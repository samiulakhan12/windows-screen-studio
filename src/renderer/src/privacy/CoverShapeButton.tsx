import { withShortcut } from '../../../shared/editor/shortcuts'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { t } from '../../../shared/i18n/t'
import type { EditorServices } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { useKeymap } from '../editor/keymapContext'
import './covers.css'

/** A solid box: the Cover tool's glyph (24 × 24, as the shape tools' glyphs). */
export function CoverGlyph({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M4 7h16v10H4z" fill="currentColor" />
    </svg>
  )
}

/**
 * The *Cover* button after *Pixelate* in the add-shape row (docs/design/auto-blur.md §2.1): it runs
 * *Add a cover*, as the Private info section's *Add cover* does, so the habit of reaching for Blur
 * meets the safe choice beside it.
 */
export function CoverShapeButton(props: { services: EditorServices }): JSX.Element | null {
  void props
  const group = useGroup()
  const keymap = useKeymap()
  return (
    <button
      className="shape-tool privacy cover-tool"
      data-kind="cover"
      data-testid="cover-tool"
      title={withShortcut(t(PRIVACY_COPY.shape.coverTitle), keymap.addCover)}
      onClick={() => group.command('addCover')}
    >
      <CoverGlyph />
      <span>{t(PRIVACY_COPY.shape.cover)}</span>
    </button>
  )
}
