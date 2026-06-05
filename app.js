// ── STATE ──────────────────────────────────────────────────────────────────
let map, userMarker, accuracyCircle;
let currentSpeed  = 0;
let currentLimit  = null;
let lastOverpassPos = null;
let overpassCooldown = false;
let lastHighway   = '';   // remembered for all-endpoints-fail fallback
let lastPos       = null; // { lat, lon, ts } for calculated speed
let appStarted    = false;
let wakeLock      = null;

// ── SOUND SYSTEM ───────────────────────────────────────────────────────────
const SPEED_THRESHOLDS = [30, 50, 60, 70, 80, 100, 120];

const C_MAJOR_FREQ = {
  30:  261.63, // C4
  50:  293.66, // D4
  60:  329.63, // E4
  70:  349.23, // F4
  80:  392.00, // G4
  100: 440.00, // A4
  120: 493.88, // B4
};

const SOUND_MODES = ['off', 'beep', 'scale'];
let soundMode = localStorage.getItem('soundMode') || 'beep';
let audioCtx  = null;
let triggeredThresholds = new Set();

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// Unlock iOS AudioContext — must be called inside a user-gesture handler
function unlockAudio() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    // Play a 1-sample silent buffer — iOS requires this to fully unlock
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* not supported */ }
}

function playDoubleBeep(threshold) {
  if (soundMode === 'off') return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();

    const freq  = soundMode === 'scale' ? (C_MAJOR_FREQ[threshold] || 880) : 880;
    const freq2 = soundMode === 'scale' ? freq * 1.122 : freq;

    function beep(startTime, f) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.12, startTime + 0.012);
      gain.gain.linearRampToValueAtTime(0,    startTime + 0.08);
      osc.start(startTime);
      osc.stop(startTime + 0.09);
    }

    const now = ctx.currentTime;
    beep(now,        freq);
    beep(now + 0.16, freq2);
  } catch { /* audio not supported */ }
}

function testBeep() {
  // Resume context on every tap — iOS can re-suspend after inactivity
  try { getAudioCtx().resume(); } catch {}
  const mode = soundMode === 'off' ? 'beep' : soundMode;
  const savedMode = soundMode;
  soundMode = mode;
  playDoubleBeep(80); // play G4 or 880Hz as demo
  soundMode = savedMode;
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
  if (soundMode !== 'off') try { getAudioCtx().resume(); } catch {}
  updateSoundBtn();
}

function updateSoundBtn() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  const labels = { off: '♪ AUS', beep: '♪ PIEP', scale: '♪ DUR' };
  btn.textContent  = labels[soundMode];
  btn.dataset.mode = soundMode;
}

// ── WAKE LOCK — keep screen on while app is running ───────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return; // not supported
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied or not available */ }
}

// Re-acquire after tab becomes visible again (iOS releases on background)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && appStarted) {
    requestWakeLock();
  }
});

// ── START OVERLAY (iOS AudioContext unlock) ────────────────────────────────
function handleStart() {
  unlockAudio(); // must happen synchronously inside tap handler

  document.getElementById('start-overlay').classList.add('hidden');
  appStarted = true;
  requestWakeLock();
  startGPS();
}

// ── MAP INIT ───────────────────────────────────────────────────────────────
function initMap(lat, lon) {
  if (map) return;
  map = L.map('map', { zoomControl: true, attributionControl: false })
          .setView([lat, lon], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
   .addTo(map);
  const icon = L.divIcon({ className: 'car-marker', iconSize: [20,20], iconAnchor: [10,10] });
  userMarker     = L.marker([lat, lon], { icon }).addTo(map);
  accuracyCircle = L.circle([lat, lon], {
    radius: 20, color: '#ff0037', fillColor: '#ff0037', fillOpacity: 0.08, weight: 1,
  }).addTo(map);
}

function updateMap(lat, lon, accuracy) {
  if (!map) { initMap(lat, lon); return; }
  userMarker.setLatLng([lat, lon]);
  accuracyCircle.setLatLng([lat, lon]);
  accuracyCircle.setRadius(Math.max(accuracy || 20, 10));
  map.setView([lat, lon], map.getZoom(), { animate: true, duration: 1 });
}

// ── OVERPASS API — 3 endpoints with fallback ────────────────────────────────
const OVERPASS_ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter',                  label: 'overpass.de' },
  { url: 'https://overpass.kumi.systems/api/interpreter',            label: 'kumi.systems' },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',  label: 'mail.ru' },
];

const AT_DEFAULTS = {
  motorway: 130, motorway_link: 100,
  trunk: 100,    trunk_link: 80,
  primary: 100,  secondary: 100, tertiary: 100,
  residential: 30, living_street: 10, pedestrian: 10,
  service: 30,   unclassified: 50,
  default_urban: 50, default_rural: 100,
};

// Higher = more relevant road when multiple ways are nearby
const HIGHWAY_PRIORITY = {
  motorway: 10, motorway_link: 9,
  trunk: 8,     trunk_link: 7,
  primary: 6,   secondary: 5,   tertiary: 4,
  unclassified: 3, residential: 2,
  service: 1,   living_street: 1,
};

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function queryOverpass(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function pickBestWay(elements) {
  // Filter out non-driveable ways, then sort by priority descending
  const driveable = elements.filter(el => {
    const hw = el.tags?.highway || '';
    return hw && !['footway','cycleway','path','steps','pedestrian','construction','proposed'].includes(hw);
  });
  if (!driveable.length) return elements[0] || null; // fallback to first
  driveable.sort((a, b) => {
    const pa = HIGHWAY_PRIORITY[a.tags?.highway] ?? 0;
    const pb = HIGHWAY_PRIORITY[b.tags?.highway] ?? 0;
    return pb - pa;
  });
  return driveable[0];
}

async function fetchSpeedLimit(lat, lon) {
  if (overpassCooldown) return;
  if (lastOverpassPos && distanceM(lat, lon, lastOverpassPos.lat, lastOverpassPos.lon) < 50) return;

  overpassCooldown = true;
  setTimeout(() => { overpassCooldown = false; }, 8000);
  lastOverpassPos = { lat, lon };

  setOverpassStatus('⟳ Laden…');

  // 50m radius, exclude foot/cycle paths, return up to 10 results for best-pick
  const query = `[out:json][timeout:12];
way(around:50,${lat},${lon})["highway"]["highway"!~"footway|cycleway|path|steps|construction|proposed"];
out tags 10;`;

  let data = null;
  let usedLabel = '';

  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      data = await queryOverpass(ep.url, query);
      usedLabel = ep.label;
      break;
    } catch { /* try next */ }
  }

  if (!data) {
    if (lastHighway) {
      const fallback = AT_DEFAULTS[lastHighway] || AT_DEFAULTS.default_urban;
      setLimit(fallback, lastHighway, 'AT-Default (offline)');
    } else {
      setOverpassStatus('Offline — kein Limit');
    }
    return;
  }

  if (!data.elements || data.elements.length === 0) {
    setOverpassStatus('Keine Straße');
    return;
  }

  const best     = pickBestWay(data.elements);
  const tags     = best.tags || {};
  const highway  = tags.highway || '';
  const maxspeed = tags.maxspeed || tags['maxspeed:forward'] || tags['maxspeed:backward'] || '';
  if (highway) lastHighway = highway;

  let limit  = null;
  let source = '';

  if (maxspeed) {
    const n = parseInt(maxspeed);
    if (!isNaN(n))                     { limit = n;   source = `OSM · ${usedLabel}`; }
    else if (maxspeed === 'AT:urban')   { limit = 50;  source = 'AT urban'; }
    else if (maxspeed === 'AT:rural')   { limit = 100; source = 'AT rural'; }
    else if (maxspeed === 'AT:motorway'){ limit = 130; source = 'AT motorway'; }
    else if (maxspeed === 'walk')       { limit = 7;   source = 'Schrittgeschwindigkeit'; }
  }

  if (!limit && highway) {
    limit  = AT_DEFAULTS[highway] || AT_DEFAULTS.default_urban;
    source = `${highway}`;
  }

  setLimit(limit, highway, source);
}

// ── GPS — speed from positions when coords.speed is null ───────────────────
function calcSpeedFromPos(lat, lon, ts) {
  if (!lastPos) return null;
  const dt = (ts - lastPos.ts) / 1000; // seconds
  if (dt <= 0.5 || dt > 8) return null; // gap too small or stale
  const dist = distanceM(lastPos.lat, lastPos.lon, lat, lon);
  return dist / dt; // m/s
}

// ── UI UPDATES ─────────────────────────────────────────────────────────────
function setSpeed(kmh) {
  currentSpeed = Math.round(kmh);
  document.getElementById('speed-num').textContent = currentSpeed;
  checkThresholds(currentSpeed);
  updateSpeedColor();
}

function setLimit(limit, highway, source) {
  currentLimit = limit;
  document.getElementById('limit-num').textContent  = limit || '—';
  document.getElementById('limit-label').textContent = source || 'Limit';
  setOverpassStatus(limit ? '✓ ' + (source || '') : '—');
  updateSpeedColor();
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
  accEl.textContent = accuracy != null ? Math.round(accuracy) : '—';
  // Highlight in red if GPS is weak
  accEl.style.color = (accuracy != null && accuracy > 80) ? 'var(--warn)' : '';
  document.getElementById('heading-val').textContent  = heading  != null ? Math.round(heading)  : '—';
  document.getElementById('altitude-val').textContent = altitude != null ? Math.round(altitude) : '—';
}

// ── GPS ────────────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    setStatus('GPS nicht verfügbar', 'error');
    return;
  }
  setStatus('GPS-Signal wird gesucht…', 'searching');

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy, speed, heading, altitude } = pos.coords;
      const ts = pos.timestamp;

      // Speed: prefer coords.speed, fall back to calculated, skip if accuracy weak
      let kmh = 0;
      if (accuracy != null && accuracy > 100) {
        setStatus(`GPS schwach — ${Math.round(accuracy)}m`, 'searching');
      } else {
        const mps = (speed != null)
          ? speed
          : calcSpeedFromPos(lat, lon, ts);
        kmh = mps != null ? Math.max(0, mps * 3.6) : currentSpeed; // hold last if null
        setStatus(`${lat.toFixed(5)}, ${lon.toFixed(5)}`, 'active');
      }

      lastPos = { lat, lon, ts };

      setSpeed(kmh);
      setHUD(accuracy, heading, altitude);
      updateMap(lat, lon, accuracy);
      fetchSpeedLimit(lat, lon);
    },
    (err) => {
      const msgs = {
        1: 'GPS verweigert — Berechtigung erlauben.',
        2: 'Position nicht verfügbar.',
        3: 'GPS-Timeout.',
      };
      setStatus(msgs[err.code] || 'GPS-Fehler', 'error');
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

// ── BOOT ───────────────────────────────────────────────────────────────────
initMap(48.2082, 16.3738); // Vienna fallback
updateSoundBtn();
// GPS starts only after user taps START (iOS AudioContext requirement)
