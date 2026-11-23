import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * Main's privacy channels and the names kept out of logs (docs/design/auto-blur.md §10.6, §10.7;
 * §17.1 tests 32 and 35): every request checked, its sender first.
 */

const h = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(), root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'flown-autoblur-ipc-'))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  app: { getPath: () => h.root, isPackaged: false, getAppPath: () => h.root },
  clipboard: {},
  screen: {},
  shell: {},
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('../src/main/security', () => ({ isAppUrl: (url: string) => url === 'file:///flown/index.html' }))
vi.mock('../src/main/projects', () => ({ readProject: async () => ({ duration: 60 }), listProjects: async () => [], projectsRoot: () => h.root }))

const { PRIVACY_CHANNELS, validateCopiesRequest, validateEverywhereRequest, validateFindRequest, validateFollowRequest, validateUnderCoverRequest } = await import('../src/shared/api/privacy')
const { registerFindIpc } = await import('../src/main/privacy/findIpc')
const { registerReaderIpc } = await import('../src/main/privacy/readerIpc')
const { privateNames, redactPrivateNames, setPrivateNames } = await import('../src/main/privacy/names')
const { AppLog } = await import('../src/main/appLog')
const { collectDiagnostics, diagnosticsText } = await import('../src/main/diagnostics')
const { scrubSecrets, secretValues } = await import('../src/main/ai/secrets')

afterAll(() => {
  setPrivateNames([])
  rmSync(h.root, { recursive: true, force: true })
})

const app = { senderFrame: { url: 'file:///flown/index.html' } }
const other = { senderFrame: { url: 'https://example.com/' } }

const find = { projectId: 'rec-20261120-100000', requestId: 'r1', kinds: ['email', 'key'], regions: ['DE'], names: ['Priya Raman'], neverHide: [] }
const follow = { projectId: 'rec-20261120-100000', requestId: 'r2', t: 2, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, start: 1, end: 4, path: '1 0.1 0.1 0.2 0.05' }
const under = { projectId: 'rec-20261120-100000', requestId: 'r3', t: 2, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }
const everywhere = { projectId: 'rec-20261120-100000', requestId: 'r4', remember: 'project' }
const copies = { projectId: 'rec-20261120-100000', copyIds: ['rec-20261121-090000'] }

describe('auto-blur contracts: main', () => {
  it("32. Validators and senders: each validator refuses what §10.7 refuses and accepts a valid request unchanged; every privacy:* handler refuses another sender's frame before validating, the download's included", async () => {
    expect(validateFindRequest(find)).toBe(find)
    for (const bad of [
      { ...find, projectPath: 'C:\\Users\\a\\Videos' },
      { ...find, projectId: '../x' },
      { ...find, projectId: 'C:\\x' },
      { ...find, kinds: ['email', 'secretsauce'] },
      { ...find, names: new Array(401).fill('Ana') },
      { ...find, names: ['x'.repeat(81)] },
      { ...find, names: ['two\nlines'] },
      { ...find, regions: ['de'] },
      { ...find, regions: ['DEU'] },
      { ...find, only: 'all' }
    ])
      expect(validateFindRequest(bad), JSON.stringify(bad).slice(0, 80)).toBeNull()
    expect(validateFindRequest({ ...find, names: new Array(400).fill('Ana') })).not.toBeNull()
    expect(validateFindRequest({ ...find, names: ['x'.repeat(80)] })).not.toBeNull()
    expect(validateFollowRequest(follow, 60)).toBe(follow)
    expect(validateUnderCoverRequest(under, 60)).toBe(under)
    const box = (b: unknown) => ({ ...follow, box: b })
    for (const bad of [box({ x: NaN, y: 0, w: 0.1, h: 0.1 }), box({ x: 0.95, y: 0, w: 0.1, h: 0.1 }), box({ x: -0.1, y: 0, w: 0.1, h: 0.1 }), box({ x: 0, y: 0, w: Infinity, h: 0.1 }), { ...follow, t: 61 }, { ...follow, start: -1 }, { ...follow, end: 0.5 }, { ...follow, path: '1e3 0 0 0.1 0.1' }, { ...follow, path: '1 0 0 0.1 0.1;'.repeat(4001) }])
      expect(validateFollowRequest(bad, 60)).toBeNull()
    expect(validateFollowRequest({ ...follow, path: Array.from({ length: 4001 }, (_v, i) => `${i} 0 0 0.1 0.1`).join(';') }, 1e6)).toBeNull()
    for (const bad of [{ ...under, t: Infinity }, { ...under, t: 61 }, { ...under, box: { x: 0, y: 0.99, w: 0.1, h: 0.1 } }, { ...under, extra: 1 }]) expect(validateUnderCoverRequest(bad, 60)).toBeNull()
    expect(validateEverywhereRequest(everywhere)).toBe(everywhere)
    expect(validateEverywhereRequest({ ...everywhere, remember: 'always' })).toBeNull()
    expect(validateCopiesRequest(copies)).toBe(copies)
    expect(validateCopiesRequest({ ...copies, copyIds: ['../../x'] })).toBeNull()

    registerFindIpc()
    registerReaderIpc()
    const channels = Object.values(PRIVACY_CHANNELS).filter((c) => h.handlers.has(c))
    // Every invoke channel has a handler (events are main's to send).
    expect(channels.sort()).toEqual(Object.values(PRIVACY_CHANNELS).filter((c) => !/Progress$/.test(c)).sort())
    const valid: Record<string, unknown[]> = {
      [PRIVACY_CHANNELS.find]: [find],
      [PRIVACY_CHANNELS.stopFind]: [find.projectId],
      [PRIVACY_CHANNELS.follow]: [follow],
      [PRIVACY_CHANNELS.underCover]: [under],
      [PRIVACY_CHANNELS.everywhere]: [everywhere],
      [PRIVACY_CHANNELS.copies]: [find.projectId],
      [PRIVACY_CHANNELS.coverCopies]: [copies],
      [PRIVACY_CHANNELS.originCovers]: [find.projectId],
      [PRIVACY_CHANNELS.names]: [['Priya Raman']]
    }
    for (const c of channels) {
      const fn = h.handlers.get(c)!
      const args = valid[c] ?? []
      // Another frame is refused first, with a valid request and with an invalid one.
      await expect(Promise.resolve().then(() => fn(other, ...args)), c).rejects.toThrow('Not allowed')
      await expect(Promise.resolve().then(() => fn(other, { bad: true })), c).rejects.toThrow('Not allowed')
      await expect(Promise.resolve().then(() => fn({}, ...args)), c).rejects.toThrow('Not allowed')
      if (c === PRIVACY_CHANNELS.downloadReader) continue
      await expect(Promise.resolve().then(() => fn(app, ...args)), c).resolves.not.toThrow()
      if (args.length) await expect(Promise.resolve().then(() => fn(app, { bad: true })), c).rejects.toThrow('Invalid request')
    }
    // The download starts nothing before the reader's part exists.
    await expect(Promise.resolve().then(() => h.handlers.get(PRIVACY_CHANNELS.downloadReader)!(app))).rejects.toThrow()
  })

  it('35. Names in logs: with "Priya Raman" listed, a log line holding it is written with <secret>; *Acme redacts "Acme"; a two-letter entry is not used; diagnostics hold no name', async () => {
    setPrivateNames(['Priya Raman', '*Acme', 'Jo', 'bad\nname'])
    expect(privateNames()).toEqual(['Priya Raman', 'Acme'])
    expect(redactPrivateNames('Sent to priya raman at ACME today, Jo says hi')).toBe('Sent to <secret> at <secret> today, Jo says hi')
    expect(secretValues()).toEqual(expect.arrayContaining(['Priya Raman', 'Acme']))
    expect(scrubSecrets('Provider said: unknown user Priya Raman of Acme')).toBe('Provider said: unknown user <secret> of <secret>')
    const dir = path.join(h.root, 'logs')
    const log = new AppLog(dir, {}, { maxBytes: 1 << 20, flushMs: 10_000, lineMax: 2000 }, () => new Date(Date.UTC(2026, 10, 20)))
    log.write('info', ['Exported the video for %s at Acme', 'Priya Raman'])
    await log.flush()
    const text = readFileSync(log.file, 'utf8')
    expect(text).toContain('Exported the video for <secret> at <secret>')
    expect(text).not.toMatch(/Priya|Raman|Acme/)
    const report = await collectDiagnostics({
      app: () => ({ name: 'Flown', version: '0.7.0', electron: '44.9.3', chrome: '140', node: '22', packaged: true }),
      system: async () => ({ os: 'Windows', build: '10.0.26100', arch: 'x64', cpu: 'Test CPU', cores: 8, memoryGB: 16 }),
      displays: async () => [],
      gpu: async () => ({ devices: [], features: {} }),
      encoders: async () => [],
      probe: async () => ({ supported: true, windowCapture: true, cursorToggle: true, borderToggle: false, hardwareEncoders: [], reason: null }),
      lastCapture: async () => null,
      recordings: async () => 1,
      jobs: () => ['export for Priya Raman 42%'],
      log: async () => ['2026-11-20T12:00:00.000Z WARN Could not send to Priya Raman', '2026-11-20T12:00:01.000Z INFO acme'],
      roots: {},
      now: () => new Date('2026-11-20T12:00:00.000Z')
    })
    const out = diagnosticsText(report, {})
    expect(out).toContain('WARN Could not send to <secret>')
    expect(out).not.toMatch(/Priya|Raman|acme/i)
    setPrivateNames([])
    expect(redactPrivateNames('Priya Raman')).toBe('Priya Raman')
  })
})
