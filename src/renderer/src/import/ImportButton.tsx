import type { VideoImporter } from './useVideoImport'

/** "Import video" in the head of Recent recordings. */
export function ImportButton({ importer, disabled }: { importer: VideoImporter; disabled: boolean }): JSX.Element {
  return (
    <button type="button" className="btn ghost import-btn" disabled={disabled} onClick={importer.pick} title="Open a video made with another app as a new project" data-testid="import-video">
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
        <path d="M12 15V4M7 9l5-5 5 5M5 20h14" />
      </svg>
      Import video
    </button>
  )
}
