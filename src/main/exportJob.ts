import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ColorTags, ExportJob, FfmpegVideoEncoder, MusicSound, RecordingSound, VideoInput } from '../shared/api/export'
import { MAX_DUCK_RANGES } from '../shared/audio/automation'
import { AUDIO_LIMITS, MUSIC_FILE_RE, SOURCE_FILES, STEM_KINDS, type StemKind } from '../shared/audio/settings'
import type { ExportFormat } from '../shared/types'
import { MAX_CHAPTERS } from '../shared/render/chapters'
import { MAX_SUBTITLE_LANGUAGES, SUBTITLE_LANGUAGE_RE } from '../shared/render/exportBundle'
import { MAX_POP_TIMES, MAX_TONES } from '../shared/render/popSound'
import { validSubtitle } from '../shared/captions/subtitles'
import { FREEZE, MAX_FREEZES } from '../shared/engine/freeze'
import { MAX_SPEED, MIN_SPEED } from '../shared/engine/timeline'
import { MAX_CUT_FADE } from '../shared/render/cutFades'
import { FfmpegFailure } from './ffmpeg'
import { isVoiceStrength } from '../shared/audio/voiceClean'
import { HARDWARE_ENCODERS } from './hwEncoders'
import { validSoundGains } from '../shared/audio/soundsEdit'
import { bedLoop, soundBed, soundEffect } from '../shared/audio/soundLibrary'
import { MAX_SFX } from '../shared/render/sfxJob'

let counter = 0
const uniqueSuffix = (): string => `${process.pid}-${Date.now().toString(36)}${(counter++).toString(36)}`

/** Hidden temporary name next to the target, keeping the real extension. */
export function partialPath(finalPath: string): string {
  const ext = path.extname(finalPath)
  const base = path.basename(finalPath, ext)
  return path.join(path.dirname(finalPath), `.${base}.partial-${uniqueSuffix()}${ext}`)
}

/** Path prefix for intermediates (GIF frames, two-pass files) in the OS temp folder. */
export function tempStem(tempDir: string): string {
  return path.join(tempDir, `screen-studio-gif-${uniqueSuffix()}`)
}

const EXPORT_EXTENSIONS = ['.mp4', '.gif', '.webm', '.mov', '.m4a']

/** A plain file name a batch export may create: no folders, no reserved characters, a known extension. */
export function batchFileOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    name === path.basename(name) &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) &&
    !name.startsWith('.') &&
    !/[. ]$/.test(name) &&
    EXPORT_EXTENSIONS.includes(path.extname(name).toLowerCase())
  )
}

/** `folder/name`, or `folder/name (2)`, `(3)`, ... when taken: a batch never replaces a file. */
export function freeBatchPath(folder: string, name: string, taken: (file: string) => boolean): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let file = path.join(folder, name)
  for (let n = 2; taken(file) && n < 10000; n++) file = path.join(folder, `${stem} (${n})${ext}`)
  return file
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const isPng = (data: Uint8Array): boolean => data.byteLength > 8 && PNG_SIGNATURE.every((b, i) => data[i] === b)

/** The renderer only sees `message`; keep ffmpeg's log after a blank line for the details view. */
export function toIpcError(e: unknown): Error {
  if (e instanceof FfmpegFailure) return new Error(e.detail && e.detail !== 'cancelled' ? `${e.message}\n\n${e.detail}` : e.message)
  if (e instanceof Error) return e
  return new Error(String(e))
}

export function renameError(e: unknown, finalPath: string): Error {
  const code = (e as NodeJS.ErrnoException).code
  const name = path.basename(finalPath)
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error(`Could not save "${name}": the file is open in another app or the folder is read-only. Close it and export again.`)
  }
  if (code === 'ENOSPC') return new Error('The disk is full.')
  return new Error(`Could not save "${name}" (${code ?? (e as Error).message}).`)
}

/** Renames with a few retries: on Windows an antivirus scan can hold a fresh file briefly. */
export async function moveIntoPlace(from: string, to: string, rename = fs.rename, backoffMs = 150): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw renameError(e, to)
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }
}

const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const ENCODERS: FfmpegVideoEncoder[] = [...HARDWARE_ENCODERS, 'libx264', 'libvpx-vp9']
const FORMATS: ExportFormat[] = ['mp4', 'gif', 'webm', 'mov', 'm4a']
/** Video input each format accepts. */
const KINDS: Record<ExportFormat, VideoInput['kind'][]> = { mp4: ['raw', 'h264'], mov: ['raw', 'h264'], webm: ['raw', 'vp9'], gif: ['raw'], m4a: ['none'] }

/** Largest frame side any encoder here accepts (the renderer keeps exports at 4096). */
export const MAX_FRAME_SIDE = 8192
/** Most click sounds one export mixes in. */
export const MAX_CLICKS = 50_000

const validColor = (c: ColorTags | undefined): boolean =>
  !!c &&
  [c.primaries, c.transfer, c.matrix ?? 0].every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
  (c.fullRange === null || typeof c.fullRange === 'boolean')

function validVideo(job: ExportJob): boolean {
  const v = job.video
  if (!v || !KINDS[job.format]?.includes(v.kind)) return false
  if (v.kind === 'raw') {
    const vp9 = v.encoder === 'libvpx-vp9'
    // GIFs take RGB frames: their palette is built from RGB.
    const formats = job.format === 'gif' ? ['rgba', 'bgra', 'rgb0', 'bgr0'] : ['rgba', 'bgra', 'rgb0', 'bgr0', 'yuv420p']
    return ENCODERS.includes(v.encoder) && vp9 === (job.format === 'webm') && formats.includes(v.pixelFormat)
  }
  return v.kind === 'none' || validColor(v.color)
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function validRecording(a: RecordingSound): boolean {
  const stems = a.stems
  return (
    isNum(a.volume, 0, 2) &&
    Array.isArray(a.clips) &&
    a.clips.every((c) => isNum(c.start, 0, 1e7) && isNum(c.end, c.start, 1e7) && isNum(c.speed, MIN_SPEED, MAX_SPEED)) &&
    (stems === undefined ||
      (typeof stems === 'object' &&
        stems !== null &&
        Object.keys(stems).length > 0 &&
        Object.entries(stems).every(([k, g]) => (STEM_KINDS as string[]).includes(k) && isNum(g, 0, 2)))) &&
    (a.noiseReduction === undefined || isNum(a.noiseReduction, 0, 1)) &&
    (a.normalize === undefined || isBool(a.normalize)) &&
    (a.voice === undefined || isVoiceStrength(a.voice)) &&
    (a.holds === undefined ||
      (Array.isArray(a.holds) && a.holds.length <= MAX_FREEZES && a.holds.every((h) => isNum(h?.at, 0, 1e7) && isNum(h.length, FREEZE.min, FREEZE.max)))) &&
    (a.cutFade === undefined || isNum(a.cutFade, 0, MAX_CUT_FADE)) &&
    (a.sounds === undefined || validSoundGains(a.sounds))
  )
}

function validMusic(m: MusicSound): boolean {
  const d = m.duck
  return (
    typeof m.file === 'string' &&
    MUSIC_FILE_RE.test(m.file) &&
    isNum(m.volume, 0, 2) &&
    isBool(m.loop) &&
    isNum(m.fadeIn, 0, AUDIO_LIMITS.musicFade.max) &&
    isNum(m.fadeOut, 0, AUDIO_LIMITS.musicFade.max) &&
    (m.duration === null || isNum(m.duration, 0, 1e7)) &&
    // A library bed is named by its catalogue id only (editing polish §10.8); main reads its loop.
    (m.bed === undefined || (typeof m.bed === 'string' && soundBed(m.bed) !== null)) &&
    (d === undefined ||
      (isNum(d.depth, 0, 1) &&
        isNum(d.attack, 0, 5) &&
        isNum(d.release, 0, 5) &&
        Array.isArray(d.ranges) &&
        d.ranges.length <= MAX_DUCK_RANGES &&
        d.ranges.every((r) => isNum(r?.start, 0, 1e7) && isNum(r.end, r.start, 1e7))))
  )
}

/** Longest chapter name accepted (the editor keeps them far shorter). */
export const MAX_CHAPTER_TITLE = 500

/** Chapters in output seconds, strictly in order, with names. */
function validChapters(list: unknown): boolean {
  if (!Array.isArray(list) || list.length > MAX_CHAPTERS) return false
  let last = -1
  for (const c of list) {
    if (!c || typeof c !== 'object' || !isNum(c.start, 0, 1e7) || !(c.start > last)) return false
    if (typeof c.title !== 'string' || c.title.length > MAX_CHAPTER_TITLE) return false
    last = c.start
  }
  return true
}

/** Longest subtitle stream name (a language's name). */
export const MAX_SUBTITLE_NAME = 64

/** Graphics' pop and ding sounds (Captions Studio §10.6): each sound once, its output seconds bounded. */
function validPops(list: unknown): boolean {
  if (!Array.isArray(list) || list.length > 2) return false
  const sounds = new Set<string>()
  for (const p of list) {
    if (!p || typeof p !== 'object' || (p.sound !== 'pop' && p.sound !== 'ding') || sounds.has(p.sound)) return false
    sounds.add(p.sound)
    if (!Array.isArray(p.times) || p.times.length > MAX_POP_TIMES || !p.times.every((t: unknown) => isNum(t, 0, 1e7))) return false
  }
  return true
}

/**
 * The library's sound effects (editing polish §10.8): at most MAX_SFX, each a catalogue effect named
 * by its id once (never a path), at most MAX_POP_TIMES output seconds in 0..1e7, a gain in 0..2.
 */
export function validEffects(list: unknown): boolean {
  if (!Array.isArray(list) || list.length > MAX_SFX) return false
  const ids = new Set<string>()
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || ids.has(e.id) || !soundEffect(e.id)) return false
    ids.add(e.id)
    if (!Array.isArray(e.times) || e.times.length > MAX_POP_TIMES || !e.times.every((t: unknown) => isNum(t, 0, 1e7))) return false
    if (!isNum(e.gain, 0, 2)) return false
  }
  return true
}

/** Bleep tones (Captions Studio §11.7): output spans, each with a start before its end, bounded. */
function validTones(list: unknown): boolean {
  if (!Array.isArray(list) || list.length > MAX_TONES) return false
  return list.every((t) => !!t && typeof t === 'object' && isNum(t.start, 0, 1e7) && isNum(t.end, 0, 1e7) && t.end > t.start)
}

/**
 * Subtitle streams (Captions Studio §11.10, §12): MP4, MOV and WebM only; at most 8, each a
 * well-formed language once, a one-line name, a WebVTT file subtitleFile could write, at most one
 * default.
 */
function validSubtitles(list: unknown, format: ExportFormat): boolean {
  if (format !== 'mp4' && format !== 'mov' && format !== 'webm') return false
  if (!Array.isArray(list) || list.length > MAX_SUBTITLE_LANGUAGES) return false
  const languages = new Set<string>()
  let defaults = 0
  for (const t of list) {
    if (!t || typeof t !== 'object' || typeof t.language !== 'string' || !SUBTITLE_LANGUAGE_RE.test(t.language) || languages.has(t.language)) return false
    languages.add(t.language)
    if (typeof t.name !== 'string' || !t.name || t.name.length > MAX_SUBTITLE_NAME || /[\u0000-\u001f\u007f]/.test(t.name)) return false
    if (typeof t.default !== 'boolean' || !validSubtitle('vtt', t.vtt)) return false
    if (t.default) defaults++
  }
  return defaults <= 1
}

/** The renderer is trusted, but ffmpeg arguments are still built only from validated values. */
export function validateJob(job: ExportJob): void {
  const audioOnly = job.format === 'm4a'
  const sizeOk = audioOnly || (isNum(job.width, 2, MAX_FRAME_SIDE) && isNum(job.height, 2, MAX_FRAME_SIDE) && job.width % 2 === 0 && job.height % 2 === 0)
  if (!sizeOk && typeof job.width === 'number' && typeof job.height === 'number') {
    throw new Error(`The export size ${job.width}×${job.height} is not supported: each side must be an even number of pixels, at most ${MAX_FRAME_SIDE}. Choose a lower resolution.`)
  }
  const ok =
    FORMATS.includes(job.format) &&
    sizeOk &&
    isNum(job.fps, 1, 120) &&
    isNum(job.frames, 1, 1e8) &&
    ['high', 'medium', 'small'].includes(job.quality) &&
    validVideo(job) &&
    (!job.audio || validRecording(job.audio)) &&
    (!job.music || (job.format !== 'gif' && validMusic(job.music))) &&
    (job.fadeIn === undefined || isNum(job.fadeIn, 0, AUDIO_LIMITS.fade.max)) &&
    (job.fadeOut === undefined || isNum(job.fadeOut, 0, AUDIO_LIMITS.fade.max)) &&
    (!job.clicks ||
      (isNum(job.clicks.volume, 0, 2) && Array.isArray(job.clicks.times) && job.clicks.times.length <= MAX_CLICKS && job.clicks.times.every((t) => isNum(t, 0, 1e7)))) &&
    (!job.bitrate || (isNum(job.bitrate.video, 0, 1e9) && isNum(job.bitrate.audio, 0, 1e6) && (audioOnly || job.bitrate.video >= 1000))) &&
    (job.maxBytes === undefined || (job.format === 'gif' && isNum(job.maxBytes, 1000, 1e12))) &&
    (job.chapters === undefined || (job.format !== 'gif' && validChapters(job.chapters))) &&
    (job.pops === undefined || (job.format !== 'gif' && validPops(job.pops))) &&
    (job.tones === undefined || (job.format !== 'gif' && validTones(job.tones))) &&
    (job.effects === undefined || (job.format !== 'gif' && validEffects(job.effects))) &&
    (job.subtitles === undefined || validSubtitles(job.subtitles, job.format))
  if (!ok) throw new Error('Invalid export settings')
  if (audioOnly && !job.audio && !job.clicks && !job.music && !job.pops?.length && !job.tones?.length && !job.effects?.length) throw new Error('This recording has no sound to export.')
}

/** The files a job's soundtrack reads, inside the project folder. */
export interface SoundInputs {
  /** The job to run: without stems when one of them is missing (the mixed track is used instead). */
  job: ExportJob
  audioInput: string | null
  stems?: Partial<Record<StemKind, string>>
  music?: string | null
  /** The music is the library bed the job names, its file checked against the catalogue: its loop (editing polish §10.4). */
  bed?: { start: number; end: number } | null
  /** The library's effects' files by id, in the bundled folder (§10.8). */
  effects?: Record<string, string>
}

/** Where the library's files are and how looping music is prepared (editing polish §10.4, §10.8). */
export interface LibraryInputs {
  /** The bundled library folder (resources/sound-library). */
  soundDir: string
  /** The file the export reads for the project's music file `file` looping over `seconds` (musicLoopCache.loopableMusic). */
  loopable?: (file: string, seconds: number) => Promise<string>
  /** Reads a project file whole (the bed check); default fs.readFile. */
  readFile?: (file: string) => Promise<Buffer>
}

export const LIBRARY_COPY = {
  missingEffect: 'A sound effect of the library is missing from this installation. Reinstall Flown to bring it back.'
}

/**
 * Whether project file `file` is exactly library bed `id` (editing polish §10.4): its size and
 * SHA-256 are the catalogue's. A bed whose file differs plays as a user's own file.
 */
export async function isLibraryBed(file: string, id: string, readFile: (file: string) => Promise<Buffer> = (f) => fs.readFile(f)): Promise<boolean> {
  const bed = soundBed(id)
  if (!bed) return false
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile() || st.size !== bed.prepared.bytes) return false
  const data = await readFile(file).catch(() => null)
  return !!data && data.length === bed.prepared.bytes && createHash('sha256').update(data).digest('hex') === bed.prepared.sha256
}

const SOURCE_NAMES: Record<StemKind, string> = { mic: 'microphone', system: 'system sound' }

/**
 * Resolves the soundtrack files of `job` in project folder `dir`. Names come from fixed
 * lists only (the music's name was validated), so nothing outside the folder is read. A
 * missing stem falls back to the screen proxy's mixed track only when that sounds the same:
 * every stem the recording kept (`recorded`) at its full volume (the stems were asked for to
 * clean the microphone). The mixed track has every source, so it would bring back a source
 * the user muted or turned down: that is refused with a message instead (the editor opens a
 * project with a missing stem without its stems, and says so). Missing music is an error the
 * user can act on.
 *
 * Editing polish (§10.4, §10.8), with `library`: a bed the music names is checked against the
 * catalogue (else the job plays the file as a user's own), the library's effects are mapped by id
 * to the bundled folder, and a user's own looping music is read through `library.loopable`.
 */
export async function resolveSoundInputs(job: ExportJob, dir: string, exists: (file: string) => Promise<boolean>, recorded: readonly StemKind[], library?: LibraryInputs): Promise<SoundInputs> {
  const audioInput = job.audio ? path.join(dir, SOURCE_FILES.mix) : null
  let out: SoundInputs = { job, audioInput }
  const wanted = job.audio?.stems ? STEM_KINDS.filter((k) => job.audio?.stems?.[k] !== undefined) : []
  if (job.audio && wanted.length > 0) {
    const files = Object.fromEntries(wanted.map((k) => [k, path.join(dir, SOURCE_FILES[k])])) as Partial<Record<StemKind, string>>
    const present = await Promise.all(wanted.map((k) => exists(files[k]!)))
    if (present.every(Boolean)) out.stems = files
    else {
      const missing = wanted.filter((_, i) => !present[i])
      const full = (g: number | undefined): boolean => g !== undefined && Math.abs(g - 1) < 1e-6
      if (![...new Set([...recorded, ...wanted])].every((k) => full(job.audio?.stems?.[k]))) {
        const names = missing.map((k) => `${SOURCE_NAMES[k]} (${SOURCE_FILES[k]})`).join(' and ')
        throw new Error(
          `The ${names} ${missing.length > 1 ? 'files of this recording are' : 'file of this recording is'} missing, so a source you muted or turned down cannot be left out. Open the recording again to use its mixed sound, with every source.`
        )
      }
      console.warn('A sound track of the recording is missing; exporting its mixed sound instead.')
      const { stems: _dropped, ...audio } = job.audio
      void _dropped
      out = { job: { ...job, audio }, audioInput }
    }
  }
  if (job.music) {
    if (!MUSIC_FILE_RE.test(job.music.file)) throw new Error('Invalid export settings')
    const music = path.join(dir, job.music.file)
    if (!(await exists(music))) throw new Error('The background music file is missing. Choose it again in the Audio panel.')
    out.music = music
    const named = out.job.music
    if (named?.bed !== undefined) {
      const bed = soundBed(named.bed)
      if (bed && (await isLibraryBed(music, named.bed, library?.readFile))) out.bed = bedLoop(bed)
      else {
        // Not the catalogue's file (changed, or replaced): it plays as a user's own file.
        const { bed: _dropped, ...own } = named
        void _dropped
        out = { ...out, job: { ...out.job, music: own } }
      }
    }
    // A user's own looping music that does not loop cleanly is read from its decoded copy (§0 decision 2).
    if (!out.bed && job.music.loop && library?.loopable) out.music = await library.loopable(job.music.file, job.frames / job.fps)
  }
  if (job.effects?.length) {
    const files: Record<string, string> = {}
    for (const e of job.effects) {
      const fx = soundEffect(e.id)
      if (!fx) throw new Error('Invalid export settings')
      const file = library ? path.join(library.soundDir, fx.prepared.file) : null
      if (!file || !(await exists(file))) throw new Error(LIBRARY_COPY.missingEffect)
      files[e.id] = file
    }
    out.effects = files
  }
  return out
}
