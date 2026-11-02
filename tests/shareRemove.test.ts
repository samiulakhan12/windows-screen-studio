/**
 * Settings › Share: Remove never turns a copy on (docs/design/share.md §2.2). A folder the user
 * added and turned off stays off when they remove it, whether a cloud app reports its path before
 * the found folders were seen or only later, so the export's remembered choices never copy into it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ShareTargets } from '../src/shared/api/share'
import { folderId } from '../src/shared/share/cloudFolders'
import { switchOn } from '../src/shared/share/onScreen'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-share-remove-')) as string,
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
import { choicesFor, withChoices } from '../src/shared/share/choices'
import { offeredIds } from '../src/renderer/src/share/useShare'

const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href } }
const call = (channel: string, ...args: unknown[]): Promise<ShareTargets> => Promise.resolve(h.handlers.get(channel)!(appEvent, ...args) as ShareTargets)
const folder = (t: ShareTargets, id: string) => t.folders.find((f) => f.id === id)

const paths = { team: '', box: '', info: '' }

beforeAll(() => {
  const profile = path.join(h.root, 'winprofile')
  const roaming = path.join(profile, 'AppData', 'Roaming')
  const onedrive = path.join(profile, 'OneDrive')
  paths.team = path.join(profile, 'Dropbox (Contoso)')
  paths.box = path.join(profile, 'Box share')
  for (const d of [onedrive, paths.team, paths.box, path.join(roaming, 'Dropbox')]) mkdirSync(d, { recursive: true })
  paths.info = path.join(roaming, 'Dropbox', 'info.json')
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
describe('Removing a folder of the user’s own that is turned off', () => {
  it('keeps it off when its cloud app reports it before the found folders were seen: removing it is seeing them', async () => {
    h.picked = paths.team
    const picked = await call('share:pickFolder')
    const id = folderId(paths.team)
    const choices = withChoices({ v: 1, byPreset: {} }, 'youtube', [id], offeredIds(picked))
    expect(choicesFor(choices, 'youtube', offeredIds(picked))).toEqual([id])
    const off = await call('share:setFolder', id, false)
    expect(off.reviewed).toBe(false)
    // Dropbox now names it as its work folder: still listed as the user's own, off, with Remove.
    writeFileSync(paths.info, JSON.stringify({ business: { path: paths.team } }))
    const found = await call('share:targets', true)
    expect(folder(found, id)).toMatchObject({ source: 'picked', on: false })
    const removed = await call('share:setFolder', id, null)
    expect(removed.reviewed).toBe(true)
    expect(folder(removed, id)).toMatchObject({ source: 'app', on: false })
    expect(switchOn(folder(removed, id)!, removed.reviewed)).toBe(false)
    expect(choicesFor(choices, 'youtube', offeredIds(removed))).toEqual([])
  })

  it('keeps it off when its cloud app reports it only after it was removed, without Settings being opened again', async () => {
    // Settings › Share has been seen: found folders are offered from now on.
    expect((await call('share:targets', false, true)).reviewed).toBe(true)
    h.picked = paths.box
    const picked = await call('share:pickFolder')
    const id = folderId(paths.box)
    const choices = withChoices({ v: 1, byPreset: {} }, 'youtube', [id], offeredIds(picked))
    await call('share:setFolder', id, false)
    const removed = await call('share:setFolder', id, null)
    expect(folder(removed, id)).toBeUndefined()
    // Later Dropbox reports it as its personal folder.
    writeFileSync(paths.info, JSON.stringify({ business: { path: paths.team }, personal: { path: paths.box } }))
    const later = await call('share:targets', true)
    expect(folder(later, id)).toMatchObject({ source: 'app', on: false })
    expect(choicesFor(choices, 'youtube', offeredIds(later))).toEqual([])
  })
})
