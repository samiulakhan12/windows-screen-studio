/**
 * The project's LUTs, loaded, checked and parsed (docs/design/editing-polish.md §9.5): fetched from
 * the project folder (studio-media://project/<id>/lut-<n>.cube, at most 16 MiB read), their
 * SHA-256 checked against the one recorded at import, and parsed with the same strict parser main
 * used before copying them. Parsing a 65³ file takes about 100 ms, so the frame loop never waits:
 * lutFor returns null until the LUT is ready (the grade's other stages still apply), and the
 * preview redraws when it is (onLutReady, and the style assets' notice the player listens to). Everything that must match the preview awaits
 * prepareLuts first (the export's prepare(), renderThumbnail and the contrast probe, through
 * prepareEditingAssets). A file that is missing, changed or unreadable is never used, and
 * lutProblem says so.
 */
import { mediaUrl } from '../../../shared/mediaUrl'
import { CUBE_LIMITS, parseCube, type CubeLut } from '../../../shared/render/cubeLut'
import type { ColorLut, Project } from '../../../shared/types'
import { notifyStyleAssetsChanged } from './watermarkLayer'

type Which = 'screen' | 'camera'

/** What the Colour section says when a grade's LUT cannot be used. */
export const LUT_PROBLEM = 'The LUT file is missing or has changed. Import it again.'

interface Entry {
  state: 'loading' | 'ready' | 'problem'
  lut: CubeLut | null
  /** Why it could not be used (the log's words; the panel says LUT_PROBLEM). */
  why: string | null
  /** Settles when loading is over, either way (never rejects). */
  done: Promise<void>
}

/** Loaded LUTs by project, file and hash; the least recently used go first past a few. */
const entries = new Map<string, Entry>()
const MAX_ENTRIES = 6
const listeners = new Set<() => void>()

const keyOf = (projectId: string, ref: ColorLut): string => `${projectId}\n${ref.file}\n${ref.sha256}`
const refOf = (project: Project, which: Which): ColorLut | null => project.grade?.[which]?.lut ?? null

/** A LUT became ready or unusable: the Colour sections update, and the preview redraws (as it does for fonts and logos). */
function notify(): void {
  for (const cb of [...listeners]) cb()
  notifyStyleAssetsChanged()
}

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

/** The response's bytes, never more than `max` read (an over-long file is refused before it is all read). */
async function cappedBytes(res: Response, max: number): Promise<Uint8Array> {
  const length = Number(res.headers?.get?.('content-length') ?? NaN)
  if (length > max) throw new Error('the file is larger than 16 MB')
  const reader = res.body?.getReader?.()
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer())
    if (whole.byteLength > max) throw new Error('the file is larger than 16 MB')
    return whole
  }
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('the file is larger than 16 MB')
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Reads, checks and parses one LUT file; throws why it cannot be used. */
async function load(projectId: string, ref: ColorLut): Promise<CubeLut> {
  const res = await fetch(mediaUrl(projectId, ref.file))
  if (!res.ok) throw new Error(`the file could not be read (${res.status})`)
  const bytes = await cappedBytes(res, CUBE_LIMITS.maxBytes)
  const sha = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  if (sha !== ref.sha256) throw new Error('the file has changed since it was imported')
  const lut = parseCube(bytes)
  if (lut.size !== ref.size) throw new Error('the file has changed since it was imported')
  return lut
}

function start(projectId: string, ref: ColorLut): Entry {
  const key = keyOf(projectId, ref)
  const entry: Entry = { state: 'loading', lut: null, why: null, done: Promise.resolve() }
  entry.done = load(projectId, ref).then(
    (lut) => {
      entry.state = 'ready'
      entry.lut = lut
      if (entries.get(key) === entry) notify()
    },
    (err: unknown) => {
      entry.state = 'problem'
      entry.why = err instanceof Error ? err.message : String(err)
      console.warn(`The LUT ${ref.file} is not used: ${entry.why}`)
      if (entries.get(key) === entry) notify()
    }
  )
  entries.set(key, entry)
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
  return entry
}

/** The entry of a grade's LUT, loading it when it is not yet (and marked as just used). */
function entryOf(project: Project, which: Which): Entry | null {
  const ref = refOf(project, which)
  if (!ref) return null
  const key = keyOf(project.id, ref)
  const found = entries.get(key)
  if (!found) return start(project.id, ref)
  entries.delete(key)
  entries.set(key, found)
  return found
}

/** The parsed LUT of a grade, or null while it loads (or when it is missing or changed). */
export function lutFor(project: Project, which: Which): CubeLut | null {
  return entryOf(project, which)?.lut ?? null
}

/** What is wrong with a grade's LUT (LUT_PROBLEM), or null (none, loading or ready). */
export function lutProblem(project: Project, which: Which): string | null {
  return entryOf(project, which)?.state === 'problem' ? LUT_PROBLEM : null
}

/**
 * Loads both grades' LUTs (awaited before an export's first frame). A LUT that could not be used
 * before is looked at again, so a file put back is found, and one still missing is reported.
 */
export async function prepareLuts(project: Project): Promise<void> {
  const waits: Promise<void>[] = []
  for (const which of ['screen', 'camera'] as const) {
    const ref = refOf(project, which)
    if (!ref) continue
    const key = keyOf(project.id, ref)
    const found = entries.get(key)
    if (found?.state === 'problem') entries.delete(key)
    waits.push(entryOf(project, which)!.done)
  }
  await Promise.all(waits)
}

/** Calls `cb` when a LUT becomes ready (or turns out unusable); returns the function that stops it. */
export function onLutReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * The export dialog's question when a grade's LUT cannot be used (after prepareLuts), or null:
 * "The camera's LUT is missing or has changed. Export without it?"
 */
export function missingLutQuestion(project: Project): string | null {
  const screen = lutProblem(project, 'screen') !== null
  const camera = lutProblem(project, 'camera') !== null
  if (screen && camera) return "The screen's and the camera's LUTs are missing or have changed. Export without them?"
  if (screen) return "The screen's LUT is missing or has changed. Export without it?"
  if (camera) return "The camera's LUT is missing or has changed. Export without it?"
  return null
}
