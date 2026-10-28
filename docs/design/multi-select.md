# Select several items and edit them together (E-06)

Status: built on `feat/multi-select` (see §14 for where the build differs from this spec). Roadmap: `docs/ROADMAP.md` E-06 "Select several items" (size M).
Branch: `feat/multi-select`, from `ccr-b6df7cf7-yked87` (Flown 0.5.0).

The owner asked: "select many items, edit all of them". This feature adds that:

- **Select several items.** Ctrl+click and Shift+click on the timeline, Ctrl+click on the
  preview, a box drawn with Shift+drag (or Ctrl+drag) across tracks, Ctrl+A, and Ctrl/Shift on
  the Inspector's item lists. Esc clears. Every selected item shows a white outline and a small
  check, and the timeline header says "5 selected".
- **Edit them together.** The Inspector shows a **Selection** view headed "5 items selected". It
  has the properties the items share, with "Mixed" where their values differ. A change applies
  to every selected item it fits.
- **Act on them together.** Drag them on the timeline (relative times kept, with snapping and
  limits), nudge them ±1 s, delete, cut, copy and paste at the playhead, duplicate, and copy one
  item's look onto others ("copy look / paste look").
- **One undo step.** Every group action is one undo step, and every action has a keyboard path.

The rules of the earlier waves still hold:
- Every visual is a function of source time.
- Every edit is one undo step.
- Projects made before this feature open, preview and export exactly as before. This feature adds
  nothing to `project.json`.

This spec merges two independent designs: Design A (engineering-first) and Design B (user-first).
Section 2 says which design each rule comes from and how each conflict was settled.

---

## 1. What the user gets

| Gesture or key | Result |
|---|---|
| Click a block | Selects it alone, as today. |
| Ctrl+click a block | Adds it to the selection, or takes it out. |
| Shift+click a block | Selects every item on that track from the last item clicked to this one. |
| Ctrl+drag a block | Adds it if it was not selected, then moves the whole selection. |
| Drag a selected block by its middle | Moves the whole selection; relative times are kept. |
| Shift+drag on empty track space | Draws a box: what it touches becomes the selection. |
| Ctrl+drag (or Ctrl+Shift+drag) on empty track space | Draws a box that adds to the selection. |
| `Ctrl+A` | Selects everything on the track you last used. Press it again to select every item. |
| `Esc` | Clears the selection. |
| `Delete` / `Backspace` | Deletes every selected item. |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste items. A paste goes at the playhead. |
| `Ctrl+D` | Duplicates the selection right after itself. |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy the look of one item / paste it onto the selected items. |
| `0`–`4` with zooms selected | Sets the level of every selected zoom. |
| Ctrl+click on the paused preview | Adds or removes the text, shape or spotlight under the pointer. |

Item kinds that can be selected together: **zooms, text, shapes (including blur and pixelate),
spotlights, title cards, chapters and freeze frames**. Captions, camera layouts, clips, cuts,
ranges and recorded clicks stay one at a time. Section 3 gives the reasons.

---

## 2. Decisions and how the two designs were merged

### 2.1 The base

**Design A is the base.** It wins on:
- the data model: a group next to the unchanged single `Selection`, with keys equal to the
  snapping owner keys;
- four small pure modules, each unit-testable in the node vitest environment;
- one field table that drives the Inspector, "Mixed" and copy look / paste look;
- exact block limits for a group move, and exact snapped edges;
- additive guard lines in the existing pointer handlers.

**Grafted from Design B:**
- the key mechanism for `Ctrl+A/C/X/V`: required, see C1;
- Shift+drag box selection on the overlay tracks;
- selection changes on pointerup, and Ctrl+drag joins and moves;
- Ctrl+A pressed again selects every item;
- refusal notices for kinds that cannot join;
- `Ctrl+Shift+C/V` for copy look / paste look;
- look buttons in the single-item panels;
- keyboard selection in the Inspector lists;
- Cut (`Ctrl+X`) and the ±1 s buttons;
- the safer preview click rules;
- camera layouts left out.

### 2.2 Conflicts and how each was settled

| # | Topic | A | B | Decision | Why |
|---|---|---|---|---|---|
| C1 | `Ctrl+A/C/V` (and `X`) | In `DEFAULT_KEYMAP` | "Standard edit keys", matched after the keymap | **B** | `tests/editingWinsContracts.test.ts:381` asserts that `matchShortcut(index(DEFAULT_KEYMAP), Ctrl+C)` is null ("Ctrl+C stays copy"). That test is frozen (editing-wins.md §4), and tests are never weakened. |
| C2 | Copy look / paste look keys | `Ctrl+Alt+C/V` | `Ctrl+Shift+C/V` | **B** | AltGr is Ctrl+Alt on many layouts (Polish AltGr+C types "ć"). Ctrl+Shift+C/V is Office's format painter. An exact binding wins over `matchShortcut`'s Shift fallback, so these never run copy or paste. |
| C3 | Select all | `Ctrl+A` for the track, `Ctrl+Shift+A` for everything | `Ctrl+A`, and again for everything | **B**, with A's track choice (§4.4) | One key to learn. |
| C4 | Box gesture | Ctrl+drag, from a capture handler on `.tl-content` | Shift+drag on empty overlay track space | **Both:** Shift+drag replaces, Ctrl+drag (or Ctrl+Shift+drag) adds. It starts from each track's own background handler (B). Hits come from rendered block rectangles (A). | Shift+drag already means "select by dragging" on the clip track, and Ctrl means "add" everywhere else. The per-track handlers already know a press is on empty space (`track()` stops propagation from blocks). A capture handler would need a list of exclusions and would catch clip blocks. Rectangles match what is drawn, including text lanes, chapter flags and the pieces of a freeze. |
| C5 | Where a box can start | Any non-block space in `.tl-content` | Overlay tracks only | **B** | On the clip track, Shift+drag keeps its range meaning. The ruler and the playhead keep scrubbing. |
| C6 | When Ctrl+click toggles | pointerdown, and it never drags | pointerup when the pointer moved 3 px or less; Ctrl+drag joins and moves | **B** | The Explorer rule. It lets you add an item and drag the group in one gesture. |
| C7 | Plain click on a member | Collapses to that item, without revealing it | Collapses on pointerup | **B's timing.** After collapsing, the click does exactly what a plain click on that block does today (for example, it reveals a text item). | Same result as a click without a group. |
| C8 | Dragging a member's edge | Collapses to that item, then trims it | Trims that item and keeps the group | **A** | The handlers' first line (`onSelect(...)`) stays as it is. Group lengths are set with **Length** in the Inspector. Keeping the group is listed under Later. |
| C9 | Modifier pressed on an edge zone | (unspecified) | (unspecified) | **New:** with Ctrl or Shift held, the whole block counts as its middle. | Edges are 3–8 px wide, and a Ctrl+click should never trim by accident. |
| C10 | Which kinds | Layouts and chapters in | Layouts and chapters out | **Layouts out (B), chapters in (A)** | Layouts form one continuous camera timeline with stay pieces and director cut-outs (§3); a group rule for them doubles the move rules and their tests. Chapters are points with a trivial clamp, and moving a section together with its chapter flag is a real need. |
| C11 | Ctrl+click on a kind that cannot join | Selects it alone, so the group is lost | Keeps the group and shows a notice | **B**, only while a group of 2 or more exists | A slip should not destroy a selection built over 20 clicks. Without a group, it is a plain click, as today. |
| C12 | Inspector | A "Selection (n)" view state inside the Inspector | A new `'selection'` value in `InspectorTab` | **A's mechanics, B's name and layout** | Widening `InspectorTab` would leave a tab with no content when the group dissolves. A view flag disappears with the group. |
| C13 | Mixed controls | A `mixed` prop on `Slider` and `Toggle` in `controls.tsx` | New `mixedControls.tsx` | **B** | `controls.tsx` and the four private `ColorDots` copies stay untouched. |
| C14 | Relative "nudge while Mixed" buttons | none | yes | **Later** | Absolute writes cover the request. Relative nudges double the field rules. |
| C15 | ±1 s buttons in Timing | none | yes | **B** | Cheap through `setGroupStart`. |
| C16 | Preview | Outlines, Ctrl/Shift hit test, and moving the group on the preview | Outlines, toggle, outlines while a modifier is held, and the preview move left for later | **Outlines and Ctrl/Shift toggle now. A plain click on a member selects it alone (B). Ctrl+click on empty preview does nothing (B).** The preview group move and the modifier-held outlines are Later. | The task asks for selecting on the preview. Moving text (output frame) and shapes (source frame, through the camera) together, plus members not on screen, is a feature of its own. |
| C17 | Source of copy look | The group's anchor | Exactly one selected item | **B** | It is always clear whose look is copied. |
| C18 | Look buttons in single-item panels | none | yes | **B** | Mouse users find the feature without knowing the keys. |
| C19 | Ctrl/Shift on Inspector lists, and their keyboard toggles | Later | yes | **B** | The only way to select an arbitrary subset without a mouse. |
| C20 | Cut items | none | `Ctrl+X` | **B** | Expected next to Ctrl+C and Ctrl+V. It is copy plus delete in one undo step. |
| C21 | Paste time | Clamped to `duration − span` | At the playhead; items past the end skipped or shortened | **A** | Every copied item arrives with its spacing kept. The notice says when the paste was moved back. |
| C22 | A pasted zoom over an existing zoom | Skipped | `insertZoom` fit | **New rule (§4.11).** The pasted zoom keeps its start; it is shortened to the free gap if the gap is at least 1 s, else skipped. | `insertZoom` grows backwards (`zoom.ts:794-814`) and would move the start, breaking the relative times. |
| C23 | Freeze frames in a group move | Interval within its own clip, plus an acceptance test | `moveFreeze` across cuts, stuck at the last valid position | **A's interval.** The acceptance test is B's ordered `canMoveFreeze`/`moveFreeze` sequence. | One convex interval: the group never jumps over a cut. No new export from `freezeEdit.ts`. |
| C24 | Snap points | The outer edges, plus the grabbed item's | The grabbed item's first, then the outer edges | **B's order, A's exactness rule** | On a tie the grabbed item's edge wins, because it has the lower point index (`snapPoints`). |
| C25 | Where Duplicate goes | At the group's end | At the end (a freeze's end is `at + length`) | **B**, plus a 1 s minimum offset. A freeze ends at its frame, or at the end of a continue freeze's still, not at `at + length` (§4.11). | A group of only chapters would otherwise land on itself. A hold is seconds of the exported video, not of the recording: counted as source time, it moved pastes and duplicates back onto other frames or into a cut. |
| C26 | Modules | Four modules | One `itemGroup.ts` | **A** | Smaller files, and builders can work in parallel. |
| C27 | Selection state | `ItemGroup { keys, anchor, stamp }` | `GroupState { items, anchor, track }` | **A** | Keys are `${kind}:${id}`, the snapping owner key, so selection, snapping exclusion and lookups share one key. The "active track" lives in the Timeline (`lastTrack()`). |
| C28 | How components read the group | Props | React context | **Context for reading** (`GroupContext`, whose default is a no-op), **plus the Timeline's gesture controller passed to the tracks as a prop** (as `snap` is) | No `Inspector` or `PreviewStage` prop drilling. Without a provider, everything behaves as today. |
| C29 | "Equal" for Mixed | 1e-9 | 1e-6 | **1e-6; zoom level 1e-3** (as `ZoomPanel.tsx:241`) | Slider steps are at least 0.002. |
| C30 | Zoom level keys and the freeze sound command on a group | Act on the group | (not covered) | **A** | Expected. |
| C31 | Ctrl+click or Shift+click on empty space | Nothing happens | Behaves as a plain click | **A** | A Ctrl+click that misses a block by one pixel must not clear the selection or move the playhead. |
| C32 | Spotlight size (cursor spotlights) in the group panel | Yes | No | **Later** | It writes geometry through the crop. |

### 2.3 Other decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Undo | Every group action is one `store.update`, or one `beginGesture`…`endGesture` with one merge key. Merge keys use new prefixes (`group-…`) and never merge with single-item keys. An update that changes nothing returns the same project, so it adds no step (the `sameSpan` lesson, editing-wins.md §6). | One action, one undo step. |
| D2 | The selection is not in the history | As today: undo restores items, and `validGroup` drops keys whose item is gone. | Selection is view state. |
| D3 | Clipboards | Two module-level clipboards in renderer memory: items, and a look. They last for the window's session, also across projects. They are never written to the OS clipboard. | No untrusted JSON parse path, no new IPC, and the user's text clipboard is not overwritten. |
| D4 | Text fields | None of the new commands runs while typing (none is `inText`). The standard keys are never matched there (the `isTextEntry` branch, `Editor.tsx:1017-1028`). | Native Ctrl+A/C/X/V keep working in fields. |
| D5 | Timeline blocks stay pointer-only | As today, blocks have no tabindex. The keyboard path is Ctrl+A, the Inspector lists and the commands. | Making blocks focusable belongs with E-09 (Later). |
| D6 | Performance | The move plan is built once per press; each move is O(n). Snap targets of members are filtered with a Set. The box reads rectangles once per box. State changes only when membership changes. | Hundreds of items stay smooth (§11, unit test G-PERF). |

---

## 3. Which items can be selected together

| Kind (`GroupKind`) | Track (`ItemTrack`) | Time | Moves | Look class |
|---|---|---|---|---|
| `zoom` | `zoom` | `start`–`end` | yes; never overlaps another zoom | `zoom` |
| `annotation` (text) | `text` | `start`–`end` | yes | `text` |
| `shape`, kinds arrow, line, rect, ellipse, highlight | `shapes` | `start`–`end` | yes | `mark` |
| `shape`, kinds blur, pixelate | `shapes` | `start`–`end` | yes | `privacy` |
| `spotlight` (cursor or region) | `shapes` | `start`–`end` | yes | `spotlight` |
| `title` (title card) | `titles` | `start`–`end` | yes | `title` |
| `chapter` | `chapters` | point `t` | yes | none |
| `freeze` | `freezes` (clip track) | point `at` | yes, within its clip | `freeze` |

**Left out, with reasons.** Ctrl+click on one of these while a group exists keeps the group and
shows the notice in brackets (§5.6). Without a group, Ctrl+click is a plain click, as today.

- **Captions** ("Captions are edited one at a time, or all at once in the Captions tab").
  - They follow the spoken words: a move re-times the words (`retimeWords`,
    `src/shared/captions/edit.ts:37`), and they may not overlap (`captionDragBounds`, edit.ts:14-35).
  - Their look is project-wide (`CaptionSettings`).
  - A transcript has hundreds of them, which would flood every box selection.
  - The Captions tab already edits in bulk (find and replace).
- **Camera layouts, including the director's** ("Camera layouts are changed one at a time; the
  director's tools redo many at once").
  - They form one continuous, non-overlapping camera timeline.
  - Moving or deleting one carries the "stay" pieces next to it (`stayAround`, `layouts.ts:96-104`)
    and gives time back to cut-outs (`removeLayout`, `layouts.ts:112-125`). Chaining that over a
    group needs its own rules and test matrix.
  - Bulk tools already exist: Direct again, and Remove automatic changes.
  - Later.
- **Clips, gaps and ranges** ("Clips and cuts are selected one at a time").
  - Delete on them cuts the recording (`Editor.tsx:578-579`). That must never ride along with
    deleting overlays in one keypress.
  - The Shift+drag range already covers several clips.
- **Recorded clicks** ("Recorded clicks are ignored one at a time, or with Find stray clicks").
  - They cannot move, be copied or carry a look.
  - Ignoring many at once already exists (`setIgnored(keys[])`, `Editor.tsx:377-383`).

Text items have no colour field (`types.ts:427-438`). "Change the colour of all of them" applies
to shapes and title cards. A text colour is a separate change; when it exists, it becomes one
more row in the field table.

---

## 4. Behaviour

### 4.1 Selection state

- The single `Selection` (`selection.ts:9-24`) is unchanged.
- Next to it, the editor keeps an `ItemGroup` of **two or more** keys.
  - A key is `${kind}:${id}`. That is the snapping owner key (`snapping.ts:116-129`, and
    `freeze:<id>` in `FreezeMarks.tsx:106`), and what `selectionKey` returns for id kinds
    (`selection.ts:62-63`).

**Invariants:**
1. `rawGroup.keys.length !== 1`. A group that shrinks to one item becomes the single selection
   of that item.
2. `rawGroup` is non-empty only when `rawSelection === null`.
3. Every existing `setSelection(sel)` call also clears the group (`Editor.tsx:261-264`). So a
   plain click, an add command, Esc, opening the crop tool (`Editor.tsx:657`) and the Polish
   result (`Editor.tsx:1242`) all end a group with no other change.
4. In group mode every existing consumer sees `selection === null`. Single-item panels show
   their lists, the preview shows no single handles, and `pickZoom` is null.

**Validity.**
- `validGroup` runs on every render. It drops keys whose item is gone (after undo, Delete, or
  regenerating auto zoom).
- It returns the same object when nothing dropped, so memoised components do not re-render.
- If one key is left, that key becomes the selection, without a tab switch.

**The anchor** is the last item clicked or added with a click. It is:
- the start of a Shift+click run;
- the first choice of track for Ctrl+A.

With a single groupable selection, the anchor is that item.

### 4.2 Clicks on timeline blocks

All of this happens in the Timeline's controller, `multi.press(e, key, mode)`. It is called on
the first line of each groupable block's pointerdown handler, and returns true when it takes the
press.

Definitions:
- `slop` is 3 px of horizontal movement, the same as today's drags (`Timeline.tsx:446`).
- `toggle` = `e.ctrlKey || e.metaKey`.
- `extend` = `e.shiftKey && !toggle`.
- Alt is not read at the press. It only frees snapping during moves, as today.
- "Member" means the key is in the group.

| Press on a groupable block | Pointer moves 3 px or less, then is released | Pointer moves more than 3 px |
|---|---|---|
| No modifier, not a member | `press` returns false: today's handler selects it alone and drags it (the group is cleared) | (same: today's single drag) |
| No modifier, member, middle (`mode === 'move'`) | Collapses to that item alone, then does what today's plain click on it does: text seeks into it (`Timeline.tsx:466-467`), shapes reveal (`revealItem`), title cards `showTitle`, chapters seek to `t`, freezes seek to `at`, zooms nothing | **Group drag** (§4.8) |
| No modifier, member, edge (`start`/`end`) | `press` returns false: today's single trim, which collapses to that item | (same) |
| Ctrl (any zone) | **Toggle:** a member leaves the group; a non-member joins | The item joins if it was not a member, then a **group drag**. The playhead does not move. |
| Shift (any zone) | **Extend** (below) | Same as Ctrl+drag |

**Toggle details.**
- If the single selection is groupable, it becomes the first member of the new group.
- If it is not groupable (clip, gap, range, click, caption, layout), the result is the clicked
  item alone.
- Toggling down to one item gives the single selection. Toggling the only item gives nothing.
- The anchor becomes the toggled key when it joins. When the anchor leaves, the new anchor is the
  last remaining key in selection order.

**Extend details.**
- If the anchor is on the same `ItemTrack`, every item of that track whose start lies between the
  anchor's start and the clicked item's start (inclusive) is added to the selection.
  - The track order is by start, then end, then key. Shapes and spotlights are interleaved by
    start, as `trackItems` does (`Timeline.tsx:117-140`).
  - The anchor stays.
- With no anchor, or an anchor on another track, it adds the clicked item, as Ctrl does.
- Extend never removes.

**Freeze blocks.** Shift and Alt keep today's meaning on the clip track: a press there selects a
range (`FreezeMarks.tsx:103`). The guard line goes after that early return, so freezes join with
Ctrl+click, a box, Ctrl+A or the lists.

**Chapter flags** always use `mode = 'move'`.

**Taking a press.** When `press` takes a press, it calls `preventDefault`, `stopPropagation` and
`releaseFocus()` at once, as `track()` does. The track's own background handler and the clip
track's range never see it.

**Ctrl+press on a kind that cannot join.** This covers clips, gaps, click markers, captions,
layouts, and empty clip-track space.
- It applies only with Ctrl (or Meta) held and **neither Shift nor Alt**. Ctrl+Shift+drag and
  Alt+drag on the clip track stay ranges.
- While a group of 2 or more exists, `multi.refuse(e, what)` keeps the group, shows the notice,
  and calls `preventDefault` and `stopPropagation`. Nothing else happens: no select, scrub or drag.
- Without a group it returns false, and the press works as today.

### 4.3 Box selection (marquee)

**Where it starts.** `multi.background(e, track)` is the first line of every overlay track's
empty-space handler:
- Timeline `onBackgroundDown('zoom' | 'text' | 'shape')` (`Timeline.tsx:511`);
- TitleTrack `onBackgroundDown('title' | 'chapter')` (`TitleTrack.tsx:132`);
- CaptionTrack `onBackgroundDown` (`CaptionTrack.tsx:39`);
- LayoutTrack `onBackgroundDown` (`LayoutTrack.tsx:118`).

It handles the press when button 0 is pressed with Shift or Ctrl (Meta counts as Ctrl). A press
without a modifier returns false, and today's double-click add, clear and scrub run unchanged.

**What it does:**
1. On press it calls `preventDefault`, `stopPropagation` and `releaseFocus()`, and sets
   `dragging.current = true`.
   - The base set is the current selection's keys when Ctrl is held, else empty. The single
     groupable selection counts as one key.
   - Nothing visible happens yet.
2. Once the pointer has moved more than 3 px (`max(|dx|, |dy|) > 3`), the box appears.
   - It is one `.tl-marquee` element inside `.tl-content`, moved by direct DOM writes (`style`),
     like the snap guide (snapping.md D17). That avoids a React render per move.
   - At that moment the rectangles of every rendered groupable block are read once, relative to
     `.tl-content`'s bounding box.
     - Blocks are found by `[data-zoom], [data-annotation], [data-shape], [data-spotlight], [data-title], [data-chapter], [data-freeze]`.
     - The pieces of one continue freeze (`FreezeMarks.tsx:165-186`) are merged by key.
   - Content-relative rectangles do not change when the timeline scrolls, so they are never read
     again during the box. The wheel cannot zoom or scroll the timeline meanwhile (Limits).
3. On each move, the pointer is mapped into `.tl-content` coordinates and the box is the
   rectangle from the press point to the pointer.
   - Hits: `rectsHit(rects, box)` gives every key whose rectangle **intersects** the box. Touching
     is enough; full containment is not needed.
   - The selection becomes base ∪ hits, through `select(keys, anchor)`, **only when membership
     changed**. The live outline is therefore the real selection.
4. Release keeps the result. The anchor becomes the hit with the earliest start, or stays when
   there are no hits.
5. Esc during the box restores the selection from before the press. The box handler listens for
   `keydown` in the capture phase and stops the event.
6. A release within 3 px does nothing: the selection and the playhead stay where they were (C31).

**Limits.**
- Only what is on screen can be boxed: the timeline does not scroll during drags
  (`Timeline.tsx:208`, snapping.md D18).
- While a box is drawn, or a press the controller took is held (a group click or drag),
  `multi.busy()` is true and the timeline's wheel handler does nothing: Ctrl+wheel does not zoom
  and the wheel does not scroll. Otherwise the stored rectangles, and a group drag's pixels-to-
  seconds scale, would no longer match the blocks.
- The box may extend over the clip row (for freezes) and the ruler. Blocks of captions, layouts,
  clips and clicks are never hit.
- Hidden layout and caption tracks are not hit either, since their blocks are not groupable.

### 4.4 Ctrl+A (`selectAll`)

The command picks a **track** in this order:
1. the anchor's track (or the single groupable selection's track);
2. `TimelineHandle.lastTrack()`: the `ItemTrack` of the last pointerdown that any `multi.*` guard
   saw:
   - the clip track counts as `freezes`;
   - the chapter strip as `chapters`;
   - the title lane as `titles`;
   - caption and layout tracks count as "no track";
3. the open Inspector tab: `zoom` → zooms, `text` → text, `shapes` → shapes, `clip` → freezes.
   Other tabs give no track.

Then:
- **The track has items and not all of them are selected:** the selection becomes all items of
  that track. Notice: "Selected all 12 text items · Ctrl+A again selects every item".
- **Otherwise** (no track, an empty track, or the track already all selected): every groupable
  item in the project. Notice: "Selected every item (24)".
- **No groupable item exists:** "No items to select yet".
- **While the crop tool is open:** "Close the crop tool first".

The anchor becomes the track's first item, or stays when it is still selected.

### 4.5 Clearing, Esc and undo

- **Esc** clears the group through the existing branch (`Editor.tsx:1036-1039`). The crop tool
  still takes Esc first (`Editor.tsx:1030-1035`), and focus picking is ended before the
  selection is cleared.
- **A plain click on empty track space** clears it, as today (`onSelect(null)`), and scrubs.
- **The count chip's × button** clears it (§5.1).
- **Survives:** playback, scrubbing the ruler or the playhead, timeline zoom, Inspector tab
  switches, and window blur.
- **Undo and redo** restore project data only. `validGroup` then drops the missing keys (§4.1).

### 4.6 The preview

With a group, and the player not moving (`player.moving === false`, as `PreviewStage.tsx:110`):

**Outlines.**
- Each member that is visible at the frame shown gets a dashed outline
  (`[data-testid="group-outline"]`):
  - text: the box `AnnotationHandle` measures (`PreviewStage.tsx:497-501`, `textWidth`);
  - shapes: `shapeBounds` mapped through the camera with `mappingFor` (`PreviewStage.tsx:83-94`);
  - region spotlights: their box, mapped the same way.
- Cursor spotlights, zooms, title cards, chapters and freezes have no outline.
- The preview is drawn flat while outlines show, as it is for handles today
  (`PreviewStage.tsx:231-235`).

**Ctrl+click or Shift+click.** A new first branch in `onOverlayDown`, after the pick and crop
branches (`PreviewStage.tsx:311-326`), hit-tests every item visible at the frame shown.
- The order is the compositor's, topmost first (`compositor.ts:198-214`):
  1. text, in reverse list order;
  2. mark shapes, in reverse list order;
  3. privacy shapes, in reverse list order;
  4. region spotlights, by their lit box (last, because it covers a large area).
- A hit toggles that key, with the same rules as §4.2. The single selection, if groupable,
  becomes the first member.
- **No hit does nothing.** Playback is not toggled (C16). Ctrl+click is a gathering gesture.
- If the pointer moves more than 4 px (`CLICK_SLOP`) before release, nothing happens.

**Plain clicks.**
- A plain click on a member's outline selects that item alone, so its normal handles appear.
- A plain click elsewhere toggles playback, as today.

**Handles of a single selection.** `AnnotationHandle.onDown` and the `ShapeEditor` drag start
return early, without `stopPropagation`, when Ctrl or Meta is held. The press then reaches
`onOverlayDown`, which toggles. Shift on a handle keeps its meaning (keep the shape while
resizing).

Moving several items on the preview is Later (C16).

### 4.7 Inspector lists (keyboard path)

Rows of these lists take part in the selection:
- "Text in this video" (`TextPanel.tsx:81-101`);
- "Title cards" (`TextPanel.tsx:161-182`);
- the chapter list's time buttons (`TextPanel.tsx:382-395`);
- Shapes "In this video" (`ShapesPanel.tsx:121-146`).

| On a row | Result |
|---|---|
| Click | As today: selects it alone and seeks |
| Ctrl+click | Toggle (§4.2) |
| Shift+click | Extend, in the list's order (by start) |
| Focus, then `Ctrl+Space` or `Ctrl+Enter` | Toggle |
| Focus, then `Shift+Enter` | Extend |

The row's `onKeyDown` handles the keys with `preventDefault` and `stopPropagation`, so the window
shortcut handler never sees them. Today `Ctrl+Space` runs no command (`shortcuts.test.ts:195`),
and `Ctrl+Enter` and `Shift+Enter` match nothing.

Rows of members get `.active` and `aria-pressed="true"`.

A toggle from a list row does **not** open the Selection view (`selectKeys(…, { reveal: false })`),
so focus stays on the row and the next row can be toggled.

**Where the lists show.** These lists are always on screen in their tabs: in group mode
(`selection === null`), and below a single selected item's editor. The selected text item, title
card or chapter's editor goes above the lists, as a selected shape's does in the Shapes tab, and
the list's row of the single selected item is marked as pressed. Each list keeps its place in the
panel, so the first Ctrl+click or Ctrl+Space on a row (which leaves one item selected, and opens
its editor above) keeps the row and its focus, and the next row can be toggled.

**The keyboard path to any subset** therefore does not depend on these lists:
1. `Ctrl+A` selects the track (or everything).
2. The Selection view's **Selected items** list (§4.9) leaves items out one by one.
3. With a group, the panels' lists also add items back (`Ctrl+Space`).

Each list header gets a **"Select all"** button that selects the list's kind:
- text items;
- title cards;
- chapters;
- shapes and spotlights.

The Zoom panel's Auto zoom aside, "N automatic zooms" (`ZoomPanel.tsx:414`), gets a **"Select
them"** link. It selects the zooms with `auto === true`.

### 4.8 Moving together on the timeline

**Start.** A group drag starts from §4.2. On the press:
- the plan is built once: `groupMovePlan(store.state, keys)`;
- a snap session opens: `snap.begin(e, { group: keys })`;
- `store.beginGesture()` is called;
- `dragging.current = true`, so the timeline does not follow the playhead.

The playhead does not move during a group drag.

**Block limits (pure `groupMovePlan`).**
- Each member gives an allowed delta interval `[lo, hi]` in source seconds.
- Each interval is widened to contain 0 (`lo = min(0, lo)`, `hi = max(0, hi)`), so a group whose
  data is already out of bounds never jumps.
- The group's `[min, max]` is the intersection of the intervals. It always holds `min ≤ 0 ≤ max`.

| Member | Interval | Stop reason |
|---|---|---|
| text, shape, spotlight, title | `[−start, duration − end]` (the clamps of `annotations.ts:38-41`, `shapes.ts:296-299`, `titles.ts:76-79`) | `start` / `end` |
| chapter | `[−t, duration − t]` (`TitleTrack.tsx:110`) | `start` / `end` |
| zoom | `[prevEnd − start, nextStart − end]`. `prevEnd` is the largest end among **unselected** zooms with `end ≤ start + 1e-6` (else 0). `nextStart` is the smallest start among unselected zooms with `start ≥ end − 1e-6` (else `duration`). This is `zoomDragBounds` (`zoom.ts:817-824`) with the selected zooms removed, computed with one sort and a sweep, O(n log n). An unselected zoom between two selected zooms bounds both directions. | `zoom` (or `start`/`end`) |
| freeze, active, not at the edit's end | `[c.start − at, c.end − 0.001 − at]`, where `c` is the clip holding `at`. Anchors are whole ms and clip ends are exclusive (`freezeEdit.ts:38-50`). | `freeze-clip` |
| freeze at the edit's end (`atEditEnd`) | `[cLast.start − at, 0]` | `freeze-clip` |
| freeze whose frame is cut (inactive) | `[0, 0]`: it pins the group | `freeze-in-cut` |
| the members already fill `[0, duration]` | `[0, 0]` | `full` |

**Acceptance (`groupAccepts(p, plan, delta)`).** A freeze can also be refused by an unselected
freeze on the frame it would take.
- The freezes are applied in order: latest first when `delta > 0`, earliest first when `delta < 0`.
- For each one, `canMoveFreeze(q, id, at + delta)` must hold; then `q = moveFreeze(q, id, at + delta)`.
- The order means a selected freeze never lands on another selected freeze's old frame.
- When the delta is refused, the drag keeps the **last accepted delta**, so the block stops. This
  matches `moveFreeze` returning the same project (`freezeEdit.ts:147-150`).
- If the group has no freezes, every clamped delta is accepted.

**Snapping.**
- `SnapBegin.group` (new) leaves out of the snap index:
  - every member's own edges: segment and chapter targets whose owner key is in a `Set`;
  - members' freezes, through `projectFreezeTargets(p, freezeExcludes)` (`snapping.ts:135-139`).
- The points snapped are the grabbed item's start and end, then the group's outer start and end,
  without duplicates (`groupSnapPoints(plan, grabbed)`). Point items have one point.
- The constants are unchanged:
  - catch at 8 px, release at 12 px, ties within 0.5 px;
  - only the visible window catches;
  - Alt places freely;
  - `N` and the magnet button toggle snapping;
  - the playhead is a target unless the player is moving (`snapping.ts:19-32`, `snapControl.ts:114-166`).
- On a tie the grabbed item's edge wins, by the lower point index.
- `snapGroup` returns the **unsnapped** clamped delta when:
  - the clamp moves the snapped point more than `SNAP.exactS` off its target; or
  - `accept` refuses the snapped delta.

  In both cases the guide is hidden, as in `snapSpan` (snapping.md D11).
- **Exact edges.** A member edge whose initial value equals, bit for bit, the snapped point's
  initial value is written as the target `T`. The member's other edge keeps its length
  (`end = start + len`, as `snapSpan`). Every other edge is `initial + delta`.

**Writing (`moveGroup(p, plan, delta, exact)`).**
- Text, shapes, spotlights, titles and chapters move by exactly `delta`.
- Zooms move by `delta` with `auto: false`, as a single zoom drag does (`Timeline.tsx:442`). They
  keep `anchor`, `easing`, `transition`, `scale` and `focus`.
- Freezes use the ordered `moveFreeze` sequence, so an anchor lands on a frame start. A freeze's
  spacing to the other members can change by less than one frame.
- `delta === 0`, or a result equal to the start, returns the same project, so no undo step is added.
- Each move is one `store.update(…, 'group-move:<n>')` inside the gesture, where `n` is a
  per-drag counter.
- The release calls `store.endGesture()`, so the whole drag is one undo step.

**Feedback.**
- The snap guide shows as it does for single drags.
- The first time a drag is held back by a limit, it shows one notice:
  - "The selection stops here: a zoom is in the way";
  - "…: the start of the recording" / "…: the end of the recording";
  - "…: a freeze frame stays in its clip (drag it alone to move it past a cut)";
  - "…: a freeze frame is already on that frame";
  - "A selected freeze frame is in a cut, so the selection can't move. Ctrl+click it to leave it out";
  - "The selection already fills the recording".

**Rendering.** Only the pressed block is kept mounted outside the render window (the `selId`
rule, `Timeline.tsx:530-531`). Other members that are scrolled away stay unmounted, and their
data still moves.

### 4.9 Editing together: the Selection view

**Opening.**
- The Inspector keeps a local flag, `showGroup`. It is set true whenever the editor's
  `groupReveal` counter changes.
  - The counter goes up on each `selectKeys(keys, anchor)` that leaves 2 or more items, unless
    the call passes `{ reveal: false }`.
  - Inspector list rows and the Selection view's own buttons pass `{ reveal: false }`. The view's
    buttons that leave one item (Leave out, or "Only text (1)") reveal it instead (item 3).
  - Timeline clicks, boxes, the preview, Ctrl+A, paste and duplicate reveal.
- Clicking any tab sets it false and shows that tab; the group stays.
- The view renders only while a group exists, so it disappears with the group.
- `TAB_FOR` and `InspectorTab` are unchanged.

**Layout, top to bottom (`SelectionPanel`):**

1. **Header.** `<Section title="5 items selected">` with `role="status" aria-live="polite"`.
   - A summary line, for example "3 zooms · 2 text items", and the span "0:12.4 – 1:45.0".
   - One narrowing button per kind present: "Only zooms (3)", "Only text (2)", and so on. Each
     selects only those items (tooltip "Select only the zooms"). Two or more stay in the view; a
     button for one item gives the single selection, revealed as Leave out does (item 3), with
     the keyboard on that item's tab button (§5.2).
2. **Actions** (each tooltip carries its shortcut through `withShortcut(text, commandKeys(keymap, id))`):
   - Duplicate (`Ctrl+D`);
   - Copy (`Ctrl+C`);
   - Paste look (`Ctrl+Shift+V`): disabled with its reason as tooltip when no look is held, or
     when no member fits the held look ("The copied look is for title cards");
   - Delete (`Delete`), styled `danger`.
3. **Selected items.** A `<details>` list, open by default up to 12 members and closed above that.
   - Its summary reads "Selected items (5)".
   - It shows one row per member, sorted by start, at most 200 rows (as the panels' lists).
     Each row has the kind's icon, a name and a time: the text, the title, the shape's label,
     "Zoom 2×", "Freeze frame", or the chapter's name.
   - Each row has a **Leave out** button, `aria-label="Leave out <name> at <time>"`. It toggles
     that key with `{ reveal: false }`. Focus then moves to the next row's button, or to the
     previous one when it was the last.
   - Leaving out down to one item gives the single selection. The view closes, and that call
     reveals (no `{ reveal: false }`), so the remaining item's tab opens as if it had been clicked.
4. **Timing** (all kinds):
   - **Starts at.** A number field in seconds, with one decimal shown. It commits on Enter or
     blur when the value is a valid number, the same pattern as `TimeFields` (`ShapesPanel.tsx:350-422`).
     - A "set to the playhead" button sets `displayTime(clips, player.time)`.
     - The value is never Mixed: it is the group's start, the smallest `start`, `t` or `at`.
     - A change calls `setGroupStart`: the group moves by the difference, with the drag's limits
       and acceptance, as one update with no merge key (one undo step per commit).
   - **Move.** Buttons "−1 s" and "+1 s". Each press is `setGroupStart(start ± 1)`, one update
     with no merge key, so each press is its own undo step, however fast they come.
     If a limit cut the move short, the notice says so: "Moved 0.6 s later: a zoom is in the way".
   - **Length.** Shown when the group has span kinds (zoom, text, shape, spotlight, title). It
     shows the shared length or "Mixed", and writes `setGroupLength` (§4.9.2).
   - Hint: "Moves as one block: it stops at the recording's ends, at zooms in the way, and a
     freeze frame stays in its clip."
   - With chapters selected: "Chapters move with the selection; rename them one at a time."
5. **One section per look class present**, in this order:
   - Zooms (n);
   - Text (n);
   - Shapes (n): mark shapes;
   - Privacy (n);
   - Spotlights (n);
   - Title cards (n);
   - Freeze frames (n).

   Rows come from `GROUP_FIELDS` (§4.9.1). With one class only, that section is the whole panel
   below Timing.
6. **Automatic blocks.** The Zooms section aside reads "5 automatic · 3 edited", with the hint:
   "Changing or moving the automatic ones makes them yours: auto zoom then keeps them."

#### 4.9.1 Field table (`GROUP_FIELDS`)

Ranges are the single panels' own constants, imported from where they are defined.

| Class | Field id | Label | Control | Read | Write | Applies to | Look |
|---|---|---|---|---|---|---|---|
| zoom | `zoom.level` | Zoom level | `ZOOM_LEVEL_PRESETS` chips + slider `ZOOM_MIN_SCALE`–`ZOOM_MAX_SCALE` (0.5–5), step 0.05, `formatLevel` | `zoomTargetScale(zoomInView(crop, z))` (`ZoomPanel.tsx:178-181`) | `setZoomLevelInView(crop, z, v)` (`cropEdit.ts:319-322`; sets `auto: false`) | all zooms | yes |
| zoom | `zoom.focus` | Focus | chips Follow cursor / Fixed point (Region is left out: it is drawn per zoom) | `focus.mode` (a region counts as its own value, which reads Mixed with the others) | as `setFocusMode` (`ZoomPanel.tsx:200-210`). Cursor: `{focus: {mode: 'cursor'}, scale: level, auto: false}`. Fixed: the point it looks at now (a region's centre, a fixed point, or `toCrop(crop, focusFor(z))`), stored through `fromCrop`, with `scale: level` and `auto: false`. Follow cursor is disabled without cursor data. | all zooms | no |
| zoom | `zoom.easing` | Easing | `ZOOM_EASINGS` chips | `zoomEasing(z, style)` | `{...z, easing: v, auto: false}` | all zooms | yes |
| zoom | `zoom.transition` | Transition | slider `MIN_TRANSITION`–`MAX_TRANSITION` (0.15–2.5 s), step 0.05, `secFmt` | `zoomTransition(z, style)` | `{...z, transition: v, auto: false}` | all zooms | yes |
| zoom | `zoom.ownStyle` | Use zoom style | link button, shown when any member has its own easing or transition | (n/a) | `{...z, easing: undefined, transition: undefined, auto: false}` on the members only | all zooms | no |
| text | `text.style` | Text style | chips Caption pill / Title | `a.style` | patch | all text | yes |
| text | `text.size` | Size | slider `ANNOTATION_SIZE.min`–`.max` (0.02–0.14), step 0.002 | `a.size` | patch | all text | yes |
| text | `text.x`, `text.y` | Position X / Y | slider 0–1, step 0.005, `pctFmt` | `a.x` / `a.y` | patch (one value lines the items up) | all text | no |
| mark | `mark.color` | Colour | colour dots: `HIGHLIGHT_COLORS` when every target is a highlight, else `SHAPE_COLORS`, plus any colour | `s.color`, compared in lower case | patch | arrow, line, rect, ellipse, highlight | yes |
| mark | `mark.fill` | Filled | toggle | `s.fill` | patch | rect, ellipse only | yes |
| mark | `mark.strokeWidth` | Line width | slider `STROKE_LIMITS` (1–24), step 0.5 | `s.strokeWidth` | patch | where `hasStroke(s)` holds **after** a Filled write | yes |
| mark | `mark.opacity` | Opacity | slider 0.1–1, step 0.01, `pctFmt` | `s.opacity` | patch | all mark shapes | yes |
| privacy | `privacy.kind` | Effect | chips Blur / Pixelate | `s.kind` | patch `{kind}` | blur, pixelate | yes |
| privacy | `privacy.strength` | Amount | slider 0–1, step 0.01, `pctFmt` | `s.strength` | patch | blur, pixelate | yes |
| spotlight | `spotlight.shape` | Shape | chips Ellipse / Rectangle | `s.shape` | patch | all spotlights | yes |
| spotlight | `spotlight.dim` | Darkness | slider 0.1–0.95, step 0.01 | `s.dim` | patch | all spotlights | yes |
| spotlight | `spotlight.feather` | Soft edge | slider 0–1, step 0.01 | `s.feather` | patch | all spotlights | yes |
| title | `title.style` | Style | the `TITLE_STYLES` buttons | `c.style` | patch | all title cards | yes |
| title | `title.background` | Background | `TITLE_BACKGROUNDS` chips | `c.background` | patch | all title cards | yes |
| title | `title.color` | Colour | colour dots `TITLE_COLORS` | `titleColorOf(c)` | patch `{color}` | cards with `background === 'solid'` (row shown only when every card is solid) | yes |
| title | `title.textColor` | Text colour | colour dots `TITLE_TEXT_COLORS` | `titleTextColorOf(c, project.style.background)` | patch `{textColor}` | all title cards | yes |
| freeze | `freeze.length` | Hold for | slider `FREEZE.min`–`FREEZE.max` (0.5–30 s), step `FREEZE.step` (0.1) | `f.length` | `setFreezeLength(p, id, v)` for each (`freezeEdit.ts:102-104`) | all freezes | yes |
| freeze | `freeze.sound` | Sound | chips Pause the sound / Keep the sound playing | `f.sound` | `setFreezeSound(p, id, v)` for each (refused at the edit's end, `freezeEdit.ts:137-142`) | all freezes | yes |

**Not offered in a group, with reasons:**
- Free text (text, title, subtitle, chapter name): writing one string into many items destroys them.
- Region focus: it is drawn per zoom.
- Pan to next zoom: it works on pairs of zooms.
- The cause line and "Ignore this click": they depend on each zoom's own click.
- Spotlight follows (mode) and cursor-spotlight size: each spotlight places its own area (C32).
- Shape geometry: use the preview, one at a time (preview group move is Later).
- Add text on the freeze.

**"Applies to n of m".** A field that applies to only some members of its section says so in its
label, for example "Filled · applies to 1 of 3", and writes only to those.

#### 4.9.2 Mixed values and how writes apply

- **Shared or Mixed.** `sharedValue(values, eq)` decides it:
  - numbers are equal within 1e-6, and the zoom level within 1e-3;
  - colours are compared in lower case;
  - `undefined` equals only `undefined`.
- **Sliders** (`MixedSlider`):
  - the readout says "Mixed", and `aria-valuetext="Mixed"`;
  - the thumb sits at the first target's value, at 50 % opacity;
  - moving it sets that absolute value on every target.
- **Chips** (`MixedChips`):
  - `value = null`, so no chip is pressed (`Chips` already supports null, `controls.tsx:76, 87`);
  - a "Mixed" tag follows the label, and the group's `aria-label` ends with ", mixed".
- **Colour dots** (`MixedColorDots`): none is pressed, and "Mixed" shows beside them. Picking a
  colour sets them all.
- **Toggles** (`MixedToggle`):
  - `indeterminate = true`, so screen readers announce "mixed";
  - a click sets every target on.
- **Length field:** empty, with placeholder "Mixed".

**Writes.**
- Every field write is one `applyField(p, field, keys, value, ctx)`:
  - list kinds change in one O(n) pass (`mapItems`), which returns the same project when no item
    changed;
  - freezes fold the existing project-level function over the ids.
- **Undo.**
  - Sliders call `holdGesture` (`context.ts:21-33`) and use the key `group-field:<fieldId>:<stamp>`.
    A drag is one step, and arrow keys merge within the 800 ms window.
  - Chips, toggles, colour dots and buttons are one update each.
- **Refusals** are counted and named in a notice, for example "1 freeze frame at the end keeps
  pausing the sound".

**Length (`setGroupLength(p, keys, length)`).** Each span member is resized through its own
kind's existing drag helper in `end` mode, with `dt = length − (end − start)`:

| Kind | Helper |
|---|---|
| zoom | `dragZoomTimes` with `zoomDragBounds` on the current project (`zoom.ts:817-846`), so it stops at the next zoom; minimum `MIN_ZOOM_LENGTH` 0.6 s |
| text | `dragAnnotationTimes`; minimum 0.3 s |
| shape, spotlight | `dragShapeTimes`; minimum 0.3 s |
| title | `dragTitleTimes`; minimum 0.5 s |

- Every helper also clamps at `duration`.
- The result says how many members were clamped: "3 zooms are shorter: the next zoom starts sooner".
- Zooms get `auto: false`.
- Freezes and chapters are not resized here; a freeze's length is **Hold for**.

### 4.10 Delete and Cut

**`deleteSelection`** gains a group branch ahead of today's single branch (`Editor.tsx:565-587`).
It is one `store.update(p => deleteItems(p, keys))`:
- zooms, text, shapes, spotlights, titles and chapters are filtered against the key Set;
- freezes go through `removeFreeze` for each id, which drops the `freezes` key with the last one
  (`freezeEdit.ts:165-173`).

Then the selection is cleared, and the notice reads "Deleted 5 items · Ctrl+Z to undo"
(`undoHint`). Delete repeats while held (`commands.ts:51`); after the group is gone, a repeat
does nothing.

**`cutItems` (`Ctrl+X`)** is `copyItems`, then the same delete, in one update. Notice: "Cut 5
items · Ctrl+Z to undo".
- On a clip, gap or range: "To cut part of the recording, press Delete". Nothing changes.
- With nothing groupable selected: "Select items to cut".

### 4.11 Copy, paste and duplicate

**Copy (`copyItems`, `Ctrl+C`)** works on the group, or on a single groupable selection.
- It stores deep copies (`structuredClone`) in the item clipboard:
  - `origin` = the selection's start (smallest `start` / `t` / `at`);
  - `span` = the selection's end minus `origin`: the part that must fit before the video's end.
    The end is the largest `end`, `t` or `at`. A freeze counts as its frame: its `length` is
    seconds of the exported video that the recording does not have, and the timeline cuts its
    block short at the end, so it never has to fit.
  - It also stores the `projectId`.
- Notice: "Copied 4 items".
- With nothing selected: "Select items to copy".
- With a selection that cannot be copied: "Ctrl+C copies zooms, text, shapes, spotlights, title
  cards, chapters and freeze frames".

**Paste (`pasteItems`, `Ctrl+V`).**
- **Paste time** `P = clamp(displayTime(clips, player.time), 0, max(0, duration − span))`.
  `displayTime` gives the frame the preview shows, so a playhead in a cut pastes at the next kept
  frame, as adding does (`Editor.tsx:433`).
- **Offset** = `P − origin`. Every item keeps its distance from the others.
- **Placement by kind:**

| Kind | Placement | Skipped when |
|---|---|---|
| text, shape, spotlight, title | `{...copy, id: newId(), start + offset, end + offset}`, with ids from `newAnnotationId`, `newShapeId`, `newSpotlightId`, `newTitleId` | its end > `duration` (`outside`) |
| zoom | `{...copy, id: newZoomId(), start, end, auto: false}` without `anchor` (it named the original click). Placed in start order into the growing list. Free room = from its start to the next zoom's start (or `duration`). Room ≥ length: kept whole. Room ≥ `MIN_NEW_ZOOM` (1 s): shortened to the room (`zoom-shortened`). | its start is inside a zoom, or the room is under 1 s (`zoom-taken`) |
| chapter | `createChapter(t + offset, copy.title)` | `chapterNear` (within `CHAPTER_NEAR` 0.1 s) of an existing chapter (`chapter-near`), or `!chapterInVideo` (`chapter-end`) |
| freeze | `freezeAtPlayhead(p, at + offset, {length, sound})` (`freezeEdit.ts:78-90`); the anchor snaps to that frame | refused: `cut`, `taken`, `frozen` or `full` (`MAX_FREEZES` 200); or the clipboard's `projectId` is another recording (`freeze-other-recording`) |

- The whole paste is **one `store.update`**.
- The pasted items become the selection: a group, or a single item if there is one.
- **Notices:**
  - "Pasted 6 items";
  - "Pasted 6 items at 0:52.0 (moved back so they fit)" when `P` was clamped;
  - "Pasted 4 of 6: 1 zoom is already there, 1 freeze frame is in a cut";
  - "… · 1 zoom was shortened to fit".
- **Empty clipboard:** "Nothing copied yet: select items and press Ctrl+C", naming the key that
  copies items for this user (`commandKeys`). When another command has taken Ctrl+C and Copy has
  no key, it reads 'Nothing copied yet: select items and run "Copy selected items" from the
  command palette' (`nothingCopiedNotice`).
- **Another project in the same window:** works. Positions are normalised, so text and shapes
  land in the same place. Freezes are skipped (they hold a frame of their own recording).

**Duplicate (`duplicateItems`, `Ctrl+D`)** pastes a fresh copy at `origin + max(reach − origin, 1)`,
with the same clamp and the same rules. `reach` is `origin + span`, or the end of a continue
freeze's still (the footage it holds the picture over, from `planOf`) when that is later, so the
copy is not refused as frozen. A pause freeze adds no footage: alone it is duplicated 1 s later.
It leaves the item clipboard untouched.
- The copies become the selection, so pressing it again builds a series.
- The Shapes panel's own Duplicate button keeps its same-time, offset-on-screen copy
  (`ShapesPanel.tsx:216-221`).

### 4.12 Copy look and paste look

**Copy look (`copyLook`, `Ctrl+Shift+C`)** needs **exactly one** selected item that has a look.
- It stores `{ cls, values, label }`: the values of its class's look fields (table §4.9.1), read
  in the crop view. The zoom level is the level as seen.
- Notice: "Copied the box look". The label is the item's name: "Box", "Arrow", "Blur", "Zoom",
  "Text", "Title card", "Spotlight", "Freeze frame".
- With a group selected: "Select one item to copy its look".
- On a chapter: "Chapters have no look to copy".
- With nothing selected: "Select an item to copy its look".

**Paste look (`pasteLook`, `Ctrl+Shift+V`)** works on a single item or a group, in one update.
- It applies the look's fields, in table order, to every selected item of the **same class**.
- A field that does not apply to a target is skipped there. For example, Filled on an arrow; and
  Line width is checked after Filled.
- Zoom levels go through `setZoomLevelInView`, so a crop is respected. Zooms that receive a look
  get `auto: false`.
- Items of other classes are left alone.
- **Notices:**
  - "Pasted the box look onto 3 shapes";
  - "… · 2 items are not shapes, left as they were";
  - "Nothing to paste the box look onto";
  - "Already has this look" (the same project comes back, so no undo step).
- With no look held: "Copy a look first: select one item and press Ctrl+Shift+C", naming the
  user's key for Copy look; without one: "… select one item and press its Copy look button"
  (`copyLookFirst`). The notice and the Selection view's disabled Paste look say the same.

**Look buttons (`LookButtons`)** go in the single-item sections: SelectedZoom, SelectedText,
SelectedTitle, SelectedShape, SelectedSpotlight and the freeze section.
- **Copy look** and **Paste look** run the commands.
- Paste look's tooltip names what is held: "Paste look (Text: Title style, 7 %) · Ctrl + Shift + V".
- Paste look is disabled for another class: "The copied look is for zooms".

Both clipboards last for the window's session and are separate from each other.

### 4.13 Existing commands on a group

Each of these runs one update and shows a notice with the count:
- **Zoom level keys `0`–`4`** (`setZoomLevelKey`, `Editor.tsx:481-492`).
  - With zooms in the group, the level goes on every selected zoom: "Zoom level 2× for 3 zooms".
  - A group without zooms: "No zoom is selected". The group stays.
- **`toggleFreezeSound`.** With freezes in the group, every selected freeze goes to the opposite
  of the anchor's sound (or of the first freeze's, when the anchor is not a freeze). Refusals at
  the edit's end are counted.
- **Delete.** §4.10.
- **Palette availability** counts the group:
  - `deleteSelection`, `zoomLevel*` and `toggleFreezeSound` (`Editor.tsx:926, 943, 959`);
  - the new commands (§6).
- **Other commands are unchanged.** Add commands select their new item, which clears the group.

### 4.14 Freeze frames, crop, snapping and automatic blocks

- **Freeze frames.** Limits and acceptance (§4.8), `removeFreeze` (§4.10), `freezeAtPlayhead`
  (§4.11), the look (§4.12). The pause hold block is drawn at `h.at` (`FreezeMarks.tsx:144`); the
  box reads the drawn block.
- **Crop.** Every spatial read and write goes through the view: `zoomInView`,
  `setZoomLevelInView`, `toCrop` and `fromCrop`, and `mappingFor` on the preview. Positions are
  stored in the full frame, so a paste does not depend on the crop. Opening the crop tool clears
  the selection (`Editor.tsx:657`). While it is open, the selection commands say "Close the crop
  tool first".
- **Snapping.** §4.8. Alt and `N` behave as for single drags.
- **Automatic blocks.**
  - Auto zooms can be grouped, keep their `.auto` stripes under the outline, and become yours
    (`auto: false`) when moved, edited or given a look, exactly as single edits do.
  - Regenerating auto zoom replaces the automatic ones, and `validGroup` drops them.
  - Pasted zooms are always yours.
  - Camera director layouts are not groupable (§3).

---

## 5. UI and copy

### 5.1 Timeline

**Selected members.**
- They get `.selected`, the existing white outline (`editor.css:1083-1092`, `freeze.css:39-43`).
- They also get `.in-group`, which adds a 10 px check badge in the top-right corner
  (`.in-group::after`), so selection is not shown by outline alone.
- The anchor also gets `.anchor`: a 1 px inner light ring.
- This applies to `.seg`, `.freeze-block`, `.freeze-mark` and `.chapter-flag`.
- `.auto` styling stays visible.

**Count chip.**
- `.tl-head` shows `<span class="tl-selcount" role="status" aria-live="polite">5 selected</span>`
  and a × button next to `SnapButton` (`Timeline.tsx:560`).
- The button has `aria-label="Clear selection (Esc)"` and title "Clear selection (Esc)".
- The chip is hidden below 2 items.

**Hint line** (`Timeline.tsx:557-559`). The line ellipsises, so the new phrase goes first:
"Ctrl+click to select several · Shift+drag to box-select · Click a track to move the playhead ·
Shift+drag on the clip to select a range · Double-click a track to add · Hold Alt while dragging
to place freely".

**Box.** `.tl-marquee`:
- a translucent `--accent-500` fill (opacity 0.12) with a 1 px `--accent-400` border;
- `pointer-events: none`;
- `z-index: 5`, the snap guide's layer, below the playhead (6);
- no transition, which respects reduced motion.

**Tooltips.**
- A member's title gains " · selected: drag to move all 5, Ctrl+click to leave it out".
- Every groupable block's title gains " · Ctrl+click to select several" when no group exists.

### 5.2 Inspector

**Rail.** A **Selection** button with a count badge sits first on the rail while a group exists.
It has `aria-pressed` reflecting `showGroup`, title "Selection (5 items)", and the existing
`check` icon of `EditorIcon`. The other tabs work as before.

**Body.** As §4.9.

**Focus.** A change that takes away the view or rail button holding the keyboard puts focus on
the open tab's rail button (`keepInspectorFocus`, `inspectorFocus.ts`): Delete or Ctrl+X with focus in
the Selection view (the key or its Delete button), Esc there, Ctrl+A or a list's "Select all" /
"Select them" from a list (the Selection view then opens, and its Selection button has the
keyboard), and a narrowing button or Leave out that leaves one item (that item's tab button).
Focus that stays on a control, or that was outside the Inspector, is left alone.

### 5.3 Preview

The hint pill while a group exists and the player is paused reads: "3 selected items on screen ·
Ctrl+click to add or remove". With no member on screen, no pill shows.

### 5.4 Single-item panels

The `LookButtons` row (§4.12) sits above the existing Delete button of each section.

### 5.5 Shortcuts dialog and palette

- **The four standard-key commands** (`selectAll`, `copyItems`, `cutItems`, `pasteItems`) show a
  fixed, non-removable chip with their standard key ("Ctrl + C"). Its title reads: "Standard key ·
  a shortcut you give another command takes it over". Extra shortcuts can still be added.
- **The palette** shows `commandKeys(keymap, id)`, which is the keymap's bindings followed by the
  standard key.

### 5.6 Notices

Every notice goes through `showNotice` into the Transport's polite live region
(`Transport.tsx:61-62`):

- **Selecting:**
  - "Selected all 12 text items · Ctrl+A again selects every item"
  - "Selected every item (24)"
  - "No items to select yet"
- **Refusals:**
  - "Camera layouts are changed one at a time; the director's tools redo many at once"
  - "Captions are edited one at a time, or all at once in the Captions tab"
  - "Clips and cuts are selected one at a time"
  - "Recorded clicks are ignored one at a time, or with Find stray clicks"
- **Moving:**
  - "The selection stops here: a zoom is in the way" (variants in §4.8)
  - "Moved 0.6 s later: a zoom is in the way"
- **Delete, cut, copy, paste:**
  - "Deleted 5 items · Ctrl+Z to undo" / "Cut 5 items · Ctrl+Z to undo"
  - "Copied 4 items" / "Select items to copy"
  - "Pasted 6 items" / "Pasted 6 items at 0:52.0 (moved back so they fit)" / "Pasted 4 of 6: 1 zoom is already there, 1 freeze frame is in a cut"
  - "Nothing copied yet: select items and press Ctrl+C" (the user's key, §4.11)
  - "Duplicated 3 items"
- **Looks:**
  - "Copied the box look" / "Select one item to copy its look"
  - "Pasted the box look onto 3 shapes · 2 items are not shapes, left as they were" / "Already has this look"
- **Existing commands on a group:**
  - "Zoom level 2× for 3 zooms" / "No zoom is selected"
  - "To cut part of the recording, press Delete"
  - "Close the crop tool first"

Plurals use the existing `plural` helper style. Kind words, singular / plural:
- zoom / zooms;
- text item / text items;
- shape / shapes (mark and privacy);
- spotlight / spotlights;
- title card / title cards;
- chapter / chapters;
- freeze frame / freeze frames.

### 5.7 Keyboard access

A full keyboard path:
1. "Open Text settings" in the palette (with no track used yet, the open tab decides what
   `Ctrl+A` selects).
2. `Ctrl+A` selects the tab's items, and `Ctrl+A` again selects every item.
3. Tab into the Selection view.
   - **Selected items › Leave out** removes items one by one.
   - With a group, the panels' lists add items with `Ctrl+Space` / `Ctrl+Enter` and extend with
     `Shift+Enter`.
   - Every control is a native button, range, checkbox or number input with a label.
4. `Delete`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V` and `Ctrl+D`; `Ctrl+Shift+C` and `Ctrl+Shift+V`; ±1 s
   or a typed start.
5. `Esc` clears.

Matched commands call `preventDefault`, so Ctrl+A never selects page text. `body` also has
`user-select: none` (`styles.css:180`).

---

## 6. Commands and keys

Seven commands go in `COMMAND_LIST`, category `Edit`, **after `toggleFreezeSound`**
(`commands.ts:61`). That position keeps `after('smartSpeed') === 'polish'` and the other order
assertions in `editingWinsContracts.test.ts:348-355`. None has `inText`, `repeat`, `toggle` or
`hidden`. The `keywords` include "multi several group many".

| id | Title | Keywords (in addition) | Default key | Binding |
|---|---|---|---|---|
| `selectAll` | Select all items on the track (again: every item) | select all track box | `Ctrl+A` | standard key |
| `copyItems` | Copy selected items | clipboard duplicate | `Ctrl+C` | standard key |
| `cutItems` | Cut selected items | clipboard remove move | `Ctrl+X` | standard key |
| `pasteItems` | Paste items at playhead | clipboard insert | `Ctrl+V` | standard key |
| `duplicateItems` | Duplicate selected items | copy clone repeat series | `Ctrl+D` | `DEFAULT_KEYMAP` |
| `copyLook` | Copy look of the selected item | style format painter appearance | `Ctrl+Shift+C` | `DEFAULT_KEYMAP` |
| `pasteLook` | Paste look onto selected items | style format painter appearance apply | `Ctrl+Shift+V` | `DEFAULT_KEYMAP` |

**Standard keys** (new in `shortcuts.ts`):

```ts
/** Edit keys every Windows user knows; matched only when the keymap has nothing for the chord. */
export const STANDARD_EDIT_KEYS: Readonly<Record<'Ctrl+A' | 'Ctrl+C' | 'Ctrl+X' | 'Ctrl+V', CommandId>> =
  { 'Ctrl+A': 'selectAll', 'Ctrl+C': 'copyItems', 'Ctrl+X': 'cutItems', 'Ctrl+V': 'pasteItems' }
/** The standard command of a chord: exact match only (Ctrl+Shift+C is never Ctrl+C). */
export function standardEditCommand(chord: Chord): CommandId | null
/** A command's keys for labels: its keymap bindings, then its standard key (if any). */
export function commandKeys(keymap: Keymap, id: CommandId): string[]
```

**In `Editor.tsx`'s keydown handler**, just before `if (!chord || !id) return` (`Editor.tsx:1041`):
`const run = id ?? (chord ? standardEditCommand(chord) : null)`.
- The standard key runs only when the keymap has no command for that chord. So a user who binds
  `Ctrl+C` to another command takes the key over.
- All four call `preventDefault` and run, with one exception: `Ctrl+C` and `Ctrl+X` are left
  alone when page text is selected (`const s = window.getSelection(); s && !s.isCollapsed`), so
  text in a `user-select: text` hint can still be copied.
- A command with nothing to act on shows its notice (§5.6), for example "Select items to copy" or
  "Nothing copied yet: select items and press Ctrl+C".
- None of them runs in text fields (D4) or behind the export dialog or the palette (the existing
  early returns).

**The other three keys:**
- Checked against `DEFAULT_KEYMAP` (`shortcuts.ts:28-67`) and `RESERVED`: none is bound or
  reserved. `findConflicts(DEFAULT_KEYMAP)` stays empty.
- `matchShortcut(Ctrl+Shift+C)` returns `copyLook` (exact), not a Shift fallback.
- Electron's default menu on Windows has no `Ctrl+D`, `Ctrl+Shift+C` or `Ctrl+Shift+V`. Its
  paste-and-match-style role exists only on macOS.

**`README.md` "Editor shortcuts"** gains these rows. `tests/shortcutsReadme.test.ts` requires
every `DEFAULT_KEYMAP` binding to be named.
- `` `Ctrl`+click / `Shift`+click `` | Select several items / a run of items on one track
- `` `Shift`+drag on a track `` | Select the items in a box (`Ctrl`+drag adds to the selection)
- `` `Ctrl+A` `` | Select all items on the track you last used (again: every item)
- `` `Ctrl+C` / `Ctrl+X` / `Ctrl+V` `` | Copy / cut / paste items (pasted at the playhead)
- `` `Ctrl+D` `` | Duplicate the selected items right after themselves
- `` `Ctrl+Shift+C` / `Ctrl+Shift+V` `` | Copy one item's look / paste it onto the selected items

**Existing rows to edit:**
- the `Delete` row adds ", or every selected item";
- the `Esc` row stays as it is.

---

## 7. Undo

| Action | Store calls | Merge key |
|---|---|---|
| Group drag | `beginGesture`; one `update` per move; `endGesture` | `group-move:<n>` |
| Slider field | `holdGesture`; `update` per change | `group-field:<fieldId>:<stamp>` |
| Chips, toggle, Use zoom style, Length, Starts at, ±1 s | one `update` | none: each is its own step (a keyed update would merge with the next one inside the 800 ms window, `src/shared/engine/history.ts:31-42`) |
| Colour dots | one `update`; a held colour picker merges | the existing `mergeKey` pattern, `group-color:<fieldId>:<stamp>` |
| Delete, Cut, Paste, Duplicate, Paste look, zoom level keys, freeze sound | one `update` | none |
| Copy, Copy look, selecting | no project change | n/a |

An update that changes nothing returns the same project and adds no step (`editStore.ts:51-63`).
`<stamp>` is `ItemGroup.stamp`, which goes up on every selection change. So two edits of the
same field on different groups never merge.

---

## 8. Data model

**Project data: no change.**
- `src/shared/types.ts`, `migrateProject`, the sanitisers, the compositor, the exporter and
  `project.json` are untouched.
- Projects made before E-06 open, preview and export byte for byte as before.
- Pasted and duplicated items are ordinary items with fresh ids, in the shape the editor's create
  functions give, so the loaders' sanitisers read them unchanged.

**Selection state** (renderer, `Editor.tsx` next to `rawSelection`, `Editor.tsx:258`):

```ts
// src/shared/editor/multiSelect.ts
export const GROUP_KINDS = ['zoom', 'annotation', 'shape', 'spotlight', 'title', 'chapter', 'freeze'] as const
export type GroupKind = (typeof GROUP_KINDS)[number]
export type ItemKey = `${GroupKind}:${string}`          // = snapping owner key = selectionKey()
export interface ItemGroup {
  readonly keys: readonly ItemKey[]   // unique, in the order selected; never exactly 1
  readonly anchor: ItemKey | null     // Shift+click start, Ctrl+A track
  readonly stamp: number              // +1 on every group change: undo merge keys
}
export const NO_GROUP: ItemGroup = Object.freeze({ keys: [], anchor: null, stamp: 0 })
```

In Editor:

```ts
const [rawGroup, setRawGroup] = useState<ItemGroup>(NO_GROUP)
const g0 = validGroup(rawGroup, project)        // NO_GROUP: O(1); else O(n + k), same object when nothing dropped
const selection = g0.keys.length === 1 ? selectionOfKey(g0.keys[0]) : validSelection(rawSelection, project)
const group = g0.keys.length >= 2 ? g0 : NO_GROUP
```

There are only two writers:
- `setSelection(sel)`, which also sets `rawGroup = NO_GROUP`;
- `selectKeys(keys, anchor, opts?: { reveal?: boolean })`:
  - 0 keys → `setSelection(null)`;
  - 1 key → `setSelection(selectionOfKey(k))`, which bumps `revealSeq` as today; with
    `reveal === false` it sets the selection without the bump;
  - 2 or more → `setRawSelection(null)` and `setRawGroup({ keys, anchor, stamp: stamp + 1 })`,
    and `groupReveal + 1` unless `reveal === false`.

`latest.current` gains `group`, so the stable command handlers read it.

**Clipboards** (`src/renderer/src/editor/itemClipboard.ts`, module-level, never persisted):

```ts
export type ClipItem =
  | { kind: 'zoom'; item: ZoomSegment } | { kind: 'annotation'; item: Annotation } | { kind: 'shape'; item: Shape }
  | { kind: 'spotlight'; item: Spotlight } | { kind: 'title'; item: TitleCard } | { kind: 'chapter'; item: Chapter }
  | { kind: 'freeze'; item: Freeze }
export interface ItemClipboard { version: 1; projectId: string; origin: number; span: number; items: readonly ClipItem[] }
export type LookClass = 'zoom' | 'text' | 'mark' | 'privacy' | 'spotlight' | 'title' | 'freeze'
export interface Look { cls: LookClass; values: Readonly<Record<string, unknown>>; label: string }
```

`ItemClipboard`, `ClipItem`, `LookClass` and `Look` are declared in the shared modules
(`groupClipboard.ts`, `groupEdit.ts`). The renderer file only holds the values.

**Preferences:** none. No `PrefKey` and no localStorage key are added.

---

## 9. Contracts: files and exported signatures

### 9.1 New pure modules (`src/shared/editor`, unit-tested in node)

**`multiSelect.ts`**

```ts
export type ItemTrack = 'zoom' | 'text' | 'shapes' | 'titles' | 'chapters' | 'freezes'
export interface ItemEntry { key: ItemKey; kind: GroupKind; id: string; track: ItemTrack; start: number; end: number } // points: start === end (freeze: at)
export const itemKey: (kind: GroupKind, id: string) => ItemKey
export function parseItemKey(key: string): { kind: GroupKind; id: string } | null
export const isGroupKind: (k: string) => k is GroupKind
export const trackOfKind: (k: GroupKind) => ItemTrack     // annotation→text, shape|spotlight→shapes, title→titles, chapter→chapters, freeze→freezes
export function projectItems(p: Project): ItemEntry[]     // every groupable item, sorted by start, end, key
export function validGroup(g: ItemGroup, p: Project): ItemGroup
export function toggleKey(keys: readonly ItemKey[], single: ItemKey | null, key: ItemKey): { keys: ItemKey[]; anchor: ItemKey | null }
export function extendTo(keys: readonly ItemKey[], anchor: ItemKey | null, single: ItemKey | null, key: ItemKey, items: readonly ItemEntry[]): { keys: ItemKey[]; anchor: ItemKey | null }
export function unionKeys(base: readonly ItemKey[], add: Iterable<ItemKey>): ItemKey[]
export function trackKeys(items: readonly ItemEntry[], track: ItemTrack): ItemKey[]
export function selectAllStep(items: readonly ItemEntry[], selected: readonly ItemKey[], track: ItemTrack | null): { keys: ItemKey[]; scope: 'track' | 'all' | 'none' }
export interface KeyRect { key: ItemKey; x: number; y: number; w: number; h: number }
export function rectsHit(rects: readonly KeyRect[], box: { x0: number; y0: number; x1: number; y1: number }): ItemKey[]  // intersect, deduped
export function topmostHit(boxes: readonly KeyRect[], x: number, y: number): ItemKey | null   // boxes in draw order, topmost first
export function groupLabel(keys: readonly ItemKey[]): string   // "3 zooms · 2 text items"
export function kindCounts(keys: readonly ItemKey[]): Partial<Record<GroupKind, number>>
```

**`groupMove.ts`**

```ts
export type StopReason = 'start' | 'end' | 'zoom' | 'freeze-clip' | 'freeze-in-cut' | 'freeze-taken' | 'full'
export interface GroupMovePlan {
  keys: readonly ItemKey[]
  initial: ReadonlyMap<ItemKey, { start: number; end: number }>
  min: number; max: number                           // min <= 0 <= max
  minWhy: StopReason | null; maxWhy: StopReason | null
  span: { start: number; end: number }
  freezes: readonly string[]                         // ids, in anchor order
}
export function groupMovePlan(p: Project, keys: readonly ItemKey[]): GroupMovePlan
export function groupAccepts(p: Project, plan: GroupMovePlan, delta: number): boolean
export function moveGroup(p: Project, plan: GroupMovePlan, delta: number, exact?: { from: number; to: number } | null): Project // same p when nothing changes
export function groupSnapPoints(plan: GroupMovePlan, grabbed: ItemKey): number[]   // grabbed start/end first, then outer start/end, deduped
export function setGroupStart(p: Project, keys: readonly ItemKey[], t: number): { project: Project; moved: number; stopped: StopReason | null }
export function setGroupLength(p: Project, keys: readonly ItemKey[], length: number): { project: Project; clamped: number }
```

**`groupEdit.ts`**

```ts
export type LookClass = 'zoom' | 'text' | 'mark' | 'privacy' | 'spotlight' | 'title' | 'freeze'
export interface FieldCtx { crop: NormRect | null; cursorValid: boolean; style: ZoomStyle; background: Background; focusFor?: (z: ZoomSegment) => { x: number; y: number } }
export type FieldControl =
  | { type: 'slider'; min: number; max: number; step: number; format: (v: number) => string }
  | { type: 'chips'; options: readonly { value: string | number; label: string; title?: string }[] }
  | { type: 'toggle' } | { type: 'color'; presets: readonly string[] } | { type: 'action'; label: string }
export interface GroupField {
  id: string; cls: LookClass; label: string; control: FieldControl; look: boolean
  applies(item: unknown, p: Project): boolean
  read(item: unknown, p: Project, ctx: FieldCtx): unknown
  eq?(a: unknown, b: unknown): boolean
  write: { item(item: unknown, v: unknown, ctx: FieldCtx): unknown } | { project(p: Project, id: string, v: unknown, ctx: FieldCtx): Project }
}
export const GROUP_FIELDS: readonly GroupField[]
export function lookClassOf(p: Project, key: ItemKey): LookClass | null
export function fieldsFor(p: Project, keys: readonly ItemKey[]): { cls: LookClass; keys: ItemKey[]; fields: { field: GroupField; targets: ItemKey[] }[] }[]
export type Shared<V> = { mixed: false; value: V } | { mixed: true; value: V }   // value: the first target's
export function sharedValue<V>(values: readonly V[], eq?: (a: V, b: V) => boolean): Shared<V> | null  // null for []
export function mapItems(p: Project, kind: GroupKind, ids: ReadonlySet<string>, fn: (item: any) => any): Project
export function applyField(p: Project, field: GroupField, keys: readonly ItemKey[], v: unknown, ctx: FieldCtx): { project: Project; applied: number; refused: number }
export function deleteItems(p: Project, keys: readonly ItemKey[]): Project
export function copyLook(p: Project, key: ItemKey, ctx: FieldCtx): Look | null
export function pasteLook(p: Project, keys: readonly ItemKey[], look: Look, ctx: FieldCtx): { project: Project; applied: number; other: number }
export function lookLabel(look: Look): string           // "Text: Title style, 7 %"
```

**`groupClipboard.ts`**

```ts
export type PasteSkip = 'outside' | 'zoom-taken' | 'chapter-near' | 'chapter-end' | 'freeze-cut' | 'freeze-taken' | 'freeze-frozen' | 'freeze-full' | 'freeze-other-recording'
export interface PasteResult { project: Project; keys: ItemKey[]; at: number; movedBack: boolean; shortened: number; skipped: { kind: GroupKind; why: PasteSkip }[] }
export function copyItems(p: Project, keys: readonly ItemKey[]): ItemClipboard | null
export function pasteItems(p: Project, clip: ItemClipboard, playhead: number): PasteResult
export function duplicateItems(p: Project, keys: readonly ItemKey[]): PasteResult
export function pasteNotice(r: PasteResult, total: number): string
export const DUPLICATE_MIN_OFFSET = 1
```

### 9.2 Additive changes to shared files

- **`snapping.ts`**: one new export. Existing exports are unchanged.
  ```ts
  export function snapGroup(index: SnapIndex, points: readonly number[], dt: number, view: SnapView,
    clamp: (d: number) => number, accept?: (d: number) => boolean): { delta: number; target: SnapTarget | null; exact: { from: number; to: number } | null }
  ```
  It runs `snapPoints` on `points.map(x => x + dt)` with no limit. With a target `T` caught by
  point `i`:
  - `d = clamp(dt + r.delta)`;
  - if `|points[i] + d − T| > SNAP.exactS`, or `accept && !accept(d)`, it returns
    `{ delta: clamp(dt), target: null, exact: null }`;
  - otherwise `{ delta: d, target, exact: { from: points[i], to: T } }`.
- **`shapes.ts`**: `export const newShapeId = (): string => newId('s')` and
  `export const newSpotlightId = (): string => newId('l')`. The private `newId` is at `shapes.ts:53-54`.
- **`titles.ts`**: `export const newTitleId = (): string => newId('c')`. The private `newId` is at
  `titles.ts:40-41`.
- **`commands.ts`**: the seven entries in §6.
- **`shortcuts.ts`**:
  - three `DEFAULT_KEYMAP` entries;
  - `STANDARD_EDIT_KEYS`, `standardEditCommand` and `commandKeys`;
  - `RESERVED` and `matchShortcut` are unchanged.

### 9.3 New renderer files

- **`editor/groupContext.ts`**
  ```ts
  export interface GroupApi {
    readonly group: ItemGroup                  // NO_GROUP below two items
    readonly keys: ReadonlySet<string>         // stable while the group is unchanged
    readonly single: ItemKey | null            // the single selection's key when groupable
    select(keys: readonly ItemKey[], anchor: ItemKey | null, opts?: { reveal?: boolean }): void  // = Editor's selectKeys
    notice(message: string): void
  }
  export const GroupContext: React.Context<GroupApi>   // default: empty, no-op select/notice (today's behaviour)
  export function useGroup(): GroupApi
  ```
- **`editor/multiSelectControl.ts`**. The Timeline's gesture controller. It has a stable
  identity, built once with refs, like `useSnapController` (`snapControl.ts:200-206`).
  ```ts
  export type RefusedKind = 'clip' | 'click' | 'caption' | 'layout'
  export interface MultiSelect {
    has(key: string): boolean
    isAnchor(key: string): boolean
    /** First line of a groupable block's pointerdown: true when it took the press (toggle, extend, collapse, group drag). */
    press(e: ReactPointerEvent, key: ItemKey, mode: DragMode): boolean
    /** First line of a non-groupable press: true when a group exists, Ctrl is held, and it showed the notice. */
    refuse(e: ReactPointerEvent, what: RefusedKind): boolean
    /** First line of an empty-space handler: true when Shift or Ctrl started a box (or a modifier click that does nothing). */
    background(e: ReactPointerEvent, track: ItemTrack | null): boolean
    lastTrack(): ItemTrack | null
    /** True while a box is drawn or a press it took is held: the timeline's wheel waits (§4.3). */
    busy(): boolean
  }
  export function useMultiSelect(deps: { snap: SnapController; pxRef: RefObject<number>; dragging: MutableRefObject<boolean>; contentRef: RefObject<HTMLDivElement>; boxRef: RefObject<HTMLDivElement> }): MultiSelect
  ```
  It reads the group through `useGroup()` and the store through `useEditor()`.
- **`editor/itemClipboard.ts`**
  ```ts
  export const itemClipboard: { get(): ItemClipboard | null; set(c: ItemClipboard): void; subscribe(l: () => void): () => void }
  export const lookClipboard: { get(): Look | null; set(l: Look): void; subscribe(l: () => void): () => void }
  export function useLookClipboard(): Look | null      // useSyncExternalStore
  ```
- **`editor/mixedControls.tsx`**: `MixedSlider`, `MixedChips`, `MixedColorDots`, `MixedToggle`
  and `GroupTimeField` (§4.9.2).
- **`editor/LookButtons.tsx`**: `export function LookButtons({ itemKey }: { itemKey: ItemKey }): JSX.Element`.
- **`editor/panels/SelectionPanel.tsx`**:
  `export function SelectionPanel(props: InspectorProps & { onCommand: (id: CommandId) => void }): JSX.Element`.
  Its buttons run the same command handlers as the keys, so each action has one implementation.
- **`editor/inspectorFocus.ts`**: `export function keepInspectorFocus(): void`, called just
  before a change that can take away the Inspector view holding the keyboard (§5.2).
- **`editor/multiSelect.css`**: `.in-group`, `.anchor`, `.tl-marquee`, `.tl-selcount`,
  `.group-outline`, `.mixed`, and the Selection panel's rules.

### 9.4 Additive edits to existing renderer files

Insertions only. Every edit is a guard line, a prop or a class.

- **`selection.ts`**:
  ```ts
  export const selectionOfKey = (k: ItemKey): Selection
  export const groupKeyOf = (s: Selection): ItemKey | null
  ```
- **`snapControl.ts`**:
  - `SnapBegin.group?: readonly string[]` (`snapControl.ts:66-73`). At `begin`, segments and
    chapters whose owner key is in this Set are filtered out, and freezes go through
    `projectFreezeTargets(p, freezeExcludes)` (`snapControl.ts:114-124`).
  - `SnapSession.group(ev, points, dt, clamp, accept?): { delta: number; exact: … }`. It has the
    same gates and guide handling as `span` and `at` (`snapControl.ts:174-193`), and calls `snapGroup`.
- **`Timeline.tsx`**:
  - `TimelineHandle.lastTrack()` (`Timeline.tsx:59-63`, `277-285`);
  - `const multi = useMultiSelect({ … })` after `useSnapController` (`Timeline.tsx:174`);
  - the guard line `if (multi.press(e, itemKey(kind, id), dragMode(e))) return` after the
    `button` check in `onZoomDown`, `onAnnotationDown` and `onShapeDown`
    (`Timeline.tsx:426-428, 450-452, 473-475`);
  - `if (multi.background(e, track)) return` in `onBackgroundDown` (`Timeline.tsx:511`);
  - `if (multi.refuse(e, 'clip')) return` at the top of `onClipTrackDown` (`Timeline.tsx:353`);
  - `if (multi.refuse(e, 'click')) return` in `onClickMarkerDown` (`Timeline.tsx:385`);
  - class expressions add `selected in-group anchor` for members (`Timeline.tsx:714, 750, 775`);
  - `multi={multi}` on the three track slots (`Timeline.tsx:794-796`) and on `<FreezeMarks>` (`Timeline.tsx:656`);
  - `<div className="tl-marquee" ref={boxRef} hidden />` next to `<SnapGuide>` (`Timeline.tsx:798`);
  - the count chip in `.tl-head` (`Timeline.tsx:560`) and the hint text (`Timeline.tsx:557-559`);
  - `if (multi.busy())` at the top of the wheel handler: no zoom or scroll during a box or group press (§4.3);
  - the clip-block, gap, waveform and click-marker render bodies are untouched.
- **`LayoutTrack.tsx`**:
  - `TrackSlotProps.multi?: MultiSelect` (`LayoutTrack.tsx:21-36`);
  - `multi?.background(e, null)` in `onBackgroundDown` (118);
  - `multi?.refuse(e, 'layout')` in `onSegmentDown` (141).
- **`TitleTrack.tsx`**:
  - `multi?.press` in `onTitleDown` (76-78) and `onChapterDown` (99-101, mode `'move'`);
  - `multi?.background(e, lane === 'title' ? 'titles' : 'chapters')` in `onBackgroundDown` (132);
  - member classes at 157 and 178.
- **`CaptionTrack.tsx`**:
  - `multi?.background(e, null)` in `onBackgroundDown` (39);
  - `multi?.refuse(e, 'caption')` in `onCaptionDown` (45).
- **`FreezeMarks.tsx`**:
  - `Props.multi?` (18-29);
  - `multi?.press(e, itemKey('freeze', f.id), 'move')` in `onBodyDown` after its Shift/Alt early
    return (103-104);
  - member classes at 140, 171 and 201.
- **`Inspector.tsx`**:
  - the local `showGroup` flag, set true when the new optional prop `groupReveal` changes (as
    `revealSeq` does for single selections, `Inspector.tsx:108-115`);
  - the Selection rail button;
  - `{showGroup && group.keys.length >= 2 ? <SelectionPanel … /> : …}` around the body
    (`Inspector.tsx:137-148`);
  - an optional `onCommand` prop.
- **`PreviewStage.tsx`**:
  - the Ctrl/Shift branch at the top of `onOverlayDown`, after the pick and crop branches (311-326);
  - `<GroupOutlines/>` inside `.preview-overlay` (353-357), as a new component at the end of this
    file, reusing the private `mappingFor` and `textWidth`;
  - the Ctrl/Meta early return in `AnnotationHandle.onDown` and the `ShapeEditor` drag start.
- **Panels** (one line per spot):
  - **TextPanel:**
    - the lists render below a selected text item or title card, each in its place (§4.7);
    - the text list rows (81-101);
    - the title list (161-182);
    - the chapter time buttons (382-395);
    - "Select all" in each header;
    - `<LookButtons>` in SelectedText and SelectedTitle.
  - **ShapesPanel:**
    - the list rows (121-146) and "Select all";
    - `<LookButtons>` in SelectedShape and SelectedSpotlight;
    - the private `ColorDots` (439) stays private: `MixedColorDots` is new (C13).
  - **ZoomPanel:**
    - `<LookButtons>` in SelectedZoom;
    - "Select them" in the Auto zoom aside (414).
  - **FreezeSection:** `<LookButtons>`.
- **`ShortcutsDialog.tsx`**: the fixed chip for standard keys in `ShortcutRow` (102-121).
- **`Editor.tsx`**:
  - the state, `groupReveal` and `selectKeys` (258-264);
  - `latest` (368-369);
  - the `GroupContext` provider around the editor body;
  - the group branches of `deleteSelection`, `setZoomLevelKey` and `toggleFreezeSound` (481-492, 532, 565-587);
  - the seven handlers in `commands`, a `Record<CommandId, …>` that the compiler requires (701-901);
  - the standard keys in `onKeyDown` (1041), and `keepInspectorFocus` before Esc clears;
  - palette `unavailable` entries and `commandKeys` for its shortcuts (922-974);
  - `onCommand` and `groupReveal` on `<Inspector>` (1171).
- **`README.md`**: §6.

### 9.5 Not touched

- `types.ts`, `src/shared/engine/**`, `src/shared/render/**`, `src/renderer/src/render/**`;
- `player.ts`, `exporter.ts`;
- `controls.tsx`, `CaptionsPanel.tsx`, `CameraPanel.tsx`, `DirectorSection.tsx`, `ClipPanel.tsx`
  (FreezeSection is its own file);
- `editStore.ts`, `history.ts`, `focus.ts`, `pointer.ts`;
- `src/main/**`, `src/preload/**`, and the recording and teleprompter files.

No test file is edited except to add new cases (§10).

### 9.6 Contracts commit (first)

1. The types and signatures above, with bodies that keep today's behaviour:
   - `validGroup` returns `NO_GROUP`;
   - `press`, `refuse` and `background` return false;
   - `GROUP_FIELDS` is `[]`;
   - pure functions return the same project or an empty result.
2. The seven commands, the three keymap entries, `STANDARD_EDIT_KEYS`, `standardEditCommand` and
   `commandKeys`, the README rows, and seven no-op handlers in `Editor.tsx`.
3. `tests/multiSelectContracts.test.ts`, which freezes the exported names, the command ids,
   titles and order, the keys, and `NO_GROUP`.

---

## 10. Test plan

### 10.1 Unit tests (vitest, `environment: 'node'`)

Each rule above has at least one case. Fixture `P20`: duration 20 s, clips `[0–8, 10–20]`.

**`tests/multiSelect.test.ts`**
- M1. For every `GroupKind`, `itemKey` equals the snapping owner (`projectSnapSegments`; `freeze:<id>`) and `selectionKey(selectionOfKey(k))`.
- M2. `toggleKey`:
  - a groupable single plus another item → 2 keys, and the anchor is the new key;
  - a non-groupable single (clip, caption, range) → the clicked key alone;
  - removing down to 1 → 1 key (the caller collapses it);
  - toggling the only key → `[]`;
  - removing the anchor → the anchor is the last remaining key.
- M3. `extendTo`:
  - same track: inclusive by start, then end, then key, with shapes and spotlights interleaved;
  - another track, or no anchor: adds only the clicked key;
  - never removes;
  - the anchor is unchanged.
- M4. `selectAllStep`:
  - the track when it is not all selected;
  - `all` when it is all selected, when the track is null, or when the track is empty;
  - `none` when the project has no groupable item;
  - `freezes` selects freezes.
- M5. `validGroup`:
  - the same object (`toBe`) when everything is valid;
  - drops keys of removed items;
  - collapses to 1 key;
  - the `NO_GROUP` fast path.
- M6. `projectItems` order is deterministic for equal starts.
- M7. `rectsHit`:
  - a touching edge counts;
  - a key with two pieces is returned once;
  - no hits → `[]`.
- M7b. `topmostHit` returns the first box containing the point.
- M8. `groupLabel`: "3 zooms · 2 text items" and "1 freeze frame".

**`tests/groupMove.test.ts`**
- G1. Text, shape and title members clamp at 0 and at `duration` exactly, with spacing kept (`toBe` on the edge items); the stop reasons are `start` and `end`.
- G2. Zooms:
  - an unselected zoom between two selected zooms bounds both directions;
  - an outside obstacle stops the group so that the moving edge equals the obstacle's edge exactly;
  - two touching selected zooms move together.
- G3. The interval contains 0 even for overlapping (corrupt) zooms.
- G4. Freezes:
  - an active freeze stays in its clip: in P20, a freeze at 5 → `max = 7.999 − 5`;
  - an end freeze → `[x, 0]`;
  - an inactive freeze → `[0, 0]` with `freeze-in-cut`.
- G5. `groupAccepts`:
  - refuses a delta that puts a selected freeze on an unselected freeze's frame (`FREEZE_EPS`);
  - accepts two selected freezes 1 s apart moved +1 s, by the ordering;
  - at 60 fps, anchors are frame starts in whole ms.
- G6. `moveGroup`:
  - delta 0 returns `p` (`toBe`);
  - `exact` writes the snapped edge as `T` (`toBe`), and its owner keeps its length;
  - zooms come out `auto: false` and keep `anchor`.
- G7. `groupSnapPoints` puts the grabbed item first and removes duplicates.
- G8. `setGroupStart`:
  - moves by `t − start`, clamped, with the reason;
  - a refused freeze delta gives no change and reason `freeze-taken`.
- G9. `setGroupLength`:
  - a zoom stops at the next zoom's start and at 0.6 s;
  - text at 0.3 s, a title at 0.5 s;
  - the clamped count;
  - zooms `auto: false`.
- G-PERF. 1000 selected among 2000 items: the plan plus 1000 `moveGroup` calls take under 250 ms
  (the same budget style as snapping test 22).

**`tests/snapping.test.ts`** (new cases only; existing cases unchanged)
- S1. `snapGroup` catches through the grabbed edge and through an outer edge.
- S2. On a tie, the grabbed point (lower index) wins.
- S3. It falls back unsnapped when the clamp moves the edge off `T`, and when `accept` refuses.
- S4. Hysteresis holds to 12 px; nothing outside the visible window catches.

**`tests/groupEdit.test.ts`**
- E1. `sharedValue`:
  - Mixed versus equal within 1e-6;
  - zoom level 1e-3;
  - colours in lower case;
  - `[]` → null.
- E2. `applyField` returns the same project when no value changes.
- E3. Zoom level:
  - through `setZoomLevelInView`, with a crop and for a region zoom;
  - `auto: false`.
- E4. Zoom focus Fixed keeps where each zoom looks (`focusFor`, the region's centre); Cursor sets `scale` to the shown level.
- E5. Mark shapes:
  - Filled applies only to rect and ellipse;
  - Line width is checked after Filled;
  - the colour presets switch to highlight colours when every target is a highlight.
- E6. Privacy kind only on blur and pixelate; a title's Colour only on solid cards.
- E7. Freeze sound `continue` is refused at the edit's end and counted; length goes through tenths.
- E8. One undo step: an `EditStore` applying `applyField` to 3 items gives one `undo()` that
  restores all three; slider-like updates with one key inside a gesture make one step.
- E9. `deleteItems`:
  - removes from all lists in one result;
  - drops the `freezes` key with the last freeze;
  - an empty key list returns `p`.
- E10. `copyLook` / `pasteLook`:
  - every class;
  - mark → privacy is not applied (counted as `other`);
  - a zoom's level, easing and transition are carried;
  - an identical look returns `p`;
  - zooms receiving a look become `auto: false`.

**`tests/groupClipboard.test.ts`**
- C1. Paste time:
  - clamped to `duration − span`, with `movedBack`;
  - a playhead in a cut pastes at the next kept frame (`displayTime`);
  - offsets keep relative times.
- C2. Ids are fresh and unique; the copy is deep (editing `p` afterwards does not change the clipboard).
- C3. Zooms:
  - a pasted zoom is `auto: false` with no `anchor`;
  - start inside a zoom → `zoom-taken`;
  - a 1.4 s gap for a 3 s zoom → shortened (counted);
  - a 0.8 s gap → skipped.
- C4. Chapters: within 0.1 s → `chapter-near`; past the video → `chapter-end`.
- C5. Freezes:
  - cut, taken, frozen and full (`MAX_FREEZES`) are each skipped with their reason;
  - a different `projectId` → `freeze-other-recording`.
- C6. Duplicate:
  - pastes at `origin + span`;
  - a single pause freeze lands 1 s later; a continue freeze lands at the end of its still;
  - a group of only chapters lands 1 s later;
  - repeated duplicates make a series.
- C7. Each paste and duplicate is one store update; the result's keys are the pasted items.
- C8. `pasteNotice` wording for full, partial, moved-back and shortened pastes.
- C9. A freeze is its frame, not its hold (P20):
  - duplicated near the end (18 s with a 2 s hold, a continue freeze at 17.5 s with 3 s, the last
    frame's hold at 20 s), it is never moved back over or before the original, and never into the
    middle of the video;
  - a copied 3 s freeze pastes at 19 s, where the playhead is (`span` 0);
  - a freeze at 6 s with a 3 s hold is duplicated at 7 s, before the cut at 8 s;
  - text 5–6 s plus a freeze at 6 s pastes at 17 s unchanged; the text alone still has to fit.

**`tests/multiSelectKeys.test.ts`**
- K1. The seven ids are in `PALETTE_COMMANDS` with their titles and category `Edit`, right after
  `toggleFreezeSound`. None is `inText`, `repeat`, `toggle` or `hidden`.
- K2. `DEFAULT_KEYMAP`:
  - `Ctrl+D` → `duplicateItems`, `Ctrl+Shift+C` → `copyLook`, `Ctrl+Shift+V` → `pasteLook`;
  - `findConflicts` is empty, and `checkShortcut` is ok for each;
  - plain `C` is still `cropRecording`.
- K3. `standardEditCommand`:
  - Ctrl+A/C/X/V → `selectAll`, `copyItems`, `cutItems`, `pasteItems`;
  - Ctrl+Shift+C → null (exact only);
  - Alt+Ctrl+C → null.
- K4. `matchShortcut(index(DEFAULT_KEYMAP), Ctrl+C)` is still null. The frozen assertion in
  `editingWinsContracts.test.ts` is untouched and passes.
- K5. `commandKeys(keymap, 'copyItems')` is `['Ctrl+C']`, and `['F9', 'Ctrl+C']` after binding F9.
  `withShortcut` uses the first.
- K6. Searches: "paste" finds "Paste items at playhead" first; "look" finds both look commands;
  "format painter" finds `copyLook`. The existing ranking tests stay green.

**`tests/multiSelectContracts.test.ts`**: §9.6.

### 10.2 End to end: `tests/e2e/multi-select.e2e.cjs` (Playwright under Xvfb)

**Helpers.** `h.tempHome`, `launch`, `run`, `sleep`, `assert`; `f.seedProject`, `openProject`
and `waitFor`; local copies of `openSeeded`, `xForTime`, `centerOf`, `dragHold` and `release`
from `snapping.e2e.cjs:13-60`; a `saved(pred)` poll of `project.json`.

**Seed.**
- 20 s, clips `[0–8, 10–20]` (a cut at 8–10);
- zooms `z1` [1,2], `z2` [4,5] (auto), `z3` [12,14];
- annotations `a1` [1,3] size 0.05, `a2` [6,7.5] size 0.08;
- shapes `s1` rect [2,4], `s2` arrow [2,4], `s3` blur [2,4];
- title `t1` [15,17];
- chapter `h1` at 6;
- freeze `f1` at 5 (pause, 2 s).

Snapping is off in setup (`localStorage editor-snapping = '0'`, as snapping.md §10) except in
scenario 9.

1. **Ctrl+click:** z1, then Ctrl+click z2 and a1.
   - 3 `.in-group` blocks;
   - `.tl-selcount` reads "3 selected";
   - the Selection view shows "3 items selected" with sections "Zooms (2)" and "Text (1)".
   - Ctrl+click a1 again → 2.
   - Esc → none, and the chip is hidden.
   - With z1, z2 and a1 selected again: Space twice (play, pause), a click on the ruler, `=` and
     `-` (timeline zoom), and a click on the Style tab each leave "3 selected" (risk 1).
   - From the Selection button, focus "Only text (1)" and press Enter → a1 alone, the Text tab
     edits it, and the keyboard is on the Text tab's rail button.
2. **Shift+click run:** click s1, Shift+click s3 → s1, s2, s3 selected (one track, by start).
3. **Group drag:** select z1, a1 and h1; drag z1's middle by +1 s of pixels.
   - Once saved, all three moved by the same delta (equal within 1e-9), and that delta is
     1 ± 0.05 s;
   - z1 `auto` false;
   - one Ctrl+Z restores all three, and Ctrl+Y redoes;
   - the playhead did not move.
4. **Block limit:** select z1 and z2, drag +30 s.
   - `z2.end === 12` (z3's start) exactly;
   - `z2.start − z1.start === 3`;
   - a notice contains "stops here".
5. **Freeze in a group:** select f1 and a2, drag +6 s.
   - `f1.at <= 7.999` (still in clip 0–8);
   - a2 moved by the same delta within one frame;
   - the notice names the freeze's clip.
6. **Box:**
   - Shift+drag from empty zoom-track space at 0.5 s down to the bottom edge of the shape track
     at 4.5 s → selects exactly z1, z2, a1, s1, s2 and s3 (the three shapes sit in three lanes);
   - captions, clips and clicks are never included;
   - `.tl-marquee` is hidden after release;
   - Ctrl+drag a second box over t1 adds t1 → 7;
   - Ctrl+wheel while a Ctrl+box is held does not change the timeline's scale;
   - a Shift+click without moving on empty space keeps the selection and does not move the playhead;
   - Esc during a box restores the previous selection.
7. **Ctrl+A and Delete:**
   - click z1, Ctrl+A → 3 zooms; Ctrl+A again → every item (11);
   - Esc, click z1, Ctrl+A, Delete → `zooms: []` in project.json;
   - one Ctrl+Z → 3 zooms back.
8. **Copy, cut, paste, duplicate:**
   - select a1 and s1, Ctrl+C, seek to 15 s, Ctrl+V → two new items starting at 15 s (a1's copy
     at 15, s1's at 16), new ids, and they are the selection;
   - one Ctrl+Z removes both;
   - Ctrl+D on z1 → a zoom at [2,3];
   - copy z1 and z2, seek to 12.5, Ctrl+V → the notice counts a zoom that is already there;
   - Ctrl+X on a2 → it is gone, and Ctrl+V at 0 s brings it back at 0;
   - Ctrl+V with focus in a text field pastes text, not items.
9. **Snapping on:** a group drag of a1 and s2 near the cut → the guide `data-kind="clip"` is
   visible; after release the snapped edge equals 8 or 10 exactly.
10. **Mixed and a group slider:** select a1 and a2.
    - The Size readout says "Mixed";
    - focus the slider and press ArrowRight 3 times → both sizes are equal;
    - one Ctrl+Z restores both originals.
11. **Look:**
    - select s1, set its colour to the 5th preset, Ctrl+Shift+C;
    - select s2 and s3 (Ctrl+click), Ctrl+Shift+V → s2's colour is s1's, s3 is unchanged, and the
      notice says "1 item is not…";
    - one undo;
    - the panel's "Paste look" button is disabled on t1 with "The copied look is for shapes".
12. **Preview:** pause at 2.5 s.
    - Ctrl+click s1's box on the preview, then Ctrl+click a1's text → 2 `[data-testid="group-outline"]`;
    - Ctrl+click on empty preview → the player is still paused;
    - a plain click on a1's outline → a single selection with `.annotation-handle`.
13. **Crop:** with a crop applied, the group zoom level 2× → each selected block's `data-scale` is 2.
    The same launch stores the user's keys with Ctrl+C on Copy look: with z1 and z3 selected,
    the Selection view's disabled Paste look says "… press Ctrl + C", and Ctrl+V with nothing
    copied names the palette's "Copy selected items".
14. **Keyboard only**, in a fresh launch with no timeline press. Every control is reached with
    Tab or Shift+Tab presses (checked against `document.activeElement`), never focused by the
    test:
    - palette "Open Text settings"; with nothing selected, Tab to a1's row, Ctrl+Space → a1's
      editor opens above the list and focus stays on the row; Tab → a2's row, Ctrl+Space → 2
      selected, focus still on the row, and no Selection view; Esc;
    - Ctrl+A → a1 and a2 selected, the Selection view is open, and its rail button has the keyboard;
    - Ctrl+A again → every item (11);
    - Tab to "Leave out" on z1's row, Enter → 10, and focus is on the next row's button;
    - Shift+Tab to the Shapes tab on the rail, Enter, Tab to s1's row, Ctrl+Space → s1 left
      out (9), and focus stays on the row;
    - Delete → 9 items gone; one Ctrl+Z → back; Esc → none;
    - Ctrl+A → the 3 shapes; Tab to "+1 s" in the Selection view, Ctrl+X → cut, and the keyboard
      is on the Shapes tab's rail button; one Ctrl+Z;
    - Tab to the list's "Select all", Enter → 3 selected with the keyboard on the Selection
      button; Esc → none, and the keyboard is on the Shapes tab's button. All without the mouse.
15. **Refusal:**
    - with 3 items selected, Ctrl+click a clip block → the notice "Clips and cuts are selected one
      at a time", and still 3 selected;
    - without a group, Ctrl+click a clip selects it, as today.
16. **Page text:** after Ctrl+A, `window.getSelection().toString() === ''`.
17. **Errors:** `ctx.logs` has no `[pageerror]` or `[console.error]`.

### 10.3 Regression

The whole e2e suite (`tests/e2e/run-all.cjs`). The suites most at risk:
- `editor.e2e` (Shift ranges, Delete, Ctrl+wheel, the 30-minute windowed timeline);
- `w3fix-timeline.e2e` (scrubbing on tracks without modifiers must be unchanged);
- `snapping`, `freeze`, `crop`, `shapes`, `titles`, `zoom`, `smart-zoom`;
- `commands.e2e` (shortcuts dialog rows, palette);
- `camera`, `camera-director`, `captions`, `audit-editor`, `waveform`.

**Tests already checked:**
- Every existing e2e Shift press is on the clip track: `editor.e2e.cjs:332`,
  `audit-editor.e2e.cjs:76`, `smart-zoom.e2e.cjs:510`, `waveform.e2e.cjs:131`.
- The only Ctrl presses are Ctrl+wheel (`editor.e2e.cjs:401`) and a shortcut-capture modifier
  (`commands.e2e.cjs:356`).

No test is skipped, disabled or weakened. If one fails, the implementation is fixed.

### 10.4 Verification

As editing-wins.md §5:
- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
- `npx vitest run --testTimeout=60000`
- `npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs multi-select.e2e editor.e2e snapping.e2e freeze.e2e w3fix-timeline.e2e commands.e2e`, then the whole suite.

### 10.5 Manual checks on Windows (not verifiable here)

- `Ctrl+A/C/X/V` with Electron's default Edit menu, with and without page text selected.
- `Ctrl+Shift+C/V` on AZERTY and Polish layouts.
- Shift+drag and Ctrl+drag boxes with a precision touchpad.
- Dragging a group of 500 items for smoothness.

---

## 11. Risks

1. **Two selection states drift apart.** Only two writers exist (`setSelection`, `selectKeys`),
   and the invariants live in the pure reducer. `validGroup` runs on every render. Every older
   `setSelection` call clears the group through the changed callback, so no call site is missed.
   - E2e checks that the group survives playback, a click on the ruler, the timeline zoom keys and
     a tab switch (§10.2 scenario 1).
   - Audit every `onSelect` and `setSelection` in an effect: `playheadItems`, `freezeItems`,
     `titleItems`, the panels. An effect calling them would clear a group unexpectedly.
2. **Electron's default menu.** `src/main` sets no `Menu`, so its Edit roles carry Ctrl+A/C/X/V.
   The editor's `preventDefault` on keydown is expected to stop the role, as Ctrl+Z already shows.
   When the editor does not call `preventDefault` (for example Ctrl+C with page text selected),
   the menu copies that text, which is intended. Needs one manual check (§10.5).
3. **Modifier presses change meaning on blocks and empty overlay space.**
   - Today Ctrl or Shift plus press selects and drags, or scrubs. Neither is documented.
   - The clip track keeps Shift/Alt ranges, and plain presses everywhere are unchanged.
   - Mitigation: the whole e2e suite (§10.3), and the hint line.
4. **Freeze frames make a group's moves stop early.** A freeze stays in its clip, a cut freeze
   pins the group, and a collision stops the block. Notices say which and how to get out. Anchors
   round to a frame (less than one frame of drift), as single freeze drags do.
5. **Auto zooms become edited** when moved or changed in a group: Ctrl+A plus a drag converts many
   at once. The Zooms section shows "5 automatic · 3 edited" with the hint, and one undo reverts it.
6. **Large groups.**
   - The plan is O(n log n) once per press; a move is O(n) plus one store update.
   - Snap exclusion uses a Set: `excluded()` is O(excludes) per target (`snapping.ts:180-181`)
     and would otherwise be O(n·k).
   - Membership changes during a box re-render the visible window only.
   - Guards: G-PERF, and the 30-minute timeline e2e.
7. **The standard keys depend on the keymap.** A user who binds `Ctrl+C` to another command loses
   copy-items on it. The fixed chip in the Shortcuts dialog says so, and the command stays in the
   palette.
8. **Merge conflicts** in `Editor.tsx`, `Timeline.tsx`, the tracks and `PreviewStage.tsx`, which
   are shared hot spots. Edits are guard lines and props at the named lines. E-09 (nudge) will
   act on the selection, so its spec should reuse `ItemGroup` and `moveGroup`.
9. **Tests that render panels with a mocked `useContext`** (`captionsPanel`, `directorSection`,
   `clipWaveform`, `polishDialog`, `captionsBadge`). This feature adds no `useContext` call to the
   components they render (CaptionsPanel, DirectorSection, ClipWaveform, PolishDialog are not
   touched). A builder who needs one there must check those mocks first.
10. **Preview outlines are approximate:**
    - text boxes are measured as `AnnotationHandle` does;
    - during a continue freeze an outline can sit away from the held picture (freeze-frame.md:715).

    They are for selecting, not for placing.
11. **The in-memory clipboard is lost when the window closes**, and items cannot be pasted into
    another app. That is deliberate (D3) and documented in the README row.
12. **No security surface is added.** There is no IPC, no file access and no system clipboard.
    Clipboard objects come only from the app's own code and are deep-copied. No CSP or guard
    changes.

---

## 12. Later (out of scope)

- Camera layouts in groups: Layout and Corner together, and moves that carry stay pieces and director cut-outs.
- Moving several items on the preview (text and shapes together), and members off screen.
- Outlines on every item while Ctrl or Shift is held over the preview.
- Relative "nudge while Mixed" buttons (Size ×1.1, level ±0.25×, …).
- Keeping the group while trimming one member's edge, and resizing every member by dragging an edge.
- Snapping every member's edges, not only the grabbed item's and the outer edges.
- Cursor-spotlight size and spotlight mode in the group panel.
- E-09: nudging the selection by frames with the arrow keys. `setGroupStart` and the limits are ready for it.
- Group operations for captions in the Captions tab.
- Focusable timeline blocks.
- A system clipboard format for items.
- A colour field for text items.

---

## 13. Build order

One workstream, on `feat/multi-select`, in this order. Each step is green before the next.

1. **Contracts** (§9.6), with `tests/multiSelectContracts.test.ts` and `tests/multiSelectKeys.test.ts`.
2. **`multiSelect.ts`** with M1–M8.
3. **`groupMove.ts` and `snapGroup`** with G1–G9, G-PERF and S1–S4.
4. **`groupEdit.ts` and `groupClipboard.ts`** with E1–E10 and C1–C8.
5. **Renderer selection:**
   - the Editor state, `GroupContext`, `selectKeys`;
   - `multiSelectControl` (press, refuse, background and box);
   - Timeline, tracks and FreezeMarks guard lines, classes and the count chip;
   - Esc and Ctrl+A.
6. **Group drag:** `SnapBegin.group` and `SnapSession.group`.
7. **Inspector:** the Selection view, `mixedControls`, the field table wiring, Timing.
8. **Commands:** delete, cut, copy, paste, duplicate, look, `LookButtons`, the zoom level keys and
   freeze sound on groups, palette availability, Shortcuts dialog chips.
9. **Preview** outlines and Ctrl/Shift toggling; the **list rows**, "Select all" and "Select them".
10. **`tests/e2e/multi-select.e2e.cjs`**, then the whole suite (§10.3–10.4).
11. **After the merge** (lead, one additive commit):
    - `docs/FEATURES.md` gets an Editor bullet;
    - `docs/ROADMAP.md` marks the E-06 row shipped;
    - `docs/IMPLEMENTATION.md` describes the selection model;
    - snapping.md §12 marks "outer edges of a group drag" done.

---

## 14. As built

Built on `feat/multi-select` in the order of §13 (screenshot: `docs/screenshots/multi-select.png`). Where the build differs from this spec, and why:

- **Steps 5 and 6 are one commit.** The timeline controller starts the group drag from the same
  press handler that toggles and extends, so the snapping session (`SnapBegin.group`,
  `SnapSession.group`) landed with it.
- **`toggleKey` takes the anchor** as an optional fourth argument. Without it, removing a key that
  is not the anchor could not keep the anchor (M2).
- **`extendTo` on another track** (or with no anchor) adds the clicked item and makes it the anchor,
  as Ctrl does, so the next Shift+click on that track runs from it. On the same track the anchor
  stays, as specified.
- **`GroupApi.command(id)`** is added: the look buttons and the Selection view run the editor's
  command handlers through the context instead of a prop threaded through every panel. The
  Inspector still takes the optional `onCommand` prop and passes it to `SelectionPanel`.
- **`GroupField` has two optional members**: `presets(targets)` (a shape colour offers the
  highlighter colours when every target is a highlighter, E5) and `onlyWhenAll` (a title card's
  Colour row shows only when every card is solid, E6).
- **More small exports**, all additive: `KIND_WORDS` and `countOf` (`multiSelect.ts`);
  `LOOK_CLASSES`, `LOOK_CLASS_WORDS`, `fieldValue` and `fieldItems` (`groupEdit.ts`); an optional
  verb for `pasteNotice` ("Duplicated 3 items"); `standardKeyOf` (`shortcuts.ts`, used by
  `commandKeys` and the Shortcuts dialog's fixed chip). The notices of §5.6 are in a new pure
  module, `multiSelectCopy.ts`, with their own tests. The list rows' Ctrl/Shift clicks and keys are
  in `renderer/editor/listSelect.ts`.
- **S1–S4 are in `tests/snapGroup.test.ts`**, a new file, so `tests/snapping.test.ts` is unchanged.
- **The preview treats Shift+click like Ctrl+click** (toggle): items on the preview have no track
  order to run along. A cursor spotlight's follow box still takes a Ctrl press for itself.
- **`TitleTrack` and `FreezeMarks` read the group with `useGroup()`**: `FreezeMarks` is memoised
  and must re-render when the group changes. Neither is rendered by a unit test with a mocked
  `useContext`.
- **The Shapes panel's list is its own component** (`ShapeList`): `tests/spotlightPanelCrop.test.ts`
  calls `ShapesPanel` and `SelectedSpotlight` as plain functions with only `useEditor` and
  `useKeymap` mocked, so those two may call no other hook (risk 9 also covers these, and
  `zoomPanelCrop.test.ts` for `ZoomPanel` and `SelectedZoom`). The group hooks live in
  `ShapeList`, `LookButtons` and the Zoom panel's Auto zoom section, which those tests do not call.
- **A freeze's length handle** with Ctrl held counts as the block's middle (C9); with Shift it
  still sets the length, as before.
- **The Selection view's Zoom level** has the preset chips above the slider, as the Zoom panel does.
- **A text block's tooltip stays its text**, without the " · Ctrl+click to select several" hint
  (§5.1): `editor.e2e` reads it as the item's text, and existing tests are not changed. The other
  blocks carry the hint.
- **The Text tab's lists stay below a selected text item or title card** (§4.7). The first build
  showed only the single editor there, so the first Ctrl+click or Ctrl+Space on a row from an
  empty selection replaced the list, and the next row could not be toggled.
- **Focus** (§5.2) moved from the Selection view's Delete button into `keepInspectorFocus`, called
  by the commands (Delete, Ctrl+X, Esc, Ctrl+A), the lists' "Select all" and the narrowing
  buttons; "Only <kind> (1)" now reveals its item, as Leave out does.
- **The wheel waits for a box or group press** (`MultiSelect.busy()`, §4.3).
- **Clipboard hints follow the keymap** (`copyLookFirst`, `nothingCopiedNotice` in
  `multiSelectCopy.ts`): they named Ctrl+Shift+C and Ctrl+C even when the user had moved them.
- **A freeze's extent is its frame** (C25, §4.11, C9). The first build ended a freeze at
  `at + length`, so a hold near the end or before a cut moved pastes and duplicates back, refused
  them, or added a hold in the middle of the video.
- **The e2e file** runs the 17 scenarios of §10.2 in five launches. Scenario 9 drags `a1` and `s2`
  until `a1`'s end meets the cut at 8: with the seed, the group's start would otherwise tie with
  the freeze frame at 5 at every whole-second delta.
