/*
 * Capture shim — injected into a COPY of dist/index.html, as a classic script
 * ahead of the app's module bundle, so it runs first (modules are deferred).
 *
 * It exists so screenshots can be taken without a microphone, without
 * BlackHole, without a Spotify account and without touching the user's real
 * settings. The app runs completely unmodified; only the two browser APIs it
 * gets its audio from are replaced.
 *
 * Why not Chromium's --use-file-for-fake-audio-capture: the fake devices
 * enumerate and the track reports unmuted, but the analyser reads zero across
 * every bin. Measured, not assumed. Synthesising the stream in-page is also
 * deterministic, which matters more for screenshots than realism does.
 */
(() => {
  // Config arrives as a base64 query param, not an inline <script>: the
  // renderer's CSP is script-src 'self', so inline is blocked outright.
  let cfg = {};
  try {
    const raw = new URLSearchParams(location.search).get('cap');
    if (raw) cfg = JSON.parse(atob(raw));
  } catch { /* no config is a valid run */ }

  // ── Settings seeding ────────────────────────────────────────────────────
  // Before the app's modules run, so its first render is already correct and
  // nothing has to be clicked (and no transition has to be waited out).
  try {
    if (cfg.settings) {
      // av.settings.v3 is NESTED: the per-style knobs live under
      // profiles.banner / profiles.immersive, and only palette and the
      // display toggles sit at the top. Writing waveformStyle flat looks like
      // it works — nothing errors, the key is simply ignored and the app
      // renders its defaults, which is a confusing way to lose a scene.
      // A scene declares the knobs flat and this splits them.
      const KEY = 'av.settings.v3';
      const VISUAL = [
        'waveformStyle', 'glow', 'sensitivity', 'autoGain', 'spectralPosition',
        'trail', 'smoothing', 'barWidth', 'barGap', 'particleDensity',
        'particleSize', 'scopeDensity', 'scopeAmbience',
      ];
      const prev = JSON.parse(localStorage.getItem(KEY) || '{}');
      const top = {};
      const visual = {};
      for (const [k, v] of Object.entries(cfg.settings)) {
        (VISUAL.includes(k) ? visual : top)[k] = v;
      }
      localStorage.setItem(KEY, JSON.stringify({
        ...prev,
        ...top,
        profiles: {
          // Both, so a scene that flips to visuals-only keeps its look.
          banner: { ...(prev.profiles?.banner || {}), ...visual },
          immersive: { ...(prev.profiles?.immersive || {}), ...visual },
        },
      }));
    }
    // Credentials the app treats as a live session. They are never sent
    // anywhere — fixtures.js answers every Spotify request locally. Without
    // these the onboarding pane covers the whole workspace and there is
    // nothing to photograph.
    if (cfg.spotify !== false) {
      localStorage.setItem('av.spotify.clientId', 'capture0000000000000000000000000');
      localStorage.setItem('av.spotify.accessToken', 'capture-token');
      localStorage.setItem('av.spotify.refreshToken', 'capture-refresh');
      localStorage.setItem('av.spotify.tokenExpiry', String(Date.now() + 3600e3));
      if (cfg.playlistId) localStorage.setItem('av.spotify.lastPlaylistId', cfg.playlistId);
    }
    for (const [k, v] of Object.entries(cfg.storage || {})) localStorage.setItem(k, v);
  } catch { /* fresh profile, nothing to merge */ }

  // ── Synthetic audio ─────────────────────────────────────────────────────

  const SR = 48000;
  const BARS = 4;
  const BPM = 120;

  /** One loopable bar-aligned buffer. Kick, sub, pad and hats, because a
   *  single tone leaves most of the spectrum flat and the visualiser looks
   *  broken rather than quiet. */
  function buildLoop(ctx) {
    const secs = (60 / BPM) * 4 * BARS;
    const n = Math.floor(SR * secs);
    const buf = ctx.createBuffer(2, n, SR);
    const spb = (60 / BPM) * SR;
    const roots = [55, 65.41, 73.42, 49];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const beat = i / spb;
      const inBeat = beat % 1;
      const root = roots[Math.floor(beat / 4) % roots.length];
      let s = 0;
      s += Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-inBeat * 26)) * t) * Math.exp(-inBeat * 14) * 0.85;
      s += Math.sin(2 * Math.PI * root * t) * 0.3 * (0.6 + 0.4 * Math.exp(-inBeat * 3));
      for (const m of [1, 1.26, 1.5, 2.01]) {
        s += Math.sin(2 * Math.PI * root * 2 * m * t + Math.sin(t * 0.7) * 2) * 0.075;
      }
      s += rnd() * Math.exp(-((beat * 2) % 1) * 45) * 0.22;
      s += rnd() * 0.012;
      const w = 0.06 * Math.sin(2 * Math.PI * 0.25 * t);
      L[i] = s * (1 - w);
      R[i] = s * (1 + w);
    }
    return buf;
  }

  let stream = null;
  function synthStream() {
    if (stream) return stream;
    const ctx = new AudioContext({ sampleRate: SR });
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buildLoop(ctx);
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(dest);
    src.start();
    if (ctx.state !== 'running') void ctx.resume();
    stream = dest.stream;
    return stream;
  }

  // ── Device API ──────────────────────────────────────────────────────────
  // Labelled "BlackHole 2ch" deliberately: useAutoSelectDevices picks that by
  // name on launch, so Live engages with nothing to click.

  const FAKE_INPUT = {
    deviceId: 'capture-input',
    groupId: 'capture',
    kind: 'audioinput',
    label: 'BlackHole 2ch',
  };
  const FAKE_OUTPUT = {
    deviceId: 'capture-output',
    groupId: 'capture-out',
    kind: 'audiooutput',
    label: 'Studio Display Speakers',
  };
  const devices = [FAKE_INPUT, FAKE_OUTPUT].map((d) => ({ ...d, toJSON: () => d }));

  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => devices;
  md.getUserMedia = async () => synthStream();
  // System Audio mode lands here; same stream, so the button works too.
  md.getDisplayMedia = async () => synthStream();

  // ── Test hooks ──────────────────────────────────────────────────────────
  window.__cap = {
    ready: () => !!document.querySelector('canvas'),
    click(sel) {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    },
    clickText(sel, text) {
      const el = [...document.querySelectorAll(sel)].find(
        (e) => (e.textContent || '').trim().toLowerCase() === text.toLowerCase(),
      );
      if (!el) return false;
      el.click();
      return true;
    },
  };
})();
