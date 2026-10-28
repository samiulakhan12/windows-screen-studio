import { perChapterBlocked, SIDECAR_KINDS, SIDECAR_LABELS, sidecarBlocked, type BundleOptions, type BundleSources } from '../../../shared/render/exportBundle'
import type { ExportFormat } from '../../../shared/types'
import { Icon } from '../components/Icon'

const TITLES: Record<string, string> = {
  srt: 'Save the captions as an SRT file next to the video (YouTube, Vimeo, most players)',
  vtt: 'Save the captions as a WebVTT file next to the video (web players)',
  chapters: 'Save the chapters as YouTube timestamps (0:00 Intro…) in a text file',
  thumbnail: 'Save the frame chosen above as a PNG at the export size',
  description: 'Save a description with the title, length and chapters, ready to paste'
}

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
  chapterCount
}: {
  value: BundleOptions
  onChange: (next: BundleOptions) => void
  format: ExportFormat
  has: BundleSources
  mode: 'single' | 'batch'
  chapterCount: number
}): JSX.Element {
  const perBlocked = perChapterBlocked(has, mode)
  return (
    <>
      <div className="form-row export-bundle">
        <span>Also save</span>
        <div className="export-stack">
          <div className="chips" role="group" aria-label="Also save">
            {SIDECAR_KINDS.map((k) => {
              const blocked = sidecarBlocked(k, format, has)
              const on = value[k] && !blocked
              return (
                <button
                  key={k}
                  className={`chip ${on ? 'active' : ''}`}
                  aria-pressed={on}
                  disabled={!!blocked}
                  title={blocked ?? TITLES[k]}
                  data-sidecar={k}
                  onClick={() => onChange({ ...value, [k]: !value[k] })}
                >
                  {on && <Icon name="check" size={12} />}
                  {SIDECAR_LABELS[k]}
                </button>
              )
            })}
          </div>
          <p className="hint">{format === 'gif' ? 'GIFs are saved alone.' : 'Saved next to the video, with the same name.'}</p>
        </div>
      </div>
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
          {value.perChapter && !perBlocked && <p className="hint">{chapterCount} files into a folder you choose.</p>}
        </div>
      </div>
    </>
  )
}
