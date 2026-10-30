# Release notes

## Next release

- **Publish: the text to post with your video** (NW-13): *Publish* in the title bar writes a YouTube
  description (with the chapter times of the edited video and tags), a LinkedIn post, an X post, a
  help-centre article, release notes, a title and a summary from the captions, with your OpenAI,
  Gemini or Claude key. Pick a tone and a length, edit any of it, copy it in one click, or regenerate
  one item. *Use for exports* saves the YouTube description as the export's description file. Every
  AI text tool is now in the command palette (Ctrl+K).

## 0.7.1

- **Flown updates itself**: it looks for a new version a few times a day, downloads it in the
  background and installs it when you close Flown. *Restart now* installs it at once (it waits while
  you record, export or make captions). Settings › About shows what is new, *Check for updates* and
  the switch *Update Flown automatically*. Updates come from Flown's page on GitHub. Install this
  version by hand once; every later version arrives by itself.
- **Suggested AI models stay current**: the models Flown suggests for each AI provider are refreshed
  with the update check, and Settings › AI tells you when a provider uses a model that is being
  retired (OpenAI retires `whisper-1` on 26 February 2027). Models you chose are never changed.

## 0.7.0

- **Import a video** (NW-07): bring in a video recorded with another app (OBS, Xbox Game Bar,
  Teams, a phone) as a new project: *Import video* on Home, or drop the file on *Recent
  recordings*. MP4, MOV, MKV and WebM work, including phone videos that are rotated, HDR or have a
  variable frame rate. Flown checks the file first and says plainly when it cannot be edited
  (sound only, copy-protected, too long, an unreadable format), then makes its own editing copy
  with progress and Cancel; your file is not changed. Backgrounds, the brand kit, captions,
  silence removal, cuts, text, images, title cards, manual zooms and export all work; auto zoom,
  cursor effects, click sounds and the shortcut overlay need what Flown records, so they are off
  and the editor says why. Existing projects open exactly as before.
- **Hands-off exports and app health** (F-12, X-03, F-26, F-11): long exports show their progress on
  the taskbar button and can be paused from the export dialog or the taskbar thumbnail; the PC stays
  awake while they run (a locked screen keeps exporting), and sleep pauses them until the PC wakes.
  When Flown is in the background, "Export finished" offers Open and Show in folder. *Also save*
  writes captions (SRT, VTT), a chapter list, the thumbnail and a description next to the video,
  and *One file per chapter* exports "01 Intro.mp4", "02 Billing.mp4", …. Settings gains
  **Storage** (disk use per recording, clean-up rules you review, Recycle Bin only) and
  **Diagnostics** (a report you see before copying it; keys and your own folders are left out).
  Existing projects and settings open unchanged.
- **Clean voice** (F-08): one switch in the Audio panel removes fan hum, keyboard and mouse clicks
  and room noise from your microphone, on this PC. Choose Light, Normal or Strong; the cleaned voice
  is made once (with progress and Cancel) and the preview plays it, with *Hear the original* to
  compare. The export uses the same cleaned voice. Projects with the switch off are unchanged.
- **Edit by text** (NW-04): the new *Transcript* tab shows what you said, word by word. Select
  words and press `Delete` to cut them from the video; they stay struck through, and *Restore*
  brings them back. Click a word to go there; the word being said is underlined while the video
  plays. Every edit is one undo step, and the timeline, preview, captions and export follow;
  subtitle files leave out exactly the words shown struck through. No transcript yet? *Make
  captions* starts the Captions tab's *Generate captions*.
- **Remove fillers and retakes** (NW-01): *Find fillers and retakes* lists "um", "uh", "you know",
  repeated words and sentences you said again (keeping the last take). Choose *Keep* or *Remove*
  for each, or *Remove all*. Nothing is cut until you choose, and cuts end in the pauses so words
  are not clipped. Found on your PC, with no AI call.
- **Smooth cuts** (NW-06): the sound now fades out and back in over 10 ms at every cut, so cuts
  no longer click. **Existing projects with cuts sound slightly different at their next export**
  (only right at the cuts).
- **Vertical video that follows the action** (NW-05): pick **Make a vertical version** from the new
  copy button right of the recording's name (or `Ctrl+K`), and a 9:16 copy opens with your camera
  in a band on top and the screen below it, cropped in and gliding calmly to where you point, click
  and type instead of the whole desktop shrunk into a strip. The view is planned on your PC from
  the recording's cursor data: it holds still most of the time, starts moving as the cursor does,
  arrives before the click, and never pans across a cut. Zooms still work inside it, gentler and
  limited so the picture stays sharp. Style › *Vertical framing* sets *How close*, *Movement*
  (Calm, Balanced, Lively), the camera (band on top, at the bottom, or the bubble) and *Keep text
  clear of app buttons*, which places captions, key presses, the logo and lower-third titles where
  TikTok, Reels and Shorts leave the video free. Steer it with *Hold the view here* (`R`), by
  dragging the paused picture, or by ignoring a stray click. *Make a square version* does the same
  in 1:1, and *Follow the action* also works in a project you already set to 9:16, 1:1 or 4:3.
  The TikTok, Reels, Shorts and Square presets export it exactly as previewed; a 16:9 export of the
  same project shows the whole screen as before. Recordings without cursor data keep one view,
  which you can place.
- **Safe-zone preview**: in a tall video, *Safe zones* under the preview (or `G`) shades where
  TikTok, Reels and Shorts put their buttons and captions (all three, or one app). It is shown in
  the editor only and never exported. The zones are approximate, and the apps move them from time
  to time.
- **Duplicate** (X-04): the same copy button makes a copy you can edit separately. The copy is a new
  project in the library, made from the editor's latest state, and opens with *Open original*; the
  original folder is never written. The recording's video and sound are hard-linked where that is
  safe, so a copy is instant and takes almost no extra space; under OneDrive, or on a drive that
  cannot link, they are copied, with progress, Cancel and a free-space check. Existing projects,
  including 9:16 and 1:1 ones, open, preview and export exactly as before until following is
  turned on.

### Known issues

- In four multi-step cases a word deleted in the *Transcript* tab shows again in the captions file
  that *Also save* writes (SRT, VTT), although the video stays cut: its caption trimmed and then
  moved on the caption track; trimmed, grown back over the word and the project reopened; or
  merged with a caption whose words were retyped. Planned for 0.7.1.
- *Make captions* in the *Transcript* tab after every caption was deleted leaves the keyboard focus
  on the page when only an AI key (or no provider) is set; press `Tab` to reach the form.

## 0.6.0 and earlier

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
