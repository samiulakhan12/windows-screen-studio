import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { migrateCursor, migrateProject } from '../shared/engine/project'
import type { CursorTrack, Project, ProjectSummary } from '../shared/types'

export function projectsRoot(): string {
  return path.join(app.getPath('videos'), 'Screen Studio for Windows')
}

const ID_RE = /^[a-zA-Z0-9_-]+$/

/** Resolves a project directory, rejecting ids that could escape the projects root. */
export function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`)
  return path.join(projectsRoot(), id)
}

export async function createProjectDir(): Promise<{ id: string; dir: string }> {
  const d = new Date()
  const pad = (n: number): string => n.toString().padStart(2, '0')
  const id = `rec-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const dir = projectDir(id)
  await fs.mkdir(dir, { recursive: true })
  return { id, dir }
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
      // Incomplete or corrupt project folder: skip it.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(projectDir(id), { recursive: true, force: true })
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
