/**
 * The export bundle (F-11, docs/design/hands-off.md §2.8): which files are saved next to an
 * exported video (SRT, VTT, chapter list, thumbnail, description), their names, and the parts of
 * "one file per chapter". Pure: the export dialog makes the contents, main writes them
 * (src/main/exportBundle.ts).
 */
import { planOf, videoDuration, videoToEdit } from '../engine/freeze'
import type { Clip, ExportFormat, Project } from '../types'
import { outputChapters, youtubeChapters, type OutputChapter } from './chapters'

export type SidecarKind = 'srt' | 'vtt' | 'chapters' | 'thumbnail' | 'description'

export const SIDECAR_KINDS: readonly SidecarKind[] = ['srt', 'vtt', 'chapters', 'thumbnail', 'description']

/** The dialog's "Also save" choices, remembered between exports. */
export interface BundleOptions {
  srt: boolean
  vtt: boolean
  chapters: boolean
  thumbnail: boolean
  description: boolean
  /** One file per chapter: "01 Intro.mp4", "02 Billing.mp4" into a folder. */
  perChapter: boolean
}

export const NO_BUNDLE: BundleOptions = { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false }

/** Stored choices with anything unknown or missing turned off. */
export function normalizeBundle(raw: unknown): BundleOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...NO_BUNDLE }
  for (const k of Object.keys(NO_BUNDLE) as (keyof BundleOptions)[]) out[k] = r[k] === true
  return out
}

/** What the video has to put in the files. */
export interface BundleSources {
  captions: boolean
  chapters: boolean
  /** A freeze frame that keeps the sound playing runs across a chapter start (stillAcrossChapters). */
  stillAcross?: boolean
}

/** Labels of the chips, in order. */
export const SIDECAR_LABELS: Record<SidecarKind, string> = {
  srt: 'Captions (SRT)',
  vtt: 'Captions (VTT)',
  chapters: 'Chapter list',
  thumbnail: 'Thumbnail',
  description: 'Description'
}

/** Why `kind` cannot be saved with this export, or null when it can. */
export function sidecarBlocked(kind: SidecarKind, format: ExportFormat, has: BundleSources): string | null {
  if (format === 'gif') return 'GIFs are saved alone'
  if ((kind === 'srt' || kind === 'vtt') && !has.captions) return 'This video has no captions yet'
  if (kind === 'chapters' && !has.chapters) return 'This video has no chapters'
  if (kind === 'thumbnail' && format === 'm4a') return 'Audio files have no thumbnail'
  return null
}

/** Why one file per chapter is not possible, or null. */
export function perChapterBlocked(has: BundleSources, mode: 'single' | 'batch'): string | null {
  if (mode === 'batch') return 'One file per chapter works with One file'
  if (!has.chapters) return 'Add chapters first'
  if (has.stillAcross) return 'A freeze frame that keeps the sound playing runs across a chapter start: move it or the chapter, or export one file'
  return null
}

/** The export dialog's line on the video's `count` chapters: where they end up. A part has no chapter markers. */
export function chaptersNote(count: number, gif: boolean, perChapter: boolean): string {
  const n = `${count} chapter${count === 1 ? '' : 's'}`
  if (gif) return `${n} · GIFs have no chapters, other formats keep them.`
  return perChapter ? `${n}, one file each (the files have no chapter markers).` : `${n}, written into the file.`
}

/**
 * The files saved with each exported file. A part of "one file per chapter" has no chapter list of
 * its own (it is one chapter).
 */
export function bundleKinds(o: BundleOptions, format: ExportFormat, has: BundleSources, part = false): SidecarKind[] {
  return SIDECAR_KINDS.filter((k) => o[k] && !sidecarBlocked(k, format, has) && !(part && k === 'chapters'))
}

const SUFFIX: Record<SidecarKind, string> = {
  srt: '.srt',
  vtt: '.vtt',
  chapters: ' - chapters.txt',
  thumbnail: ' - thumbnail.png',
  description: ' - description.txt'
}

/** "Demo.mp4" → "Demo.srt", "Demo - chapters.txt", "Demo - thumbnail.png", ... */
export function sidecarName(videoFile: string, kind: SidecarKind): string {
  const dot = videoFile.lastIndexOf('.')
  const stem = dot > 0 ? videoFile.slice(0, dot) : videoFile
  return `${stem}${SUFFIX[kind]}`
}

/** A part of "one file per chapter": the chapter's range of the video. */
export interface ChapterPart {
  index: number
  title: string
  /** Video seconds of the whole export. */
  start: number
  end: number
  /** Edit second where it starts (0 for the first). */
  editStart: number
  /** The project's clips cut to the range. */
  clips: Clip[]
}

const EPS = 1e-6

/** The pieces of `clips` shown between edit seconds `e0` and `e1`. */
export function clipsBetween(clips: readonly Clip[], e0: number, e1: number): Clip[] {
  const out: Clip[] = []
  let acc = 0
  for (const c of clips) {
    const len = (c.end - c.start) / c.speed
    const a = Math.max(e0, acc)
    const b = Math.min(e1, acc + len)
    if (b - a > EPS) out.push({ ...c, start: c.start + (a - acc) * c.speed, end: b >= acc + len - EPS ? c.end : c.start + (b - acc) * c.speed })
    acc += len
  }
  return out
}

/**
 * One part per chapter of the export (outputChapters, video time). The first part starts at 0:00:
 * what comes before the first chapter belongs to it, as YouTube reads chapters. Each range is mapped
 * back to edit time (a chapter at a pause freeze starts with the freeze) and to clip pieces.
 */
export function chapterParts(project: Pick<Project, 'clips' | 'freezes' | 'chapters'>): ChapterPart[] {
  const plan = planOf(project)
  const chapters = outputChapters(project.chapters ?? [], project.clips, plan)
  if (!chapters.length) return []
  const total = videoDuration(project.clips, plan)
  const parts: ChapterPart[] = []
  chapters.forEach((c, i) => {
    const start = i === 0 ? 0 : c.start
    const end = i + 1 < chapters.length ? chapters[i + 1].start : total
    const e0 = i === 0 ? 0 : videoToEdit(plan, start).edit
    const e1 = i + 1 < chapters.length ? videoToEdit(plan, end).edit : Infinity
    const clips = clipsBetween(project.clips, e0, e1)
    if (clips.length) parts.push({ index: parts.length, title: c.title, start, end, editStart: e0, clips })
  })
  return parts
}

/**
 * True when a freeze that keeps the sound playing (a still over a span of the edit) is cut by a
 * part's start: a part cannot begin inside a still (the engine anchors a still at its own frame), so
 * that part would show live video where the whole export shows the frozen frame.
 */
export function stillAcrossChapters(project: Pick<Project, 'clips' | 'freezes'>, parts: readonly Pick<ChapterPart, 'editStart'>[]): boolean {
  const { stills } = planOf(project)
  return parts.slice(1).some((p) => stills.some((s) => p.editStart > s.editStart + 1e-6 && p.editStart < s.editEnd - 1e-6))
}

/**
 * The project as part `part` exports it: its clips, no chapter markers, and only the freezes inside
 * it (one exactly at the part's end belongs to the next part, which starts with it).
 */
export function partProject<T extends Pick<Project, 'clips' | 'freezes' | 'chapters'>>(project: T, part: ChapterPart, last: boolean): T {
  const end = part.clips[part.clips.length - 1].end
  const inside = (at: number): boolean => part.clips.some((c) => at >= c.start - 1e-9 && at < c.end - 1e-9) || (last && Math.abs(at - end) <= 1e-3)
  const out = { ...project, clips: part.clips }
  delete (out as Partial<T>).chapters
  if (project.freezes) {
    const freezes = project.freezes.filter((f) => inside(f.at))
    if (freezes.length) out.freezes = freezes
    else delete (out as Partial<T>).freezes
  }
  return out
}

/** Longest chapter title kept in a file name. */
const NAME_TITLE_MAX = 120

/** A file name part without characters Windows refuses (as exportPresets' safeFileName). */
function safeName(name: string, fallback: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_TITLE_MAX)
    .replace(/[. ]+$/, '')
    .trim()
  return clean || fallback
}

/** "01 Intro.mp4", "02 Billing.mp4"; three digits from 100 parts, each name once. */
export function partFileNames(parts: readonly Pick<ChapterPart, 'title'>[], ext: string): string[] {
  const width = Math.max(2, String(parts.length).length)
  const seen = new Set<string>()
  return parts.map((p, i) => {
    const stem = `${String(i + 1).padStart(width, '0')} ${safeName(p.title, `Chapter ${i + 1}`)}`
    let name = `${stem}.${ext}`
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} ${n}.${ext}`
    seen.add(name.toLowerCase())
    return name
  })
}

/** The chapter list file: YouTube timestamps, one per line. */
export function chapterListText(chapters: readonly OutputChapter[], length: number): string {
  const text = youtubeChapters(chapters, length).text
  return text ? `${text}\n` : ''
}

/**
 * A length in words ("1 min 15 s", "1 h 2 min"), whole seconds as the chapter timestamps count them.
 * Never "m:ss": YouTube makes chapters only when the description's first timestamp is 0:00.
 */
function lengthInWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6))
  const units: [number, string][] = [
    [Math.floor(s / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'min'],
    [s % 60, 's']
  ]
  const words = units.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}`)
  return words.length ? words.join(' ') : '0 s'
}

/**
 * The description file: the title, the length, and the chapters as YouTube timestamps (paste it
 * into the video's description). A part says which part of which video it is.
 */
export function descriptionText(title: string, length: number, chapters: readonly OutputChapter[], part?: { index: number; count: number; of: string }): string {
  const lines = [title.trim() || 'Untitled', '']
  if (part) lines.push(`Part ${part.index + 1} of ${part.count} of ${part.of.trim() || 'the video'}`)
  lines.push(`Length: ${lengthInWords(length)}`)
  const list = chapters.length ? youtubeChapters(chapters, length).text : ''
  if (list) lines.push('', 'Chapters', list)
  return `${lines.join('\n')}\n`
}

/** Largest text sidecar accepted by main. */
export const MAX_SIDECAR_TEXT = 1024 * 1024
