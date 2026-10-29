import { memo, useEffect, useRef, useSyncExternalStore } from 'react'
import { withShortcut } from '../../../shared/editor/shortcuts'
import { planOf, videoDuration, videoTimeAt } from '../../../shared/engine/freeze'
import { formatTime } from '../../../shared/engine/project'
import { SAFE_ZONES, type SafeChoice, type SafePlatform } from '../../../shared/render/safeZones'
import type { Clip, Freeze } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { useKeymap } from './keymapContext'
import { PreviewSpeedControl } from './PreviewSpeed'
import { setSafeZoneChoice, toggleSafeZones, useSafeZoneChoice } from './safeZonePref'
import './safeZones.css'

interface Props {
  clips: Clip[]
  /** Freeze frames (E-11): pause ones make the video longer. */
  freezes?: Freeze[]
  notice: string | null
  /** A button in the notice (Open original after a copy), and whether the notice is an error (role alert). */
  noticeAction?: { label: string; run: () => void } | null
  noticeAlert?: boolean
  /** A notice with a button stays while the pointer is over it or focus is in it (true), then shows for its time again (false). */
  onNoticeHold?: (held: boolean) => void
  /** The frame is tall (9:16 and the like): the safe-zone toggle shows (docs/design/vertical-video.md §2.8). */
  tall?: boolean
  onTogglePlay: () => void
  onSplit: () => void
  onAddZoom: () => void
  onAddText: () => void
}

/**
 * The notice under the preview. Only its message gives way (an ellipsis, the whole text in its
 * title): the button after it (Open original) stays whole, so it can be seen and pressed in a
 * narrow transport row (a 9:16 frame adds the safe-zone control). A notice with a button reports
 * the pointer over it and focus in it through `onHold`, so it does not go while being used.
 */
export function TransportNotice({ text, action, alert, onHold }: { text: string; action?: Props['noticeAction']; alert?: boolean; onHold?: Props['onNoticeHold'] }): JSX.Element {
  const hold = action && onHold
  return (
    <span
      className={action ? 'notice has-action' : 'notice'}
      role={alert ? 'alert' : undefined}
      onMouseEnter={hold ? () => onHold(true) : undefined}
      onMouseLeave={
        hold
          ? (e) => {
              if (!e.currentTarget.contains(document.activeElement)) onHold(false)
            }
          : undefined
      }
      onFocus={hold ? () => onHold(true) : undefined}
      onBlur={
        hold
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover')) onHold(false)
            }
          : undefined
      }
    >
      <span className="notice-text" title={text}>
        {text}
      </span>
      {action && (
        <button className="link" onClick={action.run}>
          {action.label}
        </button>
      )}
    </span>
  )
}

export function usePlaying(): boolean {
  const { player } = useEditor()
  return useSyncExternalStore(player.subscribe, player.getPlaying)
}

/**
 * Play button, output timecode and edit tools. The timecode is written straight
 * to the DOM from the player, so playback never re-renders React components.
 */
export const Transport = memo(function Transport({ clips, freezes, notice, noticeAction, noticeAlert, onNoticeHold, tall, onTogglePlay, onSplit, onAddZoom, onAddText }: Props): JSX.Element {
  const { player } = useEditor()
  const keymap = useKeymap()
  const playing = usePlaying()
  const timeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let last = ''
    // In seconds of the exported video: a pause freeze adds its time, and counts while the preview holds it.
    const plan = planOf({ clips, freezes })
    const total = formatTime(videoDuration(clips, plan))
    const render = (): void => {
      const text = `${formatTime(videoTimeAt(clips, plan, player.time) + player.holdElapsed)} / ${total}`
      if (text !== last && timeRef.current) {
        last = text
        timeRef.current.textContent = text
      }
    }
    render()
    return player.subscribe(render)
  }, [clips, freezes, player])

  return (
    <>
      {tall && <SafeZonesLegend />}
      <div className="transport">
        <button className="btn round" onClick={onTogglePlay} title={withShortcut(playing ? 'Pause' : 'Play', keymap.play)} aria-label={playing ? 'Pause' : 'Play'} data-playing={playing}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <span className="timecode" ref={timeRef} title="Position / length of the exported video" />
        <PreviewSpeedControl />
        {tall && <SafeZonesControl />}
        <div className="notice-slot" role="status" aria-live="polite">
          {notice && <TransportNotice text={notice} action={noticeAction} alert={noticeAlert} onHold={onNoticeHold} />}
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
    </>
  )
})

/** The apps of the safe-zone menu, All three first. */
const PLATFORM_CHOICES: { value: SafeChoice; label: string }[] = [
  { value: 'all', label: 'All three' },
  ...(Object.keys(SAFE_ZONES) as SafePlatform[]).map((p) => ({ value: p, label: SAFE_ZONES[p].name }))
]

/** A phone, for the safe-zone toggle. */
function PhoneIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2" />
    </svg>
  )
}

/**
 * The safe-zone toggle (G) and, while it is on, which app's zones to shade (docs/design/vertical-video.md
 * §2.8). A view preference (safeZonePref.ts), never an edit.
 */
function SafeZonesControl(): JSX.Element {
  const keymap = useKeymap()
  const choice = useSafeZoneChoice()
  const on = choice !== 'off'
  // Whether the app menu is being used with the pointer (it then hands the editor's keys back).
  const byPointer = useRef(false)
  return (
    <span className="safe-zones-control">
      <button
        className="btn ghost"
        data-testid="safe-zones-toggle"
        aria-pressed={on}
        onClick={toggleSafeZones}
        title={withShortcut('Show where TikTok, Reels and Shorts put their buttons and captions', keymap.toggleSafeZones)}
      >
        <PhoneIcon /> Safe zones
      </button>
      {on && (
        <select
          data-testid="safe-zones-platform"
          aria-label="Safe zones of"
          value={choice}
          onPointerDown={() => (byPointer.current = true)}
          onKeyDown={() => (byPointer.current = false)}
          onChange={(e) => {
            setSafeZoneChoice(e.target.value as SafeChoice)
            // A focused select is a text field to the editor's shortcuts: picked with the pointer it gives
            // G, Space, J, K and L back; from the keyboard it keeps the focus, so the arrows go on choosing.
            if (byPointer.current) e.currentTarget.blur()
          }}
        >
          {PLATFORM_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

/** What the shading means, under the preview while it is shown. */
function SafeZonesLegend(): JSX.Element | null {
  const choice = useSafeZoneChoice()
  if (choice === 'off') return null
  return (
    <p className="safe-zones-legend" data-testid="safe-zones-legend">
      Shaded parts are covered by the apps' buttons and captions. Shown only here, never exported. The apps move them from time to time, so leave a little room.
    </p>
  )
}
