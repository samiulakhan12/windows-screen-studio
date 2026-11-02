# Plan: the next waves (agreed 31 October 2026)

The user asked for every feature suggested on 31 October, with **captions first** and **auto-blur of private
information last**. Each wave is designed first, built by builder sessions on their own branches, reviewed (every
finding checked twice), fixed, merged one branch at a time and released. Recording features belong to the other
account's area (`src/main/recording/*`, the recording bar, the recorder) and need their agreement first.

Order of releases: **0.7.1** (auto-update) → **0.8.0** (wave 8: captions that survive the OpenAI shutdown, publishing
pack, review mode, versions and filmstrip, sound finder, share, search) → **0.9.0** (wave 9, Captions Studio) → later
waves.

## Checkpoint (2 November 2026)

**Merged and pushed** on `ccr-b6df7cf7-yked87`, each reviewed through several lenses (every finding checked twice),
fixed, and verified with typecheck, the full unit suite, the build and the end-to-end files it touches:

- **0.7.1** auto-update.
- **NW-09** captions that survive OpenAI's `whisper-1` shutdown, and speaker labels.
- **E-02 Review mode**: review what Flown changed by itself.
- **NW-13 Publishing pack**: the text to post with a video, with a link check and a confirm before noted text leaves
  the app.
- **Wave 9, Captions Studio phase A**: the look gallery, 42 bundled fonts (9 Bangla families), motion, motion graphics
  made from captions, automation (Make my captions great, Tidy captions, bleeping, Auto style, AI marks), caption
  tracks and subtitle streams; Bangla bleeping redesigned to catch every form of a listed word.

**Known minor issues** (all low; none loses work):

- Review mode: a control focused while *Remove all* works can lose focus when the work ends in two cases; a Keep or
  Delete on a row a waiting undo brings back is dropped; *Keep all* pressed while *Remove all* works is refused
  instead of waiting.
- Publishing pack: some file names get a needless note; *Use for exports* can list the same link twice; a Chinese or
  Japanese text cut to fit can lose a little more than needed or get a note with no link; the highlight on a
  look-alike host stops at its non-ASCII letters.
- Captions Studio: Stickers at a very large size with very fast speech can reach past the frame edge, and a wide
  dragged Stickers block is pinned to the left; the palette's *Fix captions* and *Translate* commands point to
  Clean up and Languages until phase B.
- Bangla bleeping: Bangla written in Latin letters is not bleeped; the bustard bird's name, everyday words joined by
  an en or em dash, the locative of "boy" (spelled like a form of a listed word) and the literal "piglets" and
  "puppies" can be bleeped.

**Built, review part-way** (each resumes its review run; worktrees are clean):

| Feature | Branch | Worktree | Review run |
| --- | --- | --- | --- |
| F-18 Search | `rev/search` | `/home/user/wt-search` | `wf_c4ad3490-0d9` |
| F-17 Sound finder (needs `npm ci` in the main checkout after merging) | `rev/sound-finder` | `/home/user/wt-snd` | `wf_0844d540-15d` |
| F-22 Share | `rev/share` | `/home/user/wt-share` | `wf_4eff5e90-bd4` |
| E-12/E-07/E-09 Versions and filmstrip | `rev/versions` | `/home/user/wt-ver` | `wf_918b72cf-295` |

**Then**: Captions Studio phase B, waves 10–12 below, and auto-blur of private information last.

**Open items**: #61, an intermittent 20 ms microphone stem offset (Chromium capture); `tests/aiProviders.test.ts` and
one offline-captions e2e step read leftover `ssw-transcribe-*` folders in the shared temp folder (run unit tests
with a private `TMPDIR` until it is isolated).

## Wave 9 · Captions Studio (first)

Captions today: styles *clean, bold, boxed, karaoke, minimal*, a position, brand fonts, word timings (on this PC or
from a provider), speaker names (NW-09). Wave 9 turns them into a modern caption and motion-graphics system.
Design: `docs/design/captions-studio.md`.

**A. Look**
1. **Style gallery**: about 24 modern presets with animated thumbnails (for example big bold pop with the spoken word
   coloured, karaoke fill, highlight box, neon glow, glass pill, stacked words, typewriter, outline, handwritten,
   news, minimal subtitle); save your own; the brand kit's caption style.
2. **Font system**: a curated set of free (SIL Open Font License) display and text fonts made for captions, with
   weights; fonts for Bangla, Arabic, Hebrew, Devanagari, Thai and CJK so no script shows empty boxes; per-word font
   for emphasis; brand fonts as today.
3. **Colour system**: themes (text, spoken word, emphasis, outline, shadow, box), gradients and glow, brand colours,
   and a contrast check against the video behind the caption.
4. **Layout**: words per line, lines, one word at a time, line breaks at natural phrases, position presets and
   dragging, keeping clear of the camera bubble and the face, and the TikTok / Reels / Shorts safe zones.

**B. Motion**
5. **Word animations** driven by the exact word times: pop, bounce, slide, fade, typewriter, karaoke fill,
   highlight sweep, blur-in, shake; entry and exit per caption; one strength and speed control. Preview and export
   draw the same frames.
6. **Emphasis motion**: emphasised words bigger, in the emphasis colour, with their own animation.

**C. Motion graphics made from the captions** (automatic, every one an editable timeline item)
7. **Keyword pop-ups**: big animated word cards on key moments.
8. **Emoji**: a fitting emoji next to a word (an offline word list; an AI provider when one is set up).
9. **Numbers and stats**: "grew 300 %" becomes an animated counter.
10. **Lists**: "three steps: …" becomes animated bullet cards.
11. **Lower thirds, title and quote cards** from speaker names, chapters and quotes.
12. **Sound on pops** (optional, with the wave 10 sound library).

**D. Automation**
13. **Auto emphasis** (X-02): picks the important words, offline, or with the AI provider.
14. **Auto style**: chooses a style for the frame and the platform (tall video: bold pop; wide: clean subtitle).
15. **Make my captions great**: one click (and a Polish step) for style, emphasis, emoji and motion graphics, every
    change listed in Review mode with Keep / Remove.
16. **Clean-up**: capital letters, punctuation, numbers as digits, a word list for product names, optional
    bleeping of swear words.
17. **Translated captions and several subtitle tracks** (F-16, LT-10): offline translation, one transcript per
    language, switchable tracks in the export, fonts chosen per script.

## Wave 10 · Editing polish
- **Smooth cuts** (rest of NW-06): a soft cross-fade at cuts, per-cut styles, *Smooth all cuts*.
- **Magnifier zoom** (LT-12): a round loupe over a small detail.
- **Animated callouts and a chapter progress bar** (LT-11): enter and exit animations for text, shapes and titles,
  step badges, speech bubbles.
- **Colour correction and looks** (LT-16): brightness, contrast, saturation, temperature and LUTs, for camera and
  screen separately.
- **Music and sound-effects library** (LT-13): free (CC0) music beds and whoosh / pop sounds.

## Wave 11 · Smart tools
- **Step-by-step guide** (LT-03) and **click-through demo** (LT-07): a written guide (Markdown, HTML, PDF) and an
  offline HTML demo from the clicks.
- **Chapters without AI** (F-10): from app switches, scene changes and pauses.
- **Short clips** (LT-02): the best 15–90 s moments, or a 60-second version, each a copy of the project.
- **AI on this PC** (F-04): titles, summaries and the copy pack with a small local model, no key.
- **Any AI service and the cost up front** (NW-14).

## Wave 12 · Output and the app
- **Pro export formats** (LT-22): HEVC, AV1, ProRes, transparent video, 4:5, 24/25/120 fps, sound stems,
  FCPXML / EDL for Premiere and DaVinci Resolve.
- **Flown in Bangla and other languages** (X-05).

## Recording extras (only with the other account's agreement)
Screenshot mode (LT-06), drawing on screen while recording (LT-19), recording one app's sound (LT-18), checks before
and during recording (NW-11).

## Last · Auto-blur private information (F-07, LT-05)
Finds passwords, emails, API keys, phone and card numbers on screen and suggests blur boxes to review.
