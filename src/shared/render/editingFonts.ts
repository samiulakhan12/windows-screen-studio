/**
 * The fonts editing polish draws with (docs/design/editing-polish.md §7.6): step badges, speech
 * bubbles and the progress bar's names end their font stacks in Captions Studio's bundled script
 * fonts and the colour emoji face, so Bangla, Devanagari, Arabic, Hebrew, Thai and emoji draw the
 * same on every PC. They must be loaded before an export's first frame: fontLoader's catalogIdsOf
 * adds these ids, so prepareCaptionFonts loads them and the missing-fonts list names them.
 */
import type { Project } from '../types'

/** The bundled script fonts and the colour emoji face, in stack order (titleCardLayer's CATALOG_FALLBACK). */
export const CALLOUT_FALLBACK_IDS: readonly string[] = ['noto-sans-bengali', 'noto-sans-devanagari', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'noto-color-emoji']

/**
 * The catalogue font ids editing polish needs for `project`: the fallback fonts when an annotation
 * is a step badge or a speech bubble, or the progress bar shows chapter names (two chapters or
 * more); none otherwise, so a project from before wave 10 loads no new font.
 */
export function editingFontIds(project: Project): string[] {
  const callouts = (project.annotations ?? []).some((a) => a.style === 'badge' || a.style === 'bubble')
  const bar = project.chapterBar
  const names = !!bar && bar.show === true && bar.labels !== 'none' && (project.chapters?.length ?? 0) >= 2
  return callouts || names ? [...CALLOUT_FALLBACK_IDS].sort() : []
}
