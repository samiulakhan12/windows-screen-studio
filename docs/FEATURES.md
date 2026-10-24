# Feature list

Legend: **✓** shipped · *roadmap* = planned. "Windows-unverified" marks behaviour that is implemented
and tested on Linux / with stand-ins, but has not yet been run on a real Windows PC.

## Recording
- ✓ Pick a full screen, an **area** (drag a rectangle on a transparent overlay; move/resize handles, size readout, Enter/Esc), or a single window. Source thumbnails refresh on demand.
- ✓ **Single-window recordings keep every cursor effect**: the native helper records just that window without the Windows cursor (`record --window`) and reports where the window is as it moves, resizes or is minimised; cursor samples and clicks are mapped into the window, so auto zoom, click ripples, follow-cursor zooms and the smooth cursor (with real cursor shapes) all work. A resized window is fitted into the original frame with the same rule everywhere. Clicks on another app's window covering the recorded one are ignored (and the cursor is hidden there); dragging the window keeps the cursor aligned; windows spanning monitors with different scaling are mapped correctly. Without native window capture the window is recorded by Chromium while the helper only watches its position (`watch-window`): auto zoom and ripples still work, with the Windows cursor in the video. *Windows-unverified.*
- ✓ Microphone (device picker, falls back to the default device with a notice if the chosen one is gone) and **system audio** (Windows loopback), mixed into one track.
- ✓ Webcam recorded as its own track for the PiP bubble; its start offset is measured from the first frames.
- ✓ 3-2-1 countdown, floating always-on-top control bar (excluded from the capture) with timer, pause/resume, stop and discard (with confirmation). `Ctrl+Shift+2` stops; if another app owns the shortcut the bar says so.
- ✓ **Native Windows capture** (`ssw-capture.exe`, Windows Graphics Capture + Media Foundation): screens and areas are recorded **without the Windows cursor**, encoded on the GPU, with paused time cut out. Chromium records the audio. Any failure falls back to Chromium capture automatically. *Windows-unverified.*
- ✓ Cursor position, clicks (clicks on the app's own windows and outside the recorded display/area are ignored), cursor shape (native capture) and **shortcut keystrokes** (combos with Ctrl/Alt/Win and special keys only; plain typing is never recorded; can be turned off on Home).
- ✓ Recordings are **streamed to disk** while recording (no size limit, flat memory) and are never discarded once capture has started: a crashed recorder, a failed conversion or a closed window leaves recoverable files, listed under *Unfinished recordings* (Recover / Retry / Show folder / Delete). Processing shows a percentage and can be finished later.
- ✓ One recording at a time (double clicks are ignored), single app instance, friendly errors with a link to Windows privacy settings.
- ✓ Microphone level meter on Home; if system audio cannot start, the recording continues without it and says so; if the native helper stops on its own (e.g. a monitor is unplugged) the recording stops, keeps everything and explains why. Native recordings are written as fragmented MP4, so even a helper crash leaves a playable file.
- *roadmap*: separate microphone/system-audio tracks, cropping areas inside the native helper (today the whole monitor is captured and cropped afterwards), camera preview on Home.

## Motion engine
- ✓ **Auto zoom** generated from click clusters (zoom in just before the click, hold, ease out), aimed at the click itself even when the cursor arrives just before it; regenerate keeps your edited zooms.
- ✓ Zoom camera **follows the cursor** with spring smoothing, clamped to the frame; or a **fixed point** picked on the preview.
- ✓ **Smooth cursor**: spring-smoothed path, adjustable smoothness and size (DPI-independent), real cursor shapes from native capture. Only offered when the Windows cursor is not already in the video.
- ✓ Click ripples (work with either cursor), hide cursor when idle.
- ✓ **Motion blur** on camera moves (zoom and pan), scaled by clip speed; static frames cost nothing extra.

## Editor
- ✓ **Undo / redo** for every edit (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`, toolbar buttons); drags and slider moves are one step each.
- ✓ **Cuts and speed**: trim handles, split at playhead (`S`), cut a clip or a Shift-dragged range (`Delete`), restore cuts, speed presets 0.25×–8× per clip or range. Preview playback skips cuts and plays each clip at its speed with pitch preserved; the transport shows output time.
- ✓ **Zoom segments**: add (`Z` / double-click), move, resize, delete; level, follow cursor or fixed point. Adding never deletes or shortens existing zooms.
- ✓ **Text annotations** on their own track (`T` / double-click): text (multi-line), caption pill or title style, size, position by dragging on the preview.
- ✓ **Keystroke overlay**: keycap pills for recorded shortcuts, top or bottom, adjustable size.
- ✓ Background (10 gradient presets, solid colour, custom image), padding, corner radius, shadow; aspect ratios Auto, 16:9, 9:16, 1:1, 4:3.
- ✓ Webcam bubble: show/hide, corner, size, circle or rounded.
- ✓ Audio volume (0–200%) and mute, applied to preview and export.
- ✓ Zoomable, scrollable timeline (`+`/`-`, `Ctrl`+wheel, Fit) that stays usable for long recordings; playhead follows playback.
- ✓ Shortcuts work regardless of which control was last used, and are paused behind the export dialog. Sharp preview on high-DPI screens; only redraws when something changed.
- ✓ Auto-save with a save indicator; save failures are shown with Retry; edits are flushed when closing the window or going back.
- ✓ **Save as default style**: background, layout, cursor, camera and effect settings become the starting look of every new recording (Reset restores the built-in look).
- ✓ Projects library on the home screen (open / delete / show in Explorer).

## Export
- ✓ MP4 (H.264 + AAC) at 720p / 1080p / 1440p / 4K, 30 or 60 fps, quality presets (Studio / Web / Small file); a warning when exporting above the recording's resolution.
- ✓ **GPU-accelerated** when available: frames are decoded in order with WebCodecs and encoded with WebCodecs or ffmpeg's NVENC / Quick Sync / AMF, falling back to x264 (or choose *Software*). Progress shows fps and ETA. *GPU paths Windows-unverified.*
- ✓ Exact frames (no duplicated or skipped frames) and correct, tagged colours. Very wide or tall areas are capped to encoder limits (the dialog shows the real size).
- ✓ Audio follows cuts and speed changes and stays in sync.
- ✓ GIF with bounded memory (palette passes), up to 1080p / 15 fps.
- ✓ Safe output: written to a temporary file and moved into place only when complete; cancel works in every phase and never destroys an existing file.
- ✓ **Copy** the exported file to the clipboard (paste into Explorer, Slack, Discord, …) and *Show in folder*.
- *roadmap*: share links (needs a hosting choice), export presets per destination.

## Packaging
- ✓ App icon in the window, exe, installer and shortcuts.
- ✓ Lean installer (English locale only, no source or dev files, only the Windows binaries).
- ✓ Signing-ready: signs automatically when a certificate (pfx, Windows store, or Azure Trusted Signing) is configured.
