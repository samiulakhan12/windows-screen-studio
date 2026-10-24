import type { CameraLayout } from '../../../shared/types'

/**
 * A small picture of a camera layout (the screen as a frame, the camera filled), for the layout
 * picker and the timeline blocks. 24 x 16, drawn in the current colour.
 */
export function LayoutGlyph({ layout, size = 24 }: { layout: CameraLayout; size?: number }): JSX.Element {
  const screen = (x: number, y: number, w: number, h: number): JSX.Element => (
    <rect x={x} y={y} width={w} height={h} rx={1.6} fill="none" stroke="currentColor" strokeWidth={1.4} />
  )
  let body: JSX.Element
  switch (layout) {
    case 'camera-only':
      body = (
        <>
          <rect x={1.5} y={1.5} width={21} height={13} rx={2} fill="currentColor" opacity={0.28} />
          <circle cx={12} cy={6.6} r={2.6} fill="currentColor" />
          <path d="M6.5 14.5a5.5 4.2 0 0 1 11 0z" fill="currentColor" />
        </>
      )
      break
    case 'screen-only':
      body = screen(1.5, 1.5, 21, 13)
      break
    case 'side-by-side':
      body = (
        <>
          {screen(1.5, 3, 13.5, 10)}
          <rect x={16.5} y={3} width={6} height={10} rx={1.4} fill="currentColor" />
        </>
      )
      break
    case 'camera-large':
      body = (
        <>
          {screen(1.5, 1.5, 21, 13)}
          <circle cx={16.2} cy={9.2} r={5.3} fill="currentColor" />
        </>
      )
      break
    default:
      body = (
        <>
          {screen(1.5, 1.5, 21, 13)}
          <circle cx={18.6} cy={11.4} r={2.4} fill="currentColor" />
        </>
      )
  }
  return (
    <svg width={size} height={(size * 16) / 24} viewBox="0 0 24 16" aria-hidden="true" className="layout-glyph">
      {body}
    </svg>
  )
}
