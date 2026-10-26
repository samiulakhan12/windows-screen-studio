/** Icons of the recording bar and the camera bubble (24-unit strokes, like the app's Icon). */
const PATHS = {
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  play: 'M8 5.5v13l11-6.5z',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3',
  restart: 'M4 12a8 8 0 108-8 8.4 8.4 0 00-5.7 2.3L4 8.5M4 4v4.5h4.5',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3',
  'mic-off': 'M3 3l18 18M9 9v3a3 3 0 005.1 2.1M15 9.3V6a3 3 0 00-5.7-1.3M5 11a7 7 0 0011.9 5M19 11a7 7 0 01-.6 2.8M12 18v3',
  camera: 'M3 7h11a2 2 0 012 2v6a2 2 0 01-2 2H3zM16 10.5l5-3v9l-5-3',
  'camera-off': 'M3 3l18 18M7 7H5a2 2 0 00-2 2v6a2 2 0 002 2h9a2 2 0 001.6-.8M11 7h3a2 2 0 012 2v3.5l5-3.5v9',
  'eye-off': 'M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 5 10 7a13 13 0 01-3.2 3.9M6.2 6.3C3.9 7.8 2.5 10 2 12c1 2 5 7 10 7 1.6 0 3-.4 4.3-1',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  zoom: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4M11 8v6M8 11h6',
  alert: 'M12 3l10 18H2zM12 10v4M12 17.5h.01',
  notes: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5',
  'notes-off': 'M3 3l18 18M6 6v15h13v-2M9.5 3H15l4 4v7.5M14 3v5h5M9 12h1M9 16h5',
  'step-back': 'M6.5 5v14M18 6.5l-8.5 5.5 8.5 5.5z',
  'step-forward': 'M17.5 5v14M6 6.5l8.5 5.5L6 17.5z',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  resize: 'M20 10L10 20M20 15.5L15.5 20'
} as const

export type RecordingIconName = keyof typeof PATHS

const FILLED: ReadonlySet<RecordingIconName> = new Set(['pause', 'play'])

export function RecIcon({ name, size = 16 }: { name: RecordingIconName; size?: number }): JSX.Element {
  const filled = FILLED.has(name)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="rec-icon">
      <path
        d={PATHS[name]}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={name === 'grip' ? 3.2 : 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
