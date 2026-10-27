# Release notes

## Next release

- **Bangla captions on this PC**: a Bangla-only speech model (Bengali.AI's Whisper medium, 539 MB,
  free, works offline once downloaded). Choose *Bengali* as the spoken language and the Captions
  tab recommends it: *Download Bangla model (539 MB) and make captions*. It gets about 4 in 5
  Bangla words right, where the other models get most of them wrong. Once downloaded, Bengali
  uses it, including in Polish in one click; other languages never do, and existing settings,
  projects and other languages behave exactly as before. It needs an 8 GB PC with AVX2 and takes
  about as long as the recording or longer; its captions have no punctuation.
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
