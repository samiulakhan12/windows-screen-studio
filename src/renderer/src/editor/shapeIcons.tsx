import type { ShapeKind } from '../../../shared/types'

// Glyphs for the shape tools (24x24, stroked like EditorIcon).
const PATHS: Record<ShapeKind | 'spotlight-cursor' | 'spotlight-region' | 'duplicate', string> = {
  arrow: 'M5 19L18 6M10 6h8v8',
  line: 'M5 19L19 5',
  rect: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
  ellipse: 'M12 5c4.97 0 9 3.13 9 7s-4.03 7-9 7-9-3.13-9-7 4.03-7 9-7z',
  highlight: 'M4 15h16v4H4zM9 15l2-9h2l2 9',
  blur: 'M4 9h2M4 15h2M18 9h2M18 15h2M9 4v2M15 4v2M9 18v2M15 18v2M9 9h6v6H9z',
  pixelate: 'M4 4h5v5H4zM9 9h6v6H9zM15 4h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z',
  'spotlight-cursor': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 9l6 3-2.5.8L12.5 16z',
  'spotlight-region': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 9.5h7v5h-7z',
  duplicate: 'M8 8h11v11H8zM5 15V5h10'
}

export function ShapeIcon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name]} />
    </svg>
  )
}
