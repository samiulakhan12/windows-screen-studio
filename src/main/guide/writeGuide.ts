/**
 * Writing a saved guide (docs/design/smart-tools.md §5.8, §16 rule 12): the payload checked again in
 * main (the preload checked it first), the name through the export's file-name check, and every path
 * built here from the place the save dialog gave. A PDF or HTML file is written beside its target
 * and renamed into place; Markdown goes into a new folder (" (2)" when the name is taken) holding
 * `guide.md` and `images/`, with the image names the Markdown itself refers to. Nothing is replaced
 * except the file the save dialog confirmed.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { guidePayloadProblem, imageKind, type GuideSavePayload } from '../../shared/api/guide'
import { batchFileOk, moveIntoPlace, partialPath } from '../exportJob'

/** The name used when the one sent cannot be a file name. */
export const DEFAULT_GUIDE_NAME = 'Guide'
const NAME_MAX = 120
/** Windows' reserved device names, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** The images a Markdown guide refers to, in order. */
const IMAGE_REF = /\]\(images\/(step-\d{2,3}\.png|actual\.png)\)/g

/** Whether `name` can be the guide's file or folder name: the export's file-name check, at most 120 characters, not a device name. */
export function guideNameOk(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= NAME_MAX && name.trim() === name && !/[. ]$/.test(name) && batchFileOk(`${name}.mp4`) && !RESERVED.test(name)
}

/**
 * The payload as main uses it (§5.8): refused when it does not fit GUIDE_SAVE_LIMITS (a known
 * format, HTML of at most 64 MB, Markdown of at most 2 MB, at most 300 images of at most 16 MB,
 * each a PNG, JPEG or WebP, 256 MB in all), or lacks what its format writes; a name that is not a
 * file name becomes "Guide".
 */
export function checkGuidePayload(raw: unknown): GuideSavePayload {
  const problem = guidePayloadProblem(raw)
  if (problem) throw new Error(problem)
  const p = raw as GuideSavePayload
  if (p.format === 'markdown' ? typeof p.markdown !== 'string' : typeof p.html !== 'string') throw new Error('Nothing to save.')
  const images = p.format === 'markdown' && p.images ? p.images.map((b) => new Uint8Array(b)) : undefined
  return {
    format: p.format,
    name: guideNameOk(p.name) ? p.name : DEFAULT_GUIDE_NAME,
    ...(p.format === 'markdown' ? { markdown: p.markdown } : { html: p.html }),
    ...(images ? { images } : {}),
    ...(p.page ? { page: p.page } : {})
  }
}

/** `data` written next to `file` and renamed into place. */
async function writeInPlace(file: string, data: string | Uint8Array): Promise<number> {
  const part = partialPath(file)
  try {
    await fs.writeFile(part, data)
    await moveIntoPlace(part, file)
  } catch (e) {
    await fs.rm(part, { force: true }).catch(() => undefined)
    throw e
  }
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
}

/** A new folder `name` in `parent`, or `name (2)`, `(3)`… when taken. */
async function newFolder(parent: string, name: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const dir = path.join(parent, n === 1 ? name : `${name} (${n})`)
    try {
      await fs.mkdir(dir)
      return dir
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('Could not make a folder for the guide.')
}

/**
 * Writes the guide (§5.8): `target` is the file the save dialog gave (PDF, HTML or demo) or the
 * folder it gave (Markdown, which gets a new folder inside it). A PDF writes `pdf`. The answer is
 * where it went and how many bytes were written.
 */
export async function writeGuideFiles(target: string, payload: GuideSavePayload, pdf?: Buffer): Promise<{ path: string; bytes: number }> {
  if (!path.isAbsolute(target)) throw new Error('The guide cannot be saved there.')
  if (payload.format === 'pdf') {
    if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('The PDF could not be made.')
    return { path: target, bytes: await writeInPlace(target, pdf) }
  }
  if (payload.format === 'html' || payload.format === 'demo') return { path: target, bytes: await writeInPlace(target, payload.html ?? '') }
  const markdown = payload.markdown ?? ''
  const names = [...markdown.matchAll(IMAGE_REF)].map((m) => m[1])
  const images = payload.images ?? []
  if (names.length !== images.length || new Set(names).size !== names.length) throw new Error('The guide’s pictures do not match its text.')
  if (images.some((b) => imageKind(b) !== 'png')) throw new Error('A screenshot of this guide cannot be saved.')
  const dir = await newFolder(target, guideNameOk(payload.name) ? payload.name : DEFAULT_GUIDE_NAME)
  try {
    let bytes = 0
    if (images.length) await fs.mkdir(path.join(dir, 'images'))
    for (let i = 0; i < images.length; i++) bytes += await writeInPlace(path.join(dir, 'images', names[i]), images[i])
    bytes += await writeInPlace(path.join(dir, 'guide.md'), markdown)
    return { path: dir, bytes }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}
