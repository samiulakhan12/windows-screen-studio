/**
 * A scripted updater for development and the e2e tests (docs/design/auto-update.md §2): enabled only
 * in an unpackaged app whose SSW_UPDATES_FAKE names a scenario. Each step it takes is appended to
 * the SSW_UPDATES_FAKE_LOG file, so a test can see what Flown asked for.
 */
import fs from 'node:fs'
import type { UpdaterEvent } from '../../shared/updates/updates'
import type { UpdaterPort } from './updaterPort'

export const FAKE_SCENARIOS = ['available', 'none', 'error', 'download-error'] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]

export const isFakeScenario = (s: unknown): s is FakeScenario => typeof s === 'string' && (FAKE_SCENARIOS as readonly string[]).includes(s)

export const FAKE_VERSION = '9.9.9'
/** Release notes as GitHub gives them: HTML, with a script that must never run or show. */
export const FAKE_NOTES = '<h2>What&#39;s new</h2><ul><li>Faster <b>exports</b> &amp; fixes</li></ul><script>window.__pwned = 1</script>'

export interface FakeOptions {
  /** File each step is appended to (absent: none). */
  log?: string
  /** Quits the app (install). */
  quit: () => void
  /** Delay between events, ms. */
  step?: number
}

export function fakeUpdaterPort(scenario: FakeScenario, opts: FakeOptions): UpdaterPort {
  const listeners = new Set<(e: UpdaterEvent) => void>()
  const step = opts.step ?? 150
  const note = (line: string): void => {
    if (!opts.log) return
    try {
      fs.appendFileSync(opts.log, `${line}\n`)
    } catch {
      // A test that gave no writable file only loses its trace.
    }
  }
  const emit = (e: UpdaterEvent): void => {
    for (const l of listeners) l(e)
  }
  const later = (ms: number, fn: () => void): void => {
    setTimeout(fn, ms)
  }
  return {
    async check() {
      note('check')
      emit({ type: 'checking' })
      later(step, () => {
        if (scenario === 'none') emit({ type: 'none' })
        else if (scenario === 'error') emit({ type: 'error', stage: 'check', message: 'net::ERR_INTERNET_DISCONNECTED' })
        else emit({ type: 'available', version: FAKE_VERSION, notes: FAKE_NOTES })
      })
    },
    async download() {
      note('download')
      if (scenario === 'download-error') {
        later(step, () => emit({ type: 'progress', percent: 30 }))
        later(2 * step, () => emit({ type: 'error', stage: 'download', message: 'sha512 checksum mismatch' }))
        return
      }
      ;[25, 60, 100].forEach((percent, i) => later((i + 1) * step, () => emit({ type: 'progress', percent })))
      later(4 * step, () => emit({ type: 'downloaded', version: FAKE_VERSION, notes: FAKE_NOTES }))
    },
    install() {
      note(`install ${FAKE_VERSION}`)
      opts.quit()
    },
    setInstallOnQuit(on) {
      note(`install-on-quit ${on}`)
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
