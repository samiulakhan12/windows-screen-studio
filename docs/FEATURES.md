# Feature list

Legend: **✓** shipped · *roadmap* = planned. "Windows-unverified" marks behaviour that is implemented
and tested on Linux / with stand-ins, but has not yet been run on a real Windows PC.

## Recording
- ✓ Pick a full screen, an **area** (drag a rectangle on a transparent overlay; move/resize handles, size readout, Enter/Esc), or a single window. Source thumbnails refresh on demand.
- ✓ **Single-window recordings keep every cursor effect**: the native helper records just that window without the Windows cursor (`record --window`) and reports where the window is as it moves, resizes or is minimised; cursor samples and clicks are mapped into the window, so auto zoom, click ripples, follow-cursor zooms and the smooth cursor (with real cursor shapes) all work. A resized window is fitted into the original frame with the same rule everywhere. Clicks on another app's window covering the recorded one are ignored (and the cursor is hidden there); dragging the window keeps the cursor aligned; windows spanning monitors with different scaling are mapped correctly. Without native window capture the window is recorded by Chromium while the helper only watches its position (`watch-window`): auto zoom and ripples still work, with the Windows cursor in the video. *Windows-unverified.*
- ✓ Microphone (device picker, falls back to the default device with a notice if the chosen one is gone) and **system audio** (Windows loopback). The mixed track is kept, and each source is also saved as its own file (`mic.m4a`, `system.m4a`), lined up with the video by matching the sound itself. A source that fails to save never fails the recording, and survives crash recovery, *Finish later* and *Retry*. *System-audio stems Windows-unverified.*
- ✓ Webcam recorded as its own track for the PiP bubble; its start offset is measured from the first frames.
- ✓ 3-2-1 countdown, floating always-on-top control bar (excluded from the capture) with timer, pause/resume, stop and discard (with confirmation). A hotkey (default `Ctrl+Shift+2`) stops; if another app owns it the bar says so.
- ✓ Recording options on Home, saved in the app settings: 30 or 60 fps (the editing proxy keeps the rate); hide desktop icons while recording (Windows; restored on stop, cancel, crash, quit or next start; *Windows-unverified*); auto-pause when idle (3–60 s, "Paused (idle)" on the bar, resumes on the next input); custom hotkeys for stop / pause-resume / zoom here (default `Ctrl+Shift+2` / `Ctrl+Shift+F9` / `Ctrl+Shift+F10`, never a shortcut apps rely on such as Redo or a command palette), checked for conflicts and for combos another app owns.
- ✓ Live camera preview on Home (mirrored; released the moment recording starts).
- ✓ "Zoom here" marks and typing bursts for auto zoom (only *when* typing happened, never which keys; the "Record keyboard activity" toggle covers shortcuts and typing).
- ✓ **Native Windows capture** (`ssw-capture.exe`, Windows Graphics Capture + Media Foundation): screens and areas are recorded **without the Windows cursor**, encoded on the GPU, with paused time cut out. Chromium records the audio. Any failure falls back to Chromium capture automatically. *Windows-unverified.*
- ✓ Cursor position, clicks (clicks on the app's own windows and outside the recorded display/area are ignored), cursor shape (native capture) and **shortcut keystrokes** (combos with Ctrl/Alt/Win and special keys only; plain typing is never recorded; can be turned off on Home).
- ✓ Recordings are **streamed to disk** while recording (no size limit, flat memory) and are never discarded once capture has started: a crashed recorder, a failed conversion or a closed window leaves recoverable files, listed under *Unfinished recordings* (Recover / Retry / Show folder / Delete). Processing shows a percentage and can be finished later.
- ✓ One recording at a time (double clicks are ignored), single app instance, friendly errors with a link to Windows privacy settings.
- ✓ Microphone level meter on Home; if system audio cannot start, the recording continues without it and says so; if the native helper stops on its own (e.g. a monitor is unplugged) the recording stops, keeps everything and explains why. Native recordings are written as fragmented MP4, so even a helper crash leaves a playable file.
- *roadmap*: cropping areas inside the native helper (today the whole monitor is captured and cropped afterwards).

## Motion engine
- ✓ **Auto zoom** generated from click clusters (zoom in just before the click, hold, ease out), aimed at the click itself even when the cursor arrives just before it; regenerate keeps your edited zooms.
- ✓ Zoom camera **follows the cursor** with spring smoothing, clamped to the frame; or a **fixed point** picked on the preview.
- ✓ **Smooth cursor**: spring-smoothed path, adjustable smoothness and size (DPI-independent), real cursor shapes from native capture. Only offered when the Windows cursor is not already in the video.
- ✓ Click ripples (work with either cursor), hide cursor when idle.
- ✓ **Motion blur** on camera moves (zoom and pan), scaled by clip speed; static frames cost nothing extra.
- ✓ **Zoom easing** (smooth, snappy, bouncy, linear) and transition per zoom, or as the project's Zoom style (Apply to all).
- ✓ **Connected zooms** pan straight from one to the next without zooming out; *Pan to next zoom* joins them; linked zooms are drawn joined on the timeline.
- ✓ **Region zoom**: draw, move or resize a rectangle on the preview; the zoom frames exactly it.
- ✓ **Pull back**: levels 0.5–1× shrink the recording card (crisp corners and shadow) to show more background.
- ✓ **Auto zoom settings** (level, grouping, lead-in, hold, right clicks, typing, zoom-here marks) regenerate automatic zooms live.
- ✓ **Cursor styles**: Auto (recorded shapes), macOS-like, Windows-like, large white/black, or a custom PNG/JPG/WebP/SVG image; highlight halo; ripple / ring / pulse click effects in any colour; click sounds (preview and export); loop home for seamless GIFs; tilt and motion trail.

## Editor
- ✓ **Undo / redo** for every edit (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`, toolbar buttons); drags and slider moves are one step each.
- ✓ **Cuts and speed**: trim handles, split at playhead (`S`), cut a clip or a Shift-dragged range (`Delete`), restore cuts, speed presets 0.25×–8× per clip or range. Preview playback skips cuts and plays each clip at its speed with pitch preserved; the transport shows output time.
- ✓ **Zoom segments**: add (`Z` / double-click, at the default level), move, resize, delete; level (presets 0.75×–3×, keys `1`–`4` / `0`), follow cursor, fixed point or region. Adding never deletes or shortens existing zooms.
- ✓ **Text annotations** on their own track (`T` / double-click): text (multi-line), caption pill or title style, size, position by dragging on the preview.
- ✓ **Keystroke overlay**: keycap pills for recorded shortcuts, top or bottom, adjustable size.
- ✓ Background (10 gradient presets, solid colour, custom image), padding, corner radius, shadow; aspect ratios Auto, 16:9, 9:16, 1:1, 4:3.
- ✓ **Wallpapers and moving backgrounds**: 16 generated wallpapers (mesh gradients, waves, dunes, northern lights, blueprint, …; no image files), blur for wallpapers and custom images, and 6 **animated gradients** with adjustable speed.
- ✓ **Device frames**: browser window (address bar with your title), laptop, monitor and phone, light or dark, vector-drawn so they stay crisp; they shrink with the card when the camera pulls back.
- ✓ **Card looks**: border (solid or frosted *glass*), shadow styles soft / hard (offset, no blur) / glow (coloured), with a colour.
- ✓ **Watermark or logo**: an image (PNG, JPG, WebP, SVG) or text in a corner or the centre, with size, opacity and margin; unaffected by zoom. Changing the logo can be undone.
- ✓ **Style presets**: 8 built-in looks (Studio, Minimal, Midnight browser, Neon glow, Pop, Laptop showcase, Frosted glass, Flow) that set background, layout, frame, border, shadow, cursor look and zoom style in one undoable step; save your own looks by name, rename and delete them.
- ✓ **Shapes**: arrow, line, box, ellipse and highlighter, with colour, stroke width, fill and opacity. They are pinned to the content, so they follow zooms and pans. Add from the Shapes tab, the timeline or the command palette, drag and resize on the preview (arrow ends too), move and trim on their own timeline track.
- ✓ **Privacy blur and pixelate**: hide passwords, emails or faces. Fully applied for the whole range (no fade), under the cursor, following the content through zooms, and covering every motion-blur sub-frame.
- ✓ **Spotlight**: dim everything except an ellipse or box that follows the cursor or stays on a region, with darkness and soft edges.
- ✓ **Audio**: master volume and mute; separate microphone and system-sound volume and mute when the recording kept them apart; noise reduction (applied on export); *even out loudness* (about −16 LUFS); fade in / fade out; **background music** (MP3, M4A, AAC, WAV, OGG, Opus, FLAC) with volume, loop, fades and automatic lowering while the recording has sound (the same ducking in preview and export).
- ✓ **Command palette** (`Ctrl+K` or `Ctrl+Shift+P`): search every editor command (playback, editing, zooms, text, shapes, spotlight, toggles, inspector tabs, export, smart speed), each shown with its shortcut; recently used commands come first.
- ✓ **Custom shortcuts** (`Ctrl+/`): rebind any command, see and resolve conflicts, reset one or all; hints across the editor follow your keys.
- ✓ **Smart speed**: finds stretches where the picture does not change, nothing is heard *and* you did not move, click or type, then speeds them up (2×/4×/8×) or cuts them in one undoable step, showing how much time it saves.
- ✓ Webcam bubble: show/hide, corner, size, circle or rounded.
- ✓ Audio volume (0–200%) and mute, applied to preview and export.
- ✓ Zoomable, scrollable timeline (`+`/`-`, `Ctrl`+wheel, Fit) that stays usable for long recordings; playhead follows playback.
- ✓ Shortcuts work regardless of which control was last used, and are paused behind the export dialog. Sharp preview on high-DPI screens; only redraws when something changed.
- ✓ Auto-save with a save indicator; save failures are shown with Retry; edits are flushed when closing the window or going back.
- ✓ **Save as default style**: background, layout, frame, border, shadow, watermark, cursor, camera, effect settings and the zoom style become the starting look of every new recording (Reset restores the built-in look).
- ✓ Projects library on the home screen (open / delete / show in Explorer).

## Export
- ✓ MP4 (H.264 + AAC) at 720p / 1080p / 1440p / 4K, 30 or 60 fps, quality presets (Studio / Web / Small file); a warning when exporting above the recording's resolution.
- ✓ **GPU-accelerated** when available: frames are decoded in order with WebCodecs and encoded with WebCodecs or ffmpeg's NVENC / Quick Sync / AMF, falling back to x264 (or choose *Software*). Progress shows fps and ETA. *GPU paths Windows-unverified.*
- ✓ Exact frames (no duplicated or skipped frames) and correct, tagged colours. Very wide or tall areas are capped to encoder limits (the dialog shows the real size).
- ✓ Audio follows cuts and speed changes and stays in sync; separate sources, noise reduction, loudness, fades, music and click sounds are mixed in one ffmpeg pass (M4A includes all of it; GIF has no sound). Projects without the new audio settings export exactly as before.
- ✓ GIF with bounded memory (palette passes), up to 1080p / 15 fps.
- ✓ Safe output: written to a temporary file and moved into place only when complete; cancel works in every phase and never destroys an existing file.
- ✓ **Copy** the exported file to the clipboard (paste into Explorer, Slack, Discord, …) and *Show in folder*.
- ✓ **Destination presets** (YouTube 1080p/4K, X, LinkedIn, Instagram Reels, TikTok, YouTube Shorts, Square, Slack GIF, Email) that set format, size, frame rate, aspect (export only) and size limits; **batch export** of several presets into a folder; **target file size** (two-pass); **MP4 / MOV / WebM (VP9) / GIF / M4A**; **PNG thumbnail** of any frame.
- *roadmap*: share links (needs a hosting choice).

## Packaging
- ✓ App icon in the window, exe, installer and shortcuts.
- ✓ Lean installer (English locale only, no source or dev files, only the Windows binaries).
- ✓ Signing-ready: signs automatically when a certificate (pfx, Windows store, or Azure Trusted Signing) is configured.
