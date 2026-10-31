import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_MODEL_LIST, MODEL_LIST_EVERY_MS, MODEL_LIST_MAX_BYTES, dayText, newerList, parseModelList, retiringNotes, type ModelList } from '../src/shared/ai/modelList'
import { loadModelCache, modelDefaults, modelList, refreshModelList, resetModelList, type Fetcher } from '../src/main/ai/modelList'
import { validateProviderInput } from '../src/main/ai/keyStore'

const ROOT = path.resolve(__dirname, '..')
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(BUNDLED_MODEL_LIST))

describe('the model list (docs/design/auto-update.md §3)', () => {
  it('ships the same list as resources/ai-models.json, the file Flown downloads', () => {
    const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'ai-models.json'), 'utf8'))
    expect(file).toEqual(BUNDLED_MODEL_LIST)
    expect(parseModelList(file)).toEqual(BUNDLED_MODEL_LIST)
  })

  it('rejects anything but a usable list', () => {
    const bad = (mutate: (l: Record<string, any>) => void): void => {
      const l = clone()
      mutate(l)
      expect(parseModelList(l)).toBeNull()
    }
    expect(parseModelList(null)).toBeNull()
    expect(parseModelList('x')).toBeNull()
    bad((l) => (l.version = 2))
    bad((l) => (l.updated = '2026-02-30'))
    bad((l) => (l.updated = '30 Oct 2026'))
    bad((l) => delete l.providers.gemini)
    bad((l) => (l.providers.openai.model = 'gpt 6'))
    bad((l) => (l.providers.openai.model = '-x'))
    bad((l) => (l.providers.openai.model = 'a'.repeat(101)))
    bad((l) => delete l.providers.openai.transcriptionModel)
    bad((l) => (l.providers.anthropic.transcriptionModel = 'claude'))
    bad((l) => (l.retiring = {}))
    bad((l) => (l.retiring = Array.from({ length: 51 }, () => ({ provider: 'openai', model: 'm', on: '2027-01-01' }))))
    bad((l) => (l.retiring = [{ provider: 'openai', model: 'whisper-1', on: 'soon' }]))
    bad((l) => (l.retiring = [{ provider: 3, model: 'whisper-1', on: '2027-01-01' }]))
  })

  it('takes only what it knows: other providers and their entries are skipped', () => {
    const l = clone()
    l.providers.mistral = { model: 'm-large' }
    l.retiring.push({ provider: 'mistral', model: 'm-small', on: '2027-01-01' })
    l.extra = { anything: true }
    expect(parseModelList(l)).toEqual(BUNDLED_MODEL_LIST)
    delete l.retiring
    expect(parseModelList(l)?.retiring).toEqual([])
  })

  it('a suggestion meant for newer versions (minApp) is left to them: older ones keep their own', () => {
    const l = clone()
    l.updated = '2027-02-20'
    l.providers.openai = { model: 'gpt-6.1-sol', transcriptionModel: 'gpt-transcribe', minApp: '0.8.0' }
    l.providers.gemini = { model: 'gemini-next', transcriptionModel: 'gemini-next' }
    const old = parseModelList(l, '0.7.1')
    expect(old?.providers.openai).toEqual(BUNDLED_MODEL_LIST.providers.openai)
    expect(old?.providers.gemini).toEqual({ model: 'gemini-next', transcriptionModel: 'gemini-next' })
    expect(parseModelList(l, '0.8.0')?.providers.openai).toEqual({ model: 'gpt-6.1-sol', transcriptionModel: 'gpt-transcribe' })
    expect(parseModelList(l, '0.10.2')?.providers.openai.transcriptionModel).toBe('gpt-transcribe')
    l.providers.openai.minApp = '0.8'
    expect(parseModelList(l, '0.7.1')).toBeNull()
  })

  it('keeps the newer list by date', () => {
    const older = { ...BUNDLED_MODEL_LIST, updated: '2026-01-01' }
    expect(newerList(BUNDLED_MODEL_LIST, older)).toBe(BUNDLED_MODEL_LIST)
    expect(newerList(older, BUNDLED_MODEL_LIST)).toBe(BUNDLED_MODEL_LIST)
    expect(newerList(BUNDLED_MODEL_LIST, null)).toBe(BUNDLED_MODEL_LIST)
    expect(newerList(BUNDLED_MODEL_LIST, { ...BUNDLED_MODEL_LIST })).toBe(BUNDLED_MODEL_LIST)
    // A list from GitHub also wins a tie, never an older one.
    const same = { ...BUNDLED_MODEL_LIST }
    expect(newerList(BUNDLED_MODEL_LIST, same, true)).toBe(same)
    expect(newerList(BUNDLED_MODEL_LIST, older, true)).toBe(BUNDLED_MODEL_LIST)
  })

  it('notes a provider still using a retiring model, before and after the day', () => {
    const p = { kind: 'openai' as const, model: 'gpt-6.1-sol', transcriptionModel: 'whisper-1' }
    expect(retiringNotes(BUNDLED_MODEL_LIST, p, '2026-10-30')).toEqual(['OpenAI retires whisper-1 on 26 February 2027. Choose another transcription model before then.'])
    expect(retiringNotes(BUNDLED_MODEL_LIST, p, '2027-02-26')).toEqual(['OpenAI retired whisper-1 on 26 February 2027. Choose another transcription model.'])
    expect(retiringNotes(BUNDLED_MODEL_LIST, { ...p, transcriptionModel: 'gpt-transcribe' }, '2026-10-30')).toEqual([])
    expect(retiringNotes(BUNDLED_MODEL_LIST, { kind: 'gemini', model: 'whisper-1' }, '2026-10-30')).toEqual([])
    const list: ModelList = { ...BUNDLED_MODEL_LIST, retiring: [{ provider: 'anthropic', model: 'claude-opus-5-5', on: '2027-06-01' }] }
    expect(retiringNotes(list, { kind: 'anthropic', model: 'claude-opus-5-5' }, '2026-10-30')).toEqual(['Anthropic retires claude-opus-5-5 on 1 June 2027. Choose another model before then.'])
    expect(dayText('2027-02-26')).toBe('26 February 2027')
  })
})

describe('the list in the main process', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-models-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    resetModelList()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const newer = (): Record<string, any> => {
    const l = clone()
    l.updated = '2027-01-15'
    l.providers.openai.transcriptionModel = 'gpt-transcribe'
    return l
  }
  const respond = (body: string | Uint8Array, init: ResponseInit = {}): Fetcher => vi.fn(async () => new Response(body, init))

  it('takes a newer download, keeps it, and asks at most once a day', async () => {
    const file = path.join(tmp(), 'ai-models.json')
    loadModelCache(file)
    const fetcher = respond(JSON.stringify(newer()))
    expect(await refreshModelList('https://example.test/list.json', fetcher, 1_000_000)).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('https://example.test/list.json', expect.objectContaining({ redirect: 'error' }))
    expect(modelDefaults('openai').transcriptionModel).toBe('gpt-transcribe')
    expect(await refreshModelList('https://example.test/list.json', fetcher, 1_000_000 + MODEL_LIST_EVERY_MS - 1)).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // The cache brings it back after a restart.
    resetModelList()
    loadModelCache(file)
    expect(modelList().updated).toBe('2027-01-15')
  })

  it('a download time later than now (the clock was ahead) does not hold back the next download', async () => {
    const file = path.join(tmp(), 'ai-models.json')
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: '2026-12-15T00:00:00.000Z', list: clone() }))
    loadModelCache(file)
    const now = Date.parse('2026-11-05T09:00:00.000Z')
    const fetcher = respond(JSON.stringify(newer()))
    expect(await refreshModelList('https://example.test/l', fetcher, now)).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).fetchedAt).toBe('2026-11-05T09:00:00.000Z')
    // From then on, once a day again.
    expect(await refreshModelList('https://example.test/l', fetcher, now + MODEL_LIST_EVERY_MS - 1)).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('takes a fix made the same day as the list it has, also after a restart', async () => {
    const file = path.join(tmp(), 'ai-models.json')
    loadModelCache(file)
    const fix = clone()
    fix.providers.openai.model = 'gpt-6.1'
    fix.retiring[0].on = '2027-03-26'
    expect(fix.updated).toBe(BUNDLED_MODEL_LIST.updated)
    expect(await refreshModelList('https://example.test/l', respond(JSON.stringify(fix)), 10)).toBe(true)
    expect(modelDefaults('openai').model).toBe('gpt-6.1')
    expect(modelList().retiring[0].on).toBe('2027-03-26')
    // A second fix that day reaches a copy that took the first one.
    fix.providers.openai.model = 'gpt-6.2'
    expect(await refreshModelList('https://example.test/l', respond(JSON.stringify(fix)), 10 + MODEL_LIST_EVERY_MS)).toBe(true)
    expect(modelDefaults('openai').model).toBe('gpt-6.2')
    // The cache keeps it over the bundled list of the same date.
    resetModelList()
    loadModelCache(file)
    expect(modelDefaults('openai').model).toBe('gpt-6.2')
    expect(modelList().retiring[0].on).toBe('2027-03-26')
  })

  it('keeps the list as downloaded, so a newer Flown reads its minApp suggestions again', async () => {
    const file = path.join(tmp(), 'ai-models.json')
    loadModelCache(file, '0.7.1')
    const l = newer()
    l.providers.openai.minApp = '0.8.0'
    expect(await refreshModelList('https://example.test/l', respond(JSON.stringify(l)), 10)).toBe(true)
    expect(modelDefaults('openai').transcriptionModel).toBe('whisper-1')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).list.providers.openai.minApp).toBe('0.8.0')
    resetModelList()
    loadModelCache(file, '0.8.0')
    expect(modelDefaults('openai').transcriptionModel).toBe('gpt-transcribe')
  })

  it('never takes an older list, and a bad or older cache is ignored', async () => {
    const dir = tmp()
    const file = path.join(dir, 'ai-models.json')
    loadModelCache(file)
    const older = clone()
    older.updated = '2026-01-01'
    older.providers.openai.model = 'old-model'
    expect(await refreshModelList('https://example.test/l', respond(JSON.stringify(older)), 5)).toBe(false)
    expect(modelList()).toBe(BUNDLED_MODEL_LIST)
    fs.writeFileSync(file, '{bad')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resetModelList()
    loadModelCache(file)
    expect(modelList()).toBe(BUNDLED_MODEL_LIST)
  })

  it('drops failed, too large, non-UTF-8 and unusable downloads, and tries again at the next check', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    loadModelCache(path.join(tmp(), 'ai-models.json'))
    const url = 'https://example.test/l'
    expect(await refreshModelList(url, respond('nope', { status: 404 }), 1)).toBe(false)
    expect(await refreshModelList(url, respond('x', { headers: { 'content-length': String(MODEL_LIST_MAX_BYTES + 1) } }), 2)).toBe(false)
    expect(await refreshModelList(url, respond(' '.repeat(MODEL_LIST_MAX_BYTES + 1)), 3)).toBe(false)
    expect(await refreshModelList(url, respond(new Uint8Array([0x7b, 0xff, 0x7d])), 4)).toBe(false)
    expect(await refreshModelList(url, respond('{not json'), 5)).toBe(false)
    expect(await refreshModelList(url, respond(JSON.stringify({ version: 1 })), 6)).toBe(false)
    expect(await refreshModelList(url, vi.fn(async () => Promise.reject(new Error('offline'))), 7)).toBe(false)
    expect(modelList()).toBe(BUNDLED_MODEL_LIST)
    // None of them counted as the day's download.
    expect(await refreshModelList(url, respond(JSON.stringify(newer())), 8)).toBe(true)
  })

  it('a provider saved without models gets the list\'s suggestions', () => {
    const input = validateProviderInput({ kind: 'openai', label: 'O', apiKey: 'sk-test-12345678' }, () => ({ model: 'gpt-next', transcriptionModel: 'gpt-transcribe' }))
    expect(input).toMatchObject({ model: 'gpt-next', transcriptionModel: 'gpt-transcribe' })
    expect(validateProviderInput({ kind: 'openai', label: 'O', apiKey: 'sk-test-12345678', model: 'mine' }, () => ({ model: 'gpt-next', transcriptionModel: 'x' })).model).toBe('mine')
  })
})
