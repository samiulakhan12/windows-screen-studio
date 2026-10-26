# Build report: camera director, workstream A (pure director logic)

Branch `feat-w5-director-a`, from `89c45c0` (approved spec `docs/design/camera-director.md` and compiled contracts).

Files changed, all owned by workstream A:

- `src/shared/editor/directorTimeline.ts` (steps 5-9)
- `src/shared/editor/directorCorners.ts` (step 10)
- `src/shared/editor/cameraDirector.ts` (steps 2-4 and 11-14, Apply, Remove)
- `tests/directorTimeline.test.ts`, `tests/directorCorners.test.ts`, `tests/cameraDirector.test.ts` (new)

No frozen file was touched (`git diff 89c45c0` is empty for types.ts, engine/, layouts.ts, layoutCommands.ts, directorContracts.test.ts, audio/, render/, renderer/). Every frozen export keeps its signature, type and constant. The only API addition is two extra exports in `directorTimeline.ts` (see the decisions below).

## What was built, per spec step

| Step | Where | What |
|---|---|---|
| 2. Time base | `planDirector` | T = outputDuration(clips). Everything is planned in output seconds. Speech, user segments and events are mapped with `rangesToOutput` / `sourceToOutput`. The corner cost grid uses G = 0.1 s at (j + 0.5)·G, mapped incrementally through the clips. |
| 3. Base and classes | `planDirector` | base = `withoutDirected(layouts)`. Positions are corner-only segments; everything else is locked. Both are mapped to output. |
| 4. Speech | `planDirector` | S = rangesToOutput(speech.ranges). With no speech the note is `no-sound`. Under SPEECH.minTotal of speech the note is `no-speech` and speech is treated as null. Also notes `mixed-sound` (mix, not refined) and `transcript` (refined, or transcript source). |
| 5. Demo span | `demoSpan` | In-frame clicks of any button, keys, zoom-here marks, typing bursts, zooms over [start, end − zoomTransition], and cursor sweeps (moves >0.004 per sample, rests ≤0.25 s, ≥0.35 path within 2 s, from the sample before the move to its last moving sample). Events inside cuts are dropped. Cursor-derived events count only when `valid`; zooms and marks always count. |
| 6. Intro | `findIntro` | Ends 1 s before the first action. While still talking it snaps to the latest ≥0.25 s pause in [demo.start − 3, e], else it ends 0.5 s after the last words. Checks: ≥3 s long, first words by min(4, end − 1), ≥40% speech. Cut at the first locked range, keeping only the piece from 0. |
| 7. Outro | `findOutro` | Symmetric: starts 1.5 s after the last action, at a pause or 0.3 s before the next words; ≥3 s long, ≥40% speech; ends at T. Then MIN_DEMO is applied in `planTimeline`: drop the outro first, then the intro. |
| 8. Hidden parts | `findHidden` | Silences ≥ hideAfter. h0 and h1 follow the intro/outro, start/end and lag/lead rules. The result is ∩ within, keeping pieces ≥5 s. hideAfter 0 means never. |
| 9. Anti-flicker | `settleTimeline` | Bubble pieces shorter than 4 s next to a hidden part join it when they hold under 1.5 s of speech. Otherwise they grow to 4 s, taking time from the hidden neighbours; a neighbour that would drop under 5 s is shown instead. Pieces next to the intro or outro join it. Pieces between the user's segments stay. |
| 10. Corners | `cornerCosts`, `planCorners`, `cornerOrder` | Output size, `styleContentRect`, `cameraAt` with the focus path, `toOutput`. Points off the screen weigh 0. Padded bubble rectangles with linear falloff. Attention weights: cursor moving/resting × visibility factor, clicks ±0.75 s, typing at the anchor / last click / cursor, watermark +0.5/s. Dilation is max over [j − 10, j + 6]. Bins are 0.5 s from each stretch start, with a home bias. The minimum-stay search runs over states (corner, k ≤ 12), with moves of 3 or 4.5, entry and exit costs, ties to staying then cornerOrder(home), and the busy cap (λ doubled, up to 3 replans). |
| 11. States | `planDirector` | Runs are intro, outro, hidden and bubble(c). They are snapped onto position edges closer than 0.4 s, but never at 0, at T, at a locked edge, or across a locked range. The strip shows intro, outro, hidden, bubble(c) and yours. |
| 12. Writing | `planDirector`, `spliceDirected` | Layouts as specified, including a large camera taking the neighbouring bubble's corner. o → s uses the first kept frame at 0, the last kept end at T, and the next clip's start at a cut. Runs are clipped outside locked source ranges, even in cuts; bubble runs are also clipped outside positions. Pieces under 0.05 s are dropped. Cut-outs carry the position's corner. Position pieces under 0.4 s before or 0.8 s after join the cut-out. Id rules: P's id goes to its first remaining piece, else to its first cut-out. Touching autos that are alike are joined. A segment equal to one in the project now (within 1e-6) takes its id; fresh ids are made unique. |
| 13. withoutDirected | `withoutDirected` | Drops free autos. Joins each run of touching manual corner-only and cut-out segments in the same corner that holds a cut-out, keeping the id of its first manual piece, else of its first cut-out. Nothing else is merged. |
| 14. Plan outputs | `planDirector` | `parts` (with output and source times, ids and reasons), `diff`, `upToDate` (which also returns the project's own `layouts` array), `cameraShare`, `cameraShown` (kept source minus screen-only), `framingCap` (1.3 when camera-only, large or side-by-side overlaps the kept video), `kept`, `notes`, `strip`. Deterministic, with injectable ids. |
| Apply | `applyDirectorPlan` | Writes the layouts (the same array when unchanged). For a `framed` outcome with frameFace on, it writes zoom and crop unless they are within 0.05 zoom / 0.01 crop of the current ones. `framed` is the framing written now, else it is kept only while `framingIsDirectors`. Returns the same project when nothing changes. |
| Remove | `clearDirected` | `withoutDirected`; zoom and crop are removed only while the framing is still the director's; `director.framed` is dropped and the options stay. Returns the same project when there is nothing to remove. |

The corner costs are cached in a WeakMap on `track.samples`. The inner key covers the identities of cursorPath, focusPath, clicks and typing, plus clips, zooms, zoom style, aspect, padding, frame, source size, webcam size, cursorInVideo, cursor show/hide-when-idle, watermark position and validity. The cache keeps at most 8 entries per recording. The cursor and focus paths that `planDirector` builds when they are not passed in are cached per samples too.

## Decisions where the spec was contradictory or silent

1. **The anti-flicker rule also runs with camera positions as boundaries.** The hand-edit fixture says the 1 s left between a bubble block trimmed by hand (now a position) and the next hidden part "joins it". `TimelineInput` has no positions field, so `planTimeline` cannot see them. Fix: the rule is a function, `settleTimeline(plan, speech, total, splits)`. `planTimeline` calls it without splits, and `planDirector` calls it again with the positions' edges as splits. This also covers the "sliver" case.
2. **Two exports were added to `directorTimeline.ts`: `settleTimeline` and `subtract`** (range difference). `cameraDirector.ts` needs both. Existing exports are unchanged.
3. **The start of the video counts as the bubble being visible at home.** If a stretch starting at output 0 used the 0.4 "appears" cost, F3a and the no-sound fixture would both put the bubble in bottom-left from frame 0. The spec expects a move at 8.5-9.5 s and "from about 7.5 s". So `planDirector` gives such a stretch `entry: home, enterVisible: true`, and the F3a, F3b, F3e and watermark unit tests use that stretch. With this rule both fixtures come out as specified (the no-sound move is at 7.5 s).
4. **When the cursor is in the video pixels, it is measured at the raw position** (`capture.cursorInVideo`), not at the smoothed path. The raw position is where the viewer sees it. Otherwise the drawn smooth cursor is used, as specified.
5. **"Lies in the window" for snapping into a pause** means the gap clipped to the window is at least 0.25 s; the pause point is its middle. This gives F2's intro [0, 8.0].
6. **"Joined to its neighbour of the same layout"** for pieces under 0.05 s is implemented as dropping them. Joining a free sliver to a cut-out would put the cut-out outside its position and break the exact inverse. Inside a position, a cut-out sliver is given back to the position.
7. **Bubble-corner runs are never written inside a position**, including a position that sits in a cut. A `default` layout cannot be a cut-out (readLayouts drops `cutOut` on it). `spliceDirected` also skips the inside part of a `default` run.
8. **"Last seen" for the bubble's entry** also counts a position or cornered layout change of the user's after the previous free stretch, with `enterVisible: false`. Only a touching one makes it visible.
9. **Small fixture choices:**
   - The cuts-and-speed timeline test uses a 14 s source silence in the 2× clip, which is 7 s of output: hidden after 5 s, not after 10. The spec's clips {15, 30} cannot hold 20 s of source silence.
   - The MIN_SHOWN "grows to 4 s" case uses a 3.8 s gap with 2 s of speech; a 2 s gap cannot hold 2 s of speech plus the 1.0 / 0.8 s lag and lead.
   - The F3c "one move to top-right" starts from a visible bottom-right bubble.
10. **What "≥2.2 s apart" is measured on in the property test**: the strip items whose neighbours on both sides are director states (not `yours`).

## Tests (96 in the three new files, all passing)

**tests/directorTimeline.test.ts (34):**
- F2: demo {9, 45}; intro [0, 8.0]; outro [51.7, 60]; hidden [23.0, 51.7], and [8.0, 13.2] with hideAfter 5; Never; no speech; intro off.
- Intro rejections: first words at 5 s, under 40% speech, under 3 s. Pause snap. Locked cut. Outro dropped under MIN_DEMO. Outro snapped into a pause.
- Demo span: none; invalid track; out-of-frame clicks; sweep 8.0 → introEnd 6.5; no false sweeps; keys, typing and marks; zooms over [start, end − transition] including a custom transition; events in cuts.
- Hidden parts: from the intro and until the outro; from 0 and until T; outside locked ranges.
- MIN_SHOWN: absorbed; grown to 4 s; neighbour shown instead; joins the intro; left alone between the user's segments.
- Cuts and speed (three cases).

**tests/directorCorners.test.ts (19):**
- `cornerOrder`.
- F3a: one move to bottom-left at a bin start in [8.5, 9.5], never back; deterministic; watermark bottom-left never picked; cost cache and dilation window.
- F3b: a 1.0 s visit (dilated cost 2.60 measured) gives no move; a 2.0 s visit gives one move.
- F3c: exactly one move, to top-right.
- F3d: a position is kept and nothing is written inside it; exit move.
- F3e: four zoom-path cases.
- Busy cap: at most 4 moves in 120 s, every inner corner held ≥6 s.
- Short stretch stays in one corner; tie stays home; last-seen entry.

**tests/cameraDirector.test.ts (43):**
- F1 exactly (5 touching autos a1-a5; ramps: first in 0, last out 0, all ≤0.4), parts and reasons, strip, cameraShare 0.575, framingCap 1.3, cameraShown, diff; same result with the editor's paths.
- F4 exactly (cut-outs, `rec1` kept as [16.2, 24], `rec1b` id on the first cut-out, `m1` the same object). `withoutDirected` deep-equals the base, ids included; Remove gives the seed back; kept {1, 2}; strip.
- Sliver (a cut-out from the position's start); snap (the hidden start moves onto the position's end).
- Hand edit (the trimmed block is kept; hidden [22.0, 33.7]); Direct again is a no-op (upToDate, same ids, same project object); a deleted change comes back.
- No speech (bottom-left from 7.5 ± 0.5 s to 48); no-speech; mixed and transcript notes; cursor invalid (no-input, no-demo, hidden only); a zoom-only demo; camera hidden; nothing; all-yours.
- Settings: intro off, camera-large (bottom-left corner) and at home, hideAfter 0, corners keep, cap 1.6.
- Cuts and speed: camera-only [0, 15] and screen-only [15, 30], touching; nothing wholly inside a cut.
- Framing: write, off or other outcomes, near-keep, `framed` provenance, same object, `clearDirected` (both cases).
- `spliceDirected` joins and ids; `withoutDirected` on user-only lists.
- **Property test, 200 seeded projects**: random clips with cuts and speeds 0.25-8×, speech of each source or none, cursor walks, clicks, typing, keys, zooms, positions and locked segments, webcam, aspect, padding, cursor and watermark settings, director settings. Checked for each project:
  - sorted, no overlaps, inside the recording, unique ids;
  - `readLayouts(result)` equals the result;
  - every locked segment is intact, and `withoutDirected(result)` equals the base;
  - autos are ≥0.05 s with ramps ≤0.4 s;
  - intro and outro are ≥3 − 0.4 s and hidden parts ≥5 − 0.8 s of output;
  - director changes are ≥2.2 s apart, and the strip covers [0, T];
  - directing twice gives upToDate, an empty diff, and the same project object.

  It was also run once with 3,000 seeds in a scratch copy, all passing.
- **Performance**: 30-minute recording (60 Hz cursor, 360 clicks, a position): first plan **60 ms** (this builds the paths and the corner costs), re-plan with cached costs **11 ms**.

## Verification output

```
npm ci                                   ok
npm run typecheck                        ok (tsconfig.node.json and tsconfig.web.json, no errors)
npx vitest run --testTimeout=60000       Test Files 126 passed (126); Tests 1672 passed (1672)
npm run build                            ok (electron-vite build, built in 3.56s)
```

The existing camera, layout, zoom and directorContracts tests are unchanged and pass.

One bug was found by the property test during the build and fixed before commit: when a short bubble piece had only one hidden neighbour, `settleTimeline` compared `undefined === undefined` and crashed.
