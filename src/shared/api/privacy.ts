/**
 * Private info's IPC (docs/design/auto-blur.md §10.7): the reader's state and download, Find, Follow,
 * Cover this text everywhere, copies and the listed names; and the validators main runs on every
 * request before it touches anything. Main finds every file itself from the project id.
 */
import { MAX_KEYS_PER_COVER, parsePath } from '../privacy/coverPath'
import { isPrivateKind } from '../privacy/kinds'
import type { Bleep, Cover, NormRect, PrivateKind, ProjectPrivacy } from '../types'

export type ReaderState =
  | { status: 'none' }
  | { status: 'downloading'; done: number; total: number }
  | { status: 'ready'; bytes: number; decodeMs: number | null }
  | { status: 'damaged' }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable'; reason: 'helper' | 'cpu' }

export interface FindRequest {
  projectId: string
  requestId: string
  kinds: PrivateKind[]
  regions: string[]
  names: string[]
  neverHide: string[]
  only?: 'everywhere'
}

export interface FindProgress {
  projectId: string
  requestId: string
  phase: 'look' | 'read' | 'follow' | 'waiting'
  done: number
  total: number
  secondsLeft: number | null
}

/** A cover Find made, as main sends it (the renderer turns it into a Cover, §5.10). */
export interface FoundCover {
  kind: PrivateKind
  score: number
  group: string
  start: number
  end: number
  path: string
  color: string
  lost?: true
  thin?: true
}

export type FindFailure = 'reader' | 'busy' | 'tooLarge' | 'helper' | 'video' | 'crashed' | 'failed'

export type FindResult =
  | { ok: true; projectId: string; requestId: string; found: FoundCover[]; failedReads: number; thinSpans: string; stopped: boolean; readTo: number | null; reader: string }
  | { ok: false; projectId: string; requestId: string; reason: FindFailure }

export interface FollowRequest {
  projectId: string
  requestId: string
  t: number
  box: NormRect
  start: number
  end: number
  path: string
}

export type FollowResult =
  | { ok: true; projectId: string; requestId: string; path: string; start: number; end: number; walked: { start: number; end: number }; lostSpans: string; thin: boolean }
  | { ok: false; projectId: string; requestId: string; reason: 'none' | 'stopped' | 'busy' | 'failed' }

export interface UnderCoverRequest {
  projectId: string
  requestId: string
  t: number
  box: NormRect
}

export type UnderCoverResult = { ok: true; nameLike: boolean } | { ok: false; reason: 'noText' | 'reader' | 'busy' | 'failed' }

export interface EverywhereRequest {
  projectId: string
  requestId: string
  remember: 'no' | 'project' | 'settings'
}

export type EverywhereResult = (Extract<FindResult, { ok: true }> & { addedName?: string }) | Extract<FindResult, { ok: false }>

export interface CopyInfo {
  id: string
  name: string
  open: boolean
}

export interface OriginCovers {
  missing: number
  covers: FoundCover[]
  bleeps: Bleep[]
}

/**
 * What Polish's *Find private info* step gathered (§14.5, decision 11), applied by planPolish in its
 * one update. The covers are the project's covers after Find's merge (withFoundCovers on the project
 * as gathered; Polish never changes covers), the private bleeps are added to the project's bleeps,
 * and `privacy` replaces the project's (its record of this run, rejected places kept).
 */
export interface PrivacyGathered {
  covers: Cover[] | undefined
  said: Bleep[]
  privacy: ProjectPrivacy
  /** For Polish's result line (§2.10): private items found, how many to check, whether only the captions were listened to, whether it finished. */
  found: number
  check: number
  listenedOnly: boolean
  unfinished: boolean
}

export interface PrivacyApi {
  readerState(): Promise<ReaderState>
  downloadReader(): Promise<ReaderState>
  cancelReaderDownload(): Promise<void>
  removeReader(): Promise<ReaderState>
  onReaderState(listener: (state: ReaderState) => void): () => void
  findPrivate(request: FindRequest): Promise<FindResult>
  stopFind(projectId: string): Promise<void>
  onFindProgress(listener: (progress: FindProgress) => void): () => void
  followCover(request: FollowRequest): Promise<FollowResult>
  underCover(request: UnderCoverRequest): Promise<UnderCoverResult>
  coverEverywhere(request: EverywhereRequest): Promise<EverywhereResult>
  copies(projectId: string): Promise<CopyInfo[]>
  coverCopies(projectId: string, copyIds: string[]): Promise<{ covered: number; skipped: string[] }>
  originCovers(projectId: string): Promise<OriginCovers>
  setPrivateNames(names: string[]): Promise<void>
}

/** The channels (§10.7). Every handler checks its sender first, then validates the request. */
export const PRIVACY_CHANNELS = {
  /** invoke () → ReaderState */
  readerState: 'privacy:readerState',
  /** invoke () → ReaderState */
  downloadReader: 'privacy:downloadReader',
  /** invoke () → void */
  cancelReaderDownload: 'privacy:cancelReaderDownload',
  /** invoke () → ReaderState */
  removeReader: 'privacy:removeReader',
  /** event ReaderState */
  readerProgress: 'privacy:readerProgress',
  /** invoke (FindRequest) → FindResult */
  find: 'privacy:find',
  /** invoke (projectId) → void */
  stopFind: 'privacy:stopFind',
  /** event FindProgress */
  findProgress: 'privacy:findProgress',
  /** invoke (FollowRequest) → FollowResult */
  follow: 'privacy:follow',
  /** invoke (UnderCoverRequest) → UnderCoverResult */
  underCover: 'privacy:underCover',
  /** invoke (EverywhereRequest) → EverywhereResult */
  everywhere: 'privacy:everywhere',
  /** invoke (projectId) → CopyInfo[] */
  copies: 'privacy:copies',
  /** invoke ({ projectId, copyIds }) → { covered, skipped } */
  coverCopies: 'privacy:coverCopies',
  /** invoke (projectId) → OriginCovers */
  originCovers: 'privacy:originCovers',
  /** invoke (names) → void */
  names: 'privacy:names'
} as const

/* ---------- validators (§10.7) ---------- */

/** A project folder's name, as main's projectDir accepts it. */
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/
const REGION = /^[A-Z]{2}$/
/** Most names and never-hide words a request carries (Settings' 200 and the project's 200). */
export const MAX_REQUEST_NAMES = 400
const MAX_NAME = 80
const MAX_COPIES = 200
/** Longest path a request carries: MAX_KEYS_PER_COVER keys of at most 48 characters. */
const MAX_PATH_CHARS = MAX_KEYS_PER_COVER * 48

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const only = (o: Obj, keys: readonly string[], optional: readonly string[] = []): boolean =>
  Object.keys(o).every((k) => keys.includes(k) || optional.includes(k)) && keys.every((k) => k in o)
const projectId = (v: unknown): v is string => typeof v === 'string' && PROJECT_ID.test(v)
const requestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID.test(v)

/** A list of names or words: at most MAX_REQUEST_NAMES, each 1..80 characters on one line; null when anything is wrong. */
function names(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_REQUEST_NAMES) return null
  for (const s of v) if (typeof s !== 'string' || !s.trim() || s.length > MAX_NAME || /[\u0000-\u001f\u007f\u2028\u2029]/.test(s)) return null
  return v as string[]
}

/** A finite box inside the frame. */
function box(v: unknown): v is NormRect {
  return isObj(v) && only(v, ['x', 'y', 'w', 'h']) && num(v.x) && num(v.y) && num(v.w) && num(v.h) && v.x >= 0 && v.y >= 0 && v.w > 0 && v.h > 0 && v.x + v.w <= 1 + 1e-9 && v.y + v.h <= 1 + 1e-9
}

const within = (t: unknown, duration: number): t is number => num(t) && t >= 0 && t <= duration

/** A Find request, or null: a project id of the folder's form, known kinds, at most 400 names of 80 characters, regions of two capital letters, nothing else (no paths). */
export function validateFindRequest(raw: unknown): FindRequest | null {
  if (!isObj(raw) || !only(raw, ['projectId', 'requestId', 'kinds', 'regions', 'names', 'neverHide'], ['only'])) return null
  if (!projectId(raw.projectId) || !requestId(raw.requestId)) return null
  if (!Array.isArray(raw.kinds) || raw.kinds.length > 32 || !raw.kinds.every(isPrivateKind)) return null
  if (!Array.isArray(raw.regions) || raw.regions.length > 32 || !raw.regions.every((r) => typeof r === 'string' && REGION.test(r))) return null
  if (!names(raw.names) || !names(raw.neverHide)) return null
  if (raw.only !== undefined && raw.only !== 'everywhere') return null
  return raw as unknown as FindRequest
}

/** A Follow request, or null: a box inside the frame, times inside the recording, a path within §4.2's limits. */
export function validateFollowRequest(raw: unknown, duration: number): FollowRequest | null {
  if (!isObj(raw) || !only(raw, ['projectId', 'requestId', 't', 'box', 'start', 'end', 'path'])) return null
  if (!projectId(raw.projectId) || !requestId(raw.requestId) || !box(raw.box)) return null
  if (!within(raw.t, duration) || !within(raw.start, duration) || !within(raw.end, duration) || !(raw.end > raw.start)) return null
  if (typeof raw.path !== 'string' || raw.path.length > MAX_PATH_CHARS) return null
  const keys = parsePath(raw.path)
  if (!keys || keys.length > MAX_KEYS_PER_COVER) return null
  return raw as unknown as FollowRequest
}

/** A request to read the text under a cover, or null. */
export function validateUnderCoverRequest(raw: unknown, duration: number): UnderCoverRequest | null {
  if (!isObj(raw) || !only(raw, ['projectId', 'requestId', 't', 'box'])) return null
  if (!projectId(raw.projectId) || !requestId(raw.requestId) || !box(raw.box) || !within(raw.t, duration)) return null
  return raw as unknown as UnderCoverRequest
}

/** A Cover this text everywhere request, or null: `remember` one of its three values. */
export function validateEverywhereRequest(raw: unknown): EverywhereRequest | null {
  if (!isObj(raw) || !only(raw, ['projectId', 'requestId', 'remember'])) return null
  if (!projectId(raw.projectId) || !requestId(raw.requestId)) return null
  if (raw.remember !== 'no' && raw.remember !== 'project' && raw.remember !== 'settings') return null
  return raw as unknown as EverywhereRequest
}

/** A request to cover the copies of a project, or null: at most 200 project ids of the folder's form. */
export function validateCopiesRequest(raw: unknown): { projectId: string; copyIds: string[] } | null {
  if (!isObj(raw) || !only(raw, ['projectId', 'copyIds'])) return null
  if (!projectId(raw.projectId) || !Array.isArray(raw.copyIds) || raw.copyIds.length > MAX_COPIES || !raw.copyIds.every(projectId)) return null
  return raw as unknown as { projectId: string; copyIds: string[] }
}
