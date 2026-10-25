# Build report: AI providers and transcription (wave 4)

Branch `feat-w4-ai`, based on `2144728`.

## What was built

**Settings dialog** (`src/renderer/src/settings/*`). The gear button in the Home and editor
title bars is now enabled. It opens Settings, which also opens on
`window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'ai' } }))`
(exported as `OPEN_SETTINGS_EVENT`). It is a modal dialog in the style of the shortcuts and
export dialogs:
- It uses `useModalFocus`, so Tab stays inside and focus goes back to where it was on close.
- Esc closes in layers: a remove question first, then the form, then the dialog.
- Keys pressed inside never reach the editor's shortcuts.
- It is portalled to `<body>`, away from the title bar's drag region.

The **AI providers** section:
- Says plainly that transcription works with OpenAI or Google Gemini, and that Claude cannot
  transcribe (the Claude API does not accept sound) but can clean up, translate, and suggest
  chapters, a title or a summary.
- Shows "Keys are stored encrypted on this PC and are only sent to the provider you pick."
- Lists providers with name, kind, masked key, models and what each can do.
- **Add / Edit**:
  - Kind is a radio group with arrow keys.
  - The API key field is a password field with Show/Hide. When editing, leaving it empty keeps
    the stored key.
  - Model fields come with defaults, and there is a "Can do" line per kind (with the Claude
    caveat).
- **Test** sends a tiny request and shows the result inline. **Remove** asks first.

**Key storage** (`src/main/ai/keyStore.ts`):
- Keys are encrypted with Electron `safeStorage` (DPAPI on Windows) and stored base64 in
  `userData/ai-providers.json`, written atomically with `writeFileAtomicSync`. The file is
  validated entry by entry when read.
- If encryption is unavailable, the key is refused with a clear message.
- A packaged Linux build also refuses Chromium's `basic_text` fallback.
- The renderer only ever gets `AiProviderInfo` with `…last4`. Keys are never logged; the
  OpenAI and Anthropic SDKs get `logLevel: 'off'`.
- Every IPC input is validated, and the `ai:*` handlers only answer the app's own page
  (`isAppUrl`).

**Providers** (`src/main/ai/openai.ts`, `gemini.ts`, `anthropic.ts`). Each uses the official
SDK with explicit base URLs: an `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` or
`ANTHROPIC_AUTH_TOKEN` in the user's environment cannot redirect or alter requests. SDK
retries are off; `src/main/ai/request.ts` does it for all three:
- a time limit per attempt;
- up to 4 attempts on 429, 408, 409 and 5xx (including 529) and on network errors, waiting
  1, 2, 4 s with jitter, or the `retry-after` (capped at 30 s);
- cancellation through `AbortSignal`;
- user-facing messages from `shared/captions/transcriptErrors.ts`: invalid key, no
  credits/quota, rate limit, unknown model, too large, network, timeout, refused.

The SDKs are loaded with dynamic `import()` on first use. The main bundle's `index.js` grew by
~47 KB; the SDKs sit in separate chunks.

**Transcription pipeline** (`src/main/ai/transcribe.ts`):
1. **Source.** `source: 'auto'` takes `mic.m4a` when `project.audioStems.mic` is set and the
   file exists, else the mixed sound of `screen.mp4`. `'mic'` and `'mixed'` force one.
2. **Decode.** ffmpeg decodes it once to 16 kHz mono PCM in a temp folder.
   `aresample=async=1:first_pts=0` keeps it on the video's clock.
3. **Split.** A recording longer than one request takes is measured with the existing level
   meter (`LevelMeter`, then `detectActivity`). Parts are cut in the middle of the longest pause
   near each part's end (`transcriptPlan.ts`), else at fixed points with a 2 s overlap.
   - Part limits: OpenAI 600 s; Gemini 300 s (shorter, as its answer carries every word).
   - Every part also stays under the upload limit at 32 kbit/s MP3. That is 25 MB for OpenAI;
     at this rate a 25 MB request holds over an hour.
4. **Send and merge.** Each part is encoded to MP3 and transcribed. Results are shifted to
   **source seconds** and merged (`transcriptMerge.ts`): each segment is kept from the one
   part whose kept window holds its middle. Overlap duplicates are kept once, from the part
   that heard them farther from its edge, and neighbours are trimmed so they never overlap.
   Ids are `t1…tn`.

Jobs, progress and cancelling:
- Progress events per phase and part go out on `ai:transcribeProgress`.
- One job runs per project.
- `cancelTranscription` (and `stopAnalyses`, i.e. leaving the editor or deleting the project)
  aborts requests, kills ffmpeg (`ProjectProcesses`) and removes the temp folder before it
  resolves. ffmpeg is also stopped when the app quits.

**Text tasks** (`src/shared/captions/transcriptText.ts`):
- Tasks: `cleanup` (punctuation, casing, obvious mis-hearings, never the meaning), `translate`,
  `chapters`, `title`, `summary`.
- One prompt per task, with a JSON schema that all three providers' structured outputs accept.
  The transcript is sent as data with ids and times.
- Cleanup and translation go in batches of 150 captions / 12,000 characters. Chapters, title
  and summary send the whole transcript (long-context models).
- Answers are checked strictly before use:
  - Cleanup and translation must return every id exactly once, in order. Repeated times must
    be unchanged. Text must not be empty or balloon in length. Ids and times are always taken
    from the input.
  - Cleaned text keeps word timings when its word count matches; translations drop them.
  - Chapters are ordered, inside the transcript, at least 5 s apart and at most about one per
    two minutes (2–20). The first starts at the first caption.
  - Titles and summaries are trimmed.
- The renderer's request is validated too (`validateTextRequest`). The target language may
  only be a language name or code.

## Additive changes outside my files

- `src/main/analysisIpc.ts`: `stopAnalyses(id)` now also awaits `stopTranscription(id)`. That
  is 1 import plus 1 entry in the `Promise.all`, so leaving the editor or deleting the project
  stops a running transcription and frees its files.
- `src/shared/api/ai.ts` (owned, additive only):
  - an optional `AiProviderInfo.canTranscribe`;
  - `AiProviderKindInfo` and `AI_PROVIDER_KINDS` (labels, defaults, key pages);
  - `AI_TEXT_TASKS` and `AI_LIMITS`.
  - Nothing was renamed or reshaped.
- `src/renderer/src/settings/SettingsButton.tsx` exports `OPEN_SETTINGS_EVENT`
  (`'ssw:open-settings'`).

README, docs, shared e2e helpers and the renderer CSP are untouched.

## Dependencies added

All are pinned exact `devDependencies`, so electron-vite bundles them into the main process
and packaged `node_modules` stays as it was. Each was published at least two weeks before
2026-10-25:

| Package | Version | Published |
|---|---|---|
| `@anthropic-ai/sdk` | 0.133.0 | 2026-10-09 |
| `openai` | 7.32.0 | 2026-10-09 |
| `@google/genai` | 2.28.0 | 2026-10-07 |

`@anthropic-ai/sdk` 0.133.0 already types `output_config.format`/`effort`,
`fallbacks: 'default'`, the `server-side-fallback-2026-07-01` beta and `fallback` content
blocks.

## Documentation used (checked 2026-10-25)

- OpenAI:
  - https://developers.openai.com/api/docs/guides/speech-to-text — 25 MB limit; formats;
    `timestamp_granularities[]` "only supported for whisper-1"; whisper-1 and the gpt-4o
    transcribe models shut down on 2027-02-26; `gpt-transcribe` is the new recommended model.
  - https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
    — verbose_json shape.
  - https://developers.openai.com/api/docs/guides/structured-outputs — Responses API
    `text.format` json_schema strict; refusal content items.
  - https://developers.openai.com/api/docs/models — current model IDs.
- Gemini:
  - https://ai.google.dev/gemini-api/docs/audio — 20 MB inline request limit; formats;
    32 tokens/s; 9.5 h.
  - https://ai.google.dev/gemini-api/docs/files — resumable upload, 48 h retention, delete.
  - https://ai.google.dev/api/generate-content — generateContent is still a core API;
    blockReason values.
  - https://ai.google.dev/gemini-api/docs/structured-output — the docs now show the newer
    Interactions API. The pinned SDK's `generateContent` `responseJsonSchema` is used instead.
- Anthropic:
  - https://platform.claude.com/docs/en/build-with-claude/structured-outputs — schema limits
    (`additionalProperties: false`, no numeric/length constraints, `minItems` 0/1); check
    `stop_reason` before parsing.
  - https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback —
    `fallbacks: "default"` with `server-side-fallback-2026-07-01`; `fallback_message` usage
    iterations; discard partial output before a switch.
  - Plus the `claude-api` skill's TypeScript reference: adaptive thinking, explicit effort
    (`claude-opus-5-5` defaults to `medium`), streaming with `finalMessage()`, typed error
    classes.

## How each provider is called

- **OpenAI**
  - Test: `models.list()`.
  - Transcribe: `audio.transcriptions.create({ file: <mp3>, model: transcriptionModel,
    response_format: 'verbose_json', timestamp_granularities: ['segment','word'],
    language? })`. Words are assigned to the segment they fall in.
  - Text tasks: `responses.create({ model, instructions, input, text: { format: { type:
    'json_schema', name, schema, strict: true } } })`. Refusal items and an `incomplete`
    status are reported; `output_text` is parsed.
  - Defaults: text model `gpt-6.1-sol`, transcription `whisper-1`.
- **Gemini**
  - Test: `models.get({ model })`.
  - Transcribe: `models.generateContent({ model, contents: [{ inlineData: { mimeType:
    'audio/mpeg', data } } | { fileData: { fileUri, mimeType } }, { text: prompt }], config: {
    responseMimeType: 'application/json', responseJsonSchema: GEMINI_TRANSCRIPT_SCHEMA } })`.
    - The sound goes inline while the request stays under the 20 MB limit (14 MB before
      base64).
    - Otherwise it goes through the Files API: `files.upload`, then `files.get` until `ACTIVE`,
      then `files.delete` afterwards.
  - `promptFeedback.blockReason` and a `finishReason` other than STOP are reported.
  - Text tasks: `generateContent` with `systemInstruction` and the task schema.
  - Defaults: `gemini-3.8-flash` for both.
- **Claude** (text only)
  - Test: `models.retrieve(model)`.
  - Text tasks: `beta.messages.stream({ model, max_tokens: 64000, thinking: { type:
    'adaptive' }, output_config: { effort, format: { type: 'json_schema', schema } }, betas:
    ['server-side-fallback-2026-07-01'], fallbacks: 'default', system, messages })` then
    `.finalMessage()`.
  - Effort: `medium` for cleanup, translate and chapters; `low` for title and summary.
  - `stop_reason` is checked first: `refusal` (with its `stop_details.category`), `max_tokens`
    and `model_context_window_exceeded` are reported. Only text after the last `fallback`
    block is parsed.
  - Models other than the 4.6+/5.x families get no adaptive thinking or effort. Models
    without server-side fallback get no `fallbacks`.
  - Errors are read with the SDK's typed classes (`APIConnectionError` before `APIError`).
  - Default model: `claude-opus-5-5`.

**Test hooks.** They are honoured only when `!app.isPackaged`, as `SSW_CAPTURE_HELPER` is:
- `SSW_AI_BASE_URL_OPENAI`, `SSW_AI_BASE_URL_GEMINI`, `SSW_AI_BASE_URL_ANTHROPIC`;
- `SSW_AI_MAX_PART_SECONDS` and `SSW_AI_GEMINI_INLINE_BYTES` (force parts and the Files API
  at test sizes).

## Tests

**Unit tests** (vitest):
- `tests/transcriptPlan.test.ts`, `transcriptParse.test.ts` (documented example payloads),
  `transcriptMerge.test.ts`, `transcriptText.test.ts`, `transcriptErrors.test.ts`.
- `tests/aiKeyStore.test.ts` with a mocked safeStorage: ciphertext on disk, masking, refusal
  without encryption, edit keeps key, damaged file, undecryptable key.
- `tests/aiProviders.test.ts` drives the real IPC handlers, SDK clients and ffmpeg pipeline
  against the mock server. It covers:
  - encrypted storage;
  - tests with good, bad and quota keys;
  - OpenAI parts with word timings;
  - microphone stem vs mixed sound;
  - Gemini inline and the Files API;
  - retries;
  - Claude refused for transcription;
  - cancel (temp files removed, second job refused);
  - all five text tasks × 3 providers;
  - Claude request settings;
  - fallback-block discard;
  - refusals;
  - request validation;
  - the base-URL hook ignored when packaged.

**E2E** (`tests/e2e/ai.e2e.cjs` with `tests/e2e/ai-mock-server.cjs`, a new file of mine; the
shared helpers are not edited).
- The mock emulates each endpoint and response shape the app calls:
  - OpenAI: multipart and verbose_json.
  - Gemini: generateContent, the resumable upload protocol, and file get/delete.
  - Anthropic: SSE stream, including a mid-stream `fallback` block and a `refusal`.
- It checks auth headers, models and structured-output settings.
- Transcripts come from the sound itself: fixture "words" are tone bursts whose pitch encodes
  the word number, so text **and** times are verified after parts are shifted and merged.

The e2e test covers:
- no keyring means the key is refused and nothing is written;
- the Settings UI: add ×4, Show/Hide, Claude has no transcription field, Esc layers, Test
  OK/invalid, Edit keeps the key, Remove with confirm, Tab trap, focus return, the
  `ssw:open-settings` event;
- keys not in plain text on disk, not in `listAiProviders`, not in the DOM or storage, and
  each key sent only to its own provider;
- transcription in 3 parts with OpenAI and Gemini, with exact source times on a project whose
  clips cut 5–9 s;
- the progress sequence;
- microphone stem vs mixed sound;
- Claude refused for transcription;
- all text tasks through each kind;
- the quota error, retries after server errors, cancel through the API, and cancel by leaving
  the editor (no ffmpeg left, temp files removed).

Under Xvfb there is no keyring, so the e2e enables Chromium's basic store from outside with
`app.evaluate(safeStorage.setUsePlainTextEncryption(true))`. The app never does this itself.

## Verification

Run on Linux under `xvfb-run -a -s "-screen 0 1920x1080x24"` with openbox installed. Everything
passed:

- `npm run typecheck`: passes (node and web projects).
- `npx vitest run`: 108 files, **1389 tests passed**. That is the 1334 tests from before plus
  55 new ones.
- `npm run build`: passes.
- E2E, one file at a time:

  | File | Result |
  |---|---|
  | `ai.e2e.cjs` | 4/4 PASS |
  | `smoke.e2e.cjs` | 1/1 PASS |
  | `editor.e2e.cjs` | 13/13 PASS |
  | `audio-pack.e2e.cjs` | 10/10 PASS |
  | `audit-security.e2e.cjs` | 2/2 PASS |

  The editor and audio-pack files ran on the build before two last small edits (SDK
  `logLevel: 'off'` and a readable error when a project cannot be read). After those edits,
  typecheck, vitest, build, ai, smoke and audit-security were run again and passed.

## Known gaps

- **No real API keys were available.** All provider calls were verified against a mock built
  from the documented request and response shapes, not against the live services.
- **OpenAI timestamps need `whisper-1`, which OpenAI shuts down on 2027-02-26.** Its docs say
  `timestamp_granularities` only works with whisper-1 and do not say whether the recommended
  `gpt-transcribe` returns timings. With another model the app says to choose whisper-1. This
  needs revisiting when OpenAI documents timestamps for `gpt-transcribe`.
- **Gemini timings are approximate.** They are model-estimated, less precise than Whisper's,
  and word timings are best effort (optional in the schema).
- **Gemini's docs now favour the Interactions API.** This build uses `generateContent`, which
  is still listed as a core API.
- **The default model IDs may change.** `gpt-6.1-sol` and `gemini-3.8-flash` come from the
  providers' docs as of 2026-10-25. Users can change them per provider.
- **Text tasks cannot be cancelled from the renderer.** `AiApi` has no cancel for them; they
  time out (10–15 min) and stop on quit.
- **Parts are transcribed one after another.** This is simpler on rate limits but slower for
  very long recordings.
- **Temporary disk use.** A recording is decoded to temporary 16 kHz PCM, about 115 MB per
  hour, removed afterwards.
- **System proxy settings are not used.** Requests go through Node's fetch in the main process.
- **Settings has only the AI providers section.**
