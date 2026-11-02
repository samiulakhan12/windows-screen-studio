/**
 * Cues of a caption track (docs/design/captions-studio.md §11.10): each spoken cue's output times
 * with the track's text. Pure.
 *
 * The spoken track is today's cues (outputCues) with the bleep masks. A translated track keeps each
 * spoken caption's output times: a caption whose words are all cut is left out, a partly cut one
 * keeps its whole translation, and a caption without a translation keeps its spoken text. Pause
 * holds map as in subtitleFile.
 */
import { MIN_CUE } from '../editor/transcript'
import { editToVideo, planOf } from '../engine/freeze'
import type { Project } from '../types'
import { trackOf } from './captionTracks'
import { maskedSegments } from './cleanup'
import { outputCues, toVtt, type Cue } from './subtitles'

/** The cues of the track in `language` (the spoken one when the project has no such track), in the exported video's time. */
export function trackCues(project: Project, language: string): Cue[] {
  const segments = maskedSegments(project.transcript?.segments ?? [], project.bleeps)
  const track = trackOf(project, language)
  let cues: Cue[]
  if (!track || (project.transcript?.language && project.transcript.language.toLowerCase() === language.toLowerCase())) cues = outputCues(segments, project.clips)
  else {
    const text = new Map(track.segments.map((s) => [s.id, s.text]))
    cues = []
    for (const seg of segments) {
      // The spoken cue's times (none when every word is cut), with the translation's text.
      const [cue] = outputCues([seg], project.clips)
      if (!cue) continue
      const translated = text.get(seg.id)
      cues.push(translated === undefined ? cue : { ...cue, text: translated })
    }
    for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end) cues[i - 1] = { ...cues[i - 1], end: cues[i].start }
    cues = cues.filter((c) => c.end - c.start >= MIN_CUE - 1e-9)
  }
  const plan = planOf(project)
  return plan.holds.length ? cues.map((c) => ({ ...c, start: editToVideo(plan, c.start), end: editToVideo(plan, c.end) })) : cues
}

/**
 * A WebVTT file of the track, for a subtitle stream (§11.10). `names`: each cue starts "Name: "
 * (mov_text drops WebVTT voice tags); without it no speaker is named.
 */
export function trackVtt(project: Project, language: string, names: boolean): string {
  const cues = trackCues(project, language).map(({ speaker, ...c }) => (names && speaker ? { ...c, text: `${speaker}: ${c.text}` } : c))
  return toVtt(cues)
}
