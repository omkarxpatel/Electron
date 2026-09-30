# Changelog

What each release changed, in the user's words rather than the committer's.

The section matching a release's version is published as that release's notes
and shown inside the app when it offers the update, so keep entries short and
concrete — a few lines, no internals. `scripts/release-notes.mjs` extracts
them; the release workflow fails early if the version being tagged has no
section here.

## 1.4.14 (prompt)

- New DJ view, in the library panel next to Queue. Pick a playlist or a folder and it ranks what should play next against whatever is playing — on key, tempo and loudness — says why ("9B, one step round the wheel, and four BPM up"), and queues it. It'll read that out loud too, ducking the music under the voice.
- Steer it by typing: "something chill", "pick up the energy", "keep it in this key". It tells you what it understood, and tells you when it didn't.
- It only knows tracks this app has heard. Spotify stopped publishing key and tempo in 2024, so the app works them out by listening, and every list says how many of its tracks have been analysed — a short list is explained rather than mysterious.
- The EQ column now shows the key and tempo of what's playing, as a Camelot code.
- Key and tempo detection are much more accurate. Key was reading a fifth too high on a third of tracks, and tempo was latching onto off-beat subdivisions. Checked against 189 passages of real music with published key and tempo: key right 45% → 62%, tempo within 1 BPM 51% → 78%.
- Fixed tempo never being measured at all — the detector ran, but its output never reached the app.

## 1.4.13 (prompt)

- Playlist folders. Make folders, nest them, and drag playlists in or right-click one and pick "Move to folder". Spotify has no API for folders, so these live in this app and don't sync back to Spotify.
- "Import from Spotify" reads your existing folder structure from the Spotify desktop app on this Mac, so you don't have to file everything by hand. Spotify's own playlists — Blends, Daily Mixes — can't come with it, because third-party apps lost access to them; the import says how many it skipped.
- The app now remembers how each track sounds. AI Enhance used to spend 20 seconds measuring a track's tonal balance before it could correct it; a track you've heard before is now corrected from the downbeat. Settings -> Track memory, with a Clear button.
- New "Level-match tracks", which evens out loudness between tracks you've already heard, using the same BS.1770 standard the streaming services normalise with.
- Long playlist names no longer overprint the tiles either side of them in search results and the library.

## 1.4.12 (silent)

- Bigger playlist and Liked Songs cover art in the sidebar.

## 1.4.11 (silent)

- Fixed the "Suggested" tag appearing on tracks that are in the playlist you're playing, including ones you picked yourself.
- The play button on a playlist now shows Pause while that playlist is the thing playing.
- Bigger album art in the player bar.

## 1.4.10 (prompt)

- Fixed the app starting at almost no volume. Holding your output device at 100% was being offset by turning your system volume down, and that offset was re-applied on every launch until the slider was at the floor.
- Live may now be noticeably louder when you turn it on, which is the output cap actually being lifted. The menu bar slider covers the full range if it goes further than you want, and that stays put.
- The note in the output menu explaining the held level is shorter.

## 1.4.9 (prompt)

- Clicking a song no longer starts it. Hover a row and its number turns into a play button, or double-click anywhere on the row — the same as Spotify. Reading a list, right-clicking a track or dragging one to reorder no longer risks replacing what you're listening to.
- Search results still play on a single click, since picking one is the whole point of having searched.

## 1.4.8 (silent)

- The note explaining that your output device is being held at 100% now appears inside the output menu, instead of floating under it all the time. Opening the menu is where you'd look for it anyway.

## 1.4.7 (prompt)

- The update prompt is now part of the app instead of a macOS alert, and it lists what's in the release. The notes used to appear in a strip along the top, where longer ones were cut off mid-sentence.
- You can close the prompt and decide later — it stays under Settings → About.

## 1.4.6 (prompt)

- The playlist panel can now be folded away. The chevron in its header slides it off to the right and hands the whole window to the visualizer and EQ; a tab on the right edge brings it back. Your music, playlist and place in the list are untouched while it's closed.

## 1.4.5 (prompt)

- Skipping a version no longer makes Settings claim you're up to date. It now says the update is there and that you skipped it; "Check for updates" still brings it back.
- Small fixes can now install themselves. When a release is only bug fixes it downloads quietly and applies on your next quit — or while you're away from the Mac with nothing playing. It will never restart the app while audio is going, and anything bigger than a fix still asks first.

## 1.4.4

- Fixed "Report a bug" and "Send feedback" in Settings doing nothing when clicked.
- The reset confirmation now reads "Confirm" rather than "Really reset?".

## 1.4.3

- Fixed "Couldn't set output level" on AirPods and other Bluetooth headphones, which stopped 1.4.0's full-volume fix from working on them at all.
- Turning Live on no longer makes things suddenly louder. Your volume setting is moved onto the menu bar slider rather than simply raised, so the level stays where it was — the slider just works across its full range now.

## 1.4.2

- Update prompts now say what's new and what's fixed, instead of only a version number.

## 1.4.1

- Fixed the notch panel sometimes getting stuck open, floating above every app with no way to dismiss it.
- Rolls up the fixes from 1.3.1 and 1.4.0, which were published separately and left the update pointer on the older of the two.

## 1.4.0

- Live mode can now reach full volume: the output device is held at unity, so the macOS volume slider works across the whole range instead of topping out early.

## 1.3.1

- Closing the window now quits the app, the notch HUD included. It used to stay running in the menu bar and leave the panel on screen.

## 1.3.0

- **New: the Notch HUD.** Music controls that hang from the MacBook notch and stay on screen while you work in another app — artwork, the current lyric, a scrubber and transport. Turn it on under Settings. Note that it hides the Dock icon, which macOS requires for a panel to float over fullscreen apps.
- **Much faster visuals.** Bars, Mirror, Spectrum and Radial were re-drawing far more than they needed to and ran at 17–24 fps; they now hold 120. Nothing about how they look changed.
- The app measures your Mac on first run and picks a quality tier to match it, so weaker machines get fewer pixels rather than fewer frames.
- AI Enhance highlights every band it changes, instead of only some of them.
- Spotify: right-click a track to add it to a playlist, queue it or copy its link; playlists open at the top instead of keeping the previous scroll position; and there's a listening-stats view.
