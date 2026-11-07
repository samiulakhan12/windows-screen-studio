/**
 * Edits of the music library and the sound-effect rules (docs/design/editing-polish.md §2.6, §16):
 * each is one project update, so one undo step. Pure.
 */
import type { Project, SfxRef, SoundFx } from '../types'
import { audioLook, DEFAULT_MUSIC } from './settings'
import { readSfxRef } from './soundFxData'
import { bedSeconds, soundBed, type MusicBed } from './soundLibrary'
import type { SfxRule } from '../render/sfxJob'

/** The project with `next` as its effects (none left: the field removed, as a project from before). */
function withFx(project: Project, next: SoundFx): Project {
  if (Object.keys(next).length > 0) return { ...project, soundFx: next }
  if (!project.soundFx) return project
  const { soundFx: _gone, ...rest } = project
  void _gone
  return rest
}

/** Rule `rule` set to effect `ref`, or cleared (null: None). */
export function withSoundRule(project: Project, rule: SfxRule, ref: SfxRef | null): Project {
  const next: SoundFx = { ...project.soundFx }
  const read = ref ? readSfxRef(ref) : undefined
  if (read) next[rule] = read
  else delete next[rule]
  if (project.soundFx?.[rule] === next[rule]) return project
  return withFx(project, next)
}

/** The effects' volume, 0..1 (0.35 is the default and is stored only once set). */
export function withSfxVolume(project: Project, volume: number): Project {
  const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.35))
  if (project.soundFx?.volume === v) return project
  return withFx(project, { ...project.soundFx, volume: v })
}

/**
 * Bed `id` as the music, its copy in the project being `file` (music-<n>.ogg): volume, ducking,
 * loop and fades keep the values the music had (today's defaults when there was none).
 */
export function withLibraryBed(project: Project, id: string, file: string): Project {
  if (!soundBed(id)) return project
  const before = audioLook(project.audio).music
  const keep = before ? { volume: before.volume, ducking: before.ducking, loop: before.loop, fadeIn: before.fadeIn, fadeOut: before.fadeOut } : DEFAULT_MUSIC
  return { ...project, audio: { ...project.audio, music: { ...keep, path: file, library: { id } } } }
}

/** A user's own music file `path`, keeping the music's settings and leaving any library bed behind. */
export function withOwnMusic(project: Project, path: string): Project {
  const before = audioLook(project.audio).music
  const keep = before ? { volume: before.volume, ducking: before.ducking, loop: before.loop, fadeIn: before.fadeIn, fadeOut: before.fadeOut } : DEFAULT_MUSIC
  return { ...project, audio: { ...project.audio, music: { ...keep, path } } }
}

/** The library bed the music is, or null. */
export function libraryBedOf(project: Project): MusicBed | null {
  const id = audioLook(project.audio).music?.library?.id
  return id ? soundBed(id) : null
}

/** A bed's length as the list shows it ("1:43") and as a screen reader says it ("1 minute 43 seconds"). */
export function bedLength(bed: MusicBed): { text: string; spoken: string } {
  const total = Math.round(bedSeconds(bed))
  const m = Math.floor(total / 60)
  const s = total % 60
  const words = [m ? `${m} minute${m === 1 ? '' : 's'}` : '', s || !m ? `${s} second${s === 1 ? '' : 's'}` : ''].filter(Boolean)
  return { text: `${m}:${String(s).padStart(2, '0')}`, spoken: words.join(' ') }
}

/** Megabytes as the download button says them ("1.0 MB", spoken "1.0 megabytes"). */
export function megabytes(bytes: number): { text: string; spoken: string } {
  const mb = (bytes / 1e6).toFixed(1)
  return { text: `${mb} MB`, spoken: `${mb} megabytes` }
}
