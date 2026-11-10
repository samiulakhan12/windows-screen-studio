import type { SoundStem, TimelineEditor } from '../../../shared/api/export'
import { t, type MessageKey } from '../../../shared/i18n/t'
import { editorBlocked, editorWarning, stemsBlocked, stemsHint, timelineBlocked } from '../../../shared/render/alsoSave'
import { perChapterBlocked, SIDECAR_KINDS, SIDECAR_LABELS, sidecarBlocked, type BundleOptions, type BundleSources, type SidecarKind } from '../../../shared/render/exportBundle'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import { CODEC_NAMES } from '../../../shared/render/exportRows'
import { codecOf } from '../../../shared/render/proFormats'
import type { ExportFormat } from '../../../shared/types'
import { Icon } from '../components/Icon'

const TITLES: Record<string, string> = {
  chapters: 'Save the chapters as YouTube timestamps (0:00 Intro…) in a text file',
  thumbnail: 'Save the frame chosen above as a PNG at the export size',
  description: 'Save a description with the title, length and chapters, ready to paste'
}
/** One file per chapter: what each part's thumbnail and description hold. */
const PART_TITLES: Partial<Record<SidecarKind, string>> = {
  thumbnail: 'Save the frame 1 s into each part as a PNG at the export size',
  description: "Save a description with each part's title, which part it is and its length, ready to paste"
}
/** The description written in Publish and saved with "Use for exports" (NW-13): it replaces the standard one, not a part's. */
const SAVED_DESCRIPTION_TITLE = "Save the description written in Publish, with this export's chapters, ready to paste"
/** One file per chapter: a part is one chapter, so no chapter list is saved (bundleKinds). */
const PART_NO_CHAPTER_LIST = 'Each file is one chapter, so it has no chapter list'

/** The "Also save" chips: the captions' SRT and VTT moved to the Subtitles field (Captions Studio §2.13, SubtitlesField.tsx). */
const ALSO_SAVE: readonly SidecarKind[] = SIDECAR_KINDS.filter((k) => k !== 'srt' && k !== 'vtt')

/**
 * "Also save" in the export dialog's settings (F-11): files written next to the video, and one
 * file per chapter. A choice that cannot apply is disabled and says why.
 */
export function ExportBundleOptions({
  value,
  onChange,
  format,
  has,
  mode,
  chapterCount,
  pendingChapters = 0,
  savedDescription = false,
  alsoSave
}: {
  value: BundleOptions
  onChange: (next: BundleOptions) => void
  format: ExportFormat
  has: BundleSources
  mode: 'single' | 'batch'
  chapterCount: number
  /** Found chapters not reviewed yet (smart-tools.md §2.3): the chapter note says how many. */
  pendingChapters?: number
  /** The project has a description saved in Publish (project.publish), which the description file uses. */
  savedDescription?: boolean
  /** Sound stems and Timeline (output-and-languages §2.3): what they need to know of the export; absent, the row is as before. */
  alsoSave?: AlsoSaveContext
}): JSX.Element {
  const perBlocked = perChapterBlocked(has, mode)
  const perOn = value.perChapter && !perBlocked
  const also = alsoSave ? alsoSaveState(value, alsoSave, mode, perOn) : null
  const blockedOf = (k: SidecarKind): string | null => sidecarBlocked(k, format, has) ?? (perOn && k === 'chapters' ? PART_NO_CHAPTER_LIST : null)
  // Why chips are off, as text everyone can read (a disabled button's tooltip is not announced).
  const reasons = format === 'gif' ? [] : [...new Set(ALSO_SAVE.map(blockedOf).filter((r): r is string => !!r))]
  return (
    <>
      <div className="form-row export-bundle">
        <span>Also save</span>
        <div className="export-stack">
          <div className="chips" role="group" aria-label="Also save">
            {ALSO_SAVE.map((k) => {
              const blocked = blockedOf(k)
              const on = value[k] && !blocked
              return (
                <button
                  key={k}
                  className={`chip ${on ? 'active' : ''}`}
                  aria-pressed={on}
                  disabled={!!blocked}
                  title={blocked ?? ((perOn && PART_TITLES[k]) || (k === 'description' && savedDescription ? SAVED_DESCRIPTION_TITLE : TITLES[k]))}
                  data-sidecar={k}
                  onClick={() => onChange({ ...value, [k]: !value[k] })}
                >
                  {on && <Icon name="check" size={12} />}
                  {SIDECAR_LABELS[k]}
                </button>
              )
            })}
            {also && <AlsoSaveChips value={value} onChange={onChange} also={also} />}
          </div>
          <p className="hint">{format === 'gif' ? 'GIFs are saved alone.' : 'Saved next to the video, with the same name.'}</p>
          {reasons.length > 0 && <p className="hint">{reasons.map((r) => `${r}.`).join(' ')}</p>}
          {also && <AlsoSaveLines also={also} />}
        </div>
      </div>
      {also && <TimelineRows value={value} onChange={onChange} also={also} />}
      <div className="form-row export-bundle">
        <span>Chapters</span>
        <div className="export-stack">
          <div className="chips">
            <button
              className={`chip ${value.perChapter && !perBlocked ? 'active' : ''}`}
              aria-pressed={value.perChapter && !perBlocked}
              disabled={!!perBlocked}
              title={perBlocked ?? 'Export each chapter as its own file (01 Intro, 02 …) into a folder. Music starts again in each file.'}
              data-per-chapter
              onClick={() => onChange({ ...value, perChapter: !value.perChapter })}
            >
              {value.perChapter && !perBlocked && <Icon name="check" size={12} />}
              One file per chapter
            </button>
          </div>
          {value.perChapter && !perBlocked && <p className="hint">{chapterCount} files into a folder you choose. Music and sound fades start again in each file.</p>}
          {pendingChapters > 0 && <p className="hint">{pendingChapters} of them not reviewed yet: Review lists them.</p>}
          {perBlocked && <p className="hint">{perBlocked}.</p>}
        </div>
      </div>
    </>
  )
}

/* ---------- Sound stems and Timeline (output-and-languages §2.3) ---------- */

/** What Sound stems and Timeline need to know of the export. */
export interface AlsoSaveContext {
  /** The settings as this PC exports them (usableCodec). */
  options: ExportOptions
  /** The video has a soundtrack (hasSoundtrack). */
  hasSound: boolean
  /** The stems the export would write (stemJobOf), for the hint. */
  stems: readonly SoundStem[]
  /** The video's length in seconds. */
  seconds: number
  /** Even out loudness is on and a recording stem is written: the stems are not evened out like the video. */
  notEvened: boolean
}

interface AlsoState {
  ctx: AlsoSaveContext
  stemsBlocked: MessageKey | null
  timelineBlocked: MessageKey | null
  stemsOn: boolean
  timelineOn: boolean
  media: 'export' | 'recordings'
}

function alsoSaveState(value: BundleOptions, ctx: AlsoSaveContext, mode: 'single' | 'batch', perChapter: boolean): AlsoState {
  const stems = stemsBlocked(ctx.options, mode, perChapter, ctx.hasSound)
  const timeline = timelineBlocked(ctx.options, mode, perChapter)
  return {
    ctx,
    stemsBlocked: stems,
    timelineBlocked: timeline,
    stemsOn: value.stems === true && !stems,
    timelineOn: !!value.timelines?.length && !timeline,
    media: value.timelineMedia ?? 'export'
  }
}

/** The editors of the Open in row, in order. */
const EDITORS: readonly TimelineEditor[] = ['resolve', 'premiere', 'finalcut', 'edl']

const EDITOR_KEYS: Readonly<Record<TimelineEditor, { label: MessageKey; title: MessageKey }>> = {
  resolve: { label: 'timelines.editor.resolve.label', title: 'timelines.editor.resolve.title' },
  premiere: { label: 'timelines.editor.premiere.label', title: 'timelines.editor.premiere.title' },
  finalcut: { label: 'timelines.editor.finalcut.label', title: 'timelines.editor.finalcut.title' },
  edl: { label: 'timelines.editor.edl.label', title: 'timelines.editor.edl.title' }
}

/** The editors Open in had the last time a timeline was on in this session; the first time, DaVinci Resolve. */
let lastEditors: TimelineEditor[] = ['resolve']

/** `value` with `key` set, or without it when `v` is undefined (stored choices never hold undefined). */
function withKey<K extends keyof BundleOptions>(value: BundleOptions, key: K, v: BundleOptions[K] | undefined): BundleOptions {
  const next = { ...value }
  if (v === undefined) delete next[key]
  else next[key] = v
  return next
}

/** A blocked editor's reason, with the export's codec named. */
const editorReason = (key: MessageKey, o: ExportOptions): string => t(key, { codec: CODEC_NAMES[codecOf(o)] })

/** The Sound stems (WAV) and Timeline chips at the end of the Also save row. */
function AlsoSaveChips({ value, onChange, also }: { value: BundleOptions; onChange: (next: BundleOptions) => void; also: AlsoState }): JSX.Element {
  return (
    <>
      <button
        type="button"
        className={`chip ${also.stemsOn ? 'active' : ''}`}
        aria-pressed={also.stemsOn}
        disabled={!!also.stemsBlocked}
        title={also.stemsBlocked ? t(also.stemsBlocked) : t('stems.chip.title')}
        data-also="stems"
        onClick={() => onChange(withKey(value, 'stems', value.stems ? undefined : true))}
      >
        {also.stemsOn && <Icon name="check" size={12} />}
        {t('stems.chip.label')}
      </button>
      <button
        type="button"
        className={`chip ${also.timelineOn ? 'active' : ''}`}
        aria-pressed={also.timelineOn}
        disabled={!!also.timelineBlocked}
        title={also.timelineBlocked ? t(also.timelineBlocked) : t('timelines.chip.title')}
        data-also="timeline"
        onClick={() => {
          // Off keeps the editors for the next time Timeline is turned on in this session.
          if (value.timelines?.length) lastEditors = [...value.timelines]
          onChange(withKey(value, 'timelines', value.timelines?.length ? undefined : [...lastEditors]))
        }}
      >
        {also.timelineOn && <Icon name="check" size={12} />}
        {t('timelines.chip.label')}
      </button>
    </>
  )
}

/** Under the Also save row: why Sound stems or Timeline is off (GIFs say so already), and what the stems will be. */
function AlsoSaveLines({ also }: { also: AlsoState }): JSX.Element | null {
  const gif = also.ctx.options.format === 'gif'
  const reasons = gif ? [] : [...new Set([also.stemsBlocked, also.timelineBlocked].filter((k): k is MessageKey => !!k))]
  const hint = also.stemsOn ? stemsHint(also.ctx.stems, also.ctx.seconds) : ''
  if (!reasons.length && !hint) return null
  return (
    <>
      {reasons.length > 0 && (
        <p className="hint" data-testid="also-save-reasons">
          {reasons.map((k) => `${t(k)}.`).join(' ')}
        </p>
      )}
      {hint && (
        <p className="hint" data-testid="stems-hint">
          {hint}
        </p>
      )}
      {hint && also.ctx.notEvened && <p className="hint">{t('stems.hint.notEvened')}</p>}
    </>
  )
}

/** With Timeline on: the Open in row (at least one editor) and the Uses row (This export or The original recordings). */
function TimelineRows({ value, onChange, also }: { value: BundleOptions; onChange: (next: BundleOptions) => void; also: AlsoState }): JSX.Element | null {
  if (!also.timelineOn) return null
  const { options } = also.ctx
  const chosen = value.timelines ?? []
  // The chosen editors that can open this export: only these get a timeline.
  const usable = chosen.filter((x) => !editorBlocked(x, options, also.media))
  const toggle = (e: TimelineEditor): void => {
    const on = chosen.includes(e)
    // At least one editor that can open this export stays on.
    if (on && usable.length === 1 && usable[0] === e) return
    const next = EDITORS.filter((x) => (x === e ? !on : chosen.includes(x)))
    lastEditors = next
    onChange(withKey(value, 'timelines', next))
  }
  const blocked = EDITORS.map((e) => [e, editorBlocked(e, options, also.media)] as const).filter(([, k]) => !!k)
  const warnings = chosen.map((e) => [e, editorWarning(e, options, also.media)] as const).filter(([e, k]) => !!k && !editorBlocked(e, options, also.media))
  const setMedia = (m: 'export' | 'recordings'): void => onChange(withKey(value, 'timelineMedia', m === 'recordings' ? 'recordings' : undefined))
  return (
    <>
      <div className="form-row export-bundle">
        <span id="export-open-in">{t('timelines.row.openIn')}</span>
        <div className="export-stack">
          <div className="chips" role="group" aria-labelledby="export-open-in">
            {EDITORS.map((e) => {
              const reason = editorBlocked(e, options, also.media)
              const on = chosen.includes(e) && !reason
              return (
                <button
                  key={e}
                  type="button"
                  className={`chip ${on ? 'active' : ''}`}
                  aria-pressed={on}
                  disabled={!!reason}
                  title={reason ? editorReason(reason, options) : t(EDITOR_KEYS[e].title)}
                  data-editor={e}
                  onClick={() => toggle(e)}
                >
                  {on && <Icon name="check" size={12} />}
                  {t(EDITOR_KEYS[e].label)}
                </button>
              )
            })}
          </div>
          {blocked.map(([e, k]) => (
            <p key={e} className="hint" data-testid={`editor-blocked-${e}`}>
              {editorReason(k!, options)}
            </p>
          ))}
          {usable.length === 0 && (
            <p className="hint warn" data-testid="timeline-no-editor">
              {t('timelines.openIn.none')}
            </p>
          )}
          {warnings.map(([e, k]) => (
            <p key={e} className="hint warn" data-testid={`editor-warning-${e}`}>
              {t(k!, { editor: t(EDITOR_KEYS[e].label), codec: CODEC_NAMES[codecOf(options)] })}
            </p>
          ))}
        </div>
      </div>
      <div className="form-row export-bundle">
        <span id="export-uses">{t('timelines.row.uses')}</span>
        <div className="export-uses" role="radiogroup" aria-labelledby="export-uses">
          {(['export', 'recordings'] as const).map((m) => (
            <div key={m}>
              <label>
                <input type="radio" name="export-timeline-media" value={m} checked={also.media === m} onChange={() => setMedia(m)} data-media={m} />
                {t(m === 'export' ? 'timelines.uses.export.label' : 'timelines.uses.recordings.label')}
              </label>
              {also.media === m && <p className="hint">{t(m === 'export' ? 'timelines.uses.export.hint' : 'timelines.uses.recordings.hint')}</p>}
            </div>
          ))}
          {also.media === 'recordings' && chosen.includes('premiere') && <p className="hint">{t('timelines.uses.premierePitch')}</p>}
        </div>
      </div>
    </>
  )
}
