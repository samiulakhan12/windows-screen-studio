# Fix report: wave 4, AI side

Branch `fix-w4-ai`, from `48ed9a7`. Findings are from `origin/review-w4:review/w4-findings.json`. I checked each one again against the code before fixing it, and all of them are real. Each test listed under "Proving test" fails without its fix: I stashed the source change and ran the test to confirm that.

## ai:AI-1: words lost or repeated where a sentence crosses a fixed cut. **Fixed**

- **Re-verified:** `mergeParts` removed duplicates per segment only. A sentence that crossed a fixed (overlapped) cut came back from both parts. Either one segment was dropped whole, losing the words only the other part heard, or both were kept, so the overlap words appeared twice in the text. The old test expected `'the cut'` to be dropped.
- **Change** (`src/shared/captions/transcriptMerge.ts`): `placePart` now splits by word. A segment that has word times keeps only the words whose middle is in the part's kept window. If that is all of its words, the segment stays as heard, punctuation included. If it is some of them, the segment is rebuilt from those words: start, end and text. If it is none, the segment is dropped. Segments without word times keep the old whole-segment middle rule. The overlap removal in `mergeParts` now only applies when at least one of the two segments has no words, because pieces split by word no longer share words. The doc comment in transcriptPlan.ts, "the merge keeps each word from one part only", is now true.
- **Proving tests** (`tests/transcriptMerge.test.ts`):
  - "splits a sentence across a fixed cut by word": the result is `Across` from part 0 and `the cut.` from part 1.
  - "keeps every word of a long sentence across a fixed cut exactly once": the 590–610 s case from the review, where each of w590…w609 appears exactly once.
  - The old test without words still passes unchanged.

## ai:AI-2: Claude answer cut off after a mid-answer fallback. **Fixed**

- **Re-verified** against the claude-api skill and the refusals-and-fallback docs: on a stream, the fallback model continues from the partial text, which is kept. `claudeAnswerText` threw away everything before the last `fallback` block, so the JSON was cut and could not be parsed.
- **Change** (`src/main/ai/anthropic.ts`): every text block is joined, and the `fallback` marker and non-text blocks are skipped. The refusal, `max_tokens` and context-window checks are unchanged. The header and JSDoc now describe how streaming behaves.
- **Mock** (`tests/e2e/ai-mock-server.cjs`): a `fallback…` key now streams the first third of the real answer, then the fallback block, then the rest.
- **Proving test** (`tests/aiProviders.test.ts`): "joins the partial answer and the fallback model's continuation…". It runs title and chapters through the mock, and checks that a direct call with `[text 'ab', fallback, text 'cd']` returns `'abcd'`.

## ai:AI-3: a mid-stream SSE `overloaded_error` was not retried. **Fixed**

- **Re-verified:** the SDK throws `APIError` with `status` undefined and `type` `'overloaded_error'`. As a result `describeFailure` classified it as `other`, did not retry, and showed the raw JSON.
- **Change** (`anthropicFailure`): when there is no HTTP status, the status is taken from the stream error's type (`overloaded_error` → 529, `api_error` → 500, `rate_limit_error` → 429, `timeout_error` → 408). The message is now the body's `error.message` instead of the stringified JSON. `describeFailure` is not changed for this one.
- **Mock:** a `midstream…` key sends `message_start` followed by an SSE `error` event once per endpoint.
- **Proving tests:**
  - "reads an SSE error event … as the status it stands for" (unit test).
  - "retries an overloaded error that arrives mid-stream from Claude…": the task succeeds after exactly 2 requests.

## ai:AI-4: Gemini's free-tier per-minute 429 was reported as "no credits or quota left". **Fixed**

- **Re-verified:** `QUOTA_RE` (`billing`, `exceeded your current quota…`) ran before the 429 branch. `geminiFailure` also ignored `QuotaFailure.violations[].quotaId` and `RetryInfo.retryDelay`.
- **Changes:**
  - `src/main/ai/gemini.ts`: the quotaIds are added to `code`, and `retryDelay` is read into `retryAfter` (for example `"17s"` → 17).
  - `src/shared/captions/transcriptErrors.ts`: a 429 is now a retryable rate limit unless it matches `insufficient_quota|per ?day|PerDay`, in which case it is quota. 402 and the other `QUOTA_RE` matches are unchanged, so Anthropic's credit balance and `billing_error` are still reported as quota.
- **Mock:** a `ratemin…` Gemini key returns the real per-minute body once (QuotaFailure + RetryInfo 0.2 s).
- **Proving tests:**
  - `tests/transcriptErrors.test.ts`: per-minute → rate-limit, retryable, retryAfter 17; per-day → quota.
  - `tests/aiProviders.test.ts`: `geminiFailure` reads the quotaId and `retryAfter: 17`, and a Gemini text task with `ratemin…` succeeds after a retry.

## ai:AI-5: `GOOGLE_GEMINI_BASE_URL` could redirect the Gemini key. **Fixed**

- **Re-verified:** in a packaged app no `baseUrl` was passed, so @google/genai used the environment variable.
- **Change** (`src/main/ai/gemini.ts`): the client always passes `baseUrl: baseUrlOverride('gemini') ?? 'https://generativelanguage.googleapis.com/'`, with the same comment as the OpenAI and Anthropic clients.
- **Proving test:** "send Gemini requests to Google itself in a packaged app, whatever GOOGLE_GEMINI_BASE_URL says". It runs with `app.isPackaged` set to true and the variable pointing at the mock, and records every fetch URL through a stubbed `fetch`, so nothing goes over the network. All URLs are googleapis.com.

## ai:AI-6: the transcription temp folder (decoded voice PCM) was left behind on quit or crash. **Fixed**

- **Re-verified:** the folder was only removed in `runJob`'s async `finally`, which never runs after `will-quit`, and nothing swept it later.
- **Changes:**
  - `src/main/ai/transcribe.ts`: a `Job` records its `tmp` folder. `stopAllTranscriptions()`, called on `will-quit`, now removes it synchronously with `removeSyncWithRetries` and a recursive `rmSync`. The retries cover Windows still holding the killed ffmpeg's handle.
  - New `sweepTranscribeTemp(dir)`: removes `ssw-transcribe-*` folders older than 6 h. Younger ones may belong to another running copy of the app.
  - `src/main/aiIpc.ts`: `registerAiIpc()` calls the sweep on `os.tmpdir()`, the folder `mkdtemp` uses.
- **Proving tests:**
  - "removes the temporary files at once when the app quits mid-transcription": the folder is gone as soon as the `will-quit` handler returns.
  - "sweeps temporary folders a crash left behind, but not young ones…".

## ai:AI-7: a Test that timed out reported "Cancelled.". **Fixed**

- **Re-verified:** the outer `AbortSignal.timeout(60 s)` fires during attempt 2 (2 × 30 s + backoff), and `callWithRetry` mapped every outer abort to `cancelled()`.
- **Change** (`src/main/ai/request.ts`): a new `stopped(o)` returns a timeout failure ("X took too long to answer") when `o.signal.reason` is a `TimeoutError`, and a cancel otherwise. It is used at both outer-abort checks and around the backoff sleep, because the outer timer can also fire there. I fixed the root cause here rather than only raising the outer limit in aiIpc.ts.
- **Proving test:** "report the caller's time limit as a time-out, not as cancelled". It covers a timeout during an attempt and during the backoff, and checks that a real cancel still says "Cancelled.".

## completeness:W4-01 / captions:CAP-4: the Captions tab never heard about provider changes. **Fixed (AI side)**

- **Re-verified:** at 48ed9a7, `ssw:ai-providers-changed` appears only in CaptionsPanel's listeners. Nothing dispatched it.
- **Change:**
  - `src/renderer/src/settings/SettingsButton.tsx` exports `AI_PROVIDERS_CHANGED_EVENT = 'ssw:ai-providers-changed'` next to `OPEN_SETTINGS_EVENT`. SettingsButton dispatches it on `window` when the dialog closes.
  - Through a new `onProvidersChanged` prop, SettingsDialog passes it on to `AiProvidersSection` as `onChanged`, which calls it after a save (add or edit) and after a successful remove. With a callback prop, AiProvidersSection does not need to import SettingsButton, so there is no import cycle.
  - The Captions tab side, which imports the constant, is the captions fixer's work.
- **Proving e2e** (`tests/e2e/ai.e2e.cjs`, Settings test): a page listener counts the event. It is 0 before any change, 1 right after the first add while Settings is still open, +1 after an edit, +1 after a remove, and +1 when Settings closes. Before the fix nothing dispatched the event, so the first count check would fail.

## completeness:W4-06: summaries promised. **Kept the promise, with text that is accurate for each provider kind**

The captions fixer is adding a Summarize tool, and the backend `summary` task works with all three kinds; aiProviders.test runs `summary` against OpenAI, Gemini and Claude. Here is what each kind can do:

| Kind | Transcription | Clean-up, translation, chapters, title, summary |
|---|---|---|
| OpenAI | yes | yes |
| Gemini | yes | yes |
| Claude | no | yes |

`canDo()` in providerText.ts already says exactly this. The Settings intro implied that only Claude does text tasks. It now says: "All three providers can clean up and translate a transcript and suggest chapters, a title or a summary for it; Anthropic Claude cannot transcribe (the Claude API does not accept sound)."

## Verification

All four steps were run on the final tree:

- `npm run typecheck`: passed.
- `npx vitest run --testTimeout=60000`: 114 files and 1477 tests passed.
- `npm run build`: passed.
- e2e, each run alone with `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/<file>`:
  - `ai.e2e.cjs`: **passed**, 4/4. This includes the new providers-changed event checks.
  - `audit-security.e2e.cjs`: **passed**, 2/2.
  - `smoke.e2e.cjs`: **passed**, 1/1.
  - `captions.e2e.cjs`: **4 of 5 passed, 1 failed:** "captions: Generate with no provider, with only Claude, and the error from a provider that fails".
    - **What fails:** the test clicks "Add an AI provider", which opens the Settings dialog. It then clicks "Check again" (captions.e2e.cjs:389) without closing the dialog. Playwright times out because `.settings-backdrop` intercepts pointer events.
    - **Not caused by this branch:** I built the base commit `48ed9a7` in a separate worktree and ran the same test with `SSW_E2E_ONLY`. It fails there in exactly the same way.
    - **Fix belongs to the captions fixer:** the file is outside my scope, so I did not change it. The test needs to close Settings (Done or Esc) before going on. With this branch, closing Settings dispatches `ssw:ai-providers-changed`, so the tab re-reads its providers without needing "Check again".

Keys never reach the renderer or the logs. The existing Settings e2e checks the DOM, storage and API answers. The new failure paths log nothing, and the messages come from provider error bodies, which never contain the key.
