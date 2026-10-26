# Build report: camera director, workstream B (speech signals and face framing)

Branch `feat-w5-director-b`, from `89c45c0` (the approved spec `docs/design/camera-director.md` and its
compiled contracts). Only the six files workstream B owns were changed or added; no frozen file, exported
signature, type or constant was touched, and none of the smarter auto zoom files.

## What was built

### `src/shared/audio/speech.ts` (pure)
- `speechLevelSource`: `'mic'` when the recording kept a mic stem (`stemsOf`), else `'mix'` when it has
  sound, else `null`. Mute and volume are ignored.
- `speechFromLevels`: `detectActivity` (ACTIVITY unchanged); drops a range when at least 80% of it lies
  inside recorded input noise (typing bursts ±0.3 s, clicks ±0.15 s, keys ±0.15 s, merged; only for a
  valid track); then joins ranges closer than 1.0 s and drops those shorter than 0.6 s. Noise is removed
  *before* joining, so a keyboard burst is never joined onto real speech.
- `transcriptSpeech`: word timings when a caption has valid ones, otherwise the whole caption; joined
  across 0.3 s; `null` without a transcript or captions.
- `refineSpeech`: no levels: the transcript joined across 1.0 s (`source: 'transcript'`); mic stem: the
  levels as they are (never gated by the transcript); mixed track and a transcript: the levels intersected
  with the words padded by 0.5 s (`refined: true`); mixed track without a transcript: as they are;
  neither: `null`.

### `src/shared/render/faceFraming.ts` (pure)
- `faceBoxOfMask`: person at alpha ≥ 128 (under 2%: null); body band = longest run of columns with
  ≥ 20% of the fullest column over the lower half (the whole picture if the lower half is empty), head
  searched within its centre ± 0.6 × its width; top row with ≥ max(2, 0.015·W) pixels in the band (below
  0.6·H: null); shoulders = from 0.1·H below the top, the first of 3 consecutive rows each wider than
  1.6 × the widest row so far (running max over the rows above); otherwise 0.2·H; width = 80th percentile
  of the row widths top..shoulders, height = min(shoulders − top, 1.4·width), cx = median of the row
  centres, eyes = top + 0.45·height; normalised to the mask size.
- `framingFromFaces`: needs max(4, 40% of samples) faces; medians of cx, eyeY, width; IQR of cx > 0.12
  → not steady, zoom ≤ 1.25; zoom = clamp(0.42·side / (width·camW), 1, maxZoom), under 1.1 → 1, rounded to
  0.05 then capped; cropX = cx, cropY = clamp(eyeY + 0.08·(side/zoom)/camH, 0, 1); crops to 4 decimals.
- `faceSampleTimes`: merges `shown`, N = clamp(round(seconds/6), 6, 16) equal slots by length (a slot can
  span several ranges); per slot the middle of its longest speech overlap, else the slot's middle; camera
  time = t − webcamOffset; outside [0, cameraDuration − 0.05] skipped; sorted, duplicates dropped.

Key fixture result (256×144 mask of section 8): cx 0.6484, w 0.1531, eyeY 0.3243; framing for 12 such
faces in 1280×720 with cap 1.6: zoom 1.55, cropX 0.6484, cropY 0.3759, steady; cap 1.3 → 1.3.

### `src/renderer/src/editor/directorAnalysis.ts` (renderer glue)
- `loadDirectorSpeech`: `speechLevelSource` → `loadAudioAnalysis(id, [source])` (requested by name) →
  `speechFromLevels` with the cursor track as noise (memoised per levels object and track) →
  `refineSpeech` with the transcript. Never rejects (also when the bridge throws synchronously). Because
  `loadAudioAnalysis` swallows errors and drops failed sources from its cache, a failure is detected as
  "the source the project names returned no levels": `failed: true`, and the next call measures again.
- `measureFraming`: `ensureSegmenter` (false → `'unavailable'` with `segmenterState`'s reason); its own
  `createVideo` element, `muted`, never attached; waits for it to load (10 s cap); per time
  `seekToFrame` bounded by 3 s (timed out → that picture is null), `seekedFrame`, `segmentPicture` (the
  element itself when no VideoFrame), `faceBoxOfMask`; every VideoFrame closed in `finally`; the element
  released (`removeAttribute('src')` + `load()`) in `finally`. Progress `{done, total}` from 0 to N.
  AbortSignal checked at every await (including mid-seek and mid-segmentation) → `'skipped'`. A segmenter
  that fails mid-way → `'unavailable'`. Faces and camera size are cached per URL + times (8 entries), so a
  different `maxZoom` reuses them. Unexpected errors resolve `'unavailable'` with the message.

## Spec problems and decisions

1. **`refined` meaning.** The frozen doc comment of `DirectorSpeech.refined` says "true when the
   transcript's words removed sound"; section 2/4 says the mixed track checked against captions is
   `refined` (status line "checked against your captions", note `transcript` instead of `mixed-sound`).
   Decision: `refined` is true whenever the transcript gated the mixed track, even if nothing happened to
   be removed — the warning "sounds from your PC count as talking" is no longer true after gating.
2. **Failed measurement with a transcript.** `SpeechResult.speech` is documented as null "when nothing
   could be measured", but step 4 says "transcript alone when levels are missing". Decision: when the
   level measurement fails, `speech` falls back to the transcript (`source: 'transcript'`) if there is one,
   with `failed: true`; without a transcript it is `null`. Workstream C: the "plan uses the mouse and
   keyboard only" callout is only accurate when `speech` is null; with `failed && speech?.source ===
   'transcript'` the captions are still used.
3. **Stems without a mic stem.** A recording with stems `{mic: false, system: true}` has no microphone;
   the spec's rule ("else the mixed track") is followed literally and returns `'mix'` (PC sound then counts
   as talking, as the status line says).
4. **Constant music.** Music playing for the whole recording becomes the noise floor of
   `activityThreshold` (threshold rises to its −32 dB ceiling), so only louder speech is found; music in
   part of a recording is heard as sound and only a transcript removes it. Covered by tests; no change.
5. **Video not loaded before the first seek.** The spec lists seek timeouts only; the element is now
   awaited with `whenReady` (10 s cap, then `'unavailable'`: "the camera video could not be read") because
   seeking an element before its metadata has loaded does not reliably fire `seeked`.
6. **Prettier.** The repo has no Prettier config and existing files do not pass Prettier defaults, so the
   new code follows the surrounding style (long lines) rather than a formatter.

## Tests

`tests/directorSpeech.test.ts` (22): speechFromLevels — finds the talking, joins word gaps and removes
keyboard ticks (section 8 fixture: [[0.5, 7.8], [52, 59.5]] ± 0.05); keeps the ticks without input data;
removes click and key noise; keeps speech that only partly overlaps typing; drops an isolated 0.4 s blip;
joins pauses under 1.0 s; finds nothing in silence or digital silence; hears music the PC plays on the
mixed track; treats music over the whole recording as the noise floor. transcriptSpeech — words joined
across 0.3 s; whole captions without words; null without captions. refineSpeech — gates the mix; removes
music no word explains; trusts the mic stem; mix as is without a transcript; transcript alone joined
across 1.0 s; null when neither; silence only stays "no talking". speechLevelSource — mic, mix, none.

`tests/faceFraming.test.ts` (18): the fixture head (cx 0.648, w 0.152, eyeY 0.33); empty / 1% → null;
only shoulders → null; half-transparent pixels are background; chair back at the far left does not move
cx; head 0.2·H tall without shoulders; other mask shape. Framing: zoom 1.55, cropX 0.648, cropY 0.38,
steady; cap 1.3; 4 of 12 → null, 5 of 12 → framed; moving person ≤ 1.25, not steady; person who leaves
the picture; big head → zoom 1; crops clamped. Sampling: 6..16; inside shown, slots spanning gaps; speech
middles; webcam offset 1.5 and 4 (negatives skipped); camera shorter than the recording.

`tests/directorAnalysis.test.ts` (19, `window.api` and the segmenter mocked, fake video and VideoFrame as in
tests/cameraMasks.test.ts): mic requested with a stem; mix otherwise, gated by the transcript; background
music never requested; silence only; no sound (transcript or nothing, no request); failure → failed and
retried, then cached; never rejects when the bridge throws. measureFraming: framed with progress 0..6,
muted own element released, every frame closed; cap; unavailable with the segmenter's reason; segmenter
breaking mid-way; empty masks → not-found; dark frame with no mask skipped; person who leaves the picture;
too few frames → not-found; abort → skipped (and pre-aborted); a seek stuck for 3 s skipped; cache per
file and times (another cap reuses faces); no times.

## Verification

```
npm ci                                   ok
npm run typecheck                        ok (tsconfig.node.json and tsconfig.web.json, no errors)
npx vitest run --testTimeout=60000       Test Files 126 passed (126); Tests 1635 passed (1635)
npm run build                            ✓ built (only the existing chunk-size warning)
xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs camera
  === camera-live.e2e.cjs
  PASS the live camera bubble: one camera open, out of the capture, dragged corners become camera corners at their times
  PASS recording bar: pause and resume, mute, restart and discard with confirmation
  PASS restart: a next take that cannot be prepared brings the app back with its error
  PASS "Camera follows the preview bubble" off: moving the bubble moves nothing in the video
  PASS Camera panel: camera position of a layout change, "Move camera here from the playhead", undo
  === camera.e2e.cjs
  PASS camera look: border colour, square vs circle, mirror, zoom and crop
  PASS camera layouts: each layout places the screen and the camera, and changes animate
  PASS camera background blur: detail behind the person goes, the person stays sharp (in the preview too)
  PASS camera background blur without WebGL: the panel says why, the camera is drawn unblurred
  PASS camera layout track: hidden without a camera; add, move, trim, change, delete, undo
  2/2 e2e files passed
```

Not done here: the optional manual `measureFraming` check in `npm run dev` on a real recording (no
Windows camera here); the director e2e test belongs to workstream C and runs at integration.
