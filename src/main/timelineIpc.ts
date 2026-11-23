/**
 * Timelines for other editors (docs/design/output-and-languages.md §8.7, §18.3): main checks the
 * request (the session's exported video, stems next to it, checkTimelinePlan), probes the media and
 * refuses a plan whose rates, sizes or lengths disagree with the files, copies the recordings when
 * asked, runs the writers and writes each file under a name main derives, never replacing a file.
 *
 * - The recordings mode copies media out of the project folder and never opens a project file for
 *   writing (projectCopy.ts's rule): ffmpeg only reads them and writes new files into a new folder.
 * - Every file is written to a temporary name and renamed onto a name it first claimed; a taken name
 *   gets " (2)" as export:batchPath does.
 */
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportJob, SoundStem, TimelineEditor, TimelineRequest, TimelineResult } from '../shared/api/export'
import { fmt } from '../shared/i18n/fmt'
import { t } from '../shared/i18n/t'
import { parseProbe, type ProbeInfo } from '../shared/import/probe'
import { edl, markerEdl } from '../shared/interchange/edl'
import { fcpxml } from '../shared/interchange/fcpxml'
import { checkTimelinePlan } from '../shared/interchange/planCheck'
import type { TimelineMedia, TimelinePlan, TimelineSource } from '../shared/interchange/timelinePlan'
import { xmeml } from '../shared/interchange/xmeml'
import { STEM_FILE_WORDS } from '../shared/render/stems'
import type { Project, VoiceStrength } from '../shared/types'
import { hidesSomething } from '../shared/privacy/coverData'
import { removeWithRetries } from './exportCleanup'
import { exportJobOf } from './exportedJobs'
import { isExportedFile, onExportCancel } from './exportIpc'
import { freeBatchPath, moveIntoPlace, partialPath } from './exportJob'
import { ffmpegPath, startFfmpeg } from './ffmpeg'
import { projectDir } from './projects'
import { migrateProject } from '../shared/engine/project'
import { isAppUrl } from './security'
import { renderStems } from './stemsRun'
import { voiceCleaner } from './voice/voiceIpc'

/** What the writer reads and runs (tests replace any of it). */
export interface TimelineDeps {
  exists?: (file: string) => boolean
  /** Whether `file` was exported in this session. */
  isExported?: (file: string) => boolean
  /** The job `file` was exported with (Music and Effects, Clean voice). */
  jobOf?: (file: string) => ExportJob | undefined
  /** What ffmpeg says about a file. */
  probe?: (file: string) => Promise<ProbeInfo>
  /** Runs ffmpeg to the end; rejects when it fails or `signal` stops it. */
  ffmpeg?: (args: string[], signal?: AbortSignal) => Promise<void>
  projectDir?: (id: string) => string
  /** Free bytes in `dir`, or null when they cannot be read. */
  freeBytes?: (dir: string) => Promise<number | null>
  /** Clean voice's cleaned file (absolute path) of the microphone or the mixed track. */
  cleanVoice?: (projectId: string, source: 'mic' | 'mix', strength: VoiceStrength) => Promise<string>
  renderStems?: typeof renderStems
  /** The project as saved (auto-blur §9 row 10: main reads what the user sees, whatever the request says). */
  readProject?: (id: string) => Promise<Project>
}

/** The files of "The original recordings" in the media folder (§2.3), English on every PC (§0 decision 10). */
export const RECORDING_FILES: Readonly<Record<Exclude<TimelineMedia, 'video'>, string>> = {
  screen: 'Screen.mp4',
  camera: 'Camera.mp4',
  voice: `${STEM_FILE_WORDS.voice}.wav`,
  system: `${STEM_FILE_WORDS.system}.wav`,
  recording: `${STEM_FILE_WORDS.recording}.wav`,
  music: `${STEM_FILE_WORDS.music}.wav`,
  effects: `${STEM_FILE_WORDS.effects}.wav`
}

/** The project's own file each recorded source is read from. */
const PROJECT_FILES: Readonly<Partial<Record<TimelineMedia, string>>> = {
  screen: 'screen.mp4',
  camera: 'webcam.mp4',
  voice: 'mic.m4a',
  system: 'system.m4a',
  recording: 'screen.mp4'
}

const EDITORS: readonly TimelineEditor[] = ['resolve', 'premiere', 'finalcut', 'edl']
const STEMS: readonly SoundStem[] = ['voice', 'system', 'recording', 'music', 'effects']
const ID_RE = /^[a-zA-Z0-9_-]+$/
/** Free space a copy needs, as a multiple of what it writes (§8.1). */
const SPACE_MARGIN = 1.2
/** Bytes a second of 24-bit stereo WAV at 48 kHz takes, and of the 32-bit float stems. */
const WAV_RATE = 48000 * 3 * 2
const STEM_RATE = 48000 * 4 * 2
/** Longest wait for ffmpeg to describe a file, and the most of its log read. */
const PROBE_TIMEOUT_MS = 20_000
const PROBE_LOG_MAX = 256 * 1024

/** What ffmpeg prints about `file` (the bundled ffmpeg has no ffprobe). */
function probeMedia(file: string): Promise<ProbeInfo> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    proc.stderr.on('data', (d: Buffer) => {
      if (log.length < PROBE_LOG_MAX) log += d.toString()
    })
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(parseProbe(log))
    }
    proc.on('error', done)
    proc.on('close', done)
  })
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const run = startFfmpeg(args)
  const stop = (): void => run.kill()
  signal?.addEventListener('abort', stop, { once: true })
  return run.done.finally(() => signal?.removeEventListener('abort', stop))
}

const defaults = (): Required<TimelineDeps> => ({
  exists: existsSync,
  isExported: isExportedFile,
  jobOf: exportJobOf,
  probe: probeMedia,
  ffmpeg: runFfmpeg,
  projectDir,
  freeBytes: (dir) => fs.statfs(dir).then((s) => Number(s.bavail) * Number(s.bsize), () => null),
  cleanVoice: async (projectId, source, strength) => path.join(projectDir(projectId), await voiceCleaner.ensure(projectId, source, strength)),
  renderStems,
  readProject: async (id) => migrateProject(JSON.parse(await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8')))
})

/**
 * The timeline files next to `video` for `editors` (§2.3): `<base>.fcpxml` (DaVinci Resolve and Final
 * Cut Pro share it), `<base>.xml`, `<base>.edl`, and `<base> - Resolve markers.edl` when Resolve is
 * chosen and the video has chapters. A taken name gets " (2)"; the video's own path is never given.
 */
export function timelinePaths(video: string, editors: readonly TimelineEditor[], withMarkers: boolean, exists: (p: string) => boolean): { path: string; for: TimelineEditor | 'resolve-markers' }[] {
  const dir = path.dirname(video)
  const base = path.basename(video, path.extname(video))
  const given = new Set<string>([video])
  const free = (name: string): string => {
    const file = freeBatchPath(dir, name, (f) => exists(f) || given.has(f))
    given.add(file)
    return file
  }
  const out: { path: string; for: TimelineEditor | 'resolve-markers' }[] = []
  if (editors.includes('resolve') || editors.includes('finalcut')) {
    const file = free(`${base}.fcpxml`)
    for (const e of ['resolve', 'finalcut'] as const) if (editors.includes(e)) out.push({ path: file, for: e })
  }
  if (editors.includes('premiere')) out.push({ path: free(`${base}.xml`), for: 'premiere' })
  if (editors.includes('edl')) out.push({ path: free(`${base}.edl`), for: 'edl' })
  if (withMarkers && editors.includes('resolve')) out.push({ path: free(`${base} - Resolve markers.edl`), for: 'resolve-markers' })
  return out
}

/** `<name>` in `dir`, or `<name> (2)`, `<name> (3)` … when taken (a folder name: nothing in it is an extension). */
function freeFolder(dir: string, name: string, exists: (p: string) => boolean): string {
  let file = path.join(dir, name)
  for (let n = 2; exists(file) && n < 10000; n++) file = path.join(dir, `${name} (${n})`)
  return file
}

/** Bytes of `file`, 0 when it cannot be read. */
const sizeOf = (file: string): Promise<number> => fs.stat(file).then((s) => s.size, () => 0)

/**
 * Copies the recordings of `projectId` into `folder`, a folder that does not exist yet, for "The
 * original recordings" (§8.1): `screen.mp4` and `webcam.mp4` remuxed without their sound
 * (`-map 0:v -c:v copy -an`), the microphone, the system sound or the screen's own track converted to
 * 24-bit WAV at 48 kHz (with `voice`, Clean voice's cleaned file in place of what it was made from),
 * and Music and Effects rendered with the export's job (`options.job`) when no stems were written.
 * Files are copied, never linked, and the project's files are only read. Free space for everything
 * plus 20% is checked before anything is made. `options.media` names what to make (by default every
 * recording the project has). Resolves with the paths made; on a failure removes the folder.
 */
export async function copyRecordings(
  projectId: string,
  folder: string,
  voice: VoiceStrength | null,
  deps?: TimelineDeps,
  options: { media?: readonly TimelineMedia[]; job?: ExportJob; signal?: AbortSignal } = {}
): Promise<Partial<Record<TimelineMedia, string>>> {
  const d = { ...defaults(), ...deps }
  const src = d.projectDir(projectId)
  const from = (m: TimelineMedia): string => path.join(src, PROJECT_FILES[m]!)
  const has = (m: TimelineMedia): boolean => !!PROJECT_FILES[m] && d.exists(from(m))
  const want: readonly TimelineMedia[] =
    options.media ?? (['screen', 'camera', ...(has('voice') || has('system') ? (['voice', 'system'] as const) : (['recording'] as const))] as TimelineMedia[]).filter(has)
  for (const m of want) if (m === 'video' || (m !== 'music' && m !== 'effects' && !has(m))) throw new Error(t('errors.timeline.media'))
  const rendered = want.filter((m): m is 'music' | 'effects' => m === 'music' || m === 'effects')
  if (rendered.length && !options.job) throw new Error(t('errors.timeline.media'))

  // Free space first: the copies, the WAV files at the recording's length, the rendered sounds.
  const seconds = (await d.probe(from('screen'))).duration ?? 0
  let need = 0
  for (const m of want) {
    if (m === 'screen' || m === 'camera') need += await sizeOf(from(m))
    else if (m === 'music' || m === 'effects') need += (options.job!.frames / options.job!.fps) * STEM_RATE
    else need += seconds * WAV_RATE
  }
  const free = await d.freeBytes(path.dirname(folder))
  if (free !== null && free < need * SPACE_MARGIN) throw new Error(t('errors.disk.space', { size: fmt.bytes(need), free: fmt.bytes(free) }))

  // A new folder of its own: nothing in it belongs to anyone else, and `-n` never overwrites.
  await fs.mkdir(folder)
  const out: Partial<Record<TimelineMedia, string>> = {}
  try {
    const recordedMic = want.includes('voice')
    for (const m of want) {
      if (m === 'music' || m === 'effects') continue
      const file = path.join(folder, RECORDING_FILES[m as Exclude<TimelineMedia, 'video'>])
      if (m === 'screen' || m === 'camera') {
        await d.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-n', '-i', from(m), '-map', '0:v', '-c:v', 'copy', '-an', '-sn', '-dn', '-movflags', '+faststart', file], options.signal)
      } else {
        // Clean voice works on the microphone when the recording kept it, else on the mixed track (as the export does).
        const cleaned = voice && ((m === 'voice' && recordedMic) || (m === 'recording' && !recordedMic)) ? await d.cleanVoice(projectId, m === 'voice' ? 'mic' : 'mix', voice) : null
        await d.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-n', '-i', cleaned ?? from(m), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s24le', '-ar', '48000', file], options.signal)
      }
      out[m] = file
    }
    if (rendered.length) {
      const names = Object.fromEntries(rendered.map((m) => [m, RECORDING_FILES[m]]))
      const made = await d.renderStems(options.job!, folder, rendered, names, options.signal ?? new AbortController().signal, projectId)
      for (const m of rendered) if (made[m]) out[m] = made[m]
    }
    return out
  } catch (err) {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** Whether `request` cannot be acted on: its shape, a video this session did not export, a stem not next to it. */
function badRequest(request: TimelineRequest, d: Required<TimelineDeps>): boolean {
  if (!request || typeof request !== 'object') return true
  const { projectId, videoPath, editors, media, stems } = request
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) return true
  if (typeof videoPath !== 'string' || !path.isAbsolute(videoPath) || !d.isExported(videoPath)) return true
  if (!Array.isArray(editors) || editors.length === 0 || new Set(editors).size !== editors.length || !editors.every((e) => EDITORS.includes(e))) return true
  if (media !== 'export' && media !== 'recordings') return true
  // An EDL holds the finished video only (§8.5).
  if (media === 'recordings' && editors.includes('edl')) return true
  if (!Array.isArray(stems) || stems.length > STEMS.length) return true
  const dir = path.dirname(videoPath)
  const seen = new Set<SoundStem>()
  for (const s of stems) {
    if (!s || typeof s !== 'object' || !STEMS.includes(s.stem) || seen.has(s.stem)) return true
    seen.add(s.stem)
    // Each stem a WAV file next to the video, other than the video, and there.
    if (typeof s.path !== 'string' || !path.isAbsolute(s.path) || path.dirname(s.path) !== dir || s.path === videoPath || path.extname(s.path).toLowerCase() !== '.wav' || !d.exists(s.path)) return true
  }
  return false
}

/** Whether the plan describes `source` as the probed file is: rate and size exactly, the length within a little. */
function agrees(source: TimelineSource, probe: ProbeInfo, reached: number): boolean {
  if (!probe.opened) return false
  const picture = probe.streams.find((s) => s.type === 'video' && !s.attachedPic)
  const sound = probe.streams.find((s) => s.type === 'audio')
  if (source.video) {
    if (!picture) return false
    if (picture.fps !== null && Math.abs(picture.fps - source.fps) > 0.01 * source.fps) return false
    if (source.width !== undefined && picture.width !== null && picture.width !== source.width) return false
    if (source.height !== undefined && picture.height !== null && picture.height !== source.height) return false
  } else if (!sound) return false
  if (probe.duration !== null) {
    const slack = Math.max(0.1, 2 / source.fps)
    // No event reads past the file's end, and a picture's length is the plan's.
    if (reached / source.fps > probe.duration + slack) return false
    if (source.video && Math.abs(source.frames / source.fps - probe.duration) > Math.max(0.5, slack)) return false
  }
  return true
}

/** The last source frame the plan's events read of each media. */
function reach(plan: TimelinePlan): Map<TimelineMedia, number> {
  const out = new Map<TimelineMedia, number>()
  for (const track of plan.tracks) for (const e of track.events) out.set(e.media, Math.max(out.get(e.media) ?? 0, e.srcOut))
  return out
}

/** Writes `text` to `file` through a temporary file, onto a name it first claims, so no file is ever replaced. */
async function writeNew(file: string, text: string): Promise<void> {
  const temp = partialPath(file)
  let claimed = false
  try {
    await fs.writeFile(temp, text, 'utf8')
    await (await fs.open(file, 'wx')).close()
    claimed = true
    await moveIntoPlace(temp, file)
  } catch (err) {
    await removeWithRetries(temp)
    if (claimed) await removeWithRetries(file)
    throw err
  }
}

const failed = (problem: string): TimelineResult => ({ files: [], problem })

/**
 * Writes the timeline files of `request` (§8.7). Refuses, writing nothing, a video this session did
 * not export, a stem not next to it, a plan checkTimelinePlan refuses or one that does not fit its
 * mode, and a plan whose rates, sizes or lengths disagree with the files. In recordings mode it first
 * copies the recordings into `<base> media` (stems written with the export stand in for Music and
 * Effects). Every file written and the media folder are listed, each with what it is for. `signal`
 * stops the copies (Cancel export, §2.4): the media folder goes and no timeline file is written.
 */
export async function writeTimeline(request: TimelineRequest, deps?: TimelineDeps, signal?: AbortSignal): Promise<TimelineResult> {
  const d = { ...defaults(), ...deps }
  if (badRequest(request, d) || checkTimelinePlan(request.plan) !== null) return failed(t('errors.timeline.invalid'))
  const plan: TimelinePlan = structuredClone(request.plan)
  const { videoPath, projectId, editors } = request
  const exportMode = request.media === 'export'
  const stems = new Map(request.stems.map((s) => [s.stem, s.path]))
  const media = Object.keys(plan.media) as TimelineMedia[]
  // In recordings mode the stems stand in for Music and Effects only; the voice is the recording's own.
  const fromStem = (m: TimelineMedia): boolean => stems.has(m as SoundStem) && (exportMode || m === 'music' || m === 'effects')
  // The plan's media fit its mode: the video and the stems written with it, or the recordings.
  const fits = exportMode ? media.includes('video') && media.every((m) => m === 'video' || fromStem(m)) : media.includes('screen') && !media.includes('video')
  if (!fits) return failed(t('errors.timeline.invalid'))
  // The original recordings are never copied while the video hides part of them (auto-blur §9 row 10,
  // §0 decision 4): a cover, a blur or pixelate shape or a bleep, read from project.json itself.
  if (!exportMode) {
    let saved: Project
    try {
      // The project.json beside the recordings it would copy (in the folder projectDir gives).
      saved = deps?.readProject ? await deps.readProject(projectId) : migrateProject(JSON.parse(await fs.readFile(path.join(d.projectDir(projectId), 'project.json'), 'utf8')))
    } catch {
      return failed(t('errors.timeline.media'))
    }
    if (hidesSomething(saved)) return failed(t('errors.timeline.hidden'))
  }

  // Each media's file now, probed against what the plan says of it.
  const sources = new Map<TimelineMedia, string>()
  for (const m of media) {
    if (m === 'video') sources.set(m, videoPath)
    else if (fromStem(m)) sources.set(m, stems.get(m as SoundStem)!)
    else if (!exportMode && PROJECT_FILES[m]) sources.set(m, path.join(d.projectDir(projectId), PROJECT_FILES[m]!))
  }
  const reached = reach(plan)
  for (const [m, file] of sources) {
    if (!d.exists(file)) return failed(t('errors.timeline.media'))
    const probe = await d.probe(file)
    if (!agrees(plan.media[m]!, probe, reached.get(m) ?? 0)) return failed(t('errors.timeline.media'))
    // The finished video's own sound, as the file has it.
    if (m === 'video') plan.media.video = { ...plan.media.video!, audio: probe.streams.some((s) => s.type === 'audio') }
  }

  const files: TimelineResult['files'] = []
  const paths: Partial<Record<TimelineMedia, string>> = {}
  try {
    if (exportMode) {
      for (const [m, file] of sources) paths[m] = file
    } else {
      const folder = freeFolder(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))} media`, d.exists)
      const job = d.jobOf(videoPath)
      const made = await copyRecordings(projectId, folder, job?.audio?.voice ?? null, d, { media: media.filter((m) => !fromStem(m)), job, signal })
      Object.assign(paths, made)
      for (const m of media) if (fromStem(m)) paths[m] = stems.get(m as SoundStem)
      files.push({ path: folder, for: 'media' })
      // Music or Effects that turned out silent are not written (as stems without sound): their tracks go.
      for (const m of ['music', 'effects'] as const) {
        if (paths[m] || !plan.media[m]) continue
        delete plan.media[m]
        plan.tracks = plan.tracks.filter((track) => !track.events.some((e) => e.media === m))
      }
      if ((Object.keys(plan.media) as TimelineMedia[]).some((m) => !paths[m])) return { files, problem: t('errors.timeline.media') }
      // The copies have no sound of their own and the WAV files no picture (§8.1).
      for (const m of Object.keys(plan.media) as TimelineMedia[]) plan.media[m] = { ...plan.media[m]!, audio: m !== 'screen' && m !== 'camera', video: m === 'screen' || m === 'camera' }
    }

    const marks = markerEdl(plan)
    const written = new Set<string>()
    for (const target of timelinePaths(videoPath, editors, marks !== null, d.exists)) {
      if (!written.has(target.path)) {
        const text =
          target.for === 'premiere' ? xmeml(plan, paths) : target.for === 'edl' ? edl(plan, paths) : target.for === 'resolve-markers' ? marks! : fcpxml(plan, paths, projectId)
        await writeNew(target.path, text)
        written.add(target.path)
      }
      files.push(target)
    }
    return { files }
  } catch (err) {
    if (signal?.aborted) return { files, problem: t('errors.timeline.cancelled') }
    return { files, problem: err instanceof Error && err.message ? err.message.split('\n')[0] : t('errors.timeline.invalid') }
  }
}

/** `export:writeTimeline`, for the app's own page only; export:cancel stops the timelines being written. */
export function registerTimelineIpc(): void {
  const writing = new Set<AbortController>()
  onExportCancel(() => {
    for (const stop of writing) stop.abort()
  })
  ipcMain.handle('export:writeTimeline', async (e, request: TimelineRequest) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    const stop = new AbortController()
    writing.add(stop)
    try {
      return await writeTimeline(request, undefined, stop.signal)
    } finally {
      writing.delete(stop)
    }
  })
}
