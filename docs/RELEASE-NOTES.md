# Release notes

## Next release

- **Clean voice** (F-08): one switch in the Audio panel removes fan hum, keyboard and mouse clicks
  and room noise from your microphone, on this PC. Choose Light, Normal or Strong; the cleaned voice
  is made once (with progress and Cancel) and the preview plays it, with *Hear the original* to
  compare. The export uses the same cleaned voice. Projects with the switch off are unchanged.
- **Select several items and edit them together** (E-06): `Ctrl`+click or `Shift`+click items on
  the timeline, `Shift`+drag a box across the tracks, or press `Ctrl+A` (again for every item);
  `Ctrl`+click works on the paused preview too, and `Esc` clears. Drag one selected item to move
  them all with their spacing kept. The Inspector's new *Selection* view edits what they share
  (zoom level, text size, shape colour, title card style, freeze length, …) with *Mixed* where they
  differ, and moves them or sets their length. `Delete`, `Ctrl+X` / `Ctrl+C` / `Ctrl+V` (pasted at
  the playhead), `Ctrl+D` to duplicate, and `Ctrl+Shift+C` / `Ctrl+Shift+V` to copy one item's look
  onto others. Every group action is one undo step. Zooms, text, shapes, blur, spotlights, title
  cards, chapters and freeze frames can be selected together; captions, camera layouts, clips and
  clicks stay one at a time. Existing projects open, preview and export exactly as before.
- **Image overlays and stickers** (NW-12): put a logo, a screenshot, an animated GIF or one of 12
  built-in stickers on the video from the new Images tab, by dropping a file on the editor or by
  pasting it. Move, resize, rotate, fade and trim it; GIFs play frame-exact in the export.
- **Brand fonts** (NW-12): text, title cards and captions can use your own TTF, OTF or WOFF2 font,
  copied into the project so it looks the same on another PC. A missing font is drawn with Segoe UI
  and the editor says so.
- **Brand kit** (E-03): save your logo, colours, fonts, intro and outro title cards and a style
  preset once in Settings › Brand kit, apply them to a video in one click (one undo step), or let
  every new recording start with them. Projects and settings from earlier versions open unchanged.
- **Bangla captions on this PC**: a Bangla-only speech model (Bengali.AI's Whisper medium, 539 MB,
  free, works offline once downloaded). Choose *Bengali* as the spoken language and the Captions
  tab recommends it: *Download Bangla model (539 MB) and make captions*. It gets about 4 in 5
  Bangla words right, where the other models get most of them wrong. Once downloaded, Bengali
  uses it, including in Polish in one click; other languages never do, and existing settings,
  projects and other languages behave exactly as before. It needs an 8 GB PC with AVX2 and takes
  about as long as the recording or longer; its captions have no punctuation and are cut at the
  speaker's pauses into short ones (at most 7 s).
- **Captions on this PC** (F-01): free, private captions with exact word timings from a Whisper
  model that runs on your PC, with no key, no upload and no cost. The model (60 MB for Standard)
  is downloaded once, after you click a button that names its size. Captions keep working after
  OpenAI retires `whisper-1` on 26 February 2027.
- **Speech detector** (F-03): Remove silences, Smart speed, music ducking and the camera director
  now listen for your voice on the microphone, so typing, clicks and fans no longer count as sound.
  **Existing projects' music ducking changes at their next export**: the music ducks under your
  speech (and sound your PC plays, as before), no longer under typing.
- **Polish in one click** makes its captions on this PC once a speech model is downloaded, with no
  AI provider needed. It never starts a download, and when *On this PC* is chosen but no model is
  downloaded it leaves captions out instead of uploading the sound.
- About › *Third-party notices* lists the licences of the bundled components.
