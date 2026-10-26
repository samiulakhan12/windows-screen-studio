# Polish in one click (E-01)

Part of Wave 6, "Easier editing". The shared rules for this wave (file ownership, the shared files, merge order and the keymap) are in [editing-wins.md](editing-wins.md).

Status: implemented on `w6-e01` (section 13 lists where the build differs from the first draft). Roadmap item: `docs/ROADMAP.md` › Easier editing › E-01.

The editor can already do every part of this. Today it takes five separate clicks in four tabs, and each click is its own undo step:

| Step | Where it runs today | Pure functions it uses |
|---|---|---|
| Remove silences | `ClipPanel.tsx` `SmartSpeed`, "Silences" mode (`apply()`) | `planSilences`, `applySmartSpeed`, `SILENCE_LENGTH`, `SILENCE_PADDING` (`src/shared/editor/smartSpeed.ts`). Sound comes from `loadAudioAnalysis` (`src/renderer/src/editor/audioAnalysis.ts`), `activitySources` (`src/shared/audio/settings.ts`) and `sourceActivity` (`src/shared/audio/soundtrack.ts`). |
| Auto zoom | `ZoomPanel.tsx` `AutoZoomSection.setAuto({ enabled: true })` (the Auto zoom toggle) | `regenerateAutoZooms`, `zoomSettingsOf`, `isZoomClick` (`src/shared/engine/zoom.ts`) over `effectiveTrack` (`src/shared/engine/inputTrack.ts`) |
| Camera director | `DirectorSection.tsx` `direct()` | `planDirector`, `applyDirectorPlan` (`src/shared/editor/cameraDirector.ts`) and `directorSettingsOf` (`src/shared/engine/directorData.ts`). Speech comes from `loadDirectorSpeech` and the face from `measureFraming` (`src/renderer/src/editor/directorAnalysis.ts`). Sample times come from `faceSampleTimes` (`src/shared/render/faceFraming.ts`). |
| Captions | `CaptionsPanel.tsx` `GenerateSection.start()` | `transcribe()`, `cancelTranscription()`, `transcriptionJob()` (`src/renderer/src/editor/captionItems.ts`) → `window.api.transcribe` → `src/main/ai/transcribe.ts`. Also `readTranscript` (`src/shared/captions/captionData.ts`) and `captionsOf` (`src/shared/captions/settings.ts`). |
| Style preset | `StylePresets.tsx` | `applyPreset`, `presetMatches`, `BUILT_IN_PRESETS`, `parseUserPresets` (`src/shared/editor/stylePresets.ts`) |

E-01 adds no new editing logic. It puts these step functions into one pure planner in `src/shared` and adds one renderer dialog. The dialog collects the slow inputs (sound levels, the transcript, the face) and then commits everything with one `store.update`.

---

## 1. What the user gets

- **Three ways to open it.** A **Polish** button in the editor title bar, the palette command **Polish in one click…**, and the default key **Shift+P**.
  - Each one opens a small dialog with five steps: Remove silences, Auto zoom, Captions, Camera director and Style.
  - Each step has a checkbox. Style has a preset picker instead.
  - Your choices are remembered between sessions.
- **One click runs it.** Pressing **Polish** runs the selected steps and shows live progress for each one, for example "Transcribing… Part 2 of 3" or "Finding your face… 5/12".
  - You can skip the slow parts (captions, face framing) or cancel the whole run.
  - Nothing changes until everything has finished.
- **One undo step.** The edit is applied as **one undo step**, then a summary appears. For example: "Polished: the video is 1:12.0 shorter", then one line per step: "Style: Studio", "Auto zoom turned on: 12 zooms", "Cut 9 silences: 1:12.0 shorter", "Captions: 63 captions", "Camera: intro, 1 bubble move, 2 hidden, outro". It has **Undo polish** and **Done** buttons.
- **Your objects are kept.** Polish keeps:
  - zooms you added or edited, and automatic zooms you removed stay removed;
  - camera blocks you placed or changed, and camera positions recorded from the live bubble;
  - existing captions and title cards;
  - the crop (E-10) and freeze frames (E-11), through the contracts in 4.6.

  Like Remove silences in the Clip panel, a cut also cuts whatever is shown during that pause. Text callouts and shapes over a silent stretch are hidden with it, but not deleted. Undo brings them back.
- **A failed step never blocks the others.** For example, if the AI provider fails, the other steps still apply and the summary says why captions were not made.

---

## 2. Decisions

| # | Topic | Decision | Why (alternatives rejected) |
|---|---|---|---|
| 1 | Shape | One pure `planPolish(input, options)` in `src/shared/editor/polish.ts` runs the existing step functions in order. A renderer runner (`polishRunner.ts`) first collects the async inputs, then commits. | Rejected: calling each panel's handler in turn. That gives five undo steps and needs the panels mounted. Their state also lives in module or WeakMap caches keyed by store (`analyses` in ClipPanel, `sessions` in DirectorSection). A pure planner is deterministic and can be unit-tested. |
| 2 | Step order | style → auto zoom → silences → captions → director (`POLISH_STEPS`). | The director must run last, for three reasons. `planDirector` plans lengths in **output** seconds, so it needs the final clips. It finds the demo span from the zooms through `demoSpan(cursor, project.zooms, clips, zoomStyleOf(project))`. And the transcript refines its speech (`refineSpeech` in `loadDirectorSpeech`). Zooms and captions are in source time and do not depend on cuts. Style runs first so the zoom style the preset sets (`zoomSettings.easing/transition`) is final before the director reads it. |
| 3 | Undo | `store.seal()`, then one keyless `store.update(fn)`, then `store.seal()`. `fn` plans again from the latest project, as `DirectorSection.direct()` does. | `History.push` merges only when `mergeKey !== undefined` (`src/shared/engine/history.ts`), so no key means exactly one step. Planning again inside `fn` means nothing that changed the project during the wait is lost, for example autosave's `store.replace` corrections. |
| 4 | Captions are async, slow and can fail | They are **awaited before committing**. The Captions row has a **Skip** button (`cancelTranscription()`), and **Cancel** stops everything. A failure becomes a skipped step with its error text, and the rest still applies. | Rejected: committing first and adding captions later. That makes two undo steps, and the director would plan without the transcript-refined speech. Rejected: aborting the whole polish when captions fail, because a network error would throw away cheap local work. |
| 5 | Apply, then summarise | Polish applies the edit when the run finishes, then shows the summary with **Undo polish**. | That is what "one click" means. Rejected: a review screen before applying. Reviewing each decision is E-02 (Review mode). A paid transcript is never thrown away by an extra confirmation. |
| 6 | Existing captions | Never replaced. The step is skipped with "This video already has captions; they are kept". | The transcript holds the user's text edits. `GenerateSection.start()` asks (`window.confirm`) before replacing a transcript, and polish has no such confirm. |
| 7 | Auto zoom rule | **The Auto zoom toggle's rule.** If auto zoom is off, polish turns it on: `regenerateInFrame(p.zooms, effectiveTrack, p, { ...auto, enabled: true })` (E-10's crop-aware `regenerateAutoZooms`, `src/shared/engine/crop.ts`), then writes `autoZoom: true` and `zoomSettings.auto.enabled: true`, as `setAuto({ enabled: true })` does. If auto zoom is already on, the zooms are left exactly as they are. | Finalize already generated the automatic zooms (`src/main/recording/finalize.ts` sets `project.zooms = autoZoomsForTrack(…)`). Input edits rebase them (`inputEdits.ts` → `rebaseAutoZooms`), and settings changes regenerate them (`setAuto`). So while auto zoom is on, the zooms already are the automatic ones, minus the ones you removed. Rejected: **Regenerate** on every polish. It brings back every automatic zoom you deleted, including all of them after "Remove all zooms", which keeps `autoZoom` on. That breaks "keep my edits". Refreshing zooms on purpose stays the Zoom tab's Regenerate (see Later). |
| 8 | Silences rule | `planSilences` with the Clip panel defaults: `SILENCE_LENGTH.default` 1.0 s and `SILENCE_PADDING.default` 0.25 s. The action is chosen in the dialog: Cut (default), 2×, 4× or 8×. The keep ranges are the title cards, as `ClipPanel` builds `keep`, plus E-11 freeze frames. | This is exactly the Clip panel's "Remove silences", so the parts the panel lists are the parts polish cuts. Rejected: idle-parts mode, which needs `window.api.detectStill` (ffmpeg freezedetect over the whole recording). It is slow on long recordings and is not in the roadmap text. Rejected: also keeping text callouts and shapes. A long blur or label would block every cut under it, and the panel would disagree with polish. |
| 9 | Director rule | The project's saved or default options (`directorSettingsOf(project)`), including `frameFace`, which `directorMayFrame` already turns off when you framed the camera yourself. This is **Direct again**: `planDirector` drops only the director's own segments (`withoutDirected`) and keeps yours. The face is measured as `direct()` measures it. | The Camera tab owns these options, and repeating them in the dialog would mean two places to keep in sync. Unlike zooms, the director must plan again after cuts: its intro, outro and hide rules are measured in output seconds. |
| 10 | Style step | A **style preset** (built-in or one of yours), applied with `applyPreset`. The default is "Keep the current look". | `applyPreset` changes only `PresetStyle` (`STYLE_KEYS`), `PresetCursor`, the zoom style and the tilt. It keeps the aspect ratio, cursor visibility, a custom cursor image and each zoom's own settings. Rejected: `applyStyleDefaults`. It also overwrites `webcam`, setting `show: project.hasWebcam`, which would show a hidden camera and undo the director's framing. It also overwrites `effects` and `watermark`, and it was written for new recordings. |
| 11 | Remembered options | An app preference under the new pref key `'polish'`, read through `readPolishOptions`. Not stored in the project or the saved style. | The options are about how you work, not about one recording. "Save as default style" (`lookOf` / `StyleDefaults`) and presets (`PresetLook`) do not carry them. |
| 12 | Project schema | No change. Polish writes only fields that already exist. | Old projects open and export exactly as before. The sanitiser needs no change. |
| 13 | Where it lives | A title-bar button in `src/renderer/src/views/Editor.tsx` just before Export, the palette command, and Shift+P. | Polish works across tabs, so no inspector tab owns it. `views/Toolbar.tsx` is the recording toolbar, which the teleprompter team owns, and is not touched. |
| 14 | Modal while running | Yes. The dialog sits on an `overlay modal-backdrop` (like `ShortcutsDialog`), uses `useModalFocus`, and does not close on a backdrop click. The editor's own keys are already off while `dialog` is set (`if (L.dialog) return` in Editor's `onKeyDown`). | The plan made at the end cannot drift from what the progress showed. Apart from captions, a run takes seconds. |
| 15 | Nothing to change | `planPolish` returns `input.project` itself. `store.update` then adds no step, and the dialog says "Already polished: nothing to change". | Running Polish twice must be a no-op. Each step keeps object identity when it changes nothing: decisions 7 and 10, `applySmartSpeed` with no ranges, and `applyDirectorPlan` already returns `project` itself. |
| 16 | Captions provider | The remembered `captionsProvider` if it can still transcribe, otherwise the first provider with `transcriptionModel` (`pickTranscriber`). Source is `'auto'`, and the language is detected. | This matches `GenerateSection`'s defaults (`capable.find(…) ?? capable[0]`, `source: stems ? source : 'auto'`). A picker is shown only when two or more providers can transcribe. |

---

## 3. Data model

**Project (`src/shared/types.ts`): no change.**

- **What polish writes:** `clips`, `zooms`, `autoZoom`, `zoomSettings`, `layouts`, `webcam` (zoom, cropX, cropY only), `director`, `transcript`, `captions`, `style`, `cursor` and `tilt`. Each field is written by the function that writes it today.
- **No sanitiser rules are needed:** `migrateProject` and the per-field readers already validate all of these fields.
- **Opening a project rewrites nothing.**

**New file `src/shared/editor/polish.ts`:**

```ts
import type { AiProviderInfo } from '../api/ai'
import type { DirectorSpeech } from '../audio/speech'
import type { FramingOutcome } from '../render/faceFraming'
import type { CursorTrack, Project, Transcript } from '../types'
import type { DirectorPlan } from './cameraDirector'
import type { SmartSpeedAction, TimeRange } from './smartSpeed'
import type { PresetLook } from './stylePresets'

export type PolishStep = 'style' | 'zoom' | 'silences' | 'captions' | 'director'
/** Run order (decision 2); the dialog lists rows in this order too. */
export const POLISH_STEPS: readonly PolishStep[] = ['style', 'zoom', 'silences', 'captions', 'director']

export interface PolishOptions {
  /** A style preset id (BUILT_IN_PRESETS or the user's), or null: keep the current look. */
  styleId: string | null
  zoom: boolean
  silences: boolean
  /** What happens to each silence (smartSpeed.ts). */
  silenceAction: SmartSpeedAction
  captions: boolean
  /** Transcription provider id; null or no longer able to transcribe: the first that can (pickTranscriber). */
  captionsProvider: string | null
  director: boolean
}

export const DEFAULT_POLISH_OPTIONS: Readonly<PolishOptions> = Object.freeze({
  styleId: null, zoom: true, silences: true, silenceAction: 'cut',
  captions: true, captionsProvider: null, director: true
})

/** Why a step did not run. */
export type PolishSkip =
  | 'off'            // not selected
  | 'no-input'       // no zoom clicks, typing or marks were captured
  | 'no-sound'       // project.hasAudio false
  | 'muted'          // activitySources(project) is empty (muted, volume 0, every stem off)
  | 'not-measured'   // the sound levels could not be read (sourceActivity returned null)
  | 'nothing-heard'  // measured, but nothing is heard (sourceActivity returned [])
  | 'has-captions'   // project.transcript exists: never replaced
  | 'no-provider'    // no AI provider can transcribe
  | 'busy'           // a transcription job is already running (Captions tab)
  | 'failed'         // the provider failed (PolishInput.errors.captions)
  | 'cancelled'      // skipped by the user while it ran
  | 'no-camera'      // no camera (project.hasWebcam false, or the file is missing)
  | 'camera-hidden'  // webcam.show false
  | 'no-preset'      // options.styleId names a preset that no longer exists

export interface PolishInput {
  project: Project
  /** cursor.json as recorded; read through effectiveTrack(recorded, project). */
  recorded: CursorTrack
  /** sourceActivity(project, levels): source ranges where the recording is heard; [] nothing heard; null not measured. */
  sound: TimeRange[] | null
  /** A transcript fetched for this run (readTranscript), or null. */
  transcript: Transcript | null
  /** The provider gave more than MAX_CAPTIONS captions, so the ones after `transcript`'s last were left out. */
  transcriptLeftOut?: boolean
  /** loadDirectorSpeech(project with this run's transcript, …).speech; null when unknown. */
  speech: DirectorSpeech | null
  /** Face framing for the director; { status: 'skipped' } when not measured. */
  framing: FramingOutcome
  /** The chosen preset, resolved by the runner; null when styleId is null or the preset is gone. */
  preset: { name: string; look: PresetLook } | null
  /** Reasons the runner knows and the planner cannot see (provider, failure, cancel, camera file). */
  blocked?: Partial<Record<PolishStep, PolishSkip>>
  /** Error text of a failed step (captions). */
  errors?: Partial<Record<PolishStep, string>>
  /** Ids of new director segments (tests inject a counter). */
  newId?: () => string
}

export interface PolishStepResult {
  step: PolishStep
  status: 'changed' | 'unchanged' | 'skipped'
  reason?: PolishSkip
  error?: string
}

export interface PolishSummary {
  /** One per POLISH_STEPS entry, in order. */
  steps: PolishStepResult[]
  /** Seconds the video got shorter: max(0, videoDuration(before) − videoDuration(after)) (outputDuration without freezes). */
  saved: number
  /** Silences acted on, and how. */
  silences: number
  silenceAction: SmartSpeedAction
  /** Zooms after polishing: automatic ones, and the user's (auto: false). */
  zooms: { auto: number; kept: number }
  /** The director's parts after polishing (DirectorPlan.parts, by kind). */
  camera: { intro: boolean; outro: boolean; hidden: number; moves: number }
  /** The face framing outcome used (shown with framingLine); null when the director did not run. */
  framing: FramingOutcome | null
  /** Captions written (0 unless the captions step changed the project). */
  captions: number
  /** With captions left out (transcriptLeftOut): the output second the written ones stop at, else null. */
  captionsLeftOutAfter: number | null
  /** Name of the preset applied or matched, or null. */
  style: string | null
}

export interface PolishResult {
  /** The polished project; input.project itself when nothing changed. */
  project: Project
  summary: PolishSummary
  /** The director's plan on the polished cuts (cameraShown, framingCap), null when it did not run. */
  directorPlan: DirectorPlan | null
}

export interface PolishContext {
  /** The camera file was found and loaded (Editor's !!data.webcamUrl). */
  hasCameraFile: boolean
  /** Providers that can transcribe; null while the list is read. */
  transcribers: readonly Pick<AiProviderInfo, 'id'>[] | null
  /** transcriptionJob()?.running for this project. */
  transcribing: boolean
}
```

**Sanitising the remembered options with `readPolishOptions(raw)`:**

- Anything that is not a plain object gives `DEFAULT_POLISH_OPTIONS`.
- Each boolean field is kept only when it is a boolean. Otherwise it takes its default.
- `silenceAction` is kept only when it is one of `SMART_SPEED_ACTIONS`. Otherwise it is `'cut'`.
- `styleId` and `captionsProvider` are kept only when they are strings of 1–64 characters. Otherwise they are `null`. User preset ids already match `/^[\w-]{1,64}$/` in `parseUserPresets`.
- Unknown keys are dropped.
- The function is idempotent.

**Preferences (`src/shared/api/prefs.ts`):**

- `PrefKey` becomes `'stylePresets' | 'shortcuts' | 'polish'`, and `'polish'` is appended to `PREF_KEYS`.
- `src/main/prefsIpc.ts` (`isKey` against `PREF_KEYS`) and `src/preload/prefs.ts` need no change.
- The value is validated on read, as the file header asks.

**Saved default style and presets:** they do not carry the polish options. `lookOf` and `StyleDefaults` are unchanged. A preset is an *input* to polish and is not affected by it.

---

## 4. Algorithms and behaviour

### 4.1 `planPolish(input, options)`: pure and synchronous

Setup: `base = input.project`, `before = outputDuration(base.clips)`, `p = base`. Each step either replaces `p` with a new object or leaves it untouched.

1. **Style.**
   - `!options.styleId` → `'off'`.
   - `!input.preset` → `'no-preset'`.
   - `presetMatches(p, preset.look)` → `'unchanged'`, and `summary.style = preset.name`.
   - Otherwise `next = applyPreset(p, preset.look)`:
     - If `next === p` (the look sanitises to nothing), the result is `'unchanged'`.
     - Otherwise `p = next` → `'changed'`, and `summary.style = preset.name`.

   Any crop field E-10 adds survives as long as it is not in `STYLE_KEYS`.
2. **Auto zoom.**
   - `!options.zoom` → `'off'`.
   - `!autoZoomHasInput(input.recorded)` → `'no-input'`. This is ZoomPanel's `hasInput`, written over the recorded track. It is true when any recorded click passes `isZoomClick(c, true)`, when `recorded.valid` and there is a typing burst, or when there is a mark.
   - If `zoomSettingsOf(p).auto.enabled`, the result is `'unchanged'`. The zooms are already the automatic ones minus what you removed (decision 7).
   - Otherwise:
     - `auto = { ...zoomSettingsOf(p).auto, enabled: true }`
     - `r = regenerateInFrame(p.zooms, effectiveTrack(input.recorded, p), p, auto)`: `regenerateAutoZooms` with the clicks outside the crop left out and the anchors clamped into it (E-10). Without a crop it is exactly `regenerateAutoZooms(…, p.duration, auto)`.
     - `p = { ...p, autoZoom: true, zoomSettings: { ...zoomSettingsOf(p), auto }, zooms: r.zooms }` → `'changed'`.

     Zooms with `auto: false` are kept, and new automatic zooms that overlap them are dropped.

   `summary.zooms = { auto: count(z.auto), kept: count(!z.auto) }` on the final `p`.
3. **Silences.**
   - `!options.silences` → `'off'`.
   - `!p.hasAudio` → `'no-sound'`.
   - `activitySources(p).length === 0` → `'muted'`.
   - `input.sound === null` → `'not-measured'`.
   - `input.sound.length === 0` → `'nothing-heard'`.
   - Otherwise `plan = planSilences(input.sound, p.clips, { minLength: SILENCE_LENGTH.default, padding: SILENCE_PADDING.default }, options.silenceAction, polishKeepRanges(p))`:
     - If `plan.parts.length === 0`, the result is `'unchanged'`.
     - Otherwise `clips = applySmartSpeed(p.clips, plan.parts.flatMap((x) => x.pieces), options.silenceAction)`. A silence across a cut is acted on at both sides, exactly as `SmartSpeed.apply()` does. Then `p = { ...p, clips }` → `'changed'`, and `summary.silences = plan.parts.length`.
4. **Captions.**
   - `!options.captions` → `'off'`.
   - `p.transcript` → `'has-captions'`.
   - `!p.hasAudio` → `'no-sound'`.
   - `input.blocked?.captions` → that reason, plus `errors.captions`.
   - `!input.transcript` → `'failed'`.
   - Otherwise `p = { ...p, transcript: input.transcript, captions: { ...captionsOf(p), show: true } }` → `'changed'`. This is the same write as `transcribe()`. Then `summary.captions = input.transcript.segments.length`.
5. **Director.**
   - `!options.director` → `'off'`.
   - `input.blocked?.director` → that reason.
   - `!p.hasWebcam` → `'no-camera'`.
   - `!p.webcam.show` → `'camera-hidden'`.

     These two checks are `layoutsApply` (`src/shared/engine/layout.ts`). They are needed: for such a project `planDirector` returns an empty plan, but `applyDirectorPlan` still writes `project.director`, which would be a change that does nothing.
   - Otherwise:
     - `view = cropView(p, effectiveTrack(input.recorded, p))` (E-10: the project and track as drawn, as `DirectorSection`'s `inputFor` builds them).
     - `plan = planDirector({ project: view.project, cursor: view.cursor, speech: input.speech, newId: input.newId }, directorSettingsOf(p))`
     - `next = applyDirectorPlan(p, plan, input.framing)`, on the real `p`: it writes only layouts, `director` and the camera framing, none of which has screen coordinates. The result is `'changed'` when `next !== p`, otherwise `'unchanged'`.
     - `summary.camera` counts `plan.parts` by kind: `intro`, `outro`, `hidden`, and `corner` (bubble moves).
     - `summary.framing = input.framing`, and `directorPlan = plan`.

At the end, `summary.saved = Math.max(0, videoDuration(base.clips, planOf(base)) − videoDuration(p.clips, planOf(p)))` (`src/shared/engine/freeze.ts`): the length of the exported video, pause freezes included, as E-11 asks. Without freezes it is `outputDuration`. If no step changed anything, `p === base`.

**`polishKeepRanges(project): TimeRange[]`** is the title cards, `(project.titles ?? []).map(({ start, end }) => ({ start, end }))` (the list `ClipPanel` builds as `keep`), followed by `freezeKeepRanges(project.freezes)` (E-11: `[at − 0.25, at + 0.25]` per freeze).

**`autoZoomHasInput(recorded)`** is ZoomPanel's `hasInput`: a mark, or, on a valid track only, a click that passes `isZoomClick(c, true)` or a typing burst. ZoomPanel counts clicks through `clickRows`, which is empty without cursor data; recorded invalid tracks have no clicks anyway.

**`pickTranscriber(providers, remembered): AiProviderInfo | null`** filters the providers to those with `transcriptionModel`. It returns the one whose id is `remembered`, otherwise the first one, otherwise `null`.

**Worked example.** A 12 s project with:

- clips `[{0, 12, 1}]`;
- sound `[{0.3, 3.5}, {7.5, 11.9}]`;
- two left clicks at 2.2 s and 9.0 s, and `autoZoom: false`;
- no titles, no camera and no provider;
- default options.

The steps:

- **Style:** `'off'`.
- **Auto zoom:** it was off, so it is turned on. Two automatic zooms, about 1.3–4.0 and 8.1–10.8 (`DEFAULT_AUTO_ZOOM`: leadIn 0.9, hold 1.8, minDuration 2.2) → `'changed'`.
- **Silences:**
  - The output gaps are `[0, 0.3]`, `[3.5, 7.5]` and `[11.9, 12]`.
  - Only `[3.5, 7.5]` is at least 1.0 s long. With the padding it becomes `[3.75, 7.25]`.
  - The clips become `[{0, 3.75}, {7.25, 12}]`, which saves 3.5 s.
  - Neither end gap counts: `[0, 0.3]` is 0.3 s and `[11.9, 12]` is 0.1 s.
- **Captions:** skipped, because `blocked.captions = 'no-provider'`.
- **Director:** `'no-camera'`.
- **Headline:** "Polished: the video is 3.5 s shorter".

Run again on the result:

- auto zoom is on → `'unchanged'`;
- the remaining pause is 0.25 + 0.25 = 0.5 s, below 1.0 s, so nothing more is cut;
- `planPolish` returns `input.project` itself → "Already polished".

With action 4× the second run is also a no-op. The sped-up pause plays 0.25 + 0.875 + 0.25 = 1.375 s, but its piece already plays at 4×, so `rangeSaving` is 0 and `planSilences` drops it (`MIN_SAVING`).

### 4.2 `polishAvailability(project, recorded, ctx): Record<PolishStep, PolishSkip | null>`

This decides which rows are disabled. It uses the same rules as 4.1:

- **style:** never disabled.
- **zoom:** `'no-input'`.
- **silences:** `'no-sound'`, then `'muted'`.
- **captions**, checked in this order:
  1. `'has-captions'`;
  2. `'no-sound'`;
  3. `'busy'` (`ctx.transcribing`);
  4. `'no-provider'` (`ctx.transcribers?.length === 0`).

  While `ctx.transcribers` is null, the row reads "Looking for your AI providers…" and is disabled.
- **director:** `'no-camera'` when `!ctx.hasCameraFile || !project.hasWebcam`, and `'camera-hidden'` when `!project.webcam.show`. This is the rule of `directUnavailable(!!data.webcamUrl, webcam.show)`.

### 4.3 The runner (`src/renderer/src/editor/polishRunner.ts`)

The dialog reads the providers (`window.api.listAiProviders()`) and the options (`getPref('polish')` → `readPolishOptions`) when it opens. It resolves the provider with `pickTranscriber` and passes the provider id to `runPolish`.

`runPolish` uses one `AbortController` for the whole run, and a second one for face framing only, so the face can be skipped on its own. It runs in four phases.

1. **Collect, in parallel.**
   - **(a) Sound.** Call `loadAudioAnalysis(project.id, sources)`, where `sources` is `activitySources(p)` plus `speechLevelSource(p)` when it is not already among them.
     - Each source is measured once per editor session and shared with preview ducking, smart speed and the director.
     - The call never rejects, because a failed source is left out. One file ffmpeg cannot read fails the main process's whole request, so every source of that request is left out (and asked for again on the next call).
     - Then `sound = sourceActivity(p, levels)`, which is null when a source is missing.
     - When it is null, only Remove silences is skipped (`'not-measured'`), and its row says so at once ("The sound could not be measured, so nothing was cut"). The other steps go on: the director's speech falls back to the transcript, as in the Camera tab (`loadDirectorSpeech`).
   - **(b) Captions**, only when the row is available and selected:
     - Call the new `fetchTranscript(projectId, p.duration, { providerId, source: 'auto' })`. It runs the existing transcription job, so `transcriptionJob()`, `onTranscribeProgress` and `cancelTranscription()` behave as in the Captions tab. It **does not write to the store**. The job ends when it resolves; an error stays on the job, so the Captions tab shows it too.
     - `{ transcript }` → `input.transcript`.
     - `{ error }` → `blocked.captions = 'failed'` with `errors.captions`. This includes "No speech was found in this recording", which `transcribe()` already throws.
     - `{ cancelled }` → `'cancelled'`.
     - When no provider is passed: `'no-provider'`.
2. **Speech.** Call `loadDirectorSpeech({ ...p, transcript: fetched ?? p.transcript }, effectiveTrack(recorded, p))`. The levels are already cached, and the transcript refines the speech.
3. **Probe.** Run `planPolish({ …, framing: { status: 'skipped' } }, options)`. If `probe.directorPlan` exists, `directorSettingsOf(probe.project).frameFace` is true and `player.webcam` exists:
   - `times = faceSampleTimes(probe.directorPlan.cameraShown, speech?.ranges ?? null, p.webcamOffset, player.webcam.duration || p.duration)`. That is `FACE.minSamples` (6) to `FACE.maxSamples` (16) samples.
   - `framing = await measureFraming(player.webcam.currentSrc || player.webcam.src, times, probe.directorPlan.framingCap, { onProgress, signal: faceSignal })`.
   - `measureFraming` allows 3 s per seek and 10 s for the video to load. It never rejects and resolves `'skipped'` on abort. These are exactly the calls `direct()` makes.
4. **Commit**, unless the run was aborted:

   ```ts
   store.seal()
   let result: PolishResult | null = null
   try {
     store.update((p) => (result = planPolish({ ...gathered, project: p }, options)).project)
   } catch (err) {
     // EditStore.update calls fn once, before any push: a throw leaves the project untouched.
     return showError(`Polish failed: ${message(err)}. Nothing was changed.`)
   }
   store.seal()
   ```

   When `result.project === p`, no undo step is added.

The options are saved with `window.api.setPref('polish', options)` when **Polish** is pressed. A failed save is only logged.

**Cancel and Skip.**

- **Cancel**, in the options view or while running:
  - calls `controller.abort()`, and calls `cancelTranscription()` only if this run started the job;
  - ignores the level results (they stay cached, which does no harm);
  - writes nothing to the store;
  - shows the notice "Polish cancelled: nothing was changed".

  Closing the editor unmounts the dialog, which also aborts. The main process stops the transcription job when the editor closes.
- **Skip** on the Captions row calls `cancelTranscription()`. `fetchTranscript` then resolves `{ cancelled }` (its `generation` no longer matches), and the run continues.
- **Skip** on the Camera row aborts only the face signal. `measureFraming` resolves `'skipped'`, and the director applies without framing.
- Cancel is not offered after the commit, because the commit is synchronous.
- **A run that fails** (it throws while collecting or planning) stops as Cancel does: it aborts, cancels the transcription it started, and its rows no longer change. The dialog then stays on "Polish failed: … Nothing was changed."

### 4.4 Preview = export

Polish adds **no rendering code**. It writes only project data that preview and export already draw the same way:

- **Clips** (cuts and speeds):
  - preview: mapped by `src/renderer/src/editor/player.ts`;
  - export frames: `exportFrameTimes` (`src/shared/engine/timeline.ts`);
  - export sound: `src/shared/render/audioPlan.ts` (`atrim` / `atempo` / `concat`).
- **Zooms, layouts, webcam framing, director, captions, style, cursor and tilt:** drawn by `drawFrame` (`src/renderer/src/render/compositor.ts`) as a pure function of source time. Both `player.ts` and `src/renderer/src/editor/exporter.ts` call it.
- **Captions, subtitle export and chapters** already map source time through the clips (`viewingTime`, `src/shared/render/overlays.ts`).

So preview and export match by construction. No function in `compositor.ts`, `player.ts`, `exporter.ts` or `src/shared/render/*` changes. The e2e test (section 10) still checks the exported duration and frame count against the polished clips.

### 4.5 Numbers and edge cases

- **Silence numbers.** Minimum 1.0 s and padding 0.25 s (`SILENCE_LENGTH` / `SILENCE_PADDING`). A pause that runs to the very start or end of the video gets no padding on that side (`findSilences`). Parts saving less than 0.05 s are dropped (`MIN_SAVING`). A cut never removes the last of the video (`cutRange`).
- **Cuts you made** are kept, because `findSilences` works on the current output. A pause you **restored** by hand can be cut again (see Risks).
- **Clips you sped up:** `applySmartSpeed` only speeds up pieces slower than the action, and `rangeSaving` counts their current speed.
- **Automatic zooms** you deleted stay deleted while auto zoom is on (decision 7). With auto zoom off, `regenerateAutoZooms` runs once, keeping your `auto: false` zooms.
- **No input data** (`recorded.valid === false`): auto zoom uses the marks or clicks that exist, as the toggle does. With none, the step is `'no-input'`.
- **No speech known:** the director still runs. `planDirector` notes `'no-sound'` or `'no-speech'` and only moves the bubble. The summary shows its parts.
- **Face framing unavailable** (no WebGL, or the segmenter failed): the outcome is `'unavailable'`. `applyDirectorPlan` writes everything except the framing, and the summary line uses `framingLine` ("Face framing is unavailable: … The rest of the camera track was directed.").
- **An automatic camera block you deleted** comes back. This is Direct again's rule, and `AUTO_LAYOUT_HINT` already tells you to change a block instead of deleting it.
- **Long recordings.** `planPolish` runs twice (probe, then commit). Its most expensive step, `planDirector`, already runs live in the Camera tab (`safePlan`, debounced).
- **Transcript size** is capped at `MAX_CAPTIONS` = 5000 by `readTranscript`. `fetchTranscript` says whether captions were left out (`leftOut`), the runner passes it as `PolishInput.transcriptLeftOut`, and `planPolish` sets `summary.captionsLeftOutAfter` to the output second the kept captions end at, on the **polished** clips. The captions line then adds the same sentence `transcribe()` shows.
- **A transcription already running** from the Captions tab disables the Captions row (`'busy'`). If that job finishes during the run, its own `transcribe()` writes its own undo step before polish's. The commit then plans from that project and skips captions with `'has-captions'`.

### 4.6 How it interacts with the other wave features

- **E-04 waveform:** no dependency. If E-04 reads levels through `loadAudioAnalysis`, a polish run warms its cache. Cuts made by polish are ordinary gaps.
- **E-05 snapping:** no change. Cut edges made by polish are ordinary cuts, so they become snap targets. Freeze frames (E-11) remain targets.
- **E-08 J/K/L and preview speed:** no interaction. Preview speed is player state, not project data, and silences are measured on the output timeline whatever the playback rate. Keys are checked in section 6.
- **E-10 crop:** polish keeps the crop: no step writes `crop`, and `applyPreset` does not carry it (it is not in `STYLE_KEYS`). Auto zoom goes through `regenerateInFrame` and the director plans on `cropView(p, track)`, so clicks the crop hides make no zoom and the bubble avoids the cursor where the cropped video draws it. The mapping itself belongs to E-10. Tested: the crop object is carried through unchanged.
- **E-11 freeze frame:** a freeze with the sound paused is silent, so without a keep range the silence step would cut it.
  - **Contract:** E-11 exports `freezeKeepRanges(freezes): { start, end }[]` in source seconds (0.25 s each side of every anchor; it takes the freeze list, not the project), and `polishKeepRanges` appends `freezeKeepRanges(project.freezes)`. Tested: the freezes are carried through unchanged and their anchors are never cut.
  - `ClipPanel`'s silences need the same, and wiring that is E-11's job.
  - If E-11 inserts output time with no source range, it must also keep that time out of `rangeGaps` in `findSilences` and out of `rangesToOutput`. E-11 owns that change.

---

## 5. UI and copy

**Button.** In `src/renderer/src/views/Editor.tsx`, in the title bar, directly before the Export button:

- `<button className="btn" data-testid="polish-open" onClick={() => setDialog('polish')}>` with `<EditorIcon name="sparkle" size={16} /> Polish`.
- It is not `primary`, so `render-fixtures.cjs` `openExportDialog` (`header button.primary:has-text("Export")`) is unaffected.
- Tooltip: `withShortcut('Polish in one click: silences, zooms, captions, camera and style', keymap.polish)`.

**Dialog.** New file `src/renderer/src/editor/PolishDialog.tsx`, styled by `src/renderer/src/editor/polish.css`.

- The wrapper is `<div className="overlay modal-backdrop">`. It does not close on a backdrop click.
- The panel has `role="dialog"`, `aria-modal="true"`, `aria-labelledby="polish-title"` and `className="polish-dialog"`, and uses `useModalFocus(ref, onEsc)`.
- The panel does **not** use the class `modal`, so the export helpers' `.modal` selectors stay unambiguous.
- Esc means Cancel in the options and running views, and Done in the summary view.

**Options view.**

- Title: **Polish in one click**
- Lead: "Runs the automatic edits in one go. Zooms, camera changes and captions you made are kept, and it is all one undo step."

Rows (`data-testid="polish-row-<step>"`, `data-available`) appear in run order (`POLISH_STEPS`: Style, Auto zoom, Remove silences, Captions, Camera director), as the running view and the summary do; the table below lists them by importance:

| Row | Control | Hint when available | Disabled text (`polishSkipText`) |
|---|---|---|---|
| Remove silences | Checkbox, plus "Silence action" chips Cut / 2× / 4× / 8×. Labels and titles are copied into `polishCopy.ts` from ClipPanel's file-local `SILENCE_ACTION_TITLE` ("Remove pauses from the video", "Play pauses twice as fast", …). | "Cuts pauses of 1.0 s or more, keeping a quarter second next to the sound." | "This recording has no sound" · "The sound is muted: turn it on in the Audio tab" |
| Auto zoom | Checkbox | Off: "Turns auto zoom on. Zooms you added or edited are kept." On: "Auto zoom is on: your zooms stay as they are." | "No clicks were captured" |
| Captions | Checkbox, plus a provider select (`aria-label="Transcription provider"`), shown only with two or more capable providers | "The sound is sent to <provider label> with your key and billed to your account." The label is `AiProviderInfo.label` or the kind name, as `providerLabel` builds it. | "This video already has captions; they are kept" · "This recording has no sound" · "A transcription is already running in the Captions tab" · "Add an AI provider that can transcribe (OpenAI or Gemini)", with an **Add an AI provider** button that closes this dialog and dispatches `OPEN_SETTINGS_EVENT` (`src/renderer/src/settings/SettingsButton.tsx`) with `{ section: 'ai' }` |
| Camera director | Checkbox | "Uses your Camera tab options: intro and outro, bubble corners, hiding in long silences, centring your face. Camera blocks you placed or changed are kept." | "This recording has no camera" · "Show the camera first" |
| Style | Select (`aria-label="Style preset"`): "Keep the current look", the built-in names, then a "Your presets" `<optgroup>` read with `getPref('stylePresets')` through `parseUserPresets` | "Changes the background, card, cursor look and zoom style. The aspect ratio and crop stay." | none |

- A disabled row shows its checkbox unchecked and disabled, without changing the remembered option.
- Footer: **Cancel** · **Polish** (primary).
- **Polish** is disabled, with the title "Choose at least one step", when no available row is selected and Style is "Keep the current look". It is also disabled while the options, the AI providers and your presets are being read. A remembered preset that no longer exists shows as "Keep the current look" and runs as `styleId: null`.

**Running view.** The same rows, each with a state and a text:

- Waiting: "Waiting…"
- Silences: "Measuring the sound…", then skipped with "The sound could not be measured, so nothing was cut" when it could not be.
- Captions: the Captions tab's words, through `transcribePhaseText(progress, stopping)`:
  - "Starting…", "Preparing the sound…", "Sending the sound…", "Transcribing…", "Finishing…" or "Stopping…";
  - plus " Part 2 of 3." when `total > 1`;
  - and a small **Skip** button.
- Camera: `applyingLabel` from `directorCopy.ts` ("Listening for speech…", then "Finding your face… 5/12"), with a small **Skip** while the face is measured.
- Last: "Applying…"

Footer: **Cancel**.

**Summary view** (`data-testid="polish-summary"`). Each line has `data-testid="polish-line-<step>"` and `data-status`. All text comes from `polishCopy.ts`. `shorter(s)` is ClipPanel's file-local `seconds()` rule, copied: under 60 s it gives `s.toFixed(1) + ' s'`, otherwise `formatTime(s)`, so 72 → "1:12.0".

| Situation | Text |
|---|---|
| Headline: changed, `saved ≥ 0.05` | "Polished: the video is 1:12.0 shorter" |
| Headline: changed otherwise | "Polished" |
| Headline: nothing changed | "Already polished: nothing to change" |
| Silences, changed | "Cut 9 silences: 1:12.0 shorter" / "Sped up 9 silences 4×: 48.0 s shorter" |
| Silences, unchanged | "No silences of 1.0 s or more" |
| Silences, `nothing-heard` | "Nothing is heard in this recording, so nothing was cut" |
| Auto zoom, changed | "Auto zoom turned on: 12 zooms · 2 of yours kept" |
| Auto zoom, unchanged | "Auto zoom: already on · 12 zooms" |
| Captions, changed | "Captions: 63 captions" (plus the `MAX_CAPTIONS` notice when given) |
| Captions, `failed` | "Captions not made: <error>. Try again in the Captions tab." |
| Captions, `cancelled` | "Captions: skipped" |
| Any other skip | the step's label, then its `polishSkipText` with a lower-case first letter: "Auto zoom: no clicks were captured", "Captions: skipped", "Remove silences: not selected", "Style: the current look is kept" |
| Director, changed | "Camera: intro, 1 bubble move, 2 hidden, outro", using the same words as `directedNotice`, followed by "; face centred (1.25×)" or, when not framed, `framingLine(summary.framing, false)?.text` |
| Director, unchanged | "Camera: already directed", or "Camera: nothing to change" when the plan has no part |
| Director, framing not done | the line goes on with `framingLine(summary.framing, false)?.text`: "Camera: intro, outro. No one was found in the camera picture, so the framing was left as it was." |
| Style, changed | "Style: Studio" |
| Style, unchanged | "Style: already Studio" |
| Footnote | "All of this is one undo step." |

Footer: **Undo polish** · **Done**.

- **Undo polish** calls `store.undo()` and closes the dialog with the notice "Polish undone". It is enabled only while `store.state === after`; otherwise its title is "The video changed since". It is not shown when nothing changed.

**Notice when the dialog closes**, through Editor's `showNotice`: `polishNotice(summary, changed, undoHint(keymap))`. For example: "Polished: 1:12.0 shorter · Studio style · auto zoom on · 9 silences cut · 63 captions · 5 camera changes, face centred · Ctrl + Z to undo". Only the steps that changed something are listed, in run order. When the clips changed, Editor also calls `setSelection(null)`, as `SmartSpeed.apply()` does with `onSelect(null)`.

---

## 6. Commands and shortcuts

- **`src/shared/editor/commands.ts`:** one `COMMAND_LIST` entry in the Edit group, right after `smartSpeed`:

  ```ts
  { id: 'polish', title: 'Polish in one click…', category: 'Edit', keywords: 'auto magic clean up remove silences auto zoom camera director captions subtitles style preset one click' }
  ```
- **`src/shared/editor/shortcuts.ts`:** `DEFAULT_KEYMAP.polish = ['Shift+P']`.
- **Editor:**
  - The `commands` map gets `polish: () => setDialog('polish')`.
  - The `dialog` state becomes `useState<'palette' | 'shortcuts' | 'polish' | null>`.
  - `paletteEntries`' `unavailable` gets no entry for `polish`, because the dialog explains each step.

Conflicts checked:

- `DEFAULT_KEYMAP` binds no `P` and no `Shift+P`. `Ctrl+Shift+P` (commandPalette) is a different chord.
- `matchShortcut` looks up the exact chord first, and only falls back to the Shift-less chord when there is no exact match. So `Shift+P` → `polish`, `Ctrl+Shift+P` → `commandPalette`, and plain `P` stays unbound.
- `Shift+P` is not in `RESERVED` and is not Escape.
- The command is not `inText`, so typing a capital P in the title field still types.
- No hard-coded `KeyP` / `'p'` handler exists in `src` (grep).
- The recording hotkeys (`DEFAULT_HOTKEYS` in `src/shared/recording/hotkeys.ts`: `Ctrl+Shift+2`, `Ctrl+Shift+F9`, `Ctrl+Shift+F10`) are recording-time globals, and the teleprompter owns them. There is no overlap.
- Other wave features: E-08 uses J/K/L. **E-05, E-10 and E-11 must not take `P` or `Shift+P`.**
- `findConflicts(DEFAULT_KEYMAP).size === 0` must still hold.

---

## 7. Undo

**One** undo step holds every change the run made: clips, zooms and auto zoom settings, layouts, webcam framing, director, transcript and captions, and style. It is made by one keyless `store.update` between two `store.seal()` calls.

- A run that changes nothing adds no step.
- A cancelled run, or one that throws while planning, adds no step.
- Redo brings back the whole polish.
- `fetchTranscript` never writes. Only the polish commit writes, so captions can never become a second step.
- Undo works with the Camera tab's session state. `DirectorSection`'s `outcomes` WeakMap is keyed by the `DirectorSettings` object in `Project.director`, and it has no entry for the one polish wrote. The Camera tab's framing line then shows nothing (see Later).

---

## 8. Contracts (committed first as stubs)

| File | Export | Signature |
|---|---|---|
| `src/shared/editor/polish.ts` | types | `PolishStep`, `PolishOptions`, `PolishSkip`, `PolishInput`, `PolishStepResult`, `PolishSummary`, `PolishResult`, `PolishContext` (section 3) |
| | constants | `POLISH_STEPS: readonly PolishStep[]`, `DEFAULT_POLISH_OPTIONS: Readonly<PolishOptions>` |
| | | `function planPolish(input: PolishInput, options: PolishOptions): PolishResult` |
| | | `function readPolishOptions(raw: unknown): PolishOptions` |
| | | `function polishAvailability(project: Project, recorded: CursorTrack, ctx: PolishContext): Record<PolishStep, PolishSkip \| null>` |
| | | `function polishKeepRanges(project: Project): TimeRange[]` |
| | | `function autoZoomHasInput(recorded: CursorTrack): boolean` |
| | | `function pickTranscriber(providers: readonly AiProviderInfo[], remembered: string \| null): AiProviderInfo \| null` |
| `src/shared/editor/polishCopy.ts` | | `function polishStepLabel(step: PolishStep): string` |
| | | `const SILENCE_ACTION_CHIPS: readonly { value: SmartSpeedAction; label: string; title: string }[]` |
| | | `function polishSkipText(step: PolishStep, reason: PolishSkip, error?: string): string` |
| | | `function transcribePhaseText(progress: TranscribeProgress \| null, stopping: boolean): string` |
| | | `function polishResultLines(summary: PolishSummary): { step: PolishStep; status: PolishStepResult['status']; text: string }[]` |
| | | `function polishHeadline(summary: PolishSummary, changed: boolean): string` |
| | | `function polishNotice(summary: PolishSummary, changed: boolean, undo: string): string` |
| `src/renderer/src/editor/captionItems.ts` | | `type FetchedTranscript = { transcript: Transcript; leftOut: boolean } \| { error: string } \| { cancelled: true }` |
| | | `function fetchTranscript(projectId: string, duration: number, options: TranscribeOptions): Promise<FetchedTranscript>` (`transcribe()` becomes this plus its existing `store.update`; its behaviour does not change) |
| `src/renderer/src/editor/polishRunner.ts` | | `type PolishRowState = { phase: 'waiting' \| 'working' \| 'done' \| 'skipped'; text: string; canSkip?: boolean }` |
| | | `interface PolishRun { done: Promise<{ before: Project; after: Project; result: PolishResult } \| null>; cancel(): void; skipCaptions(): void; skipFace(): void }` |
| | | `function runPolish(services: EditorServices, recorded: CursorTrack, options: PolishOptions, ctx: { hasCameraFile: boolean; providerId: string \| null; userPresets: readonly StylePreset[] }, onProgress: (rows: Record<PolishStep, PolishRowState>) => void): PolishRun` |
| `src/renderer/src/editor/PolishDialog.tsx` | | `function PolishDialog(props: { recorded: CursorTrack; hasCameraFile: boolean; onClose: (notice?: string) => void; onDone: (r: { changed: boolean; clipsChanged: boolean; summary: PolishSummary }) => void }): JSX.Element` |
| `src/shared/api/prefs.ts` | | `PrefKey` gains `'polish'`; `PREF_KEYS` gains `'polish'` |
| `src/shared/editor/commands.ts` | | `CommandId` gains `'polish'` (through `COMMAND_LIST`) |

---

## 9. Files owned by this feature

**Create:**

- `src/shared/editor/polish.ts`: the planner, options, availability, keep ranges and provider choice.
- `src/shared/editor/polishCopy.ts`: every string in section 5. It is pure and tested.
- `src/renderer/src/editor/polishRunner.ts`: async collection (levels, transcript, speech, face), cancel and skip, and the commit.
- `src/renderer/src/editor/PolishDialog.tsx` and `src/renderer/src/editor/polish.css`: the dialog's three views.
- `tests/polish.test.ts`, `tests/polishCopy.test.ts`, `tests/fetchTranscript.test.ts` and `tests/e2e/one-click-polish.e2e.cjs`. The existing `tests/e2e/polish.e2e.cjs` belongs to an earlier "polish features" wave and is not touched. `run-all.cjs` picks up every `*.e2e.cjs` by itself.
- `docs/design/polish-in-one-click.md`: this section.

**Modify:**

- `src/renderer/src/editor/captionItems.ts`: split `transcribe()` into `fetchTranscript()` (job, progress, `readTranscript`, the empty-transcript error, whether captions were left out) and the store write with its `MAX_CAPTIONS` notice. The job, `generation`, progress and cancel behaviour are unchanged.
- **SHARED** `src/renderer/src/views/Editor.tsx`, four small regions only:
  - two imports (`PolishDialog`, and `POLISH_BUTTON_TITLE` / `polishNotice` from `polishCopy.ts`);
  - the `dialog` state union;
  - the `polish` entry in the `commands` `useMemo` map (E-01's no-op group of the contracts commit);
  - one title-bar `<button>` before Export;
  - one `{dialog === 'polish' && <PolishDialog …/>}` block next to the palette and shortcuts dialogs, whose `onClose` shows its notice and whose `onDone` calls `showNotice` and `setSelection(null)`.

  E-08, E-10 and E-11 add their own entries to the same map.
- In the wave's contracts commit (frozen, not changed by this workstream): the `COMMAND_LIST` entry after `smartSpeed` in `src/shared/editor/commands.ts`, `polish: ['Shift+P']` in `src/shared/editor/shortcuts.ts`, and the `'polish'` key in `src/shared/api/prefs.ts`. `tests/editingWinsContracts.test.ts` checks them.
- `docs/FEATURES.md` and `docs/ROADMAP.md` are updated by the lead after the merge (editing-wins.md decision 4).

**Not touched:**

- `compositor.ts`, `player.ts`, `exporter.ts`, `src/shared/render/*`, `project.ts`, `types.ts`, `src/main/prefsIpc.ts` and `src/preload/*`.
- Every file the teleprompter team owns.
- `ClipPanel`, `ZoomPanel`, `DirectorSection`, `CaptionsPanel` and `StylePresets`. Polish reuses their shared functions, not their components. The few file-local strings it needs are copied into `polishCopy.ts`.

---

## 10. Test plan

**`tests/polish.test.ts`** (vitest).

- Projects are built with `createProject`, as in `tests/cameraDirector.test.ts`. Its `e2eProject()`, `e2eCursor()` and `counter()` are file-local, so they are copied.
- Tracks are built as in `tests/smartSpeed.test.ts` `track()`.
- The base input for cases 1–4 is a 12 s project with clips `[{c0, 0, 12, 1}]`, `hasAudio: true`, no camera, `sound = [{0.3, 3.5}, {7.5, 11.9}]`, framing `{ status: 'skipped' }` and no transcript.

Cases:

1. **Silences only.**
   - Clips become `[{0, 3.75, 1}, {7.25, 12, 1}]`.
   - `saved = 3.5`, `silences = 1`, and the status is `'changed'`.
2. **Same, with action 4:** the piece `[3.75, 7.25]` plays at speed 4, and `saved` = 3.5 − 3.5/4 = 2.625.
3. **Titles kept.** Add the title `{start: 4, end: 6}`.
   - The gaps become `[3.5, 4]` (0.5 s, too short) and `[6, 7.5]`.
   - Only `[6.25, 7.25]` is cut, and `saved = 1.0`.
4. **Silence skips.**
   - `sound: []` → `'nothing-heard'` and the clips are kept (`toBe`).
   - `sound: null` → `'not-measured'`.
   - `audio.muted: true` → `'muted'`.
5. **Auto zoom.** Setup: clicks at 2.2 and 9.0, and one manual zoom `{auto: false, start: 10.8, end: 11.8}`.
   - With `autoZoom: false`:
     - the result has `autoZoom: true` and `zoomSettings.auto.enabled: true`;
     - the manual zoom is the same object (`toBe`);
     - the automatic zooms equal `regenerateAutoZooms(p.zooms, track, 12, {...auto, enabled: true}).zooms` with ids stripped, because `newZoomId` uses `Date.now()`.
   - With `autoZoom: true` and one automatic zoom deleted: the status is `'unchanged'` and `zooms` is the input array (`toBe`).
   - With no clicks, typing or marks: `'no-input'`.
6. **Director after cuts.** Use the copied director fixture: 48 s, camera, clicks at 13–25, and speech and sound `[{0.5, 6}, {17, 22}, {34, 46.5}]`. Options: `{ zoom: false, captions: false, styleId: null }`.
   - `cut = planPolish(input, { …, director: false }).project`.
   - `planPolish(input, { …, director: true }).project.layouts` equals `applyDirectorPlan(cut, planDirector({ project: cut, cursor, speech, newId: counter() }, directorSettingsOf(cut)), skipped).layouts`, with a fresh `counter()` on both sides. This proves the director plans on the polished clips.
   - The `summary.camera` counts match the plan's `parts`.
   - A user layout segment (no `auto`) is kept.
7. **Director skips.**
   - `hasWebcam: false` with `webcam.show: true` → `'no-camera'`, and the returned project is the input (`toBe`). No `director` is written.
   - `webcam.show: false` → `'camera-hidden'`.
8. **Captions.**
   - With no transcript in the project: `project.transcript` is `input.transcript` and `captions.show` is true.
   - With a transcript already in the project: it is kept (`toBe`), with `'has-captions'`.
   - With `blocked.captions = 'failed'`: the step is `{ status: 'skipped', reason: 'failed', error }`, and the other steps still apply.
9. **Style.**
   - `BUILT_IN_PRESETS` `studio`: `style.background` is `{ type: 'wallpaper', id: 'violet-mesh' }` and `aspectRatio` is unchanged.
   - Applied again: `'unchanged'`.
   - `preset: null` with `styleId: 'gone'`: `'no-preset'`.
   - A look of `{style:{}, cursor:{}, zoom:{}}`: `'unchanged'`, and the project is kept (`toBe`).
10. **Idempotent.** `planPolish` on its own output, with the same inputs and every step on (the case 6 fixture plus Studio), returns that output itself (`toBe`). Every step is `'unchanged'` or `'skipped'`, and `saved` is 0.
11. **All off** returns `input.project` itself.
11a. **Crop and freezes** (E-10, E-11; their mappings are identity stubs on this branch, so this checks what polish itself guarantees): with `crop` and two `freezes` set and every step on, `project.crop` and `project.freezes` come back as the same objects, both freeze anchors (in silent stretches) are still in the clips, and without the freezes the same run cuts them. `polishKeepRanges` lists the title cards, then `[at − 0.25, at + 0.25]` per freeze, and a freeze in the 12 s fixture's pause splits its cut in two.
12. **`readPolishOptions`:**
    - `null`, `[]` and `'x'` → defaults;
    - `{ silenceAction: 3 }` → `'cut'`;
    - `{ styleId: 5 }` → `null`;
    - a 65-character `captionsProvider` → `null`;
    - it is idempotent.
13. **`polishAvailability`:**
    - `hasAudio: false` → silences and captions `'no-sound'`;
    - `audio.muted` → silences `'muted'`, while captions stay available;
    - `transcribing: true` → `'busy'`;
    - `transcribers: []` → `'no-provider'`;
    - `hasCameraFile: false` → `'no-camera'`;
    - `webcam.show: false` → `'camera-hidden'`.
14. **`pickTranscriber`:**
    - a Claude-only list → `null`;
    - the remembered id is capable → that one;
    - the remembered id is gone → the first capable one.

**`tests/fetchTranscript.test.ts`** (the main process stubbed as in `tests/captionItems.test.ts`, which still covers `transcribe()`): the transcript comes back with the job ended and nothing written; `leftOut` over `MAX_CAPTIONS`; a failure (and "No speech was found") is returned and stays on the job; a cancel resolves `{ cancelled }`, also for a late answer and for the main process's "Cancelled."; a job already running is left alone.

**`tests/polishRunner.test.ts`** (`runPolish` on a recording with microphone and system stems, the levels and the transcription job stubbed as above): when the levels request fails, the Silences row is skipped at once with its reason while the transcription goes on, and the run applies the captions and the style with the silences `'not-measured'`; measured levels cut the pause; a run that throws while the transcription runs rejects, cancels that job and calls `onProgress` no more; Cancel cancels the job and writes nothing. **`tests/audioAnalysis.test.ts`:** `loadAudioAnalysis` resolves without the sources of a failed request (two at once included) and asks for them again on the next call.

**`tests/polishCopy.test.ts`:**

- `polishHeadline` for `saved` 3.5 → "Polished: the video is 3.5 s shorter", for 72 → "Polished: the video is 1:12.0 shorter", and for 0 with changes → "Polished".
- Nothing changed → "Already polished: nothing to change".
- One line per status.
- `transcribePhaseText({ phase: 'uploading', done: 1, total: 3 }, false)` → "Sending the sound… Part 2 of 3.".
- `polishNotice` lists only the changed steps and ends with the undo hint.

**Commands and keys:** the keys are covered by `tests/editingWinsContracts.test.ts`. The palette search (`titles('polish')[0]`, "magic") is tested in `tests/polish.test.ts`, so the shared `tests/commands.test.ts` and `tests/shortcuts.test.ts` are not touched. What was planned:

- `polish` is in `PALETTE_COMMANDS`.
- `titles('polish')[0] === 'Polish in one click…'` (the file's `titles` helper over `searchCommands`), and `titles('magic')` contains it.
- `run(DEFAULT_KEYMAP, ev('P', 'KeyP', { shiftKey: true }))` → `'polish'`.
- `run(DEFAULT_KEYMAP, ev('P', 'KeyP', { shiftKey: true, ctrlKey: true }))` → `'commandPalette'`.
- `run(DEFAULT_KEYMAP, ev('p', 'KeyP'))` → `null`.
- `findConflicts(DEFAULT_KEYMAP).size === 0`.

**E2E: `tests/e2e/one-click-polish.e2e.cjs`.** It reuses:

- `h.tempHome`, `h.launch({ home, env })`, `h.readProject`, `h.mockSaveDialog`, `h.assert` and `h.run` (`helpers.cjs`);
- `f.seedProject`, `f.openProject` and `f.waitFor` (`editor-fixtures.cjs`);
- `fx.openExportDialog`, `fx.pickChip`, `fx.waitForExport`, `fx.exportFrameTimes`, `fx.probe` and `fx.MEDIA_CACHE` (`render-fixtures.cjs`);
- `startMockAi`, `mockAiEnv` and `burstAudioArgs` (`ai-mock-server.cjs`);
- the `api(win, 'saveAiProvider', …)` helper from `ai.e2e.cjs`.

The `openSeeded` media swap and `waitSaved` (`.save-state[data-state="saved"]`) are local to `polish.e2e.cjs`, so they are copied, not imported. The duration check uses `f.ffprobeDuration` and `f.ffprobeFrames`.

**Scenario "polish applies everything in one undo step, and the export matches":**

1. **Media.** Build a 12 s, 640×360, 30 fps clip with ffmpeg: `testsrc2` video, with sound from `burstAudioArgs([0.5, 2.0, 8.0, 9.5], 12)`, as `ai.e2e.cjs` builds its media. The bursts are 1.2 s long, and the mock transcribes them as "Word 0"…"Word 3". The file is cached in `fx.MEDIA_CACHE`.
2. **Seed** with `f.seedProject(home, …)`:
   - `{ name: 'Polish me', seconds: 12, width: 640, height: 360, fps: 30, audio: true, webcam: true }`;
   - `capture: { method: 'chromium', cursorInVideo: false, region: null }`;
   - left clicks at 2.2 and 8.6;
   - one manual zoom `zm` = `{ id: 'zm', start: 10.9, end: 11.7, scale: 1.5, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }`.

   Then:
   - swap `screen.mp4` for the burst media;
   - patch `project.json` to `autoZoom: false` and `director: { intro: 'camera-only', corners: 'auto', hideAfter: 10, frameFace: false }`, so auto zoom is turned on and no WebGL face pass runs. `autoZoom: false` works because `seedProject` writes no `zoomSettings`: `zoomSettingsOf` lets `zoomSettings.auto.enabled` win over `autoZoom`.

   `seedProject` writes `autoZoom: true` and no `director` by itself.
3. **Launch.** Start `startMockAi({ ffmpeg })` as `ai.e2e.cjs` does, and launch with `env: mockAiEnv(mock.url)`. Add the provider with `api(win, 'saveAiProvider', { kind: 'openai', label: 'OpenAI', apiKey: 'sk-e2e-polish-0001' })`. Then `f.openProject`, rename the recording (its own undo step, so the snapshot is the saved, migrated project, with `tilt` and `layouts` filled in) and snapshot `before = h.readProject(…)` once it is saved.
4. **Open and run.**
   - With focus outside text fields, press `Shift+P` and wait for `.polish-dialog[role="dialog"]`.
   - The rows silences, zoom, captions and director are checked.
   - Pick "Studio" in `select[aria-label="Style preset"]` and click **Polish**.
   - Wait up to 60 s for `[data-testid="polish-summary"]`.
   - The `data-status` of `polish-line-style`, `polish-line-silences`, `polish-line-zoom` and `polish-line-captions` is `changed`. `polish-line-director` is `changed` or `unchanged`, not `skipped` (on this 12 s recording the director finds nothing to change: "Camera: nothing to change").
5. **Check `project.json`** after `waitSaved`:
   - **Clips:** at least 2. The output is 4.3–6.4 s shorter than 12 s. The expected cut is ≈ 5.35 s: `[3.45, 7.75]` = 4.3 s plus the unpadded tail `[10.95, 12]` = 1.05 s.
   - **Zooms:** `zm` deep-equals the seeded zoom. The automatic zooms cover 2.2 and 8.6, and none overlaps `zm`. `autoZoom` is true.
   - **Captions:** the transcript texts are `['Word 0', 'Word 1', 'Word 2', 'Word 3']`, and `captions.show` is true.
   - **Style:** `style.background` is `{ type: 'wallpaper', id: 'violet-mesh' }` and `style.aspectRatio` is `'auto'`.
6. **Done and undo.**
   - Click **Done**, and `.notice:has-text("Polished:")` appears.
   - Press **one** `Control+z`, then `waitSaved`.
   - `clips`, `zooms`, `autoZoom`, `zoomSettings`, `layouts`, `director`, `webcam`, `transcript`, `captions`, `style`, `cursor` and `tilt` deep-equal `before`.
7. **Redo and export.**
   - Press `Control+Shift+z`, then `waitSaved`.
   - `h.mockSaveDialog(app, out)`, `fx.openExportDialog(win)`, `fx.pickChip(win, 'Frame rate', '30 fps')`, then click `.modal button.primary` with the text "Export", and `fx.waitForExport` → ok.
   - `|ffprobeDuration − outputDuration(clips)| < 0.1`, the same AAC-tolerant bound as `editor.e2e.cjs`.
   - `|ffprobeFrames − fx.exportFrameTimes(clips, 30).length| ≤ 1`.

**Scenario "cancel and skip"** (its own HOME and launch, same media):

1. Add the provider with key `slow-e2e-0001`. The mock waits 60 s for keys matching `/^slow/`.
2. Polish. While the Captions row matches `/Sending the sound|Transcribing/`, click **Cancel**.
   - `.notice:has-text("Polish cancelled: nothing was changed")` appears.
   - `project.json` deep-equals `before`.
3. Reopen the dialog. With `f.waitFor`, wait until `polish-row-captions` is enabled: the cancelled job shows as "Stopping…" (`'busy'`) until the main process lets go.
4. Polish again, then click **Skip** on the Captions row.
   - `polish-line-captions` reads "Captions: skipped".
   - `project.json` has cut clips and no `transcript`.

**Scenario "a sound that cannot be measured"** (its own HOME and launch, same media): the recording gets `audioStems: { mic: true, system: true }`, with the words' sound as `mic.m4a` and a `system.m4a` ffmpeg cannot read, and the slow key.

1. Polish with Studio. `polish-row-silences` becomes `data-phase="skipped"` with "The sound could not be measured, so nothing was cut", while the Captions row still transcribes and the dialog stays in the running view.
2. Skip the captions. In the summary, the silences line is skipped with that reason, and style and auto zoom are changed.
3. After **Done**, `project.json` has the clips it had, the Studio background and no `transcript`.

---

## 11. Risks

1. **Captions cost and time.** Captions run only when a provider can transcribe and the video has no captions, and the hint says the account is billed. **Skip** and **Cancel** are always there, and progress uses the existing transcription job. The modal dialog blocks editing while it waits. For a long recording that can take minutes (see Later).
2. **Objects over a cut pause.** Text callouts, shapes and manual zooms over a pause are hidden with it, as in the Clip panel's Remove silences. Undo brings them back. Only title cards (and E-11 freezes) are keep ranges.
3. **A pause you restored can be cut again**, because restored ranges are not recorded. Undo brings it back (see Later).
4. **A deleted automatic camera block comes back.** This is Direct again's rule. The block hint already says to change a block to keep it. Automatic *zooms* you deleted do not come back (decision 7).
5. **Fresh recordings already have auto zoom on**, so the zoom step usually reads "already on". This is intended: finalize made the automatic zooms, and Regenerate stays in the Zoom tab.
6. **E-11 freeze frames would be cut as silences** without their keep ranges. `polishKeepRanges` is the one place that collects keep ranges, and it adds `freezeKeepRanges` (4.6, tested in case 11a).
7. **The E-10 crop would be lost** if E-10 put it in `PresetStyle`. Contract: the crop stays out of `STYLE_KEYS`. Case 11a checks the crop is carried through a full polish, the style step included.
8. **Face framing needs WebGL.** When it is unavailable, the director still applies and the summary says why. The e2e test turns `frameFace` off, and `camera-director.e2e.cjs` already covers framing.
9. **Planning against a changed project.** The commit plans again from `store.state`, as `direct()` does, so edits during the wait are not lost. The probe's face sample times can be slightly off for the final plan, exactly as in `DirectorSection`.
10. **Merge conflicts in shared files** (`Editor.tsx`, `captionItems.ts`). Every edit is small and in the regions named in section 9; `commands.ts`, `shortcuts.ts` and `prefs.ts` were done in the contracts commit.
11. **Stale remembered options** (a deleted preset, a removed provider). `readPolishOptions` validates them, the dialog shows a missing preset as "Keep the current look" (the planner would report `'no-preset'`), and `pickTranscriber` falls back to the first provider that can transcribe.

---

## 12. Later (out of scope)

- **F-02 after-recording autopilot:** run `planPolish` headlessly when processing finishes, with the same options.
- **F-20 batch polish** of many recordings.
- **E-02 review mode:** step through each automatic decision of a polish with Keep / Remove.
- **E-03 brand kit** as the source of the style step.
- **An optional "Refresh automatic zooms" step**, the Zoom tab's Regenerate, for projects whose automatic zooms came from an older generator.
- **Idle-parts mode** (smart speed with `detectStill`) as an optional step.
- **Per-step settings in the dialog:** silence length and padding, director options.
- **Keep ranges for short text callouts and shapes**, in the Clip panel and polish together.
- **Captions in the background:** close the dialog and let the transcript arrive as a second, clearly labelled step.
- **F-01 offline captions** as a provider, so captions need no key.
- **Remembering restored ranges**, so polish never cuts a pause you brought back.
- **Polish only a selected range.**
- **Showing polish's framing outcome in the Camera tab:** a small `DirectorSection` export that records the outcome for the `Project.director` polish wrote.

---

## 13. As built (differences from the first draft)

- **Crop and freezes (E-10, E-11).** Auto zoom calls `regenerateInFrame` and the director plans on `cropView` (4.1, 4.6). `polishKeepRanges` appends `freezeKeepRanges(project.freezes)`; E-11's function takes the freeze list, not the project. `summary.saved` uses `videoDuration` with `planOf` (freeze-frame.md asks polish to report it). On this branch both features are identity stubs, so the unit tests check what polish guarantees: the crop and freezes are carried through and freeze anchors are kept.
- **Captions left out.** `FetchedTranscript` carries `leftOut: boolean` instead of a ready `notice`: the notice names the output time where the kept captions stop, and that time depends on the polished clips, which only the planner knows. `PolishInput.transcriptLeftOut` and `PolishSummary.captionsLeftOutAfter` were added for it.
- **`fetchTranscript`** resolves `{ error }` at once, and leaves the job alone, when a transcription is already running. It ends the job itself on success; an error stays on the job, as with `transcribe()`.
- **Row order.** The options, running and summary views all list the steps in `POLISH_STEPS` order (the contract's comment), not in the order of the table in section 5.
- **Summary lines of skipped steps** start with the step's name ("Auto zoom: no clicks were captured"), because a line like "Not selected" or "No clicks were captured" does not say which step it is about in the summary. The failed-captions line keeps its own wording. 'off' reads "Not selected" ("The current look is kept" for Style).
- **Camera lines.** "Camera: nothing to change" when the plan has no part (changed or not: the first run on a project only saves the options), and the reason the face was not framed follows the line.
- **Notice.** "Studio style" rather than "Style: Studio" in the middle of the list, the steps in run order, and the camera as a number of changes (intro + outro + hidden + bubble moves), with ", face centred" when framed.
- **Undo polish** closes the dialog with the notice "Polish undone" instead of staying open with a disabled button. `PolishDialog`'s `onClose` therefore takes an optional notice (also "Polish cancelled: nothing was changed" when a run is cancelled; Cancel in the options view closes without a notice).
- **Add an AI provider** closes the polish dialog before opening Settings: two modal dialogs would both trap Tab and handle Esc.
- **The runner** measures only the sound the chosen, available steps need (`activitySources` for silences, `speechLevelSource` for the director), reads `frameFace` from the probe plan's settings (the `directorSettingsOf` the plan was made with), and catches a face-framing failure as `'unavailable'` as `direct()` does. The director's speech is measured on the full track: only times matter there.
- **Copy additions** in `polishCopy.ts`: the dialog's title, lead, footnote and notices, `polishHint` (the silences hint follows the chosen action: "Plays pauses of 1.0 s or more 4× as fast, …"), `providerName` and `transcriberLabel` (copied from the Captions tab), `polishFailed`. 'busy' reads "A transcription is already running in the Captions tab".
- **Shared files.** Only `Editor.tsx` (the regions in section 9) and `captionItems.ts` were changed. The command, key and preference were already in the contracts commit, and the palette search test lives in `tests/polish.test.ts`, so `commands.ts`, `shortcuts.ts`, `prefs.ts`, `tests/commands.test.ts` and `tests/shortcuts.test.ts` are untouched. `docs/FEATURES.md` and `docs/ROADMAP.md` are left to the lead.
- **E2E.** The test renames the recording first, so the snapshot it compares the undo with is the saved, migrated project; and it relies on `seedProject` writing no `zoomSettings` for `autoZoom: false` to turn auto zoom off.
