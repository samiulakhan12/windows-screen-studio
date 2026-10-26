# Audio waveform on the timeline (E-04)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

Status: implemented (branch `w6-e04`). Roadmap item: `docs/ROADMAP.md` "Easier editing", E-04 (size S). Where the build differs from the first design, this document has been updated; the list is in [§13](#13-changes-made-while-building-it).

The clip track shows the recording's sound as a waveform. You can see where you talk and where the pauses are, so a Shift+drag range, a split or a trim lands in a pause and not in the middle of a word.

The feature draws only data the editor already measures. `src/main/audioAnalysis.ts` `analyzeAudio` reaches the renderer through `src/renderer/src/editor/audioAnalysis.ts` `loadAudioAnalysis`.

It changes nothing in `project.json`, the preview, the export or the undo history. It does not touch the recording side, which the teleprompter team owns.

---

## 1. What the user gets

- **A waveform in the clip track.** It is drawn inside the existing 40 px clip track (`.clip-track`, `editor.css`), at the same source-time x as every other track.
  - In cuts and trims it is drawn faded to 30% over their hatching.
  - Sped-up clips show the same shape, because the timeline is in source time (`Timeline.tsx` doc comment: "Source-time timeline").
- **Mic and system sound apart.** When the recording kept stems (`mic.m4a`, `system.m4a`), the microphone is drawn above the centre line in light lavender and the system sound below it in orange. With only the mixed track (`screen.mp4`), one shape is drawn, mirrored around the line.
- **Pauses are shaded darker.** These are stretches of at least 0.5 s where nothing is heard. They come from the same sound detector that Remove silences and music ducking use (`sourceActivity`).
- **Muted sound is grey.** A muted source, or a muted recording, is drawn grey instead of disappearing.
- **A palette toggle, "Audio waveform on the timeline".** It is on by default and remembered per user. It has no default key.
- **Empty and loading states.**
  - A recording without sound shows nothing.
  - While the sound is being measured, a faint centre line is shown.
  - If the sound cannot be read, the track looks as before and its tooltip says so.

## 2. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Where the levels come from | Reuse `analyzeAudio` through `loadAudioAnalysis`. `analyzeAudio` runs in the main process: ffmpeg decodes at 16 kHz into `LevelMeter`. There is no new ffmpeg pass. | It exists and is cached. Its header says an hour-long recording "costs a few seconds and constant memory". **Rejected:** WebAudio `decodeAudioData` in the renderer, which decodes the whole file to PCM in memory (1 h of 48 kHz stereo float32 is about 1.4 GB). **Rejected:** a second ffmpeg pass (`astats`, `showwavespic`), which decodes the same file twice. |
| 2 | What is drawn | The K-weighted mean-square power per 50 ms window (`AudioLevels`, `LEVEL_WINDOW = 0.05`, `loudness.ts`), shown in dB. | It is the envelope the silence detector reads, so what looks quiet is what is treated as silent. **Rejected:** sample min/max peaks. They need a new measurement and can disagree with the detector, for example on a click. |
| 3 | Resolution | 20 values per second, as stored. A column shows the peak of the windows it covers. When a column is narrower than half a window, heights are interpolated between window centres. | Syllables last 100–300 ms, so 50 ms is enough. At `MAX_PX_PER_SEC = 400` (`timelineScale.ts`) a window is 20 px, and interpolation avoids a staircase. |
| 4 | Cache | No new file. The main process keeps its in-memory cache (`cachedLevels`: 12 entries keyed `path\|size\|mtime`). The renderer keeps its module-level `Map` in `loadAudioAnalysis`, which lasts for the app session and drops failures. | Measuring is fast, and a file in the project folder would need its own invalidation. **Rejected:** `levels.bin` (see Later). **Rejected:** measuring at finalize, because `src/main/recording/**` is teleprompter-owned. |
| 5 | Placement | A `<canvas>` inside `.clip-track`. No new lane. | Cuts are made on the clip track (Shift+drag ranges, gap blocks, trim handles). **Rejected:** a separate audio lane. It adds track height and puts the waveform one track away from where you cut. |
| 6 | Time axis | Source time, like every track. Cut and trimmed stretches are faded to 30%, not removed. Speed does not change the shape. | Overlays stay in source time, so no clip mapping is needed. A faded waveform in a cut also shows what "Restore this cut" brings back. |
| 7 | Mic vs system | With both stems, the mic goes up from the centre line and the system sound goes down. With the mix only, or a single stem, one shape is mirrored. | Two colours overlaid in 40 px are hard to read, and two lanes go against decision 5. |
| 8 | Vertical scale | dB, linear over the 45 dB below a reference. The reference is the 99th-percentile power of the loudest source and is shared by all lanes. | A fixed dBFS scale makes quiet microphones look flat. Scaling each lane separately would make system hum look as loud as speech. |
| 9 | Volume, mute, normalisation | The shape ignores volume, normalisation and noise reduction. A lane whose gain is 0 is drawn grey. Gain is 0 when the source, the master or both are muted or at volume 0: the `trackGain` / `recordingMix` rule in `settings.ts`. | Volume changes how loud the sound is, not where the speech is. Grey shows the content while saying "not heard". |
| 10 | Pause shading | Pauses are the gaps, inside `[0, duration]` and at least `SILENCE_LENGTH.min` (0.5 s) long, of `sourceActivity(project, analysis)` (`shared/audio/soundtrack.ts`). That is the same activity (`activitySources` → `combineLevels` → `detectActivity`) that `ClipPanel` hands to `planSilences` and that the preview and export duck music under. | One detector. **It is not Remove silences' plan.** `findSilences` (`smartSpeed.ts`) measures a pause's length in output time (through cuts and speed), uses the panel's minimum (default 1 s), counts title cards as sound and takes padding off each end. The shading shows where the sound is quiet. The Silences list shows what will be cut. **Rejected:** following the Silences panel's minimum, which is `ClipPanel` component state. |
| 11 | Drawing | One canvas covering the timeline's render window `win`, redrawn in `useLayoutEffect` only when the levels, `px`, `win`, the clips, the lanes or the pauses change. | No per-frame or per-playhead work. This is the same rule as `placePlayhead`, which moves the playhead by transform without a React render. **Rejected:** SVG or DOM bars, which would be thousands of nodes at fit. |
| 12 | Show/hide | A per-user view preference in `localStorage['editor-waveform']`, on by default. Palette command `toggleWaveform`, no default key. | It is not part of the video, so there is no project field and no migration. `localStorage` already holds editor view state (`CommandPalette` `editor-recent-commands`, `ExportDialog` `readJson`/`writeJson`). **Rejected:** a `PrefKey` in `editor-prefs.json`. It only needs a line in `src/shared/api/prefs.ts` `PREF_KEYS`, but it is read asynchronously, so the first paint would flash, and the file is shared. |
| 13 | When to measure | After mount, in `requestIdleCallback` (timeout 1500 ms), and only while the waveform is shown. | It does not compete with the first decode. `analyzeAudio` already measures one source at a time. |

## 3. Data model

**No change to `src/shared/types.ts`, `project.json` or the sanitisers** (`src/shared/engine/project.ts` `migrateProject`). Old projects open and export byte-for-byte as before, because nothing they contain is read differently.

- **Inputs read (all existing).**
  - `Project.id`, `Project.hasAudio`, `Project.clips` and `Project.duration`.
  - `Project.audioStems`. When a stem file is missing, the editor's copy has no `audioStems` (`openedWithoutStems`), so the waveform falls back to the mix by itself.
  - `Project.audio`, through `audioLook`.
- **View preference.** `localStorage['editor-waveform']` is `'off'` when hidden (`'on'` once shown again). Anything else, a missing key or a storage error means shown. Every read and write is wrapped in try/catch, as in `CommandPalette.loadRecent` / `saveRecent`. A value storage refuses to keep is held in memory for the session, as `snapPref` does, so the toggle still works.
- **Style presets and "Save as default style"** do not carry it. It is a viewing preference, not a look of the video.

New pure module `src/shared/audio/waveform.ts`:

```ts
import { SILENCE_LENGTH } from '../editor/smartSpeed'
import type { AudioLevels } from './loudness'
import type { AudioSource } from './settings'
import type { Range } from './activity'
import type { Project } from '../types'

/** How one recorded source is drawn on the clip track. */
export interface WaveformLane {
  source: AudioSource            // 'mix' | 'mic' | 'system'
  /** 'both': mirrored around the centre line; 'up' (microphone) / 'down' (system) when both stems exist. */
  side: 'both' | 'up' | 'down'
  /** Not heard (its gain or the master gain is 0): drawn grey. */
  muted: boolean
}

export const WAVEFORM = {
  /** dB shown below the reference; quieter is drawn as a hairline. */
  rangeDb: 45,
  /** Reference level: this percentile of the heard windows of the loudest source. */
  percentile: 0.99,
  /** Shortest pause shaded, source seconds (the Silences slider's minimum). */
  minPause: SILENCE_LENGTH.min,
  /** Opacity the waveform keeps inside cuts and trims. */
  gapAlpha: 0.3,
  /** Half-height of the line drawn for silence and while loading, px. */
  hairline: 0.5
} as const
```

`smartSpeed.ts` imports only `../audio/activity`, so importing it here makes no cycle.

## 4. Algorithms and behaviour

**4.1 Which sources: `waveformLanes(project)`**

- `!hasAudio` → `[]`. Nothing is drawn and the command is unavailable.
- `stems = stemsOf(project)` (`settings.ts`). Both stems → `[{mic,'up'}, {system,'down'}]`. One stem → `[{thatStem,'both'}]`. None → `[{mix,'both'}]`.
- `muted`: let `look = audioLook(project.audio)`. A lane is muted when `look.muted || look.volume <= 0`, or, for a stem lane `k`, when `look[k].muted || look[k].volume <= 0`.
- The renderer requests `lanes.map(l => l.source)` with `loadAudioAnalysis(project.id, sources)`. This always includes `activitySources(project)`, because `activitySources` is the heard stems or `['mix']`. So `sourceActivity` has what it needs.

**4.2 Reference: `waveformRef(levels[])`**

- For each source, copy the powers above 1e-10 into a `Float64Array`. This is the same digital-silence cut-off as `activityThreshold`. The copy matters because `kthSmallest` reorders its input.
- Take `kthSmallest(heard, min(n − 1, floor(n · 0.99)))` (`activity.ts`, quickselect, linear).
- Return `powerDb` of the largest of these values across sources.
- When no source has a heard window, return `null` and draw a hairline. Muted lanes count too, because the shape ignores gain.

**4.3 Height: `waveformHeight(db, ref)`**

`clamp((db − (ref − 45)) / 45, 0, 1)`. With ref = −20 dB: −20 → 1, −42.5 → 0.5, −65 or −∞ → 0, −10 → 1.

**4.4 Columns: `waveformColumns(levels, ref, from, to, columns)`**

Column k covers `[from + k·d, from + (k+1)·d)`, with `d = (to − from)/columns` and `w = levels.window`.

- **When `d ≥ w/2`:** take the largest power over windows `i0 = floor(t0/w + 1e-9)` to `max(i0 + 1, ceil(t1/w − 1e-9)) − 1`, then apply `waveformHeight`. The epsilons matter because `1.5 / 0.05` is `30.000000000000004` in floating point. This keeps the peak per column, so a short word never disappears at fit.
- **Otherwise:** interpolate height linearly between the centres `(i + 0.5)·w` of the two windows around the column centre. Before the first centre or after the last, use the edge value.
- Windows at or past `power.length` (a source shorter than the video) and times below 0 have height 0.

Cost is O(columns + windows in range). At fit on a 1 h recording that is 72,000 windows into about 1,500 columns, well under 1 ms.

**4.5 Pauses: `pauseRanges(activity, duration, minLength = WAVEFORM.minPause)`**

- **Gaps kept.** The gaps of `mergeRanges(activity)`, clipped to `[0, duration]`, with length ≥ `minLength − 1e-9`, including a leading and a trailing gap.
- **Nothing heard.** If no activity is left inside `[0, duration]`, return `[]`, as `findSilences` does: "Nothing when nothing is heard at all". This also covers a muted recording, since `sourceActivity` returns `[]` when no source is heard.
- **Null activity.** If `sourceActivity` returns `null` (levels missing), no pauses are drawn.
- **Short gaps.** `detectActivity` already joins gaps shorter than `ACTIVITY.hold` (0.5 s), so the shaded bands are whole pauses.
- **Where they differ from Remove silences** (decision 10):
  - The bands are in source time and do not depend on cuts or speed.
  - A pause under a title card is shaded but kept by Remove silences.
  - A 0.8 s pause inside a 2× clip is shaded, but it lasts 0.4 s in the video, so Remove silences never offers it, even at its 0.5 s minimum.
  - Each silence Remove silences cuts lies inside a shaded band, once its padding is added back (tested in §10).
- **A heard stem decides.** If one stem is muted, `activitySources` leaves it out, so its grey shape may show sound inside a shaded band. That matches what Remove silences and ducking hear.
- **Memo key.** Computed in a `useMemo` keyed on `levels` and `activitySources(project).join(',')`, like `ClipPanel`'s `sourcesKey`. A volume-slider drag or a trim drag never recomputes it.

**4.6 Drawing (`ClipWaveform.tsx`, `draw()`)**

1. **Size.**
   - `cssW = (win.end − win.start)·px`, and `cssH` is `parentElement.clientHeight` (40).
   - The ratio is `r = min(devicePixelRatio, 16384 / cssW)`. The canvas gets `width = round(cssW·r)` and `height = round(cssH·r)`, and the context is scaled by `r`.
   - `win` is normally at most 6 viewports (`renderWindow` is 3, and `updateWindow` allows up to 2×). Right after a zoom there is one layout pass with the new `px` and the old `win`. `Timeline`'s own `useLayoutEffect` then calls `updateWindow`, which re-renders before paint. The cap keeps that transient draw under 16k columns.
2. **Position.**
   - The canvas sits at `left = win.start·px` inside `.clip-track`, which is the positioned parent of every block, with `pointer-events: none` and `z-index: 1`.
   - It comes in the DOM right after the clip-block `.map`.
   - It paints over the clip blocks and the gap blocks (`z-index: auto`), and over `.clip-block.selected` (z 1, earlier in the DOM).
   - It stays under `.path-bar` (z 1, later in the DOM), `.click-marker` (2), `.trim-handle` (3), `.range-sel` and `.gap-restore` (4), and `.playhead` (6).
3. **Pause bands.** For each pause that overlaps `win`, `fillRect` the full height, inset 1 px top and bottom, with `--wave-pause`.
4. **Lanes.** Columns = `canvas.width` (one per device pixel). The centre is `c = cssH/2` and the amplitude is `A = cssH/2 − 4`. Each lane is one filled polygon: the top contour left to right, then the bottom contour right to left.
   - `both`: `c ± max(h·A, 0.5)`.
   - `up`: from `c − max(h·A, 0.5)` to `c`.
   - `down`: from `c` to `c + max(h·A, 0.5)`.
   - Fill with `--wave-mix`, `--wave-mic` or `--wave-system`, or `--wave-muted` when the lane is muted.
5. **Cuts and trims.** For each gap from `timelineGaps(clips, duration)` (`shared/editor/clips.ts`) that overlaps `win`, set `globalCompositeOperation = 'destination-out'` and `fillRect` with an opaque fill at `globalAlpha = 1 − WAVEFORM.gapAlpha`. Then reset to `source-over`. The fill must be opaque: `destination-out` removes the fill's alpha times `globalAlpha`, so the last lane's colour (alpha 0.78) would leave 45% instead of 30%. The gap's hatching, painted below, shows through.
6. **Speed badges.** `.speed-badge` lives inside `.clip-block`. A selected block (`z-index: 1`) and a hovered block (`filter: brightness`) are stacking contexts, so no z-index on the badge can lift it above the canvas. Instead, `draw()` clears the badge's box: for every clip with `c.speed !== 1 && (c.end − c.start)·px > 28` (the same condition `Timeline` uses), `clearRect((c.start − win.start)·px + 4, 1, 46, 19)`.
7. **Bookkeeping.** Set `canvas.dataset.draws = String(++draws)` imperatively. There is no React state, so drawing never re-renders.

**When it redraws.** Only in `useLayoutEffect([px, win, levels, ref, lanes, pauses, gaps, clips, shown, status])`.

- Playback, scrubbing and the playhead never re-render it. `Timeline`'s player subscription only moves `playheadRef` by transform.
- A Shift+drag re-renders `Timeline` (`setDraftRange`), but `ClipWaveform` is `memo` with unchanged props.
- A trim drag (`onTrimDown`: `store.beginGesture`, one `store.update` per move) gives one redraw per move, up to 16k columns × 2 lanes, a few ms.
- Colours are read once per mount with `getComputedStyle(canvas).getPropertyValue('--wave-…')`.

**4.7 States** (`data-state` on the canvas, and published to the hint store of §5)

| State | Shown | When |
|---|---|---|
| `none` | no canvas | `lanes.length === 0` (no sound), or hidden |
| `loading` | `--wave-muted` hairline at the centre | the idle callback is pending or the request is in flight |
| `ready` | waveform and pauses | levels for every lane |
| `error` | nothing drawn | `loadAudioAnalysis` left a lane out (see below) |

`loadAudioAnalysis` leaves a lane out in three cases:

- The measurement failed. A file without an audio stream fails too: `levelArgs` with `-map 0:a:0?` makes ffmpeg exit with "Output file does not contain any stream". This was checked with ffmpeg here. The "empty envelope" in `measureLevels`' comment does not happen.
- The measurement was stopped.
- The file is missing (`analyzeAudio` skips it).

`loadAudioAnalysis` drops failures from its cache, so hiding and showing the waveform, or reopening the project, retries. Responses that arrive after unmount are ignored.

**4.8 Preview = export.** The waveform is editor chrome.

- It is never drawn by `src/renderer/src/render/compositor.ts` and is not driven by `player.ts` frames.
- It is never read by `exporter.ts`, `src/shared/render/exportPlan.ts` or `audioPlan.ts`, and none of those files change.
- No sound changes: `previewAudio.ts` is untouched.
- The only shared logic it calls, `sourceActivity`, is pure and is what the preview's and the export's ducking already use (`previewAudio.ts`, `exporter.ts` through `soundActivity`). So the shading agrees with them by construction.

**4.9 Worked example.** Take a 12 s mix-only recording with a tone at 0.3–3.5 s and 7.5–11.9 s (`talkSilenceTalk()` in `tests/e2e/polish.e2e.cjs`).

- `sourceActivity` → about `[{0.3,3.5},{7.5,11.9}]`.
- `pauseRanges` → `[{3.5,7.5}]`. The 0.3 s at the start and the 0.1 s at the end are under 0.5 s and are not shaded.
- Remove silences with its defaults (`minLength` 1, padding 0.25, action `'cut'`) cuts 3.75–7.25, inside the band.
- After that cut the band stays, because pauses do not depend on the clips. The waveform inside 3.75–7.25 is faded to 30% over the cut hatching.
- If 6–12 s plays at 2× instead, `findSilences` returns 3.75–7.0. The 0.25 s output padding is 0.5 s of source on the fast side. That is still inside the band.

## 5. UI and copy

- **Where.** `<ClipWaveform px={px} win={win} duration={duration} />` goes inside `.clip-track` in `src/renderer/src/editor/Timeline.tsx`, right after the `clips.filter(...).map(...)` block.
  - It reads `id`, `hasAudio`, `audioStems`, `audio` and `clips` itself with `useSyncExternalStore(store.subscribe, …)`, as `Timeline` does for `shapes` and as `LayoutTrack` does. `duration` comes from its props.
  - It sets `data-testid="clip-waveform"`, `data-state`, `data-sources` (`"mix"`, `"mic,system"`, …), `data-pauses` (`"3.50-7.50;…"`, source seconds to 2 decimals), `data-from` (`win.start`), `data-px` and `data-draws`.
- **Styles.** In the new `src/renderer/src/editor/waveform.css`, imported by `ClipWaveform.tsx`. Selectors use two classes because `editor.css` loads later (see the note at the top of `captions.css`).
  ```css
  .tl-track.clip-track { --wave-mix: rgba(240,237,255,.78); --wave-mic: rgba(240,237,255,.82);
    --wave-system: rgba(253,186,116,.85); --wave-muted: rgba(255,255,255,.22); --wave-pause: rgba(5,5,10,.32); }
  .clip-track .clip-wave { position:absolute; top:0; height:100%; pointer-events:none; z-index:1; }
  ```
  `height: 100%`, not `bottom: 0`: an absolutely positioned canvas is a replaced element, so `top` and `bottom` do not stretch it and it would take its device-pixel height. Its `left` and `width` are set inline.
  Orange is used for the system sound because it contrasts with `--track-clip` (#6d4aff) and `--track-clip-fast` (#0ea5c6) (`styles.css`). There is no light theme in the renderer.
- **Tooltip.** The `.clip-track` `title` becomes `` `Click to move the playhead, Shift+drag to select a range to cut${useWaveformHint()}` ``. `useWaveformHint` reads a small module-level status store that `ClipWaveform` publishes to (state, stems or mix, any lane muted), with `useSyncExternalStore`. `Timeline` re-renders only when that status changes.
  - mix, ready: ` · Waveform: the recording's sound; darker stretches are pauses`
  - stems, ready: ` · Waveform: microphone above the line, system sound below; darker stretches are pauses`
  - any lane muted (ready only): append ` (grey: muted)`
  - loading: ` · Reading the sound for the waveform…`
  - error: ` · The waveform could not read the sound`
  - none or hidden: `''`
- **Notice.** Running the toggle shows the existing `turned('Audio waveform', on)` notice ("Audio waveform on" / "Audio waveform off"), as `toggleKeystrokes` and `toggleCaptions` do. Running it by a custom key on a recording without sound shows `showNotice('This recording has no sound')`.
- **Empty and disabled.** A recording without sound has no canvas and no hint. The palette lists the command as unavailable: `.palette-item.unavailable`, with title "This recording has no sound".
- **Unchanged.** Timeline height, track labels and `tl-hint`.

## 6. Commands and shortcuts

| id | title | category | flags | keywords | default key |
|---|---|---|---|---|---|
| `toggleWaveform` | Audio waveform on the timeline | Timeline | `toggle: true` | `sound wave levels audio pauses silence talk show hide` | none |

- **`src/shared/editor/commands.ts`.** The entry after `timelineFit` was added by the wave's contracts commit (`482c370`), with the rest of the wave's commands. `DEFAULT_KEYMAP` (`shortcuts.ts`) spreads `COMMAND_IDS.map(id => [id, []])`, so **`shortcuts.ts` needs no change**.
- **`src/renderer/src/views/Editor.tsx`**, in the `commands` `useMemo`:
  ```ts
  toggleWaveform: () => {
    if (!store.state.hasAudio) return showNotice('This recording has no sound')
    const on = !waveformShown()
    setWaveformShown(on)
    turned('Audio waveform', on)
  },
  ```
  In `paletteEntries`, add `unavailable.toggleWaveform = p.hasAudio ? null : 'This recording has no sound'` and `on.toggleWaveform = p.hasAudio && waveformShown()`. The list is recomputed when the palette opens, so the state shown is current.
- **Conflicts checked** against `DEFAULT_KEYMAP`: Space, Home, End, Left, Right, Shift+Left, Shift+Right, Shift+PageUp, Shift+PageDown, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, S, Delete, Backspace, Z, T, Shift+T, M, 0–4, Plus, =, -, _, Ctrl+E, Ctrl+/, Ctrl+K, Ctrl+Shift+P.
  - `W` is free (only `Ctrl+W` is in `RESERVED`). No default is proposed, because the toggle is rarely used and E-08 (J/K/L), E-05 and E-11 are claiming letters in parallel.
  - Users can bind it in the shortcuts editor, where `checkShortcut` / `reservedReason` apply as usual.

## 7. Undo

Nothing to undo: the feature never edits the project. The toggle is a view preference and stays off the undo stack, like timeline zoom.

Edits made while looking at the waveform stay the existing single steps:

- Cuts and trims are `store.beginGesture` / `endGesture` drags.
- Range cuts are one `store.update`.
- Remove silences is one `store.update`.

## 8. Contracts (committed first as stubs and types)

| File | Export | Signature |
|---|---|---|
| `src/shared/audio/waveform.ts` | `WaveformLane`, `WAVEFORM` | as in §3 |
| | `waveformLanes` | `(project: Pick<Project, 'hasAudio' \| 'audioStems' \| 'audio'>) => WaveformLane[]` |
| | `waveformRef` | `(levels: readonly AudioLevels[]) => number \| null` |
| | `waveformHeight` | `(db: number, ref: number) => number` |
| | `waveformColumns` | `(levels: AudioLevels, ref: number, from: number, to: number, columns: number) => Float32Array` |
| | `pauseRanges` | `(activity: readonly Range[], duration: number, minLength?: number) => Range[]` |
| `src/renderer/src/editor/waveformPref.ts` | `waveformShown` | `() => boolean` |
| | `setWaveformShown` | `(on: boolean) => void` (writes `localStorage['editor-waveform']`, notifies subscribers) |
| | `useWaveformShown` | `() => boolean` (`useSyncExternalStore`) |
| `src/renderer/src/editor/ClipWaveform.tsx` | `ClipWaveform` | `memo((props: { px: number; win: { start: number; end: number }; duration: number }) => JSX.Element \| null)` |
| | `useWaveformHint` | `() => string` (tooltip suffix, `''` when nothing is shown) |
| `src/shared/editor/commands.ts` | `CommandId` gains | `'toggleWaveform'` |

## 9. Files owned by this feature

**Create:**

- `src/shared/audio/waveform.ts`: lanes, reference, heights, columns and pauses (pure).
- `src/renderer/src/editor/ClipWaveform.tsx`: idle-time loading through `loadAudioAnalysis`, the canvas, `draw()`, the status store and `useWaveformHint`.
- `src/renderer/src/editor/waveformPref.ts`: the per-user show/hide preference.
- `src/renderer/src/editor/waveform.css`: colour tokens and canvas placement.
- `tests/waveform.test.ts`: unit tests.
- `tests/e2e/waveform.e2e.cjs`: the end-to-end scenario. `run-all.cjs` picks up every `*.e2e.cjs`.

**Modify:**

- `src/renderer/src/editor/Timeline.tsx` (**SHARED**). E-05 snapping owns the drag handlers `onTrimDown`, `onZoomDown`, `onAnnotationDown`, `onShapeDown` and `onClipTrackDown`. E-11 may add blocks to `.clip-track`. This feature touches only three places:
  - one import line;
  - one JSX line inside `.clip-track`, after the clip-block `.map`;
  - the `.clip-track` `title` expression.
- `src/renderer/src/views/Editor.tsx` (**SHARED**): one import line, the handler in the E-04 group of the `commands` map, and two statements in `paletteEntries`, after the `unavailable` and `on` literals (`unavailable.toggleWaveform = …`, `on.toggleWaveform = …`), so no line of the literals changes.

Changed by others (editing-wins.md):

- `src/shared/editor/commands.ts`: the entry after `timelineFit` is in the contracts commit. `tests/commands.test.ts` is contracts-only in this wave (editing-wins.md §2), so the command's tests are a `describe` block in `tests/waveform.test.ts`.
- `docs/FEATURES.md` (one bullet next to "Zoomable, scrollable timeline") and `docs/ROADMAP.md` (E-04 done) are edited by the lead after the merge (editing-wins.md decision 4).

**Not touched:**

- `src/shared/types.ts` and `src/shared/engine/project.ts`.
- `src/main/**`: `analyzeAudio` is reused as is.
- `src/preload/**` and `src/shared/editor/shortcuts.ts`.
- The compositor, player, exporter and audio plans.
- Every teleprompter-owned file: `src/main/recording*`, `recordingIpc.ts`, `src/shared/recording/**`, `Home.tsx`, `Toolbar.tsx`, `src/renderer/src/recorder/**`.

**Interactions with the other E-features:**

- **E-05 snapping.** `pauseRanges` is exported so E-05 can add pause edges (source seconds) as snap targets. To get the levels it would read the same `loadAudioAnalysis` cache. E-05 decides.
- **E-01 polish.** It runs Remove silences, whose cuts fall inside the shaded bands. No coupling.
- **E-11 freeze frame.** Anything it draws in `.clip-track` needs `z-index ≥ 2` to stay above the waveform. Sound "continuing" during a freeze is in output time and is not shown (see Later).
- **E-08 J/K/L and preview speed.** No interaction: nothing redraws during playback.
- **E-10 crop.** None: crop is video only.

## 10. Test plan

**Unit: `tests/waveform.test.ts`.** It copies the `levels(db[])`, `run(db, s)`, `clip(start, end, speed)` and `project()` helpers from `tests/audioLevels.test.ts`. In `levels`, −200 dB means power 0.

- **`waveformLanes`**
  - `hasAudio:false` → `[]`.
  - No `audioStems` → `[{source:'mix', side:'both', muted:false}]`.
  - `{mic:true,system:true}` → `[{mic,'up',false},{system,'down',false}]`.
  - `{mic:true,system:false}` → `[{mic,'both',false}]`.
  - `audio.muted:true` → every lane muted.
  - `audio.mic.volume:0` with both stems → only mic muted.
  - `audio.volume:0` → all muted.
- **`waveformRef`**
  - One source `levels([...run(-20,5), ...run(-60,5)])` → −20 (±0.01).
  - Two sources `run(-20,2)` and `run(-30,2)` → −20.
  - All powers 0 → `null`.
  - `power.length === 0` → `null`.
  - The input arrays are unchanged afterwards (the copy).
- **`waveformHeight(·, -20)`**: −20 → 1, −42.5 → 0.5, −65 → 0, −∞ → 0, −10 → 1.
- **`waveformColumns`** (ref = −20)
  - `levels([...run(-20,1), ...run(-200,1)])`, 0 → 2, 4 columns → `[1,1,0,0]`.
  - 0 → 3 s of `[...run(-20,1), ...run(-200,2)]`, 2 columns → `[1,0]`. This checks the boundary at `1.5/0.05`.
  - One −20 window at index 3 among −200 windows, 0 → 2 with 4 columns → column 0 is 1 (peak per column).
  - Interpolation: `levels([-20,-65])`, 0 → 0.1, 8 columns → columns 0 and 1 are 1, column 4 (centre 0.05625) is 0.375, column 7 is 0.
  - 1.9 → 2.1 on 2 s of −20 levels, 2 columns → `[1, 0]`.
  - `from = -0.5` → 0 for columns before 0.
- **`pauseRanges`**
  - `[{0.3,3.5},{7.5,11.9}]`, duration 12 → `[{3.5,7.5}]`.
  - `[{2,4}]`, duration 10 → `[{0,2},{4,10}]`.
  - `[]` → `[]`.
  - `[{0,10}]`, duration 10 → `[]`.
  - `[{1,2},{2.4,3}]`, duration 3 → `[{0,1}]`.
- **Agreement with Remove silences**
  - Build `p = project({ duration: 12 })` and the mix levels `[...run(-200,0.3), ...run(-20,3.2), ...run(-200,4), ...run(-20,4.4), ...run(-200,0.1)]`. Let `act = sourceActivity(p, { mix })`.
  - `pauseRanges(act, 12)` → one range ≈ 3.5–7.5.
  - For clips `[clip(0,12)]` and for `[clip(0,6), clip(6,12,2)]`: every part of `findSilences(act, clips, { minLength: 1, padding: 0.25 })` has `[start − 0.25, end + 0.25]` inside a pause range (±1e-6).
  - Muting the recording (`audio.muted:true`) gives `sourceActivity` → `[]`, and then `pauseRanges` → `[]`.

**Unit: the command** (`describe('audio waveform command')` in `tests/waveform.test.ts`; `tests/commands.test.ts` is contracts-only in this wave):

- `commandInfo('toggleWaveform')` has category `'Timeline'`, title `'Audio waveform on the timeline'` and `toggle: true`.
- It is in `PALETTE_COMMANDS`.
- `titles('waveform')[0]` is its title. `titles` is a helper over `searchCommands(PALETTE_COMMANDS, q)`, as in `tests/commands.test.ts`.
- `titles('pauses')` contains it. `smartSpeed` also has "pauses" in its keywords, so this is not checked as first.
- `DEFAULT_KEYMAP.toggleWaveform` deep-equals `[]`.

**End to end: `tests/e2e/waveform.e2e.cjs`.** It reuses:

- `h.tempHome`, `h.launch`, `h.sleep`, `h.assert`, `h.run`, `h.projectsRoot` (`helpers.cjs`);
- `f.seedProject`, `f.openProject`, `f.waitFor` (`editor-fixtures.cjs`);
- copied from `polish.e2e.cjs`, because it does not export them: `talkSilenceTalk()`, the `test()` wrapper and the symlink step of `openSeeded`;
- copied from `editor.e2e.cjs` / `audit-editor.e2e.cjs`: the local `xForTime` / `centerY` pattern, using `.tl-content`'s `data-px-per-sec`.

Scenario, "waveform shows talk and pauses, follows a cut, costs nothing during playback, hides from the palette":

1. **Seed both projects before launch, in one home.**
   - "Talk": `id: 'rec-talk'`, 12 s, 640×360, 30 fps, `audio:true`, with `screen.mp4` replaced by a symlink to `talkSilenceTalk()`.
   - "Silent": `id: 'rec-silent'`, `audio:false`.
   - Launch, wait for `.home`, and `f.openProject(win, 'Talk')`.
2. **Ready.** Wait for `[data-testid="clip-waveform"][data-state="ready"]` (30 s). Assert `data-sources === 'mix'` and that `data-pauses` parses to one range ≈ 3.5–7.5 (±0.15), and that the clip track's tooltip ends with the mix hint.
3. **Pixels.** In `win.evaluate`, let `r = canvas.width / canvas.clientWidth` and `x = round((t − data-from)·data-px·r)`. A pixel is lit when R > 150 and A > 100. This keeps out the dark pause band, which has alpha about 82.
   - At t = 2.0 s, lit pixels span more than 50% of the height.
   - At t = 5.5 s, they span less than 10%, and the pixel 3·r rows from the top has A > 40 and R < 60 (the pause band).
4. **Cut.**
   - Shift+drag on `.clip-track` from x(1.0) to x(2.5), as in `editor.e2e.cjs`.
   - Wait for `[data-testid="range-selection"]`, then press Delete.
   - Wait for one `.gap-block.cut`.
   - Assert that the mean alpha of the column at t = 1.75 is 0.3 × the alpha at t = 3.0 (±0.08). A looser "under 0.5×" missed the translucent-fill bug of §4.6 step 5 (it gave 0.46×).
5. **Playback.** Read `data-draws`. Press Space, wait 1.5 s, press Space. Assert `data-draws` is unchanged. At fit the timeline does not scroll.
6. **Undo.** Press Ctrl+Z. Assert no `.gap-block.cut` remains and `data-pauses` is unchanged. This runs before reopening, because a reopened editor starts a new history.
7. **Hide.**
   - Press Ctrl+K, type "waveform", press Enter.
   - Before Enter, the palette shows the toggle "On". Wait for `.notice:has-text("Audio waveform off")` and assert there is no canvas and no hint in the tooltip.
   - Click `button[aria-label="Back to recordings"]`, then `f.openProject(win, 'Talk')`. Assert still no canvas (`localStorage`).
   - Toggle it back on through the palette and wait for `ready`.
8. **No sound.**
   - Go back and open "Silent". Assert there is no `[data-testid="clip-waveform"]` and the tooltip is as before.
   - Press Ctrl+K and type "waveform". Assert the first `.palette-item` is `.unavailable`, with title "This recording has no sound".

## 11. Risks

- **Extra CPU when opening a project with sound.** Before this feature, levels were measured only for ducking, normalisation, Silences, smart speed or the director. Mitigations:
  - measuring starts at idle and only while the waveform is shown;
  - `analyzeAudio` decodes one source at a time at 16 kHz;
  - results are cached for the app session.

  With stems, two files are decoded. A 3 h recording may take about 10 s to show its waveform, covered by the loading hairline and tooltip. A disk cache is in Later.
- **The K-weighted envelope is not a sample-peak waveform.** It is smoother and slightly treble-weighted. That suits speech and pauses, and it matches the detector. People used to DAW waveforms may find it soft.
- **Shading is not Remove silences' plan.** Speed, cuts, title cards and the panel's minimum make them differ (§4.5). The tooltip says "pauses", not "will be removed".
- **Stacking in `.clip-track`.** Children added by E-05 or E-11 without a z-index paint under the waveform. Speed badges are handled by clearing their box (§4.6, step 6). The selected clip's white outline is drawn under the waveform's edge columns; this is accepted.
- **Merge conflicts in shared files** (`Timeline.tsx`, `commands.ts`, `Editor.tsx`, `tests/commands.test.ts`). The edits are a few lines each, in distinct regions (§9).
- **Stale comment.** `measureLevels`' comment ("an empty envelope when it has no audio stream") is wrong. A `hasAudio` project whose `screen.mp4` has no audio stream shows `error`, not a hairline, and logs one `console.warn` per attempt.
- **Huge `win` at high DPR.** The 16,384 device-px cap (§4.6) makes rendering slightly softer in that edge case.

## 12. Later (out of scope)

- A `levels.bin` cache in the project folder, written at finalize, for instant waveforms on very long recordings. This needs the recording side.
- Snapping trims and ranges to pause edges (E-05, through `pauseRanges`).
- "Go to next pause" and "Cut this pause" commands, and a hover tooltip per pause with its length.
- Showing background music, click sounds and a freeze frame's continuing sound. These are in output time and need an output-time audio lane.
- Reflecting volume and normalisation in the shape, and a sample-peak mode for music-heavy recordings.
- A waveform in the Clip panel's Silences list.
- Fixing `measureLevels`' comment, and returning an empty envelope for files without an audio stream (`src/main/audioAnalysis.ts`).

## 13. Changes made while building it

- **Commands.** `commands.ts` was not touched here: the contracts commit added the entry. The command's unit tests live in `tests/waveform.test.ts`, because `tests/commands.test.ts` is contracts-only in this wave (§9, §10).
- **`Editor.tsx`.** The two palette lines are statements after the `unavailable` and `on` literals, so no existing line changes (§9).
- **Gap fade.** The `destination-out` fill is opaque; with the lane's translucent colour still set it removed 55% instead of 70% (§4.6 step 5). The e2e check is tightened to 0.3× ± 0.08 (§10).
- **Canvas height.** `height: 100%` instead of `bottom: 0` (§5).
- **Preference.** A value storage refuses is kept in memory for the session; `'on'` is written when shown (§3).
- **Pauses.** Activity is clipped to `[0, duration]` before the "nothing heard" check, so sound only past the end shades nothing (§4.5).
- **Hint.** ` (grey: muted)` is added to the ready hint only (§5). `duration` comes from props (§5).
- **Checked by hand, not in the e2e test.** With both stems and a 2× clip: the microphone above the line in lavender, the system sound below in orange, the speed badge's box clear, and muting the system sound turns its lane grey and adds "(grey: muted)" to the tooltip (one redraw).
