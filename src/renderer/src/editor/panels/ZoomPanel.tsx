import { isCommandId } from '../../../../shared/editor/commands'
import { setZoomLevelInView } from '../../../../shared/editor/cropEdit'
import { followsAction, framedLevel } from '../../../../shared/editor/followEdit'
import { zoomCause } from '../../../../shared/editor/inputEdits'
import type { ClickRow } from '../../../../shared/engine/inputData'
import { scrollBreaks } from '../../../../shared/engine/scroll'
import { orPress, shortcutLabel, undoHint, withShortcut, zoomLevelKeysHint } from '../../../../shared/editor/shortcuts'
import { ZOOM_EASINGS } from '../../../../shared/engine/easing'
import { cropOf, fromCrop, regenerateInFrame, toCrop, zoomFromView, zoomInView } from '../../../../shared/engine/crop'
import { itemKey } from '../../../../shared/editor/multiSelect'
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
  isConnectedToNext,
  nextZoom,
  regionAround,
  setZoomLevel,
} from '../../../../shared/editor/zoomEdit'
import type { AutoZoomSettings, CursorTrack, Project, ScrollZoomMode, ZoomEasing, ZoomFocus, ZoomSegment, ZoomSettings } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InputActions, InspectorProps } from '../Inspector'
import { autoZoomFoundText, clickKind, clickState, STRAY_REASON_TEXT, usedClickText } from '../selection'
import { useKeymap } from '../keymapContext'
import { useListSelect } from '../listSelect'
import { LookButtons } from '../LookButtons'
import { ShortcutKeys } from '../ShortcutKeys'
import { IMPORTED_COPY, isImported } from '../../../../shared/import/imported'
import { fmt } from '../../../../shared/i18n/fmt'
import '../zoom.css'
import { MagnifierZoomRow } from './MagnifierZoomRow'
import { t, uiLanguage } from '../../../../shared/i18n/t'
import { zoomLevelPresets } from '../../../../shared/editor/itemNames'

const secFmt = (v: number): string => t('zoom.zoomPanel.seconds', { n: fmt.number(v, { max: 2 }) })
const tenthsFmt = (v: number): string => t('zoom.zoomPanel.seconds', { n: fmt.number(v, { max: 1 }) })

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
          {keymap.addZoom[0] ? t('zoom.zoomPanel.selectAZoomKeys', { keys: shortcutLabel(keymap.addZoom[0]) }) : t('zoom.zoomPanel.selectAZoom')}
          {levelKeys ? ` ${t('zoom.zoomPanel.withAZoomSelected', { levels: levelKeys })}` : ''}
        </p>
      )}
      <ZoomStyleSection project={project} onNotice={props.onNotice} />
      {/* The magnifier, where users look for it (docs/design/editing-polish.md §2.2). */}
      <MagnifierZoomRow />
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
    <Section title={t('zoom.zoomPanel.selectedClick')} aside={<span className="muted small">{`${clickKind(row.click.button)} · ${fmt.clock(row.click.t)}`}</span>}>
      <div className="selected-click" data-testid="selected-click" data-state={state}>
        {state === 'used' ? (
          <p className="hint">{usedClickText(row.click, rightClicks)}</p>
        ) : (
          <p className="hint">{uiLanguage() === 'en' ? (
            // English keeps today's two text nodes (merge group, output-and-languages §9.3).
            <>
              {t('zoom.zoomPanel.ignored.lead')}{row.ignored?.stray ? t('zoom.zoomPanel.ignored.auto', { reason: STRAY_REASON_TEXT[row.ignored.stray] }) : ''}
            </>
          ) : (
            t('zoom.zoomPanel.ignored.whole', { auto: row.ignored?.stray ? 'yes' : 'no', reason: row.ignored?.stray ? STRAY_REASON_TEXT[row.ignored.stray] : '' })
          )}
          </p>
        )}
        {state === 'used' ? (
          <button className="btn" onClick={() => input.setIgnored([row.ms], true)} title={withShortcut(t('zoom.zoomPanel.ignoreThisClickTitle'), keymap.deleteSelection)}>
            <EyeOffIcon /> {t('zoom.zoomPanel.ignoreClick')}{keymap.deleteSelection[0] && <ShortcutKeys accelerator={keymap.deleteSelection[0]} className="btn-shortcut" />}
          </button>
        ) : (
          <button className="btn" onClick={() => input.setIgnored([row.ms], false)} title={t('zoom.zoomPanel.useThisClickAgain')}>
            <Icon name="refresh" size={16} /> {t('zoom.zoomPanel.useClick')}
          </button>
        )}
        <p className="hint">{t('zoom.zoomPanel.onlyAutomaticZoomsChange')}</p>
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
        <span>{t('zoom.zoomPanel.madeForTheClick', { time: fmt.clock(cause.click.t) })}</span>
        <button
          className="btn ghost small-btn"
          title={t('zoom.zoomPanel.stopUsingThisClick')}
          onClick={() => {
            input.setIgnored([cause.ms], true)
            // The zoom is gone with its click.
            onSelect(null)
          }}
        >{t('zoom.zoomPanel.ignoreThisClick')}</button>
      </div>
    )
  }
  const text =
    cause.kind === 'typing'
      ? t('zoom.zoomPanel.cause.typing', { time: fmt.clock(cause.t) })
      : cause.kind === 'mark'
        ? t('zoom.zoomPanel.cause.mark', { time: fmt.clock(cause.t) })
        : t('zoom.zoomPanel.cause.scroll', { time: fmt.clock(cause.t) })
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
  // While the view follows the action (docs/design/vertical-video.md §2.6): a 1× level only moves
  // the view, and the zoom shows gentler than set.
  const following = followsAction(project)
  const framed = following ? framedLevel(project, zoom.id) : null
  const presets = following ? [{ value: 1, key: '', label: '1×', title: t('zoom.zoomPanel.presetFollow') }, ...zoomLevelPresets()] : zoomLevelPresets()

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
    else props.onNotice(t('zoom.zoomPanel.tooShortToEnd'))
  }

  const easing = zoomEasing(zoom, style)
  const transition = zoomTransition(zoom, style)
  const ownStyle = zoom.easing !== undefined || zoom.transition !== undefined

  return (
    <Section title={t('zoom.zoomPanel.selectedZoom')} aside={<span className="muted small">{zoom.auto ? t('zoom.zoomPanel.automatic') : t('zoom.zoomPanel.edited')}</span>}>
      <p className="hint">
        {t('zoom.zoomPanel.span', { start: fmt.clock(zoom.start), end: fmt.clock(zoom.end), seconds: fmt.number(zoom.end - zoom.start, { max: 1 }) })}
      </p>
      {zoom.auto && <ZoomCauseLine zoom={zoom} cursor={props.cursor} auto={zoomSettingsOf(project).auto} input={props.input} onSelect={props.onSelect} />}
      <div className="zoom-chips-fill">
        <Chips
          label={t('zoom.zoomPanel.zoomLevelPresets')}
          value={presets.find((p) => Math.abs(p.value - level) < 1e-3)?.value ?? null}
          onChange={(v) => setLevel(v)}
          options={presets.map((p) => {
            const command = `zoomLevel${p.key}`
            return { value: p.value, label: p.label, title: withShortcut(p.title, isCommandId(command) ? keymap[command] : undefined) }
          })}
        />
      </div>
      {framed !== null && (
        <p className="hint" data-testid="zoom-framed-level">
          {t('zoom.zoomPanel.framedLevel', { level: fmt.factor(framed) })}
        </p>
      )}
      <Slider
        label={level < 1 ? t('zoom.zoomPanel.zoomLevelPullBack') : t('zoom.zoomPanel.zoomLevel')}
        value={level}
        min={ZOOM_MIN_SCALE}
        max={ZOOM_MAX_SCALE}
        step={0.05}
        format={fmt.factor}
        onChange={(v) => setLevel(v, `zoom-scale:${zoom.id}`)}
      />
      <Chips
        label={t('zoom.zoomPanel.zoomFocus')}
        value={focus.mode === 'cursor' && !cursorValid ? null : focus.mode}
        onChange={setFocusMode}
        options={[
          { value: 'cursor', label: t('style.groupEdit.option.zoomFocus.cursor'), disabled: !cursorValid, title: cursorValid ? t('style.groupEdit.option.zoomFocus.cursor.title') : t('style.selectionPanel.noCursor') },
          { value: 'fixed', label: t('style.groupEdit.option.zoomFocus.fixed'), title: t('zoom.zoomPanel.focus.fixed.title') },
          { value: 'region', label: t('zoom.zoomPanel.focus.region'), title: t('zoom.zoomPanel.focus.region.title') }
        ]}
      />
      {focus.mode === 'cursor' && level < 1 && <p className="hint">{t('zoom.zoomPanel.aPulledBackZoom')}</p>}
      {focus.mode === 'fixed' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <EditorIcon name="crosshair" size={16} /> {props.pickFocus ? t('zoom.zoomPanel.donePicking') : t('zoom.zoomPanel.pickOnPreview')}
          </button>
          <Slider label={t('zoom.zoomPanel.focusX')} value={focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: fixedAt(v, focus.y) }, `zoom-focus:${zoom.id}`)} />
          <Slider label={t('zoom.zoomPanel.focusY')} value={focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: fixedAt(focus.x, v) }, `zoom-focus:${zoom.id}`)} />
        </>
      )}
      {focus.mode === 'region' && (
        <>
          <button className={`btn ${props.pickFocus ? 'primary' : ''}`} onClick={() => (props.pickFocus ? props.onPickFocus(false) : startPicking())} aria-pressed={props.pickFocus}>
            <RegionIcon /> {props.pickFocus ? t('common.action.done') : t('zoom.zoomPanel.drawOnPreview')}
          </button>
          <p className="hint" data-testid="zoom-region-readout">
            {t('zoom.zoomPanel.regionReadout', { width: pctFmt(focus.w), height: pctFmt(focus.h), level: fmt.factor(level) })}
          </p>
        </>
      )}
      <div className="field-label zoom-subhead">
        <span>{t('common.label.motion')}</span>
        {ownStyle ? (
          <button className="link" onClick={() => setZoom({ easing: undefined, transition: undefined })} title={t('zoom.zoomPanel.useTheProjectS')}>{t('zoom.zoomPanel.useZoomStyle')}</button>
        ) : (
          <span className="muted small">{t('zoom.zoomPanel.zoomStyle')}</span>
        )}
      </div>
      <div className="zoom-chips-fill">
        <Chips label={t('zoom.zoomPanel.zoomEasing')} value={easing} onChange={(v: ZoomEasing) => setZoom({ easing: v })} options={ZOOM_EASINGS} />
      </div>
      <Slider label={t('zoom.zoomPanel.transition')} value={transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(v) => setZoom({ transition: v }, `zoom-transition:${zoom.id}`)} />
      <Toggle
        label={t('zoom.zoomPanel.panToNextZoom')}
        checked={connected}
        disabled={!next}
        title={next ? t('zoom.zoomPanel.moveStraightToThe') : t('zoom.zoomPanel.thereIsNoZoom')}
        onChange={toggleConnect}
      />
      <LookButtons itemKey={itemKey('zoom', zoom.id)} />
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== zoom.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> {t('zoom.zoomPanel.deleteZoom')}
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
    <Section title={t('zoom.zoomPanel.zoomStyleTitle')} aside={<span className="muted small">{t('zoom.zoomPanel.allZooms')}</span>}>
      <div className="zoom-chips-fill">
        <Chips label={t('zoom.zoomPanel.defaultZoomEasing')} value={settings.easing} onChange={(easing: ZoomEasing) => set({ easing })} options={ZOOM_EASINGS} />
      </div>
      <Slider label={t('zoom.zoomPanel.transition')} value={settings.transition} min={MIN_TRANSITION} max={MAX_TRANSITION} step={0.05} format={secFmt} onChange={(transition) => set({ transition }, 'zoomSettings.transition')} />
      <Slider label={t('zoom.zoomPanel.newZoomLevel')} value={settings.defaultScale} min={ZOOM_MIN_SCALE} max={ZOOM_MAX_SCALE} step={0.05} format={fmt.factor} onChange={(defaultScale) => set({ defaultScale }, 'zoomSettings.defaultScale')} />
      <p className="hint">
        {t('zoom.zoomPanel.everyZoomWithoutIts')}
        {overridden > 0 ? ` ${t('zoom.zoomPanel.ownStyleCount', { count: overridden, n: fmt.count(overridden) })}` : ''}
      </p>
      <div className="row start zoom-actions">
        <button
          className="btn"
          disabled={overridden === 0}
          onClick={() => {
            store.update((p) => ({ ...p, zooms: clearZoomStyles(p.zooms) }))
            onNotice(`${t('zoom.zoomPanel.styleApplied')}${undoHint(keymap)}`)
          }}
        >{t('zoom.zoomPanel.applyToAllZooms')}</button>
      </div>
    </Section>
  )
}

const SCROLL_MODES = (): { value: ScrollZoomMode; label: string; title: string }[] => [
  { value: 'zoom-out', label: t('zoom.zoomPanel.scroll.zoomOut'), title: t('zoom.zoomPanel.scroll.zoomOut.title') },
  { value: 'hold', label: t('zoom.zoomPanel.scroll.hold'), title: t('zoom.zoomPanel.scroll.hold.title') },
  { value: 'ignore', label: t('zoom.zoomPanel.scroll.ignore'), title: t('zoom.zoomPanel.scroll.ignore.title') }
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
  const list = useListSelect()
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
    onNotice(r.kept ? t('zoom.zoomPanel.regeneratedKept', { count: r.added, n: fmt.count(r.added), kept: fmt.count(r.kept) }) : t('zoom.zoomPanel.regenerated', { count: r.added, n: fmt.count(r.added) }))
  }

  const removeAll = (): void => {
    const n = project.zooms.length
    store.update((p) => ({ ...p, zooms: [] }))
    onNotice(`${t('zoom.zoomPanel.removed', { count: n, n: fmt.count(n) })}${undoHint(keymap)}`)
  }

  return (
    <Section
      title={t('zoom.zoomPanel.autoZoom')}
      aside={
        <span className="muted small">
          {t('zoom.zoomPanel.automaticCount', { count: autoCount, n: fmt.count(autoCount) })}
          {autoCount > 1 && (
            <>
              {' · '}
              <button
                className="link small"
                onClick={() => list.selectAll(project.zooms.filter((z) => z.auto).map((z) => itemKey('zoom', z.id)))}
                title={t('zoom.zoomPanel.selectTheAutomaticZooms')}
              >{t('zoom.zoomPanel.selectThem')}</button>
            </>
          )}
        </span>
      }
    >
      <p className="hint" data-testid="auto-zoom-summary" data-imported={isImported(project) || undefined}>
        {hasInput
          ? t('zoom.zoomPanel.changingTheseSettingsRegenerates', { found: autoZoomFoundText(found, auto.rightClicks) })
          : `${orPress(isImported(project) ? IMPORTED_COPY.autoZoom : t('zoom.zoomPanel.noClicks'), keymap.addZoom)}.`}
      </p>
      <Toggle label={t('zoom.zoomPanel.autoZoom')} checked={auto.enabled} disabled={!hasInput} onChange={(enabled) => setAuto({ enabled })} />
      <div className={`auto-zoom-options ${auto.enabled && hasInput ? '' : 'off'}`}>
        <Slider label={t('zoom.zoomPanel.level')} value={auto.scale} min={1.1} max={4} step={0.05} format={fmt.factor} disabled={!auto.enabled || !hasInput} onChange={(scale) => setAuto({ scale }, 'auto.scale')} />
        <Slider label={t('zoom.zoomPanel.groupClicksWithin')} value={auto.clusterGap} min={0.5} max={8} step={0.1} format={tenthsFmt} disabled={!auto.enabled || !hasInput} onChange={(clusterGap) => setAuto({ clusterGap }, 'auto.clusterGap')} />
        <Slider label={t('zoom.zoomPanel.zoomInBefore')} value={auto.leadIn} min={0.2} max={2.5} step={0.05} format={secFmt} disabled={!auto.enabled || !hasInput} onChange={(leadIn) => setAuto({ leadIn }, 'auto.leadIn')} />
        <Slider label={t('zoom.zoomPanel.holdAfter')} value={auto.hold} min={0.5} max={6} step={0.1} format={tenthsFmt} disabled={!auto.enabled || !hasInput} onChange={(hold) => setAuto({ hold }, 'auto.hold')} />
        <Toggle label={t('zoom.zoomPanel.rightClicks')} checked={auto.rightClicks} disabled={!auto.enabled || !hasInput} onChange={(rightClicks) => setAuto({ rightClicks })} />
        <Toggle
          label={t('zoom.zoomPanel.typing')}
          title={t('zoom.zoomPanel.zoomInALittle')}
          checked={auto.onTyping}
          disabled={!auto.enabled || !hasInput}
          onChange={(onTyping) => setAuto({ onTyping })}
        />
        <Toggle label={t('zoom.zoomPanel.zoomHereMarks')} title={t('zoom.zoomPanel.zoomWhereYouPressed')} checked={auto.onMarks} disabled={!auto.enabled || !hasInput} onChange={(onMarks) => setAuto({ onMarks })} />
        <span className="field-label">{t('zoom.zoomPanel.whileScrolling')}</span>
        <div className="zoom-chips-fill">
          <Chips
            label={t('zoom.zoomPanel.whileScrolling')}
            value={auto.scrolling ?? 'zoom-out'}
            disabled={!auto.enabled || !hasInput || !scrollsRecorded}
            onChange={(scrolling) => setAuto({ scrolling })}
            options={SCROLL_MODES()}
          />
        </div>
        {!scrollsRecorded && recorded.valid && (
          <p className="hint" data-testid="scroll-not-recorded">{t('zoom.zoomPanel.scrollingWasNotRecorded')}</p>
        )}
      </div>
      <div className="row start zoom-actions">
        <button className="btn" disabled={!hasInput} onClick={regenerate}>
          <Icon name="refresh" size={16} /> {t('common.action.regenerate')}
        </button>
        <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={removeAll}>
          <Icon name="trash" size={16} /> {t('common.action.removeAll')}
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
        {ignored > 0
          ? t('zoom.zoomPanel.recordedClicksIgnored', { n: fmt.count(rows.length), ignored: fmt.count(ignored) })
          : t('zoom.zoomPanel.recordedClicksCount', { n: fmt.count(rows.length) })}
      </summary>
      <ul className="click-list" aria-label={t('zoom.zoomPanel.recordedClicksList')}>
        {rows.map((r, i) => {
          const state = clickState(r)
          const at = fmt.clock(r.click.t)
          return (
            <li key={`${r.ms}:${i}`} className={`${state === 'used' ? '' : 'ignored'} ${selected === r.ms ? 'selected' : ''}`} data-click-ms={r.ms} data-state={state}>
              <button className="click-time" title={t('zoom.zoomPanel.selectThisClickOn')} aria-current={selected === r.ms ? 'true' : undefined} onClick={() => input.selectClick(r.ms)}>
                {at}
              </button>
              <span className="click-kind">{r.click.button}</span>
              <span className="click-state" title={r.ignored?.stray ? t('zoom.zoomPanel.ignoredAutomatically', { reason: STRAY_REASON_TEXT[r.ignored.stray] }) : undefined}>
                {state === 'used' ? t('zoom.zoomPanel.used') : state === 'stray' ? t('zoom.zoomPanel.stray') : t('zoom.zoomPanel.stateIgnored')}
              </span>
              {state === 'used' ? (
                <button className="btn ghost small-btn" aria-label={t('zoom.zoomPanel.ignoreTheClickAt', { at: String(at) })} onClick={() => input.setIgnored([r.ms], true)}>{t('zoom.zoomPanel.ignore')}</button>
              ) : (
                <button className="btn ghost small-btn" aria-label={t('zoom.zoomPanel.useTheClickAt', { at: String(at) })} onClick={() => input.setIgnored([r.ms], false)}>{t('common.action.use')}</button>
              )}
            </li>
          )
        })}
      </ul>
      <div className="row start zoom-actions">
        <button className="btn" onClick={input.findStray} title={t('zoom.zoomPanel.ignoreClicksThatAre')}>{t('zoom.zoomPanel.findStrayClicks')}</button>
        <button className="btn ghost" disabled={ignored === 0} onClick={input.useAll}>{t('zoom.zoomPanel.useAllClicks')}</button>
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
