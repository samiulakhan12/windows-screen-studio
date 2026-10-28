/**
 * Loads a project's fonts (docs/design/brand-kit.md §4.3) without widening the content security
 * policy: the bytes are fetched from studio-media:// (allowed by connect-src) and registered with
 * `new FontFace(family, bytes)`, which does no font fetch of its own. Chromium's font sanitiser
 * checks each face; one that fails stays "missing" and its text draws with the default font.
 *
 * Text layers cache measured widths and drawn sprites: they put fontGeneration() in their keys,
 * so everything measured while a font was still loading is measured again once it is ready.
 */
import { fontFamily, fontOf, fontStack } from '../../../shared/render/fonts'
import { mediaUrl } from '../../../shared/mediaUrl'
import type { Project, ProjectFont } from '../../../shared/types'
import { notifyStyleAssetsChanged } from './watermarkLayer'

export type FontState = 'loading' | 'ready' | 'missing'

interface Entry {
  state: FontState
  face: FontFace | null
  done: Promise<void>
}

const entries = new Map<string, Entry>()
let generation = 0
let currentProject: string | null = null

const keyOf = (projectId: string, font: ProjectFont): string => `${projectId}/${font.id}/${font.file}`

/** Increments whenever a font finishes loading or fails: a part of every text cache key. */
export const fontGeneration = (): number => generation

function changed(): void {
  generation++
  notifyStyleAssetsChanged()
}

/** Forgets the fonts of other projects (one editor is open at a time). */
function switchProject(projectId: string): void {
  if (currentProject === projectId) return
  currentProject = projectId
  for (const [key, e] of entries) {
    if (key.startsWith(`${projectId}/`)) continue
    if (e.face && typeof document !== 'undefined') document.fonts.delete(e.face)
    entries.delete(key)
  }
}

async function loadFace(url: string, family: string): Promise<FontFace> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`The font file is missing (${res.status})`)
  const face = new FontFace(family, await res.arrayBuffer())
  await face.load()
  return face
}

function load(projectId: string, font: ProjectFont, url: string): Entry {
  const key = keyOf(projectId, font)
  const entry: Entry = { state: 'loading', face: null, done: Promise.resolve() }
  entries.set(key, entry)
  entry.done = loadFace(url, fontFamily(font.id)).then(
    (face) => {
      if (entries.get(key) !== entry) return
      document.fonts.add(face)
      entry.face = face
      entry.state = 'ready'
      changed()
    },
    (err: unknown) => {
      if (entries.get(key) !== entry) return
      entry.state = 'missing'
      console.warn(`Font ${font.name} (${font.file}) could not be loaded; its text uses the default font:`, err)
      changed()
    }
  )
  return entry
}

function entryOf(projectId: string, font: ProjectFont, url?: string): Entry | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null
  switchProject(projectId)
  return entries.get(keyOf(projectId, font)) ?? load(projectId, font, url ?? mediaUrl(projectId, font.file))
}

/**
 * The font stack text with font `id` draws with (shared fontStack), starting to load the font
 * the first time it is asked for: the preview draws with the default font until it is ready,
 * then repaints. The export waits for it first (prepareProjectFonts).
 */
export function projectFontStack(project: Pick<Project, 'id' | 'fonts'>, id: unknown, fallback: string): string {
  const font = fontOf(project.fonts, id)
  if (font) entryOf(project.id, font)
  return fontStack(project.fonts, id, fallback)
}

/** Starts loading every font of the project (cached: a second call costs nothing). */
export function ensureProjectFonts(project: Pick<Project, 'id' | 'fonts'>): void {
  for (const f of project.fonts ?? []) entryOf(project.id, f)
}

/** Whether font `id` of the project draws: loading, ready, or missing (drawn with the default font). Null for no font. */
export function fontState(project: Pick<Project, 'id' | 'fonts'>, id: unknown): FontState | null {
  const font = fontOf(project.fonts, id)
  if (!font) return null
  return entryOf(project.id, font)?.state ?? 'missing'
}

/**
 * Loads a font newly copied into the project before the project uses it. Rejects when it
 * cannot be read (the project is then left unchanged). A font that failed before is read again:
 * its file may be back under the same name.
 */
export async function preloadProjectFont(projectId: string, font: ProjectFont, url?: string): Promise<void> {
  if (entries.get(keyOf(projectId, font))?.state === 'missing') entries.delete(keyOf(projectId, font))
  const entry = entryOf(projectId, font, url)
  if (!entry) return
  await entry.done
  if (entry.state !== 'ready') throw new Error('This font could not be read.')
}

/** Ids of the fonts text uses: annotations, title cards and captions. */
export function usedFontIds(project: Pick<Project, 'annotations' | 'titles' | 'captions' | 'fonts'>): string[] {
  const ids = new Set<string>()
  for (const a of project.annotations) if (a.font) ids.add(a.font)
  for (const c of project.titles ?? []) if (c.font) ids.add(c.font)
  if (project.captions?.font) ids.add(project.captions.font)
  return [...ids].filter((id) => !!fontOf(project.fonts, id))
}

/** Waits for every font text uses (export: before the first frame). Never rejects. */
export async function prepareProjectFonts(project: Project): Promise<void> {
  const waits: Promise<void>[] = []
  for (const id of usedFontIds(project)) {
    const e = entryOf(project.id, fontOf(project.fonts, id)!)
    if (e) waits.push(e.done)
  }
  await Promise.all(waits)
}

/** Fonts text uses that could not be loaded (drawn with the default font): for the export dialog. */
export function missingFonts(project: Project): ProjectFont[] {
  return usedFontIds(project)
    .map((id) => fontOf(project.fonts, id)!)
    .filter((f) => entries.get(keyOf(project.id, f))?.state === 'missing')
}
