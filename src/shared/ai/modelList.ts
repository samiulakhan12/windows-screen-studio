/**
 * The list of suggested AI models (NW-15, docs/design/auto-update.md §3): the default models of
 * each provider and the models their makers are retiring. Flown carries BUNDLED_MODEL_LIST and
 * refreshes it from resources/ai-models.json on GitHub (the same content: a test keeps them equal).
 * A downloaded list is untrusted: parseModelList takes only what it knows, and it only ever
 * suggests models and flags retiring ones; a model the user saved is never changed.
 */
import { AI_LIMITS, AI_PROVIDER_KINDS } from '../api/ai'
import type { AiProviderKind } from '../types'
import { isNewer, isVersion } from '../updates/updates'

/** The list on GitHub, on the default branch (raw.githubusercontent.com resolves HEAD). */
export const MODEL_LIST_URL = 'https://raw.githubusercontent.com/samiulakhan12/windows-screen-studio/HEAD/resources/ai-models.json'
/** Largest list read. */
export const MODEL_LIST_MAX_BYTES = 64 * 1024
/** At most one download per this long. */
export const MODEL_LIST_EVERY_MS = 24 * 60 * 60 * 1000
const MAX_RETIRING = 50

/** As keyStore checks a saved model name. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export interface ModelDefaults {
  /** For text tasks. */
  model: string
  /** For transcription (providers that can transcribe). */
  transcriptionModel?: string
}

export interface RetiringModel {
  provider: AiProviderKind
  model: string
  /** The day it stops working, YYYY-MM-DD. */
  on: string
}

export interface ModelList {
  version: 1
  /** YYYY-MM-DD: the newest list wins. */
  updated: string
  providers: Record<AiProviderKind, ModelDefaults>
  retiring: RetiringModel[]
}

export const BUNDLED_MODEL_LIST: ModelList = {
  version: 1,
  updated: '2026-10-30',
  providers: {
    openai: { model: 'gpt-6.1-sol', transcriptionModel: 'whisper-1' },
    gemini: { model: 'gemini-3.8-flash', transcriptionModel: 'gemini-3.8-flash' },
    anthropic: { model: 'claude-opus-5-5' }
  },
  retiring: [{ provider: 'openai', model: 'whisper-1', on: '2027-02-26' }]
}

const KINDS = Object.keys(AI_PROVIDER_KINDS) as AiProviderKind[]
const isKind = (v: unknown): v is AiProviderKind => typeof v === 'string' && (KINDS as string[]).includes(v)
const isModel = (v: unknown): v is string => typeof v === 'string' && v.length <= AI_LIMITS.modelLength && MODEL_RE.test(v)

function isDate(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DATE_RE.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The list in `raw`, or null when it is not one Flown can use: version 1, a date, valid defaults for
 * every provider Flown knows (a transcription model only for providers that transcribe) and at most
 * 50 retiring entries. Providers and entries for providers Flown does not know are skipped (a newer
 * list may name more); anything else wrong rejects the whole list.
 *
 * A provider's entry may carry `minApp` (x.y.z): a suggestion only versions from that one can use
 * (a model an older version cannot handle). Flown `appVersion` older than that keeps its own
 * bundled suggestion for that provider. The list on GitHub is read by every installed version.
 */
export function parseModelList(raw: unknown, appVersion?: string): ModelList | null {
  if (!isObject(raw) || raw.version !== 1 || !isDate(raw.updated) || !isObject(raw.providers)) return null
  const providers = {} as Record<AiProviderKind, ModelDefaults>
  for (const kind of KINDS) {
    const p = raw.providers[kind]
    if (!isObject(p) || !isModel(p.model)) return null
    if (p.minApp !== undefined && !isVersion(p.minApp)) return null
    if (AI_PROVIDER_KINDS[kind].canTranscribe) {
      if (!isModel(p.transcriptionModel)) return null
      providers[kind] = { model: p.model, transcriptionModel: p.transcriptionModel }
    } else {
      if (p.transcriptionModel !== undefined) return null
      providers[kind] = { model: p.model }
    }
    // Meant for newer versions only: this one keeps its own suggestion.
    if (appVersion && typeof p.minApp === 'string' && isNewer(p.minApp, appVersion)) providers[kind] = BUNDLED_MODEL_LIST.providers[kind]
  }
  const list = raw.retiring === undefined ? [] : raw.retiring
  if (!Array.isArray(list) || list.length > MAX_RETIRING) return null
  const retiring: RetiringModel[] = []
  for (const r of list) {
    if (!isObject(r) || typeof r.provider !== 'string' || !isModel(r.model) || !isDate(r.on)) return null
    if (isKind(r.provider)) retiring.push({ provider: r.provider, model: r.model, on: r.on })
  }
  return { version: 1, updated: raw.updated, providers, retiring }
}

/** The newer of two lists by `updated` (`a` when they are as new). */
export const newerList = (a: ModelList, b: ModelList | null): ModelList => (b && b.updated > a.updated ? b : a)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "26 February 2027". */
export function dayText(date: string): string {
  const m = DATE_RE.exec(date)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : date
}

const MAKERS: Record<AiProviderKind, string> = { openai: 'OpenAI', gemini: 'Google', anthropic: 'Anthropic' }

/** Notes for Settings › AI: a provider's model or transcription model on the retiring list. */
export function retiringNotes(list: ModelList, p: { kind: AiProviderKind; model: string; transcriptionModel?: string }, today: string): string[] {
  const maker = MAKERS[p.kind]
  const notes: string[] = []
  const uses: { model: string | undefined; what: string }[] = [
    { model: p.model, what: 'model' },
    { model: p.transcriptionModel, what: 'transcription model' }
  ]
  for (const { model, what } of uses) {
    const r = model ? list.retiring.find((x) => x.provider === p.kind && x.model === model) : undefined
    if (!r) continue
    notes.push(
      r.on > today
        ? `${maker} retires ${r.model} on ${dayText(r.on)}. Choose another ${what} before then.`
        : `${maker} retired ${r.model} on ${dayText(r.on)}. Choose another ${what}.`
    )
  }
  return notes
}
