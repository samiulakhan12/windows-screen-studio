import { OPEN_SETTINGS_EVENT, SettingsButton } from '../settings/SettingsButton'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { LoadedProject } from '../../../shared/api'
import { openedWithoutStems, withRecordedStems } from '../../../shared/audio/settings'
import { captionsOf } from '../../../shared/captions/settings'
import { createAnnotation } from '../../../shared/editor/annotations'
import { Autosaver } from '../../../shared/editor/autosave'
import { canSplitAt, clipAt, correctProjectMedia, displayTime, restoreRange, stepOutput } from '../../../shared/editor/clips'
import { commandInfo, PALETTE_COMMANDS, type CommandId } from '../../../shared/editor/commands'
import { cropNotice, setCrop, setZoomLevelInView, snapCrop, taskbarCrop, type CropDraft } from '../../../shared/editor/cropEdit'
import { directUnavailable } from '../../../shared/editor/directorCopy'
import { FREEZE_REFUSAL_TEXT, freezeRefusal, removeFreeze } from '../../../shared/editor/freezeEdit'
import { clickAtPlayhead, ignoreStrayClicks, pathSummary, setClicksIgnored, setPathRange, setStraighten, useAllClicks, type PathSummary } from '../../../shared/editor/inputEdits'
import { EditStore } from '../../../shared/editor/editStore'
import { copyItems as copyGroupItems, duplicateItems as duplicateGroupItems, pasteItems as pasteGroupItems, pasteNotice, type PasteResult } from '../../../shared/editor/groupClipboard'
import { applyField, copyLook, deleteItems, GROUP_FIELDS, LOOK_CLASS_WORDS, lookClassOf, pasteLook, type FieldCtx } from '../../../shared/editor/groupEdit'
import { countOf, NO_GROUP, parseItemKey, projectItems, selectAllStep, trackOfKind, validGroup, type ItemGroup, type ItemKey, type ItemTrack } from '../../../shared/editor/multiSelect'
import { copyLookFirst, nothingCopiedNotice, removedNotice, selectAllNotice } from '../../../shared/editor/multiSelectCopy'
import { layoutRefusal, setLayoutAt } from '../../../shared/editor/layoutCommands'
import { removeLayout } from '../../../shared/editor/layouts'
import { mediaLength } from '../../../shared/editor/mediaLength'
import { POLISH_BUTTON_TITLE, polishNotice } from '../../../shared/editor/polishCopy'
import { UNTITLED, withSavedName } from '../../../shared/editor/projectName'
import {
  chordFromEvent,
  commandKeys,
  DEFAULT_KEYMAP,
  isSliderKey,
  keymapFromPrefs,
  keymapOverrides,
  matchShortcut,
  serializeShortcuts,
  shortcutIndex,
  shortcutLabel,
  standardEditCommand,
  withShortcut,
  zoomLevelKeysHint,
  undoHint,
  type Keymap
} from '../../../shared/editor/shortcuts'
import { atOutputStart, formatRate, nextPreviewSpeed, type ShuttleKey } from '../../../shared/editor/shuttle'
import { clampIntoCrop, cropOf, cropView, fromCrop, FULL_FRAME, type CropView } from '../../../shared/engine/crop'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { clamp } from '../../../shared/engine/math'
import { NO_PATHS, planCursorPath } from '../../../shared/engine/cursorPath'
import { clickRows } from '../../../shared/engine/inputData'
import { DEFAULT_EFFECTS, formatTime } from '../../../shared/engine/project'
import { scrollBreaks } from '../../../shared/engine/scroll'
import { openedWithoutCamera, withRecordedCamera } from '../../../shared/engine/webcamData'
import { cutRange, keptBounds, outputDuration, removeClip, splitAt } from '../../../shared/engine/timeline'
import { nextChapter, previousChapter } from '../../../shared/editor/titles'
import { formatLevel, ZOOM_LEVEL_PRESETS } from '../../../shared/editor/zoomEdit'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import { focusPathFor, insertZoom, zoomAt, zoomSettingsOf, zoomStyleOf } from '../../../shared/engine/zoom'
import type { CameraLayout, NormRect, PathMode, Project, ShapeKind, Spotlight, ZoomFocus, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { CommandPalette, SearchIcon, type PaletteEntry } from '../editor/CommandPalette'
import { EditorContext, type EditorServices } from '../editor/context'
import { CropBar, type CropTool } from '../editor/CropEditor'
import { EditorIcon } from '../editor/EditorIcon'
import { ExportDialog } from '../editor/ExportDialog'
import { blurActiveControl, installFocusRelease, isRangeInput, isTextEntry, releaseFocus } from '../editor/focus'
import { keepInspectorFocus } from '../editor/inspectorFocus'
import { addFreezeAt, freezeTarget, toggleFreezeSound } from '../editor/freezeItems'
import { itemClipboard, lookClipboard } from '../editor/itemClipboard'
import { Inspector, type InputActions, type InspectorTab } from '../editor/Inspector'
import { KeymapContext } from '../editor/keymapContext'
import { showLayout } from '../editor/LayoutTrack'
import { createVideo, loadImage } from '../editor/media'
import { PreviewPlayer } from '../editor/player'
import { addShapeAt, addSpotlightAt } from '../editor/playheadItems'
import { PolishDialog } from '../editor/PolishDialog'
import { PreviewStage } from '../editor/PreviewStage'
import { SaveIndicator } from '../editor/SaveIndicator'
import { groupKeyOf, selectionOfKey, validSelection, type Selection } from '../editor/selection'
import { GroupContext, type GroupApi } from '../editor/groupContext'
import { ShortcutKeys } from '../editor/ShortcutKeys'
import { ShortcutsDialog } from '../editor/ShortcutsDialog'
import { snapPref } from '../editor/snapControl'
import { addChapterAt, addTitleAt, brandFontFor } from '../editor/titleItems'
import { OverlayDropZone } from '../editor/OverlayDropZone'
import { ipcMessage, noteItemCopy, pasteClipboardImage } from '../editor/overlayItems'
import { requestCaptions } from '../editor/captionItems'
import { Timeline, type TimelineHandle } from '../editor/Timeline'
import { Transport } from '../editor/Transport'
import { videoTrackDuration } from '../editor/videoTrack'
import { setWaveformShown, waveformShown } from '../editor/waveformPref'
import type { RenderScene } from '../render/compositor'
import '../editor/editor.css'

interface Session {
  data: LoadedProject
  store: EditStore<Project>
  saver: Autosaver<Project>
  player: PreviewPlayer
}

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; session: Session }

const METADATA_TIMEOUT_MS = 20000

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** How a reason a cursor move keeps its recorded path is counted: [one, many]. */
const KEPT_NOUN: Record<keyof PathSummary['kept'], [string, string]> = {
  drag: ['drag', 'drags'],
  'drag-guess': ['possible drag', 'possible drags'],
  click: ['move across a click', 'moves across a click'],
  scroll: ['move while scrolling', 'moves while scrolling'],
  'off-frame': ['move outside the video', 'moves outside the video'],
  short: ['very quick move', 'very quick moves'],
  long: ['long move', 'long moves'],
  small: ['tiny move', 'tiny moves'],
  wobbly: ['winding move', 'winding moves'],
  gesture: ['loop', 'loops']
}

/** " (1 drag, 1 move across a click)", or "" when no move was kept for a reason. */
function keptReasons(summary: PathSummary): string {
  const parts = (Object.keys(KEPT_NOUN) as (keyof PathSummary['kept'])[])
    .filter((k) => (summary.kept[k] ?? 0) > 0)
    .map((k) => {
      const n = summary.kept[k]!
      return `${n} ${KEPT_NOUN[k][n === 1 ? 0 : 1]}`
    })
  return parts.length ? ` (${parts.join(', ')})` : ''
}

/** Resolves once the video's duration and size are known (or after a timeout); rejects if it cannot load. */
function whenMetadata(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (v.readyState >= 1) return resolve()
    const timer = window.setTimeout(done, METADATA_TIMEOUT_MS)
    function done(): void {
      window.clearTimeout(timer)
      v.removeEventListener('loadedmetadata', done)
      v.removeEventListener('error', fail)
      resolve()
    }
    function fail(): void {
      window.clearTimeout(timer)
      v.removeEventListener('loadedmetadata', done)
      v.removeEventListener('error', fail)
      reject(new Error(`the video could not be loaded (${v.error?.message || 'unsupported or missing file'})`))
    }
    v.addEventListener('loadedmetadata', done)
    v.addEventListener('error', fail)
  })
}

async function openSession(projectId: string): Promise<Session> {
  const data = await window.api.loadProject(projectId)
  const screen = createVideo(data.screenUrl)
  const webcam = data.webcamUrl ? createVideo(data.webcamUrl) : null
  // Read in parallel with the element's metadata; never rejects.
  const videoLength = videoTrackDuration(data.screenUrl)
  try {
    await whenMetadata(screen)
  } catch (err) {
    for (const v of [screen, webcam]) v?.removeAttribute('src')
    throw err
  }
  // Correct duration and size from the file before anything (or any undo step) depends on them.
  // The video track's length, not screen.duration: that is the container's, which includes a longer audio track.
  const duration = mediaLength(data.project.duration, await videoLength, screen.duration)
  // Without its stems when one of their files is missing; saves keep them, so they are used again once the file is back.
  // Likewise without its camera when the camera file is missing (its layouts then leave the screen be).
  const opened = openedWithoutCamera(openedWithoutStems(data.project, data.missingStems), !data.webcamUrl)
  const project = correctProjectMedia(opened, { duration, width: screen.videoWidth, height: screen.videoHeight })
  const store = new EditStore(project)
  const recorded = (p: Project): Project => withRecordedCamera(withRecordedStems(withSavedName(p), data.project), data.project)
  const saver = new Autosaver(store, {
    save: (p, meta) => window.api.saveProject(recorded(p), meta),
    saveSync: (p, meta) => window.api.saveProjectSync(recorded(p), meta)
  })
  if (project !== opened) saver.markDirty()
  const player = new PreviewPlayer(screen, webcam, project, data.missingStems)
  return { data, store, saver, player }
}

function closeSession(s: Session): void {
  s.player.dispose()
  // Normally already flushed by Back; this covers any other way the editor goes away.
  if (s.saver.dirty) void s.saver.flush().finally(() => s.saver.dispose())
  else s.saver.dispose()
}

export function Editor({ projectId, onClose }: { projectId: string; onClose: () => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let disposed = false
    let session: Session | null = null
    setState({ kind: 'loading' })
    openSession(projectId)
      .then((s) => {
        if (disposed) return closeSession(s)
        session = s
        setState({ kind: 'ready', session: s })
      })
      .catch((err: unknown) => {
        if (!disposed) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      disposed = true
      if (session) closeSession(session)
    }
  }, [projectId])

  if (state.kind === 'error') {
    return (
      <div className="app">
        <header className="titlebar">
          <button className="btn ghost" onClick={onClose}>
            <Icon name="back" /> Back
          </button>
        </header>
        <div className="center-message error">Could not open this recording: {state.message}</div>
      </div>
    )
  }

  if (state.kind === 'loading') {
    return (
      <div className="app">
        <div className="overlay">
          <div className="spinner" />
          <p>Opening recording…</p>
        </div>
      </div>
    )
  }

  return <EditorSession session={state.session} onClose={onClose} />
}

/** What the editor's components read from context: the session's services, the current shortcuts and the selected group. */
function EditorProviders({ services, keymap, group, children }: { services: EditorServices; keymap: Keymap; group: GroupApi; children: ReactNode }): JSX.Element {
  return (
    <EditorContext.Provider value={services}>
      <KeymapContext.Provider value={keymap}>
        <GroupContext.Provider value={group}>{children}</GroupContext.Provider>
      </KeymapContext.Provider>
    </EditorContext.Provider>
  )
}

function EditorSession({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const { data, store, saver, player } = session
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const services = useMemo<EditorServices>(() => ({ store, player }), [store, player])
  // cursor.json as recorded; never changed. Everything that shows or uses input reads `cursor`:
  // the recording with the project's input edits (ignored clicks, straightened moves) applied.
  const recorded = data.cursor
  const { inputEdits, capture, width, height } = project
  const cursor = useMemo(() => effectiveTrack(recorded, { inputEdits, capture, width, height }), [recorded, inputEdits, capture, width, height])
  // Every recorded click, with its ignore state: the timeline markers and the click lists.
  const rows = useMemo(() => clickRows(recorded, inputEdits), [recorded, inputEdits])
  // What the timeline explains: the straightened moves (only when Flown draws the cursor) and the
  // long scrolls auto zoom zooms out for.
  const straighten = !!inputEdits?.straighten
  const paths = inputEdits?.paths
  const pathBars = useMemo(
    () => (recorded.valid && !capture.cursorInVideo && (straighten || paths) ? planCursorPath(recorded, { aspect: width / height, straighten, paths: paths ?? NO_PATHS }).straightened : []),
    [recorded, capture.cursorInVideo, straighten, paths, width, height]
  )
  const { zoomSettings, autoZoom } = project
  const autoSettings = useMemo(() => zoomSettingsOf({ zoomSettings, autoZoom }).auto, [zoomSettings, autoZoom])
  const scrollBands = useMemo(() => scrollBreaks(cursor, autoSettings), [cursor, autoSettings])

  const [rawSelection, setRawSelection] = useState<Selection>(null)
  const [revealSeq, setRevealSeq] = useState(0)
  // E-06: several items selected together (docs/design/multi-select.md §4.1, §8). Two or more keys,
  // only while there is no single selection; items that are gone (undo, delete) drop out.
  const [rawGroup, setRawGroup] = useState<ItemGroup>(NO_GROUP)
  const [groupReveal, setGroupReveal] = useState(0)
  const groupStamp = useRef(0)
  const g0 = useMemo(() => validGroup(rawGroup, project), [rawGroup, project])
  const collapsed = useMemo(() => (g0.keys.length === 1 ? selectionOfKey(g0.keys[0]) : null), [g0])
  const selection = collapsed ?? validSelection(rawSelection, project)
  const group = g0.keys.length >= 2 ? g0 : NO_GROUP
  // Every selection made the way it always was ends a group.
  const setSelection = useCallback((sel: Selection) => {
    setRawSelection(sel)
    setRawGroup(NO_GROUP)
    if (sel) setRevealSeq((n) => n + 1)
  }, [])
  /** Selects items by key: none clears, one is the single selection, two or more a group (shown in the Inspector unless `reveal` is false). */
  const selectKeys = useCallback(
    (keys: readonly ItemKey[], anchor: ItemKey | null, opts?: { reveal?: boolean }) => {
      const unique = [...new Set(keys)]
      if (unique.length === 0) return setSelection(null)
      if (unique.length === 1) {
        if (opts?.reveal !== false) return setSelection(selectionOfKey(unique[0]))
        setRawSelection(selectionOfKey(unique[0]))
        setRawGroup(NO_GROUP)
        return
      }
      setRawSelection(null)
      setRawGroup({ keys: unique, anchor: anchor && unique.includes(anchor) ? anchor : unique[unique.length - 1], stamp: ++groupStamp.current })
      if (opts?.reveal !== false) setGroupReveal((n) => n + 1)
    },
    [setSelection]
  )
  const [pickFocus, setPickFocus] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [background, setBackground] = useState<HTMLImageElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timelineRef = useRef<TimelineHandle>(null)
  const [tab, setTab] = useState<InspectorTab>('style')
  const [dialog, setDialog] = useState<'palette' | 'shortcuts' | 'polish' | null>(null)
  const [smartSpeedRequest, setSmartSpeedRequest] = useState(0)
  const [directorRequest, setDirectorRequest] = useState(0)

  // The background image always follows the project state, including undo/redo.
  // `backgroundVersion` reloads it when a newly picked file reuses the same name.
  const [backgroundVersion, setBackgroundVersion] = useState(0)
  const backgroundPath = project.style.background.type === 'image' ? project.style.background.path : null
  useEffect(() => {
    if (!backgroundPath) {
      setBackground(null)
      return
    }
    let cancelled = false
    window.api
      .backgroundUrl(store.state.id, backgroundPath)
      .then((url) => (url ? loadImage(url) : null))
      .then((img) => !cancelled && setBackground(img))
      .catch(() => !cancelled && setBackground(null))
    return () => {
      cancelled = true
    }
  }, [store, backgroundPath, backgroundVersion])

  /* ---------- scene + preview ---------- */

  // The crop being edited (the crop tool is open); Done applies it as one undo step.
  const [cropDraft, setCropDraft] = useState<CropDraft | null>(null)
  const cropping = !!cropDraft
  // What is drawn: the project and input as shown (cropView: positions relative to the crop, its
  // pixel size). While the crop tool is open, the whole recording without the camera (nor camera
  // layouts); setNoZoom below leaves zooms and the tilt out.
  const drawn = useMemo((): CropView<Project> => {
    if (!cropping) return cropView(project, cursor)
    const { crop: _crop, ...whole } = project
    return { project: { ...whole, webcam: { ...project.webcam, show: false } }, cursor, crop: null }
  }, [cropping, project, cursor])
  const cursorPath = useMemo(() => new SmoothedTrack(drawn.cursor.samples, project.duration, project.cursor.smoothing), [drawn.cursor.samples, project.duration, project.cursor.smoothing])
  const focusPath = useMemo(() => focusPathFor(drawn.cursor.samples, project.duration), [drawn.cursor.samples, project.duration])
  const scene: RenderScene = useMemo(
    () => ({ project: drawn.project, cursor: drawn.cursor, cursorPath, focusPath, ...(drawn.crop ? { crop: drawn.crop } : {}) }),
    [drawn, cursorPath, focusPath]
  )

  useEffect(() => player.setProject(project), [player, project])
  useEffect(() => player.setScene(scene, background), [player, scene, background])

  const pickZoom =
    pickFocus && selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id && z.focus.mode !== 'cursor') ?? null) : null
  useEffect(() => {
    player.setNoZoom(!!pickZoom || cropping)
    if (pickFocus && !pickZoom) setPickFocus(false)
  }, [player, pickFocus, pickZoom, cropping])
  // Picking applies to the zoom it was started for; selecting anything else ends it.
  const selectedZoomId = selection?.kind === 'zoom' ? selection.id : null
  useEffect(() => setPickFocus(false), [selectedZoomId])

  const selectedAnnotation = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null

  /* ---------- notices ---------- */

  const noticeTimer = useRef(0)
  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  /* ---------- shortcuts (stored in the editor preferences) ---------- */

  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYMAP)
  const shortcuts = useMemo(() => shortcutIndex(keymap), [keymap])
  useEffect(() => {
    let cancelled = false
    window.api
      .getPref('shortcuts')
      .then((raw) => !cancelled && setKeymap(keymapFromPrefs(raw)))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const changeKeymap = useCallback(
    (next: Keymap) => {
      setKeymap(next)
      const stored = Object.keys(keymapOverrides(next)).length ? serializeShortcuts(next) : null
      window.api.setPref('shortcuts', stored).catch((err: unknown) => {
        showNotice(`Your shortcuts could not be saved: ${(err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      })
    },
    [showNotice]
  )

  /* ---------- edit actions (stable; they read the store, not render-time values) ---------- */

  const latest = useRef({ selection, group, tab, pickFocus, exporting, dialog, keymap, shortcuts })
  latest.current = { selection, group, tab, pickFocus, exporting, dialog, keymap, shortcuts }


  /** Edits to the recorded input: each one store.update (one undo step), with its notice. */
  const input = useMemo((): InputActions => {
    const at = (ms: number): string => formatTime(ms / 1000)
    const range = (r: { start: number; end: number }): string => `${formatTime(r.start)} – ${formatTime(r.end)}`
    const undo = (): string => undoHint(latest.current.keymap)
    return {
      setIgnored: (keys, ignore) => {
        const before = store.state
        store.update((p) => setClicksIgnored(p, recorded, ignore ? { ignore: keys.map((ms) => ({ ms })) } : { use: keys }))
        if (store.state === before || keys.length === 0) return
        if (keys.length > 1) showNotice(ignore ? `Ignored ${plural(keys.length, 'click')}${undo()}` : `${plural(keys.length, 'click')} used again`)
        else showNotice(ignore ? `Click at ${at(keys[0])} ignored: no zoom, effect or sound${undo()}` : `Click at ${at(keys[0])} used again`)
      },
      findStray: () => {
        let added = 0
        store.update((p) => {
          const r = ignoreStrayClicks(p, recorded)
          added = r.added.length
          return r.project
        })
        showNotice(added ? `Ignored ${plural(added, 'stray click')}${undo()}` : 'No stray clicks found')
      },
      useAll: () => {
        const n = clickRows(recorded, store.state.inputEdits).filter((r) => r.ignored).length
        if (!n) return showNotice('No click is ignored')
        store.update((p) => useAllClicks(p, recorded))
        showNotice(n === 1 ? 'The ignored click is used again' : `All ${n} ignored clicks are used again`)
      },
      setStraighten: (on) => store.update((p) => setStraighten(p, on)),
      setPathRange: (r, mode) => {
        if (mode === 'straight') {
          // Painting a range that straightens nothing would only add an undo step: say why instead.
          const next = setPathRange(store.state, r, 'straight')
          const summary = pathSummary(recorded, next, r)
          if (!summary.straightened) return showNotice(`No cursor move here can be straightened${keptReasons(summary)}`)
          store.update((p) => setPathRange(p, r, 'straight'))
          return showNotice(`Straightened ${plural(summary.straightened, 'cursor move')} in ${range(r)}`)
        }
        store.update((p) => setPathRange(p, r, mode))
        showNotice(mode === 'recorded' ? `Kept the recorded cursor path in ${range(r)}` : `The cursor path in ${range(r)} follows Straighten moves again`)
      },
      selectClick: (ms) => {
        setSelection({ kind: 'click', ms })
        // Just past the click, so its effect shows on the preview (never into a cut).
        const t = ms / 1000 + 0.15
        if (clipAt(store.state.clips, t)) player.seek(t)
      }
    }
  }, [recorded, store, player, showNotice, setSelection])

  const actions = useMemo(() => {
    const newZoomFocus = (): ZoomFocus => {
      if (cursor.valid) return { mode: 'cursor' }
      // The centre of the part of the recording that is shown, stored in the whole frame.
      const at = fromCrop(cropOf(store.state), { x: 0.5, y: 0.5 })
      return { mode: 'fixed', x: at.x, y: at.y }
    }

    // Zooms and text go on the frame the preview shows at `t` (in a cut, the next kept one), like
    // shapes (playheadItems.ts): placed at a cut's source time they would never be seen.
    const addZoomAt = (t: number, lead: number): void => {
      const p = store.state
      const r = insertZoom(p.zooms, displayTime(p.clips, t), p.duration, { lead, focus: newZoomFocus(), scale: zoomSettingsOf(p).defaultScale })
      if (r.ok) {
        store.update((q) => ({ ...q, zooms: r.zooms }))
        setSelection({ kind: 'zoom', id: r.id })
      } else if (r.reason === 'inside') {
        setSelection({ kind: 'zoom', id: r.id })
        showNotice('There is already a zoom here, so it is selected instead')
      } else {
        showNotice('No room for a new zoom here: move the playhead to free space or shorten a zoom')
      }
    }

    const addTextAt = (t: number): void => {
      const p = store.state
      const a = createAnnotation(displayTime(p.clips, t), p.duration, brandFontFor(p, 'text'))
      store.update((q) => ({ ...q, annotations: [...q.annotations, a] }))
      setSelection({ kind: 'annotation', id: a.id })
      if (player.time < a.start || player.time >= a.end) player.seek(a.start)
    }

    // Placed and shown exactly as from the Shapes panel and the timeline.
    const addShape = (kind: ShapeKind): void => void addShapeAt({ store, player }, kind, cursor, { onSelect: setSelection })
    const addSpotlight = (mode: Spotlight['mode']): void => void addSpotlightAt({ store, player }, mode, { onSelect: setSelection })

    const deleteClip = (id: string): void => {
      if (store.state.clips.length <= 1) {
        showNotice('The last clip cannot be removed')
        return
      }
      store.update((p) => ({ ...p, clips: removeClip(p.clips, id) }))
      setSelection(null)
    }

    const cut = (start: number, end: number): void => {
      const p = store.state
      const next = cutRange(p.clips, start, end)
      if (next === p.clips) {
        showNotice('Part of the recording has to stay in the video')
        return
      }
      if (Math.abs(outputDuration(next) - outputDuration(p.clips)) < 1e-6) {
        showNotice('That range is already cut')
        return
      }
      store.update((q) => ({ ...q, clips: next }))
      setSelection(null)
    }

    /** Zoom level commands: level of the selected zoom (else the zoom under the playhead). */
    const setZoomLevelKey = (level: number): void => {
      const group = latest.current.group
      if (group.keys.length >= 2) {
        // E-06: every selected zoom (made yours, as one edit).
        const zooms = group.keys.filter((k) => k.startsWith('zoom:'))
        if (!zooms.length) return showNotice('No zoom is selected')
        const ctx: FieldCtx = { crop: cropOf(store.state), cursorValid: cursor.valid, style: zoomStyleOf(store.state), background: store.state.style.background }
        store.update((q) => applyField(q, GROUP_FIELDS.find((f) => f.id === 'zoom.level')!, zooms, level, ctx).project)
        return showNotice(`Zoom level ${formatLevel(level)} for ${countOf(zooms.length, 'zoom')}`)
      }
      const sel = latest.current.selection
      const p = store.state
      const z = sel?.kind === 'zoom' ? p.zooms.find((x) => x.id === sel.id) : zoomAt(p.zooms, player.time)
      if (!z) {
        const keys = zoomLevelKeysHint(latest.current.keymap)
        showNotice(keys ? `Select a zoom first: ${keys}` : 'Select a zoom first')
        return
      }
      store.update((q) => ({ ...q, zooms: q.zooms.map((x) => (x.id === z.id ? setZoomLevelInView(cropOf(q), x, level) : x)) }))
      if (sel?.kind !== 'zoom') setSelection({ kind: 'zoom', id: z.id })
    }

    /** Chapter commands: moves the playhead to the next (or previous) chapter. */
    const goToChapter = (next: boolean): void => {
      const { chapters = [], clips } = store.state
      const c = next ? nextChapter(chapters, player.time, clips) : previousChapter(chapters, player.time, clips)
      if (c) return player.seek(c.t)
      const key = latest.current.keymap.addChapter[0]
      if (chapters.length) showNotice(next ? 'There is no chapter after the playhead' : 'There is no chapter before the playhead')
      else showNotice(`This video has no chapters yet${key ? `: press ${shortcutLabel(key)} to add one at the playhead` : ''}`)
    }

    /** Camera layout commands: the layout at the playhead (a new layout segment, or the one there changes). */
    const setLayout = (layout: CameraLayout): void => {
      if (!data.webcamUrl) return showNotice('This recording has no camera')
      const r = setLayoutAt(store.state, layout, player.time)
      if (!r.ok) {
        if (r.id) setSelection({ kind: 'layout', id: r.id })
        showNotice(layoutRefusal(r.reason, layout))
        return
      }
      store.update((q) => ({ ...q, layouts: r.layouts }))
      setSelection({ kind: 'layout', id: r.id })
      // A new change starts at the playhead, where it has not changed anything yet: show it.
      if (r.added) showLayout(player, store.state, r.id)
    }

    return {
      togglePlay: (): void => player.toggle(),
      addShape,
      addSpotlight,
      addZoomAt,
      addZoom: (): void => addZoomAt(player.time, zoomSettingsOf(store.state).transition),
      setZoomLevelKey,
      addZoomFromTrack: (t: number): void => addZoomAt(t, 0),
      addTextAt,
      addText: (): void => addTextAt(player.time),
      addTitle: (): void => void addTitleAt({ store, player }, { onSelect: setSelection }),
      addChapter: (): void => void addChapterAt({ store, player }, { onSelect: setSelection, onNotice: showNotice }),
      freezeFrame: (): void => addFreezeAt({ store, player }, { onSelect: setSelection, onNotice: showNotice }),
      toggleFreezeSound: (): void => toggleFreezeSound({ store, player }, latest.current.selection, { onSelect: setSelection, onNotice: showNotice }),
      goToChapter,
      setLayout,
      split: (): void => {
        const t = player.time
        const clips = store.state.clips
        if (!canSplitAt(clips, t)) {
          showNotice(clipAt(clips, t) ? 'Too close to the edge of a clip to split' : 'The playhead is in a cut: move it onto a clip to split')
          return
        }
        store.update((p) => ({ ...p, clips: splitAt(p.clips, t) }))
      },
      deleteClip,
      cut,
      restore: (start: number, end: number): void => {
        store.update((p) => ({ ...p, clips: restoreRange(p.clips, start, end, p.duration) }))
        setSelection(null)
      },
      restoreAll: (): void => {
        const before = store.state
        store.update((p) => {
          const c = p.clips
          if (c.length === 1 && c[0].start === 0 && c[0].end === p.duration && c[0].speed === 1) return p
          return { ...p, clips: [{ id: c[0].id, start: 0, end: p.duration, speed: 1 }] }
        })
        if (store.state === before) showNotice('Nothing is cut, trimmed or re-timed')
        else setSelection(null)
      },
      cutSelectedRange: (): void => {
        const sel = latest.current.selection
        if (sel?.kind === 'range') cut(sel.start, sel.end)
        else showNotice('Select a range first: Shift+drag on the clip track')
      },
      deleteSelection: (): void => {
        // The panel that had the keyboard may go with what it showed (§5.2).
        keepInspectorFocus()
        const group = latest.current.group
        if (group.keys.length >= 2) {
          // E-06: every selected item, in one undo step.
          const keys = group.keys
          store.update((p) => deleteItems(p, keys))
          setSelection(null)
          return showNotice(removedNotice('Deleted', keys.length, undoHint(latest.current.keymap)))
        }
        const sel = latest.current.selection
        if (!sel) return
        if (sel.kind === 'zoom') store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== sel.id) }))
        else if (sel.kind === 'annotation') store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== sel.id) }))
        else if (sel.kind === 'shape') store.update((p) => ({ ...p, shapes: (p.shapes ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'spotlight') store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'layout') store.update((p) => ({ ...p, layouts: removeLayout(p.layouts, sel.id) }))
        else if (sel.kind === 'title') store.update((p) => ({ ...p, titles: (p.titles ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'chapter') store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'caption')
          store.update((p) => (p.transcript ? { ...p, transcript: { ...p.transcript, segments: p.transcript.segments.filter((s) => s.id !== sel.id) } } : p))
        else if (sel.kind === 'freeze') store.update((p) => removeFreeze(p, sel.id))
        else if (sel.kind === 'overlay') store.update((p) => ({ ...p, overlays: (p.overlays ?? []).filter((o) => o.id !== sel.id) }))
        else if (sel.kind === 'clip') return deleteClip(sel.id)
        else if (sel.kind === 'range') return cut(sel.start, sel.end)
        else if (sel.kind === 'click') {
          // Delete on a click ignores it; the click stays selected, so the Zoom panel shows its new state.
          const row = clickRows(recorded, store.state.inputEdits).find((r) => r.ms === sel.ms)
          if (row?.ignored) return showNotice('This click is already ignored: use it again in the Zoom panel')
          return input.setIgnored([sel.ms], true)
        } else return
        setSelection(null)
      },
      undo: (): void => {
        setCropDraft(null)
        if (!store.undo()) showNotice('Nothing to undo')
      },
      redo: (): void => {
        setCropDraft(null)
        if (!store.redo()) showNotice('Nothing to redo')
      },
      step: (delta: number): void => player.seek(stepOutput(store.state.clips, player.time, delta)),
      goToStart: (): void => player.seek(keptBounds(store.state.clips).start),
      goToEnd: (): void => player.seek(keptBounds(store.state.clips).end)
    }
  }, [cursor, recorded, input, data.webcamUrl, player, store, showNotice, setSelection])

  const focusFor = useCallback(
    (zoom: ZoomSegment) => {
      // An auto zoom's own click, else where the camera would be in its middle (the focus path is
      // in the crop's view; without cursor data, its centre), inside the part of the recording that
      // is shown.
      const c = scene.crop ?? null
      // The stored crop, not the scene's: the crop tool shows the whole frame while it is open.
      if (!cursor.valid) return fromCrop(cropOf(project), { x: 0.5, y: 0.5 })
      const p = clampIntoCrop(c, zoom.anchor ?? fromCrop(c, focusPath.at((zoom.start + zoom.end) / 2)))
      return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
    },
    [cursor.valid, focusPath, scene.crop, project]
  )

  const onBackgroundImage = useCallback(async () => {
    const picked = await window.api.pickBackgroundImage(store.state.id).catch((err: unknown) => {
      showNotice((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      return null
    })
    if (!picked) return
    store.update((p) => ({ ...p, style: { ...p.style, background: { type: 'image', path: picked.path } } }))
    setBackgroundVersion((v) => v + 1)
  }, [store, showNotice])

  const exitPick = useCallback(() => setPickFocus(false), [])

  const openExport = useCallback((): void => {
    player.pause()
    releaseFocus()
    setPickFocus(false)
    setCropDraft(null)
    setExporting(true)
  }, [player])

  /* ---------- crop ---------- */

  const cropActions = useMemo(() => {
    /** Applies `rect` (null: the whole recording) as one undo step, rebasing the automatic zooms; false when nothing changes. */
    const apply = (rect: NormRect | null): boolean => {
      const p = store.state
      const outcome = setCrop(p, rect, effectiveTrack(recorded, p))
      if (outcome.project === p) return false
      store.update(() => outcome.project)
      showNotice(cropNotice(outcome))
      return true
    }
    /** The draft (or, without one, the crop) with the taskbar cut off; null when the recording does not show it. */
    const withoutTaskbar = (r: NormRect): NormRect | null => {
      const p = store.state
      const cut = taskbarCrop(r, p, recorded.scale)
      return cut && snapCrop(cut, p, { x: 0, y: 0 }, null)
    }
    return {
      /** Opens the crop tool on the current crop. */
      open: (): void => {
        setSelection(null)
        setPickFocus(false)
        setCropDraft((d) => d ?? { rect: cropOf(store.state) ?? { ...FULL_FRAME }, aspect: 'free' })
      },
      cancel: (): void => setCropDraft(null),
      /** Applies the draft (Done, Enter, a double-click on the box). */
      done: (draft: CropDraft | null): void => {
        setCropDraft(null)
        if (draft) apply(draft.rect)
      },
      reset: (): void => {
        if (!cropOf(store.state)) return showNotice('The recording is not cropped')
        apply(null)
      },
      taskbar: (): void => {
        const r = withoutTaskbar(cropOf(store.state) ?? FULL_FRAME)
        if (!r) return showNotice('This recording does not show the taskbar')
        if (!apply(r)) showNotice('The taskbar is already cropped out')
      },
      withoutTaskbar
    }
  }, [store, recorded, showNotice, setSelection])
  // The draft and its actions, for the keyboard and the stage.
  const cropRef = useRef(cropDraft)
  cropRef.current = cropDraft
  const applyCrop = useCallback(() => cropActions.done(cropRef.current), [cropActions])
  const applyCropRef = useRef(applyCrop)
  applyCropRef.current = applyCrop
  // A draft counts only while the tool is open: nothing late (a drag still held) opens it again.
  const editCropDraft = useCallback((d: CropDraft) => setCropDraft((cur) => (cur ? d : cur)), [])
  const cropTool = useMemo((): CropTool | null => (cropDraft ? { draft: cropDraft, onDraft: editCropDraft, onDone: applyCrop } : null), [cropDraft, editCropDraft, applyCrop])
  // Reset (the panel's or the palette's): while the tool is open it changes the draft, as its bar
  // does, and Done applies it.
  const resetCrop = useCallback(() => {
    if (cropRef.current) setCropDraft({ rect: { ...FULL_FRAME }, aspect: 'free' })
    else cropActions.reset()
  }, [cropActions])
  const onCrop = useCallback((action: 'edit' | 'reset') => (action === 'edit' ? cropActions.open() : resetCrop()), [cropActions, resetCrop])

  /* ---------- commands (palette and shortcuts) ---------- */

  const lastMotionBlur = useRef(store.state.effects.motionBlur || DEFAULT_EFFECTS.motionBlur)
  /** The `code` of the pause key (K) while it is held down: J and L then step one frame. */
  const pauseHeld = useRef<string | null>(null)
  /** What the Paste items key (Ctrl+V) runs: a newer clipboard image first (set with the commands). */
  const pasteKeyRef = useRef<() => void>(() => {})
  const commands = useMemo((): Record<CommandId, () => void> => {
    const turned = (what: string, on: boolean): void => showNotice(`${what} ${on ? 'on' : 'off'}`)
    const level = (key: string) => (): void => actions.setZoomLevelKey(ZOOM_LEVEL_PRESETS.find((p) => p.key === key)!.value)
    const showTab = (t: InspectorTab) => (): void => setTab(t)
    /** The cursor path range commands: the selected range straightened, or kept as recorded. */
    const pathRangeCommand = (mode: PathMode): void => {
      const sel = latest.current.selection
      if (!cursor.valid) return showNotice('This recording has no cursor data')
      if (store.state.capture.cursorInVideo) return showNotice('The recorded cursor is in the video')
      if (sel?.kind !== 'range') return showNotice('Select a range first: Shift+drag on the clip track')
      input.setPathRange(sel, mode)
    }
    /** J, K and L: a frame step instead while K is held. */
    const shuttle = (key: ShuttleKey): void => {
      const held = pauseHeld.current !== null
      if (key === 'reverse' && !held && !player.reversing && atOutputStart(store.state.clips, player.time)) return showNotice('At the start: nothing to play backwards')
      const { frameStep } = player.shuttle(key, held)
      if (frameStep) actions.step(frameStep / 30)
    }
    /* E-06: several items (docs/design/multi-select.md §4.4, §4.10-4.13). */
    const fieldCtx = (): FieldCtx => ({ crop: cropOf(store.state), cursorValid: cursor.valid, style: zoomStyleOf(store.state), background: store.state.style.background, focusFor })
    /** The selected items: the group, or the single selection when it can join one. */
    const selectedKeys = (): ItemKey[] => {
      const L = latest.current
      if (L.group.keys.length >= 2) return [...L.group.keys]
      const k = groupKeyOf(L.selection)
      return k ? [k] : []
    }
    const what = 'zooms, text, shapes, spotlights, title cards, chapters and freeze frames'
    const undo = (): string => undoHint(latest.current.keymap)
    const keyLabel = (id: CommandId): string => {
      const k = commandKeys(latest.current.keymap, id)[0]
      return k ? shortcutLabel(k) : ''
    }
    /** The open tab's track, for Ctrl+A before anything was pressed on the timeline. */
    const TAB_TRACK: Partial<Record<InspectorTab, ItemTrack>> = { zoom: 'zoom', text: 'text', shapes: 'shapes', images: 'images', clip: 'freezes' }
    const pasted = (r: PasteResult, total: number, verb?: string): void => {
      if (r.keys.length) selectKeys(r.keys, r.keys[0])
      showNotice(pasteNotice(r, total, verb))
    }
    const selectAll = (): void => {
      if (cropRef.current) return showNotice('Close the crop tool first')
      const L = latest.current
      const items = projectItems(store.state)
      const anchor = L.group.anchor ?? groupKeyOf(L.selection)
      const parsed = anchor ? parseItemKey(anchor) : null
      const track = parsed ? trackOfKind(parsed.kind) : (timelineRef.current?.lastTrack() ?? TAB_TRACK[L.tab] ?? null)
      const r = selectAllStep(items, selectedKeys(), track)
      if (r.scope !== 'none') {
        // The Selection view opens in place of the panel that may have the keyboard (§5.2).
        keepInspectorFocus()
        selectKeys(r.keys, anchor && r.keys.includes(anchor) ? anchor : r.keys[0])
      }
      showNotice(selectAllNotice(r.scope, r.keys, keyLabel('selectAll') || null))
    }
    const copySelected = (): ItemKey[] | null => {
      const keys = selectedKeys()
      if (!keys.length) {
        showNotice(latest.current.selection ? `Ctrl+C copies ${what}` : 'Select items to copy')
        return null
      }
      const clip = copyGroupItems(store.state, keys)
      if (!clip) return null
      itemClipboard.set(clip)
      noteItemCopy()
      return keys
    }
    const copySelectedItems = (): void => {
      const keys = copySelected()
      if (keys) showNotice(`Copied ${keys.length} item${keys.length === 1 ? '' : 's'}`)
    }
    const cutSelectedItems = (): void => {
      const sel = latest.current.selection
      if (!selectedKeys().length) {
        if (sel?.kind === 'clip' || sel?.kind === 'gap' || sel?.kind === 'range') return showNotice(`To cut part of the recording, press ${keyLabel('deleteSelection') || 'Delete'}`)
        return showNotice(sel ? `Ctrl+X cuts ${what}` : 'Select items to cut')
      }
      const keys = copySelected()
      if (!keys) return
      keepInspectorFocus()
      store.update((p) => deleteItems(p, keys))
      setSelection(null)
      showNotice(removedNotice('Cut', keys.length, undo()))
    }
    const pasteItemsNow = (): void => {
      if (cropRef.current) return showNotice('Close the crop tool first')
      const clip = itemClipboard.get()
      if (!clip) return showNotice(nothingCopiedNotice(keyLabel('copyItems') || null))
      let r: PasteResult | null = null
      store.update((p) => (r = pasteGroupItems(p, clip, player.time)).project)
      if (r) pasted(r, clip.items.length)
    }
    // The key only: an image on the system clipboard that is newer than the copied items is added as
    // an image (brand kit, NW-12). The palette's "Paste items at playhead" always pastes the items.
    const pasteClipboard = (): void => {
      if (cropRef.current) return showNotice('Close the crop tool first')
      void pasteClipboardImage({ store, player }, { onSelect: setSelection }, !!itemClipboard.get()).then(
        (o) => (o ? showNotice(`Added ${o.name ?? 'the pasted image'} at the playhead`) : pasteItemsNow()),
        (err: unknown) => showNotice(ipcMessage(err))
      )
    }
    pasteKeyRef.current = pasteClipboard
    const duplicateSelected = (): void => {
      if (cropRef.current) return showNotice('Close the crop tool first')
      const keys = selectedKeys()
      if (!keys.length) return showNotice(latest.current.selection ? `Ctrl+D duplicates ${what}` : 'Select items to duplicate')
      let r: PasteResult | null = null
      store.update((p) => (r = duplicateGroupItems(p, keys)).project)
      if (r) pasted(r, keys.length, 'Duplicated')
    }
    const copyItemLook = (): void => {
      const L = latest.current
      if (L.group.keys.length >= 2) return showNotice('Select one item to copy its look')
      const k = groupKeyOf(L.selection)
      if (!k) return showNotice(L.selection ? 'This item has no look to copy' : 'Select an item to copy its look')
      if (k.startsWith('chapter:')) return showNotice('Chapters have no look to copy')
      const look = copyLook(store.state, k, fieldCtx())
      if (!look) return
      lookClipboard.set(look)
      showNotice(`Copied the ${look.label.toLowerCase()} look`)
    }
    const pasteItemLook = (): void => {
      if (cropRef.current) return showNotice('Close the crop tool first')
      const look = lookClipboard.get()
      if (!look) return showNotice(copyLookFirst(keyLabel('copyLook') || null))
      const keys = selectedKeys()
      const name = look.label.toLowerCase()
      if (!keys.length) return showNotice(`Select items to paste the ${name} look onto`)
      const before = store.state
      let r: ReturnType<typeof pasteLook> | null = null
      store.update((p) => (r = pasteLook(p, keys, look, fieldCtx())).project)
      const done = r as ReturnType<typeof pasteLook> | null
      if (!done || done.applied === 0) return showNotice(`Nothing to paste the ${name} look onto`)
      if (store.state === before) return showNotice('Already has this look')
      const [one, many] = LOOK_CLASS_WORDS[look.cls]
      const others = done.other ? ` · ${done.other === 1 ? `1 item is not a ${one}` : `${done.other} items are not ${many}`}, left as they were` : ''
      showNotice(`Pasted the ${name} look onto ${done.applied} ${done.applied === 1 ? one : many}${others}`)
    }
    /** Freeze sound on a group: every selected freeze goes to the opposite of the anchor's (or the first one's). */
    const toggleGroupFreezeSound = (): void => {
      const group = latest.current.group
      if (group.keys.length < 2) return actions.toggleFreezeSound()
      const freezes = group.keys.filter((k) => k.startsWith('freeze:'))
      if (!freezes.length) return showNotice('No freeze frame is selected')
      const lead = group.anchor?.startsWith('freeze:') ? group.anchor : freezes[0]
      const f = store.state.freezes?.find((x) => `freeze:${x.id}` === lead)
      if (!f) return
      const sound = f.sound === 'pause' ? 'continue' : 'pause'
      let refused = 0
      store.update((p) => {
        const r = applyField(p, GROUP_FIELDS.find((x) => x.id === 'freeze.sound')!, freezes, sound, fieldCtx())
        refused = r.refused
        return r.project
      })
      const n = countOf(freezes.length, 'freeze')
      const kept = refused ? ` · ${countOf(refused, 'freeze')} at the end ${refused === 1 ? 'keeps' : 'keep'} pausing the sound` : ''
      showNotice(sound === 'pause' ? `${n}: the recording waits with its sound paused` : `${n}: the sound keeps playing${kept}`)
    }

    /** > and <: the next preview speed (nothing is written to the project). */
    const previewSpeed = (step: 1 | -1): void => {
      const next = nextPreviewSpeed(player.previewSpeed, step)
      if (next === null) return showNotice(`The preview already plays at its ${step > 0 ? 'fastest' : 'slowest'} speed (${formatRate(player.previewSpeed)})`)
      player.setPreviewSpeed(next)
      showNotice(`Preview speed ${formatRate(next)} (the export is not affected)`)
    }
    return {
      play: actions.togglePlay,
      goToStart: actions.goToStart,
      goToEnd: actions.goToEnd,
      stepBack: () => actions.step(-1 / 30),
      stepForward: () => actions.step(1 / 30),
      jumpBack: () => actions.step(-1),
      jumpForward: () => actions.step(1),
      nextChapter: () => actions.goToChapter(true),
      prevChapter: () => actions.goToChapter(false),
      undo: actions.undo,
      redo: actions.redo,
      split: actions.split,
      deleteSelection: actions.deleteSelection,
      cutRange: actions.cutSelectedRange,
      restoreAll: actions.restoreAll,
      smartSpeed: () => {
        setTab('clip')
        setSmartSpeedRequest((n) => n + 1)
      },
      addZoom: actions.addZoom,
      addText: actions.addText,
      addArrow: () => actions.addShape('arrow'),
      addLine: () => actions.addShape('line'),
      addRect: () => actions.addShape('rect'),
      addEllipse: () => actions.addShape('ellipse'),
      addHighlight: () => actions.addShape('highlight'),
      addBlur: () => actions.addShape('blur'),
      addPixelate: () => actions.addShape('pixelate'),
      addSpotlight: () => actions.addSpotlight('region'),
      addCursorSpotlight: () => {
        if (cursor.valid) actions.addSpotlight('cursor')
        else showNotice('This recording has no cursor data: add a spotlight on an area instead')
      },
      addTitle: actions.addTitle,
      addChapter: actions.addChapter,
      layoutDefault: () => actions.setLayout('default'),
      layoutCameraOnly: () => actions.setLayout('camera-only'),
      layoutScreenOnly: () => actions.setLayout('screen-only'),
      layoutSideBySide: () => actions.setLayout('side-by-side'),
      layoutCameraLarge: () => actions.setLayout('camera-large'),
      directCamera: () => {
        const why = directUnavailable(!!data.webcamUrl, store.state.webcam.show)
        if (why) return showNotice(why)
        setTab('camera')
        setDirectorRequest((n) => n + 1)
      },
      zoomLevel0: level('0'),
      zoomLevel1: level('1'),
      zoomLevel2: level('2'),
      zoomLevel3: level('3'),
      zoomLevel4: level('4'),
      toggleCursor: () => {
        const p = store.state
        if (!cursor.valid || p.capture.cursorInVideo) return showNotice(cursor.valid ? 'The recorded cursor is already in the video' : 'This recording has no cursor data')
        store.update((q) => ({ ...q, cursor: { ...q.cursor, show: !p.cursor.show } }))
        turned('Smooth cursor', !p.cursor.show)
      },
      toggleClickEffects: () => {
        const p = store.state
        if (!cursor.valid) return showNotice('This recording has no cursor data')
        store.update((q) => ({ ...q, cursor: { ...q.cursor, clickEffect: !p.cursor.clickEffect } }))
        turned('Click effects', !p.cursor.clickEffect)
      },
      toggleStraighten: () => {
        const p = store.state
        if (!cursor.valid || p.capture.cursorInVideo) return showNotice(cursor.valid ? 'The recorded cursor is in the video' : 'This recording has no cursor data')
        const on = !p.inputEdits?.straighten
        input.setStraighten(on)
        turned('Straighten moves', on)
      },
      straightenRange: () => pathRangeCommand('straight'),
      recordedPathRange: () => pathRangeCommand('recorded'),
      toggleClickAtPlayhead: () => {
        if (!recorded.valid) return showNotice('This recording has no cursor data')
        const p = store.state
        const row = clickAtPlayhead(clickRows(recorded, p.inputEdits), p.zooms, player.time)
        if (!row) return showNotice('No click near the playhead')
        input.setIgnored([row.ms], !row.ignored)
      },
      findStrayClicks: () => {
        if (!recorded.valid) return showNotice('This recording has no cursor data')
        input.findStray()
      },
      useAllClicks: () => {
        if (!recorded.valid) return showNotice('This recording has no cursor data')
        input.useAll()
      },
      toggleMotionBlur: () => {
        const was = store.state.effects.motionBlur
        if (was > 0) lastMotionBlur.current = was
        const next = was > 0 ? 0 : lastMotionBlur.current
        store.update((q) => ({ ...q, effects: { ...q.effects, motionBlur: next } }))
        turned('Motion blur', next > 0)
      },
      toggleKeystrokes: () => {
        const on = !store.state.effects.keystrokes.show
        store.update((q) => ({ ...q, effects: { ...q.effects, keystrokes: { ...q.effects.keystrokes, show: on } } }))
        turned('Keystroke overlay', on)
      },
      toggleWebcam: () => {
        if (!data.webcamUrl) return showNotice('This recording has no camera')
        const on = !store.state.webcam.show
        store.update((q) => ({ ...q, webcam: { ...q.webcam, show: on } }))
        turned('Camera', on)
      },
      generateCaptions: () => {
        setTab('captions')
        requestCaptions({ kind: 'generate' })
      },
      toggleCaptions: () => {
        if (!store.state.transcript?.segments.length) return showNotice('This video has no captions yet: generate them in the Captions tab')
        const on = !captionsOf(store.state).show
        store.update((q) => ({ ...q, captions: { ...captionsOf(q), show: on } }))
        turned('Captions', on)
      },
      exportCaptions: () => {
        if (!store.state.transcript?.segments.length) return showNotice('This video has no captions yet: generate them in the Captions tab')
        setTab('captions')
        requestCaptions({ kind: 'export' })
      },
      showCaptions: showTab('captions'),
      showStyle: showTab('style'),
      showCursor: showTab('cursor'),
      showZoom: showTab('zoom'),
      showClip: showTab('clip'),
      showText: showTab('text'),
      showShapes: showTab('shapes'),
      showEffects: showTab('effects'),
      showCamera: showTab('camera'),
      showAudio: showTab('audio'),
      timelineZoomIn: () => timelineRef.current?.zoomIn(),
      timelineZoomOut: () => timelineRef.current?.zoomOut(),
      timelineFit: () => timelineRef.current?.fit(),
      export: openExport,
      shortcuts: () => setDialog('shortcuts'),
      about: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'about' } })),
      commandPalette: () => setDialog('palette'),

      // E-01 polish
      polish: () => setDialog('polish'),

      // E-04 waveform: a view preference, so not an undo step (like the timeline zoom)
      toggleWaveform: () => {
        if (!store.state.hasAudio) return showNotice('This recording has no sound')
        const on = !waveformShown()
        setWaveformShown(on)
        turned('Audio waveform', on)
      },

      // E-05 snapping: an editor preference, not an edit (no undo step)
      toggleSnapping: () => turned('Snapping', snapPref.toggle()),

      // E-08 shuttle and preview speed
      shuttleReverse: () => shuttle('reverse'),
      shuttlePause: () => shuttle('pause'),
      shuttleForward: () => shuttle('forward'),
      previewSpeedUp: () => previewSpeed(1),
      previewSpeedDown: () => previewSpeed(-1),

      // E-10 crop: while the tool is open, Reset and the taskbar preset change the draft, as its bar does.
      cropRecording: cropActions.open,
      resetCrop,
      cropTaskbar: () => {
        const draft = cropRef.current
        if (!draft) return cropActions.taskbar()
        const rect = cropActions.withoutTaskbar(draft.rect)
        if (rect) setCropDraft({ rect, aspect: 'free' })
        else showNotice('This recording does not show the taskbar')
      },

      // E-11 freeze frame
      freezeFrame: actions.freezeFrame,
      toggleFreezeSound: toggleGroupFreezeSound,

      // E-06 select several items (docs/design/multi-select.md §6)
      selectAll,
      copyItems: copySelectedItems,
      cutItems: cutSelectedItems,
      pasteItems: pasteItemsNow,
      duplicateItems: duplicateSelected,
      copyLook: copyItemLook,
      pasteLook: pasteItemLook
    }
  }, [actions, input, cursor.valid, recorded, player, data.webcamUrl, openExport, showNotice, store, cropActions, resetCrop, focusFor, selectKeys, setSelection])
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const runCommand = useCallback((id: CommandId) => commandsRef.current[id](), [])

  // What the timeline, the Inspector and the preview read about the group (E-06).
  const groupKeys = useMemo(() => new Set<string>(group.keys), [group])
  const singleKey = groupKeyOf(selection)
  const groupApi = useMemo(
    (): GroupApi => ({ group, keys: groupKeys, single: singleKey, select: selectKeys, notice: showNotice, command: runCommand }),
    [group, groupKeys, singleKey, selectKeys, showNotice, runCommand]
  )

  const closeDialog = useCallback(() => setDialog(null), [])
  const runFromPalette = useCallback((id: CommandId) => {
    setDialog(null)
    commandsRef.current[id]()
  }, [])

  // What the palette shows: worked out only while it is open, from the moment it opened.
  const paletteEntries = useMemo((): PaletteEntry[] => {
    if (dialog !== 'palette') return []
    const p = project
    const t = player.time
    const noCursor = 'This recording has no cursor data'
    const smoothCursor = cursor.valid && !p.capture.cursorInVideo
    const zoomTarget = selection?.kind === 'zoom' || !!zoomAt(p.zooms, t)
    const edited = p.clips.length > 1 || p.clips[0].start > 0 || p.clips[0].end < p.duration || p.clips[0].speed !== 1
    const freezeRefused = freezeRefusal(p, t)?.refused
    const unavailable: Partial<Record<CommandId, string | null>> = {
      undo: store.canUndo ? null : 'Nothing to undo',
      redo: store.canRedo ? null : 'Nothing to redo',
      split: canSplitAt(p.clips, t) ? null : clipAt(p.clips, t) ? 'Too close to the edge of a clip to split' : 'The playhead is in a cut',
      deleteSelection: (selection && selection.kind !== 'gap') || group.keys.length >= 2 ? null : 'Select something on the timeline first',
      cutRange: selection?.kind === 'range' ? null : 'Select a range first: Shift+drag on the clip track',
      restoreAll: edited ? null : 'Nothing is cut, trimmed or re-timed',
      addCursorSpotlight: cursor.valid ? null : noCursor,
      toggleCursor: smoothCursor ? null : cursor.valid ? 'The recorded cursor is already in the video' : noCursor,
      toggleClickEffects: cursor.valid ? null : noCursor,
      toggleWebcam: data.webcamUrl ? null : 'This recording has no camera',
      directCamera: directUnavailable(!!data.webcamUrl, p.webcam.show),
      nextChapter: nextChapter(p.chapters ?? [], t, p.clips) ? null : p.chapters?.length ? 'No chapter after the playhead' : 'No chapters yet',
      prevChapter: previousChapter(p.chapters ?? [], t, p.clips) ? null : p.chapters?.length ? 'No chapter before the playhead' : 'No chapters yet',
      toggleCaptions: p.transcript?.segments.length ? null : 'No captions yet',
      exportCaptions: p.transcript?.segments.length ? null : 'No captions yet',
      toggleClickAtPlayhead: cursor.valid ? null : noCursor,
      findStrayClicks: cursor.valid ? null : noCursor,
      useAllClicks: !cursor.valid ? noCursor : rows.some((r) => r.ignored) ? null : 'No click is ignored',
      toggleStraighten: smoothCursor ? null : cursor.valid ? 'The recorded cursor is in the video' : noCursor,
      freezeFrame: freezeRefused ? FREEZE_REFUSAL_TEXT[freezeRefused] : null,
      toggleFreezeSound: (group.keys.length >= 2 ? group.keys.some((k) => k.startsWith('freeze:')) : !!freezeTarget(p, selection, t)) ? null : 'Select a freeze frame first',
      resetCrop: cropOf(p) || cropDraft ? null : 'The recording is not cropped',
      cropTaskbar: taskbarCrop(cropDraft?.rect ?? cropOf(p) ?? FULL_FRAME, p, recorded.scale) ? null : 'This recording does not show the taskbar'
    }
    for (const k of ['straightenRange', 'recordedPathRange'] as const) {
      unavailable[k] = !cursor.valid
        ? noCursor
        : p.capture.cursorInVideo
          ? 'The recorded cursor is in the video'
          : selection?.kind === 'range'
            ? null
            : 'Select a range first: Shift+drag on the clip track'
    }
    for (const k of ['layoutDefault', 'layoutCameraOnly', 'layoutScreenOnly', 'layoutSideBySide', 'layoutCameraLarge'] as const) {
      unavailable[k] = data.webcamUrl ? null : 'This recording has no camera'
    }
    for (const k of ['zoomLevel0', 'zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const)
      unavailable[k] = (group.keys.length >= 2 ? group.keys.some((x) => x.startsWith('zoom:')) : zoomTarget) ? null : 'Select a zoom first'
    // E-06: the selection commands.
    const picked = group.keys.length >= 2 ? group.keys : groupKeyOf(selection) ? [groupKeyOf(selection)!] : []
    const look = lookClipboard.get()
    unavailable.selectAll = cropDraft ? 'Close the crop tool first' : projectItems(p).length ? null : 'No items to select yet'
    unavailable.copyItems = picked.length ? null : 'Select items to copy'
    unavailable.cutItems = picked.length ? null : 'Select items to cut'
    unavailable.duplicateItems = picked.length ? null : 'Select items to duplicate'
    unavailable.pasteItems = itemClipboard.get() ? null : 'Nothing copied yet'
    unavailable.copyLook =
      group.keys.length >= 2 ? 'Select one item to copy its look' : picked.length && lookClassOf(p, picked[0]) ? null : 'Select an item to copy its look'
    unavailable.pasteLook = !look ? 'Copy a look first' : picked.some((k) => lookClassOf(p, k) === look.cls) ? null : `The copied look is for ${LOOK_CLASS_WORDS[look.cls][1]}`
    unavailable.toggleWaveform = p.hasAudio ? null : 'This recording has no sound'
    if (nextPreviewSpeed(player.previewSpeed, 1) === null) unavailable.previewSpeedUp = `Already the fastest preview speed (${formatRate(player.previewSpeed)})`
    if (nextPreviewSpeed(player.previewSpeed, -1) === null) unavailable.previewSpeedDown = `Already the slowest preview speed (${formatRate(player.previewSpeed)})`
    const on: Partial<Record<CommandId, boolean>> = {
      toggleSnapping: snapPref.get(),
      toggleCursor: smoothCursor && p.cursor.show,
      toggleClickEffects: cursor.valid && p.cursor.clickEffect,
      toggleStraighten: smoothCursor && !!p.inputEdits?.straighten,
      toggleMotionBlur: p.effects.motionBlur > 0,
      toggleKeystrokes: p.effects.keystrokes.show,
      toggleWebcam: !!data.webcamUrl && p.webcam.show,
      toggleCaptions: !!p.transcript?.segments.length && captionsOf(p).show
    }
    on.toggleWaveform = p.hasAudio && waveformShown()
    return PALETTE_COMMANDS.map((info) => ({ info, shortcuts: commandKeys(keymap, info.id), unavailable: unavailable[info.id] ?? null, on: info.toggle ? !!on[info.id] : undefined }))
    // Recomputed when the palette opens or something it shows changes, not on every playhead move.
  }, [dialog, project, selection, group, keymap, cursor.valid, rows, data.webcamUrl, store, player, cropDraft, recorded.scale])

  const goBack = async (): Promise<void> => {
    if (leaving) return
    setLeaving(true)
    player.pause()
    // Wait for the save so the library shows the latest name and nothing is lost.
    const saved = await saver.flush()
    const status = saver.status
    if (!saved && !window.confirm(`Your latest changes could not be saved${status.state === 'error' ? `:\n${status.message}` : ''}.\n\nLeave the editor anyway?`)) {
      setLeaving(false)
      return
    }
    onClose()
  }

  /* ---------- keyboard ---------- */

  useEffect(() => installFocusRelease(), [])

  useEffect(() => {
    let spaceDown = false
    const onKeyDown = (e: KeyboardEvent): void => {
      const L = latest.current
      if (L.exporting) {
        // Editor shortcuts are off behind the export dialog. Escape acts as its own close
        // button, which the dialog only offers while no export is running.
        if (e.key === 'Escape') {
          const close = document.querySelector<HTMLButtonElement>('.modal .modal-head button[title="Close"]')
          if (close) {
            e.preventDefault()
            close.click()
          }
        }
        return
      }
      // The palette and the shortcuts dialog handle their own keys (Esc closes them).
      if (L.dialog) return
      const target = e.target instanceof Element ? e.target : null
      const chord = chordFromEvent(e)
      const id = chord ? matchShortcut(L.shortcuts, chord) : null
      if (isTextEntry(target)) {
        // Typing: only leave the field (Ctrl+Z stays the field's own undo), or open the palette.
        // Enter in a field of a form submits the form (e.g. naming a style preset) instead.
        if (id && commandInfo(id).inText) {
          e.preventDefault()
          if (!e.repeat) commandsRef.current[id]()
        } else if (e.key === 'Escape' || (e.key === 'Enter' && target instanceof HTMLInputElement && !target.form)) {
          e.preventDefault()
          ;(target as HTMLElement).blur()
        }
        return
      }
      // The crop tool: Esc closes it without applying, Enter applies it (a focused button takes Enter itself).
      if (cropRef.current && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !(target instanceof HTMLButtonElement)))) {
        e.preventDefault()
        if (e.key === 'Escape') setCropDraft(null)
        else if (!e.repeat) applyCropRef.current()
        return
      }
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (L.pickFocus) setPickFocus(false)
        else {
          keepInspectorFocus()
          setSelection(null)
        }
        return
      }
      // E-06: Ctrl+A/C/X/V run their standard commands when the keymap has nothing for them; Ctrl+C
      // and Ctrl+X leave text selected on the page to the system (a hint's text can still be copied).
      const run = id ?? (chord ? standardEditCommand(chord) : null)
      if (!chord || !run) return
      if (!id && (run === 'copyItems' || run === 'cutItems')) {
        const text = window.getSelection()
        if (text && !text.isCollapsed) return
      }
      // A focused slider keeps its own arrow, Home and End keys.
      if (isRangeInput(target) && isSliderKey(chord)) return
      e.preventDefault()
      if (chord.key === 'Space') {
        // A focused toggle or button must not also react to Space (on key up).
        blurActiveControl()
        spaceDown = true
      }
      if (run === 'shuttlePause' && !e.repeat) pauseHeld.current = e.code
      if (e.repeat && !commandInfo(run).repeat) return
      if (run === 'pasteItems') pasteKeyRef.current()
      else commandsRef.current[run]()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === pauseHeld.current) pauseHeld.current = null
      if (spaceDown && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault()
        spaceDown = false
      }
    }
    // A key up lost to another window (Alt+Tab) must not leave the pause key held.
    const onBlur = (): void => {
      pauseHeld.current = null
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [setSelection])

  /* ---------- saving on close ---------- */

  useEffect(() => {
    // Closing the window or quitting tears the page down without unmounting React; save synchronously.
    const flush = (): void => {
      saver.flushSync()
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [saver])

  return (
    <EditorProviders services={services} keymap={keymap} group={groupApi}>
      <div className="app editor">
        <header className="titlebar">
          <button className="btn ghost" onClick={() => void goBack()} disabled={leaving} title="Back to recordings" aria-label="Back to recordings">
            <Icon name="back" />
          </button>
          <input
            className="title-input"
            aria-label="Recording name"
            value={project.name}
            onChange={(e) => {
              const name = e.target.value
              store.update((p) => ({ ...p, name }), 'name')
            }}
            onBlur={() => {
              // Saves never store an empty name (withSavedName); the field shows what they store.
              if (!store.state.name.trim()) store.update((p) => ({ ...p, name: UNTITLED }), 'name')
            }}
          />
          <div className="history-buttons">
            <button className="btn ghost icon-btn" onClick={actions.undo} disabled={!store.canUndo} title={withShortcut('Undo', keymap.undo)} aria-label="Undo">
              <EditorIcon name="undo" />
            </button>
            <button className="btn ghost icon-btn" onClick={actions.redo} disabled={!store.canRedo} title={withShortcut('Redo', keymap.redo)} aria-label="Redo">
              <EditorIcon name="redo" />
            </button>
          </div>
          <SaveIndicator saver={saver} />
          <div className="tb-spacer" />
          <SettingsButton />
          <button className="btn command-button" onClick={() => setDialog('palette')} title="Search every editor command" aria-label="Command palette">
            <SearchIcon size={14} />
            <span>Commands</span>
            {keymap.commandPalette[0] && <ShortcutKeys accelerator={keymap.commandPalette[0]} />}
          </button>
          <button className="btn ghost icon-btn" onClick={() => setDialog('shortcuts')} title={withShortcut('Keyboard shortcuts', keymap.shortcuts)} aria-label="Keyboard shortcuts">
            <EditorIcon name="keyboard" />
          </button>
          <button className="btn" data-testid="polish-open" onClick={() => setDialog('polish')} title={withShortcut(POLISH_BUTTON_TITLE, keymap.polish)}>
            <EditorIcon name="sparkle" size={16} /> Polish
          </button>
          <button className="btn primary" onClick={openExport} title={withShortcut('Export the video', keymap.export)}>
            <Icon name="download" size={16} /> Export
          </button>
        </header>

        <div className="editor-body">
          <div className="stage">
            <PreviewStage
              project={project}
              pickZoom={pickZoom}
              selectedAnnotation={selectedAnnotation}
              onTogglePlay={actions.togglePlay}
              onExitPick={exitPick}
              scene={scene}
              selection={selection}
              onSelect={setSelection}
              cropTool={cropTool}
            />
            {cropDraft && (
              <CropBar
                recorded={{ width: project.width, height: project.height }}
                draft={cropDraft}
                capture={project.capture}
                scale={recorded.scale}
                onDraft={editCropDraft}
                onDone={applyCrop}
                onCancel={cropActions.cancel}
              />
            )}
            <Transport
              clips={project.clips}
              freezes={project.freezes}
              notice={notice}
              onTogglePlay={actions.togglePlay}
              onSplit={actions.split}
              onAddZoom={actions.addZoom}
              onAddText={actions.addText}
            />
          </div>
          <Inspector
            tab={tab}
            onTab={setTab}
            smartSpeedRequest={smartSpeedRequest}
            directorRequest={directorRequest}
            project={project}
            selection={selection}
            revealSeq={revealSeq}
            groupReveal={groupReveal}
            onCommand={runCommand}
            onSelect={setSelection}
            cursor={cursor}
            recorded={recorded}
            clickRows={rows}
            input={input}
            hasWebcam={!!data.webcamUrl}
            pickFocus={pickFocus}
            onPickFocus={setPickFocus}
            focusFor={focusFor}
            onBackgroundImage={onBackgroundImage}
            onCrop={onCrop}
            onNotice={showNotice}
            onAddText={actions.addText}
            onSplit={actions.split}
            onDeleteClip={actions.deleteClip}
            onRestore={actions.restore}
            onCutRange={actions.cut}
          />
        </div>

        <Timeline
          ref={timelineRef}
          duration={project.duration}
          clips={project.clips}
          zooms={project.zooms}
          zoomStyle={zoomStyleOf(project)}
          annotations={project.annotations}
          clickRows={rows}
          pathBars={pathBars}
          scrollBands={scrollBands}
          onSelectClick={input.selectClick}
          cursor={cursor}
          selection={selection}
          onSelect={setSelection}
          onAddZoom={actions.addZoomFromTrack}
          onAddText={actions.addTextAt}
          onRestore={actions.restore}
          onCutRange={actions.cut}
        />

        {exporting && (
          <ExportDialog
            project={project}
            scene={scene}
            screenUrl={data.screenUrl}
            webcamUrl={data.webcamUrl}
            background={background}
            onClose={() => setExporting(false)}
          />
        )}
        <OverlayDropZone onSelect={setSelection} onNotice={showNotice} />
        {dialog === 'palette' && <CommandPalette entries={paletteEntries} onRun={runFromPalette} onClose={closeDialog} />}
        {dialog === 'shortcuts' && <ShortcutsDialog keymap={keymap} onChange={changeKeymap} onClose={closeDialog} />}
        {dialog === 'polish' && (
          <PolishDialog
            recorded={recorded}
            hasCameraFile={!!data.webcamUrl}
            onClose={(message) => {
              setDialog(null)
              if (message) showNotice(message)
            }}
            onDone={({ changed, clipsChanged, summary }) => {
              setDialog(null)
              showNotice(polishNotice(summary, changed, undoHint(keymap)))
              if (clipsChanged) setSelection(null)
            }}
          />
        )}
      </div>
    </EditorProviders>
  )
}
