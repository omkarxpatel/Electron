# Audio Visualizer & Modifier

A local macOS desktop app that combines a **system-wide audio EQ**, a **real-time audio visualizer**, and a **Spotify control surface** in one window.

Built with Electron + React + Web Audio API. Runs locally on your Mac — no servers, no telemetry. Bring your own Spotify Client ID.

> ⚠️ macOS only (audio capture depends on macOS-specific APIs). Tested on Apple Silicon, Sonoma+.

---

## Features

**Audio engine**
- 10 / 15 / 31-band parametric EQ (±12 dB per band) with switchable presets (Flat, Bass, Vocal, Loudness, Rock)
- Bass / Mid / Treble enhancer shelves + global volume + L/R balance
- ±12 dB preamp
- Bypass + reset for both EQ and enhancer
- Output device picker — route the processed audio to any speaker / headphone independent of macOS default

**Visualization**
- 8 waveform styles: spectrum, ribbon, radial, dots, mirror, bars, line, filled
- 11 color palettes that re-theme the whole UI (every accent in the app follows the active palette)
- Glow, motion trail, sensitivity, and smoothing settings
- Pan-able EQ response curve (drag to pan horizontally + vertically, double-click to reset)
- Live FFT energy bars **behind** each EQ slider showing current (post-EQ) vs unmodified signal level
- 0 dB reference tick on every slider track

**Audio analytics overlay**
- LEVEL (1-second moving-average RMS)
- RMS (per-frame)
- PEAK (instantaneous)
- HOLD (peak with slow decay)
- CREST (peak − RMS dynamic range)
- STEREO (L/R Pearson correlation)
- CENTROID (spectral center, in Hz)
- Tooltips on each explaining what they mean

**Multi-band drag-select**
- Click a band's frequency label to toggle it into the selection (pick non-contiguous bands)
- Drag across labels to range-select
- Move any selected band's slider — they all move by the same dB delta with per-band clamping
- Click anywhere outside the bands or press `Esc` to clear

**Spotify**
- PKCE OAuth (no client secret needed)
- Playlist browser + paginated track list
- Persistent player bar with transport, scrubber, and volume
- Reconnect button if tokens expire
- Collapsible playlist sidebar

---

## Setup

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 20 or later (`node -v`) + npm
- A Spotify account
- (Recommended) [BlackHole 2ch](https://existential.audio/blackhole/) for clean system-wide EQ routing

### 1. Install BlackHole (optional but recommended)

BlackHole is a free virtual audio device that lets the app capture system audio cleanly without feedback. To install:

```bash
brew install blackhole-2ch
```

…or download the `.pkg` installer from https://existential.audio/blackhole/. **Reboot** after installing so macOS picks up the driver.

Then open **System Settings → Sound → Output** and select **BlackHole 2ch**. Your Mac will go silent — that's expected. You'll route audio back out through the app's output device picker.

If you skip BlackHole, you can still use the app's "System Audio" capture mode (which uses macOS ScreenCaptureKit), but Live mode may produce a feedback loop because the processed audio gets re-captured.

### 2. Create a Spotify Developer app

You need a Client ID to use the Spotify integration. This is free and takes ~2 minutes:

1. Go to https://developer.spotify.com/dashboard
2. **Create app** → fill in any name/description
3. In the app's **Settings → Edit**, add this Redirect URI **exactly**:
   ```
   http://127.0.0.1:8888/callback
   ```
   (note: must be `127.0.0.1`, not `localhost` — Spotify deprecated localhost in 2024)
4. Check the **Web API** box
5. Save, then copy the **Client ID** from the app overview page

You'll paste this Client ID into the app on first launch. You do **not** need the Client Secret — the app uses PKCE OAuth.

### 3. Clone + run

```bash
git clone https://github.com/<your-username>/audio-visualizer.git
cd audio-visualizer
npm install
npm run dev
```

This launches Vite + Electron together with hot reload. The app window opens automatically.

### 4. First launch

1. Paste your Spotify **Client ID** → **Save Client ID**
2. **Connect to Spotify** → authorize in your browser → return to the app
3. In the topbar:
   - **Audio source**: pick **System Audio** (ScreenCaptureKit) or **Device** → **BlackHole 2ch**
   - **Output device**: pick where the processed audio plays (MacBook Speakers, your headphones, etc.) — important when using BlackHole, since the macOS default is the silent virtual device
4. Toggle **Live** ON in the EQ header to start processing
5. Play a track via the Spotify panel and you should see the curve, activity bars, and visualizer come alive

### 5. (Optional) Build a packaged `.app`

```bash
npm run build
```

Produces a `.dmg` in `release/`. The app is not signed/notarized — fine for personal use, but macOS Gatekeeper will warn on first launch (right-click → Open).

---

## Mouse / keyboard interactions

| Action | Result |
|---|---|
| Drag the EQ response curve | Pan the visible frequency / dB window |
| Double-click the curve | Reset pan to default view |
| Click a band's freq label (e.g. "1k") | Toggle that band into the multi-select |
| Drag across band labels | Range-select bands |
| Click outside the bands grid | Clear selection |
| `Esc` | Clear selection |
| Drag any selected band's slider | All selected bands move by the same dB delta |
| Drag a single (unselected) band's slider | Normal single-band adjustment |
| Drag enhancer knobs vertically | Adjust value |
| Shift + drag knob | Fine adjust |
| Double-click a knob | Reset to default |
| `×` on stats overlay | Collapse the analytics readout |

---

## Tech stack

- **Electron 33** (Chromium 130, Node 20)
- **Vite 6** + `vite-plugin-electron/simple`
- **React 19** + **TypeScript 5.7** strict
- **Web Audio API** — BiquadFilter, GainNode, StereoPannerNode, AnalyserNode, ChannelSplitter
- **Spotify Web API** + PKCE OAuth
- **macOS ScreenCaptureKit** via Electron's `setDisplayMediaRequestHandler` with `audio: 'loopback'`

No external state library — React hooks + `localStorage` for persistence.

---

## Known limitations

- **macOS only.** The audio capture chain uses Electron + ScreenCaptureKit which isn't available cross-platform without a different code path.
- **No signed `.app`.** Personal use only.
- **Live + same output device = feedback risk.** Pick a different output device than the one feeding into the app's input, or use BlackHole + a real output device.

---

## License

MIT
