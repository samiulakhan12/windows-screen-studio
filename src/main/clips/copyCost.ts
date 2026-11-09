/**
 * What copies of a project cost on disk (docs/design/smart-tools.md §8.5 step 6), before Short
 * clips makes them: whether the recording's media can be linked (not under OneDrive, linkAllowed),
 * the bytes one copy writes (the files Duplicate copies, and the media too when they cannot be
 * linked) and the free space where copies go. Reads only; the contracts register its channel
 * (projects:copyCost), which answers the main window only.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CopyCost } from '../../shared/api/projects'
import { copiedFile, linkAllowed, NOT_COPIED_DIRS } from '../projectCopy'
import * as projects from '../projects'

/** Why the cost could not be read, as the panel shows it. */
const READ_FAILED = "The recording's files could not be read."

/** Bytes of the regular file `file` (no links, no folders), or 0. */
async function fileBytes(file: string): Promise<number> {
  const st = await fs.lstat(file).catch(() => null)
  return st?.isFile() ? st.size : 0
}

/**
 * The cost of one copy of project `sourceId` (Duplicate's files: projectCopy.ts copiedFile), and
 * the free space under the projects folder. Rejects for an id that is not a project's, or when
 * its folder cannot be read.
 */
export async function copyCost(sourceId: unknown): Promise<CopyCost> {
  if (typeof sourceId !== 'string') throw new Error('Invalid project id')
  // Throws for an id that could leave the projects root.
  const src = projects.projectDir(sourceId)
  const root = projects.projectsRoot()
  const linked = linkAllowed(root) && linkAllowed(src)
  let entries: string[]
  try {
    entries = await fs.readdir(src)
  } catch {
    throw new Error(READ_FAILED)
  }
  let bytes = 0
  for (const entry of entries) {
    if (NOT_COPIED_DIRS.includes(entry)) continue
    if (entry === '.cache') {
      const cache = path.join(src, entry)
      if (!(await fs.lstat(cache).catch(() => null))?.isDirectory()) continue
      for (const name of await fs.readdir(cache).catch(() => [] as string[])) {
        if (copiedFile(`.cache/${name}`)) bytes += await fileBytes(path.join(cache, name))
      }
      continue
    }
    const how = copiedFile(entry)
    if (!how || (how === 'link' && linked)) continue
    bytes += await fileBytes(path.join(src, entry))
  }
  let free = 0
  try {
    const st = await fs.statfs(root)
    free = st.bavail * st.bsize
  } catch {
    throw new Error(READ_FAILED)
  }
  return { linked, bytes, free }
}
