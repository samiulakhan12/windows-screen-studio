/**
 * Writing the sound stems after the video (docs/design/output-and-languages.md §7.6): one ffmpeg run
 * into temporary files next to the video, each renamed into place; a cancel deletes the stems written
 * so far and never the video, and a failure is reported, never undoing the video.
 *
 * The stems' sound is resolved from the project's own files as the export resolves the video's
 * (resolveSoundInputs, then Clean voice's cleaned microphone), on a copy of the job that asks for the
 * separate microphone and system files even where the video itself mixed screen.mp4's track
 * (stemSoundJob). Temporary files are logged while they exist, so a crash leaves nothing behind once
 * stems are written again.
 */
import { app } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportJob, SoundStem } from '../shared/api/export'
import { stemsOf, type StemKind } from '../shared/audio/settings'
import { t } from '../shared/i18n/t'
import type { SoundFiles } from '../shared/render/audioPlan'
import { stemPlan, stemSoundJob } from '../shared/render/stems'
import { LeftoverLog, removeWithRetries } from './exportCleanup'
import { externalizeGraph } from './exportArgs'
import { moveIntoPlace, partialPath, resolveSoundInputs, tempStem, type LibraryInputs, type SoundInputs } from './exportJob'
import { describeFfmpegError, ffmpegPath, FfmpegFailure, startFfmpeg, type FfmpegRun } from './ffmpeg'
import { loopableMusic } from './musicLoopCache'
import * as projects from './projects'
import { bundledSoundDir } from './soundLibrary/paths'
import { stemOutputArgs, stemPaths } from './stemsArgs'
import { cleanVoiceInputs } from './voice/voiceIpc'

/** What the stem step reads, runs and writes (tests replace any of it). */
export interface StemDeps {
  projectDir(id: string): string
  /** The stems the recording kept (project.json): a missing one may fall back to the mixed track only when that sounds the same. */
  recorded(id: string): Promise<StemKind[]>
  /** The library's files, and a user's own looping music decoded once (editing polish §10.4, §10.8). */
  library(dir: string, signal: AbortSignal): LibraryInputs
  /** Clean voice's cleaned microphone in place of the one it was made from (clean-voice.md §4.6). */
  cleanVoice(sound: SoundInputs, projectId: string, requested: ExportJob): Promise<SoundInputs>
  run(args: string[]): FfmpegRun
  /** The folder for the filter-graph script of a long graph. */
  tempDir(): string
  exists(file: string): boolean
  fileExists(file: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  bytes(file: string): Promise<number>
  remove(file: string): Promise<boolean>
  /** Temporary files logged while they exist, deleted at a later stem step if a crash left them. */
  leftovers: { add(files: string[]): void; remove(files: string[]): void }
}

/** Longest a looping music file may take to decode (as the export's own wait). */
const MUSIC_DECODE_TIMEOUT_MS = 5 * 60 * 1000

/** The stem step's own clean-up log, swept once on first use (a crash during an earlier stem step). */
let stemLog: LeftoverLog | null = null
function leftoverLog(): LeftoverLog {
  if (!stemLog) {
    stemLog = new LeftoverLog(path.join(app.getPath('userData'), 'stem-leftovers.json'))
    void stemLog.sweep().catch(() => undefined)
  }
  return stemLog
}

const defaultDeps = (): StemDeps => ({
  projectDir: projects.projectDir,
  recorded: (id) => projects.readProject(id).then(stemsOf, () => []),
  library: (dir, signal) => ({
    // Asked for only when the job has library effects.
    get soundDir() {
      return bundledSoundDir()
    },
    loopable: (file, seconds) => loopableMusic(dir, file, ffmpegPath(), { seconds, signal, timeoutMs: MUSIC_DECODE_TIMEOUT_MS })
  }),
  cleanVoice: (sound, projectId, requested) => cleanVoiceInputs(sound, projectId, requested),
  run: startFfmpeg,
  tempDir: () => app.getPath('temp'),
  exists: existsSync,
  fileExists: (file) => fs.access(file).then(() => true, () => false),
  rename: (from, to) => moveIntoPlace(from, to),
  bytes: async (file) => (await fs.stat(file)).size,
  remove: (file) => removeWithRetries(file),
  leftovers: { add: (files) => leftoverLog().add(files), remove: (files) => leftoverLog().remove(files) }
})

/** `file`, or "name (2).wav", "(3)", ... when `taken`: a stem never replaces a file. */
function freePath(file: string, taken: (p: string) => boolean): string {
  const ext = path.extname(file)
  const stem = file.slice(0, file.length - ext.length)
  let out = file
  for (let n = 2; taken(out) && n < 10000; n++) out = `${stem} (${n})${ext}`
  return out
}

const HEAD = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin']

/**
 * Renders the stems `only` of `job` from project `projectId`'s files, to the paths `place` gives for
 * the stems that have sound: one ffmpeg run into temporary names next to each target, then each
 * renamed into place. A cancel (or a failure) deletes every stem file of this run, temporary or
 * renamed; nothing else is ever deleted. Rejects with the signal's reason when cancelled.
 */
async function renderInto(
  job: ExportJob,
  only: readonly SoundStem[],
  place: (stems: SoundStem[]) => Partial<Record<SoundStem, string>>,
  signal: AbortSignal,
  projectId: string,
  deps: StemDeps
): Promise<{ stem: SoundStem; path: string; bytes: number }[]> {
  signal.throwIfAborted()
  const dir = deps.projectDir(projectId)
  const asked = stemSoundJob(job, only)
  const resolved = await deps.cleanVoice(await resolveSoundInputs(asked, dir, deps.fileExists, await deps.recorded(projectId), deps.library(dir, signal)), projectId, asked)
  signal.throwIfAborted()
  const files: SoundFiles = {
    mix: resolved.audioInput,
    ...(resolved.stems ? { stems: resolved.stems } : {}),
    ...(resolved.music ? { music: resolved.music } : {}),
    ...(resolved.bed ? { bed: resolved.bed } : {}),
    ...(resolved.effects ? { effects: resolved.effects } : {})
  }
  const plan = stemPlan(resolved.job, files, 0)
  if (plan.outputs.length === 0) return []
  const targets = place(plan.outputs.map((o) => o.stem))
  const outputs = plan.outputs.map((o) => ({ ...o, target: targets[o.stem]!, temp: partialPath(targets[o.stem]!) }))
  const args = [...HEAD, ...plan.args, '-filter_complex', plan.graph, ...outputs.flatMap((o) => ['-map', `[${o.label}]`, ...stemOutputArgs(o.stem, o.temp)])]
  const { args: command, script } = externalizeGraph(args, `${tempStem(deps.tempDir())}.graph.txt`)
  const temps = [...outputs.map((o) => o.temp), ...(script ? [script.path] : [])]
  deps.leftovers.add(temps)
  const placed: { stem: SoundStem; path: string; bytes: number }[] = []
  try {
    if (script) await fs.writeFile(script.path, script.content, 'utf8')
    signal.throwIfAborted()
    const run = deps.run(command)
    const stop = (): void => run.kill()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await run.done
    } finally {
      signal.removeEventListener('abort', stop)
    }
    for (const o of outputs) {
      signal.throwIfAborted()
      await deps.rename(o.temp, o.target)
      placed.push({ stem: o.stem, path: o.target, bytes: 0 })
    }
    for (const p of placed) p.bytes = await deps.bytes(p.path)
    signal.throwIfAborted()
    return placed
  } catch (err) {
    // Every stem file of this run goes, the ones already in place too; the video is never touched.
    await Promise.all([...outputs.map((o) => deps.remove(o.temp)), ...placed.map((p) => deps.remove(p.path))])
    if (signal.aborted) throw signal.reason
    throw err
  } finally {
    if (script) await deps.remove(script.path)
    deps.leftovers.remove(temps)
  }
}

/** Why the stems could not be written, for the done view's "The sound stems could not be saved: {reason}". */
function problemOf(err: unknown): string {
  if (err instanceof FfmpegFailure) return describeFfmpegError(err.detail, t('errors.stems.failed'))
  return err instanceof Error && err.message ? err.message : t('errors.stems.failed')
}

/**
 * The stem step of `export:finish`, after the video `output` is in place. `projectId` names the
 * project whose recordings the stems are cut from (export:start's). The stems go next to the video
 * under names main derives ("Demo - Voice.wav", " (2)" when taken). A failure is reported as
 * `stemsProblem`; a cancel deletes the stems written so far and reports nothing. Never touches the
 * video.
 */
export async function writeStemsStep(
  job: ExportJob,
  output: string,
  signal: AbortSignal,
  projectId: string,
  deps: Partial<StemDeps> = {}
): Promise<{ stems?: { stem: SoundStem; path: string; bytes: number }[]; stemsProblem?: string }> {
  if (!job.stems || job.stems.stems.length === 0) return {}
  const d = { ...defaultDeps(), ...deps }
  try {
    const stems = await renderInto(job, job.stems.stems, (wanted) => stemPaths(output, wanted, d.exists), signal, projectId, d)
    return stems.length > 0 ? { stems } : { stemsProblem: t('errors.stems.noSound') }
  } catch (err) {
    if (signal.aborted) return {}
    return { stemsProblem: problemOf(err) }
  }
}

/**
 * Renders `only` of the job's stems of project `projectId` into `folder` under `names` (file names in
 * that folder, "Music.wav"; P4's timeline media, Music and Effects when stems are off). Stems without
 * sound are not written, and a taken name gets " (2)". Resolves with the paths written; rejects on a
 * failure or a cancel, having deleted what it wrote.
 */
export async function renderStems(
  job: ExportJob,
  folder: string,
  only: readonly SoundStem[],
  names: Partial<Record<SoundStem, string>>,
  signal: AbortSignal,
  projectId: string,
  deps: Partial<StemDeps> = {}
): Promise<Partial<Record<SoundStem, string>>> {
  const d = { ...defaultDeps(), ...deps }
  // Only a plain name inside `folder`: a path in a name is never followed.
  const named = only.filter((s) => typeof names[s] === 'string' && path.basename(names[s]!) !== '')
  const place = (wanted: SoundStem[]): Partial<Record<SoundStem, string>> => {
    const given: string[] = []
    const out: Partial<Record<SoundStem, string>> = {}
    for (const s of wanted) {
      const file = freePath(path.join(folder, path.basename(names[s]!)), (p) => d.exists(p) || given.includes(p))
      given.push(file)
      out[s] = file
    }
    return out
  }
  const written = await renderInto(job, named, place, signal, projectId, d)
  return Object.fromEntries(written.map((w) => [w.stem, w.path]))
}
