# Core Audio process-tap spike

Answers one question: **can we replace the BlackHole requirement with a
driverless Core Audio process tap that the app's existing
`getUserMedia({ deviceId })` path can open unchanged?**

**Answer: yes**, with one non-obvious constraint (see "tap-only aggregate").

Not wired into the app. Standalone, build and run by hand.

```sh
swiftc -O main.swift -o tapspike -framework CoreAudio -framework AudioToolbox

./tapspike --list                        # devices + current defaults
./tapspike --cleanup                     # destroy leaked aggregates (see below)
./tapspike --selftest --no-subdevice     # read the tap in-process, report peak
./run-test.sh --no-subdevice             # full chain: tap -> Chromium getUserMedia
```

## Verified results (macOS 26.4.1, Electron 33.4.11, Swift 6.3.3)

| Capability | Result |
|---|---|
| Tap creation (`AudioHardwareCreateProcessTap`) | works, no driver, no reboot |
| Aggregate device visible to other processes | yes |
| Visible in Chromium `enumerateDevices()` | yes — `"AV Tap Spike (Aggregate)"` |
| Audio delivered through `getUserMedia` | **yes — peak 0.8545** |
| Mute source while still capturing (`CATapMuted`) | yes — captures at 0.8545 while silencing output |
| Exclude a process from the tap | yes — excluded process's audio absent (peak 3e-11) |
| Mute state restored on clean teardown | yes |

Peak 0.8545 is an exact match for the 28000/32768 test tone, i.e. the tap is
bit-accurate, not merely non-silent.

## The one constraint that matters: tap-only aggregate

Apple's sample wires the default output device into the aggregate as a
sub-device to anchor the clock. **Don't** — do that and the aggregate exposes
two input streams, the output device's stream lands first, and Chromium reads
only stream 0. You get a device that enumerates correctly, hands back a `live`
unmuted track, and delivers pure silence forever.

- With output sub-device: Swift IOProc reads audio (stream 1), Chromium reads silence (stream 0).
- Tap only (`--no-subdevice`): one input stream, both paths read audio.

This is the difference between the approach working and appearing impossible.

## Gotchas found the hard way

1. **`kill -9` leaks BOTH the aggregate device AND the tap — and the tap is
   the dangerous one.** A leaked aggregate is merely confusing: it enumerates
   and returns silence, which is a convincing false negative. A leaked tap
   created with `.muted` keeps muting audio at the **process** level, upstream
   of every output device, so the machine stays silent no matter which output
   the user selects — built-in, AirPods, anything. Switching output devices
   does not help, which makes it look like unrelated hardware breakage.

   This bit once for real. `--cleanup` originally swept only aggregates, so it
   reported "0 leaked devices" while a muted tap was still live and the user's
   audio was dead. Always SIGTERM, never `kill -9`. `--cleanup` now sweeps
   taps (matched by name, so other apps' taps are untouched) as well as
   aggregates, and the create path sweeps both before starting.

   To check by hand: enumerate `kAudioHardwarePropertyTapList` and destroy
   anything named "AV Tap Spike" with `AudioHardwareDestroyProcessTap`.

2. **Excluding a process that isn't currently playing audio fails.**
   `kAudioHardwarePropertyTranslatePIDToProcessObject` returns object 0 and tap
   creation fails with `'!obj'`. So excluding *our own* process needs our
   playback running first. On macOS 26+, `CATapDescription.bundleIDs` +
   `processRestoreEnabled` sidestep PIDs entirely — prefer those.

3. **A muted output device masquerades as a broken tap.** Check
   `osascript -e 'get volume settings'` before trusting a zero reading.

4. **Count bytes, not callbacks.** IOProc callbacks fire at the right rate with
   empty buffers, so "callbacks > 0" proves nothing. `--selftest` reports
   buffers/bytes/nil-data/samples separately for this reason.

5. CoreAudio publishes a new aggregate **asynchronously** — the creating
   process may not see it in its own immediate enumeration. Poll.

## Architecture this unlocks

Global tap excluding our own process, `muteBehavior = .muted`: the OS captures
everything except us and silences it at the hardware, we play the processed
signal out our own untapped output. That is exactly what the BlackHole routing
achieves today, with no install, no reboot, and no System Settings trip — one
"System Audio Recording" TCC prompt instead.

Keep the BlackHole path as the fallback: taps need **macOS 14.2+**, and a bare
CLI has no bundle so the permission is attributed to the *parent* process
(terminal/IDE) rather than to the binary.
