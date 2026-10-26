# Automatic camera director (NW-08): final design

Status: contracts committed on `feat/director-contracts` (types, sanitisers, shared mapping, the
data rules for hand edits, and stubbed modules with frozen signatures). The bodies are built by
the three workstreams at the end of this document.

One click builds the camera track of a recording that has a webcam:

- the **full camera** (camera only, or a large camera) for an **intro** and an **outro**, while the
  person talks before the demo starts and after it ends;
- the **bubble** during the demo, in a corner kept clear of the cursor and the action, measured
  where the compositor draws them (zooms move the content), moving only when it has to;
- the camera **hidden** in long silences of the demo;
- the **face centred**: one static webcam framing (zoom, cropX, cropY) from the person masks of the
  bundled person segmentation on sampled camera frames. No new model, no AI provider.

Everything it writes is project data (layout segments marked `auto`, the webcam framing and
`Project.director`), so the preview and the export draw it through the same `drawFrame`, and one
`store.update` makes it one undo step.

---

## 1. Decisions

Two designs were compared: A (algorithm first) and B (user first).

**Base: design A.** Its planner is the stronger one: decisions in output seconds, a measured speech
signal with keyboard noise removed, careful intro and outro rules that do not cut a sentence, a
shortest-path corner search with a minimum stay (optimal and testable rather than greedy), an
explicit `cutOut` mark that makes "remove the director's changes" an exact inverse, saved options,
and framing provenance that needs no change to any framing control.

**Grafted from B:**

| From B | Why |
|---|---|
| The plan is shown **before** it is applied (a strip the width of the video, a list of changes with reasons, "+2 new · 1 removed · 3 unchanged", "Up to date"), computed live while the Camera tab is open. | The smart speed pattern (find, look, apply) that the brief points to, while still one click. It also replaces A's separate "the video changed since" warning: a stale plan simply shows a diff. |
| Apply **recomputes the plan inside `store.update`** from the latest project. | Face measuring takes 1-3 s; an edit made meanwhile is never overwritten. |
| **Ids are kept** for segments that did not change. | Selection survives a re-run, and "Direct again" on an unchanged project is a true no-op (no undo step). |
| `removeLayout` **gives a cut-out back** to the camera position it came from even when it covered the whole position. | Deleting the director's outro inside a recorded position must not leave a hole. Implemented with A's explicit `cutOut` mark instead of B's implicit invariant. |
| A lower **zoom cap (1.3)** when the result shows the camera large. | A 1280x720 webcam upscaled to a full 1080p frame softens quickly. |
| One **"Intro and outro" chip row** (Camera only / Large camera / Off). | Simpler than A's two toggles plus a layout chip. |
| **Hide thresholds 5 / 10 / 20 s / Never, default 10.** | Conservative default; A's 8 s hides too eagerly in a demo with pauses for thought. |
| Status line naming the **sound source**, and the transcript as an optional speech source. | Honest about mixed-track speech. |

**Conflicts resolved:**

| Topic | A | B | Decision |
|---|---|---|---|
| Options storage | `Project.director`, every option change re-directs (one undo step each) | session-only `lastChoice` | Saved in `Project.director`, written **only when applying**. Options are a draft in the section until then; the live plan shows their effect. No undo step per option click. |
| Framing ownership | `director.framed` provenance | `WebcamSettings.autoFrame` flag cleared by every framing control | A: provenance. No framing control changes; a hand edit simply makes the values differ. |
| Recorded camera positions | always kept; `corners: 'keep'` default when they exist | toggle `keepMoves` (off deletes them) | A: always kept, never deleted. One toggle, "Move the bubble away from the cursor" (`corners`), defaulting to off (`keep`) when the user already placed the camera. B's `keepMoves: false` is cut (destructive). |
| Cut-out marking | explicit `cutOut` | implicit (auto + corner + not default) | Explicit `cutOut` (a large camera in free time also carries a corner, which would break B's invariant). |
| Corner search | Viterbi with minimum stay, dilated costs, busy cap | greedy with thresholds | A. It is about 150 lines, deterministic, and unit-testable; B's greedy brakes can still flap. |
| Attention sources | cursor, clicks, typing, annotations, shapes, spotlights, captions, watermark | cursor, clicks, typing | Cursor, clicks, typing, watermark. Overlays and captions are **later**. |
| Speech + transcript | levels intersected with words, always | transcript preferred | Levels first. The transcript gates the **mixed** track only (where PC sound pollutes it); the microphone stem is trusted as is (a hand-edited transcript could only remove real speech). Transcript alone when levels are missing. |
| Face samples | 16 | 6-12 | One per 6 s of camera shown, 6-16; a framing needs max(4, 40%) faces. |
| Head width | median row width | median of mid-band rows | 80th percentile of the head rows (a median reads a round head too narrow), shoulders found against the widest row so far. |
| Moving person | zoom at most 1.25 | zoom 1 | A: at most 1.25 (still centred, gently). |
| Palette command | opens the tab and directs | opens the tab and directs | Same: opens the Camera tab and applies at once with the saved (or default) options. |
| Shared mapping | `toOutput` in zoom.ts | `viewPoint` in zoom.ts | `toOutput(rect, cam)` in a new `src/shared/engine/outputPoint.ts` (keeps zoom.ts free for NW-03, in progress at the same time). |

**Cut to "later"** (section 9): overlay and caption costs, the "your camera move sits where the
cursor works" note, ghost blocks on the camera track, per-layout or moving face framing,
picture-change attention, AI labelling, export-aspect plans, directing new recordings
automatically, remembering deleted automatic changes.

---

## 2. User experience

### Placement

- A new first section, **"Auto director"**, in the Camera tab, only for recordings with a camera
  (as the Layout section is). `data-testid="director"`.
- Command palette: **"Direct the camera automatically"** (Camera category, no default shortcut).
  It opens the Camera tab and directs at once with the saved options (defaults for a project
  never directed), then shows the notice.

### The section

1. Lead text: "One click builds your camera track: the full camera while you talk before and
   after the demo, the bubble kept clear of your cursor, hidden in long silences, and your face
   centred. Changes you made yourself are kept."
2. Sound status (`data-testid="director-source"`, `data-source`):
   - mic: "Listening to your microphone."
   - mix: "Listening to the recording's sound (no separate microphone): sounds from your PC count as talking."
   - mix refined: "Listening to the recording's sound, checked against your captions."
   - transcript: "Using your captions' word timings."
   - measuring: "Listening for speech…" (spinner).
3. **Plan strip** (`data-testid="director-strip"`): the output timeline coloured by state: camera
   only or large (violet), bubble in another corner (teal, with the corner glyph of
   LayoutTrack), hidden (grey hatching), the user's own segments (white outline, tooltip "Yours,
   kept"). Clicking a block seeks there.
4. **List of changes** (`data-testid="director-part"`, `data-kind`, `data-corner`), one row each,
   glyph, label, output times and the reason in muted text; clicking selects the segment and
   shows it (showLayout):
   - "Intro · Camera only · 0:00–0:06 · you talk before the demo"
   - "Bubble bottom left · 0:16–0:23 · your cursor works in the bottom right"
   - "Camera hidden · 0:23–0:33 · silent for 12 s"
   - "Outro · Camera only · 0:33–0:48 · you talk after the demo"
   - "Face centred · measured when you direct" (after applying: "Face centred · 1.25×")
5. **Summary** (`data-testid="director-summary"`, `data-state` = `measuring | ready | applying |
   up-to-date`): "4 changes · camera on screen 58% of the video"; second line when relevant
   "Keeps 1 layout change and 2 camera positions of yours"; on a re-run "+2 new · 1 removed · 3
   unchanged". With no change left it shows only when Direct again would remove the director's
   earlier segments ("0 changes · …", "+0 new · 5 removed · 0 unchanged").
6. **Options** (a draft until applied; saved in the project when applied):
   - Chips "Intro and outro": Camera only | Large camera | Off (`data-testid="director-intro"`).
   - Chips "Hide the camera when silent for": 5 s | 10 s | 20 s | Never (`director-hide`).
   - Toggle "Move the bubble away from the cursor" (`director-corners`). When camera positions
     exist it starts off, with the hint "You placed the camera yourself (while recording or with
     Move camera here): those positions are kept either way."
   - Toggle "Centre my face" (`director-face`). When the framing is the user's it starts off,
     with the hint "You framed the camera yourself; turn this on to let the director frame it."
7. Primary button (`director-apply`, sparkle icon): **"Direct camera"**; **"Direct again"** once the
   project has the director's changes; disabled **"Up to date"** when the plan equals the track,
   there is no framing to do and the options shown are the saved ones (for a project never
   directed, the options it resolves to). No framing is left to do when the camera shows the
   director's framing, or when the last Apply measured one within 0.05 zoom and 0.01 crop of the
   camera's (and so left it as it was). Ghost button **"Remove automatic changes"**
   (`director-remove`), shown when the director's changes are in the project.
8. Hint under the buttons: "Changing a block made by the director makes it yours: Direct again
   keeps it. Direct again brings back automatic changes you deleted; turn off what made them above."

### Applying

- The button shows a spinner: "Listening for speech…" (if still measuring), then "Finding your
  face… 7/12".
- One `store.update` writes layouts, framing and options: one Ctrl+Z.
- Notice: "Camera directed: intro, 1 bubble move, 2 hidden, outro; face centred (1.25×)" plus
  the undo hint (undoHint(keymap)). "Nothing to change" when the update is a no-op. With no part
  and no framing: "Camera directed: earlier automatic changes removed" when the director's
  segments went, else "Camera directed: options saved" (only the options were written).
- The section then reads "Up to date", the Framing pad shows the new box.

### States and copy (`data-testid="director-note"`, `data-note`)

| Note | Copy |
|---|---|
| camera-hidden | "The camera is hidden: show it to direct it." (button disabled; the palette says "Show the camera first") |
| no-sound | "No sound was recorded, so there is no intro, outro or hiding: the director keeps the bubble clear of your cursor and centres your face." Shown only once the measurement finished and found no sound and no captions: not while measuring (the status line speaks), not when it failed (the callout below). |
| (sound failed) | callout "The sound could not be measured: the plan uses the mouse and keyboard only." with **Try again**; when the captions gave the speech: "The sound could not be measured: the plan uses your captions' word timings." |
| no-speech | "No talking was heard, so the camera stays on throughout and there is no intro or outro." |
| mixed-sound | (the status line above) |
| transcript | (the status line above) |
| no-input | "This recording has no mouse or keyboard data: the director hides the camera in silences and frames your face, but cannot keep the bubble clear of the cursor." |
| no-demo | "Nothing happens on screen that the director can see (no clicks, typing or zooms), so it cannot tell the intro from the demo." |
| kept-positions | "Your camera positions are kept." |
| all-yours | "Your own camera changes cover the whole video: nothing left to direct." |
| options-off | No part because the options turn everything off (intro and outro Off, hide Never, the bubble not moved): "The intro and outro, hiding and bubble moves are all off, so the director adds nothing to the camera track." |
| nothing | No part and no earlier automatic change to remove (the diff shows a removal instead), the options allowing some: "Nothing to change: no talking before or after the demo, no long silences, and the cursor never came near the camera." Not shown while the sound is measured or when it could not be. |

Framing outcome (`data-testid="director-framing"`, `data-status`), the outcome of the last Apply,
shown while the project still has the options that Apply saved (an undo hides it, a redo brings it
back); "framed" only while the camera shows that framing:

| Status | Copy |
|---|---|
| framed | "Face centred (1.25×)." / not steady: "You move around a lot, so the camera is centred on you with little zoom." |
| not-found | "No one was found in the camera picture, so the framing was left as it was." |
| unavailable | callout `director-framing-unavailable`: "Face framing is unavailable: {reason}. The rest of the camera track was directed." |
| skipped, user's framing | "Your framing is kept (turn on Centre my face to let the director frame you)." |

### Timeline

- Director segments: `.layout-seg.auto`, `data-auto="true"`; dashed border and a dimmer fill
  like `.zoom-seg.auto` (editor.css); label suffix " · auto" when wider than 110 px; title suffix
  " · automatic: change it to keep it when you direct again".
- Cut-outs show the position's corner glyph as layoutInStay changes already do.
- Dragging, trimming, retyping or moving the corner of one removes the mark at once (byHand).
- Layout section hint for an auto target: "Made by the auto director. Changing it makes it yours;
  Direct again keeps it."
- Position section "Default" reset goes through `updateLayout` (so it claims the segment).

---

## 3. Data model and migration (committed)

`src/shared/types.ts`:

```ts
interface LayoutSegment {
  ...
  /** Made by the camera director; "Direct again" replaces only these; any edit by hand clears it. */
  auto?: boolean
  /** Only with auto + corner, layout not 'default': cut out of a camera position in that corner. */
  cutOut?: boolean
}
type DirectorHideAfter = 0 | 5 | 10 | 20
interface DirectorSettings {
  intro: 'camera-only' | 'camera-large' | 'off'
  corners: 'auto' | 'keep'
  hideAfter: DirectorHideAfter
  frameFace: boolean
  /** The framing the director last applied: the framing is the director's while the webcam still shows it. */
  framed?: { zoom: number; cropX: number; cropY: number }
}
interface Project { ...; director?: DirectorSettings }
```

Sanitising (committed, real code):

- `readLayouts` (webcamData.ts) keeps `auto` only when `=== true`, and `cutOut` only when `=== true`
  with `auto`, a valid corner and a layout other than 'default'. The overlap trimming spreads
  the object, so the marks survive it; `clampTimed` (clips.ts) spreads too.
- `migrateProject` takes `director` out of `...rest` and adds it back only through
  `readDirectorSettings` (directorData.ts): invalid fields get defaults, a `hideAfter` the
  director does not offer becomes 10, `framed` is kept only with finite values, clamped (zoom
  1..3, crops 0..1). A non-object is dropped.
- No schema bump and no migration: old projects have no marks, so everything in them is the
  user's, which is right. An older build reading a newer file drops the marks (readLayouts rebuilds
  segments) and `director` (it passes through `...rest` there unchecked, harmlessly); directed
  segments then simply count as manual.
- Style defaults and presets never carry layouts, framing or `director`.

Ownership rules (committed, real code):

- `byHand(s)` (layouts.ts) strips `auto` and `cutOut`. Applied by `updateLayout` (Camera panel
  pickers), `dragLayout` (the dragged segment only; stay pieces dragged along keep their marks),
  `setLayoutAt` and `setCornerAt` when they change a segment in place.
- `layoutInStay` needs no change: the new change is built without marks and the pieces of the
  stay keep theirs. So a change added inside the director's bubble corner is the user's and
  survives "Direct again", while the corner pieces around it are re-planned.
- `removeLayout`: a cut-out with no stay pieces around it (it covered the position whole) becomes
  the corner-only position again (same id, no marks). With pieces, `stayAround` joins them as before.
- `directorData.ts`: `framingUntouched`, `framingIsDirectors` (within 1e-4 of `framed`),
  `directorMayFrame`, `hasCameraPositions` (manual corner-only segments), `hasDirectorChanges`,
  `directorSettingsOf` (saved options; for a never-directed project the defaults with
  `corners: 'keep'` when camera positions exist; `frameFace` offered only while the director may
  frame).

Defaults: intro 'camera-only', corners 'auto' ('keep' with camera positions), hideAfter 10,
frameFace true.

Undo and saving: Direct, Direct again and Remove are each one `store.update` without a merge key
(editStore.ts: one undo step); an unchanged result returns the same project object, so no step
is pushed. Autosave persists like any edit.

---

## 4. Algorithm

Facts it relies on (checked in the code): layout segments are in source time, one at a time;
outside them the layout is 'default' with the bubble at `webcam.corner`. A segment ramps in over
min(0.4 s, its length, half its length when it ramps both ways) after its start, unless it
starts at the first kept frame; it ramps back to default over its last 0.4 s unless the next one
touches it (within 1e-3) or it ends at the last kept frame; touching segments change straight
from one to the next. A hidden camera fades where the camera is on the other side, so a corner
change across a hidden part costs nothing visually. 'camera-only' and 'screen-only' ignore a
segment's corner when drawing. The bubble is `webcamRect(W, H, {corner, size})`: side
size·min(W, H), margin 4%. The compositor maps source points with
`toOutput(sceneContentRect(...), cameraAt(zooms, t, cursor.valid ? focusPath : null, zoomStyleOf(project)))`.

### Step 0. Preconditions

`hasWebcam && webcam.show` (layoutsApply). Without a camera the section is not shown; with the
camera hidden the plan is empty with the note `camera-hidden`.

### Step 1. Inputs

project, CursorTrack, cursorPath (`new SmoothedTrack(samples, duration, cursor.smoothing)`),
focusPath (`focusPathFor(samples, duration)`), speech (`DirectorSpeech | null`), settings
(`directorSettingsOf` plus the section's draft), newId.

### Step 2. Time base

T = outputDuration(clips). Grid G = 0.1 s, points o_j = (j + 0.5)·G, source t_j =
outputToSource(clips, o_j).time. **Every length below is in output seconds**; source times
appear only when segments are written (step 12).

### Step 3. Base and classes

base = withoutDirected(project.layouts): every earlier director result removed, everything the
user placed restored.

- **Positions (pins)**: corner-only base segments (layout 'default' with a corner). Their corner is
  fixed; the director may cut its own parts out of them.
- **Locked**: every other base segment. Never written over.

Both mapped to output with rangesToOutput.

### Step 4. Speech S (workstream B produces it; output ranges here)

- Source (speechLevelSource): the mic stem when the recording kept one, else the mixed track when
  it has sound. Requested by name, so a muted microphone still counts.
- speechFromLevels: detectActivity (ACTIVITY unchanged: threshold = clamp(10th-percentile floor
  + 12 dB, −50, −32) dBFS, hold 0.5 s, minimum 0.12 s); drop a range at least 80% inside recorded
  input padded (typing bursts ±0.3 s, clicks ±0.15 s, keys ±0.15 s): keyboard and mouse noise;
  join ranges closer than 1.0 s (sentence pauses); drop ranges shorter than 0.6 s.
- refineSpeech: with the **mixed** track and a transcript, keep only sound within 0.5 s of a word
  (words joined across 0.3 s), `refined`. With the **mic** stem, levels as they are. Without
  levels, the transcript's words joined across 1.0 s (`source: 'transcript'`). Neither: null.
- In the planner: S = rangesToOutput(speech.ranges, clips). Null speech: note `no-sound`. Under
  2.0 s of speech in all: note `no-speech`, treated as null. Notes `mixed-sound` (mix, not
  refined) and `transcript` (refined, or transcript source).
- With S null: no intro, no outro, no hiding.

### Step 5. Demo span

Events, source times mapped with sourceToOutput (events in cuts dropped):

- clicks of any button inside the frame (0..1), keys and "zoom here" marks: instants;
- typing bursts [t, end];
- every zoom (manual or auto): [start, end − zoomTransition(z, style)];
- cursor sweeps: a move (consecutive samples each more than 0.004 from the one before; a rest of
  up to 0.25 s does not end it) whose path covers at least 0.35 (normalised, positions clamped
  to 0..1) within some 2.0 s of it; span from the sample before its first moving sample to its
  last moving sample.

Cursor-track events count only when `cursor.valid` (else note `no-input`; zooms still count).
demo.start = earliest event start, demo.end = latest event end. No events: no intro or outro,
note `no-demo`.

### Step 6. Intro (settings.intro ≠ 'off', S and a demo)

- e = demo.start − 1.0 (the full camera has changed back to the bubble before the first action,
  whichever way the 0.4 s change runs).
- Still talking (S meets [e − 0.5, e]): introEnd = the latest midpoint of a speech gap of at least
  0.25 s lying in [demo.start − 3.0, e]; none: introEnd = e.
- Otherwise: introEnd = min(e, end of the last S range starting before e, + 0.5).
- Valid when introEnd ≥ 3.0, the first speech onset ≤ min(4.0, introEnd − 1.0), and speech covers
  at least 40% of [0, introEnd].
- Intro = [0, introEnd] minus locked; keep only the piece starting at 0, if at least 3.0 s. It
  starts at the first kept frame, so the video opens on the full camera with no animation.

### Step 7. Outro (symmetric)

- b = demo.end + 1.5 (the result of the last click shows first).
- Still talking (S meets [b, b + 0.5]): outroStart = the earliest midpoint of a speech gap of at
  least 0.25 s in [b, demo.end + 4.0], else b.
- Otherwise: outroStart = max(b, n − 0.3), n = the next speech onset at or after b; no onset: no outro.
- Valid when T − outroStart ≥ 3.0 and speech covers at least 40% of [outroStart, T].
- Outro = [outroStart, T] minus locked; keep only the piece ending at T, if at least 3.0 s. It
  ends at the last kept frame, so the video ends on the full camera.
- The demo between them is at least 4.0 s (MIN_DEMO): if outroStart − introEnd < 4.0 drop the
  outro; an intro alone needs T − introEnd ≥ 4.0, an outro alone outroStart ≥ 4.0.

### Step 8. Hidden parts (settings.hideAfter ∈ {0, 5, 10, 20}, default 10; 0 = never)

- within = [introEnd or 0, outroStart or T] minus locked.
- For each gap [a, b] of S over [0, T] with b − a ≥ hideAfter:
  - h0 = introEnd if there is an intro and a ≤ introEnd (straight from the full camera to no
    camera); 0 if a = 0 and there is no intro; else a + 1.0 (the fade ends 1.4 s after the last word);
  - h1 = outroStart if there is an outro and b ≥ outroStart; T if b = T and there is no outro;
    else b − 0.8 (the bubble is back at least 0.4 s before the next word).
- H = [h0, h1] ∩ within; keep pieces of at least 5.0 s.

### Step 9. Short bubble stretches (anti-flicker)

V = within \ H is bubble time. A V piece shorter than 4.0 s:

- next to a hidden part, with under 1.5 s of speech: joins the hidden part;
- next to a hidden part, with 1.5 s of speech or more: grows to 4.0 s, taking time from the
  neighbouring hidden parts; a neighbour that would drop below 5.0 s is removed (shown) instead;
- next to the intro or outro: joins it;
- otherwise (between the user's segments) it stays.

Result: changes the director adds are at least 3.0 s of output apart (at least 2.2 s after the
snap to a position's edge in step 12).

### Step 10. Corners (bubble time; skipped when corners = 'keep', without cursor data, or without samples)

Free stretches = V minus positions (positions keep their corner). Each stretch has an entry: a
position or a cornered locked segment touching its start makes the camera visible there
(`enterVisible`, entry = its corner); otherwise the bubble appears (after hidden, full camera or
the start) where it was last seen (the previous stretch's last corner, else home =
`webcam.corner`). A position touching its end is its `exit`.

**Cost grid** (cornerCosts, cached per inputs). Output size: outputSize(style.aspectRatio, width,
height, 1080). Screen: styleContentRect (bubble time is the default layout). For grid point j:
cam_j = cameraAt(zooms, t_j, cursor.valid ? focusPath : null, zoomStyleOf(project)); a source point
p maps to q = toOutput(screen, cam_j)(p.x, p.y); a point outside the screen is not seen (weight 0).

For each corner c: R_c = webcamRect(W, H, {corner: c, size}) padded by 0.03·m (m = min(W, H));
prox(q) = max(0, 1 − d / (0.10·m)), d = distance from q to R_c (0 inside). o[c][j] = Σ w·prox:

- **Cursor** (raw sample inside 0..1; drawn at cursorPath.at(t_j)): w = 1.0 when it moved more than
  0.004 in the last 0.1 s, else 0.5; times 1 when the cursor is in the video
  (capture.cursorInVideo), 0.3 when the smooth cursor is off (cursor.show false), else
  max(0.2, cursorOpacity) when it hides when idle.
- **Clicks**: w = 2.0 while |t − click.t| ≤ 0.75 s, at the click's position.
- **Typing**: w = 1.5 over [burst.t, burst.end + 1.0], at the anchor of the auto zoom covering it,
  else the last click within TYPING_CLICK_WINDOW (10 s) before it, else the cursor.
- **Watermark** shown in a corner: +0.5 per second on that corner.

**Hysteresis**: o'[c][j] = max(o[c][j − 10 .. j + 6]): the bubble leaves 0.6 s before the action
arrives (its 0.4 s move is over) and does not come back for 1.0 s.

**Bins**: 0.5 s bins aligned to each stretch start; C[c][b] = Σ o'·G (+ watermark·0.5) + 0.005·0.5
when c ≠ home (tie-break only).

**Search** (planCorners): state (c, k), k = bins since the last move, saturating at D = 12 (6.0 s).
Staying is free; a move is allowed only from k = D and costs λ = 3.0 between neighbouring
corners (same edge) or 4.5 diagonally. Start: k = 1; cost 0 for the entry corner; for another
corner λ(entry, c) when `enterVisible`, else 0.4. End: k = D unless the stretch is shorter than D
bins (then one corner); with an `exit`, + λ(last, exit) (no minimum stay for the user's move).
Ties (|Δ| < 1e-9): staying first, then cornerOrder(home) = [home, its horizontal neighbour,
its vertical neighbour, the diagonal]. In plain words: a move happens only when it avoids at
least 3 weight-seconds of attention (about 1.4 s of a moving cursor in the bubble, or one click
under it), and the new corner then holds at least 6 s.

**Busy cap**: a stretch with more than 2 moves per minute of its length (and more than 1 in all)
is searched again with λ doubled, at most 3 times.

Cost: one hour is 36 000 grid points and 7 200 bins × 48 states: tens of milliseconds.

### Step 11. States

Per output instant: intro | outro | hidden | bubble(c) | yours (a base segment). Runs of equal
state form the plan (and the strip).

### Step 12. Writing

- intro, outro → settings.intro ('camera-only' or 'camera-large'). A large camera takes the
  corner of the neighbouring bubble (intro: the first bubble corner after it; outro: the last
  before it) so it grows in place; none when that is home.
- hidden → 'screen-only'.
- bubble(c) → 'default' + corner c, except where c is already in effect (home in free time, the
  position's corner inside a position): nothing.
- yours → nothing.
- Snap: a run boundary closer than 0.4 s (output) to an edge of a position moves onto that edge,
  so no sliver of a run is left on either side of it.
- Boundaries: s = outputToSource(clips, o).time; o = 0 → clips[0].start, o = T → the last clip's
  end; neighbouring runs share s exactly (they touch and change straight into each other); a
  boundary at a cut lands on the next clip's start. Runs are clipped to source time outside
  locked segments (a change hidden inside a cut is still not written over).
- spliceDirected(base, runs, newId): in free time a run becomes `{auto: true}`; inside position P
  it is cut out: `{auto: true, cutOut: true, corner: P.corner}`, and P keeps its pieces before and
  after (a piece shorter than 0.4 s before, or 0.8 s after, joins the cut-out, as layoutInStay
  does). P's id stays on its first remaining piece; when nothing of P remains, on its first
  cut-out; other pieces get new ids. Touching auto segments with equal (layout, corner, cutOut)
  are joined. Sorted.
- Ids: any written segment equal to one in the project now (layout, corner, marks, start and end
  within 1e-6) takes its id; new ones come from newId ('a' + base36 time + counter).
- No director segment is shorter than 0.05 s of source (readLayouts would drop it); a piece that
  would be is joined to its neighbour of the same layout, or left out when it has none.

### Step 13. withoutDirected (exact inverse)

Walk the segments in start order: drop free auto segments; join each maximal run of touching
(|Δ| ≤ 1e-6) segments that are either manual corner-only in corner C or auto cut-outs in corner
C, and that holds at least one cut-out, into one corner-only C segment, with the id of its first
manual piece, else of its first cut-out; marks stripped. Nothing else is merged. Hence
withoutDirected(spliceDirected(base, runs)) equals base, ids included (when base has no two
touching positions in the same corner, which recordings never make; such a pair is drawn the
same either way).

### Step 14. Plan outputs

- `layouts`: the complete new list. `parts`: one per intro, outro, hidden part, bubble corner,
  with output and source times, ids and a reason.
- `diff` against the auto segments now (matched by layout, corner, marks, times); `upToDate` when
  the layouts equal the current ones.
- `cameraShare`: output share with the camera visible. `cameraShown`: source ranges with the camera
  visible (face samples). `framingCap`: 1.3 when the result shows camera only, a large camera or
  side by side anywhere in the kept video, else 1.6. `kept`: locked changes and positions.
- Notes as in section 2.
- Deterministic: no randomness, ids injectable, fixed tie orders.

### Apply

```ts
const outcome = settings.frameFace
  ? await measureFraming(webcamUrl, faceSampleTimes(plan.cameraShown, speech?.ranges ?? null, webcamOffset, cameraDuration), plan.framingCap, { onProgress, signal })
  : { status: 'skipped' }
// The cursor with the latest project's input edits: a click ignored while the face is measured counts.
store.update((p) => applyDirectorPlan(p, planDirector({ project: p, cursor: effectiveTrack(recorded, p), speech }, settings), outcome))
```

applyDirectorPlan writes the layouts; `director` = settings with `framed`; for a 'framed' outcome
(the option on) the webcam's zoom, cropX and cropY unless within 0.05 zoom and 0.01 crop of the
current ones; `framed` = the framing written now, else kept only while the webcam still shows it.
It returns the same project when nothing changes.

clearDirected ("Remove automatic changes"): withoutDirected; zoom, cropX, cropY removed only while
the framing is still the director's; `director.framed` dropped (the options stay).

---

## 5. Face framing

**Goal**: one static {zoom, cropX, cropY}. It is global on purpose: drawWebcamLayer crops every
layout's box with cameraSourceRect (cover the box, divide by zoom, centre on (cropX, cropY),
clamp inside the picture), so one face centre serves the bubble (1:1), the large camera (1:1),
side by side (3:4) and camera only (frame-shaped); each stops where the picture ends.

**When**: the "Centre my face" option is on (offered by default only while the framing is
untouched or still the director's) and person segmentation can run (ensureSegmenter).

**Sampling** (faceSampleTimes): the source ranges where the result shows the camera, split into N
equal slots by length, N = clamp(round(seconds / 6), 6, 16); in each slot the middle of its
longest speech, else the slot's middle. Camera time = t − webcamOffset; outside [0, camera
duration − 0.05] skipped. Frames come from a hidden muted `<video>` of its own (createVideo on the
webcam URL), seekToFrame then seekedFrame (3 s timeout, then skipped), segmentPicture (the
picture scaled to 256 px on its longest side, the same as for blur; the worker runs on the CPU,
so the same frame gives the same mask), every VideoFrame closed, the element released. About
1-3 s, cached per camera file and times for the editor session.

**faceBoxOfMask** (RGBA mask, about 256×144):

1. Person where alpha ≥ 128; under 2% of the picture: null.
2. Body: column counts over the lower half; the longest run of columns with at least 20% of the
   fullest column; the head is searched within its centre ± 0.6 × its width (ignores chair backs
   and hands at the edges).
3. Top: the first row with at least max(2, 0.015·W) person pixels in that band; below 0.6·H: null.
4. Shoulders: from 0.1·H below the top, the first of 3 consecutive rows each wider than 1.6 × the
   widest row above it; none found: the head is 0.2·H tall.
5. Head width = the 80th percentile of the row widths from the top to the shoulders; height =
   min(shoulders − top, 1.4 × width); centre x = median of those rows' centres; eyes = top +
   0.45 × height. Normalised by the mask size (the mask keeps the camera's shape).

**framingFromFaces**: needs max(4, 40% of samples) faces, else null. Medians of cx, eyeY, width;
spread = IQR of cx. side = min(camW, camH) (a 1:1 bubble's visible side at zoom 1). zoom =
clamp(0.42·side / (width·camW), 1, maxZoom); under 1.1 → 1; spread > 0.12 → at most 1.25 (not
steady); rounded to 0.05 then capped. cropX = cx (the mask is of the unmirrored picture, which
is what cropX addresses). cropY = clamp(eyeY + 0.08·(side/zoom)/camH, 0, 1), so the eyes sit
about 42% down the visible part. Crops rounded to 4 decimals.

**Caps**: maxZoom = plan.framingCap: 1.6, or 1.3 when the result shows the camera large (the
webcam is 1280×720; a 1.3× crop of it fills 1080p at about 1.95× upscaling).

**Worked example** (the e2e camera): a person drawn at 0.62 of a 640×360 picture, hair about 122 px
wide. width ≈ 0.18-0.19 → zoom ≈ 0.42·360/118 ≈ 1.28 → 1.25-1.3 (cap 1.3, camera only is used);
cropX ≈ 0.62; eyes ≈ 0.33 → cropY ≈ 0.40. In camera only at 1280×720 the visible part is about
500 px of 640, clamped at the picture's right edge: the face lands about 0.5 across (mirrored
about 630 px) instead of 486 px without framing.

---

## 6. Files and contracts

Committed with real code (frozen):

| File | What |
|---|---|
| `src/shared/types.ts` | LayoutSegment.auto, cutOut; DirectorHideAfter; DirectorSettings; Project.director |
| `src/shared/engine/directorData.ts` | HIDE_AFTER_CHOICES, DEFAULT_DIRECTOR, FRAMING_EPS, readDirectorSettings, framingUntouched, framingIsDirectors, directorMayFrame, hasCameraPositions, hasDirectorChanges, directorSettingsOf |
| `src/shared/engine/webcamData.ts` | readLayouts keeps the marks |
| `src/shared/engine/project.ts` | migrateProject sanitises `director` |
| `src/shared/engine/outputPoint.ts` | `toOutput(rect, cam)`: the compositor's source → output mapping |
| `src/renderer/src/render/compositor.ts` | `toOut: toOutput(rect, cam)` (same numbers) |
| `src/shared/editor/layouts.ts` | byHand; updateLayout and dragLayout claim; removeLayout gives a whole cut-out back |
| `src/shared/editor/layoutCommands.ts` | setLayoutAt and setCornerAt claim in-place changes |
| `tests/directorContracts.test.ts` | the above |

Committed as stubs (signatures, constants and doc comments frozen; bodies to write):

| File | Exports | Stream |
|---|---|---|
| `src/shared/editor/directorTimeline.ts` | DEMO, INTRO, OUTRO, MIN_DEMO, HIDE, DemoSpan, demoSpan, findIntro, findOutro, findHidden, TimelinePlan, TimelineInput, planTimeline | A |
| `src/shared/editor/directorCorners.ts` | CORNERS_PLAN, ATTENTION, cornerOrder, CornerProject, CornerCosts, cornerCosts, CornerStretch, CornerRun, planCorners | A |
| `src/shared/editor/cameraDirector.ts` | DirectorProject, DirectorInput, DirectorPart(Kind), DirectorReason, DirectorNote, DirectorStripItem, DirectorPlan, planDirector (stub returns an empty plan), withoutDirected, DirectedRun, spliceDirected, applyDirectorPlan, clearDirected | A |
| `src/shared/audio/speech.ts` | SPEECH, SpeechSource, DirectorSpeech, speechLevelSource, speechFromLevels, transcriptSpeech, refineSpeech | B |
| `src/shared/render/faceFraming.ts` | FACE, FaceBox, faceBoxOfMask, FaceFraming, framingFromFaces, faceSampleTimes, FramingOutcome | B |
| `src/renderer/src/editor/directorAnalysis.ts` | SpeechResult, loadDirectorSpeech (stub resolves "nothing known"), FaceProgress, measureFraming (stub resolves 'unavailable') | B |

New in workstream C (no stub needed): DirectorSection.tsx, director.css, directorCopy.ts, the
`directCamera` command, e2e fixtures and test (section 10).

Command spec (C adds it to `COMMAND_LIST`; the editor's `Record<CommandId, () => void>` then
requires the handler):

```ts
{ id: 'directCamera', title: 'Direct the camera automatically', category: 'Camera',
  keywords: 'auto director webcam layout intro outro bubble corner move hide silence face centre framing' }
```

---

## 7. Risks

1. **Speech from the mixed track**: PC sound counts as talking (fewer hides, possible false intro or
   outro). Mitigations: the mic stem is preferred, a transcript gates the mix, the status line says
   which source is used.
2. **Keyboard noise on the mic** outside recorded typing (hook off, another app) reads as speech:
   fewer hides, never a wrong layout.
3. **The cursor stands in for attention**: UI that changes under a corner without the cursor (a
   chat box, a notification) is not seen. Mitigations: 6 s minimum stay, the user can pin a
   corner with "Move camera here", which the director keeps. Picture-change attention is later.
4. **Stale plans**: corners use the current zooms, edit, aspect and bubble size. The section's live
   diff shows when Direct again would change something.
5. **Export aspect presets** that differ from the project aspect move the bubble relative to the
   content; plans use the project aspect, as the preview does.
6. **3D tilt is not modelled**: points map through the flat card (the bubble is drawn flat over
   it); at most ±30°, quadrant choice is barely affected.
7. **Global framing**: a face-tight bubble also crops camera only; caps 1.3 / 1.6 and 1.25 for a
   moving person keep it acceptable. Per-layout framing needs a schema change (later).
8. **Head heuristic**: a raised hand or a high chair back can shift the top row; the body band, the
   shoulder rule and the median over many frames limit it; "not found" leaves the framing alone.
9. **Recorded positions vs automatic corners**: with corners 'auto' and positions, the bubble can
   go to a corner the user never used in free time; hence 'keep' is the default with positions.
10. **Deleted automatic changes come back** on Direct again (as with auto zoom Regenerate); the
    hint says so.
11. **Touching segments block edge drags** (layoutDragBounds stops at a neighbour): the user
    shrinks a block, or deletes the neighbour first. Same as recorded positions today.
12. **Speed changes squeeze transitions**: lengths are planned in output time but the 0.4 s
    transition is in source time; at 8× a change plays in 0.05 s, as for hand-made layouts.
13. **Long recordings**: sound levels are measured once (seconds per hour, cached); faces are a
    constant 6-16 seeks; the plan is tens of ms, debounced 150 ms, corner costs cached.
14. **Forward compatibility**: older builds drop the marks; directed segments become manual there.
15. **Windows-unverified**: the constants are reasoned, not measured on real recordings; they live
    in exported objects (DEMO, INTRO, OUTRO, HIDE, CORNERS_PLAN, ATTENTION, SPEECH, FACE) so they can
    be tuned.

---

## 8. Test plan

### Unit (vitest; fixtures as literals in each test file)

**tests/directorContracts.test.ts** (committed): marks survive readLayouts (only `true`; cutOut
rules; overlap trimming); `director` sanitised by migrateProject; framing ownership; settings
resolution; byHand in updateLayout, dragLayout, setLayoutAt, setCornerAt; layoutInStay inside an
auto corner; removeLayout gives cut-outs back; toOutput equals the compositor formula.

**tests/directorSpeech.test.ts** (B)

- Levels fixture: window 0.05, 60 s; floor 1e-7; speech 1e-3 over 0.5-7.8 s with 0.3 s word gaps
  every 2 s, and 52-59.5 s; keyboard ticks 1e-4 for 0.1 s every 0.3 s over 20-23 s; track.typing
  [{t: 20, end: 23}]. speechFromLevels = [[0.5, 7.8], [52, 59.5]] ± 0.05 (ticks removed, word
  gaps joined). An isolated 0.4 s blip is dropped.
- refineSpeech: mix + transcript with words only in 0.5-7.8 → the 52-59.5 sound removed, `refined`;
  mic + the same transcript → unchanged, not refined; no levels → transcript words joined;
  neither → null.
- transcriptSpeech: words when present, caption times otherwise; null without captions.
- speechLevelSource: mic with a mic stem; mix with sound and no stem; null without sound.

**tests/faceFraming.test.ts** (B)

- Mask 256×144: head ellipse centre (166, 48), radii 20 × 26; neck 16 px wide to y 80; shoulders a
  trapezoid from y 80 to 144, 120 px wide at the bottom. faceBoxOfMask: cx 0.648 ± 0.01, w 0.152
  ± 0.01, eyeY 0.33 ± 0.02.
- framingFromFaces(12 × that box, 1280, 720, 1.6): zoom 1.55 ± 0.05, cropX 0.648 ± 0.01, cropY
  0.38 ± 0.02, steady; cap 1.3 → 1.3.
- Empty mask, 1% coverage → null; a blob only below 0.6·H → null; a chair-back blob at the far
  left does not move cx; 12 faces with 4 found (< 40%) → null; cx alternating 0.4 / 0.7 → zoom ≤
  1.25, not steady; a head 0.4 wide → zoom 1.
- faceSampleTimes: 6..16 times, inside `shown`, preferring speech middles, shifted by webcamOffset
  1.5 (times below 0 skipped), clamped to the camera length, sorted.

**tests/directorAnalysis.test.ts** (B): loadDirectorSpeech with `window.api.analyzeAudio` mocked
(mic requested when the stem exists, mix otherwise; a failed measurement → failed: true and
retried); measureFraming with personSegmenter and the video mocked (as tests/cameraMasks.test.ts
does): 'unavailable' when ensureSegmenter is false, 'not-found' with empty masks, progress
callbacks, abort → 'skipped', frames closed.

**tests/directorTimeline.test.ts** (A)

- F2: T = 60, S = [[0.5, 7.8], [14, 22], [52, 59.5]], clicks at 9, 12, 20, 45. demoSpan = {9, 45};
  intro = [0, 8.0] (still talking at e = 8.0, no pause in [6, 8]); outro = [51.7, 60] (onset 52 −
  0.3); hideAfter 10: [7.8, 14] is not hidden, [22, 52] gives [23.0, 51.7]; hideAfter 5:
  [8.0, 13.2] too.
- Intro rejected when the first onset is at 5 s, when speech covers under 40%, when introEnd < 3.
  Outro dropped when outroStart − introEnd < 4.
- No events → demoSpan null. A sweep (0.5, 0.5) → (0.92, 0.9) over 8.0-8.5 → demo.start 8.0 →
  with speech ending at 6.0, introEnd = min(7.0, 6.5) = 6.5.
- Zooms count as events (over [start, end − transition]); events in cuts are dropped.
- MIN_SHOWN: a 2 s bubble gap without speech between two hidden parts is absorbed; with 2 s of
  speech it grows to 4 s.
- Cuts and speed: clips [{0, 10, ×1}, {15, 30, ×2}]: a hidden part needs 10 s of output silence (20
  s of source in the 2× clip).

**tests/directorCorners.test.ts** (A). Common: 1920×1080 output, padding 0, source 1920×1080, webcam
0.24 bottom-right (BR bubble x 0.8425-0.9775, y 0.72-0.96), cursor drawn (cursorInVideo false,
show true, hideWhenIdle false), no zooms.

- F3a: cursor (0.5, 0.5) until 10 s, (0.93, 0.9) 10-20 s, back to (0.5, 0.5) until 40 s → exactly
  one move, to bottom-left, at a bin start in [8.5, 9.5]; no move back.
- F3b: a moving visit (circling, radius 0.02) into BR of 1.0 s → no move (dilated cost 2.6 < 3.0);
  of 2.0 s → one move.
- F3c: the cursor alternating 3 s in BR and 3 s in BL for 30 s → exactly one move, to top-right.
- F3d: a position top-left [10, 30] with the cursor in TL → TL there, nothing written inside it.
- F3e (zoom path): cursor at (0.9, 0.85) 10-30 s → a move without zooms; with a zoom {10-30,
  ×2, fixed (0.3, 0.3)} the point is off the card → no move. Cursor resting at (0.5, 0.5) 10-30 s
  → no move without zooms; with that zoom it is drawn at (0.9, 0.9) of the card → a move away
  from BR.
- Busy cap: clicks cycling through the four corners every 6.5 s for 120 s → at most 2 moves per
  minute after re-planning.
- Watermark bottom-left: the search never picks bottom-left.
- cornerOrder('bottom-right') = [BR, BL, TR, TL].
- Determinism: two runs equal.

**tests/cameraDirector.test.ts** (A). Shared fixture (the e2e one, in output = source time): T =
48, one clip; 1280×720, padding 0; webcam 0.24 BR; cursor valid, cursorInVideo true: (0.5, 0.5)
until 8.0, moving to (0.92, 0.9) over 8.0-8.5, held; left clicks at 13, 16, 19, 22, 25 there;
speech {source: 'mic', ranges [[0.5, 6], [17, 22], [34, 46.5]]}; ids 'a1', 'a2', ….

- F1 default settings → exactly, touching: camera-only [0, 6.5]; screen-only [6.5, 16.2];
  default bottom-left [16.2, 23.0]; screen-only [23.0, 33.7]; camera-only [33.7, 48]; all auto.
  layoutRamps: first in = 0, last out = 0; every change ≤ 0.4 s.
- F4 splice and inverse: base rec1 default TL [10, 24], m1 side-by-side TL [24, 27], rec1b default TL
  [27, 48] (corners resolve to 'keep') → camera-only [0, 6.5] {auto}; screen-only [6.5, 10]
  {auto}; screen-only [10, 16.2] {auto, cutOut, TL}; rec1 [16.2, 24]; m1 unchanged; screen-only
  [27, 33.7] {auto, cutOut, TL, id 'rec1b'}; camera-only [33.7, 48] {auto, cutOut, TL}.
  withoutDirected(result) deep-equals the base, ids included. kept = {changes: 1, positions: 2}.
- Sliver: a hidden part starting 0.3 s into a position gives a cut-out from the position's start.
- Hand edit: the bubble block trimmed by hand to [16.2, 22.0] (byHand) → re-plan keeps it; the
  hidden part becomes [22.0, 33.7] (the 1 s gap joins it); nothing overlaps it.
- Idempotence: applying, then planning again → upToDate, diff {added 0, removed 0}, same ids;
  applyDirectorPlan returns the same project.
- Speech null → note no-sound, only a corner part (default BL from about 7.5 s to 48). cursor.valid
  false → no-input, no corner parts, intro and outro from zooms only (none here: no-demo).
- Settings: intro 'off', 'camera-large' (corner of the neighbouring bubble), hideAfter 0, corners
  'keep'.
- Cuts and speed: clips [{0, 10, ×1}, {15, 30, ×2}] → a boundary at output 10 maps to source 15,
  neighbours touch, no segment lies wholly inside a cut.
- Framing: applyDirectorPlan writes zoom/crop and `framed` for 'framed' with frameFace, nothing for
  the others, keeps a framing within 0.05 / 0.01; clearDirected resets the framing only while it
  is the director's.
- Property test (200 seeded projects: random speech, clicks, cursor walk, clips with cuts and
  speeds 0.25-8×, random positions and locked segments): sorted, no overlaps; every locked
  segment intact; withoutDirected(result) ≡ base; changes added by the director (between
  different states) at least 2.2 s of output apart; every auto segment at least 0.05 s long with
  ramps ≤ 0.4 s; readLayouts(result) equals result.

**tests/directorCopy.test.ts** (C): part labels, reasons, summary and notice text for fixed plans;
`directCamera` is a Camera command with no default shortcut.

### End to end: tests/e2e/camera-director.e2e.cjs (C)

Launched with WEBGL (`--enable-unsafe-swiftshader`) like camera.e2e.cjs, except the no-WebGL test.

Fixtures (tests/e2e/camera-fixtures.cjs, moved out of camera.e2e.cjs, which keeps its behaviour):

- `personVideo(48, { cx: 0.62 })`: the drawn person moved to 0.62 of a 640×360, 30 fps picture
  (markers optional), cached by name.
- screen: `fx.solidVideo({ seconds: 48 })` (grey), style BLACK (padding 0).
- mic.m4a (cached): `-f lavfi -i "aevalsrc='0.5*(between(t,0.5,6)+between(t,17,22)+between(t,34,46.5))*(0.6+0.4*sin(2*PI*4*t))*sin(2*PI*180*t)':s=48000:d=48" -c:a aac -b:a 128k`.
- project: hasAudio true, audioStems {mic: true, system: false}, webcam {show, BR, 0.24, circle},
  zooms [], autoZoom false, capture default (chromium, cursorInVideo true).
- cursor.json, valid: a sample every 0.1 s at (0.5, 0.5) until 8.0, moving linearly to (0.92, 0.9)
  by 8.5, held; left clicks at 13, 16, 19, 22, 25 at (0.92, 0.9).

Tests:

1. **Direct, preview equals export, one undo step.** Camera tab → [data-testid=director] shows
   parts intro, hidden, corner (data-corner bottom-left), hidden, outro, source "mic", summary
   ready. Click director-apply. Saved project.json layouts (± 0.15 s), all auto: camera-only
   [0, 6.5]; screen-only [6.5, 16.2]; default bottom-left [16.2, 23.0]; screen-only [23.0, 33.7];
   camera-only [33.7, 48]. Framing: zoom ∈ [1.1, 1.3], cropX ∈ [0.56, 0.68], cropY ∈ [0.3, 0.5];
   director.framed equals it. Five `.layout-seg[data-auto="true"]`. Preview at 19.5 s: the canvas
   at the bottom-left bubble's centre (x 0.09, y 0.84 of the canvas) is not grey; at the
   bottom-right one's (0.91, 0.84) grey. Export 720p 60 fps, frames at 3, 11, 19.5, 28, 41 s:
   3 s skin centroid x within 640 ± 90 (centred; 486 without framing); 11 s and 28 s no skin
   anywhere; 19.5 s skin inside the bottom-left bubble (x 28.8-201.6, y 518.4-691.2), the
   bottom-right rectangle all grey; 41 s full camera. Ctrl+Z once: layouts [], no zoom/crop, no
   director. Ctrl+Y: back.
2. **Direct again keeps hand edits.** After directing, drag the bottom-left block's right edge
   about 1 s left → its data-auto is gone. The button reads "Direct again", the summary shows a
   diff. Click it → that block keeps its times, the hidden part after it starts where it ends
   (≈ 22.0), nothing overlaps, the rest as before.
3. **Recorded camera positions.** Seed layouts rec1 (default TL 10-24), m1 (side-by-side TL
   24-27), rec1b (default TL 27-48). "Move the bubble away from the cursor" is off with the
   kept-positions hint. Direct → the saved layouts match F4 (rec1 kept as [16.2, 24], cut-outs
   carry cutOut and TL, the first one in rec1b has id rec1b). Export at 19.5 s shows the bubble top
   left. "Remove automatic changes" → layouts deep-equal the seed, ids included.
4. **No sound.** hasAudio false, no mic. Note no-sound; intro and hide chips disabled. Direct →
   exactly one auto layout: default bottom-left from 7.5 ± 0.5 s to 48; no camera-only or
   screen-only.
5. **No WebGL** (launched with `--disable-webgl`): Direct → the layouts of test 1 and the callout
   director-framing-unavailable; webcam zoom unchanged.
6. **Command palette.** Ctrl+K, type "direct", Enter → the Camera tab is active, the five auto
   segments are saved, the notice starts "Camera directed". A project without a camera lists the
   command as unavailable with "This recording has no camera"; with the camera hidden, "Show the
   camera first".

Regression: camera.e2e.cjs, camera-live.e2e.cjs, render.e2e.cjs, ui.e2e.cjs and commands.e2e.cjs
unchanged and passing (compositor unit tests already cover the toOutput refactor).

---

## 9. Later (not in this wave)

- Attention from annotations, shapes, spotlights and captions (overlays the bubble should not cover).
- Picture-change attention (UI changing under a corner without the cursor), e.g. from proxy frames.
- The note "your camera move at 0:20 sits where your cursor works".
- Ghost blocks of the plan on the camera track while the section is open.
- Per-layout framing, or framing that follows the face over time.
- AI labelling of intro, demo and outro from the transcript; sentence-aware snapping beyond gating.
- Plans for an export preset whose aspect differs from the project's.
- Directing new recordings automatically (an app setting, run when a recording is finalised);
  E-01 "Polish in one click" calling planDirector / applyDirectorPlan.
- Remembering deleted automatic changes so Direct again does not bring them back.
- 3D-tilt-aware mapping.
- Letting the director move or drop the user's recorded positions (B's keepMoves off).

---

## 10. Work split

Three parallel workstreams with disjoint files. Each branches from `feat/director-contracts`.

**Frozen after the contracts commit** (change only with agreement of all three, recorded in this
document): `src/shared/types.ts`; `src/shared/engine/directorData.ts`;
`src/shared/engine/webcamData.ts`; `src/shared/engine/project.ts`;
`src/shared/engine/outputPoint.ts`; `src/renderer/src/render/compositor.ts`;
`src/shared/editor/layouts.ts`; `src/shared/editor/layoutCommands.ts`;
`tests/directorContracts.test.ts`; and every **exported signature, type and constant** of the six
stubbed modules (their bodies and private helpers are free).

### Workstream A: pure director logic (src/shared) and its unit tests

- **Owns**: `src/shared/editor/cameraDirector.ts`, `src/shared/editor/directorTimeline.ts`,
  `src/shared/editor/directorCorners.ts`; `tests/cameraDirector.test.ts`,
  `tests/directorTimeline.test.ts`, `tests/directorCorners.test.ts`.
- **Builds**: steps 2-14 and apply/clear: demoSpan, intro, outro, hidden parts and the anti-flicker
  rule (planTimeline); corner costs through cameraAt + toOutput + styleContentRect with the
  attention weights, dilation, binning, the minimum-stay search and the busy cap (cornerCosts,
  planCorners, cornerOrder); planDirector (classes, output time base, writing runs,
  spliceDirected with cut-outs and id rules, id reuse, diff, notes, strip, cameraShown,
  framingCap); withoutDirected; applyDirectorPlan (framing rules, `framed`, same object when
  unchanged); clearDirected. Cache cornerCosts per inputs (WeakMap on the track's samples plus a
  key of zooms, clips, style, webcam size, capture, cursor settings, watermark).
- **Uses, does not change**: DirectorSpeech (speech.ts), FACE and FramingOutcome
  (faceFraming.ts), directorData.ts, layouts.ts helpers, the engine.
- **Verify**: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`;
  `npx vitest run --testTimeout=60000` (its three test files with the fixtures of section 8,
  including the 200-project property test, plus every existing test).

### Workstream B: signals and face framing, and their unit tests

- **Owns**: `src/shared/audio/speech.ts`, `src/shared/render/faceFraming.ts`,
  `src/renderer/src/editor/directorAnalysis.ts`; `tests/directorSpeech.test.ts`,
  `tests/faceFraming.test.ts`, `tests/directorAnalysis.test.ts`.
- **Builds**: speech ranges from the mic (or mix) levels with keyboard and mouse noise removed,
  joined and filtered; transcript speech; refineSpeech (transcript gates the mix only);
  speechLevelSource. The head from a person mask (faceBoxOfMask: body band, top row, running-max
  shoulders, 80th-percentile width), framingFromFaces (medians, IQR spread, zoom rule, rounding,
  caps), faceSampleTimes. Renderer glue: loadDirectorSpeech over loadAudioAnalysis (never rejects;
  failed flag; retried next call), measureFraming on a private hidden muted video
  (createVideo, seekToFrame, seekedFrame with a 3 s timeout, segmentPicture, frames closed,
  element released, AbortSignal, progress, cache per URL and times). The cursor needs no renderer
  data: output coordinates are computed in A from toOutput.
- **Verify**: typecheck both configs; vitest with its three files (mocks for window.api and the
  segmenter as in tests/cameraMasks.test.ts) plus every existing test. Optional manual check in
  `npm run dev`: call measureFraming from the devtools on a recording with a camera.

### Workstream C: UI, command, timeline marking, undo, persistence, e2e

- **Owns**: `src/renderer/src/editor/panels/DirectorSection.tsx` (new),
  `src/renderer/src/editor/panels/director.css` (new), `src/shared/editor/directorCopy.ts` (new, pure
  copy: part labels, reasons, summary, notice), `src/renderer/src/editor/panels/CameraPanel.tsx`
  (mount the section first when the recording has a camera; Position section reset through
  updateLayout; Layout section hint for an auto target), `src/renderer/src/editor/Inspector.tsx`
  (`directorRequest` prop passed to the Camera panel), `src/renderer/src/views/Editor.tsx`
  (`directCamera` handler: setTab('camera') and a request counter, like smartSpeed; palette
  availability), `src/renderer/src/editor/LayoutTrack.tsx` and `src/renderer/src/editor/camera.css`
  (auto marking), `src/shared/editor/commands.ts` (`directCamera`), `tests/directorCopy.test.ts`,
  `tests/e2e/camera-director.e2e.cjs` (new), `tests/e2e/camera-fixtures.cjs` (new: drawPerson and
  personVideo moved here with a `cx` option), `tests/e2e/camera.e2e.cjs` (imports them; behaviour
  unchanged), `docs/FEATURES.md`, `docs/ROADMAP.md` (NW-08 shipped; no separate face model needed).
- **Builds**: section 2. The section keeps a per-store analysis (like ClipPanel's `analyses`
  WeakMap): speech loaded on mount (loadDirectorSpeech), the draft options from
  directorSettingsOf, the live plan (planDirector, debounced 150 ms; cursorPath/focusPath left to
  planDirector, which builds them once per recording and caches them, so opening the tab again
  reuses them and their corner costs), the strip, the list, the options, the buttons.
  Apply: measureFraming (when Centre my face is on) on faceSampleTimes(plan.cameraShown, …,
  `player.webcam.duration`), then one `store.update` recomputing the plan from the fresh project
  and its input edits (section 4, Apply), the notice with undoHint, the outcome line. Remove: one `store.update(clearDirected)`.
  The palette request applies at once. Unavailable reasons in the palette. Timeline marking.
- **Verify**: typecheck, vitest (directorCopy plus all). Against the stubs the section shows an
  empty plan ("Nothing to change") and framing 'unavailable', enough to build and style it. The e2e
  test runs at integration, after A and B are merged: `npm run build`, then
  `xvfb-run node tests/e2e/camera-director.e2e.cjs`, plus the regression list of section 8.

### Integration

Merge A and B (disjoint), then C; resolve nothing in frozen files. Run both typechecks, the whole
vitest suite, `npm run build`, and the e2e files camera-director, camera, camera-live, render, ui,
commands. Then tune constants only through the exported objects, updating this document.
