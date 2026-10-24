import type { PresetIcon } from '../../../shared/render/exportPresets'

/**
 * Small badges for the destination presets: simple shapes in each platform's colour
 * (not the platforms' logos), drawn on a 24x24 grid.
 */
const BADGES: Record<PresetIcon, { bg: string; body: JSX.Element }> = {
  youtube: {
    bg: '#ff2d2d',
    body: <path d="M10 8.5v7l6-3.5z" fill="#fff" />
  },
  shorts: {
    bg: '#ff2d2d',
    body: (
      <>
        <rect x="8" y="5" width="8" height="14" rx="2.2" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M11 10v4l3.2-2z" fill="#fff" />
      </>
    )
  },
  x: {
    bg: '#000',
    body: <path d="M7.5 7l9 10M16.5 7l-9 10" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
  },
  linkedin: {
    bg: '#0a66c2',
    body: (
      <>
        <rect x="7" y="10.5" width="2.2" height="6.5" rx="0.6" fill="#fff" />
        <circle cx="8.1" cy="7.9" r="1.3" fill="#fff" />
        <path d="M11.4 17v-6.5h2.1v1c.5-.8 1.3-1.2 2.3-1.2 1.6 0 2.4 1 2.4 2.9V17H16v-3.5c0-.9-.4-1.4-1.1-1.4-.8 0-1.3.6-1.3 1.5V17z" fill="#fff" />
      </>
    )
  },
  instagram: {
    bg: 'url(#ssw-ig)',
    body: (
      <>
        <rect x="6.5" y="6.5" width="11" height="11" rx="3.3" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="15.2" cy="8.8" r="0.9" fill="#fff" />
      </>
    )
  },
  tiktok: {
    bg: '#111',
    body: (
      <>
        <path d="M13.6 6v8.2a2.6 2.6 0 1 1-2.6-2.6" fill="none" stroke="#25f4ee" strokeWidth="1.8" strokeLinecap="round" transform="translate(-0.7 -0.5)" />
        <path d="M13.6 6v8.2a2.6 2.6 0 1 1-2.6-2.6" fill="none" stroke="#fe2c55" strokeWidth="1.8" strokeLinecap="round" transform="translate(0.7 0.5)" />
        <path d="M13.6 6v8.2a2.6 2.6 0 1 1-2.6-2.6M13.6 6c.3 1.8 1.5 3 3.4 3.2" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </>
    )
  },
  square: {
    bg: '#3b3b52',
    body: <rect x="7" y="7" width="10" height="10" rx="1.6" fill="none" stroke="#fff" strokeWidth="1.7" />
  },
  slack: {
    bg: '#4a154b',
    body: (
      <text x="12" y="15.2" textAnchor="middle" fontSize="7.4" fontWeight="800" fill="#fff" fontFamily="'Segoe UI', system-ui, sans-serif">
        GIF
      </text>
    )
  },
  email: {
    bg: '#0e7490',
    body: (
      <>
        <rect x="6" y="8" width="12" height="9" rx="1.5" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M6.6 8.8l5.4 4.2 5.4-4.2" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </>
    )
  }
}

export function PresetBadge({ icon, size = 30 }: { icon: PresetIcon; size?: number }): JSX.Element {
  const b = BADGES[icon]
  return (
    <svg className="preset-badge" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {icon === 'instagram' && (
        <defs>
          <linearGradient id="ssw-ig" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#feda75" />
            <stop offset="0.35" stopColor="#fa7e1e" />
            <stop offset="0.65" stopColor="#d62976" />
            <stop offset="1" stopColor="#4f5bd5" />
          </linearGradient>
        </defs>
      )}
      <rect width="24" height="24" rx="6" fill={b.bg} />
      {b.body}
    </svg>
  )
}

/** The outline of an aspect ratio, for the shape chips and preset cards. */
export function AspectGlyph({ ratio, size = 14 }: { ratio: number; size?: number }): JSX.Element {
  const w = ratio >= 1 ? size : Math.max(4, size * ratio)
  const h = ratio >= 1 ? Math.max(4, size / ratio) : size
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="aspect-glyph">
      <rect x={(size - w) / 2 + 0.75} y={(size - h) / 2 + 0.75} width={w - 1.5} height={h - 1.5} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
