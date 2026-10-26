import { app } from 'electron'
import { existsSync, promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '../shared/brand'
import type { UnfinishedRecording } from '../shared/api/recording'
import { migrateCursor, migrateProject } from '../shared/engine/project'
import { cleanNotesText, NOTES_TEXT_MAX, readProjectScript } from '../shared/notes/notes'
import type { CursorTrack, NormRect, Project, ProjectScript, ProjectSummary } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'

/** Where recordings are kept: Videos\Flown. */
export function projectsRoot(): string {
  return path.join(app.getPath('videos'), APP_NAME)
}

/**
 * Older recordings folders still listed because the start-up move could not empty them
 * (brandMigration.ts). Usually none.
 */
let legacyRoots: string[] = []

export function setLegacyProjectRoots(roots: readonly string[]): void {
  legacyRoots = [...roots]
}

/** Every folder the library lists, the current one first (it wins when an id is in two). */
const allRoots = (): string[] => [projectsRoot(), ...legacyRoots]

const ID_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Resolves a project directory, rejecting ids that could escape the projects root. An id found
 * only in a legacy root resolves there; new ids always land in the current root (createProjectDir
 * skips ids a legacy root holds, since their folder exists).
 */
export function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`)
  const dir = path.join(projectsRoot(), id)
  if (legacyRoots.length && !existsSync(dir)) {
    for (const root of legacyRoots) if (existsSync(path.join(root, id))) return path.join(root, id)
  }
  return dir
}

/** Folder names of every root, each id once (the current root's copy first). */
async function projectFolders(): Promise<string[]> {
  await fs.mkdir(projectsRoot(), { recursive: true })
  const seen = new Set<string>()
  for (const root of allRoots()) {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue // a legacy root removed meanwhile
    }
    for (const e of entries) if (e.isDirectory() && ID_RE.test(e.name)) seen.add(e.name)
  }
  return [...seen]
}

/** Creates a new, never reused project folder (a suffix is added when the second is taken). */
export async function createProjectDir(now = new Date()): Promise<{ id: string; dir: string }> {
  await fs.mkdir(projectsRoot(), { recursive: true })
  const pad = (n: number): string => n.toString().padStart(2, '0')
  const d = now
  const base = `rec-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const dir = projectDir(id)
    try {
      await fs.mkdir(dir)
      return { id, dir }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not create a folder for the recording')
}

/**
 * Small JSON state files go through writeFileAtomicSync: a temporary file and a rename,
 * retried while Windows reports a short-lived lock (antivirus, indexer, OneDrive or
 * Explorer's preview holding the file). Being synchronous, two writes of the same file
 * can never interleave.
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  // At most ~150 ms of retries; the callers keep the state in memory and write it again later.
  writeFileAtomicSync(file, JSON.stringify(value, null, 2), { attempts: 4 })
}

export async function writeProject(project: Project): Promise<void> {
  await writeJsonAtomic(path.join(projectDir(project.id), 'project.json'), project)
}

/**
 * The folder decides the id: a copied folder (a backup, a OneDrive conflict copy) still holds
 * the original's id, which would make loading, saving and deleting it act on the original.
 */
export async function readProject(id: string): Promise<Project> {
  return { ...migrateProject(JSON.parse(await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8'))), id }
}

export async function writeCursor(id: string, track: CursorTrack): Promise<void> {
  writeCursorSync(id, track)
}

/** Atomic like the other state files: a failed or interrupted write never truncates the track. */
export function writeCursorSync(id: string, track: CursorTrack): void {
  writeFileAtomicSync(path.join(projectDir(id), 'cursor.json'), JSON.stringify(track), { attempts: 4 })
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * "Zoom here" marks and typing bursts of a stored track (newer recordings), validated; absent
 * from older tracks. Kept here so they survive migrateCursor().
 */
export function inputEvents(raw: unknown): Pick<CursorTrack, 'marks' | 'typing'> {
  const c = (raw ?? {}) as { marks?: unknown; typing?: unknown }
  const out: Pick<CursorTrack, 'marks' | 'typing'> = {}
  if (Array.isArray(c.marks)) {
    out.marks = c.marks.filter((m): m is { t: number } => finite((m as { t?: unknown } | null)?.t)).map((m) => ({ t: m.t }))
  }
  if (Array.isArray(c.typing)) {
    out.typing = c.typing
      .filter((b): b is { t: number; end: number } => finite((b as { t?: unknown } | null)?.t) && finite((b as { end?: unknown }).end))
      .filter((b) => b.end >= b.t)
      .map((b) => ({ t: b.t, end: b.end }))
  }
  return out
}

export async function readCursor(id: string): Promise<CursorTrack> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(projectDir(id), 'cursor.json'), 'utf8'))
    return { ...migrateCursor(raw), ...inputEvents(raw) }
  } catch {
    return migrateCursor(undefined)
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const out: ProjectSummary[] = []
  for (const name of await projectFolders()) {
    try {
      const p = await readProject(name)
      out.push({ id: p.id, name: p.name, createdAt: p.createdAt, duration: p.duration, dir: projectDir(name) })
    } catch {
      // Not a finished project; unfinished recordings are listed by listUnfinished().
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(projectDir(id), { recursive: true, force: true, maxRetries: 3 })
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

/** Raw media written while recording; deleted once the editing proxies exist. */
export const RAW = {
  screen: 'screen.webm',
  native: 'native.mp4',
  webcam: 'webcam.webm',
  audio: 'audio.webm'
} as const

/**
 * The speaker notes read during the recording (UTF-8), written when it is prepared and kept with
 * it: finalize copies it into project.json `script`. Not in RAW, so never removed as an intermediate.
 */
export const SCRIPT_FILE = 'script.txt'

/** Writes the speaker notes into recording folder `dir` (script.txt). */
export async function writeScriptFile(dir: string, text: string): Promise<void> {
  await fs.writeFile(path.join(dir, SCRIPT_FILE), cleanNotesText(text), 'utf8')
}

/**
 * The speaker notes kept in recording folder `dir`, cleaned and capped (readProjectScript);
 * undefined when there is none. Reads at most what NOTES_TEXT_MAX characters can take in UTF-8.
 */
export async function readScriptFile(dir: string): Promise<ProjectScript | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(path.join(dir, SCRIPT_FILE), 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read the speaker notes kept with the recording:', err)
    return undefined
  }
  try {
    // 3 bytes per UTF-16 unit at most, plus one partial character that is cut away anyway.
    const buffer = Buffer.alloc(3 * NOTES_TEXT_MAX + 3)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return readProjectScript({ text: buffer.subarray(0, bytesRead).toString('utf8') })
  } catch (err) {
    console.warn('Could not read the speaker notes kept with the recording:', err)
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const MANIFEST = 'recording.json'

/**
 * Everything needed to (re)process a raw recording into a project. Written when a
 * recording starts and updated as it progresses, so an interrupted or failed
 * recording can always be recovered from its folder.
 */
export interface RecordingManifest {
  version: 1
  id: string
  createdAt: string
  status: 'recording' | 'processing' | 'failed' | 'interrupted'
  error: string | null
  method: 'native' | 'chromium'
  sourceKind: 'screen' | 'window'
  region: NormRect | null
  /** Epoch ms of the video timeline start (null until recording started). */
  startedAt: number | null
  /** Encoded screen video size in physical pixels (0 = unknown). */
  width: number
  height: number
  hasAudio: boolean
  hasWebcam: boolean
  /** Screen capture frame rate (absent in older manifests: 60). */
  fps?: 30 | 60
  webcamFps: number
  webcamOffset: number
  audioOffset: number
  /** Measured duration in seconds (null until the recording stopped). */
  duration: number | null
}

export async function writeManifest(m: RecordingManifest): Promise<void> {
  await writeJsonAtomic(path.join(projectDir(m.id), MANIFEST), m)
}

export async function readManifest(id: string): Promise<RecordingManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(projectDir(id), MANIFEST), 'utf8')) as RecordingManifest
    // The folder decides, as for projects: recovering a copied folder must never process (or,
    // when it holds no video, delete) the folder its manifest was copied from.
    return { ...m, id }
  } catch {
    return null
  }
}

export async function removeManifest(id: string): Promise<void> {
  await fs.rm(path.join(projectDir(id), MANIFEST), { force: true, maxRetries: 3 }).catch(() => undefined)
}

async function rawBytes(dir: string): Promise<number> {
  let total = 0
  for (const f of Object.values(RAW)) total += await fileSize(path.join(dir, f))
  return total
}

/**
 * A manifest for a folder without one: raw media left behind by an older version
 * or by a crash before the manifest was written. Unknown values are probed later.
 */
export async function legacyManifest(id: string): Promise<RecordingManifest> {
  const dir = projectDir(id)
  const stat = await fs.stat(dir)
  const native = (await fileSize(path.join(dir, RAW.native))) > 0
  return {
    version: 1,
    id,
    createdAt: stat.mtime.toISOString(),
    status: 'failed',
    error: null,
    method: native ? 'native' : 'chromium',
    sourceKind: 'screen',
    region: null,
    startedAt: null,
    width: 0,
    height: 0,
    hasAudio: native ? (await fileSize(path.join(dir, RAW.audio))) > 0 : true,
    hasWebcam: (await fileSize(path.join(dir, RAW.webcam))) > 0,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null
  }
}

/** Recordings that never became a project (interrupted, or processing failed). */
export async function listUnfinished(exclude: ReadonlySet<string>): Promise<UnfinishedRecording[]> {
  const out: UnfinishedRecording[] = []
  for (const name of await projectFolders()) {
    if (exclude.has(name)) continue
    const dir = projectDir(name)
    if (await exists(path.join(dir, 'project.json'))) continue
    const bytes = await rawBytes(dir)
    if (bytes === 0) continue
    const m = (await readManifest(name)) ?? (await legacyManifest(name))
    out.push({
      id: name,
      createdAt: m.createdAt,
      status: m.status === 'failed' ? 'failed' : 'interrupted',
      error: m.error,
      dir,
      bytes
    })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
