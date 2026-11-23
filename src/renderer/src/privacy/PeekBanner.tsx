import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { t } from '../../../shared/i18n/t'
import { clearPeek, usePeek } from './peek'
import './covers.css'

/**
 * The banner over the preview while anything is peeked (docs/design/auto-blur.md §2.8): exports
 * still cover what the preview shows. *Stop peeking* stops Peek, *Peek while reviewing* and Listen.
 */
export function PeekBanner(): JSX.Element | null {
  const peek = usePeek()
  if (peek.ids === null) return null
  return (
    <div className="cover-peek-banner" role="status" data-testid="peek-banner">
      <span>{t(PRIVACY_COPY.peek.banner)}</span>
      <button type="button" className="btn ghost small" onPointerDown={(e) => e.stopPropagation()} onClick={() => clearPeek()} data-testid="peek-stop">
        {t(PRIVACY_COPY.peek.stop)}
      </button>
    </div>
  )
}
