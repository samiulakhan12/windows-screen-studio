import { useRef } from 'react'
import { Icon } from '../components/Icon'
import { useModalFocus } from '../editor/modalFocus'
import { AboutSection } from './AboutSection'
import { AiProvidersSection } from './AiProvidersSection'
import { BrandKitSection } from './BrandKitSection'
import { HealthSections } from './HealthSections'
import { SpeechModelsSection } from './SpeechModelsSection'
import { CaptionDownloadsSection } from './CaptionDownloadsSection'
import { MusicDownloadsSection } from './MusicDownloadsSection'
import { LocalAiSection } from './LocalAiSection'
import { ShareSection } from '../share/ShareSection'
import './settings.css'

/** 'localAi': AI on this PC (docs/design/smart-tools.md §2.5): the palette's Set up AI on this PC… and every "use AI on this PC" link. */
export type SettingsSection = 'ai' | 'speech' | 'localAi' | 'brand' | 'about'

/**
 * App settings: the AI providers (the user's own API keys for transcription and text tasks),
 * captions on this PC (the speech models), the brand kit and About. A modal dialog: Tab stays inside, Esc closes it (after closing a form or question
 * inside first), and focus goes back to where it was. Keys pressed inside stay inside, so the
 * editor's shortcuts never act behind it.
 */
export function SettingsDialog({ section, onClose, onProvidersChanged }: { section: SettingsSection; onClose: () => void; onProvidersChanged?: () => void }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  useModalFocus(boxRef, onClose)

  return (
    <div className="overlay modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={boxRef}
        data-section={section}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="btn ghost icon-btn" onClick={onClose} title="Close" aria-label="Close settings">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="settings-body">
          <AiProvidersSection onChanged={onProvidersChanged} autoFocus={section === 'ai'} />
          <SpeechModelsSection reveal={section === 'speech'} />
          <LocalAiSection reveal={section === 'localAi'} />
          <CaptionDownloadsSection />
          {/* More music for the library (docs/design/editing-polish.md §2.6): hidden until its download source exists. */}
          <MusicDownloadsSection />
          <BrandKitSection reveal={section === 'brand'} />
          <ShareSection />
          <HealthSections />
          <AboutSection reveal={section === 'about'} />
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
