import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloudCandidates, folderId, linkHint, normalizeFolderPath, parseRegQuery, sourceText, type CloudInput } from '../src/shared/share/cloudFolders'
import { detectCloudFolders, fakeProbe } from '../src/main/share/cloudDetect'

const win = path.win32.join

const ONEDRIVE_REG = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts',
  '    LastUpdate    REG_QWORD    0x1',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal',
  '    UserFolder    REG_SZ    C:\\Users\\Ana Lee\\OneDrive',
  '    cid    REG_SZ    abc',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1',
  '    DisplayName    REG_SZ    Contoso Ltd',
  '    UserFolder    REG_SZ    C:\\Users\\Ana Lee\\OneDrive - Contoso Ltd',
  '    Timer Interval    REG_DWORD    0x10',
  ''
].join('\r\n')

const DRIVEFS_REG = [
  'HKEY_CURRENT_USER\\Software\\Google\\DriveFS',
  '    PerAccountPreferences    REG_SZ    {"per_account_preferences":[{"key":"1","value":{"mount_point_path":"H"}}]}',
  ''
].join('\r\n')

const input = (over: Partial<CloudInput> = {}): CloudInput => ({
  env: { USERPROFILE: 'C:\\Users\\Ana Lee', OneDrive: 'C:\\Users\\Ana Lee\\OneDrive' },
  registry: {},
  dropboxInfo: [],
  driveLetters: true,
  join: win,
  ...over
})

describe('parseRegQuery', () => {
  it('reads string values by key, with spaces in names and data', () => {
    const reg = parseRegQuery(ONEDRIVE_REG)
    expect(reg['hkcu\\software\\microsoft\\onedrive\\accounts\\personal'].userfolder).toBe('C:\\Users\\Ana Lee\\OneDrive')
    expect(reg['hkcu\\software\\microsoft\\onedrive\\accounts\\business1'].displayname).toBe('Contoso Ltd')
    // Numbers are not kept.
    expect(reg['hkcu\\software\\microsoft\\onedrive\\accounts\\business1']['timer interval']).toBeUndefined()
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toEqual({})
  })
})

describe('cloudCandidates', () => {
  it('lists what the apps report first, then the usual places, each folder once', () => {
    const list = cloudCandidates(
      input({
        registry: { ...parseRegQuery(ONEDRIVE_REG), ...parseRegQuery(DRIVEFS_REG) },
        dropboxInfo: ['not json', JSON.stringify({ personal: { path: 'D:\\Dropbox' }, business: { path: 'D:\\Dropbox (Contoso)' } })]
      })
    )
    expect(list).toEqual([
      { service: 'onedrive', label: 'OneDrive', path: 'C:\\Users\\Ana Lee\\OneDrive', source: 'app' },
      { service: 'onedrive', label: 'OneDrive – Contoso Ltd', path: 'C:\\Users\\Ana Lee\\OneDrive - Contoso Ltd', source: 'app' },
      { service: 'dropbox', label: 'Dropbox', path: 'D:\\Dropbox', source: 'app' },
      { service: 'dropbox', label: 'Dropbox (work)', path: 'D:\\Dropbox (Contoso)', source: 'app' },
      { service: 'dropbox', label: 'Dropbox', path: 'C:\\Users\\Ana Lee\\Dropbox', source: 'usual' },
      { service: 'gdrive', label: 'Google Drive', path: 'H:\\My Drive', source: 'app' },
      { service: 'gdrive', label: 'Google Drive', path: 'G:\\My Drive', source: 'usual' },
      { service: 'gdrive', label: 'Google Drive', path: 'C:\\Users\\Ana Lee\\My Drive', source: 'usual' },
      { service: 'gdrive', label: 'Google Drive', path: 'C:\\Users\\Ana Lee\\Google Drive', source: 'usual' }
    ])
  })

  it('takes the same folder once whatever its case or separators', () => {
    const list = cloudCandidates(input({ env: { OneDriveConsumer: 'c:/users/ana lee/onedrive/', OneDrive: 'C:\\Users\\Ana Lee\\OneDrive' } }))
    expect(list.filter((c) => c.service === 'onedrive')).toHaveLength(1)
  })

  it('uses no drive letters off Windows', () => {
    const list = cloudCandidates(input({ driveLetters: false, registry: parseRegQuery(DRIVEFS_REG) }))
    expect(list.some((c) => c.path.startsWith('G:') || c.path.startsWith('H:'))).toBe(false)
  })

  it('gives stable ids and says where each folder came from', () => {
    expect(folderId('C:\\Users\\Ana\\OneDrive')).toBe(folderId('c:/users/ana/onedrive/'))
    expect(folderId('C:\\Users\\Ana\\OneDrive')).toMatch(/^cf[0-9a-f]{10}$/)
    expect(folderId('C:\\A')).not.toBe(folderId('C:\\B'))
    expect(normalizeFolderPath('C:\\')).toBe('c:\\')
    expect(sourceText('onedrive', 'app')).toBe("Found in OneDrive's settings")
    expect(sourceText('dropbox', 'usual')).toBe('Found at the usual place')
    expect(sourceText('folder', 'picked')).toBe('Added by you')
    expect(linkHint('dropbox')).toContain('Copy Dropbox link')
  })
})

describe('detectCloudFolders', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-cloud-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps only folders that exist, from a fake Windows profile', async () => {
    const home = path.join(dir, 'home')
    mkdirSync(path.join(home, 'OneDrive'), { recursive: true })
    mkdirSync(path.join(home, 'AppData', 'Roaming', 'Dropbox'), { recursive: true })
    mkdirSync(path.join(dir, 'Box'), { recursive: true })
    writeFileSync(path.join(home, 'AppData', 'Roaming', 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: path.join(dir, 'Box') } }))
    const fake = path.join(dir, 'fake.json')
    writeFileSync(
      fake,
      JSON.stringify({
        env: { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), OneDrive: path.join(home, 'OneDrive') },
        registry: { 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts': `HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1\r\n    UserFolder    REG_SZ    ${path.join(dir, 'gone')}\r\n` }
      })
    )
    const found = await detectCloudFolders(fakeProbe(fake))
    expect(found.map((f) => [f.service, f.path, f.source])).toEqual([
      ['onedrive', path.join(home, 'OneDrive'), 'app'],
      ['dropbox', path.join(dir, 'Box'), 'app']
    ])
  })

  it('finds nothing, without failing, when the fake file is missing', async () => {
    expect(await detectCloudFolders(fakeProbe(path.join(dir, 'none.json')))).toEqual([])
  })
})
