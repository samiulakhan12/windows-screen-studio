import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { UpdaterPort } from '../src/main/updates/updaterPort'
import type { UpdaterEvent } from '../src/shared/updates/updates'

/**
 * The real electron-updater, driven by a stand-in app and a stand-in network (no request leaves
 * the test): what Flown's update check sends to GitHub.
 */
const h = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-updater-'))
  const config = path.join(dir, 'app-update.yml')
  fs.writeFileSync(config, 'provider: github\nowner: samiulakhan12\nrepo: windows-screen-studio\nupdaterCacheDirName: flown-updater\n')
  const app = {
    version: '0.7.1',
    name: 'Flown',
    isPackaged: true,
    appUpdateConfigPath: config,
    userDataPath: path.join(dir, 'userData'),
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    quit: () => undefined,
    relaunch: () => undefined,
    onQuit: () => undefined
  }
  return { dir, app, holder: { updater: null as unknown } }
})

vi.mock('electron-updater', async () => {
  const { NsisUpdater } = await import('electron-updater/out/NsisUpdater')
  h.holder.updater = new NsisUpdater(null, h.app as never)
  return { autoUpdater: h.holder.updater }
})

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }))

/**
 * Electron's app as far as a quit goes: before-quit, then (unless a window keeps Flown open, as the
 * recording's "Keep working" does) quit with exit code 0.
 */
function standInApp(): { app: EventEmitter & { quit(): void }; steps: string[]; keepOpen: { on: boolean } } {
  const steps: string[] = []
  const keepOpen = { on: false }
  const app = Object.assign(new EventEmitter(), {
    quit() {
      steps.push('quit asked')
      app.emit('before-quit', {})
      if (keepOpen.on) return
      steps.push('quit')
      app.emit('quit', {}, 0)
    }
  })
  return { app, steps, keepOpen }
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/v0.7.2</id>
<link rel="alternate" type="text/html" href="https://github.com/samiulakhan12/windows-screen-studio/releases/tag/v0.7.2"/>
<title>0.7.2</title><content type="html">&lt;p&gt;Fixes&lt;/p&gt;</content></entry></feed>`
const LATEST_YML = `version: 0.7.2
files:
  - url: Flown-Setup-0.7.2.exe
    sha512: ${'A'.repeat(86)}==
    size: 1000
path: Flown-Setup-0.7.2.exe
sha512: ${'A'.repeat(86)}==
releaseDate: '2026-10-30T10:00:00.000Z'
`

describe('the real updater (electronUpdaterPort)', () => {
  it('sends no per-install identifier with a check', async () => {
    const { NO_STAGING_ID, electronUpdaterPort } = await import('../src/main/updates/electronUpdaterPort')
    const port = await electronUpdaterPort(standInApp().app as never)
    const updater = h.holder.updater as { httpExecutor: unknown; _testOnlyOptions: unknown; logger: unknown }
    updater.logger = null
    updater._testOnlyOptions = { platform: 'win32' }
    const sent: { path: string; headers: Record<string, string> }[] = []
    updater.httpExecutor = {
      request: async (o: { path?: string; headers?: Record<string, string> }) => {
        sent.push({ path: o.path ?? '', headers: { ...(o.headers ?? {}) } })
        if (o.path?.endsWith('.atom')) return FEED
        if (o.path?.endsWith('/releases/latest')) return JSON.stringify({ tag_name: 'v0.7.2' })
        if (o.path?.endsWith('/latest.yml')) return LATEST_YML
        throw new Error(`unexpected request ${o.path}`)
      }
    }
    const events: UpdaterEvent[] = []
    port.on((e) => events.push(e))
    await port.check()
    expect(events.at(-1)).toMatchObject({ type: 'available', version: '0.7.2' })
    expect(sent.map((r) => r.path)).toEqual([
      '/samiulakhan12/windows-screen-studio/releases.atom',
      '/samiulakhan12/windows-screen-studio/releases/latest',
      '/samiulakhan12/windows-screen-studio/releases/download/v0.7.2/latest.yml'
    ])
    // electron-updater still keeps its random id on disk; it never leaves the PC.
    const id = fs.readFileSync(path.join(h.app.userDataPath, '.updaterId'), 'utf8')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    for (const r of sent) {
      expect(JSON.stringify(r.headers)).not.toContain(id)
      expect(r.headers['x-user-staging-id']).toBe(NO_STAGING_ID)
    }
  })

  /** The real port over a stand-in app; the installer start (quitAndInstall) is only recorded. */
  async function restartSetup(): Promise<ReturnType<typeof standInApp> & { port: UpdaterPort }> {
    const { electronUpdaterPort } = await import('../src/main/updates/electronUpdaterPort')
    const stand = standInApp()
    const port = await electronUpdaterPort(stand.app as never)
    const updater = h.holder.updater as { quitAndInstall(silent?: boolean, run?: boolean): void }
    vi.spyOn(updater, 'quitAndInstall').mockImplementation((silent, run) => {
      stand.steps.push(`installer ${silent ? 'silent' : 'shown'} ${run ? 'reopens' : 'stays closed'}`)
    })
    return { ...stand, port }
  }

  it('Restart now starts the installer only once Flown has really quit, and reopens Flown', async () => {
    const s = await restartSetup()
    s.port.setInstallOnQuit(true)
    s.port.install()
    expect(s.steps).toEqual(['quit asked', 'quit', 'installer silent reopens'])
  })

  it('Restart now that a window calls off (a recording being processed: "Keep working") installs nothing', async () => {
    const s = await restartSetup()
    s.port.setInstallOnQuit(true)
    s.keepOpen.on = true
    s.port.install()
    expect(s.steps).toEqual(['quit asked'])
    // Closing Flown later is an ordinary quit: electron-updater's own handler installs, without reopening.
    s.keepOpen.on = false
    s.app.quit()
    expect(s.steps).toEqual(['quit asked', 'quit asked', 'quit'])
  })

  it('Restart now never installs a release pulled meanwhile', async () => {
    const s = await restartSetup()
    s.port.setInstallOnQuit(false)
    s.port.install()
    expect(s.steps).toEqual(['quit asked', 'quit'])
    s.port.setInstallOnQuit(true)
  })
})
