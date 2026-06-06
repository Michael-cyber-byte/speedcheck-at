/* ═══════════════════════════════════════════════════════════════════════════
   SHIFT11 Feedback Widget — feedback.js  v1.0  2026-06-06
   Wiederverwendbar für alle SHIFT11 Apps.

   Einbinden:
     <script src="/shared/feedback.js"></script>
     <link rel="stylesheet" href="/shared/feedback.css">

   Init (einmalig, nach DOM ready):
     S11Feedback.init({
       appName:       'SpeedCheck AT',
       version:       'v1.11',
       endpoint:      'https://formspree.io/f/YOUR_FORM_ID',  // optional
       fallbackEmail: 'feedback@shift11.com',                 // fallback mailto
       onSuccess:     (payload) => console.log(payload),      // optional callback
     });

   Öffnen:
     S11Feedback.open()

   Formspree Setup (kostenlos, bis 50 Submissions/Monat):
     1. formspree.io → Account erstellen
     2. New Form → Name eingeben → Form ID kopieren
     3. endpoint: 'https://formspree.io/f/DEINE_FORM_ID'
   ═══════════════════════════════════════════════════════════════════════════ */

const S11Feedback = (() => {
  let cfg = {
    appName:       'App',
    version:       null,
    endpoint:      null,
    fallbackEmail: null,
    onSuccess:     null,
  };

  let currentRating = 0;

  // ── HTML Template ─────────────────────────────────────────────────────────
  function buildHTML() {
    return `
      <div id="s11fb-overlay" onclick="S11Feedback.close()"></div>
      <div id="s11fb-panel">
        <div id="s11fb-header">
          <div id="s11fb-title">Dein Feedback</div>
          <button id="s11fb-close" onclick="S11Feedback.close()">✕</button>
        </div>
        <div id="s11fb-body">

          <div class="s11fb-section-label">Erfahrung</div>
          <div id="s11fb-stars">
            ${[1,2,3,4,5].map(n =>
              `<button class="s11fb-star" onclick="S11Feedback.setRating(${n})" data-val="${n}" aria-label="${n} Sterne">★</button>`
            ).join('')}
          </div>

          <div class="s11fb-section-label" style="margin-top:14px">Kategorie</div>
          <div id="s11fb-cats">
            <button class="s11fb-cat" onclick="S11Feedback.toggleCat(this)" data-cat="bug">🐛 Bug</button>
            <button class="s11fb-cat" onclick="S11Feedback.toggleCat(this)" data-cat="feature">💡 Wunsch</button>
            <button class="s11fb-cat" onclick="S11Feedback.toggleCat(this)" data-cat="lob">👍 Lob</button>
            <button class="s11fb-cat" onclick="S11Feedback.toggleCat(this)" data-cat="frage">❓ Frage</button>
          </div>

          <div class="s11fb-section-label" style="margin-top:14px">Beobachtung / Wunsch</div>
          <textarea id="s11fb-text"
            placeholder="Was hast du bemerkt? Was wünschst du dir?"
            rows="4"></textarea>

          <button id="s11fb-submit" onclick="S11Feedback.submit()">Feedback senden</button>
          <div id="s11fb-status"></div>

        </div>
      </div>
    `;
  }

  function mount() {
    if (document.getElementById('s11fb-root')) return;
    const root = document.createElement('div');
    root.id = 's11fb-root';
    root.innerHTML = buildHTML();
    document.body.appendChild(root);
  }

  function reset() {
    currentRating = 0;
    document.querySelectorAll('.s11fb-star').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.s11fb-cat').forEach(c => c.classList.remove('active'));
    const txt = document.getElementById('s11fb-text');
    if (txt) txt.value = '';
    const status = document.getElementById('s11fb-status');
    if (status) status.textContent = '';
    const btn = document.getElementById('s11fb-submit');
    if (btn) btn.disabled = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {

    init(config = {}) {
      Object.assign(cfg, config);
      // Mount lazily on first open, or eagerly here
      document.addEventListener('DOMContentLoaded', mount);
      if (document.readyState !== 'loading') mount();
    },

    open() {
      mount();
      reset();
      document.getElementById('s11fb-root').classList.add('open');
    },

    close() {
      const root = document.getElementById('s11fb-root');
      if (root) root.classList.remove('open');
    },

    setRating(n) {
      currentRating = n;
      document.querySelectorAll('.s11fb-star').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.val) <= n);
      });
    },

    toggleCat(btn) {
      btn.classList.toggle('active');
    },

    async submit() {
      const text  = (document.getElementById('s11fb-text')?.value || '').trim();
      const cats  = [...document.querySelectorAll('.s11fb-cat.active')]
                      .map(b => b.dataset.cat).join(', ');
      const statusEl = document.getElementById('s11fb-status');
      const submitBtn = document.getElementById('s11fb-submit');

      if (!currentRating && !text) {
        statusEl.textContent = 'Bitte Bewertung oder Text eingeben.';
        statusEl.className   = 's11fb-status-error';
        return;
      }

      const payload = {
        app:        cfg.appName,
        version:    cfg.version || '—',
        rating:     currentRating || '—',
        categories: cats || '—',
        message:    text || '—',
        timestamp:  new Date().toISOString(),
        url:        window.location.href,
      };

      submitBtn.disabled   = true;
      statusEl.textContent = 'Wird gesendet…';
      statusEl.className   = '';

      // ── Versuch 1: HTTP Endpoint (Formspree o.ä.) ──
      if (cfg.endpoint) {
        try {
          const res = await fetch(cfg.endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body:    JSON.stringify(payload),
            signal:  AbortSignal.timeout(8000),
          });
          if (res.ok) {
            statusEl.textContent = '✓ Danke für dein Feedback!';
            statusEl.className   = 's11fb-status-ok';
            if (cfg.onSuccess) cfg.onSuccess(payload);
            setTimeout(() => this.close(), 2000);
            return;
          }
        } catch { /* endpoint failed → fallback */ }
      }

      // ── Versuch 2: mailto Fallback ──
      if (cfg.fallbackEmail) {
        const subject = encodeURIComponent(
          `[${cfg.appName}${cfg.version ? ' ' + cfg.version : ''}] Feedback — ${currentRating}★ ${cats}`
        );
        const body = encodeURIComponent([
          `App: ${payload.app} ${payload.version}`,
          `Bewertung: ${payload.rating}★`,
          `Kategorie: ${payload.categories}`,
          ``,
          payload.message,
          ``,
          `---`,
          `Datum: ${payload.timestamp}`,
          `URL: ${payload.url}`,
        ].join('\n'));
        window.location.href = `mailto:${cfg.fallbackEmail}?subject=${subject}&body=${body}`;
        statusEl.textContent = 'E-Mail-App wird geöffnet…';
        setTimeout(() => this.close(), 2000);
        return;
      }

      // ── Kein Endpunkt konfiguriert ──
      statusEl.textContent = '⚠ Kein Feedback-Endpunkt konfiguriert.';
      statusEl.className   = 's11fb-status-error';
      submitBtn.disabled   = false;
    },
  };
})();
