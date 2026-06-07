// ── STATE ──────────────────────────────────────────────────────────────────
let map, userMarker, accuracyCircle;
let currentSpeed    = 0;   // always km/h internally
let currentLimit    = null; // always km/h internally
let lastOverpassPos = null;
let lastLimitFetchPos = null;
let limitCooldown   = false;   // true while a fetch is actually in flight
let lastHighway     = '';

// Local speed-limit cache (offline fallback) — survives in localStorage
const LIMIT_CACHE_KEY = 'speedLimitCache_v1';
const LIMIT_CACHE_MAX = 800;
let lastPos         = null;  // { lat, lon, ts }
let appStarted      = false;
let wakeLock        = null;

// Feature toggles (persisted)
let driveMode    = localStorage.getItem('driveMode')    === '1';
let radarEnabled = localStorage.getItem('radarEnabled') === '1';
let voiceEnabled = localStorage.getItem('voiceEnabled') === '1';
let compassMode  = localStorage.getItem('compassMode')  || 'north';
let speedUnit    = localStorage.getItem('speedUnit')    || 'kmh'; // 'kmh' | 'mph'
let lightMode    = localStorage.getItem('lightMode')    === '1';

// Auto Drive Mode
let speedZeroSince = null;
let currentHeading = null;

// Custom thresholds (which speeds trigger a beep)
const ALL_THRESHOLDS = [30, 50, 60, 70, 80, 100, 120];
let activeThresholds = new Set(
  (localStorage.getItem('activeThresholds') || '30,50,60,70,80,100,120')
    .split(',').map(Number).filter(n => ALL_THRESHOLDS.includes(n))
);

// Radar state
let cameraMarkers = [];
let nearbyCameras = [];
let warnedCameras = new Map();
let radarCooldown = false;
let lastRadarPos  = null;

// ── UNIT HELPERS ───────────────────────────────────────────────────────────
function kmhToDisplay(kmh) {
  if (kmh == null) return null;
  return speedUnit === 'mph' ? Math.round(kmh * 0.621371) : Math.round(kmh);
}

function unitLabel() {
  return speedUnit === 'mph' ? 'mph' : 'km/h';
}

// ── SOUND SYSTEM ───────────────────────────────────────────────────────────
const C_MAJOR_FREQ = {
  30: 261.63, 50: 293.66, 60: 329.63, 70: 349.23,
  80: 392.00, 100: 440.00, 120: 493.88,
};
const SOUND_MODES = ['off', 'beep', 'scale'];
let soundMode = localStorage.getItem('soundMode') || 'beep';
let audioCtx  = null;
let triggeredThresholds = new Set();

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Auto-resume when iOS/Car resumes audio session
    audioCtx.onstatechange = () => {
      if (audioCtx.state === 'suspended') audioCtx.resume();
    };
  }
  return audioCtx;
}

function unlockAudio() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0);
  } catch {}
}

function startSilentLoop() {
  try {
    const ctx  = getAudioCtx();
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    const src  = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(gain); gain.connect(ctx.destination); src.start(0);
  } catch {}
}

function playTone(freq, startTime, duration = 0.10, volume = 0.15) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.015);
    gain.gain.linearRampToValueAtTime(0,      startTime + duration);
    osc.start(startTime); osc.stop(startTime + duration + 0.01);
  } catch {}
}

function playDoubleBeep(threshold) {
  if (soundMode === 'off') return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    if (soundMode === 'scale') {
      // DUR-Modus: jede Schwelle hat ihre eigene Note (C-Dur C4–B4)
      const freq = C_MAJOR_FREQ[threshold] || 440;
      playTone(freq, now,        0.14, 0.18); // längere, klarere Töne
      playTone(freq, now + 0.22, 0.14, 0.18);
    } else {
      // PIEP-Modus: standard 880Hz
      playTone(880, now,        0.09, 0.13);
      playTone(880, now + 0.17, 0.09, 0.13);
    }
  } catch {}
}

function playCameraBeep() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    playTone(1200, now,        0.06, 0.10);
    playTone(1200, now + 0.12, 0.06, 0.10);
    playTone(1200, now + 0.24, 0.06, 0.10);
  } catch {}
}

function testBeep() {
  try { getAudioCtx().resume(); } catch {}
  const saved = soundMode;
  if (saved === 'off') { soundMode = 'beep'; }
  playDoubleBeep(80); // G4 in DUR-Modus, 880Hz in PIEP
  soundMode = saved;
}

function checkThresholds(speedKmh) {
  ALL_THRESHOLDS.forEach(t => {
    const active = activeThresholds.has(t);
    if (speedKmh >= t && !triggeredThresholds.has(t)) {
      triggeredThresholds.add(t);
      if (active) playDoubleBeep(t);
    } else if (speedKmh < t - 3) {
      triggeredThresholds.delete(t);
    }
  });
}

function toggleSound() {
  const idx = SOUND_MODES.indexOf(soundMode);
  soundMode = SOUND_MODES[(idx + 1) % SOUND_MODES.length];
  localStorage.setItem('soundMode', soundMode);
  try { getAudioCtx().resume(); } catch {}
  updateSoundBtn();
}

function updateSoundBtn() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  const labels = { off: '♪ AUS', beep: '♪ PIEP', scale: '♪ DUR' };
  btn.textContent = labels[soundMode];
  btn.dataset.mode = soundMode;
}

// ── VOICE ──────────────────────────────────────────────────────────────────
function speak(text) {
  if (!voiceEnabled) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-AT'; u.rate = 0.92; u.pitch = 1; u.volume = 0.95;
    window.speechSynthesis.speak(u);
  } catch {}
}

function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem('voiceEnabled', voiceEnabled ? '1' : '0');
  updateVoiceBtn();
  if (voiceEnabled) speak('Sprachausgabe aktiv');
}

function updateVoiceBtn() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;
  btn.textContent   = voiceEnabled ? '🔊 AN' : '🔊 AUS';
  btn.dataset.state = voiceEnabled ? 'on' : 'off';
}

// ── THEME ──────────────────────────────────────────────────────────────────
function applyTheme() {
  document.body.dataset.theme = lightMode ? 'light' : 'dark';
  const btn = document.getElementById('theme-btn');
  if (btn) { btn.textContent = lightMode ? '☀ Hell' : '🌙 Dunkel'; }
}

function toggleTheme() {
  lightMode = !lightMode;
  localStorage.setItem('lightMode', lightMode ? '1' : '0');
  applyTheme();
}

// ── UNIT TOGGLE ────────────────────────────────────────────────────────────
function toggleUnit() {
  speedUnit = speedUnit === 'kmh' ? 'mph' : 'kmh';
  localStorage.setItem('speedUnit', speedUnit);
  updateUnitDisplay();
}

function updateUnitDisplay() {
  // Update unit label everywhere
  const label = document.getElementById('speed-kmh');
  if (label) label.textContent = unitLabel();
  // Re-render current speed + limit with new unit
  document.getElementById('speed-num').textContent = kmhToDisplay(currentSpeed) ?? '0';
  document.getElementById('limit-num').textContent = currentLimit ? (kmhToDisplay(currentLimit) ?? '—') : '—';
  // Update settings button label
  const btn = document.getElementById('unit-btn');
  if (btn) btn.textContent = speedUnit === 'mph' ? 'mph' : 'km/h';
}

// ── CUSTOM THRESHOLDS ──────────────────────────────────────────────────────
function toggleThreshold(t) {
  if (activeThresholds.has(t)) activeThresholds.delete(t);
  else activeThresholds.add(t);
  localStorage.setItem('activeThresholds', [...activeThresholds].join(','));
  renderThresholdBtns();
}

function renderThresholdBtns() {
  const container = document.getElementById('threshold-picker');
  if (!container) return;
  container.innerHTML = ALL_THRESHOLDS.map(t => `
    <button class="thresh-btn ${activeThresholds.has(t) ? 'active' : ''}"
            onclick="toggleThreshold(${t})">${t}</button>
  `).join('');
}

// ── SETTINGS PANEL ─────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-panel').classList.add('open');
  renderThresholdBtns();
  updateUnitDisplay();
  applyTheme();
}

function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open');
}

// ── DRIVE MODE ─────────────────────────────────────────────────────────────
function toggleDriveMode() {
  driveMode = !driveMode;
  localStorage.setItem('driveMode', driveMode ? '1' : '0');
  speedZeroSince = null;
  applyDriveMode();
}

function applyDriveMode() {
  document.body.classList.toggle('drive-mode', driveMode);
  const btn = document.getElementById('drive-btn');
  if (!btn) return;
  btn.textContent   = driveMode ? '⬛ EXIT' : '▶ DRIVE';
  btn.dataset.state = driveMode ? 'on' : 'off';
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

function checkAutoDriveMode(speedKmh) {
  if (!appStarted) return;
  if (speedKmh >= 15 && !driveMode) {
    driveMode = true;
    localStorage.setItem('driveMode', '1');
    applyDriveMode();
    speedZeroSince = null;
  } else if (speedKmh === 0 && driveMode) {
    if (!speedZeroSince) speedZeroSince = Date.now();
    else if (Date.now() - speedZeroSince >= 20000) {
      driveMode = false;
      localStorage.setItem('driveMode', '0');
      applyDriveMode();
      speedZeroSince = null;
    }
  } else if (speedKmh > 0) {
    speedZeroSince = null;
  }
}

// ── COMPASS + DEVICE ORIENTATION ───────────────────────────────────────────
let orientationActive = false;
let pendingBearing    = null;
let bearingRAF        = null;
let smoothedHeading   = null;

function lerpAngle(current, target, t) {
  if (current === null) return target;
  let diff = target - current;
  if (diff >  180) diff -= 360;
  if (diff < -180) diff += 360;
  return (current + diff * t + 360) % 360;
}

function scheduleBearingUpdate(heading) {
  smoothedHeading = lerpAngle(smoothedHeading, heading, 0.25);
  pendingBearing  = smoothedHeading;
  const el = userMarker?.getElement?.();
  if (el) el.style.transform = `rotate(${smoothedHeading}deg)`;
  if (!bearingRAF && compassMode === 'heading') {
    bearingRAF = requestAnimationFrame(() => {
      if (pendingBearing !== null && map) {
        try { map.setBearing(pendingBearing); } catch {}
      }
      bearingRAF = null;
    });
  }
}

function handleDeviceOrientation(e) {
  if (!orientationActive || compassMode !== 'heading') return;
  let heading = null;
  if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
    heading = e.webkitCompassHeading;
  } else if (e.alpha !== null) {
    heading = (360 - e.alpha + 360) % 360;
  }
  if (heading !== null) scheduleBearingUpdate(heading);
}

async function startOrientationTracking() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') return;
    } catch { return; }
  }
  orientationActive = true;
  window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
  window.addEventListener('deviceorientation',         handleDeviceOrientation, true);
}

function toggleCompass() {
  compassMode = compassMode === 'north' ? 'heading' : 'north';
  localStorage.setItem('compassMode', compassMode);
  updateCompassBtn();
  if (compassMode === 'north' && map) {
    smoothedHeading = null;
    pendingBearing  = null;
    if (bearingRAF) { cancelAnimationFrame(bearingRAF); bearingRAF = null; }
    requestAnimationFrame(() => { try { map.setBearing(0); } catch {} });
  }
}

function updateCompassBtn() {
  const btn = document.getElementById('compass-btn');
  if (!btn) return;
  btn.textContent  = compassMode === 'north' ? '⬤ N' : '↑ HDG';
  btn.dataset.mode = compassMode;
}

function applyHeading(heading) {
  if (heading == null || orientationActive) return;
  currentHeading = heading;
  scheduleBearingUpdate(heading);
}

// ── RADAR TOGGLE ───────────────────────────────────────────────────────────
function toggleRadar() {
  if (!radarEnabled) {
    const ok = confirm(
      'Radarwarnung aktivieren?\n\n' +
      'Zeigt OSM-Standorte fixer Radarboxen. Daten können unvollständig sein. ' +
      'POI-Warnungen sind in Österreich legal.\n\nAktivieren?'
    );
    if (!ok) return;
  }
  radarEnabled = !radarEnabled;
  localStorage.setItem('radarEnabled', radarEnabled ? '1' : '0');
  updateRadarBtn();
  if (!radarEnabled) clearCameraMarkers();
}

function updateRadarBtn() {
  const btn = document.getElementById('radar-btn');
  if (!btn) return;
  btn.textContent   = radarEnabled ? '📷 AN' : '📷 AUS';
  btn.dataset.state = radarEnabled ? 'on' : 'off';
}

// ── WAKE LOCK ──────────────────────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && appStarted) {
    requestWakeLock();
    try { if (audioCtx?.state === 'suspended') audioCtx.resume(); } catch {}
  }
});

// ── START ──────────────────────────────────────────────────────────────────
function handleStart() {
  unlockAudio();
  startSilentLoop();
  document.getElementById('start-overlay').classList.add('hidden');
  appStarted = true;
  requestWakeLock();
  applyDriveMode();
  startOrientationTracking();
  startGPS();
}

// ── MAP ────────────────────────────────────────────────────────────────────
function initMap(lat, lon) {
  if (map) return;
  map = L.map('map', {
    zoomControl: true, attributionControl: false,
    rotate: true, bearingControl: false,
  }).setView([lat, lon], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  const icon = L.divIcon({ className: 'car-marker', iconSize: [20,28], iconAnchor: [10,14] });
  userMarker     = L.marker([lat, lon], { icon }).addTo(map);
  accuracyCircle = L.circle([lat, lon], {
    radius: 20, color: '#ff0037', fillColor: '#ff0037', fillOpacity: 0.08, weight: 1,
  }).addTo(map);
  const CompassControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'compass-control');
      div.innerHTML = `<button id="compass-btn" onclick="toggleCompass()">⬤ N</button>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  new CompassControl({ position: 'bottomright' }).addTo(map);
  updateCompassBtn();
}

function updateMap(lat, lon, accuracy) {
  if (!map) { initMap(lat, lon); return; }
  userMarker.setLatLng([lat, lon]);
  accuracyCircle.setLatLng([lat, lon]);
  accuracyCircle.setRadius(Math.max(accuracy || 20, 10));
  map.setView([lat, lon], map.getZoom(), { animate: true, duration: 1 });
}

// ── OVERPASS ───────────────────────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter',                 label: 'overpass.de' },
  { url: 'https://overpass.kumi.systems/api/interpreter',           label: 'kumi.systems' },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', label: 'mail.ru' },
];

const AT_DEFAULTS = {
  motorway: 130, motorway_link: 100, trunk: 100, trunk_link: 80,
  primary: 100,  secondary: 100,    tertiary: 100,
  residential: 30, living_street: 10, pedestrian: 10,
  service: 30,   unclassified: 50,
  default_urban: 50, default_rural: 100,
};

const HIGHWAY_PRIORITY = {
  motorway: 10, motorway_link: 9, trunk: 8, trunk_link: 7,
  primary: 6,   secondary: 5,    tertiary: 4,
  unclassified: 3, residential: 2, service: 1, living_street: 1,
};

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function queryOverpass(url, query) {
  const res = await fetch(url, {
    method: 'POST', body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Race all mirrors in parallel — first one to answer wins. Much faster &
// far less likely to look "Offline" than trying them one after another
// (which could take 3 × 12s = 36s and stack up overlapping requests).
async function queryOverpassRace(query) {
  const attempts = OVERPASS_ENDPOINTS.map(ep =>
    queryOverpass(ep.url, query).then(data => ({ data, label: ep.label }))
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return null; // all mirrors failed/timed out
  }
}

// ── LOCAL LIMIT CACHE (offline fallback) ───────────────────────────────────
// Grid cells of ~110m (3 decimal places). Once a road's limit has been seen
// once, it's remembered — so a flaky connection later still shows a value.
function loadLimitCache() {
  try { return JSON.parse(localStorage.getItem(LIMIT_CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function cacheKeyFor(lat, lon) { return `${lat.toFixed(3)},${lon.toFixed(3)}`; }

function cacheSpeedLimit(lat, lon, limit, highway, source) {
  if (!limit) return;
  const cache = loadLimitCache();
  cache[cacheKeyFor(lat, lon)] = { limit, highway, source, ts: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > LIMIT_CACHE_MAX) {
    keys.sort((a, b) => cache[a].ts - cache[b].ts)
        .slice(0, keys.length - LIMIT_CACHE_MAX)
        .forEach(k => delete cache[k]);
  }
  try { localStorage.setItem(LIMIT_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

function lookupCachedLimit(lat, lon) {
  const cache = loadLimitCache();
  const direct = cache[cacheKeyFor(lat, lon)];
  if (direct) return direct;
  // search the 8 neighbouring ~110m cells too
  const latR = Math.round(lat * 1000), lonR = Math.round(lon * 1000);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const hit = cache[`${((latR + dy) / 1000).toFixed(3)},${((lonR + dx) / 1000).toFixed(3)}`];
      if (hit) return hit;
    }
  }
  return null;
}

// Prefer ways with explicit maxspeed; among those, highest road priority
function pickBestWay(elements) {
  const driveable = elements.filter(el => {
    const hw = el.tags?.highway || '';
    return hw && !['footway','cycleway','path','steps','pedestrian','construction','proposed'].includes(hw);
  });
  const pool = driveable.length ? driveable : elements;

  // Sort: maxspeed present first, then by road priority
  pool.sort((a, b) => {
    const aHasSpeed = !!(a.tags?.maxspeed || a.tags?.['maxspeed:forward'] || a.tags?.['zone:maxspeed']);
    const bHasSpeed = !!(b.tags?.maxspeed || b.tags?.['maxspeed:forward'] || b.tags?.['zone:maxspeed']);
    if (aHasSpeed !== bHasSpeed) return bHasSpeed ? 1 : -1;
    return (HIGHWAY_PRIORITY[b.tags?.highway]??0) - (HIGHWAY_PRIORITY[a.tags?.highway]??0);
  });
  return pool[0] || null;
}

// Snap GPS position to nearest driveable road via OSRM
async function snapToRoad(lat, lon) {
  try {
    const res = await fetch(
      `https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}?number=1`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await res.json();
    if (data.code === 'Ok' && data.waypoints?.length) {
      const [slon, slat] = data.waypoints[0].location;
      return { lat: slat, lon: slon };
    }
  } catch {}
  return null;
}

async function fetchSpeedLimit(lat, lon) {
  if (limitCooldown) return;   // a fetch is already in flight — never overlap
  if (lastLimitFetchPos && distanceM(lat,lon,lastLimitFetchPos.lat,lastLimitFetchPos.lon) < 40) return;

  limitCooldown = true;
  lastLimitFetchPos = { lat, lon };
  setOverpassStatus('⟳');

  try {
    // Snap to nearest road for better accuracy
    const snapped = await snapToRoad(lat, lon);
    const qLat = snapped ? snapped.lat : lat;
    const qLon = snapped ? snapped.lon : lon;
    const radius = snapped ? 25 : 50; // tighter radius when snapped

    const query = `[out:json][timeout:12];
way(around:${radius},${qLat},${qLon})["highway"]["highway"!~"footway|cycleway|path|steps|construction|proposed"];
out tags 10;`;

    const result = await queryOverpassRace(query);
    const data = result?.data || null;

    if (!data) {
      // All mirrors failed — fall back to local cache, then last-seen road type
      const cached = lookupCachedLimit(qLat, qLon);
      if (cached) setLimit(cached.limit, cached.highway, `${cached.source} · Cache`);
      else if (lastHighway) setLimit(AT_DEFAULTS[lastHighway]||AT_DEFAULTS.default_urban, lastHighway, 'AT-Default');
      else setOverpassStatus('Offline');
      return;
    }
    if (!data.elements?.length) { setOverpassStatus('—'); return; }

    const best    = pickBestWay(data.elements);
    const tags    = best?.tags || {};
    const highway = tags.highway || '';
    // Check all maxspeed-related tags including zone tags
    const maxspeed = tags.maxspeed || tags['maxspeed:forward'] || tags['maxspeed:backward']
                   || tags['zone:maxspeed'] || tags['maxspeed:zone'] || '';
    if (highway) lastHighway = highway;

    let limit = null, source = '';
    if (maxspeed) {
      const n = parseInt(maxspeed);
      if (!isNaN(n))                       { limit = n;   source = highway || 'OSM'; }
      else if (maxspeed === 'AT:urban')    { limit = 50;  source = 'urban'; }
      else if (maxspeed === 'AT:rural')    { limit = 100; source = 'rural'; }
      else if (maxspeed === 'AT:motorway') { limit = 130; source = 'motorway'; }
      else if (maxspeed === 'walk')        { limit = 7;   source = 'Schritt'; }
    }
    if (!limit && highway) {
      limit  = AT_DEFAULTS[highway] || AT_DEFAULTS.default_urban;
      source = highway;
    }
    setLimit(limit, highway, source);
    if (limit) cacheSpeedLimit(qLat, qLon, limit, highway, source);
  } finally {
    limitCooldown = false;   // ready for the next position update
  }
}

// ── RADAR ──────────────────────────────────────────────────────────────────
function clearCameraMarkers() {
  cameraMarkers.forEach(m => map && map.removeLayer(m));
  cameraMarkers = []; nearbyCameras = [];
  hideCameraAlert();
}

async function fetchCameras(lat, lon) {
  if (!radarEnabled || radarCooldown) return;
  if (lastRadarPos && distanceM(lat,lon,lastRadarPos.lat,lastRadarPos.lon) < 200) return;
  radarCooldown = true;
  setTimeout(() => { radarCooldown = false; }, 30000);
  lastRadarPos = { lat, lon };
  const query = `[out:json][timeout:12];node["highway"="speed_camera"](around:500,${lat},${lon});out;`;
  const result = await queryOverpassRace(query);
  const data = result?.data || null;
  if (!data?.elements) return;
  clearCameraMarkers();
  data.elements.forEach(el => {
    if (!el.lat || !el.lon) return;
    const icon = L.divIcon({ className: 'camera-marker', iconSize: [14,14], iconAnchor: [7,7] });
    cameraMarkers.push(L.marker([el.lat, el.lon], { icon }).addTo(map));
    nearbyCameras.push({ id: el.id, lat: el.lat, lon: el.lon });
  });
}

function checkCameraProximity(lat, lon) {
  if (!radarEnabled || !nearbyCameras.length) { hideCameraAlert(); return; }
  let closest = null, minDist = Infinity;
  nearbyCameras.forEach(cam => {
    const d = distanceM(lat,lon,cam.lat,cam.lon);
    if (d < minDist) { minDist = d; closest = cam; }
  });
  if (!closest || minDist >= 300) { hideCameraAlert(); return; }
  showCameraAlert(Math.round(minDist));
  const now = Date.now();
  const lastWarned = warnedCameras.get(closest.id) || 0;
  if (minDist < 200 && now - lastWarned > 20000) {
    warnedCameras.set(closest.id, now);
    playCameraBeep();
    speak('Achtung, Radar');
  }
}

function showCameraAlert(distM) {
  const el = document.getElementById('camera-alert');
  if (el) { el.textContent = `📷 ${distM}m`; el.classList.add('visible'); }
}
function hideCameraAlert() {
  const el = document.getElementById('camera-alert');
  if (el) el.classList.remove('visible');
}

// ── UI ─────────────────────────────────────────────────────────────────────
let lastAnnouncedLimit = null;

function setSpeed(kmh) {
  currentSpeed = Math.round(kmh);
  document.getElementById('speed-num').textContent = kmhToDisplay(currentSpeed);
  checkThresholds(currentSpeed);
  checkAutoDriveMode(currentSpeed);
  updateSpeedColor();
}

function setLimit(limit, highway, source) {
  const changed = limit !== currentLimit;
  currentLimit  = limit;
  document.getElementById('limit-num').textContent   = limit ? (kmhToDisplay(limit) ?? '—') : '—';
  document.getElementById('limit-label').textContent = source || 'Limit';
  setOverpassStatus(limit ? `✓ ${source}` : '—');
  updateSpeedColor();
  if (changed && limit && limit !== lastAnnouncedLimit) {
    lastAnnouncedLimit = limit;
    speak(`Tempolimit ${limit}`);
  }
}

function updateSpeedColor() {
  const speedEl = document.getElementById('speed-num');
  const overlay = document.getElementById('alert-overlay');
  const badge   = document.getElementById('delta-badge');
  if (!currentLimit || currentSpeed === 0) {
    speedEl.style.color = 'var(--speed-ok)';
    overlay.classList.remove('visible');
    badge.classList.remove('visible');
    return;
  }
  const delta = currentSpeed - currentLimit;
  if (delta > 10) {
    speedEl.style.color = 'var(--red)';
    overlay.classList.add('visible');
    badge.textContent = `+${kmhToDisplay(delta)} ${unitLabel()}`;
    badge.classList.add('visible');
  } else if (delta > 0) {
    speedEl.style.color = 'var(--red)';
    overlay.classList.remove('visible');
    badge.textContent = `+${kmhToDisplay(delta)} ${unitLabel()}`;
    badge.classList.add('visible');
  } else {
    speedEl.style.color = 'var(--speed-ok)';
    overlay.classList.remove('visible');
    badge.classList.remove('visible');
  }
}

function setStatus(text, state) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = '';
  if (state) dot.classList.add(state);
}

function setOverpassStatus(text) {
  document.getElementById('overpass-status').textContent = text;
}

function setHUD(accuracy, heading, altitude) {
  const accEl = document.getElementById('accuracy-val');
  accEl.textContent = accuracy != null ? Math.round(accuracy) : '—';
  accEl.style.color = (accuracy != null && accuracy > 80) ? 'var(--red)' : '';
  document.getElementById('heading-val').textContent  = heading  != null ? Math.round(heading)  : '—';
  document.getElementById('altitude-val').textContent = altitude != null ? Math.round(altitude) : '—';
}

// ── GPS ────────────────────────────────────────────────────────────────────
function calcSpeedFromPos(lat, lon, ts) {
  if (!lastPos) return null;
  const dt = (ts - lastPos.ts) / 1000;
  if (dt <= 0.5 || dt > 8) return null;
  return distanceM(lastPos.lat, lastPos.lon, lat, lon) / dt;
}

function startGPS() {
  if (!navigator.geolocation) { setStatus('GPS nicht verfügbar', 'error'); return; }
  setStatus('GPS-Signal wird gesucht…', 'searching');
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy, speed, heading, altitude } = pos.coords;
      const ts = pos.timestamp;
      let kmh = currentSpeed;
      if (accuracy != null && accuracy > 100) {
        setStatus(`GPS schwach — ${Math.round(accuracy)}m`, 'searching');
      } else {
        const mps = speed != null ? speed : calcSpeedFromPos(lat, lon, ts);
        if (mps != null) kmh = Math.max(0, mps * 3.6);
        setStatus(`${lat.toFixed(5)}, ${lon.toFixed(5)}`, 'active');
      }
      lastPos = { lat, lon, ts };
      setSpeed(kmh);
      setHUD(accuracy, heading, altitude);
      updateMap(lat, lon, accuracy);
      applyHeading(heading);
      fetchSpeedLimit(lat, lon);
      fetchCameras(lat, lon);
      checkCameraProximity(lat, lon);
    },
    (err) => {
      const msgs = { 1:'GPS verweigert.', 2:'Position nicht verfügbar.', 3:'GPS-Timeout.' };
      setStatus(msgs[err.code] || 'GPS-Fehler', 'error');
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

// ── BOOT ───────────────────────────────────────────────────────────────────
initMap(48.2082, 16.3738);
applyTheme();
updateSoundBtn();
updateVoiceBtn();
updateRadarBtn();
updateUnitDisplay();
