# Research: what makes Screen Studio (macOS) feel good

Screen Studio is a macOS-only recorder whose output looks "produced" without manual
editing. Its signature features, gathered from the official site and reviews:

| Area | What Screen Studio does |
| --- | --- |
| Auto zoom | Detects mouse clicks and zooms into the area around them; zoom starts slightly *before* the click and follows the cursor between clicks. Users can edit zoom segments on a timeline. |
| Smooth cursor | Shaky, fast cursor motion is replaced by a smooth glide. Cursor size is adjustable; the cursor can be hidden when idle; clicks get a subtle effect. |
| Background & framing | Recording sits on a wallpaper, gradient, solid colour or custom image with padding, rounded corners, shadow and inset. |
| Camera & audio | Webcam picture-in-picture overlay, microphone and system audio. |
| Editor | Timeline with trim, zoom segments, (speed, cuts), aspect-ratio presets (16:9, 9:16, 1:1 …). |
| Export | MP4 or GIF, up to 4K60, presets for web / social / GIF. |

Known weaknesses called out by reviewers: Mac-only, subscription pricing, busy recordings
still need manual zoom tweaking.

## Existing Windows / open-source alternatives

* **OpenScreen** – MIT, Electron + React + TypeScript + PixiJS; manual zoom, pan,
  backgrounds, motion blur; uses Windows Graphics Capture on Windows. Not a 1:1 clone
  (weak auto zoom).
* **Recordly** – fork of OpenScreen adding auto zoom and cursor animations.
* **ScreenArc**, **Screenity** (browser extension), **OBS** (no auto zoom).

Takeaway: an Electron + React + TypeScript stack is a proven way to ship this category of
app on Windows. The differentiator is the *motion engine* (auto zoom + cursor smoothing)
and a pleasant editor, which is where this project focuses.

## Platform facts that shape the design (Windows)

* `desktopCapturer` + `session.setDisplayMediaRequestHandler` give screen/window video and
  **system audio via `audio: 'loopback'`** on Windows — no native driver needed.
* `screen.getCursorScreenPoint()` in the Electron main process gives cursor position with
  no native module; global **mouse clicks** need a hook → `uiohook-napi` (prebuilt Windows
  binaries; loaded optionally).
* `MediaRecorder` WebM files have no seek index/duration, so recordings are normalised
  with **ffmpeg** into an H.264 "proxy" with short GOPs that seeks frame-accurately for the
  editor and exporter. ffmpeg also encodes the final MP4/GIF.
* Chromium composites the OS cursor into desktop capture and ignores the `cursor: 'never'`
  constraint (verified: the track always reports `cursor: 'always'`). A smooth synthetic cursor
  therefore needs native capture: the app ships a small Windows Graphics Capture helper
  (`IsCursorCaptureEnabled=false`, see `native/`) and falls back to Chromium capture, with the
  Windows cursor in the video, where the helper is unavailable.

Sources: [screen.studio](https://screen.studio/), [screen.studio/help](https://Screen.studio/help),
[Trainn review](https://trainn.co/blog/screen-studio-reviews/),
[Filmora review](https://filmora.wondershare.com/video-editor-review/screen-studio-review.html),
[OpenScreen docs](https://mintlify.com/siddharthvaddem/openscreen/introduction),
[OpenScreen FAQ](https://www.mintlify.com/siddharthvaddem/openscreen/reference/faq),
[AlternativeTo](https://alternativeto.net/software/screen-story).
