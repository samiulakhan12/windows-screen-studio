import { isCommandId } from '../../../../shared/editor/commands'
import { setZoomLevelInView } from '../../../../shared/editor/cropEdit'
import { zoomCause } from '../../../../shared/editor/inputEdits'
import type { ClickRow } from '../../../../shared/engine/inputData'
import { scrollBreaks } from '../../../../shared/engine/scroll'
import { orPress, shortcutLabel, undoHint, withShortcut, zoomLevelKeysHint } from '../../../../shared/editor/shortcuts'
import { ZOOM_EASINGS } from '../../../../shared/engine/easing'
import { cropOf, fromCrop, regenerateInFrame, toCrop, zoomFromView, zoomInView } from '../../../../shared/engine/crop'
import { formatTime } from '../../../../shared/engine/project'
import {
  isZoomClick,
  MAX_TRANSITION,
  MIN_TRANSITION,
  zoomEasing,
  zoomSettingsOf,
  zoomStyleOf,
  zoomTargetScale,
  zoomTransition,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE
} from '../../../../shared/engine/zoom'
import {
  clearZoomStyles,
  connectToNext,
  disconnectFromNext,
  formatLevel,
  isConnectedToNext,
  nextZoom,
  regionAround,
  setZoomLevel,
  ZOOM_LEVEL_PRESETS
} from '../../../../shared/editor/zoomEdit'
import type { AutoZoomSettings, CursorTrack, Project, ScrollZoomMode, ZoomEasing, ZoomFocus, ZoomSegment, ZoomSettings } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InputActions, InspectorProps } from '../Inspector'
import { autoZoomFoundText, clickKind, clickState, STRAY_REASON_TEXT, usedClickText } from '../selection'
import { useKeymap } from '../keymapContext'
import { ShortcutKeys } from '../ShortcutKeys'
import '../zoom.css'

const secFmt = (v: number): string => `${v.toFixed(2)} s`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Recorded input auto zoom can use, given its settings: the recorded clicks it can zoom for
 * (`clicks`, ignored ones included, and how many of them are `ignored`), typing, marks and the
 * long scrolls it zooms out for.
 */
function inputSummary(
  track: CursorTrack,
  rows: readonly ClickRow[],
  auto: AutoZoomSettings
): { clicks: number; ignored: number; typing: number; marks: number; scrolls: number } {
  const zoomRows = rows.filter((r) => isZoomClick(r.click, auto.rightClicks))
  return {
    clicks: zoomRows.length,
    ignored: zoomRows.filter((r) => r.ignored).length,
    scrolls: track.valid ? scrollBreaks(track, auto).length : 0,
    // Typing zooms aim at clicks or the cursor, so they need cursor data; marks do not.
    typing: track.valid ? (track.typing?.length ?? 0) : 0,
    marks: track.marks?.length ?? 0
  }
}

/* ---------- Zoom ---------- */

export function ZoomPanel(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const keymap = useKeymap()
  const zoom = selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id) ?? null) : null
  const click = selection?.kind === 'click' ? (props.clickRows.find((r) => r.ms === selection.ms) ?? null) : null
  const levelKeys = zoomLevelKeysHint(keymap)
  return (
    <>
      {zoom ? (
        <SelectedZoom {...props} zoom={zoom} />
      ) : click ? (
        <SelectedClick row={click} input={props.input} rightClicks={zoomSettingsOf(project).auto.rightClicks} />
      ) : (
        <p className="hint">
          Select a zoom on the timeline to edit it{keymap.addZoom[0] ? `, or press ${shortcutLabel(keymap.addZoom[0])} to add one at the playhead` : ''}.
          {levelKeys ? ` With a zoom selected, ${levelKeys}.` : ''}
        </p>
      )}
      <ZoomStyleSection project={project} onNotice={props.onNotice} />
      <AutoZoomSection
        project={project}
        cursor={props.cursor}
        recorded={props.recorded}
        rows={props.clickRows}
        input={props.input}
        selectedClick={selection?.kind === 'click' ? selection.ms : null}
        onNotice={props.onNotice}
      />
    </>
  )
}

/** A click selected on the timeline (or in the recorded clicks list): ignore it or use it again. */
function SelectedClick({ row, input, rightClicks }: { row: ClickRow; input: InputActions; rightClicks: boolean }): JSX.Element {
  const keymap = useKeymap()
  const state = clickState(row)
  return (
    <Section title="Selected click" aside={<span className="muted small">{`${clickKind(row.click.button)} · ${formatTime(row.click.t)}`}</span>}>
      <div className="selected-click" data-testid="selected-click" data-state={state}>
        {state === 'used' ? (
          <p className="hint">{usedClickText(row.click, rightClicks)}</p>
        ) : (
          <p className="hint">
            Ignored: no zoom, click effect or sound, and smart speed does not count it.
            {row.ignored?.stray ? ` It was ignored automatically: ${STRAY_REASON_TEXT[row.ignored.stray]}.` : ''}
          </p>
        )}
        {state === 'used' ? (
          <button className="btn" onClick={() => input.setIgnored([row.ms], true)} title={withShortcut('Ignore this click', keymap.deleteSelection)}>
            <EyeOffIcon /> Ignore click
            {keymap.deleteSelection[0] && <ShortcutKeys accelerator={keymap.deleteSelection[0]} className="btn-shortcut" />}
          </button>
        ) : (
          <button className="btn" onClick={() => input.setIgnored([row.ms], false)} title="Use this click again">
            <Icon name="refresh" size={16} /> Use click
          </button>
        )}
        <p className="hint">Only automatic zooms change; zooms you added or edited stay as they are.</p>
      </div>
    </Section>
  )
}

/** Why an automatic zoom exists: the click, typing, mark or scroll it was made for. */
function ZoomCauseLine({ zoom, cursor, auto, input, onSelect }: { zoom: ZoomSegment; cursor: CursorTrack; auto: AutoZoomSettings; input: InputActions; onSelect: InspectorProps['onSelect'] }): JSX.Element | null {
  const cause = zoomCause(zoom, cursor, auto)
  if (!cause) return null
  if (cause.kind === 'click') {
    return (
      <div className="zoom-cause" data-testid="zoom-cause" data-kind="click">
        <span>Made for the click at {formatTime(cause.click.t)}</span>
        <button
          className="btn ghost small-btn"
          title="Stop using this click: its zoom, click effect and sound go away"
          onClick={() => {
            input.setIgnored([cause.ms], true)
            // The zoom is gone with its click.
            onSelect(null)
          }}
        >
          Ignore this click
        </button>
      </div>
    )
  }
  const text =
    cause.kind === 'typing'
      ? `Made for typing at ${formatTime(cause.t)}`
      : cause.kind === 'mark'
        ? `Made for a zoom-here mark at ${formatTime(cause.t)}`
        : `Zooms back in where scrolling stopped (${formatTime(cause.t)})`
  return (
    <div className="zoom-cause" data-testid="zoom-cause" data-kind={cause.kind}>
      <span>{text}</span>
    </div>
  )
}

function SelectedZoom(props: InspectorProps & { zoom: ZoomSegment }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const { project, zoom } = props
  const cursorValid = props.cursor.valid
  const style = zoomStyleOf(project)
  const next = nextZoom(project.zooms, zoom.id)
  const connected = isConnectedToNext(project.zooms, zoom.id, style)
  // The zoom as the preview frames it: levels and places are relative to the part of the recording
  // that is shown (its crop); edits are stored in the full frame.
  const crop = cropOf(project)
  const shown = zoomInView(crop, zoom)
  const focus = shown.focus
  const level = zoomTargetScale(shown)

  const patch = (fn: (z: ZoomSegment) => ZoomSegment, key?: string): void => {
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === zoom.id ? fn(z) : z)) }), key)
  }
  const setZoom = (change: Partial<ZoomSegment>, key?: string): void => patch((z) => ({ ...z, ...change, auto: false }), key)
  const setLevel = (v: number, key?: string): void => patch((z) => setZoomLevelInView(crop, z, v), key)
  /** A fixed focus on the shown point (x, y). */
  const fixedAt = (x: number, y: number): ZoomFocus => {
    const at = fromCrop(crop, { x, y })
    return { mode: 'fixed', x: at.x, y: at.y }
  }

  /** Shows the zoom on the preview while picking on it. */
  const startPicking = (): void => {
    if (player.time < zoom.start || player.time >= zoom.end) player.seek((zoom.start + zoom.end) / 2)
    props.onPickFocus(true)
  }

  const setFocusMode = (mode: 'cursor' | 'fixed' | 'region'): void => {
    if (mode === focus.mode) return
    // Keep looking where the zoom looks now instead of jumping to the centre, at the level shown: a
    // region zoom's stored scale is its level in the frame it was drawn in, not in the crop's view.
    const f = focus.mode === 'region' ? { x: focus.x + focus.w / 2, y: focus.y + focus.h / 2 } : focus.mode === 'fixed' ? focus : toCrop(crop, props.focusFor(zoom))
    if (mode === 'cursor') {
      setZoom({ focus: { mode: 'cursor' }, scale: level })
      props.onPickFocus(false)
    } else if (mode === 'fixed') {
      setZoom({ focus: fixedAt(f.x, f.y), scale: level })
    } else {
      const region = regionAround(f.x, f.y, level >= 1.05 ? level : 2)
      patch((z) => zoomFromView(crop, setZoomLevel({ ...zoomInView(crop, z), focus: region }, level >= 1.05 ? level : 2)))
      startPicking()
    }
  }

  const toggleConnect = (on: boolean): void => {
    if (on) {
      const zooms = connectToNext(store.state.zooms, zoom.id)
      if (zooms) store.update((p) => ({ ...p, zooms }))
      return
    }
    const zooms = disconnectFromNext(store.state.zooms, zoom.id, zoomStyleOf(store.state))
    if (zooms) store.update((p) => ({ ...p, zooms }))
    else props.onNotice('This zoom is too short to end before the next one: shorten or move a zoom instead')
  }

  const easing = zoomEasing(zoom, style)
  const transition = zoomTransition(zoom, style)
  const ownStyle = zoom.easing !== undefined || zoom.transition !== undefined

  return (
    <Section title="Selected zoom" aside={<span className="muted small">{zoom.auto ? 'automatic' : 'edited'}</span>}>
      <p className="hint">
        {formatTime(zoom.start)} – {formatTime(zoom.end)} · {(zoom.end - zoom.start).toFixed(1)} s
      </p>
      {zoom.auto && <ZoomCauseLine zoom={zoom} cursor={props.cursor} auto={zoomSettingsOf(project).auto} input={props.input} onSelect={props.onSelect} />}
      <div className="zoom-chips-fill">
        <Chips
          label="Zoom level presets"
          value={ZOOM_LEVEL_PRESETS.find((p) => Math.abs(p.value - level) < 1e-3)?.value ?? null}
          onChange={(v) => setLevel(v)}
          options={ZOOM_LEVEL_PRESETS.map((p) => {
            const command = `zoomLevel${p.key}`
            return { value: p.value, label: p.label, title: withShortcut(p.title, isCommandId(command) ? keymap[command] : undefined) }
          })}
        />
      </div>
      <Slider
        label={level < 1 ? 'Zoom level · pull back' : 'Zoom level'}
        value={level}
        min={ZOOM_MIN_SCALE}
        max={ZOOM_MAX_SCALE}
        step={0.05}
        format={formatLevel}
        onChange={(v) => setLevel(v, `zoom-scale:${zoom.id}`)}
      />
      <Chips
        label="Zoom focus"
        value={focus.mode === 'cursor' && !cursorValid ? null : focus.mode}
        onChange={setFocusMode}
        options={[
          { value: 'cursor', label: 'Follow cursor', disabled: !cursorValid, title: cursorValid ? 'Follow the cursor' : 'No cursor data in this recording' },
          { value: 'fixed', label: 'Fixed point', title: 'Look at one point' },
          { value: 'region', label: 'Region', title: 'Frame a rectangle you draw on the preview' }
        ]}
      />
      {focus.mode === 'cursor' && level < 1 && <p className="hint">A pulled-back zoom stays centred while the cursor moves.</p>}
      {focus.mode === 'fixed' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <EditorIcon name="crosshair" size={16} /> {props.pickFocus ? 'Done picking' : 'Pick on preview'}
          </button>
          <Slider label="Focus X" value={focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: fixedAt(v, focus.y) }, `zoom-focus:${zoom.id}`)} />
          <Slider label="Focus Y" value={focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: fixedAt(focus.x, v) }, `zoom-focus:${zoom.id}`)} />
        </>
      )}
      {focus.mode === 'region' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <RegionIcon /> {props.pickFocus ? 'Done' : 'Draw on preview'}
          </button>
          <p className="hint" data-testid="zoom-region-readout">
            Frames {pctFmt(focus.w)} × {pctFmt(focus.h)} of the recording at {formatLevel(level)}. Drag on the preview to draw a new box, or move and resize it.
          </p>
        </>
      )}
      <div className="field-label zoom-subhead">
        <span>Motion</span>
        {ownStyle ? (
          <button className="link" onClick={() => setZoom({ easing: undefined, transition: undefined })} title="Use the project's zoom style for this zoom">
            Use zoom style
          </button>
        ) : (
          <span className="muted small">zoom style</span>
        )}
      </div>
      <div className="zoom-chips-fill">
        <Chips label="Zoom easing" value={easing} onChange={(v: ZoomEasing) => setZoom({ easing: v })} options={ZOOM_EASINGS} />
      </div>
      <Slider label="Transition" value={transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(v) => setZoom({ transition: v }, `zoom-transition:${zoom.id}`)} />
      <Toggle
        label="Pan to next zoom"
        checked={connected}
        disabled={!next}
        title={next ? 'Move straight to the next zoom instead of zooming out in between' : 'There is no zoom after this one'}
        onChange={toggleConnect}
      />
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
  )
}

function ZoomStyleSection({ project, onNotice }: { project: Project; onNotice: (m: string) => void }): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const settings = zoomSettingsOf(project)
  const set = (patch: Partial<ZoomSettings>, key?: string): void =>
    store.update((p) => ({ ...p, zoomSettings: { ...zoomSettingsOf(p), ...patch } }), key)
  const overridden = project.zooms.filter((z) => z.easing !== undefined || z.transition !== undefined).length
  return (
    <Section title="Zoom style" aside={<span className="muted small">all zooms</span>}>
      <div className="zoom-chips-fill">
        <Chips label="Default zoom easing" value={settings.easing} onChange={(easing: ZoomEasing) => set({ easing })} options={ZOOM_EASINGS} />
      </div>
      <Slider label="Transition" value={settings.transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(transition) => set({ transition }, 'zoomSettings.transition')} />
      <Slider label="New zoom level" value={settings.defaultScale} min={ZOOM_MIN_SCALE} max={ZOOM_MAX_SCALE} step={0.05} format={formatLevel} onChange={(defaultScale) => set({ defaultScale }, 'zoomSettings.defaultScale')} />
      <p className="hint">
        Every zoom without its own motion follows this style; zooms you add start at the new zoom level.
        {overridden > 0 ? ` ${plural(overridden, 'zoom')} ${overridden === 1 ? 'has its' : 'have their'} own.` : ''}
      </p>
      <div className="row start zoom-actions">
        <button
          className="btn"
          disabled={overridden === 0}
          onClick={() => {
            store.update((p) => ({ ...p, zooms: clearZoomStyles(p.zooms) }))
            onNotice(`Zoom style applied to all zooms${undoHint(keymap)}`)
          }}
        >
          Apply to all zooms
        </button>
      </div>
    </Section>
  )
}

const SCROLL_MODES: { value: ScrollZoomMode; label: string; title: string }[] = [
  { value: 'zoom-out', label: 'Zoom out', title: 'Show the whole page while it scrolls, then zoom in where you stop' },
  { value: 'hold', label: 'Hold', title: 'Keep the zoom steady until scrolling stops' },
  { value: 'ignore', label: 'Ignore', title: 'Scrolling does not change the zooms' }
]

function AutoZoomSection({
  project,
  cursor,
  recorded,
  rows,
  input,
  selectedClick,
  onNotice
}: {
  project: Project
  /** The effective track: what the zooms are generated from. */
  cursor: CursorTrack
  /** cursor.json as recorded: whether there is input at all, and whether scrolling was recorded. */
  recorded: CursorTrack
  rows: ClickRow[]
  input: InputActions
  selectedClick: number | null
  onNotice: (m: string) => void
}): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const settings = zoomSettingsOf(project)
  const auto = settings.auto
  const found = inputSummary(cursor, rows, auto)
  const autoCount = project.zooms.filter((z) => z.auto).length
  // The recorded clicks count, so ignoring every click does not turn auto zoom off here.
  const hasInput = rows.some((r) => isZoomClick(r.click, true)) || found.typing > 0 || found.marks > 0
  const scrollsRecorded = recorded.valid && recorded.scrolls !== undefined

  /** Changes auto zoom settings and regenerates the automatic zooms with them (one undo step per drag). */
  const setAuto = (patch: Partial<AutoZoomSettings>, key?: string): void => {
    store.update((p) => {
      const zs = zoomSettingsOf(p)
      const next = { ...zs, auto: { ...zs.auto, ...patch } }
      const zooms = hasInput || !next.auto.enabled ? regenerateInFrame(p.zooms, cursor, p, next.auto).zooms : p.zooms
      return { ...p, autoZoom: next.auto.enabled, zoomSettings: next, zooms }
    }, key)
  }

  const regenerate = (): void => {
    const r = regenerateInFrame(project.zooms, cursor, project, { ...auto, enabled: true })
    store.update((p) => ({ ...p, autoZoom: true, zoomSettings: { ...zoomSettingsOf(p), auto: { ...zoomSettingsOf(p).auto, enabled: true } }, zooms: r.zooms }))
    onNotice(`Auto zoom: ${plural(r.added, 'zoom')}${r.kept ? `, ${r.kept} edited kept` : ''}`)
  }

  const removeAll = (): void => {
    const n = project.zooms.length
    store.update((p) => ({ ...p, zooms: [] }))
    onNotice(`Removed ${plural(n, 'zoom')}${undoHint(keymap)}`)
  }

  return (
    <Section title="Auto zoom" aside={<span className="muted small">{plural(autoCount, 'automatic zoom')}</span>}>
      <p className="hint" data-testid="auto-zoom-summary">
        {hasInput
          ? `${autoZoomFoundText(found, auto.rightClicks)} Changing these settings regenerates the automatic zooms; zooms you added or edited are kept.`
          : `${orPress('No clicks were captured, so add zooms yourself: double-click the zoom track', keymap.addZoom)}.`}
      </p>
      <Toggle label="Auto zoom" checked={auto.enabled} disabled={!hasInput} onChange={(enabled) => setAuto({ enabled })} />
      <div className={`auto-zoom-options ${auto.enabled && hasInput ? '' : 'off'}`}>
        <Slider label="Level" value={auto.scale} min={1.1} max={4} step={0.05} format={formatLevel} disabled={!auto.enabled || !hasInput} onChange={(scale) => setAuto({ scale }, 'auto.scale')} />
        <Slider label="Group clicks within" value={auto.clusterGap} min={0.5} max={8} step={0.1} format={(v) => `${v.toFixed(1)} s`} disabled={!auto.enabled || !hasInput} onChange={(clusterGap) => setAuto({ clusterGap }, 'auto.clusterGap')} />
        <Slider label="Zoom in before" value={auto.leadIn} min={0.2} max={2.5} step={0.05} format={secFmt} disabled={!auto.enabled || !hasInput} onChange={(leadIn) => setAuto({ leadIn }, 'auto.leadIn')} />
        <Slider label="Hold after" value={auto.hold} min={0.5} max={6} step={0.1} format={(v) => `${v.toFixed(1)} s`} disabled={!auto.enabled || !hasInput} onChange={(hold) => setAuto({ hold }, 'auto.hold')} />
        <Toggle label="Right clicks" checked={auto.rightClicks} disabled={!auto.enabled || !hasInput} onChange={(rightClicks) => setAuto({ rightClicks })} />
        <Toggle
          label="Typing"
          title="Zoom in a little closer on the field you type into, and stay there until you stop typing (short pauses included)"
          checked={auto.onTyping}
          disabled={!auto.enabled || !hasInput}
          onChange={(onTyping) => setAuto({ onTyping })}
        />
        <Toggle label="Zoom-here marks" title="Zoom where you pressed the zoom-here shortcut while recording" checked={auto.onMarks} disabled={!auto.enabled || !hasInput} onChange={(onMarks) => setAuto({ onMarks })} />
        <span className="field-label">While scrolling</span>
        <div className="zoom-chips-fill">
          <Chips
            label="While scrolling"
            value={auto.scrolling ?? 'zoom-out'}
            disabled={!auto.enabled || !hasInput || !scrollsRecorded}
            onChange={(scrolling) => setAuto({ scrolling })}
            options={SCROLL_MODES}
          />
        </div>
        {!scrollsRecorded && recorded.valid && (
          <p className="hint" data-testid="scroll-not-recorded">
            Scrolling was not recorded in this video (it was made before Flown recorded scrolling).
          </p>
        )}
      </div>
      <div className="row start zoom-actions">
        <button className="btn" disabled={!hasInput} onClick={regenerate}>
          <Icon name="refresh" size={16} /> Regenerate
        </button>
        <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={removeAll}>
          <Icon name="trash" size={16} /> Remove all
        </button>
      </div>
      {rows.length > 0 && <RecordedClicks rows={rows} input={input} selected={selectedClick} />}
    </Section>
  )
}

/** Every recorded click, to review: select one (it shows on the preview), ignore it or use it again. */
function RecordedClicks({ rows, input, selected }: { rows: ClickRow[]; input: InputActions; selected: number | null }): JSX.Element {
  const ignored = rows.filter((r) => r.ignored).length
  return (
    <details className="click-review" data-testid="recorded-clicks">
      <summary>
        Recorded clicks · {rows.length}
        {ignored > 0 ? ` · ${ignored} ignored` : ''}
      </summary>
      <ul className="click-list" aria-label="Recorded clicks">
        {rows.map((r, i) => {
          const state = clickState(r)
          const at = formatTime(r.click.t)
          return (
            <li key={`${r.ms}:${i}`} className={`${state === 'used' ? '' : 'ignored'} ${selected === r.ms ? 'selected' : ''}`} data-click-ms={r.ms} data-state={state}>
              <button className="click-time" title="Select this click on the timeline" aria-current={selected === r.ms ? 'true' : undefined} onClick={() => input.selectClick(r.ms)}>
                {at}
              </button>
              <span className="click-kind">{r.click.button}</span>
              <span className="click-state" title={r.ignored?.stray ? `Ignored automatically: ${STRAY_REASON_TEXT[r.ignored.stray]}` : undefined}>
                {state === 'used' ? 'used' : state === 'stray' ? 'stray' : 'ignored'}
              </span>
              {state === 'used' ? (
                <button className="btn ghost small-btn" aria-label={`Ignore the click at ${at}`} onClick={() => input.setIgnored([r.ms], true)}>
                  Ignore
                </button>
              ) : (
                <button className="btn ghost small-btn" aria-label={`Use the click at ${at}`} onClick={() => input.setIgnored([r.ms], false)}>
                  Use
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <div className="row start zoom-actions">
        <button className="btn" onClick={input.findStray} title="Ignore clicks that are almost certainly not part of the demo: right at the start, right before stopping, or made while the cursor flew past">
          Find stray clicks
        </button>
        <button className="btn ghost" disabled={ignored === 0} onClick={input.useAll}>
          Use all clicks
        </button>
      </div>
    </details>
  )
}

function RegionIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z" />
    </svg>
  )
}

/** A click that no longer counts: the eye-off glyph of the Ignore buttons. */
function EyeOffIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.7 3.3M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}
