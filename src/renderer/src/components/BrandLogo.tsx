import markFlatUrl from '../../../../assets/brand/flown-mark-flat.svg?url'
import markUrl from '../../../../assets/brand/flown-mark.svg?url'
import wordmarkUrl from '../../../../assets/brand/flown-wordmark-white.svg?url'
import { APP_NAME } from '../../../shared/brand'
import './brand.css'

/**
 * The Flown logo from the brand kit (assets/brand): the gradient mark and the white wordmark,
 * as vectors, so they stay sharp at every display scale. For the dark surfaces only (Ink).
 * `size` is the mark's height in px; below 48 px the kit's flat mark is used, as its usage
 * rules ask. The mark alone is decorative (put the name next to it).
 */
export function BrandLogo({ size = 20, wordmark = true }: { size?: number; wordmark?: boolean }): JSX.Element {
  return (
    <span className="flown-logo" {...(wordmark ? { role: 'img', 'aria-label': APP_NAME } : { 'aria-hidden': true })} style={{ ['--flown-logo-size' as string]: `${size}px` }}>
      <img className="flown-logo-mark" src={size < 48 ? markFlatUrl : markUrl} alt="" draggable={false} />
      {wordmark && <img className="flown-logo-wordmark" src={wordmarkUrl} alt="" draggable={false} />}
    </span>
  )
}
