// ── STATE ──────────────────────────────────────────────────────────────────
let map, userMarker, accuracyCircle;
let currentSpeed    = 0;
let currentLimit    = null;
let lastOverpassPos = null;
let overpassCooldown = false;
let lastHighway     = '';
let lastPos         = null;  // { lat, lon, ts }
let appStarted      = false;
let wakeLock        = null;

// Feature toggles (persisted)
let driveMode    = localStorage.getItem('driveMode')    === '1';
let radarEnabled = localStorage.getItem('radarEnabled') === '1';
let voiceEnabled = localStorage.getItem('voiceEnabled') === '1';
let compassMode  = localStorage.getItem('compassMode')  || 'north'; // 'north' | 'heading'

// Auto Drive Mode timer
let speedZeroSince  = null;
let currentHeading  = null;

// Radar state
let cameraMarkers   = [];
let nearbyCameras   = [];
let warnedCameras   = new Map();  // id → timestamp
let radarCooldown   = false;
let lastRadarPos    = null;

// ── SOUND SYSTEM ───────────────────────────────────────────────────────────
const SPEED_THRESHOLDS = [30, 50, 60, 70, 80, 100, 120];
const C_MAJOR_FREQ = {
  30: 261.63, 50: 293.66, 60: 329.63, 70: 349.23,
  80: 392.00, 100: 440.00, 120: 493.88,
};
const SOUND_MODES = ['off', 'beep', 'scale'];
let soundMode = localStorage.getItem('soundMode') || 'beep';
let audioCtx  = null;
let triggeredThresholds = new Set();

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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

function playTone(freq, startTime, duration = 0.08, volume = 0.12) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.012);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.start(startTime); osc.stop(startTime + duration + 0.01);
  } catch {}
}

function playDoubleBeep(threshold) {
  if (soundMode === 'off') return;
  try {
    const ctx   = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const freq  = soundMode === 'scale' ? (C_MAJOR_FREQ[threshold] || 880) : 880;
    const freq2 = soundMode === 'scale' ? freq * 1.122 : freq;
    const now   = ctx.currentTime;
    playTone(freq,  now,        0.08, 0.12);
    playTone(freq2, now + 0.16, 0.08, 0.12);
  } catch {}
}

function playCameraBeep() {
  // Three short high beeps for camera warning
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
  soundMode = saved === 'off' ? 'beep' : saved;
  playDoubleBeep(80);
  soundMode = saved;
}

function checkThresholds(speed) {
  SPEED_THRESHOLDS.forEach(t => {
    if (speed >= t && !triggeredThresholds.has(t)) {
      triggeredThresholds.add(t);
      playDoubleBeep(t);
    } else if (speed < t - 3) {
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

// ── VOICE SYSTEM ───────────────────────────────────────────────────────────
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

// ── DRIVE MODE ─────────────────────────────────────────────────────────────
function toggleDriveMode() {
  driveMode = !driveMode;
  localStorage.setItem('driveMode', driveMode ? '1' : '0');
  speedZeroSince = null; // reset timer on manual toggle
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

function checkAutoDriveMode(speed) {
  if (!appStarted) return;
  if (speed >= 15 && !driveMode) {
    driveMode = true;
    localStorage.setItem('driveMode', '1');
    applyDriveMode();
    speedZeroSince = null;
  } else if (speed === 0 && driveMode) {
    if (!speedZeroSince) speedZeroSince = Date.now();
    else if (Date.now() - speedZeroSince >= 20000) {
      driveMode = false;
      localStorage.setItem('driveMode', '0');
      applyDriveMode();
      speedZeroSince = null;
    }
  } else if (speed > 0) {
    speedZeroSince = null; // still moving — reset timer
  }
}

// ── COMPASS ────────────────────────────────────────────────────────────────
function toggleCompass() {
  compassMode = compassMode === 'north' ? 'heading' : 'north';
  localStorage.setItem('compassMode', compassMode);
  updateCompassBtn();
  if (compassMode === 'north' && map) {
    try { map.setBearing(0); } catch {}
  } else if (currentHeading != null && map) {
    try { map.setBearing(currentHeading); } catch {}
  }
}

function updateCompassBtn() {
  const btn = document.getElementById('compass-btn');
  if (!btn) return;
  btn.textContent   = compassMode === 'north' ? '⬤ N' : '↑ HDG';
  btn.dataset.mode  = compassMode;
}

function applyHeading(heading) {
  if (heading == null || !map) return;
  currentHeading = heading;

  // Rotate directional car marker
  const el = userMarker?.getElement?.();
  if (el) el.style.transform = `rotate(${heading}deg)`;

  if (compassMode === 'heading') {
    try { map.setBearing(heading); } catch {}
  }
}

// ── RADAR TOGGLE ───────────────────────────────────────────────────────────
function toggleRadar() {
  if (!radarEnabled) {
    // Show legal disclaimer on first enable
    const ok = confirm(
      'Radarwarnung aktivieren?\n\n' +
      'Diese App zeigt OSM-Standorte fixer Radarboxen als Orientierungshilfe. ' +
      'Daten können unvollständig oder veraltet sein. ' +
      'In Österreich sind POI-basierte Warnungen legal, ' +
      'solange keine Messgeräte beeinflusst werden.\n\n' +
      'Aktivieren?'
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
  if (document.visibilityState === 'visible' && appStarted) requestWakeLock();
});

// ── START OVERLAY ──────────────────────────────────────────────────────────
function handleStart() {
  unlockAudio();
  startSilentLoop();
  document.getElementById('start-overlay').classList.add('hidden');
  appStarted = true;
  requestWakeLock();
  applyDriveMode();
  startGPS();
}

// ── MAP ────────────────────────────────────────────────────────────────────
function initMap(lat, lon) {
  if (map) return;

  // rotate: true — leaflet-rotate plugin adds this support (cdn.jsdelivr.net)
  // Leaflet silently ignores unknown options if plugin didn't load
  map = L.map('map', { zoomControl: true, attributionControl: false, rotate: true })
          .setView([lat, lon], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
   .addTo(map);

  // Directional arrow marker (triangle)
  const icon = L.divIcon({ className: 'car-marker', iconSize: [20,28], iconAnchor: [10,14] });
  userMarker     = L.marker([lat, lon], { icon }).addTo(map);
  accuracyCircle = L.circle([lat, lon], {
    radius: 20, color: '#ff0037', fillColor: '#ff0037', fillOpacity: 0.08, weight: 1,
  }).addTo(map);

  // Compass control overlay
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

// ── RADAR — Speed Camera Fetch ─────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter',                 label: 'overpass.de' },
  { url: 'https://overpass.kumi.systems/api/interpreter',           label: 'kumi.systems' },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', label: 'mail.ru' },
];

async function queryOverpass(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function clearCameraMarkers() {
  cameraMarkers.forEach(m => map && map.removeLayer(m));
  cameraMarkers = [];
  nearbyCameras = [];
  hideCameraAlert();
}

async function fetchCameras(lat, lon) {
  if (!radarEnabled || radarCooldown) return;
  if (lastRadarPos && distanceM(lat, lon, lastRadarPos.lat, lastRadarPos.lon) < 200) return;

  radarCooldown = true;
  setTimeout(() => { radarCooldown = false; }, 30000);
  lastRadarPos = { lat, lon };

  const query = `[out:json][timeout:12];node["highway"="speed_camera"](around:500,${lat},${lon});out;`;

  let data = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try { data = await queryOverpass(ep.url, query); break; } catch {}
  }
  if (!data?.elements) return;

  // Clear old markers
  clearCameraMarkers();

  // Add new markers
  data.elements.forEach(el => {
    if (!el.lat || !el.lon) return;
    const icon = L.divIcon({ className: 'camera-marker', iconSize: [14,14], iconAnchor: [7,7] });
    const marker = L.marker([el.lat, el.lon], { icon }).addTo(map);
    cameraMarkers.push(marker);
    nearbyCameras.push({ id: el.id, lat: el.lat, lon: el.lon });
  });
}

function checkCameraProximity(lat, lon) {
  if (!radarEnabled || !nearbyCameras.length) { hideCameraAlert(); return; }
  const now = Date.now();
  let closest = null;
  let minDist = Infinity;

  nearbyCameras.forEach(cam => {
    const d = distanceM(lat, lon, cam.lat, cam.lon);
    if (d < minDist) { minDist = d; closest = cam; }
  });

  if (!closest) { hideCameraAlert(); return; }

  if (minDist < 300) {
    showCameraAlert(Math.round(minDist));
    const lastWarned = warnedCameras.get(closest.id) || 0;
    if (minDist < 200 && now - lastWarned > 20000) {
      warnedCameras.set(closest.id, now);
      playCameraBeep();
      speak(`Achtung, Radar`);
    }
  } else {
    hideCameraAlert();
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

// ── OVERPASS — Speed Limits ────────────────────────────────────────────────
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

function pickBestWay(elements) {
  const driveable = elements.filter(el => {
    const hw = el.tags?.highway || '';
    return hw && !['footway','cycleway','path','steps','pedestrian','construction','proposed'].includes(hw);
  });
  const pool = driveable.length ? driveable : elements;
  return pool.sort((a,b) =>
    (HIGHWAY_PRIORITY[b.tags?.highway]??0) - (HIGHWAY_PRIORITY[a.tags?.highway]??0)
  )[0] || null;
}

let lastLimitFetchPos = null;
let limitCooldown = false;

async function fetchSpeedLimit(lat, lon) {
  if (limitCooldown) return;
  if (lastLimitFetchPos && distanceM(lat,lon,lastLimitFetchPos.lat,lastLimitFetchPos.lon) < 50) return;

  limitCooldown = true;
  setTimeout(() => { limitCooldown = false; }, 8000);
  lastLimitFetchPos = { lat, lon };

  setOverpassStatus('⟳');

  const query = `[out:json][timeout:12];
way(around:50,${lat},${lon})["highway"]["highway"!~"footway|cycleway|path|steps|construction|proposed"];
out tags 10;`;

  let data = null, usedLabel = '';
  for (const ep of OVERPASS_ENDPOINTS) {
    try { data = await queryOverpass(ep.url, query); usedLabel = ep.label; break; } catch {}
  }

  if (!data) {
    if (lastHighway) setLimit(AT_DEFAULTS[lastHighway]||AT_DEFAULTS.default_urban, lastHighway, 'AT-Default');
    else setOverpassStatus('Offline');
    return;
  }

  if (!data.elements?.length) { setOverpassStatus('—'); return; }

  const best     = pickBestWay(data.elements);
  const tags     = best?.tags || {};
  const highway  = tags.highway || '';
  const maxspeed = tags.maxspeed || tags['maxspeed:forward'] || tags['maxspeed:backward'] || '';
  if (highway) lastHighway = highway;

  let limit = null, source = '';

  if (maxspeed) {
    const n = parseInt(maxspeed);
    if (!isNaN(n))                      { limit = n;   source = highway; }
    else if (maxspeed==='AT:urban')      { limit = 50;  source = 'urban'; }
    else if (maxspeed==='AT:rural')      { limit = 100; source = 'rural'; }
    else if (maxspeed==='AT:motorway')   { limit = 130; source = 'motorway'; }
    else if (maxspeed==='walk')          { limit = 7;   source = 'Schritt'; }
  }
  if (!limit && highway) {
    limit = AT_DEFAULTS[highway] || AT_DEFAULTS.default_urban;
    source = highway;
  }

  setLimit(limit, highway, source);
}

// ── UI UPDATES ─────────────────────────────────────────────────────────────
let lastAnnouncedLimit = null;

function setSpeed(kmh) {
  currentSpeed = Math.round(kmh);
  document.getElementById('speed-num').textContent = currentSpeed;
  checkThresholds(currentSpeed);
  checkAutoDriveMode(currentSpeed);
  updateSpeedColor();
}

function setLimit(limit, highway, source) {
  const changed = limit !== currentLimit;
  currentLimit = limit;
  document.getElementById('limit-num').textContent  = limit || '—';
  document.getElementById('limit-label').textContent = source || 'Limit';
  setOverpassStatus(limit ? `✓ ${source||''}` : '—');
  updateSpeedColor();

  // Voice: announce new limit when it changes
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
    speedEl.style.color = 'var(--white)';
    overlay.classList.remove('visible');
    badge.classList.remove('visible');
    return;
  }
  const delta = currentSpeed - currentLimit;
  if (delta > 10) {
    speedEl.style.color = 'var(--danger)';
    overlay.classList.add('visible');
    badge.textContent = '+' + delta + ' km/h';
    badge.classList.add('visible');
  } else if (delta > 0) {
    speedEl.style.color = 'var(--warn)';
    overlay.classList.remove('visible');
    badge.textContent = '+' + delta + ' km/h';
    badge.classList.add('visible');
  } else {
    speedEl.style.color = 'var(--white)';
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
  accEl.textContent  = accuracy  != null ? Math.round(accuracy)  : '—';
  accEl.style.color  = (accuracy != null && accuracy > 80) ? 'var(--warn)' : '';
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
updateSoundBtn();
updateVoiceBtn();
updateRadarBtn();
// compass button created inside initMap, updateCompassBtn called there
