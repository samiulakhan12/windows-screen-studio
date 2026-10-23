# Feature list

Legend: **v1** = implemented in this version, *roadmap* = planned.

## Recording
- **v1** Pick any screen or window (live thumbnails).
- **v1** Microphone (device picker) + **system audio** (Windows loopback), mixed into one track.
- **v1** Webcam recorded as a separate track (device picker) for the PiP bubble.
- **v1** 3-2-1 countdown, floating always-on-top control bar with timer, pause/resume, stop, cancel.
- **v1** Global shortcut `Ctrl+Shift+2` to stop recording.
- **v1** Cursor position tracked at 60 Hz; mouse clicks via global hook (optional native module).
- **v1** Recording saved as a project folder (`project.json`, `screen.mp4`, `webcam.mp4`, `cursor.json`).
- *roadmap* Region capture, Windows Graphics Capture helper (hide OS cursor natively), keystroke capture.

## Motion engine
- **v1** **Auto zoom** generated from click clusters (zoom-in starts before the click, holds, eases out).
- **v1** Zoom camera **follows the cursor** with spring smoothing, clamped to the frame.
- **v1** **Smooth cursor**: spring-smoothed path, adjustable smoothness and size.
- **v1** Click ripple effect, hide cursor when idle.
- *roadmap* Motion blur, cursor style packs.

## Editor
- **v1** Live preview (play / pause / scrub, Space to play).
- **v1** Timeline: trim handles, zoom track (click to select, drag to move/resize, add, delete), click markers, playhead.
- **v1** Per-zoom settings: scale, focus mode (follow cursor / fixed point).
- **v1** Background: gradient presets, solid colour, custom image; padding, corner radius, shadow.
- **v1** Webcam bubble: show/hide, corner position, size, shape (circle / rounded).
- **v1** Aspect ratio presets: Auto, 16:9, 9:16, 1:1, 4:3.
- **v1** Projects library on the home screen (open / delete / reveal in Explorer); edits auto-saved.
- *roadmap* Cuts and speed segments, text annotations, undo/redo.

## Export
- **v1** MP4 (H.264 + AAC) at 720p / 1080p / 1440p / 4K, 30 or 60 fps, quality presets.
- **v1** GIF (palette-optimised) for quick sharing.
- **v1** Export renders through exactly the same compositor as the preview (WYSIWYG), with progress and cancel.
- *roadmap* Hardware encoders (NVENC / QSV / AMF), copy-to-clipboard, share links.
