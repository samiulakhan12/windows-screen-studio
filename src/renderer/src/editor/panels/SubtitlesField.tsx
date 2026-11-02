/**
 * The export dialog's Subtitles field (docs/design/captions-studio.md §2.13, §11.10): the caption
 * languages to write, the SRT and VTT files (one per ticked language), and Also inside the video
 * (subtitle streams in MP4, MOV and WebM). GIF and M4A keep today's choices: no languages, no
 * streams.
 *
 * Mounted by ExportDialog.tsx, which keeps the choices: the contracts' props { project } gained
 * the bundle choices, the format and the streams flag, which the field shows and changes.
 */
import { burnedTrackNote, exportLanguages, tickedExportLanguages } from '../../../../shared/captions/captionTracks'
import { sidecarBlocked, SIDECAR_LABELS, type BundleOptions } from '../../../../shared/render/exportBundle'
import type { ExportFormat, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'

const TITLES = {
  srt: 'Save the captions as an SRT file next to the video, one per language (YouTube, Vimeo, most players)',
  vtt: 'Save the captions as a WebVTT file next to the video, one per language (web players)'
} as const

/** Formats that carry subtitle streams. */
export const STREAM_FORMATS: readonly ExportFormat[] = ['mp4', 'mov', 'webm']

export function SubtitlesField(props: {
  project: Project
  value: BundleOptions
  onChange: (next: BundleOptions) => void
  format: ExportFormat
  /** Also inside the video. */
  streams: boolean
  onStreams: (on: boolean) => void
}): JSX.Element {
  const { project, value, onChange, format } = props
  const has = { captions: !!project.transcript?.segments.some((s) => s.text.trim()), chapters: false }
  const blocked = sidecarBlocked('srt', format, has)
  const languages = exportLanguages(project)
  const ticked = tickedExportLanguages(project, value.languages)
  // GIF and M4A keep today's choices: the spoken language's files only, no streams.
  const several = !blocked && format !== 'm4a' && languages.length > 1
  const streamable = !blocked && STREAM_FORMATS.includes(format)
  const note = !blocked && format !== 'm4a' ? burnedTrackNote(project) : null
  const tick = (code: string, on: boolean): void => {
    const next = on ? [...ticked, code] : ticked.filter((l) => l !== code)
    if (next.length) onChange({ ...value, languages: languages.map((l) => l.code).filter((l) => next.includes(l)) })
  }
  return (
    <div className="form-row export-bundle" data-testid="export-subtitles">
      <span>Subtitles</span>
      <div className="export-stack">
        {several && (
          <div role="group" aria-label="Subtitle languages" className="row start">
            {languages.map((l) => {
              const on = ticked.includes(l.code)
              return (
                <label key={l.code} className="toggle">
                  <span>{l.name}</span>
                  <input type="checkbox" checked={on} disabled={on && ticked.length === 1} data-language={l.code} onChange={(e) => tick(l.code, e.target.checked)} />
                </label>
              )
            })}
          </div>
        )}
        <div className="chips" role="group" aria-label="Subtitle files">
          {(['srt', 'vtt'] as const).map((k) => {
            const on = value[k] && !blocked
            return (
              <button key={k} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} disabled={!!blocked} title={blocked ?? TITLES[k]} data-sidecar={k} onClick={() => onChange({ ...value, [k]: !value[k] })}>
                {on && <Icon name="check" size={12} />}
                {SIDECAR_LABELS[k]}
              </button>
            )
          })}
        </div>
        {blocked ? <p className="hint">{blocked}.</p> : <p className="hint">As files next to the video, one for each language ticked. This is what YouTube takes.</p>}
        {streamable && (
          <>
            <label className="toggle">
              <span>Also inside the video (players can switch them)</span>
              <input type="checkbox" data-testid="export-subtitle-streams" checked={props.streams} onChange={(e) => props.onStreams(e.target.checked)} />
            </label>
            {props.streams && <p className="hint">They are separate from the captions drawn on the video.</p>}
          </>
        )}
        {note && <p className="hint">{note}</p>}
      </div>
    </div>
  )
}
