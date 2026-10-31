import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, UPDATE_COPY, statusLine, type UpdaterEvent, type UpdateState } from '../src/shared/updates/updates'
import { DEFAULT_UPDATE_PREFS, UpdatePrefsStore, sanitizeUpdatePrefs, type UpdatePrefs } from '../src/main/updates/updatePrefs'
import { CHECK_TIMEOUT_MS, UpdateService, type Timers } from '../src/main/updates/updateService'
import type { UpdaterPort } from '../src/main/updates/updaterPort'

/** Timers run by hand: `tick(ms)` fires every timer due. */
function manualTimers() {
  let now = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      due.set(id, { at: now + ms, fn })
      return id
    },
    clear: (h) => void due.delete(h as number)
  }
  const tick = async (ms: number): Promise<void> => {
    const until = now + ms
    for (;;) {
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      due.delete(next[0])
      next[1].fn()
      await Promise.resolve()
    }
    now = until
  }
  return { timers, tick, pending: () => [...due.values()].map((t) => t.at - now).sort((a, b) => a - b) }
}

/** An updater whose events the test sends. */
function fakePort() {
  const listeners = new Set<(e: UpdaterEvent) => void>()
  const calls: string[] = []
  const port: UpdaterPort = {
    check: vi.fn(async () => void calls.push('check')),
    download: vi.fn(async () => void calls.push('download')),
    install: vi.fn(() => void calls.push('install')),
    setInstallOnQuit: vi.fn((on: boolean) => void calls.push(`install-on-quit ${on}`)),
    on: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return { port, calls, emit: (e: UpdaterEvent) => listeners.forEach((l) => l(e)), listeners }
}

function memPrefs(start: Partial<UpdatePrefs> = {}) {
  let v: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS, ...start }
  const writes: UpdatePrefs[] = []
  return {
    prefs: {
      get: () => ({ ...v }),
      set: (p: Partial<UpdatePrefs>) => {
        v = { ...v, ...p }
        writes.push({ ...v })
        return { ...v }
      }
    },
    writes
  }
}

function setup(opts: { auto?: boolean; busy?: string | null; port?: boolean } = {}) {
  const t = manualTimers()
  const f = fakePort()
  const p = memPrefs({ auto: opts.auto ?? true })
  const states: UpdateState[] = []
  const afterCheck = vi.fn()
  const svc = new UpdateService({
    port: opts.port === false ? null : f.port,
    current: '0.7.1',
    prefs: p.prefs,
    busy: () => opts.busy ?? null,
    onChange: (s) => states.push(s),
    afterCheck,
    timers: t.timers,
    now: () => new Date('2026-10-30T10:00:00Z')
  })
  return { svc, ...t, ...f, ...p, states, afterCheck }
}

describe('UpdateService (docs/design/auto-update.md §1.5)', () => {
  it('checks 30 s after start, then every 4 h, and downloads what it finds when automatic', async () => {
    const s = setup()
    s.svc.start()
    expect(s.pending()).toEqual([FIRST_CHECK_MS])
    await s.tick(FIRST_CHECK_MS)
    expect(s.calls).toEqual(['check'])
    s.emit({ type: 'checking' })
    s.emit({ type: 'available', version: '0.7.2', notes: 'Notes' })
    await Promise.resolve()
    expect(s.calls).toEqual(['check', 'download'])
    expect(s.svc.get()).toMatchObject({ phase: 'downloading', version: '0.7.2', percent: 0 })
    expect(s.writes.at(-1)?.lastCheck).toBe('2026-10-30T10:00:00.000Z')
    expect(s.afterCheck).toHaveBeenCalledTimes(1)
    expect(s.pending()).toEqual([CHECK_EVERY_MS])
    s.emit({ type: 'progress', percent: 50 })
    s.emit({ type: 'downloaded', version: '0.7.2' })
    expect(s.svc.get()).toMatchObject({ phase: 'ready', version: '0.7.2' })
    expect(s.calls).toContain('install-on-quit true')
  })

  it('with automatic updates off: no automatic check, a manual check only finds, Download fetches', async () => {
    const s = setup({ auto: false })
    s.svc.start()
    expect(s.pending()).toEqual([])
    await s.svc.check()
    s.emit({ type: 'available', version: '0.7.2' })
    await Promise.resolve()
    expect(s.calls).toEqual(['check'])
    expect(s.svc.get().phase).toBe('available')
    await s.svc.download()
    expect(s.calls).toEqual(['check', 'download'])
  })

  it('turning automatic updates on schedules a check and downloads a release already found; off stops checks', async () => {
    const s = setup({ auto: false })
    await s.svc.check()
    s.emit({ type: 'available', version: '0.7.2' })
    s.svc.setAuto(true)
    await Promise.resolve()
    expect(s.writes.at(-1)?.auto).toBe(true)
    expect(s.calls).toContain('download')
    expect(s.pending()).toEqual([FIRST_CHECK_MS])
    s.svc.setAuto(false)
    expect(s.pending()).toEqual([])
    expect(s.svc.get().auto).toBe(false)
  })

  it('refuses Restart now while something runs, and without a downloaded update', () => {
    const busy = setup({ busy: 'Finish or stop the export first.' })
    expect(busy.svc.install()).toEqual({ ok: false, reason: UPDATE_COPY.notReady })
    busy.emit({ type: 'available', version: '0.7.2' })
    busy.emit({ type: 'downloaded', version: '0.7.2' })
    expect(busy.svc.install()).toEqual({ ok: false, reason: 'Finish or stop the export first.' })
    expect(busy.calls).not.toContain('install')
    const free = setup()
    free.emit({ type: 'available', version: '0.7.2' })
    free.emit({ type: 'downloaded', version: '0.7.2' })
    expect(free.svc.install()).toEqual({ ok: true })
    expect(free.calls).toContain('install')
  })

  it('a release pulled after it was downloaded no longer installs at quit', async () => {
    const s = setup({ auto: false })
    s.emit({ type: 'available', version: '0.7.2' })
    s.emit({ type: 'downloaded', version: '0.7.2' })
    await s.svc.check()
    s.emit({ type: 'none' })
    expect(s.svc.get().phase).toBe('idle')
    expect(s.calls.at(-1)).toBe('install-on-quit false')
  })

  it('a downloaded release that was pulled no longer installs at quit when the check offers another version', async () => {
    const s = setup()
    await s.svc.check()
    s.emit({ type: 'available', version: '0.7.3' })
    s.emit({ type: 'downloaded', version: '0.7.3' })
    expect(s.svc.get()).toMatchObject({ phase: 'ready', version: '0.7.3' })
    s.calls.length = 0
    // 0.7.3 is pulled: the latest release is 0.7.2, still newer than this copy.
    await s.svc.check()
    s.emit({ type: 'available', version: '0.7.2' })
    await Promise.resolve()
    expect(s.calls).toEqual(['check', 'install-on-quit false', 'download'])
    expect(s.svc.get()).toMatchObject({ phase: 'downloading', version: '0.7.2' })
    s.emit({ type: 'downloaded', version: '0.7.2' })
    expect(s.svc.get()).toMatchObject({ phase: 'ready', version: '0.7.2' })
    expect(s.calls.at(-1)).toBe('install-on-quit true')
  })

  it('a check that offers the version already downloaded keeps it ready', async () => {
    const s = setup()
    s.emit({ type: 'available', version: '0.7.3' })
    s.emit({ type: 'downloaded', version: '0.7.3' })
    s.calls.length = 0
    await s.svc.check()
    s.emit({ type: 'available', version: '0.7.3' })
    await Promise.resolve()
    expect(s.calls).toEqual(['check'])
    expect(s.svc.get()).toMatchObject({ phase: 'ready', version: '0.7.3', lastCheck: '2026-10-30T10:00:00.000Z' })
  })

  it('a check that never answers fails after the timeout, and checks go on', async () => {
    const s = setup()
    s.svc.start()
    await s.tick(FIRST_CHECK_MS)
    expect(s.svc.get().phase).toBe('idle')
    await s.tick(CHECK_TIMEOUT_MS)
    expect(s.svc.get()).toMatchObject({ phase: 'error', error: UPDATE_COPY.checkFailed })
    expect(s.pending()).toEqual([CHECK_EVERY_MS])
    await s.tick(CHECK_EVERY_MS)
    expect(s.calls.filter((c) => c === 'check')).toHaveLength(2)
  })

  it('never checks twice at once, nor during a download; a failed download is tried again', async () => {
    const s = setup({ auto: false })
    await s.svc.check()
    await s.svc.check()
    expect(s.calls).toEqual(['check'])
    s.emit({ type: 'available', version: '0.7.2' })
    await s.svc.download()
    await s.svc.check()
    expect(s.calls).toEqual(['check', 'download'])
    s.emit({ type: 'error', stage: 'download', message: 'x' })
    expect(s.svc.get()).toMatchObject({ phase: 'error', error: UPDATE_COPY.downloadFailed })
    // Automatic updates are off: nothing tries again by itself, and the status line says so.
    expect(s.pending()).toEqual([])
    expect(statusLine(s.svc.get())).toBe(UPDATE_COPY.downloadFailedManual)
    await s.svc.download()
    expect(s.calls).toEqual(['check', 'download', 'download'])
  })

  it('a build that cannot update itself is disabled and does nothing', async () => {
    const s = setup({ port: false })
    s.svc.start()
    expect(s.svc.get()).toMatchObject({ phase: 'disabled', auto: false })
    await s.svc.check()
    expect(s.svc.setAuto(true).auto).toBe(false)
    expect(s.svc.install().ok).toBe(false)
    expect(s.pending()).toEqual([])
  })

  it('dispose stops the schedule and the events', () => {
    const s = setup()
    s.svc.start()
    s.svc.dispose()
    expect(s.pending()).toEqual([])
    expect(s.listeners.size).toBe(0)
  })
})

describe('userData/updates.json', () => {
  it('defaults, sanitizes and writes atomically', () => {
    expect(sanitizeUpdatePrefs(null)).toEqual({ auto: true, lastCheck: null })
    expect(sanitizeUpdatePrefs({ auto: 'no', lastCheck: 'yesterday' })).toEqual({ auto: true, lastCheck: null })
    expect(sanitizeUpdatePrefs({ auto: false, lastCheck: '2026-10-30T10:00:00.000Z' })).toEqual({ auto: false, lastCheck: '2026-10-30T10:00:00.000Z' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-updates-'))
    try {
      const file = path.join(dir, 'updates.json')
      fs.writeFileSync(file, '{bad')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const store = new UpdatePrefsStore(file)
      expect(store.get()).toEqual(DEFAULT_UPDATE_PREFS)
      warn.mockRestore()
      store.set({ auto: false })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, auto: false, lastCheck: null })
      expect(new UpdatePrefsStore(file).get()).toEqual({ auto: false, lastCheck: null })
      expect(fs.readdirSync(dir)).toEqual(['updates.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
