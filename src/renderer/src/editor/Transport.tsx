import { memo, useEffect, useRef, useSyncExternalStore } from 'react'
import { outputTimeAt } from '../../../shared/editor/clips'
import { withShortcut, type Keymap } from '../../../shared/editor/shortcuts'
import { formatTime } from '../../../shared/engine/project'
import { outputDuration } from '../../../shared/engine/timeline'
import type { Clip } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'

interface Props {
  clips: Clip[]
  notice: string | null
  onTogglePlay: () => void
  onSplit: () => void
  onAddZoom: () => void
  onAddText: () => void
  /** Current shortcuts, shown in the tooltips. */
  keymap: Keymap
}

export function usePlaying(): boolean {
  const { player } = useEditor()
  return useSyncExternalStore(player.subscribe, player.getPlaying)
}

/**
 * Play button, output timecode and edit tools. The timecode is written straight
 * to the DOM from the player, so playback never re-renders React components.
 */
export const Transport = memo(function Transport({ clips, notice, onTogglePlay, onSplit, onAddZoom, onAddText, keymap }: Props): JSX.Element {
  const { player } = useEditor()
  const playing = usePlaying()
  const timeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let last = ''
    const total = formatTime(outputDuration(clips))
    const render = (): void => {
      const text = `${formatTime(outputTimeAt(clips, player.time))} / ${total}`
      if (text !== last && timeRef.current) {
        last = text
        timeRef.current.textContent = text
      }
    }
    render()
    return player.subscribe(render)
  }, [clips, player])

  return (
    <div className="transport">
      <button className="btn round" onClick={onTogglePlay} title={withShortcut(playing ? 'Pause' : 'Play', keymap.play)} aria-label={playing ? 'Pause' : 'Play'} data-playing={playing}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <span className="timecode" ref={timeRef} title="Position / length of the exported video" />
      <div className="notice-slot" role="status" aria-live="polite">
        {notice && <span className="notice">{notice}</span>}
      </div>
      <div className="tool-group">
        <button className="btn ghost" onClick={onSplit} title={withShortcut('Split the clip at the playhead', keymap.split)}>
          <EditorIcon name="split" size={16} /> Split
        </button>
        <button className="btn ghost" onClick={onAddZoom} title={withShortcut('Add a zoom at the playhead', keymap.addZoom)}>
          <Icon name="zoom" size={16} /> Zoom
        </button>
        <button className="btn ghost" onClick={onAddText} title={withShortcut('Add text at the playhead', keymap.addText)}>
          <EditorIcon name="text" size={16} /> Text
        </button>
      </div>
    </div>
  )
})
