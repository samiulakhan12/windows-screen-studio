import { memo, useSyncExternalStore } from 'react'
import { shortcutLabel } from '../../../shared/editor/shortcuts'
import { formatRate, isPreviewSpeed, PREVIEW_SPEEDS, previewSpeedHint, shuttleHint, shuttleLabel, type ShuttleDir } from '../../../shared/editor/shuttle'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { useKeymap } from './keymapContext'
import './previewSpeed.css'

/**
 * The preview speed menu and the J/K/L shuttle badge, in the transport. Neither is an edit: the
 * speed lives on the player, never in the project. Re-renders only when the shuttle or the speed
 * changes (player.getShuttleKey), not on every frame.
 */
export const PreviewSpeedControl = memo(function PreviewSpeedControl(): JSX.Element {
  const { player } = useEditor()
  const keymap = useKeymap()
  const [dir, level, speed, silent] = useSyncExternalStore(player.subscribe, player.getShuttleKey).split('|').map(Number)
  const badge = shuttleLabel({ dir: dir as ShuttleDir, level }, speed, silent === 1)
  const key = (keys: readonly string[]): string | null => (keys.length ? shortcutLabel(keys[0]) : null)

  return (
    <>
      <label className="preview-speed" data-changed={speed !== 1} title={previewSpeedHint(key(keymap.previewSpeedDown), key(keymap.previewSpeedUp))}>
        <EditorIcon name="speed" size={14} />
        <select
          aria-label="Preview speed"
          value={String(speed)}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (isPreviewSpeed(v)) player.setPreviewSpeed(v)
            // A focused select is a text field to the editor's shortcuts: give Space, J, K and L back.
            e.currentTarget.blur()
          }}
        >
          {PREVIEW_SPEEDS.map((s) => (
            <option key={s} value={String(s)}>
              {formatRate(s)}
            </option>
          ))}
        </select>
      </label>
      <span className="shuttle-slot" role="status" aria-live="polite">
        {badge && (
          <span
            className="shuttle-badge"
            data-dir={dir < 0 ? 'reverse' : 'forward'}
            title={shuttleHint({ reverse: key(keymap.shuttleReverse), pause: key(keymap.shuttlePause), forward: key(keymap.shuttleForward) })}
          >
            {badge}
          </span>
        )}
      </span>
    </>
  )
})
