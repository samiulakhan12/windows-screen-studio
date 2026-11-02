import { describe, expect, it } from 'vitest'
import { folderPlaces, hookPlaces, withPlace } from '../src/shared/share/names'

const names = (folders: { id: string; label: string; path: string }[]): string[] => {
  const places = folderPlaces(folders)
  return folders.map((f) => withPlace(f.label, places.get(f.id)))
}

describe('destination names', () => {
  it('leaves a label of its own alone', () => {
    expect(names([{ id: 'a', label: 'OneDrive', path: 'C:\\Users\\me\\OneDrive' }, { id: 'b', label: 'Dropbox', path: 'C:\\Users\\me\\Dropbox' }])).toEqual(['OneDrive', 'Dropbox'])
  })

  it('says where each folder is when two share a label', () => {
    // Drive for desktop with two Google accounts.
    expect(names([{ id: 'a', label: 'Google Drive', path: 'G:\\My Drive' }, { id: 'b', label: 'Google Drive', path: 'h:\\My Drive' }])).toEqual(['Google Drive (G:)', 'Google Drive (H:)'])
    // Two added folders with the same name, one on a network share.
    expect(names([{ id: 'a', label: 'Videos', path: 'D:\\Videos' }, { id: 'b', label: 'videos', path: '\\\\nas\\team\\videos' }])).toEqual(['Videos (D:)', 'videos (nas)'])
    // Same drive: the folder's own name, then its parent too.
    expect(names([{ id: 'a', label: 'Google Drive', path: 'C:\\Users\\me\\My Drive' }, { id: 'b', label: 'Google Drive', path: 'C:\\Users\\me\\Google Drive' }])).toEqual([
      'Google Drive (My Drive)',
      'Google Drive (Google Drive)'
    ])
    expect(names([{ id: 'a', label: 'Videos', path: 'C:\\a\\Videos' }, { id: 'b', label: 'Videos', path: 'C:\\b\\Videos' }])).toEqual(['Videos (a\\Videos)', 'Videos (b\\Videos)'])
    // Only the folders that share the label get a place.
    expect(names([{ id: 'a', label: 'Dropbox', path: 'D:\\Dropbox' }, { id: 'b', label: 'Dropbox', path: 'C:\\Users\\me\\Dropbox' }, { id: 'c', label: 'OneDrive', path: 'C:\\Users\\me\\OneDrive' }])).toEqual([
      'Dropbox (D:)',
      'Dropbox (C:)',
      'OneDrive'
    ])
  })

  it('says which chat each is when two share a label', () => {
    const hook = (id: string, service: 'slack' | 'discord', masked: string, readable = true) => ({ id, label: 'Team', service, masked, readable })
    expect(hookPlaces([hook('a', 'slack', 'hooks.slack.com/…/AbCd'), hook('b', 'discord', 'discord.com/…/WxYz')])).toEqual(new Map([['a', 'Slack'], ['b', 'Discord']]))
    expect(hookPlaces([hook('a', 'slack', 'hooks.slack.com/…/AbCd'), hook('b', 'slack', 'hooks.slack.com/…/WxYz')])).toEqual(new Map([['a', '…AbCd'], ['b', '…WxYz']]))
    // One that cannot be read has no end to show: numbered.
    expect(hookPlaces([hook('a', 'slack', 'hooks.slack.com/…/AbCd'), hook('b', 'slack', 'cannot be read', false)])).toEqual(new Map([['a', '1'], ['b', '2']]))
    expect(hookPlaces([hook('a', 'slack', 'hooks.slack.com/…/AbCd')])).toEqual(new Map())
  })
})
