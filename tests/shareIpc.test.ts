/**
 * Settings › Share through main's IPC handlers (docs/design/share.md §2.2): found folders (a fake
 * Windows profile, as the e2e uses) are offered only once their list has been seen, and changing
 * one of their "Use" switches counts as seeing them.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ShareTargets } from '../src/shared/api/share'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-share-ipc-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  picked: ''
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), isPackaged: false },
  session: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [h.picked] }) },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: { isSupported: () => false },
  net: {},
  shell: {}
}))
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({ isDestroyed: () => false }), windowIconPath: () => undefined }))
vi.mock('../src/main/exportIpc', () => ({ isExportedFile: () => false }))
vi.mock('../src/main/longJobs', () => ({ setNotificationExtras: () => undefined }))

import { registerShareIpc } from '../src/main/share/shareIpc'

const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href } }
const call = (channel: string, ...args: unknown[]): Promise<ShareTargets> => Promise.resolve(h.handlers.get(channel)!(appEvent, ...args) as ShareTargets)
const shareJson = (): { reviewed?: boolean; off?: string[] } => JSON.parse(readFileSync(path.join(h.root, 'userData', 'share.json'), 'utf8'))
const on = (t: ShareTargets): Record<string, boolean> => Object.fromEntries(t.folders.map((f) => [f.label, f.on]))

beforeAll(() => {
  // OneDrive from the registry, Dropbox from its info.json (cloudDetect's fake probe).
  const profile = path.join(h.root, 'winprofile')
  const roaming = path.join(profile, 'AppData', 'Roaming')
  const onedrive = path.join(profile, 'OneDrive')
  const dropbox = path.join(profile, 'Dropbox (Personal)')
  h.picked = path.join(h.root, 'Team share')
  for (const d of [onedrive, dropbox, path.join(roaming, 'Dropbox'), h.picked]) mkdirSync(d, { recursive: true })
  writeFileSync(path.join(roaming, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: dropbox } }))
  const reg = ['HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal', `    UserFolder    REG_SZ    ${onedrive}`, ''].join('\r\n')
  const fake = path.join(h.root, 'fake-cloud.json')
  writeFileSync(fake, JSON.stringify({ env: { USERPROFILE: profile, APPDATA: roaming }, registry: { 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts': reg } }))
  vi.stubEnv('SSW_SHARE_FAKE_CLOUD', fake)
  registerShareIpc()
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(h.root, { recursive: true, force: true })
})

// In order: the store is main's own, kept between the steps.
describe('Settings › Share found folders', () => {
  it('are not offered before their list is seen, and a switch of a folder of the user’s own does not count', async () => {
    const first = await call('share:targets')
    expect(first.reviewed).toBe(false)
    expect(on(first)).toEqual({ OneDrive: false, Dropbox: false })
    const picked = await call('share:pickFolder')
    const team = picked.folders.find((f) => f.source === 'picked')!
    const off = await call('share:setFolder', team.id, false)
    expect(off.reviewed).toBe(false)
    expect(on(off)).toEqual({ OneDrive: false, Dropbox: false, 'Team share': false })
    expect(shareJson().reviewed).toBe(false)
  })

  it('are seen when one of their switches is changed: the one turned off stays off, the others are offered', async () => {
    const dropbox = (await call('share:targets')).folders.find((f) => f.label === 'Dropbox')!
    const next = await call('share:setFolder', dropbox.id, false)
    expect(next.reviewed).toBe(true)
    expect(on(next)).toEqual({ OneDrive: true, Dropbox: false, 'Team share': false })
    expect(shareJson()).toMatchObject({ reviewed: true, off: expect.arrayContaining([dropbox.id]) })
  })
})
