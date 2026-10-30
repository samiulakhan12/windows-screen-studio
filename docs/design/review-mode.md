# Review mode (E-02)

Status: built for the next release (branch `feat-review-mode`).

Flown makes many edits by itself: auto zoom, the camera director, Remove silences, Smart speed,
Polish in one click and the "Remove all" of the fillers-and-retakes list. Review mode steps through
every one of them, like tracked changes in a document: what each one is, where it is, and **Keep**
or **Remove** (undo just that one). Keeping a change makes it yours; removing it puts back what was
there before.

| What | Where |
|---|---|
| Review list (the pure rules) | `src/shared/review/*` |
| Review panel (view, css) | `src/renderer/src/review/*` |
| Record of automatic cuts | `Project.autoCuts` (optional, additive), read by `readAutoCuts` in the migration |
| Entry points | a **Review** button in the editor's title bar, the `review` command in `Ctrl+K` (`Shift+R`) |

---

## 1. What the code does today (read before deciding)

* **Zooms already say whether they are automatic.** `ZoomSegment.auto` (`src/shared/types.ts`) is
  true for zooms made by auto zoom (`engine/zoom.ts` `autoZoomsForTrack`, Polish's zoom step) and
  every edit by hand clears it (`zoomEdit.ts`, `groupEdit.ts`, `followEdit.ts` `holdViewAt`).
  Regenerating auto zooms replaces only `auto` zooms (`regenerateAutoZooms`), and
  `rebaseAutoZooms` keeps a deleted automatic zoom deleted.
* **Camera layouts too.** `LayoutSegment.auto` marks the director's segments; `cutOut` marks a
  director segment cut out of a camera position of the user's, and `cameraDirector.ts`
  `withoutDirected` joins such pieces back into the position. The director's face framing is the
  webcam's `zoom/cropX/cropY` while `framingIsDirectors(webcam, project.director)` holds
  (`engine/directorData.ts`); `clearDirected` resets it.
* **Cuts do not.** `Project.clips` is a list of kept ranges (`Clip {start, end, speed}`), so a cut
  made by Remove silences (`smartSpeed.ts` `planSilences` + `applySmartSpeed`, called by
  `editor/panels/ClipPanel.tsx` `apply` and by `polish.ts` `planPolish`'s silences step), by Smart
  speed's idle parts (same `apply`), or by the fillers list's Remove all
  (`editor/panels/TranscriptPanel.tsx` `removeSuggestions` → `transcriptReview.ts`
  `applySuggestions` → `transcript.ts` `cutWords`) looks exactly like a cut made by hand.
  `cutRange` (`engine/timeline.ts`) may also take a sliver shorter than `MIN_CLIP` (0.1 s) next to
  the range, and refuses to cut the last of the video.
* **Undo** is `EditStore.update` (`shared/editor/editStore.ts`): one call is one undo step unless a
  `key` merges it with the previous one. The editor's `settle` (`settleDeletedWords`) drops the
  Transcript tab's `deleted` word marks whose time is no longer cut, so restoring a filler cut
  needs nothing more.
* **Vertical framing.** The follow plan (`engine/reframe.ts`) is recomputed from the project every
  time and never stored; the only stored framing decisions are the holds placed by hand
  (`followEdit.ts`, `auto: false` zooms). There is nothing automatic to review there (§10).
* **Fillers and retakes that were only suggested** live in the Transcript tab's own review list
  (`transcriptReview.ts`); they are not changes yet, so they stay there.
* **The preview player** (`editor/player.ts`) works in source time: `seek(t)`, `play()`, `pause()`,
  `time`, `playing`. It does not emit per frame.
* **Keys.** The editor listens on `window` (`views/Editor.tsx`); a panel that handles a key and
  stops it from bubbling keeps it to itself. `N` is Snapping and `P` is free; `K` is Pause.

## 2. Decisions

### 2.1 How Flown remembers automatic cuts — **a separate, optional record** (`Project.autoCuts`)

Alternatives:
1. *A flag on `Clip`* (`auto?: true`). A cut is a gap *between* clips, not a clip, so the flag has
   nothing to sit on; and clips are split, joined and re-created by every edit (`normalizeClips`,
   `restoreRange`), so a flag would be lost or spread to the wrong footage.
2. *Store the clips from before each automatic edit* (a snapshot). Large, and Remove would undo
   every later edit inside the range too.
3. **A list of records, each the source range acted on and what was there before** (chosen). Source
   time is what every other timed item uses, so the record never moves when the user cuts or
   re-times other parts. Each record holds the kept pieces with their speeds from before
   (`was`), so Remove puts the footage back *at the speed it had*, not just at 1×.

The record is written in the same `store.update` as the cut (one undo step; undo takes both away).
Records whose change is no longer in the clips (the user restored or re-timed that part by hand)
are *stale*: the editor's store drops them in the same undo step as the edit that made them stale
(`settleAutoCuts`, composed with `settleDeletedWords` as the `EditStore` settle), so a later hand cut
over the same footage can never bring an old record back; undo brings the record back with the clips.
A speed-up stays intact when a part of it is cut later: what is still kept still plays at its speed.

### 2.2 What is listed

| Kind (`ReviewKind`) | Comes from | Pending while |
|---|---|---|
| `zoom` | `ZoomSegment.auto === true` | the zoom exists and is still `auto` |
| `camera` | `LayoutSegment.auto === true`; the director's face framing | the segment exists and is `auto`; `framingIsDirectors` |
| `silence` | `autoCuts` by `silences` or `polish` | the record exists and its change is intact |
| `idle` | `autoCuts` by `smart-speed` | as above |
| `words` | `autoCuts` by `filler`, `retake`, `repeat` | as above |

Captions written by Polish and a style preset are not listed: captions have their own tab and are
plain text the user edits; a style is one visible look, not a decision at a time.

### 2.3 Status is derived from the project, never stored

Each listed item is **pending**, **kept** or **removed**, worked out from the current project:

* zoom / camera segment: exists and `auto` → pending; exists, not `auto` → kept; gone → removed.
* face framing: `framingIsDirectors` → pending; framing still set (not the director's) → kept;
  framing back to none → removed.
* automatic cut: record present and intact → pending. Otherwise: its footage is back as it was
  (`was` pieces kept at their old speeds) → removed; else → kept.

So **undo and redo just work**: undoing a Keep makes the zoom `auto` again and the item pending
again, with no second copy of the state to keep in step. Alternative: a set of reviewed ids in the
panel — rejected, it disagrees with the project after any undo.

The panel keeps one thing of its own: the list of items it showed (a snapshot taken when it opens,
with every new pending item added as it appears), so kept and removed items stay in the list,
marked, until the panel closes. Reopening lists only what is still automatic.

### 2.4 Keep and Remove

| | Keep | Remove |
|---|---|---|
| zoom | `auto: false` (as an edit by hand does) | the zoom is deleted |
| camera segment | `auto` and `cutOut` cleared | the segment is deleted; a `cutOut` piece turns back into the position's corner and joins its touching pieces (as `withoutDirected` does for one run) |
| face framing | `director.framed` dropped (the framing is yours) | webcam `zoom/cropX/cropY` removed and `director.framed` dropped (`clearDirected`'s framing part) |
| automatic cut | the record is dropped (the cut stays, now a plain cut) | each `was` piece restored (`restoreRange`) and set back to its speed (`setRangeSpeed`); the record is dropped |
| automatic speed-up | the record is dropped | each `was` piece set back to its speed where it still plays at the record's speed |

Each Keep or Remove is **one** `store.update` (one undo step). **Keep all** keeps every pending
item in one update; **Remove all of this kind** removes every pending item of the focused item's
kind in one update. Removing cuts goes from the latest in source time to the earliest so restoring
one never shifts another (they are in source time anyway; the order only keeps `restoreRange`'s
joins predictable).

### 2.5 Where the panel lives — **a non-modal side panel over the Inspector**

Alternatives: a modal dialog (Polish's) hides the preview and turns off Undo; a timeline overlay
has no room for text. The panel is 360 px wide on the right, over the Inspector, so the preview
stays in view while it plays each change. Editor shortcuts keep working (Space, `Ctrl+Z`), except
for the keys the list uses while the focus is in it (§4.3).

### 2.6 What "Zoom in on the Save button" can say

Flown does not know the names of buttons on the screen (that needs Windows UI Automation at record
time, §10). The label says what the zoom was made for and where: *"Zoom in on a click, top right"*,
*"Zoom in on typing, middle"*, *"Pull back"*, from `anchor` (or a fixed focus point) in thirds of
the frame.

## 3. Data model and compatibility

```ts
/** Who made an automatic cut or speed change. */
export type AutoCutSource = 'silences' | 'smart-speed' | 'polish' | 'filler' | 'retake' | 'repeat'

/** A cut or speed-up Flown made by itself (docs/design/review-mode.md). Source seconds. */
export interface AutoCut {
  id: string
  by: AutoCutSource
  /** 'cut', or the speed the range was set to (2, 4 or 8). */
  action: 'cut' | 2 | 4 | 8
  start: number
  end: number
  /** The kept pieces inside [start, end] before the change, with their speeds: what Remove puts back. */
  was: { start: number; end: number; speed: number }[]
  /** The words a filler or retake cut removed, as shown in the Transcript tab (at most 80 characters). */
  words?: string
}

Project.autoCuts?: AutoCut[]
```

* **Absent** in every project from before (and in projects nothing automatic has cut): the
  migration adds no key (`optional('autoCuts', readAutoCuts(...))`), so old projects load and save
  **byte for byte unchanged**, and simply have no automatic cuts to review. Zooms and layouts
  already carried `auto`.
* `readAutoCuts(raw, duration)`: an array of plain objects only; `id` 1–64 characters, unique;
  `by` and `action` from their lists; `start < end`, finite, clamped to `[0, duration]`; `was`
  pieces finite, inside `[start, end]`, speed in `[0.25, 16]`, at most 64 pieces; `words` a string
  cut to 80 characters; at most 1000 records (the newest kept). Anything else is dropped; an empty
  result is `undefined` (no key). Idempotent.
* A copy (Duplicate, vertical version) carries the records with the clips; they are in source time
  of the same media.
* Rendering, export, captions and the audio plan never read `autoCuts`.

## 4. Exact behaviour and numbers

### 4.1 Recording a change (`recordAutoCuts`)

`recordAutoCuts(project, nextClips, ranges, action, by, words?) → Project`:
1. `removed` = the kept source time of `project.clips` that is not kept in `nextClips` (for a cut),
   or the kept time whose speed changed to `action` (for a speed-up); each piece with its old speed.
2. The pieces are split at the ranges' ends; a part inside a range goes to the first range holding
   it, a part outside every range (a sliver `cutRange` took next to one) to the nearest range. So
   two fillers whose cuts meet keep a record each. Ranges whose share is empty — the cut was
   refused, the part already played that fast — get no record; a share of more than 64 pieces is
   split over several records.
3. Stale records (§2.1) are dropped; the new ones are appended; ids are `c<base36 time><counter>`.
4. Returns `{ ...project, clips: nextClips, autoCuts }`; `project` itself when the clips are the
   same object.

Intact (`autoCutIntact`): for a cut, no clip overlaps any `was` piece by more than 1 ms; for a
speed-up, every part of the `was` pieces still kept plays at `action` (within 1 ms) and something
is kept.

Remove of a cut (`undoAutoCut`) puts each `was` piece back as a clip at its own speed where nothing
plays it, **without snapping** (a piece shorter than `MIN_CLIP` next to a speed change joins the
clip it was part of), and joins it to touching clips at the same speed, keeping the old clip's id;
a split of the user's next to it stays.

### 4.2 The list (`reviewItems`)

`reviewItems(project) → ReviewItem[]`, sorted by source start, then kind:

```ts
interface ReviewItem {
  key: string            // 'zoom:<id>', 'camera:<id>', 'camera:framing', 'cut:<id>'
  kind: ReviewKind       // 'zoom' | 'camera' | 'silence' | 'idle' | 'words'
  start: number; end: number   // source seconds
  title: string          // "Cut 2.4 s of silence"
  detail: string         // "Remove silences", "Polish", "2×", "Camera director"
}
```

Titles (exact copy):

| Item | Title | Detail |
|---|---|---|
| auto zoom, click | `Zoom in on a click, <place>` | `<level>` e.g. `2×` |
| auto zoom, typing (`anchor.until`) | `Zoom in on typing, <place>` | level |
| auto zoom, no anchor | `Zoom in, <place>` / `Zoom in` | level |
| auto zoom, level < 1 | `Pull back` | level |
| layout `camera-only` | `Full camera` | `Camera director` |
| layout `camera-large` | `Large camera` | `Camera director` |
| layout `side-by-side` | `Camera side by side` | `Camera director` |
| layout `screen-only` | `Camera hidden` | `Camera director` |
| layout `default` + corner | `Camera to the <corner> corner` | `Camera director` |
| face framing | `Camera framed on your face` | `Camera director` |
| cut, silences / polish | `Cut <n> s of silence` | `Remove silences` / `Polish` |
| speed, silences / polish | `Sped up <n> s of silence <k>×` | as above |
| cut / speed, smart speed | `Cut <n> s of idle time` / `Sped up <n> s of idle time <k>×` | `Smart speed` |
| filler | `Removed “<words>”` | `Filler` |
| retake / repeat | `Removed a retake: “<words>”` / `Removed a repeat: “<words>”` | `Retake` / `Repeat` |

`<place>` is one of `top left, top, top right, left, middle, right, bottom left, bottom, bottom
right` from the anchor (else a fixed focus point) in thirds; `<n>` is the source length of the
`was` pieces with one decimal; `<corner>` is `top left`, `top right`, `bottom left`, `bottom right`.

`reviewStatus(project, item) → 'pending' | 'kept' | 'removed'` (§2.3). `reviewProgress(statuses)`
gives `{ reviewed, total }`.

`pendingCount(project)` is the badge on the Review button (`reviewItems(project).length`, every
listed item being pending by construction).

### 4.3 The panel

* While open, the Inspector under it is `inert`, so `Tab` never reaches hidden controls. A mouse
  click on a row keeps the focus on the row (the editor's focus release would hand it back to the
  page, and the list's keys with it).
* Opens with the Review button or the `review` command; the focus goes to the first pending item
  (else the first item, else the Close button). Escape (focus in the panel) or Close shuts it and
  gives the focus back to the Review button.
* The time shown is the **video time** of the item's start (`videoTimeAt`, freeze frames counted),
  as `m:ss.t`.
* Choosing an item (click, Enter or Space on it, or `N`/`P`/↑/↓ moving to it) **jumps and plays**:
  the playhead goes to `PREVIEW_BEFORE = 1.5` s of video before the item and plays until
  `PREVIEW_AFTER = 1.5` s after it, at most `PREVIEW_MAX = 8` s in all, then pauses. A cut has no
  length in the video: it plays across the cut point. A removed cut plays the footage that came
  back. Moving to another item, closing the panel, or pressing Space stops it.
* Keys while the focus is in the list: `↓`/`N` next item, `↑`/`P` previous, `Home`/`End` first and
  last, `K` keep, `Delete`/`Backspace` remove. The focus stays on the row (roving `tabindex`); `Tab`
  moves to the row's Keep and Remove buttons. Other keys go on to the editor (Space plays,
  `Ctrl+Z` undoes).
* Header: `Review automatic changes`, then progress `12 of 40 reviewed` and a bar.
* Footer: `Keep all` (keeps every pending item), `Remove all <kind words>` for the focused item's
  kind (`Remove all zooms`, `Remove all camera changes`, `Remove all silence cuts`,
  `Remove all idle-time changes`, `Remove all word cuts`), disabled when none of that kind is pending.
* After each action a polite live region says what happened: `Kept. 13 of 40 reviewed.`,
  `Removed. 14 of 40 reviewed.`, `Kept 26 changes.`, `Removed 5 zooms.`; and the next pending item
  after the one acted on gets the focus (it is not played: playing only follows a move).
* Empty: `Nothing to review. Flown has not changed anything by itself yet, or you have reviewed it all.`

## 5. UI and copy

* Title bar button, before **Polish**: an eye-check icon, `Review`, and a count pill when there are
  pending items. `title`: `Review automatic changes (Shift+R)`; `aria-label`:
  `Review automatic changes, 12 to review`.
* Command: `review`, *Review automatic changes…*, category Edit, keywords `tracked changes auto
  zoom silence cut camera director filler undo keep remove accept reject`, default key `Shift+R`.
* Each row: kind chip (`Zoom`, `Camera`, `Silence`, `Idle`, `Words`, coloured like the timeline
  track: `--track-zoom`, `--track-layout`, `--track-clip`, `--track-clip-fast`, `--track-caption`),
  title, detail and time on the second line, then **Keep** and **Remove** buttons. A reviewed row
  shows `Kept` (check, `--success-text`) or `Removed` (`--text-2`, title struck through) in place of
  its buttons; `Ctrl+Z` takes the action back and the row is pending again (§2.3).
* The row's accessible name: `<title>, <kind>, at <time>, <status>` (status: `not reviewed`,
  `kept`, `removed`), e.g. *"Cut 2.4 s of silence, silence, at 0:12.4, not reviewed"*. The list is
  `role="listbox"`-free: a `ul` of rows whose main button carries that name, so the Keep and Remove
  buttons stay ordinary buttons a screen reader can reach.
* Contrast (on `--surface-1` #141418): titles `--text-1` 17:1, details `--text-2` 7.2:1, `Kept`
  `--success-text` #6ee7b7 11:1, the chips' text is `--text-1` on a 16% tint of the track colour
  (≥ 12:1). Focus ring: `--focus-ring` (7.7:1).

## 6. Security

Nothing new reads files, runs programs or talks to the network. `project.json` is untrusted input:
`readAutoCuts` keeps only well-formed records (types, finite numbers, bounded lengths and counts, no
prototype keys copied: fields are read one by one), so a hand-edited file cannot crash the list or
make Remove restore time outside the recording (`restoreRange` clamps to the duration as well).

## 7. Files and exported signatures

* `src/shared/review/autoCuts.ts` — `AUTO_CUT_SOURCES`, `readAutoCuts(raw, duration)`,
  `recordAutoCuts(project, nextClips, ranges, action, by, words?)`, `autoCutIntact(cut, clips)`,
  `footageBack(cut, clips)`, `undoAutoCut(clips, cut, duration)`, `liveAutoCuts(project)`.
* `src/shared/review/review.ts` — `ReviewKind`, `ReviewItem`, `ReviewStatus`, `reviewItems(project)`,
  `reviewStatus(project, item)`, `keepItems(project, items)`, `removeItems(project, items)`,
  `mergeSnapshot(snapshot, current)`, `reviewProgress`, `KIND_WORDS`.
* `src/shared/review/copy.ts` — titles, places, the live messages, `itemAccessibleName`.
* `src/shared/review/preview.ts` — `previewStretch(clips, start, end)` (where to seek, when to stop).
* `src/shared/review/stretch.ts` — `playStretch(player, clips, stretch, clock)`: plays the stretch,
  pauses at its end; a seek of more than 0.5 s (back or ahead) or a pause by the user ends it
  quietly. `src/renderer/src/review/playStretch.ts` runs it on animation frames.
* `src/shared/review/wordCuts.ts` — `suggestionRanges(words, items, duration)`.
* `src/renderer/src/review/ReviewPanel.tsx`, `ReviewButton.tsx`, `playStretch.ts`, `review.css`.
* Additive lines: `types.ts` (`AutoCut`, `Project.autoCuts`), `engine/project.ts` (one line),
  `Editor.tsx`'s store settle (`settleAutoCuts` after `settleDeletedWords`),
  `ClipPanel.tsx` apply, `polish.ts` silences step, `TranscriptPanel.tsx` Remove all,
  `commands.ts`/`shortcuts.ts` (the command and its key), `Editor.tsx` (state, button, command,
  panel).

## 8. Risks

* **A record drifts from the clips** (the user edits that part by hand): the record turns stale and
  is not listed; Remove of an intact record is computed from the clips at that moment, never from a
  snapshot. Tested.
* **Restoring a cut next to clips at another speed**: `restoreRange` makes the footage a 1× clip and
  `setRangeSpeed` sets it back; tested at 2× and 0.5×.
* **Polish's "polishing again changes nothing"**: recording adds nothing when the clips do not
  change (same object back), so it still holds; covered by the existing polish tests.
* **Shift+R** could clash with a user's own binding: the keymap's conflict rules already handle a
  clash (the user's binding wins in their keymap file).
* **Long lists** (a long recording with 300 zooms): items are plain rows, computed once per project
  change; no virtualisation needed below a few thousand (tested 2000 in < 50 ms).

## 9. Test plan

Unit (`tests/review*.test.ts`), each failing without its code:
* `readAutoCuts`: absent → undefined; malformed entries dropped; clamped; capped; idempotent; a
  project without `autoCuts` migrates with no key (byte-for-byte JSON equal to the old migration).
* `recordAutoCuts`: a silence cut records the exact removed pieces with speeds; a sliver taken by
  `cutRange` joins its record; a refused cut records nothing; speed-ups record only changed pieces;
  stale records are dropped; same clips → same project.
* `undoAutoCut`: cut at 1×, at 2× next to a 1× clip, speed-up back to 1× and to 0.5×; parts the
  user re-timed since are left alone.
* `reviewItems`/`reviewStatus`: each kind and title; statuses after keep, remove, undo (an
  `EditStore` round trip: one undo step each, `Keep all` and `Remove all` one step).
* Director: removing a `cutOut` piece gives its time back to the position (`withoutDirected` agrees).
* `previewStretch`: a cut plays across the cut point; capped at 8 s; clamped to the video.
* Polish and the Clip panel record (planPolish with silences gives `autoCuts`; nothing when no change).
* Copy: every title, the accessible name, progress text.

End to end (`tests/e2e/review-mode.e2e.cjs`): open a project with an auto zoom, a director segment
and an automatic silence cut; the button shows 3; open with `Shift+R`; the rows read right; `N`
moves and the playhead jumps; `K` keeps the zoom (it stays, `auto` false in the saved project);
Delete removes the cut (clips back, record gone); `Ctrl+Z` brings the cut back and the row back to
pending; Keep all; Escape returns the focus to the button; screenshots.

## 10. Later

* Name the clicked control ("Zoom in on the Save button") from Windows UI Automation at record time.
* Review the suggestions not applied yet (fillers) in the same list.
* Polish's captions and style as reviewable items.
* A "Show automatic changes" layer on the timeline (marks on the tracks).
* Vertical framing: if the follow plan's holds become stored decisions, list them as a kind.
