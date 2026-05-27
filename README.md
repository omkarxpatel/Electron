# Electron

> **macOS audio visualizer + system-wide EQ + Spotify control surface.**

[![Latest release](https://img.shields.io/github/v/release/omkarxpatel/Electron?label=latest&color=1DB954)](https://github.com/omkarxpatel/Electron/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-11%2B-555?logo=apple)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-555)](#license)

A local macOS desktop app that combines a **system-wide audio EQ**, a **real-time audio visualizer**, and a **Spotify control surface** in one window.

Runs entirely on your Mac — no servers, no telemetry. You bring your own Spotify Client ID; everything else stays on your machine.

> macOS 11 Big Sur or later. Tested on Apple Silicon and Intel.

<img width="1512" height="952" alt="image" src="https://github.com/user-attachments/assets/01be2a14-2242-4f1a-8387-1a9a96949811" />

---

## Contents

- [Install](#install)
- [First-run setup](#first-run-setup)
  - [macOS permissions](#1-macos-permissions)
  - [BlackHole 2ch](#2-optional-but-recommended-blackhole-2ch)
  - [Spotify Client ID](#3-spotify-client-id)
- [Features](#features)
- [Mouse / keyboard cheatsheet](#mouse--keyboard-cheatsheet)
- [Troubleshooting](#troubleshooting)
  - [Install / launch issues](#install--launch-issues) — "damaged" error, right-click → Open, hidden window
  - [No audio when Live is on](#i-clicked-live-but-i-dont-hear-any-audio) — diagnostic walkthrough
  - [Audio is too quiet](#audio-is-playing-but-its-too-quiet) — volume, preamp, output device
  - [Other](#other) — feedback, Spotify connect, permissions, empty device list
- [For developers](#for-developers)
- [Tech stack](#tech-stack)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Install

1. **Download the latest `.dmg`** from the [Releases page](https://github.com/omkarxpatel/Electron/releases/latest). Pick the file that matches your Mac:
   - `Electron-x.y.z-arm64.dmg` for Apple Silicon (M1, M2, M3, …)
   - `Electron-x.y.z-x64.dmg` for Intel Macs
2. **Open the DMG** and drag `Electron` into your `Applications` folder.
3. **First launch — "Electron is damaged and can't be opened"** ← **this is expected**, and the message is misleading. The app is unsigned (the Apple Developer Program costs $99/year and this is a free hobby tool), so macOS slaps a quarantine flag on it that the OS interprets as "damaged." Strip the flag and the app launches normally:

   ### The simplest fix (works on all macOS versions)

   **Don't move the `.app` into `/Applications` yet.** Open Terminal and run these three commands one at a time:

   ```sh
   xattr -cr ~/Downloads/Electron.app
   mv ~/Downloads/Electron.app /Applications/
   open /Applications/Electron.app
   ```

   - The first command strips the quarantine flag while the app is still in `~/Downloads` (where Terminal has unrestricted access).
   - The second command moves it to `/Applications`.
   - The third launches it. macOS will accept it because the quarantine is already gone.

   ### If you already moved it to /Applications and it's "damaged"

   `xattr` directly in `/Applications` will fail with `Operation not permitted` on modern macOS — Apple introduced **App Management** protection that blocks Terminal from modifying apps in `/Applications` by default. Two paths:

   ```sh
   # Path A: move it out, fix it, move it back
   mv "/Applications/Electron.app" ~/Desktop/
   xattr -cr ~/Desktop/Electron.app
   mv ~/Desktop/Electron.app /Applications/
   ```

   ```
   Path B: grant Terminal App Management permission
     System Settings → Privacy & Security → App Management → toggle Terminal on
     Restart Terminal, then:
     xattr -cr "/Applications/Electron.app"
   ```

   Path A is one-shot; Path B is permanent (helpful if you anticipate more unsigned-app upgrades).

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
6. Paste it into the Electron onboarding screen.
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

### Install / launch issues

**"Electron is damaged and can't be opened"**
Misleading message — the app isn't damaged, it's unsigned. macOS slaps a quarantine flag on anything downloaded by a browser, and recent macOS versions reject unsigned apps with that flag much more aggressively than they used to. The fix is documented in the [Install](#install) section above. Short version: run `xattr -cr` against the app *while it's in your `~/Downloads`*, then move it to `/Applications`.

**"Operation not permitted" when I try `xattr` on an app in /Applications**
Apple added **App Management** protection on recent macOS — Terminal can't modify apps in `/Applications` without explicit permission. Two ways out:
- Move the app to your Desktop or Downloads, run `xattr -cr` there, move it back. The flag clear travels with the file.
- Grant Terminal App Management permission: **System Settings → Privacy & Security → App Management** → toggle Terminal on, restart Terminal, then re-run `xattr -cr`.

**Right-click → Open does nothing on macOS 15+**
The old workaround stopped working on newer macOS. Use the `xattr` command above instead.

**App opens but window is hidden / nothing visible**
The app launched in the background. Click its icon in the Dock, or press `Cmd+Tab` to bring it forward.

---

### "I clicked Live but I don't hear any audio"

Walk through these in order — most "no sound" cases are one of the first three.

**1. Is something actually playing?**
Spotify (or any audio source) needs to be playing on your Mac. Confirm by toggling **Live OFF** — if you can hear the source through your speakers normally, audio is reaching macOS at least.

**2. macOS output device — what is the system playing through?**
Click the volume icon in the menu bar. The selected output (highlighted) is where macOS sends audio.

- If you're using **BlackHole as input** for the app: macOS output **must be BlackHole 2ch** so the app can capture the signal. (Your real speakers go silent — that's expected.)
- If you're using **System Audio** mode (top-bar button): macOS output can be your real speakers, headphones, etc.

**3. App's "Output device" dropdown — where does the processed signal go?**
Top bar, second-to-last dropdown. The processed audio routes here.

- Set this to a **real output** (AirPods, headphones, MacBook speakers — NOT BlackHole, or you'll create a silent feedback loop).
- "System default" follows macOS's output — if macOS is set to BlackHole, "System default" also goes to BlackHole, which is silent. Pick a real device explicitly.

**4. Is "Live" actually ON?**
The Live indicator in the top right needs the orange dot lit. Without it, the app is in "visualize only" mode — no output through the app's chain, system audio plays directly through wherever macOS is routing it.

**5. Did you connect AirPods / Bluetooth headphones AFTER launching the app?**
Known caveat: the output picker doesn't auto-re-route when a new device connects mid-session. Open the **Output device** dropdown and pick the AirPods manually.

**6. Audio worked, then stopped after switching sources**
The audio context can get stuck on a stale device handle. Source picker → Disconnect → reconnect. If that doesn't help, quit and relaunch the app.

---

### Audio is playing but it's too quiet

The app's chain is unity-gain at default settings; the volume knob (in the Enhancer panel) is a literal multiplier on top of that. 0..250%.

- **100%** = same loudness as direct macOS playback.
- **200%+** = noticeably louder for quietly-mastered content (classical, podcasts, older recordings). For modern hip-hop / pop already mastered near 0 dBFS, peaks will clip past ~150% — that's the digital ceiling, not a bug.
- The **Preamp** slider (vertical, left of the EQ bands) adds another ±12 dB before EQ.
- The **Bass / Mid / Treble** knobs add ±12 dB each at their respective shelf frequencies.

If audio still feels quieter than direct playback at 100%, check:
- macOS app-level volume (System Settings → Sound → some macOS versions expose a per-app mixer).
- The output device's own volume (AirPods have hardware volume; some Bluetooth speakers have an internal level).

---

### Other

**Live mode feedback (loud whining / echo)**
The output device and input source are routed through the same path. If your input is BlackHole, your output must NOT be BlackHole. Set the **Output device** dropdown to a real device.

**Spotify won't connect**
- Redirect URI in your Spotify dashboard must be exactly `http://127.0.0.1:8888/callback`. Not `localhost` — Spotify deprecated localhost in 2024.
- Port 8888 must be free. Quit any other dev server using it temporarily.
- If the browser tab opens but never returns to the app, the redirect URI is probably wrong. Double-check it character-by-character.

**Nothing happens when I click "System Audio"**
macOS is asking for Screen Recording permission silently. Open **System Settings → Privacy & Security → Screen Recording**, enable `Electron`, then click System Audio again.

**Input device dropdown is empty**
macOS hides device labels from apps without microphone permission, even if you only plan to use BlackHole. Click "Grant microphone access" in the source dropdown when prompted, or go to **System Settings → Privacy & Security → Microphone** and enable the app.

---

## For developers

If you want to run from source instead of the DMG:

```sh
git clone https://github.com/omkarxpatel/Electron.git
cd Electron
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
