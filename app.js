// ── STATE ──────────────────────────────────────────────────────────────────
let map, userMarker, accuracyCircle;
let currentSpeed = 0;
let currentLimit = null;
let lastOverpassPos = null;
let overpassCooldown = false;

// ── SOUND SYSTEM ───────────────────────────────────────────────────────────
const SPEED_THRESHOLDS = [30, 50, 60, 70, 80, 100, 120];
let audioCtx = null;
let soundEnabled = localStorage.getItem('soundEnabled') !== 'false'; // default: on
let triggeredThresholds = new Set();

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playDoubleBeep() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    // Resume context if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') ctx.resume();

    function beep(startTime) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.12, startTime + 0.012);
      gain.gain.linearRampToValueAtTime(0, startTime + 0.08);
      osc.start(startTime);
      osc.stop(startTime + 0.09);
    }

    const now = ctx.currentTime;
    beep(now);
    beep(now + 0.16); // second beep 160ms later
  } catch { /* audio not supported */ }
}

function checkThresholds(speed) {
  SPEED_THRESHOLDS.forEach(t => {
    if (speed >= t && !triggeredThresholds.has(t)) {
      triggeredThresholds.add(t);
      playDoubleBeep();
    } else if (speed < t - 3) {
      // reset with 3 km/h hysteresis to avoid rapid re-triggering
      triggeredThresholds.delete(t);
    }
  });
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('soundEnabled', soundEnabled);
  updateSoundBtn();
  // Wake up AudioContext on first user interaction
  if (soundEnabled) getAudioCtx();
}

function updateSoundBtn() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  btn.textContent  = soundEnabled ? '♪ AN' : '♪ AUS';
  btn.classList.toggle('sound-off', !soundEnabled);
}

// ── MAP INIT ───────────────────────────────────────────────────────────────
function initMap(lat, lon) {
  if (map) return;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([lat, lon], 16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(map);

  const icon = L.divIcon({ className: 'car-marker', iconSize: [20, 20], iconAnchor: [10, 10] });
  userMarker = L.marker([lat, lon], { icon }).addTo(map);
  accuracyCircle = L.circle([lat, lon], {
    radius: 20,
    color: '#ff0037',
    fillColor: '#ff0037',
    fillOpacity: 0.08,
    weight: 1,
  }).addTo(map);
}

function updateMap(lat, lon, accuracy) {
  if (!map) { initMap(lat, lon); return; }
  userMarker.setLatLng([lat, lon]);
  accuracyCircle.setLatLng([lat, lon]);
  accuracyCircle.setRadius(accuracy || 20);
  map.setView([lat, lon], map.getZoom(), { animate: true, duration: 1 });
}

// ── OVERPASS API ───────────────────────────────────────────────────────────
const AT_DEFAULTS = {
  motorway:      130,
  motorway_link: 100,
  trunk:         100,
  trunk_link:     80,
  primary:       100,
  secondary:     100,
  tertiary:      100,
  residential:    30,
  living_street:  10,
  pedestrian:     10,
  service:        30,
  unclassified:   50,
  default_urban:  50,
  default_rural: 100,
};

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function fetchSpeedLimit(lat, lon) {
  if (overpassCooldown) return;
  if (lastOverpassPos && distanceM(lat, lon, lastOverpassPos.lat, lastOverpassPos.lon) < 50) return;

  overpassCooldown = true;
  setTimeout(() => { overpassCooldown = false; }, 8000);
  lastOverpassPos = { lat, lon };

  setOverpassStatus('⟳ Straßendaten…');

  const query = `[out:json][timeout:10];way(around:30,${lat},${lon})["highway"];out tags 1;`;

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();

    if (data.elements && data.elements.length > 0) {
      const tags = data.elements[0].tags || {};
      const highway = tags.highway || '';
      const maxspeed = tags.maxspeed || tags['maxspeed:forward'] || '';

      let limit = null;
      let source = '';

      if (maxspeed) {
        const parsed = parseInt(maxspeed);
        if (!isNaN(parsed)) {
          limit = parsed; source = 'OSM';
        } else if (maxspeed === 'AT:urban')    { limit = 50;  source = 'AT urban'; }
        else if (maxspeed === 'AT:rural')      { limit = 100; source = 'AT rural'; }
        else if (maxspeed === 'AT:motorway')   { limit = 130; source = 'AT motorway'; }
      }

      if (!limit && highway) {
        limit = AT_DEFAULTS[highway] || AT_DEFAULTS.default_urban;
        source = `Typ: ${highway}`;
      }

      setLimit(limit, highway, source);
    } else {
      setOverpassStatus('Keine Straße gefunden');
    }
  } catch {
    setOverpassStatus('Overpass offline');
  }
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
  document.getElementById('limit-num').textContent = limit || '—';
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
  document.getElementById('accuracy-val').textContent = accuracy  != null ? Math.round(accuracy)  : '—';
  document.getElementById('heading-val').textContent  = heading   != null ? Math.round(heading)   : '—';
  document.getElementById('altitude-val').textContent = altitude  != null ? Math.round(altitude)  : '—';
}

// ── GPS ────────────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    setStatus('GPS nicht verfügbar in diesem Browser', 'error');
    return;
  }

  setStatus('GPS-Signal wird gesucht…', 'searching');

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy, speed, heading, altitude } = pos.coords;
      const kmh = speed != null ? speed * 3.6 : 0;

      setSpeed(Math.max(0, kmh));
      setHUD(accuracy, heading, altitude);
      updateMap(lat, lon, accuracy);
      setStatus(`Position aktiv — ${lat.toFixed(5)}, ${lon.toFixed(5)}`, 'active');
      fetchSpeedLimit(lat, lon);
    },
    (err) => {
      const msgs = {
        1: 'GPS-Zugriff verweigert. Bitte Berechtigung erlauben.',
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
setStatus('Tippe auf die Karte oder erlaube GPS', '');
updateSoundBtn();
startGPS();
