import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorIcon } from '../editor/EditorIcon'
import { SettingsDialog, type SettingsSection } from './SettingsDialog'

/** Opens Settings at a section from anywhere: dispatch `new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'ai' } })`. */
export const OPEN_SETTINGS_EVENT = 'ssw:open-settings'

/** Dispatched on window after AI providers were added, edited or removed (and when Settings closes): lists of providers re-read then. */
export const AI_PROVIDERS_CHANGED_EVENT = 'ssw:ai-providers-changed'

const announceProviders = (): void => void window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED_EVENT))

/**
 * Opens the app settings (AI providers and API keys). Shown in the title bars of Home and the
 * editor; also opens on OPEN_SETTINGS_EVENT (the captions panel's "Add a provider").
 */
export function SettingsButton(): JSX.Element {
  const [section, setSection] = useState<SettingsSection | null>(null)

  useEffect(() => {
    const onOpen = (e: Event): void => {
      const wanted = (e as CustomEvent<{ section?: unknown } | null>).detail?.section
      setSection(wanted === 'about' || wanted === 'speech' ? wanted : 'ai')
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
  }, [])

  return (
    <>
      <button className="btn ghost icon-btn" title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded={section !== null} onClick={() => setSection('ai')}>
        <EditorIcon name="gear" />
      </button>
      {/* In the body: title bars are drag regions and may be transformed by their layout. */}
      {section &&
        createPortal(
          <SettingsDialog
            section={section}
            onProvidersChanged={announceProviders}
            onClose={() => {
              setSection(null)
              announceProviders()
            }}
          />,
          document.body
        )}
    </>
  )
}
