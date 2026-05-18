# Audio Visualizer & Modifier

[![Latest release](https://img.shields.io/github/v/release/omkarxpatel/Spotify-Visualizer-Modifier?label=latest&color=1DB954)](https://github.com/omkarxpatel/Spotify-Visualizer-Modifier/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-11%2B-555?logo=apple)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-555)](#license)

A local macOS desktop app that combines a **system-wide audio EQ**, a **real-time audio visualizer**, and a **Spotify control surface** in one window.

Runs entirely on your Mac — no servers, no telemetry. You bring your own Spotify Client ID; everything else stays on your machine.

> macOS 11 Big Sur or later. Tested on Apple Silicon and Intel.

---

## Install

1. **Download the latest `.dmg`** from the [Releases page](https://github.com/omkarxpatel/Spotify-Visualizer-Modifier/releases/latest). Pick the file that matches your Mac:
   - `AudioVisualizer-x.y.z-arm64.dmg` for Apple Silicon (M1, M2, M3, …)
   - `AudioVisualizer-x.y.z-x64.dmg` for Intel Macs
2. **Open the DMG** and drag `Audio Visualizer` into your `Applications` folder.
3. **First launch — Gatekeeper warning.** Because this app isn't code-signed (the Apple Developer Program costs $99/year and this is free), macOS will refuse to open it the normal way. Instead:
   - Open `Applications` in Finder.
   - **Right-click** (or Control-click) `Audio Visualizer` → **Open**.
   - A dialog appears asking if you're sure. Click **Open**.
   - You only have to do this once. After that, double-click works normally.

   If the right-click trick doesn't work on your macOS version: open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the `Audio Visualizer` notice that appears after you tried to launch it.

That's it. No `brew install`, no `npm install`, no Node.

---

## First-run setup

The app needs a few permissions and a Spotify Client ID before it's fully wired up.

### 1. macOS permissions

On first launch, macOS prompts you for these as you use each feature. Granting them is one click each. If you skip them you can grant later from **System Settings → Privacy & Security**.

- **Microphone** — needed for the app to list your audio input devices (the OS hides device labels from apps that don't have mic access, even if you only plan to use BlackHole).
- **Screen Recording** — needed *only* if you want to capture system audio without a virtual driver, via the **System Audio** button in the top bar. The actual screen video is discarded immediately; only audio is used.

### 2. (Optional but recommended) BlackHole 2ch

BlackHole is a free virtual audio device that lets the app capture system audio cleanly and route the processed signal back to your speakers/headphones. Without it, "Live mode" can produce a feedback loop because the processed audio gets re-captured by the OS.

Install it via Homebrew if you have it:

```sh
brew install blackhole-2ch
```

Or download the `.pkg` directly from [existential.audio/blackhole](https://existential.audio/blackhole/) and run the installer.

**Reboot once** after install so macOS picks up the driver. Then open **System Settings → Sound → Output** and choose **BlackHole 2ch**. Your Mac will go silent — that's expected. In the app's top bar, set:

- **Audio source:** BlackHole 2ch (the app will auto-pick this if it's installed)
- **Output device:** your real speakers or headphones (auto-picks an external device if you have one connected, else MacBook speakers)

Now system audio flows through the app and the EQ'd output reaches your real speakers.

If you skip BlackHole, you can still use the **System Audio** button to capture via macOS ScreenCaptureKit (requires Screen Recording permission). Live mode may feedback when used this way; visualizer-only works fine.

### 3. Spotify Client ID

The Spotify integration needs a Client ID. This is free, takes ~2 minutes, and never expires:

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and sign in with your normal Spotify account.
2. Click **Create app**, fill in any name and description (these are private to you).
3. In the new app's **Settings → Edit**, add this Redirect URI **exactly**:

   ```
   http://127.0.0.1:8888/callback
   ```

   It must be `127.0.0.1`, not `localhost` — Spotify deprecated localhost in 2024.
4. Check the **Web API** box.
5. Save, then copy the **Client ID** from the app overview page.
6. Paste it into the Audio Visualizer onboarding screen.
7. Click **Connect to Spotify** → authorize in your browser → return to the app.

You only do this once per Mac.

---

## Features

**Audio engine**
- 10 / 15 / 31-band parametric EQ (±12 dB per band) with switchable presets — Flat, Bass, Vocal, Loudness, Rock.
- Bass / Mid / Treble enhancer shelves + global volume + L/R balance.
- ±12 dB preamp.
- Bypass + reset for both EQ and enhancer.
- **AI Enhance** — adapts the EQ in real time to whatever music is playing. Lock any band to keep your manual value fixed.
- Output device picker — route processed audio to any speaker / headphone independent of macOS default.

**Visualization**
- 10 styles: spectrum, ribbon, radial, dots, mirror, bars, line, filled, particles, silk.
- 11 colour palettes that re-theme the whole UI.
- Glow, motion trail, sensitivity, smoothing.
- Pan-able EQ response curve — drag to pan horizontally + vertically, double-click to reset.
- Live FFT energy bars behind each EQ slider, showing current vs. unmodified signal level.
- 0 dB reference tick on every slider track.

**Audio analytics overlay**
- LEVEL (1-second moving-average RMS), RMS, PEAK, HOLD, CREST, STEREO (L/R correlation), CENTROID (spectral center in Hz). Tooltip on every value explains what it means.

**Multi-band drag-select**
- Click a band's frequency label to toggle it into the selection.
- Drag across labels to range-select.
- Move any selected band's slider and they all move by the same dB delta.
- Click outside / `Esc` clears.

**Spotify**
- PKCE OAuth (no client secret needed).
- Playlist browser + paginated track list + saved-albums view.
- Persistent player bar with transport, scrubber, volume.
- Live lyrics (synced when available, plain otherwise).
- Reconnect / sign out from Settings.

---

## Mouse / keyboard cheatsheet

| Action | Result |
|---|---|
| Drag the EQ response curve | Pan the visible frequency / dB window |
| Double-click the curve | Reset pan |
| Click a band's freq label (e.g. "1k") | Toggle into multi-select |
| Drag across band labels | Range-select bands |
| Drag any selected band's slider | All selected bands move by the same dB delta |
| Drag an unselected band's slider | Normal single-band adjust |
| Drag enhancer knobs vertically | Adjust value |
| Shift + drag knob | Fine adjust |
| Double-click a knob | Reset to default |
| `Esc` | Clear band selection |
| `Cmd+Shift+P` | Toggle the in-app perf overlay |

---

## Troubleshooting

**"App is damaged and can't be opened" on first launch**
This is the Gatekeeper warning for unsigned apps. Right-click the app in `Applications` → **Open**, then click **Open** in the dialog. Documented in the install section above. (`xattr -dr com.apple.quarantine /Applications/Audio\ Visualizer.app` from Terminal removes it system-wide if you prefer.)

**Live mode is silent**
Either no audio source is connected, or the output device is set to a silent virtual driver. Check the top-bar dropdowns — input should be BlackHole 2ch (or System Audio), output should be real speakers / headphones.

**Live mode feedback (loud whining / echo)**
The output device and input source are the same (or both go through BlackHole). Pick a different output device — your real speakers / headphones, not BlackHole.

**Spotify won't connect**
Make sure the redirect URI you added is exactly `http://127.0.0.1:8888/callback`. If you used `localhost`, change it. If port 8888 is taken by another app, quit it temporarily.

**Nothing happens when I click "System Audio"**
macOS is asking for Screen Recording permission. Open **System Settings → Privacy & Security → Screen Recording** and enable `Audio Visualizer`, then click System Audio again.

---

## For developers

If you want to run from source instead of the DMG:

```sh
git clone https://github.com/omkarxpatel/Spotify-Visualizer-Modifier.git
cd Spotify-Visualizer-Modifier
npm install
npm run dev
```

Builds:

```sh
npm run build          # Local DMG into release/
npm run build:unpack   # Unpacked .app (faster iteration)
npm run icon:gen       # Regenerate build/icon.icns from build/icon.svg
```

Tag-driven releases: push a tag matching `v*` and the GitHub Actions workflow builds DMG + zip for arm64 and x64, then uploads them to the GitHub Release.

```sh
npm version patch        # or minor / major
git push --follow-tags
```

---

## Tech stack

- **Electron 33** (Chromium 130, Node 20)
- **Vite 6** + `vite-plugin-electron/simple`
- **React 19** + **TypeScript 5.7** strict
- **Web Audio API** — BiquadFilter, GainNode, StereoPannerNode, AnalyserNode, ChannelSplitter, DynamicsCompressor
- **Spotify Web API** + PKCE OAuth
- **macOS ScreenCaptureKit** via Electron's `setDisplayMediaRequestHandler` with `audio: 'loopback'`
- **lrclib.net + lyrics.ovh** for synced & plain-text lyrics

No external state library — React hooks + `localStorage` for persistence.

---

## Known limitations

- **macOS only.** The audio-capture chain uses Electron + ScreenCaptureKit, which isn't available cross-platform without a different code path.
- **Unsigned `.app`.** Gatekeeper will warn on first launch; right-click → Open works around it. The Apple Developer Program ($99/year) would make this seamless but isn't worth it for a free hobby tool.
- **Live + same output as input = feedback risk.** Pick a different output than the device feeding the app's input.

---

## License

MIT — see [LICENSE](LICENSE) if present, or assume MIT terms.
