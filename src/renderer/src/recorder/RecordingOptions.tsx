import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react'
import { comboFromKeyEvent, DEFAULT_HOTKEYS, HOTKEY_ACTIONS, HOTKEY_NAMES, hotkeyLabel, type HotkeyAction } from '../../../shared/recording/hotkeys'
import { COUNTDOWN, COUNTDOWN_CHOICES, IDLE_SECONDS, type RecordingSettings, type RecordingSettingsPatch } from '../../../shared/recording/settings'
import type { RecorderError } from '../../../shared/recording/errors'
import { previewCamera } from './devices'
import './presets.css'

/** Names in the narrow hotkey list (the full names are in the tooltips and messages). */
const SHORT_NAMES: Record<HotkeyAction, string> = { stop: 'Stop', pause: 'Pause', mark: 'Zoom here' }
const HOTKEY_HELP: Record<HotkeyAction, string> = {
  stop: 'Stops the recording.',
  pause: 'Pauses the recording, and resumes it when pressed again.',
  mark: 'Marks the moment for auto zoom: a zoom on the cursor right there.'
}

/** A hotkey as keycaps: "Ctrl + Shift + 2" → Ctrl Shift 2. */
export function Keys({ label }: { label: string }): JSX.Element {
  return (
    <span className="keys">
      {label.split(' + ').map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  )
}

/**
 * Live, mirrored preview of the selected camera, at a small size. Mounted only while Home is
 * visible and idle with a camera selected; unmounting (or `release`) frees the camera at once.
 */
export function CameraPreview({
  deviceId,
  release,
  onProblem
}: {
  deviceId: string
  /** Set to a function that frees the camera now (called before a recording opens it). */
  release: MutableRefObject<(() => void) | null>
  onProblem: (err: RecorderError | null) => void
}): JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const v = video.current
    if (!v) return
    setLive(false)
    setFailed(false)
    onProblem(null)
    const stop = previewCamera(deviceId, v, () => setLive(true), (err) => {
      setFailed(true)
      onProblem(err)
    })
    release.current = stop
    return () => {
      stop()
      if (release.current === stop) release.current = null
    }
  }, [deviceId, release, onProblem])
  return (
    <div className={`camera-preview ${live ? 'live' : ''}`}>
      <video ref={video} muted playsInline aria-label="Camera preview" />
      {!live && <span className="camera-preview-wait">{failed ? 'No camera picture' : 'Starting camera…'}</span>}
    </div>
  )
}

/** Click, then press the keys: a hotkey field with validation messages from the caller. */
function HotkeyField({
  action,
  value,
  disabled,
  onSet
}: {
  action: HotkeyAction
  value: string
  disabled: boolean
  /** Saves the hotkey ('' = none); resolves to an error message, or null when saved. */
  onSet: (accelerator: string) => Promise<string | null>
}): JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const name = HOTKEY_NAMES[action]

  const commit = async (accelerator: string): Promise<void> => {
    setCapturing(false)
    setPartial('')
    setBusy(true)
    const message = await onSet(accelerator)
    setBusy(false)
    setError(message)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    const mods = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey
    if (e.key === 'Escape' && !mods) {
      setCapturing(false)
      setPartial('')
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mods) {
      void commit('')
      return
    }
    const combo = comboFromKeyEvent(e)
    if (combo.accelerator) void commit(combo.accelerator)
    else setPartial(combo.label)
  }

  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (capturing && !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) setPartial('')
  }

  const label = value ? hotkeyLabel(value) : ''
  return (
    <div className={`hotkey ${error ? 'invalid' : ''}`} data-action={action}>
      <div className="hotkey-row">
        <span className="hotkey-name" title={HOTKEY_HELP[action]}>
          {SHORT_NAMES[action]}
        </span>
        <button
          type="button"
          className={`hotkey-field ${capturing ? 'capturing' : ''}`}
          disabled={disabled || busy}
          aria-label={`${name} hotkey`}
          title={capturing ? 'Press the new keys · Esc cancels · Backspace removes the hotkey' : 'Click to change'}
          onClick={() => {
            setError(null)
            setCapturing((c) => !c)
            setPartial('')
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            setCapturing(false)
            setPartial('')
          }}
        >
          {capturing ? <span className="hotkey-prompt">{partial || 'Press keys…'}</span> : label ? <Keys label={label} /> : <span className="muted">None</span>}
        </button>
        <button
          type="button"
          className="hotkey-reset"
          title={`Reset to ${hotkeyLabel(DEFAULT_HOTKEYS[action])}`}
          aria-label={`Reset ${name} hotkey`}
          disabled={disabled || busy || value === DEFAULT_HOTKEYS[action]}
          onClick={() => void commit(DEFAULT_HOTKEYS[action])}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 12a8 8 0 1 0 2.3-5.7M4 5v5h5" />
          </svg>
        </button>
      </div>
      {error && (
        <span className="hotkey-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={`chevron ${open ? 'open' : ''}`}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/** Short summary of the options, shown while they are folded. */
export function optionsSummary(s: RecordingSettings, isWindows: boolean): string {
  const parts = [`${s.fps} fps`]
  if (s.countdown !== COUNTDOWN.default) parts.push(s.countdown ? `${s.countdown} s countdown` : 'no countdown')
  if (s.autoPause) parts.push(`auto-pause ${s.idleSeconds} s`)
  if (s.hideDesktopIcons && isWindows) parts.push('no desktop icons')
  return parts.join(' · ')
}

const COUNTDOWN_TITLE = (n: number): string => (n === 0 ? 'Start recording at once' : `Count down ${n} seconds before recording starts`)

/** Frame rate, countdown, desktop icons, auto-pause and hotkeys: saved at once in the app settings. */
export function RecordingOptions({
  settings,
  open,
  onToggle,
  onChange,
  onHotkey,
  disabled,
  isWindows
}: {
  settings: RecordingSettings
  open: boolean
  onToggle: () => void
  onChange: (patch: RecordingSettingsPatch) => void
  onHotkey: (action: HotkeyAction, accelerator: string) => Promise<string | null>
  disabled: boolean
  isWindows: boolean
}): JSX.Element {
  const section = useRef<HTMLElement>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    // Opening shows the whole section (the panel may need to scroll for it).
    if (open && !wasOpen.current) section.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    wasOpen.current = open
  }, [open])
  return (
    <section ref={section} className={`rec-options ${open ? 'open' : ''}`}>
      <button type="button" className="rec-options-head" aria-expanded={open} onClick={onToggle}>
        <Chevron open={open} />
        <span>Recording options</span>
        {!open && <span className="rec-options-summary">{optionsSummary(settings, isWindows)}</span>}
      </button>
      {open && (
        <div className="rec-options-body">
          <div className="option-row">
            <span>Frame rate</span>
            <div className="chips" role="group" aria-label="Frame rate">
              {([30, 60] as const).map((fps) => (
                <button
                  key={fps}
                  type="button"
                  className={`chip ${settings.fps === fps ? 'active' : ''}`}
                  aria-pressed={settings.fps === fps}
                  disabled={disabled}
                  title={fps === 30 ? 'Lighter: half the frames to capture, encode and edit' : 'Smoothest motion'}
                  onClick={() => onChange({ fps })}
                >
                  {fps} fps
                </button>
              ))}
            </div>
          </div>
          <div className="option-row">
            <span>Countdown</span>
            <div className="chips" role="group" aria-label="Countdown">
              {COUNTDOWN_CHOICES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${settings.countdown === n ? 'active' : ''}`}
                  aria-pressed={settings.countdown === n}
                  disabled={disabled}
                  title={COUNTDOWN_TITLE(n)}
                  onClick={() => onChange({ countdown: n })}
                >
                  {n === 0 ? 'Off' : `${n} s`}
                </button>
              ))}
            </div>
          </div>
          <label
            className={`toggle ${!isWindows || disabled ? 'disabled' : ''}`}
            title={isWindows ? 'Hides the icons on your desktop while recording and brings them back afterwards.' : 'Windows only'}
          >
            <span>Hide desktop icons</span>
            <input
              type="checkbox"
              aria-label="Hide desktop icons"
              checked={settings.hideDesktopIcons && isWindows}
              disabled={!isWindows || disabled}
              onChange={(e) => onChange({ hideDesktopIcons: e.target.checked })}
            />
          </label>
          <label className={`toggle ${disabled ? 'disabled' : ''}`} title="Pauses when you leave the mouse and keyboard alone, and resumes as soon as you continue.">
            <span>Auto-pause when idle</span>
            <input type="checkbox" aria-label="Auto-pause when idle" checked={settings.autoPause} disabled={disabled} onChange={(e) => onChange({ autoPause: e.target.checked })} />
          </label>
          {settings.autoPause && (
            <label className="slider idle-slider">
              <span className="slider-head">
                <span>Pause after</span>
                <span className="muted">{settings.idleSeconds} s without input</span>
              </span>
              <input
                type="range"
                aria-label="Seconds without input before pausing"
                min={IDLE_SECONDS.min}
                max={60}
                step={1}
                value={Math.min(60, settings.idleSeconds)}
                disabled={disabled}
                onChange={(e) => onChange({ idleSeconds: Number(e.target.value) })}
              />
            </label>
          )}
          <div className="hotkeys" role="group" aria-label="Hotkeys while recording">
            <span className="option-label">Hotkeys while recording</span>
            {HOTKEY_ACTIONS.map((action) => (
              <HotkeyField key={action} action={action} value={settings.hotkeys[action]} disabled={disabled} onSet={(a) => onHotkey(action, a)} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
