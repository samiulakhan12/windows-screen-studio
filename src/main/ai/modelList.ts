/**
 * The suggested AI models in the main process (NW-15, docs/design/auto-update.md §3): the bundled
 * list, the cached download (userData/ai-models.json) and a refresh from GitHub at most once a day
 * (modelListIpc.ts asks for it after an update check). No Electron here: until the cache is loaded
 * (and in the tests) the list is the bundled one.
 */
import fs from 'node:fs'
import { BUNDLED_MODEL_LIST, MODEL_LIST_EVERY_MS, MODEL_LIST_MAX_BYTES, newerList, parseModelList, type ModelDefaults, type ModelList } from '../../shared/ai/modelList'
import type { AiProviderKind } from '../../shared/types'
import { writeFileAtomicSync } from '../atomicWrite'

export const MODEL_CACHE_FILE = 'ai-models.json'

let current: ModelList = BUNDLED_MODEL_LIST
let cacheFile: string | null = null
/** This Flown's version: suggestions meant for newer versions (`minApp`) are not taken. */
let appVersion: string | undefined
/** When the list was last downloaded (epoch ms); 0 before. */
let fetchedAt = 0

export const modelList = (): ModelList => current
/** A provider kind's suggested models (the list Flown has now). */
export const modelDefaults = (kind: AiProviderKind): ModelDefaults => current.providers[kind]

/** Back to the bundled list (tests). */
export function resetModelList(): void {
  current = BUNDLED_MODEL_LIST
  cacheFile = null
  fetchedAt = 0
  appVersion = undefined
}

/**
 * Reads the cached list as downloaded (so a newer Flown reads its `minApp` entries again): a bad
 * one, or one older than what Flown has, is ignored. `version`: this Flown's version.
 */
export function loadModelCache(file: string, version?: string): void {
  cacheFile = file
  appVersion = version
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring the unreadable list of AI models:', err)
    return
  }
  const r = raw && typeof raw === 'object' ? (raw as { fetchedAt?: unknown; list?: unknown }) : {}
  const at = typeof r.fetchedAt === 'string' ? Date.parse(r.fetchedAt) : NaN
  if (Number.isFinite(at)) fetchedAt = at
  current = newerList(current, parseModelList(r.list, appVersion))
}

/** The body as text, or null past `max` bytes or when it is not UTF-8. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) return null
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all)
  } catch {
    return null
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/**
 * Downloads the list from `url` when the last download is a day old (a failure is tried again at
 * the next update check). Returns whether Flown now has a newer list. Only https, no redirects, at
 * most MODEL_LIST_MAX_BYTES, 15 s; anything parseModelList rejects is dropped.
 */
export async function refreshModelList(url: string, fetcher: Fetcher, now = Date.now()): Promise<boolean> {
  if (fetchedAt > 0 && now - fetchedAt < MODEL_LIST_EVERY_MS) return false
  let list: ModelList | null = null
  let raw: unknown = null
  try {
    const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await readCapped(res, MODEL_LIST_MAX_BYTES)
    if (text === null) throw new Error('too large or not UTF-8')
    raw = JSON.parse(text)
    list = parseModelList(raw, appVersion)
    if (!list) throw new Error('not a list Flown can use')
  } catch (err) {
    console.warn('Could not refresh the list of AI models:', err instanceof Error ? err.message : String(err))
    return false
  }
  fetchedAt = now
  if (cacheFile) {
    try {
      writeFileAtomicSync(cacheFile, `${JSON.stringify({ fetchedAt: new Date(now).toISOString(), list: raw }, null, 2)}\n`)
    } catch (err) {
      console.warn('Could not keep the list of AI models:', err)
    }
  }
  const before = current
  current = newerList(current, list)
  return current !== before
}
