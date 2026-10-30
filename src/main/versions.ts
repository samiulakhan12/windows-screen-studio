/**
 * Versions of an edit on disk (E-12, docs/design/versions.md §2.1, §2.5): `<project>/versions/`
 * holds one file per version (its meta and the project as it was) and `index.json`, a cache of
 * the metas that is rebuilt from the files whenever it is missing, unreadable or behind. Writes
 * are synchronous and atomic (writeFileAtomicSync): a version's file first, then the index, so
 * two requests never interleave and a crash between them loses nothing.
 *
 * Everything here takes the project folder made by projects.projectDir (which checks the id);
 * version ids are checked against VERSION_ID_RE and paths are built here only.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { migrateProject } from '../shared/engine/project'
import {
  AUTO_REASONS,
  autoVersionName,
  cleanVersionName,
  defaultVersionName,
  prunedAutos,
  sanitizeMeta,
  VERSION_ID_RE,
  VERSION_LIMITS,
  versionSummary,
  type AutoReason,
  type VersionMeta
} from '../shared/editor/versions'
import type { Project } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'

export const VERSIONS_DIR = 'versions'
const INDEX = 'index.json'
const FORMAT = 'flown-version'
const FILE_RE = /^(v-[0-9a-z]{6,12}-[0-9a-f]{8})\.json$/

/** A refusal whose message is the sentence to show. */
export class VersionError extends Error {}

/**
 * `dir`/versions, checked to be a real folder (never a link or junction that could point
 * anywhere); null when it does not exist and `create` is false.
 */
export function versionsDir(dir: string, create = false): string | null {
  const folder = path.join(dir, VERSIONS_DIR)
  let st: fs.Stats | null = null
  try {
    st = fs.lstatSync(folder)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new VersionError('The versions folder of this recording is not a folder.')
  if (!st) {
    if (!create) return null
    if (!fs.existsSync(dir)) throw new VersionError('The recording folder no longer exists.')
    fs.mkdirSync(folder)
  }
  return folder
}

const fileOf = (folder: string, id: string): string => {
  if (!VERSION_ID_RE.test(id)) throw new VersionError('Unknown version')
  return path.join(folder, `${id}.json`)
}

/** JSON with every object's keys sorted: the same edit gives the same text whatever order its fields were set in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v
  )
}

export const hashProject = (p: Project): string => createHash('sha256').update(canonicalJson(p)).digest('hex')

/** A new version id: the time, then random hex (§2.2). */
export const newVersionId = (now: number = Date.now()): string => `v-${now.toString(36)}-${randomBytes(4).toString('hex')}`

/** The meta of the version file `file` (its own copy of it), or null when it cannot be read as one. */
function readFileMeta(file: string, id: string): VersionMeta | null {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > VERSION_LIMITS.bytes + 64 * 1024) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { format?: unknown; meta?: unknown }
    if (raw?.format !== FORMAT) return null
    const meta = sanitizeMeta(raw.meta)
    return meta && meta.id === id ? { ...meta, bytes: st.size } : null
  } catch {
    return null
  }
}

const newestFirst = (a: VersionMeta, b: VersionMeta): number => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)

function writeIndex(folder: string, items: readonly VersionMeta[]): void {
  writeFileAtomicSync(path.join(folder, INDEX), JSON.stringify({ v: 1, items }, null, 1), { attempts: 4 })
}

/**
 * Every version of the project in `dir`, newest first. The index is checked against the files:
 * entries without a file are dropped, files it does not list are adopted (read from their own
 * meta); when anything was out of line the index is written again (best effort).
 */
export function listVersions(dir: string): VersionMeta[] {
  const folder = versionsDir(dir)
  if (!folder) return []
  const files = new Map<string, string>()
  for (const name of fs.readdirSync(folder)) {
    const m = FILE_RE.exec(name)
    if (m) files.set(m[1], name)
  }
  let indexed: VersionMeta[] = []
  let stale = false
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(folder, INDEX), 'utf8')) as { v?: unknown; items?: unknown }
    if (raw?.v !== 1 || !Array.isArray(raw.items)) throw new Error('not an index')
    indexed = raw.items.slice(0, VERSION_LIMITS.index).map(sanitizeMeta).filter((m): m is VersionMeta => m !== null)
    if (indexed.length !== raw.items.length) stale = true
  } catch {
    stale = files.size > 0
  }
  const seen = new Set<string>()
  const out: VersionMeta[] = []
  for (const m of indexed) {
    if (seen.has(m.id) || !files.has(m.id)) {
      stale = true
      continue
    }
    seen.add(m.id)
    out.push(m)
  }
  for (const id of files.keys()) {
    if (seen.has(id) || out.length >= VERSION_LIMITS.index) continue
    const meta = readFileMeta(path.join(folder, `${id}.json`), id)
    if (!meta) continue
    out.push(meta)
    stale = true
  }
  out.sort(newestFirst)
  if (stale) {
    try {
      writeIndex(folder, out)
    } catch (err) {
      console.warn('Could not write the versions index again:', err)
    }
  }
  return out
}

export interface SaveVersionOptions {
  /** The name the user typed (named versions). */
  name?: unknown
  /** Why Flown keeps it (automatic versions). */
  reason?: unknown
  /** The name of the version being opened (reason 'open'). */
  about?: unknown
  now?: Date
}

export interface SaveVersionResult {
  /** The version kept; null when an automatic one equals a kept version (nothing to keep). */
  saved: VersionMeta | null
  /** Automatic versions removed to stay within the limit. */
  removed: string[]
}

/**
 * The editor's project `raw` as a new version of project `projectId` in folder `dir`: checked as
 * a copy is (migrateProject, its own id, its size), then written (§2.2-2.4).
 */
export function saveVersion(dir: string, projectId: string, raw: unknown, opts: SaveVersionOptions = {}): SaveVersionResult {
  let reason: AutoReason | null = null
  if (opts.reason !== undefined && opts.reason !== null) {
    if (typeof opts.reason !== 'string' || !(AUTO_REASONS as readonly string[]).includes(opts.reason)) throw new VersionError('Unknown reason')
    reason = opts.reason as AutoReason
  }
  let project: Project
  try {
    project = migrateProject(raw)
  } catch {
    throw new VersionError('This is not an edit Flown can keep.')
  }
  // The editor may only keep versions of the project it has open.
  if (project.id !== projectId) throw new VersionError('Not allowed')
  const json = JSON.stringify(project)
  if (json.length > VERSION_LIMITS.bytes) throw new VersionError('This edit is too large to keep as a version.')
  const hash = hashProject(project)
  const now = opts.now ?? new Date()

  const list = listVersions(dir)
  if (reason && list.some((v) => v.hash === hash)) return { saved: null, removed: [] }
  const named = list.filter((v) => !v.auto).length
  if (!reason && named >= VERSION_LIMITS.named) throw new VersionError(`You have ${VERSION_LIMITS.named} saved versions. Delete one to save another.`)

  const folder = versionsDir(dir, true)!
  let id = newVersionId(now.getTime())
  while (list.some((v) => v.id === id)) id = newVersionId(now.getTime())
  const about = typeof opts.about === 'string' ? cleanVersionName(opts.about, 'a version') : undefined
  const meta: VersionMeta = {
    id,
    name: reason ? autoVersionName(reason, about) : cleanVersionName(opts.name, defaultVersionName(named)),
    auto: reason !== null,
    ...(reason ? { reason } : {}),
    createdAt: now.toISOString(),
    bytes: 0,
    hash,
    summary: versionSummary(project)
  }
  const body = `{"format":"${FORMAT}","v":1,"meta":${JSON.stringify(meta)},"project":${json}}`
  meta.bytes = Buffer.byteLength(body)
  // The size in the file's own meta is left 0: the listing reads it from the file.
  writeFileAtomicSync(fileOf(folder, id), body, { attempts: 4 })

  const next = [meta, ...list].sort(newestFirst)
  const removed = reason ? prunedAutos(next) : []
  for (const old of removed) fs.rmSync(fileOf(folder, old), { force: true, maxRetries: 3 })
  writeIndex(folder, next.filter((v) => !removed.includes(v.id)))
  return { saved: meta, removed }
}

/** Gives version `id` a new name (empty: kept as it was). */
export function renameVersion(dir: string, id: string, name: unknown): VersionMeta {
  if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) throw new VersionError('Unknown version')
  const list = listVersions(dir)
  const found = list.find((v) => v.id === id)
  if (!found) throw new VersionError('This version is no longer there.')
  const renamed = { ...found, name: cleanVersionName(name, found.name) }
  if (renamed.name === found.name) return found
  writeIndex(versionsDir(dir)!, list.map((v) => (v.id === id ? renamed : v)))
  return renamed
}

/**
 * Removes version `id` for good: its file first (an index entry without a file is dropped when
 * listed, while a file without an entry would come back), then its index entry.
 */
export function deleteVersion(dir: string, id: string): void {
  if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) throw new VersionError('Unknown version')
  const folder = versionsDir(dir)
  if (!folder) return
  fs.rmSync(fileOf(folder, id), { force: true, maxRetries: 3 })
  writeIndex(folder, listVersions(dir).filter((v) => v.id !== id))
}

/** The project kept as version `id`, read and checked; its id is the folder's (`projectId`). */
export async function readVersion(dir: string, projectId: string, id: string): Promise<{ meta: VersionMeta; project: Project }> {
  if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) throw new VersionError('Unknown version')
  const folder = versionsDir(dir)
  if (!folder) throw new VersionError('This version is no longer there.')
  const file = fileOf(folder, id)
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(file)
  } catch {
    throw new VersionError('This version is no longer there.')
  }
  if (!st.isFile() || st.size > VERSION_LIMITS.bytes + 64 * 1024) throw new VersionError('This version could not be read.')
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { format?: unknown; meta?: unknown; project?: unknown }
    const meta = raw?.format === FORMAT ? sanitizeMeta(raw.meta) : null
    if (!meta || meta.id !== id) throw new Error('not a version')
    return { meta: { ...meta, bytes: st.size }, project: { ...migrateProject(raw.project), id: projectId } }
  } catch {
    throw new VersionError('This version could not be read.')
  }
}
