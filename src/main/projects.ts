import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { UnfinishedRecording } from '../shared/api/recording'
import { migrateCursor, migrateProject } from '../shared/engine/project'
import type { CursorTrack, NormRect, Project, ProjectSummary } from '../shared/types'

export function projectsRoot(): string {
  return path.join(app.getPath('videos'), 'Screen Studio for Windows')
}

const ID_RE = /^[a-zA-Z0-9_-]+$/

/** Resolves a project directory, rejecting ids that could escape the projects root. */
export function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`)
  return path.join(projectsRoot(), id)
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

export async function writeProject(project: Project): Promise<void> {
  const file = path.join(projectDir(project.id), 'project.json')
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(project, null, 2))
  await fs.rename(tmp, file)
}

export async function readProject(id: string): Promise<Project> {
  return migrateProject(JSON.parse(await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8')))
}

export async function writeCursor(id: string, track: CursorTrack): Promise<void> {
  await fs.writeFile(path.join(projectDir(id), 'cursor.json'), JSON.stringify(track))
}

export async function readCursor(id: string): Promise<CursorTrack> {
  try {
    return migrateCursor(JSON.parse(await fs.readFile(path.join(projectDir(id), 'cursor.json'), 'utf8')))
  } catch {
    return migrateCursor(undefined)
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsRoot()
  await fs.mkdir(root, { recursive: true })
  const entries = await fs.readdir(root, { withFileTypes: true })
  const out: ProjectSummary[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue
    try {
      const p = await readProject(e.name)
      out.push({ id: p.id, name: p.name, createdAt: p.createdAt, duration: p.duration, dir: projectDir(p.id) })
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
  webcamFps: number
  webcamOffset: number
  audioOffset: number
  /** Measured duration in seconds (null until the recording stopped). */
  duration: number | null
}

export async function writeManifest(m: RecordingManifest): Promise<void> {
  const file = path.join(projectDir(m.id), MANIFEST)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(m, null, 2))
  await fs.rename(tmp, file)
}

export async function readManifest(id: string): Promise<RecordingManifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir(id), MANIFEST), 'utf8')) as RecordingManifest
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
  const root = projectsRoot()
  await fs.mkdir(root, { recursive: true })
  const out: UnfinishedRecording[] = []
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !ID_RE.test(e.name) || exclude.has(e.name)) continue
    const dir = projectDir(e.name)
    if (await exists(path.join(dir, 'project.json'))) continue
    const bytes = await rawBytes(dir)
    if (bytes === 0) continue
    const m = (await readManifest(e.name)) ?? (await legacyManifest(e.name))
    out.push({
      id: e.name,
      createdAt: m.createdAt,
      status: m.status === 'failed' ? 'failed' : 'interrupted',
      error: m.error,
      dir,
      bytes
    })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
