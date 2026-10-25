import { EditorIcon } from '../editor/EditorIcon'

/** Opens the app settings (AI providers and API keys). Shown in the title bars of Home and the editor. */
export function SettingsButton(): JSX.Element {
  return (
    <button className="btn ghost icon-btn" title="Settings" aria-label="Settings" disabled>
      <EditorIcon name="gear" />
    </button>
  )
}
