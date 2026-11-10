/**
 * ffmpeg arguments for the WAV format and the sound stems (docs/design/output-and-languages.md §7):
 * 32-bit float PCM at 48 kHz, RF64 beyond 4 GiB, a BWF chunk starting at 0, names main derives.
 *
 * 32-bit float, not 24-bit integer, because the soundtrack can go above 0 dBFS (music at gain 2,
 * clicks and library effects are mixed after loudnorm with normalize=0): float keeps such peaks where
 * an integer format would clip them (§7.7).
 */
import path from 'node:path'
import type { ExportJob, SoundStem } from '../shared/api/export'
import { AUDIO_RATE } from '../shared/render/audioPlan'
import { STEM_FILE_WORDS } from '../shared/render/stems'
import { exportArgs, externalizeGraph, type FfmpegPlan, type PlanPaths } from './exportArgs'

/** 32-bit float PCM at 48 kHz, switching to RF64 past 4 GiB (§7.7, §7.8). */
const FLOAT_WAV = ['-c:a', 'pcm_f32le', '-ar', String(AUDIO_RATE), '-rf64', 'auto']

/**
 * The output arguments of one stem written to `path` (§7.2): no input's tags (an imported phone
 * video's location, as the M4A export drops them), float WAV, and a BWF chunk saying it starts at
 * sample 0 (the timelines' 00:00:00:00, §8.6) and which stem it is, in English (§0 decision 10).
 */
export function stemOutputArgs(stem: SoundStem, path: string): string[] {
  return [
    '-map_metadata', '-1',
    ...FLOAT_WAV,
    '-write_bext', '1',
    '-metadata', 'time_reference=0',
    '-metadata', 'originator=Flown',
    '-metadata', `description=${STEM_FILE_WORDS[stem]}`,
    '-f', 'wav', path
  ]
}

/**
 * The WAV format: today's M4A job (§7.7), its inputs and soundtrack graph byte for byte (so it is the
 * video's sound, loudnorm included), written as 32-bit float WAV instead of AAC in an M4A. A WAV
 * holds no chapters, so none are read. A job with nothing to hear is refused as its M4A twin is.
 */
export function wavPlan(job: ExportJob, given: PlanPaths): FfmpegPlan {
  const { chapters: _chapters, bitrate: _bitrate, ...rest } = job
  void [_chapters, _bitrate]
  const m4a = exportArgs({ ...rest, format: 'm4a' }, { ...given, chapters: null, subtitles: null })
  // Everything up to the mapped soundtrack is the M4A job's; only the codec and the container change.
  const mapped = m4a.findIndex((a, i) => a === '[aout]' && m4a[i - 1] === '-map')
  const args = [...m4a.slice(0, mapped + 1), '-map_metadata:g', '-1', '-map_chapters', '-1', ...FLOAT_WAV, '-f', 'wav', given.output]
  const { args: capture, script } = externalizeGraph(args, `${given.tempStem}.graph.txt`)
  const scripts = script ? [script] : []
  return { capture, passes: [], scripts, temps: scripts.map((s) => s.path) }
}

/** `a` and `b` name the same file (Windows paths are case-insensitive). */
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * Free paths next to `output` for `stems` ("Demo - Voice.wav", " (2)" when taken), never the video's
 * own (§7.1, §18.3): existing files are never replaced, and no two stems share a path.
 */
export function stemPaths(output: string, stems: readonly SoundStem[], exists: (p: string) => boolean): Partial<Record<SoundStem, string>> {
  const dir = path.dirname(output)
  const base = path.basename(output, path.extname(output))
  const given: string[] = [output]
  const taken = (p: string): boolean => exists(p) || given.some((g) => samePath(g, p))
  const out: Partial<Record<SoundStem, string>> = {}
  for (const stem of stems) {
    const name = `${base} - ${STEM_FILE_WORDS[stem]}`
    let file = path.join(dir, `${name}.wav`)
    for (let n = 2; taken(file) && n < 10000; n++) file = path.join(dir, `${name} (${n}).wav`)
    given.push(file)
    out[stem] = file
  }
  return out
}
