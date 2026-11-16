/**
 * The words of Versions in the UI language (docs/design/output-and-languages.md §9.1, §9.7): the
 * summary line, the comparison, the parts of the edit that differ and the notices about a version's
 * files. shared/editor/versions.ts, which main imports too, keeps the English forms and the data
 * (summaryCounts, summaryDiffs, the area names and namedFiles' kinds) these words are made from; the
 * names Flown gives versions are written into the version files and stay as they were written.
 */
import { summaryCounts, summaryDiffs, type CountKey, type SummaryChange, type VersionSummary } from './versions'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'

/** A count as the summary line says it: "1 cut", "3 cuts". */
const countWord = (key: CountKey, n: number): string => t(`review.versions.count.${key}`, { count: n, n: fmt.count(n) })

/** "2:13 · 3 cuts · 5 zooms · 42 captions": the length (whole seconds), then the counts that are not zero, five parts at most. */
export function summaryLine(s: VersionSummary): string {
  return [fmt.clock(s.duration, 'whole'), ...summaryCounts(s).map((c) => countWord(c.key, c.n))].join(' · ')
}

/** The counts that differ between a version and the edit now (the length first), as the comparison's rows. */
export function compareSummaries(version: VersionSummary, now: VersionSummary): SummaryChange[] {
  const yes = (b: boolean): string => t(b ? 'review.versions.yes' : 'review.versions.no')
  return summaryDiffs(version, now).map((d) => {
    if (d.key === 'duration') return { label: t('review.versions.row.duration'), version: fmt.clock(d.version), now: fmt.clock(d.now) }
    if (d.key === 'trimmed') return { label: t('review.versions.row.trimmed'), version: yes(d.version), now: yes(d.now) }
    return { label: t(`review.versions.row.${d.key}`), version: fmt.count(d.version), now: fmt.count(d.now) }
  })
}

/** The parts of the edit changedAreas names, and the files main says changed (namedFiles' kinds), by their names there. */
const AREAS: Readonly<Record<string, MessageKey>> = {
  style: 'review.versions.area.style',
  cursor: 'review.versions.area.cursor',
  camera: 'review.versions.area.camera',
  sound: 'review.versions.area.sound',
  'ignored sounds': 'review.versions.area.ignoredSounds',
  effects: 'review.versions.area.effects',
  'zoom settings': 'review.versions.area.zoomSettings',
  'captions look': 'review.versions.area.captionsLook',
  'caption languages': 'review.versions.area.captionLanguages',
  crop: 'review.versions.area.crop',
  'vertical framing': 'review.versions.area.verticalFraming',
  brand: 'review.versions.area.brand',
  watermark: 'review.versions.area.watermark',
  'export description': 'review.versions.area.exportDescription',
  'automatic changes to review': 'review.versions.area.autoChanges',
  'smooth cuts': 'review.versions.area.smoothCuts',
  colour: 'review.versions.area.colour',
  'progress bar': 'review.versions.area.progressBar',
  guide: 'review.versions.area.guide',
  clips: 'review.versions.area.clips',
  zooms: 'review.versions.area.zooms',
  'texts and titles': 'review.versions.area.textsAndTitles',
  'shapes and spotlights': 'review.versions.area.shapesAndSpotlights',
  images: 'review.versions.area.images',
  'pop-ups': 'review.versions.area.popUps',
  chapters: 'review.versions.area.chapters',
  'freeze frames': 'review.versions.area.freezeFrames',
  'caption text': 'review.versions.area.captionText',
  'speaker names': 'review.versions.area.speakerNames',
  'other settings': 'review.versions.area.otherSettings',
  'background image': 'review.versions.file.backgroundImage',
  'cursor image': 'review.versions.file.cursorImage'
}

/** A part of the edit that differs, in the UI language ("style", "zooms"); a name it does not know as it came. */
export const areaName = (name: string): string => (AREAS[name] ? t(AREAS[name]) : name)

/** The kinds of project files namedFiles gives (its `what`), by those names. */
const FILE_KINDS: Readonly<Record<string, MessageKey>> = {
  'background image': 'review.versions.file.backgroundImage',
  'cursor image': 'review.versions.file.cursorImage',
  logo: 'review.versions.file.logo',
  music: 'review.versions.file.music',
  image: 'review.versions.file.image',
  font: 'review.versions.file.font',
  'colour LUT': 'review.versions.file.colourLut'
}

/** A kind of project file in the UI language ("background image"); a kind it does not know as it came. */
export const fileKindName = (what: string): string => (FILE_KINDS[what] ? t(FILE_KINDS[what]) : what)

/**
 * "Its background image has changed since it was kept." for the files of `changed` (namedFiles'
 * `what`; replacedInPlace gives at most the background and the cursor image, joined as "A and B").
 */
export function changedFilesNotice(changed: readonly string[]): string {
  const kinds = [...new Set(changed)]
  if (kinds.length === 0) return ''
  return t('review.versions.filesChanged', { count: kinds.length, what: fmt.list(kinds.map(fileKindName)) })
}

/** "Its music file is no longer in the project folder." for the files of `missing` (namedFiles' `what`). */
export function missingFilesNotice(missing: readonly string[]): string {
  if (missing.length === 0) return ''
  const kinds = [...new Set(missing)]
  if (kinds.length === 1 && missing.length === 1) return t('review.versions.fileMissing', { what: fileKindName(kinds[0]) })
  return t('review.versions.filesMissing', { n: fmt.count(missing.length), kinds: kinds.map(fileKindName).join(', ') })
}
