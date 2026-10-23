const PATHS: Record<string, string> = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  window: 'M3 5h18v14H3zM3 9h18',
  camera: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  plus: 'M12 5v14M5 12h14',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  folder: 'M3 6h6l2 2h10v11H3z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  back: 'M15 5l-7 7 7 7',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  cursor: 'M5 3l14 7-6 2-2 6z',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 0 0-.01',
  check: 'M5 12l5 5 9-10',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5S13.4 15 14.5 15H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11a1 1 0 1 0 0-.01M10 7.5a1 1 0 1 0 0-.01M14.5 7.5a1 1 0 1 0 0-.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4'
}

export function Icon({ name, size = 18 }: { name: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name] ?? ''} fill={name === 'play' || name === 'pause' ? 'currentColor' : 'none'} />
    </svg>
  )
}
