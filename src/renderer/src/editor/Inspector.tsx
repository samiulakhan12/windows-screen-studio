import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ANNOTATION_SIZE } from '../../../shared/editor/annotations'
import { saveErrorMessage } from '../../../shared/editor/autosave'
import { setRangeSpeed, timelineGaps, type Gap } from '../../../shared/editor/clips'
import { ASPECT_RATIOS, CORNERS, LOOK_LIMITS, lookOf } from '../../../shared/editor/styleDefaults'
import { outputDuration, SPEED_PRESETS } from '../../../shared/engine/timeline'
import { GRADIENTS, gradientCss } from '../../../shared/engine/backgrounds'
import { formatTime } from '../../../shared/engine/project'
import { isUsableClick, regenerateAutoZooms } from '../../../shared/engine/zoom'
import type { AnnotationStyle, CursorTrack, Project, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { Chips, pctFmt, Section, Slider, Toggle } from './controls'
import { EditorIcon } from './EditorIcon'
import type { Selection } from './selection'

export interface InspectorProps {
  project: Project
  selection: Selection
  /** Increments whenever the user selects something, to reveal its settings again. */
  revealSeq: number
  onSelect: (sel: Selection) => void
  cursor: CursorTrack
  hasWebcam: boolean
  pickFocus: boolean
  onPickFocus: (on: boolean) => void
  /** Where a cursor-following zoom currently looks, so switching it to a fixed point keeps the view. */
  focusFor: (zoom: ZoomSegment) => { x: number; y: number }
  onBackgroundImage: () => void
  onNotice: (message: string) => void
  onAddText: () => void
  onSplit: () => void
  onDeleteClip: (id: string) => void
  onRestore: (start: number, end: number) => void
  onCutRange: (start: number, end: number) => void
}

type Tab = 'style' | 'cursor' | 'zoom' | 'clip' | 'text' | 'effects' | 'camera' | 'audio'

const TABS: { id: Tab; label: string; icon: string; editorIcon?: boolean }[] = [
  { id: 'style', label: 'Style', icon: 'palette' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom' },
  { id: 'clip', label: 'Clip', icon: 'scissors', editorIcon: true },
  { id: 'text', label: 'Text', icon: 'text', editorIcon: true },
  { id: 'effects', label: 'Effects', icon: 'sparkle', editorIcon: true },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'audio', label: 'Audio', icon: 'volume', editorIcon: true }
]

const TAB_FOR: Record<NonNullable<Selection>['kind'], Tab> = { zoom: 'zoom', annotation: 'text', clip: 'clip', gap: 'clip', range: 'clip' }

const GAP_TITLE: Record<Gap['kind'], string> = { 'trim-start': 'Trimmed start', cut: 'Cut', 'trim-end': 'Trimmed end' }
const L = LOOK_LIMITS

export const Inspector = memo(function Inspector(props: InspectorProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('style')
  const selKind = props.selection?.kind ?? null

  // Selecting something (even the already selected item) reveals its settings.
  // Keyed on the selection counter only, so undo or deselecting never switches tabs.
  // A layout effect, so the old tab is never painted for a frame first.
  const revealKind = useRef(selKind)
  revealKind.current = selKind
  useLayoutEffect(() => {
    if (revealKind.current) setTab(TAB_FOR[revealKind.current])
  }, [props.revealSeq])

  return (
    <aside className="inspector">
      <nav className="insp-tabs" aria-label="Inspector">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-pressed={tab === t.id} title={t.label}>
            {t.editorIcon ? <EditorIcon name={t.icon} size={17} /> : <Icon name={t.icon} size={17} />}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="insp-body" data-tab={tab}>
        {tab === 'style' && <StylePanel project={props.project} onBackgroundImage={props.onBackgroundImage} onNotice={props.onNotice} />}
        {tab === 'cursor' && <CursorPanel project={props.project} cursor={props.cursor} />}
        {tab === 'zoom' && <ZoomPanel {...props} />}
        {tab === 'clip' && <ClipPanel {...props} />}
        {tab === 'text' && <TextPanel {...props} />}
        {tab === 'effects' && <EffectsPanel project={props.project} cursor={props.cursor} />}
        {tab === 'camera' && <CameraPanel project={props.project} hasWebcam={props.hasWebcam} />}
        {tab === 'audio' && <AudioPanel project={props.project} />}
      </div>
    </aside>
  )
})

/* ---------- Style ---------- */

function StylePanel({ project, onBackgroundImage, onNotice }: { project: Project; onBackgroundImage: () => void; onNotice: (message: string) => void }): JSX.Element {
  const { store } = useEditor()
  const { style } = project
  const setStyle = (patch: Partial<Project['style']>, key?: string): void => store.update((p) => ({ ...p, style: { ...p.style, ...patch } }), key)
  return (
    <>
      <Section title="Frame">
        <Chips label="Aspect ratio" value={style.aspectRatio} onChange={(a) => setStyle({ aspectRatio: a })} options={ASPECT_RATIOS.map((a) => ({ value: a, label: a === 'auto' ? 'Auto' : a }))} />
      </Section>
      <Section title="Background">
        <div className="swatches">
          {GRADIENTS.map((g) => (
            <button
              key={g.id}
              title={g.name}
              aria-label={`${g.name} background`}
              className={`swatch ${style.background.type === 'gradient' && style.background.preset === g.id ? 'active' : ''}`}
              style={{ background: gradientCss(g) }}
              onClick={() => setStyle({ background: { type: 'gradient', preset: g.id } })}
            />
          ))}
        </div>
        <div className="row">
          <label className="color-field">
            <input
              type="color"
              value={style.background.type === 'color' ? style.background.color : '#1f2937'}
              onChange={(e) => setStyle({ background: { type: 'color', color: e.target.value } }, 'style.color')}
            />
            Solid colour
          </label>
          <button className={`btn ghost ${style.background.type === 'image' ? 'active' : ''}`} onClick={onBackgroundImage}>
            <Icon name="image" size={16} /> Image…
          </button>
        </div>
      </Section>
      <Section title="Layout">
        <Slider label="Padding" value={style.padding} {...L.padding} step={0.005} format={pctFmt} onChange={(v) => setStyle({ padding: v }, 'style.padding')} />
        <Slider label="Corner radius" value={style.cornerRadius} {...L.cornerRadius} step={1} format={(v) => `${v}px`} onChange={(v) => setStyle({ cornerRadius: v }, 'style.radius')} />
        <Slider label="Shadow" value={style.shadow} {...L.shadow} step={0.05} format={pctFmt} onChange={(v) => setStyle({ shadow: v }, 'style.shadow')} />
      </Section>
      <StyleDefaultsSection project={project} onNotice={onNotice} />
    </>
  )
}

/** Saves this project's look (style, cursor, camera, effects) as the start of every new recording. */
function StyleDefaultsSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  // null while unknown (the saved state is read once when the Style tab opens).
  const [saved, setSaved] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    window.api
      .getStyleDefaults()
      .then((d) => live && setSaved(!!d))
      .catch(() => live && setSaved(false))
    return () => {
      live = false
    }
  }, [])

  const run = async (action: () => Promise<string>, failure: string): Promise<void> => {
    setBusy(true)
    try {
      onNotice(await action())
    } catch (err) {
      onNotice(`${failure}: ${saveErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await window.api.saveStyleDefaults(lookOf(project))
      setSaved(true)
      return project.style.background.type === 'image' ? 'Saved as default (image backgrounds are not included)' : 'Saved as default for new recordings'
    }, 'Could not save the defaults')

  const reset = (): Promise<void> =>
    run(async () => {
      await window.api.resetStyleDefaults()
      setSaved(false)
      return 'Defaults reset: new recordings use the built-in look'
    }, 'Could not reset the defaults')

  return (
    <Section title="New recordings">
      <p className="hint" data-testid="style-defaults-state">
        {saved
          ? 'New recordings start with your saved look: background, layout, cursor, camera and effects.'
          : 'New recordings start with the built-in look. Save this one to use it for every new recording.'}
      </p>
      <div className="defaults-actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={16} /> Save as default for new recordings
        </button>
        <button className="btn ghost" disabled={busy || !saved} onClick={() => void reset()} title={saved ? 'Go back to the built-in look for new recordings' : 'No defaults are saved'}>
          <Icon name="refresh" size={16} /> Reset defaults
        </button>
      </div>
    </Section>
  )
}

/* ---------- Cursor ---------- */

function CursorPanel({ project, cursor: track }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const { cursor } = project
  const set = (patch: Partial<Project['cursor']>, key?: string): void => store.update((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }), key)
  const inVideo = project.capture.cursorInVideo
  const isWindow = project.capture.target === 'window'
  // A drawn cursor only makes sense when the real one is not already in the pixels.
  const smoothAvailable = track.valid && !inVideo
  const smoothOn = smoothAvailable && cursor.show
  return (
    <>
      {!track.valid ? (
        <p className="callout" data-testid="cursor-not-recorded">
          <EditorIcon name="alert" size={16} />
          <span>
            {isWindow
              ? 'Cursor movement was not recorded for this window (its position on screen could not be followed), so cursor effects are not available.'
              : 'Cursor movement was not recorded for this capture, so cursor effects are not available.'}
          </span>
        </p>
      ) : inVideo ? (
        <p className="callout" data-testid="cursor-in-video">
          <EditorIcon name="alert" size={16} />
          <span>
            {isWindow
              ? 'The Windows cursor is part of this video (the window was recorded with standard capture, which includes it), so a smooth cursor would show up as a second cursor. '
              : 'The Windows cursor is part of this video (it was recorded with screen capture), so a smooth cursor would show up as a second cursor. '}
            Smooth cursor and hide-when-idle are therefore off. Click highlights {isWindow ? 'and auto zoom still work' : 'still work on top of the recorded cursor'}.
          </span>
        </p>
      ) : null}
      <Section title="Click highlight">
        <Toggle label="Click effect" checked={track.valid && cursor.clickEffect} disabled={!track.valid} onChange={(v) => set({ clickEffect: v })} />
      </Section>
      <Section title="Smooth cursor">
        <Toggle
          label="Show smooth cursor"
          checked={smoothOn}
          disabled={!smoothAvailable}
          title={smoothAvailable ? undefined : 'Not available: the recorded cursor is in the video'}
          onChange={(v) => set({ show: v })}
        />
        <Slider label="Size" value={cursor.size} {...L.cursorSize} step={0.05} format={(v) => `${v.toFixed(2)}×`} disabled={!smoothOn} onChange={(v) => set({ size: v }, 'cursor.size')} />
        <Slider label="Smoothing" value={cursor.smoothing} {...L.smoothing} step={0.05} format={pctFmt} disabled={!smoothOn} onChange={(v) => set({ smoothing: v }, 'cursor.smoothing')} />
        <Toggle label="Hide when idle" checked={smoothOn && cursor.hideWhenIdle} disabled={!smoothOn} onChange={(v) => set({ hideWhenIdle: v })} />
      </Section>
    </>
  )
}

/* ---------- Zoom ---------- */

function ZoomPanel(props: InspectorProps): JSX.Element {
  const { store, player } = useEditor()
  const { project, selection } = props
  const zoom = selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id) ?? null) : null
  const clicks = props.cursor.clicks.filter(isUsableClick)
  const cursorValid = props.cursor.valid
  const autoCount = project.zooms.filter((z) => z.auto).length

  const setZoom = (patch: Partial<ZoomSegment>, key?: string): void => {
    if (!zoom) return
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === zoom.id ? { ...z, ...patch, auto: false } : z)) }), key)
  }

  const regenerate = (): void => {
    const r = regenerateAutoZooms(project.zooms, props.cursor.clicks, project.duration)
    store.update((p) => ({ ...p, autoZoom: true, zooms: r.zooms }))
    props.onNotice(`Auto zoom: ${r.added} zoom${r.added === 1 ? '' : 's'} from clicks${r.kept ? `, ${r.kept} edited kept` : ''}`)
  }

  const removeAll = (): void => {
    const n = project.zooms.length
    store.update((p) => ({ ...p, zooms: [] }))
    props.onNotice(`Removed ${n} zoom${n === 1 ? '' : 's'} · Ctrl+Z to undo`)
  }

  return (
    <>
      <Section title="Auto zoom">
        <p className="hint">
          {clicks.length > 0
            ? `${clicks.length} click${clicks.length === 1 ? '' : 's'} detected. Regenerating replaces the ${autoCount} automatic zoom${autoCount === 1 ? '' : 's'}; zooms you added or edited are kept.`
            : 'No clicks were captured, so add zooms yourself: press Z or double-click the zoom track.'}
        </p>
        <div className="row start">
          <button className="btn" disabled={clicks.length === 0} onClick={regenerate}>
            <Icon name="refresh" size={16} /> Regenerate
          </button>
          <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={removeAll}>
            <Icon name="trash" size={16} /> Remove all
          </button>
        </div>
      </Section>
      {zoom ? (
        <Section title="Selected zoom" aside={<span className="muted small">{zoom.auto ? 'automatic' : 'edited'}</span>}>
          <p className="hint">
            {formatTime(zoom.start)} – {formatTime(zoom.end)}
          </p>
          <Slider label="Zoom level" value={zoom.scale} min={1.1} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setZoom({ scale: v }, `zoom-scale:${zoom.id}`)} />
          <Chips
            label="Zoom focus"
            value={zoom.focus.mode === 'cursor' && cursorValid ? 'cursor' : zoom.focus.mode === 'fixed' ? 'fixed' : null}
            onChange={(mode) => {
              if (mode === 'cursor') {
                setZoom({ focus: { mode: 'cursor' } })
                props.onPickFocus(false)
              } else if (zoom.focus.mode !== 'fixed') {
                // Keep looking where the zoom looks now instead of jumping to the centre.
                const f = props.focusFor(zoom)
                setZoom({ focus: { mode: 'fixed', x: f.x, y: f.y } })
              }
            }}
            options={[
              { value: 'cursor', label: 'Follow cursor', disabled: !cursorValid, title: cursorValid ? undefined : 'No cursor data in this recording' },
              { value: 'fixed', label: 'Fixed point' }
            ]}
          />
          {zoom.focus.mode === 'fixed' && (
            <>
              <button
                className={`btn ${props.pickFocus ? 'primary' : ''}`}
                onClick={() => {
                  if (!props.pickFocus && (player.time < zoom.start || player.time >= zoom.end)) player.seek((zoom.start + zoom.end) / 2)
                  props.onPickFocus(!props.pickFocus)
                }}
                aria-pressed={props.pickFocus}
              >
                <EditorIcon name="crosshair" size={16} /> {props.pickFocus ? 'Done picking' : 'Pick on preview'}
              </button>
              <Slider label="Focus X" value={zoom.focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: v, y: (zoom.focus as { y: number }).y } }, `zoom-focus:${zoom.id}`)} />
              <Slider label="Focus Y" value={zoom.focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: (zoom.focus as { x: number }).x, y: v } }, `zoom-focus:${zoom.id}`)} />
            </>
          )}
          <button
            className="btn ghost danger"
            onClick={() => {
              store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== zoom.id) }))
              props.onSelect(null)
            }}
          >
            <Icon name="trash" size={16} /> Delete zoom
          </button>
        </Section>
      ) : (
        <p className="hint">Select a zoom on the timeline to edit it, or press Z to add one at the playhead.</p>
      )}
    </>
  )
}

/* ---------- Clip (cuts, trims, speed) ---------- */

function ClipPanel(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const { project, selection } = props
  const { clips } = project
  const length = outputDuration(clips)
  const clipIndex = selection?.kind === 'clip' ? clips.findIndex((c) => c.id === selection.id) : -1
  const clip = clipIndex >= 0 ? clips[clipIndex] : null
  const edited = clips.length > 1 || clips[0].start > 0 || clips[0].end < project.duration || clips[0].speed !== 1

  const setSpeed = (speed: number): void => {
    if (!clip) return
    store.update((p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? { ...c, speed } : c)) }))
  }

  return (
    <>
      <p className="hint">
        Video length <strong>{formatTime(length)}</strong> of {formatTime(project.duration)} recorded.
      </p>
      {clip ? (
        <Section title={`Clip ${clipIndex + 1} of ${clips.length}`}>
          <p className="hint">
            {formatTime(clip.start)} – {formatTime(clip.end)} of the recording, plays for {((clip.end - clip.start) / clip.speed).toFixed(1)} s
          </p>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> Speed
          </span>
          <Chips label="Clip speed" value={clip.speed} onChange={setSpeed} options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))} />
          <button className="btn ghost danger" disabled={clips.length <= 1} onClick={() => props.onDeleteClip(clip.id)} title={clips.length <= 1 ? 'The last clip cannot be removed' : 'Cut this clip out of the video (Delete)'}>
            <EditorIcon name="scissors" size={16} /> Delete clip
          </button>
        </Section>
      ) : selection?.kind === 'gap' ? (
        <Section title={GAP_TITLE[timelineGaps(clips, project.duration).find((g) => Math.abs(g.start - selection.start) < 1e-6)?.kind ?? 'cut']}>
          <p className="hint">
            {formatTime(selection.start)} – {formatTime(selection.end)} ({(selection.end - selection.start).toFixed(1)} s) is not in the video.
          </p>
          <button className="btn" onClick={() => props.onRestore(selection.start, selection.end)}>
            <EditorIcon name="restore" size={16} /> Restore
          </button>
        </Section>
      ) : selection?.kind === 'range' ? (
        <Section title="Selected range">
          <p className="hint">
            {formatTime(selection.start)} – {formatTime(selection.end)} ({(selection.end - selection.start).toFixed(1)} s)
          </p>
          <button className="btn" onClick={() => props.onCutRange(selection.start, selection.end)}>
            <EditorIcon name="scissors" size={16} /> Cut range
          </button>
          <span className="field-label">
            <EditorIcon name="speed" size={14} /> Speed up or slow down this range
          </span>
          <Chips
            label="Range speed"
            value={null}
            onChange={(s) => {
              store.update((p) => ({ ...p, clips: setRangeSpeed(p.clips, selection.start, selection.end, s) }))
              props.onSelect(null)
            }}
            options={SPEED_PRESETS.map((s) => ({ value: s, label: `${s}×` }))}
          />
        </Section>
      ) : (
        <Section title="Edit">
          <button className="btn" onClick={props.onSplit}>
            <EditorIcon name="split" size={16} /> Split at playhead
          </button>
          <p className="hint">
            Press <kbd>S</kbd> to split at the playhead, select a clip and press <kbd>Delete</kbd> to cut it, or <kbd>Shift</kbd>+drag on the clip track to select a range. Drag the yellow handles to trim.
          </p>
        </Section>
      )}
      {edited && (
        <button
          className="btn ghost"
          onClick={() => {
            store.update((p) => ({ ...p, clips: [{ id: p.clips[0].id, start: 0, end: p.duration, speed: 1 }] }))
            props.onSelect(null)
          }}
        >
          <EditorIcon name="restore" size={16} /> Restore the whole recording
        </button>
      )}
    </>
  )
}

/* ---------- Text ---------- */

function TextPanel(props: InspectorProps): JSX.Element {
  const { store, player } = useEditor()
  const { project, selection } = props
  const ann = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null
  const set = (patch: Partial<(typeof project.annotations)[number]>, key?: string): void => {
    if (!ann) return
    store.update((p) => ({ ...p, annotations: p.annotations.map((a) => (a.id === ann.id ? { ...a, ...patch } : a)) }), key)
  }

  if (!ann) {
    return (
      <>
        <Section title="Text">
          <button className="btn" onClick={props.onAddText}>
            <EditorIcon name="text" size={16} /> Add text at playhead
          </button>
          <p className="hint">
            Press <kbd>T</kbd> or double-click the text track. Drag a text item on the timeline to change when it shows, and on the preview to move it.
          </p>
        </Section>
        {project.annotations.length > 0 && (
          <Section title={`In this video (${project.annotations.length})`}>
            <ul className="item-list">
              {[...project.annotations]
                .sort((a, b) => a.start - b.start)
                .slice(0, 100)
                .map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => {
                        props.onSelect({ kind: 'annotation', id: a.id })
                        player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
                      }}
                    >
                      <span className="muted">{formatTime(a.start, false)}</span> {a.text || 'Text'}
                    </button>
                  </li>
                ))}
            </ul>
          </Section>
        )}
      </>
    )
  }

  return (
    <Section title="Selected text" aside={<span className="muted small">{formatTime(ann.start)} – {formatTime(ann.end)}</span>}>
      <label className="field">
        <span>Text</span>
        <textarea className="text-field" rows={2} value={ann.text} onChange={(e) => set({ text: e.target.value }, `annotation-text:${ann.id}`)} placeholder="Type your text" />
      </label>
      <Chips<AnnotationStyle>
        label="Text style"
        value={ann.style}
        onChange={(style) => set({ style })}
        options={[
          { value: 'pill', label: 'Caption pill' },
          { value: 'title', label: 'Title' }
        ]}
      />
      <Slider label="Size" value={ann.size} min={ANNOTATION_SIZE.min} max={ANNOTATION_SIZE.max} step={0.002} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => set({ size: v }, `annotation-size:${ann.id}`)} />
      <Slider label="Position X" value={ann.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `annotation-pos:${ann.id}`)} />
      <Slider label="Position Y" value={ann.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `annotation-pos:${ann.id}`)} />
      <p className="hint">Tip: drag the text on the preview to place it.</p>
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== ann.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> Delete text
      </button>
    </Section>
  )
}

/* ---------- Effects ---------- */

function EffectsPanel({ project, cursor }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const { effects } = project
  const keys = cursor.keys?.length ?? 0
  const setKeys = (patch: Partial<Project['effects']['keystrokes']>, key?: string): void =>
    store.update((p) => ({ ...p, effects: { ...p.effects, keystrokes: { ...p.effects.keystrokes, ...patch } } }), key)
  return (
    <>
      <Section title="Motion blur">
        <Slider
          label="Strength"
          value={effects.motionBlur}
          {...L.motionBlur}
          step={0.05}
          format={(v) => (v === 0 ? 'Off' : pctFmt(v))}
          onChange={(v) => store.update((p) => ({ ...p, effects: { ...p.effects, motionBlur: v } }), 'effects.motionBlur')}
        />
        <p className="hint">Blurs fast zoom and pan movements, like a real camera.</p>
      </Section>
      <Section title="Keyboard shortcuts">
        <p className="hint">
          {keys > 0 ? `${keys} shortcut${keys === 1 ? '' : 's'} recorded (plain typing is never recorded).` : 'No keyboard shortcuts were recorded in this video.'}
        </p>
        <Toggle label="Show shortcuts on screen" checked={effects.keystrokes.show} onChange={(v) => setKeys({ show: v })} />
        <Chips
          label="Shortcut position"
          value={effects.keystrokes.position}
          disabled={!effects.keystrokes.show}
          onChange={(position) => setKeys({ position })}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'top', label: 'Top' }
          ]}
        />
        <Slider label="Size" value={effects.keystrokes.size} {...L.keystrokeSize} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} disabled={!effects.keystrokes.show} onChange={(v) => setKeys({ size: v }, 'effects.keys.size')} />
      </Section>
    </>
  )
}

/* ---------- Camera ---------- */

function CameraPanel({ project, hasWebcam }: { project: Project; hasWebcam: boolean }): JSX.Element {
  const { store } = useEditor()
  const { webcam } = project
  const set = (patch: Partial<Project['webcam']>, key?: string): void => store.update((p) => ({ ...p, webcam: { ...p.webcam, ...patch } }), key)
  const off = !hasWebcam || !webcam.show
  return (
    <>
      {!hasWebcam && <p className="hint">This recording has no camera. Pick a camera on the home screen before recording.</p>}
      <Section title="Camera">
        <Toggle label="Show camera" checked={hasWebcam && webcam.show} disabled={!hasWebcam} onChange={(v) => set({ show: v })} />
        <Slider label="Size" value={webcam.size} {...L.webcamSize} step={0.01} format={pctFmt} disabled={off} onChange={(v) => set({ size: v }, 'webcam.size')} />
        <Chips
          label="Camera shape"
          value={webcam.shape}
          disabled={off}
          onChange={(shape) => set({ shape })}
          options={[
            { value: 'circle', label: 'Circle' },
            { value: 'rounded', label: 'Rounded' }
          ]}
        />
        <div className="corner-grid" role="group" aria-label="Camera corner">
          {CORNERS.map((c) => (
            <button key={c} disabled={off} className={`corner ${webcam.corner === c ? 'active' : ''} ${c}`} onClick={() => set({ corner: c })} title={c.replace('-', ' ')} aria-label={c.replace('-', ' ')}>
              <span />
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

/* ---------- Audio ---------- */

function AudioPanel({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const { audio } = project
  const set = (patch: Partial<Project['audio']>, key?: string): void => store.update((p) => ({ ...p, audio: { ...p.audio, ...patch } }), key)
  return (
    <>
      {!project.hasAudio && <p className="hint">This recording has no audio track.</p>}
      <Section title="Audio">
        <Toggle label="Mute" checked={audio.muted} disabled={!project.hasAudio} onChange={(v) => set({ muted: v })} />
        <Slider
          label="Volume"
          value={audio.volume}
          min={0}
          max={2}
          step={0.05}
          format={pctFmt}
          disabled={!project.hasAudio || audio.muted}
          onChange={(v) => set({ volume: v }, 'audio.volume')}
        />
        <p className="hint">Applies to the preview and the exported video. Sped-up clips keep their pitch.</p>
      </Section>
    </>
  )
}
