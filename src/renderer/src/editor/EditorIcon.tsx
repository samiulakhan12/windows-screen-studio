// Icons used only by the editor (24x24, stroked like components/Icon).
const PATHS: Record<string, string> = {
  captions: 'M3 5h18v14H3zM7 12h3M7 15h6M13 12h4M15 15h2',
  gear: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  scissors: 'M6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8.5 7.5L20 19M8.5 16.5L20 5',
  split: 'M12 3v18M8 7H4v10h4M16 7h4v10h-4',
  text: 'M5 7V4h14v3M12 4v16M9 20h6',
  speed: 'M12 14l4-4M4 18a9 9 0 1 1 16 0',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9.5l5 5M22 9.5l-5 5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4',
  crosshair: 'M12 2v5M12 17v5M2 12h5M17 12h5M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  restore: 'M4 11a8 8 0 1 1 2.3 5.7M4 5v6h6',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  shapes: 'M3 11h9v10H3zM16 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  image: 'M3 5h18v14H3zM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM21 15l-5-5L5 19'
}

export function EditorIcon({ name, size = 18 }: { name: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
