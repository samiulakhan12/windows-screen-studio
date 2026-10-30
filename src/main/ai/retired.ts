/**
 * A failed request to a model its maker has retired, as the plain message saying what to do
 * (NW-09, docs/design/transcription.md §5; the wording is shared/captions/retiredModel.ts). The
 * provider clients wrap their requests with it.
 */
import { app } from 'electron'
import { retiredMessage, todayUtc } from '../../shared/captions/retiredModel'
import type { AiProviderKind } from '../../shared/types'
import { modelList } from './modelList'
import { AiError } from './request'

/** Today (UTC); SSW_AI_TODAY (YYYY-MM-DD) stands in for it in the end-to-end tests, never in a packaged app. */
export function today(): string {
  const hook = app.isPackaged ? undefined : process.env.SSW_AI_TODAY
  return hook && /^\d{4}-\d{2}-\d{2}$/.test(hook) ? hook : todayUtc()
}

/** `err` as the plain "retired" failure when `model` is on the retiring list and its day has come, else `err` itself. */
export function retiredFailure(err: unknown, kind: AiProviderKind, model: string, use: 'transcription' | 'text', day = today()): unknown {
  if (!(err instanceof AiError)) return err
  const message = retiredMessage(modelList(), kind, model, day, use, err.failure.kind, err.failure.status)
  return message ? new AiError({ kind: 'not-found', retryable: false, message }) : err
}
