/**
 * What the text reader helper's users share (docs/design/auto-blur.md §5.5, §5.6, §5.11, §10.6): the
 * helper's error and what a run makes of it, the pause while Flown records, and the lines the careful
 * pass reads again. One place for readerHelper, the scan, findIpc and the rules' worker; nothing here
 * starts a process or needs Electron.
 */
import type { FindFailure } from '../../shared/api/privacy'
import { needsCareful, type Hit } from '../../shared/privacy/detect/detect'
import type { HelperEvent, ReadResult, ReadVariant } from '../../shared/privacy/protocol'

/** Why a command failed: the helper's own error kinds, and what main saw happen to the helper. */
export type HelperFailure = Extract<HelperEvent, { error: string }>['error'] | 'crashed' | 'silent' | 'protocol' | 'missing'

export class HelperError extends Error {
  constructor(readonly kind: HelperFailure) {
    super(`ssw-ocr: ${kind}`)
    this.name = 'HelperError'
  }
}

/**
 * What ends a Find, from what the helper did (§2.6): `tooLarge`, the files refused (`reader`, the
 * state then `damaged`), no helper that runs here (`helper`), a recording ffmpeg cannot read
 * (`video`), the helper ending or going silent (`crashed`: the scan starts it once more, and only a
 * second death ends Find), anything else `failed`.
 */
export function findFailureOf(err: unknown): FindFailure {
  if (!(err instanceof HelperError)) return 'failed'
  switch (err.kind) {
    case 'tooLarge':
      return 'tooLarge'
    case 'model':
      return 'reader'
    case 'missing':
    case 'protocol':
      return 'helper'
    case 'video':
      return 'video'
    case 'crashed':
    case 'silent':
      return 'crashed'
    default:
      return 'failed'
  }
}

/**
 * Polls whether Flown records (every `everyMs`, 2 s) and pauses the helper while it does (§5.11):
 * `onWaiting` gets true and false as it turns. `helper` is asked each time, so a helper the scan
 * started again after a death is the one paused. Returns the stop, which resumes a paused helper.
 */
export function pauseWhileRecording(helper: { pause(): void; resume(): void }, recording: () => boolean, onWaiting: (waiting: boolean) => void, everyMs = 2000): () => void {
  let paused = false
  const check = (): void => {
    let now = false
    try {
      now = recording()
    } catch {
      now = false
    }
    if (now === paused) return
    paused = now
    if (now) helper.pause()
    else helper.resume()
    onWaiting(now)
  }
  check()
  const timer = setInterval(check, everyMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (paused) {
      paused = false
      helper.resume()
      onWaiting(false)
    }
  }
}

/**
 * The lines of a read the careful pass reads again (careful-long, §5.6, question 16): those P3's
 * `needsCareful` picks with the read's hits (a rule hit, a confidence under 0.9, or a run of 16
 * or more token characters). Empty: the read is released instead.
 */
export function carefulLines(result: Pick<ReadResult, 'lines'>, hits: readonly Hit[]): number[] {
  return result.lines.flatMap((line, i) => (needsCareful(line, hits, i) ? [i] : []))
}

/** `result` with the careful pass's variants added to the lines they were asked for, in order. */
export function withCareful<R extends Pick<ReadResult, 'lines'>>(result: R, lines: readonly number[], careful: readonly ReadVariant[][]): R {
  const extra = new Map(lines.map((l, k) => [l, careful[k] ?? []] as const))
  return { ...result, lines: result.lines.map((line, i) => (extra.get(i)?.length ? { ...line, variants: [...line.variants, ...extra.get(i)!] } : line)) }
}
