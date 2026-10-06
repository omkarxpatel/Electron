# Changelog

What each release changed, in the user's words rather than the committer's.

The section matching a release's version is published as that release's notes
and shown inside the app when it offers the update, so keep entries short and
concrete — a few lines, no internals. `scripts/release-notes.mjs` extracts
them; the release workflow fails early if the version being tagged has no
section here.

## 1.4.19 (prompt)

- New in Settings: "Install updates automatically". With it on, an update installs itself and the app restarts as soon as nothing is playing — it won't cut off a song, and it tells you what changed when it comes back. Off by default; updates keep asking first as they do now.
- The notch HUD no longer swallows clicks meant for the window behind it. An open panel claimed the whole strip across the top of the screen, transparent margin included, so a click aimed at a browser tab brought the music player forward instead. Clicking the panel itself no longer brings the app forward either — only its buttons do anything.
- Album and artist pages are rebuilt. The artwork's colour washes behind the header, albums have a Play button for the whole record, and the column headings stay put as you scroll a long one. Album tracks no longer repeat the album's artist on every row, so a guest credit stands out.
- Right-click a track and you can go to its artist — from a playlist row, and from inside an album.
- "Add to playlist" now marks the playlists that already have the song, and lists those first, so you can see where it is before deciding where it goes. The list fills in over a few seconds the first time you open it each session; a playlist it has not read yet is simply unmarked rather than claimed to be missing the song.
- Artist pages have a Popular section — the artist's top tracks, playable from there, with the full ten behind "Show all". No play counts: Spotify's API does not publish them at any tier, and the number it does publish is a different thing.
- Update checks ask for less and run twice as often, so a new version reaches you sooner.

## 1.4.18 (prompt)

- The notch HUD waits a moment before it opens. Moving the pointer across the notch on the way to a tab or a menu no longer drops the panel on top of what you were reaching for.
- Smoother opening and closing on the notch HUD. The panel, its artwork and its text now arrive together and settle, instead of landing at four slightly different times and drifting to a stop.

## 1.4.17 (silent)

- Fixed the window emptying out after updating to 1.4.15: the equalizer stretched to fill everything and the visualizer and player controls were pushed off the bottom of the screen.
- Fixed update checks reporting "Couldn't reach the update server". 1.4.16 published without the file the updater reads, so every check failed.

## 1.4.16 (silent)

- Fixed the window emptying out after updating to 1.4.15: the equalizer stretched to fill everything and the visualizer and player controls were pushed off the bottom of the screen.

## 1.4.15 (prompt)

- Right-click the track in the player bar for the same menu the track rows have: add to a playlist, add to the queue, save or remove from Liked Songs, go to the album or artist, copy a link.
- Context menus no longer close themselves a moment after opening. Any scrolling anywhere dismissed them, and the synced lyrics pane scrolls itself as the song plays.
- The back button restarts the track when you're more than a few seconds in, instead of jumping to the previous one. The player bar already did this; the arrow keys, the menu bar and the notch HUD now do it too. Double-click it to go back regardless.
- Your Stats shows top artists and top tracks as artwork rather than a list of thumbnails, and movement badges sit on the artwork instead of a column of dashes.
- The playlist you're listening to is marked in your library, and so is the folder holding it.
- Fixed the dock icon and menu bar going missing when the window opened.
- Fixed the right-hand panel sliding back over the visualizer after it had been collapsed.

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
