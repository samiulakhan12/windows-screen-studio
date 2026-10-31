import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiProviderStore, validateProviderInput, type SecretBox } from '../src/main/ai/keyStore'

/** A stand-in for safeStorage: reversible, and never the plain text. */
function fakeBox(opts: { available?: boolean; weak?: string } = {}): SecretBox & { calls: number } {
  const box = {
    calls: 0,
    isEncryptionAvailable: () => opts.available ?? true,
    encryptString: (plain: string) => {
      box.calls++
      return Buffer.concat([Buffer.from('v10'), Buffer.from(plain).map((b) => b ^ 0xa5)])
    },
    decryptString: (enc: Buffer) => {
      if (enc.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return Buffer.from(enc.subarray(3).map((b) => b ^ 0xa5)).toString()
    },
    weakness: () => opts.weak ?? null
  }
  return box
}

const KEY = 'sk-proj-THISISASECRETKEY1234abcd'

describe('AiProviderStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-aikeys-'))
    file = path.join(dir, 'ai-providers.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stores keys encrypted and only ever returns their last characters', () => {
    const store = new AiProviderStore(file, fakeBox())
    const info = store.save({ kind: 'openai', label: '  My   OpenAI ', apiKey: ` ${KEY} ` }, new Date('2026-10-25T10:00:00Z'))
    expect(info).toEqual({
      id: info.id,
      kind: 'openai',
      label: 'My OpenAI',
      model: 'gpt-6.1-sol',
      transcriptionModel: 'whisper-1',
      maskedKey: '…abcd',
      createdAt: '2026-10-25T10:00:00.000Z',
      canTranscribe: true
    })
    const disk = readFileSync(file, 'utf8')
    expect(disk).not.toContain(KEY)
    expect(disk).not.toContain('THISISASECRET')
    expect(JSON.stringify(store.list())).not.toContain(KEY)
    // A fresh store reads it back; the key is there for requests only.
    const again = new AiProviderStore(file, fakeBox())
    expect(again.list()).toEqual([info])
    expect(again.get(info.id).apiKey).toBe(KEY)
  })

  it('stores no suggested transcription model, so the provider moves with the list; a chosen one stays', () => {
    // The suggestions of the list Flown has: near whisper-1's retirement the list moves to gpt-transcribe.
    let suggested = 'whisper-1'
    const defaults = (kind: 'openai' | 'gemini' | 'anthropic'): { model: string; transcriptionModel?: string } =>
      kind === 'openai' ? { model: 'gpt-6.1-sol', transcriptionModel: suggested } : { model: 'm', ...(kind === 'gemini' ? { transcriptionModel: 'gemini-3.8-flash' } : {}) }
    const store = new AiProviderStore(file, fakeBox(), defaults)
    // As the form sends it (filled with the suggestion), with the field emptied, without it, and with another model.
    const form = store.save({ kind: 'openai', label: 'Form', apiKey: KEY, transcriptionModel: 'whisper-1' })
    const empty = store.save({ kind: 'openai', label: 'Empty', apiKey: KEY, transcriptionModel: '' })
    const absent = store.save({ kind: 'openai', label: 'Absent', apiKey: KEY })
    const chosen = store.save({ kind: 'openai', label: 'Chosen', apiKey: KEY, transcriptionModel: 'gpt-4o-transcribe' })
    expect([form, empty, absent, chosen].map((p) => p.transcriptionModel)).toEqual(['whisper-1', 'whisper-1', 'whisper-1', 'gpt-4o-transcribe'])
    const disk = JSON.parse(readFileSync(file, 'utf8')).providers
    expect(disk.map((p: { transcriptionModel?: string }) => p.transcriptionModel)).toEqual([undefined, undefined, undefined, 'gpt-4o-transcribe'])
    // A provider saved by an earlier Flown has whisper-1 in the file: it loads as it was.
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.providers.push({ ...raw.providers[0], id: 'aiold1', label: 'Old', transcriptionModel: 'whisper-1' })
    writeFileSync(file, JSON.stringify(raw))
    suggested = 'gpt-transcribe'
    const moved = new AiProviderStore(file, fakeBox(), defaults)
    for (const p of [form, empty, absent]) expect(moved.get(p.id).info.transcriptionModel).toBe('gpt-transcribe')
    expect(moved.get(chosen.id).info.transcriptionModel).toBe('gpt-4o-transcribe')
    expect(moved.get('aiold1').info.transcriptionModel).toBe('whisper-1')
    expect(moved.list().map((p) => p.transcriptionModel)).toEqual(['gpt-transcribe', 'gpt-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe', 'whisper-1'])
    // whisper-1 typed while the list suggests gpt-transcribe is a choice: it stays.
    expect(moved.save({ id: form.id, kind: 'openai', label: 'Form', transcriptionModel: 'whisper-1' }).transcriptionModel).toBe('whisper-1')
    expect(new AiProviderStore(file, fakeBox(), defaults).get(form.id).info.transcriptionModel).toBe('whisper-1')
    // Claude transcribes nothing, whatever the list says.
    expect(moved.save({ kind: 'anthropic', label: 'C', apiKey: KEY }).transcriptionModel).toBeUndefined()
  })

  it('an edit without the transcription model (the user did not type in it) keeps the provider’s', () => {
    const store = new AiProviderStore(file, fakeBox())
    const chosen = store.save({ kind: 'openai', label: 'Chosen', apiKey: KEY, transcriptionModel: 'gpt-4o-transcribe' })
    const follows = store.save({ kind: 'openai', label: 'Follows', apiKey: KEY })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.providers.push({ ...raw.providers[1], id: 'aiold1', label: 'Old', transcriptionModel: 'whisper-1' })
    writeFileSync(file, JSON.stringify(raw))
    const again = new AiProviderStore(file, fakeBox())
    // Renamed with the field left out: each keeps what it had, an earlier Flown's whisper-1 too.
    for (const id of [chosen.id, follows.id, 'aiold1']) again.save({ id, kind: 'openai', label: `${id} 2` })
    const disk = (): (string | undefined)[] => JSON.parse(readFileSync(file, 'utf8')).providers.map((p: { transcriptionModel?: string }) => p.transcriptionModel)
    expect(disk()).toEqual(['gpt-4o-transcribe', undefined, 'whisper-1'])
    // Emptied, it follows the list again; another kind starts from that kind's suggestion.
    again.save({ id: chosen.id, kind: 'openai', label: 'Chosen', transcriptionModel: '' })
    expect(again.save({ id: 'aiold1', kind: 'gemini', label: 'Old', apiKey: KEY }).transcriptionModel).toBe('gemini-3.8-flash')
    expect(disk()).toEqual([undefined, undefined, undefined])
  })

  it('refuses to store a key when encryption is unavailable or weak', () => {
    expect(() => new AiProviderStore(file, fakeBox({ available: false })).save({ kind: 'gemini', label: 'G', apiKey: KEY })).toThrow(/cannot be stored safely/)
    expect(() => new AiProviderStore(file, fakeBox({ weak: 'no system keyring is available' })).save({ kind: 'gemini', label: 'G', apiKey: KEY })).toThrow(/no system keyring/)
    expect(() => readFileSync(file)).toThrow()
  })

  it('edits without the key (keeping it), or with a new one; a new kind needs a new key', () => {
    const box = fakeBox()
    const store = new AiProviderStore(file, box)
    const info = store.save({ kind: 'anthropic', label: 'Claude', apiKey: KEY })
    expect(info.transcriptionModel).toBeUndefined()
    expect(info.canTranscribe).toBe(false)
    expect(info.model).toBe('claude-opus-5-5')
    const renamed = store.save({ id: info.id, kind: 'anthropic', label: 'Claude 2', model: 'claude-sonnet-5-5' })
    expect(renamed).toMatchObject({ id: info.id, label: 'Claude 2', model: 'claude-sonnet-5-5', maskedKey: '…abcd', createdAt: info.createdAt })
    expect(store.get(info.id).apiKey).toBe(KEY)
    expect(() => store.save({ id: info.id, kind: 'openai', label: 'X' })).toThrow(/API key for the new kind/)
    store.save({ id: info.id, kind: 'anthropic', label: 'Claude 2', apiKey: 'sk-ant-other-key-9876' })
    expect(store.get(info.id).apiKey).toBe('sk-ant-other-key-9876')
    expect(() => store.save({ id: 'ainotthere', kind: 'anthropic', label: 'X', apiKey: KEY })).toThrow(/no longer exists/)
    expect(() => store.save({ kind: 'anthropic', label: 'X' })).toThrow(/Enter the API key/)
  })

  it('removes providers', () => {
    const store = new AiProviderStore(file, fakeBox())
    const a = store.save({ kind: 'openai', label: 'A', apiKey: KEY })
    const b = store.save({ kind: 'gemini', label: 'B', apiKey: 'AIzaSyFAKEFAKEFAKE0000' })
    store.remove(a.id)
    store.remove('nope')
    store.remove(42)
    expect(store.list().map((p) => p.id)).toEqual([b.id])
    expect(new AiProviderStore(file, fakeBox()).list().map((p) => p.id)).toEqual([b.id])
    expect(() => store.get(a.id)).toThrow(/no longer exists/)
  })

  it('reads a damaged file entry by entry, and says so when a key can no longer be decrypted', () => {
    const store = new AiProviderStore(file, fakeBox())
    const good = store.save({ kind: 'openai', label: 'Good', apiKey: KEY })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.providers.push(
      { ...raw.providers[0], id: 'ai2', kind: 'evil' },
      { ...raw.providers[0], id: '../x' },
      { ...raw.providers[0], id: 'ai3', model: 'a b' },
      'junk',
      { ...raw.providers[0], id: 'ai4', label: 'Other PC', key: Buffer.from('garbage').toString('base64') }
    )
    writeFileSync(file, JSON.stringify(raw))
    const reread = new AiProviderStore(file, fakeBox())
    expect(reread.list().map((p) => [p.id, p.maskedKey])).toEqual([
      [good.id, '…abcd'],
      ['ai4', 'unreadable']
    ])
    expect(() => reread.get('ai4')).toThrow(/can no longer be read on this PC/)
    writeFileSync(file, '{ not json')
    expect(new AiProviderStore(file, fakeBox()).list()).toEqual([])
  })
})

describe('validateProviderInput', () => {
  it('fills default models and checks every field', () => {
    expect(validateProviderInput({ kind: 'gemini', label: 'G', apiKey: KEY, model: '', transcriptionModel: '  ' })).toEqual({
      kind: 'gemini',
      label: 'G',
      apiKey: KEY,
      model: 'gemini-3.8-flash',
      transcriptionModel: 'gemini-3.8-flash'
    })
    // Claude has no transcription model, whatever is sent.
    expect(validateProviderInput({ kind: 'anthropic', label: 'C', transcriptionModel: 'x' })).not.toHaveProperty('transcriptionModel')
    const bad = (input: unknown, message: RegExp): void => expect(() => validateProviderInput(input)).toThrow(message)
    bad(null, /Invalid/)
    bad({ kind: 'mistral', label: 'x' }, /Choose OpenAI/)
    bad({ kind: 'openai', label: ' ' }, /name/)
    bad({ kind: 'openai', label: 'x'.repeat(61) }, /too long/)
    bad({ kind: 'openai', label: 'x', apiKey: 'short' }, /does not look like an API key/)
    bad({ kind: 'openai', label: 'x', apiKey: 'sk-with space inside' }, /does not look like an API key/)
    bad({ kind: 'openai', label: 'x', apiKey: 42 }, /must be text/)
    bad({ kind: 'openai', label: 'x', model: 'gpt; rm -rf' }, /not a model name/)
    bad({ kind: 'openai', label: 'x', id: '../../etc' }, /Invalid/)
  })
})
