import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretBox } from '../src/main/ai/keyStore'
import { ShareStore } from '../src/main/share/shareStore'
import { choicesFor, presetKey, readShareChoices, withChoices } from '../src/shared/share/choices'
import { folderId } from '../src/shared/share/cloudFolders'

function fakeBox(opts: { available?: boolean; weak?: string } = {}): SecretBox {
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    encryptString: (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain).map((b) => b ^ 0xa5)]),
    decryptString: (enc: Buffer) => {
      if (enc.subarray(0, 3).toString() !== 'v10') throw new Error('bad')
      return Buffer.from(enc.subarray(3).map((b) => b ^ 0xa5)).toString()
    },
    weakness: () => opts.weak ?? null
  }
}

const SLACK = 'https://hooks.slack.com/services/T0001/B0002/abcdEFGHijklMNOPqrstUVWX'

describe('ShareStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-share-'))
    file = path.join(dir, 'share.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps webhooks encrypted and only shows them masked', () => {
    const store = new ShareStore(file, fakeBox())
    const info = store.addHook('  #demos  ', ` ${SLACK} `)
    expect(info).toMatchObject({ service: 'slack', label: '#demos', masked: 'hooks.slack.com/…/UVWX', readable: true })
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('hooks.slack.com')
    expect(text).not.toContain('abcdEFGH')
    expect(JSON.stringify(new ShareStore(file, fakeBox()).hooks())).not.toContain('abcdEFGH')
    expect(new ShareStore(file, fakeBox()).hook(info.id)).toEqual({ service: 'slack', label: '#demos', url: SLACK })
  })

  it('names a chat after its service when no name is given, and refuses the same webhook twice', () => {
    const store = new ShareStore(file, fakeBox())
    expect(store.addHook('', 'https://discord.com/api/webhooks/1/abc').label).toBe('Discord')
    expect(() => store.addHook('again', 'https://discord.com/api/webhooks/1/abc')).toThrow('already added')
  })

  it('stores nothing without safe encryption', () => {
    expect(() => new ShareStore(file, fakeBox({ available: false })).addHook('x', SLACK)).toThrow('cannot be stored safely')
    expect(() => new ShareStore(file, fakeBox({ weak: 'no system keyring is available' })).addHook('x', SLACK)).toThrow('no system keyring')
    expect(() => readFileSync(file)).toThrow()
  })

  it('refuses a URL that is not a webhook of the three services', () => {
    expect(() => new ShareStore(file, fakeBox()).addHook('x', 'https://example.com/hook')).toThrow('incoming webhook')
  })

  it('says when a webhook can no longer be read (another Windows user)', () => {
    const store = new ShareStore(file, fakeBox())
    const { id } = store.addHook('x', SLACK)
    const other = new ShareStore(file, { ...fakeBox(), decryptString: () => { throw new Error('bad') } })
    expect(other.hooks()[0]).toMatchObject({ readable: false, masked: 'cannot be read' })
    expect(() => other.hook(id)).toThrow('can no longer be read')
    expect(() => store.hook('whkgone')).toThrow('no longer set up')
  })

  it('caps the chats and removes one', () => {
    const store = new ShareStore(file, fakeBox())
    for (let i = 0; i < 10; i++) store.addHook(`c${i}`, `https://discord.com/api/webhooks/${i}/x`)
    expect(() => store.addHook('one more', 'https://discord.com/api/webhooks/99/x')).toThrow('At most 10')
    store.removeHook(store.hooks()[0].id)
    expect(store.hooks()).toHaveLength(9)
  })

  it('adds folders the user picked, turns found ones off, and reads them back', () => {
    const store = new ShareStore(file, fakeBox())
    const team = path.join(dir, 'Team share')
    store.addFolder(team, 'Team share')
    store.setOff('cf0123456789', true)
    const again = new ShareStore(file, fakeBox())
    expect(again.folders()).toMatchObject([{ id: folderId(team), path: team, label: 'Team share' }])
    expect(again.isOff('cf0123456789')).toBe(true)
    // Adding a folder turned off turns it on.
    again.setOff(folderId(team), true)
    again.addFolder(team, 'Team share')
    expect(again.isOff(folderId(team))).toBe(false)
    expect(again.folders()).toHaveLength(1)
    again.removeFolder(folderId(team))
    expect(again.folders()).toEqual([])
  })

  it('drops malformed entries and reads a broken file as empty', () => {
    writeFileSync(
      file,
      JSON.stringify({
        folders: [{ id: 'cf0000000000', path: '/x', label: 'Wrong id' }, { id: folderId('/ok'), path: '/ok', label: 'Ok' }, { path: 'relative', id: folderId('relative'), label: 'r' }],
        off: ['cf0123456789', '../evil', 3],
        hooks: [{ id: 'whk1', service: 'evil', label: 'x', url: 'AAAA' }, { id: 'nope', service: 'slack', label: 'x', url: 'AAAA' }]
      })
    )
    const store = new ShareStore(file, fakeBox())
    expect(store.folders().map((f) => f.label)).toEqual(['Ok'])
    expect(store.hooks()).toEqual([])
    expect(store.isOff('cf0123456789')).toBe(true)
    writeFileSync(file, '{ not json')
    expect(new ShareStore(file, fakeBox()).folders()).toEqual([])
  })
})

describe('After export choices', () => {
  const offered = ['cf0000000001', 'cf0000000002', 'whkabc']

  it('remembers choices per preset', () => {
    let c = readShareChoices({})
    c = withChoices(c, 'youtube', ['whkabc', 'cf0000000001'], offered)
    expect(choicesFor(c, 'youtube', offered)).toEqual(['cf0000000001', 'whkabc'])
    expect(choicesFor(c, 'tiktok', offered)).toEqual([])
    expect(choicesFor(c, undefined, offered)).toEqual([])
    c = withChoices(c, undefined, ['cf0000000002'], offered)
    expect(c.byPreset.custom).toEqual(['cf0000000002'])
    expect(presetKey('../x')).toBe('custom')
  })

  it('ignores destinations no longer offered and removes empty lists', () => {
    const c = withChoices(readShareChoices({}), 'youtube', ['cf0000000001'], offered)
    expect(choicesFor(c, 'youtube', ['whkabc'])).toEqual([])
    expect(withChoices(c, 'youtube', [], offered).byPreset).toEqual({})
  })

  it('reads stored choices defensively', () => {
    expect(readShareChoices(null).byPreset).toEqual({})
    expect(readShareChoices({ byPreset: [] }).byPreset).toEqual({})
    expect(readShareChoices({ byPreset: { youtube: ['cf0000000001', 'bad', 7, 'cf0000000001'], '../x': ['whkabc'], tiktok: 'no' } }).byPreset).toEqual({ youtube: ['cf0000000001'] })
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, ['whkabc']]))
    expect(Object.keys(readShareChoices({ byPreset: many }).byPreset)).toHaveLength(50)
  })
})
