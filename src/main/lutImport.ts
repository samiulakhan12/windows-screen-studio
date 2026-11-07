/**
 * Importing a .cube LUT into a project (docs/design/editing-polish.md §9.5, §14 rule 1). The file
 * is untrusted: its size is checked before it is read (16 MiB at most, and never more than that
 * read), it is parsed strictly in full (cubeLut.ts) and refused before anything is copied, then
 * hashed (SHA-256) and stored from the same bytes as lut-<n>.cube under a temporary name that is
 * renamed into place. Every import gets a new name, so the LUT in use is never overwritten and
 * undo can go back to it; the folder keeps the three newest imports and every LUT the saved project
 * names. The renderer later reads the file back, checks this hash and parses it again before using
 * it (render/lutCache.ts).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nextPickFile, stalePickFiles, type PickedFiles } from '../shared/engine/picks'
import { CubeError, CUBE_LIMITS, parseCube } from '../shared/render/cubeLut'
import { cleanLutTitle, readProjectGrade } from '../shared/render/gradeData'

/** LUT imports: lut-<n>.cube, the three newest kept (besides the ones the saved project uses). */
export const LUT_PICKS: PickedFiles = { base: 'lut', re: /^lut(-[1-9][0-9]{0,8})\.cube$/, keep: 3 }

const CHOOSE = 'Choose a .cube LUT.'

/** The file's bytes, its size checked first and never more than the limit read. */
async function readCapped(source: string): Promise<Buffer> {
  const handle = await fs.open(source, 'r')
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new Error(CHOOSE)
    if (st.size === 0) throw new Error('This file is empty.')
    const tooLarge = (size: number): Error => new Error(`The file is too large (${Math.ceil(size / 2 ** 20)} MB; ${CUBE_LIMITS.maxBytes / 2 ** 20} MB at most).`)
    if (st.size > CUBE_LIMITS.maxBytes) throw tooLarge(st.size)
    // One byte more than allowed is asked for, so a file that grew since is noticed.
    const buf = Buffer.alloc(Math.min(st.size, CUBE_LIMITS.maxBytes) + 1)
    let got = 0
    for (;;) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
      if (got === buf.length) break
    }
    if (got > CUBE_LIMITS.maxBytes) throw tooLarge(got)
    return buf.subarray(0, got)
  } finally {
    await handle.close()
  }
}

/** The LUT files the saved project in `projectDir` uses (none when it cannot be read). */
async function savedLuts(projectDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf8')) as { grade?: unknown }
    const grade = readProjectGrade(raw?.grade)
    return [grade?.screen?.lut?.file, grade?.camera?.lut?.file, grade?.auto?.camera?.lut?.file].filter((f): f is string => typeof f === 'string')
  } catch {
    return []
  }
}

/**
 * Copies the .cube LUT `source` into the project folder `projectDir` as lut-<n>.cube after checking
 * it in full, and returns its file name, SHA-256, title (its TITLE, else its file name, as plain
 * text of at most 80 characters) and 3D size. Throws the reason it is refused (the parser's names
 * the line); nothing is written then.
 */
export async function importLut(projectDir: string, source: string): Promise<{ file: string; sha256: string; title: string; size: number }> {
  if (typeof source !== 'string' || source.includes('\0') || !path.isAbsolute(source)) throw new Error(CHOOSE)
  const ext = path.extname(source)
  if (ext.toLowerCase() !== '.cube') throw new Error(CHOOSE)
  const data = await readCapped(source)
  let lut
  try {
    lut = parseCube(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  } catch (err) {
    throw new Error(err instanceof CubeError ? err.message : 'This LUT could not be used.')
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const title = lut.title || cleanLutTitle(path.basename(source, ext)) || 'LUT'
  const existing = await fs.readdir(projectDir)
  const file = nextPickFile(LUT_PICKS, existing, 'cube')
  const tmp = path.join(projectDir, `.${file}.part`)
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, path.join(projectDir, file))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  // Earlier imports nothing goes back to: all but the three newest, the new one and the saved project's.
  try {
    const keep = new Set([file, ...(await savedLuts(projectDir))])
    for (const name of stalePickFiles(LUT_PICKS, await fs.readdir(projectDir), keep)) await fs.rm(path.join(projectDir, name), { force: true })
  } catch (err) {
    console.warn('Could not remove earlier LUT imports:', err)
  }
  return { file, sha256, title, size: lut.size }
}
