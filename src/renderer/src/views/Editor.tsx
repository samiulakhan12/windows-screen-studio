import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { LoadedProject } from '../../../shared/api'
import { openedWithoutStems, withRecordedStems } from '../../../shared/audio/settings'
import { createAnnotation } from '../../../shared/editor/annotations'
import { Autosaver } from '../../../shared/editor/autosave'
import { canSplitAt, clipAt, correctProjectMedia, displayTime, restoreRange, stepOutput } from '../../../shared/editor/clips'
import { commandInfo, PALETTE_COMMANDS, type CommandId } from '../../../shared/editor/commands'
import { EditStore } from '../../../shared/editor/editStore'
import { LAYOUT_NAMES, setLayoutAt } from '../../../shared/editor/layoutCommands'
import { mediaLength } from '../../../shared/editor/mediaLength'
import {
  chordFromEvent,
  DEFAULT_KEYMAP,
  isSliderKey,
  keymapFromPrefs,
  keymapOverrides,
  matchShortcut,
  serializeShortcuts,
  shortcutIndex,
  shortcutLabel,
  withShortcut,
  zoomLevelKeysHint,
  type Keymap
} from '../../../shared/editor/shortcuts'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { clamp } from '../../../shared/engine/math'
import { DEFAULT_EFFECTS } from '../../../shared/engine/project'
import { cutRange, keptBounds, outputDuration, removeClip, splitAt } from '../../../shared/engine/timeline'
import { nextChapter, previousChapter } from '../../../shared/editor/titles'
import { setZoomLevel, ZOOM_LEVEL_PRESETS } from '../../../shared/editor/zoomEdit'
import { focusPathFor, insertZoom, isUsableClick, zoomAt, zoomSettingsOf, zoomStyleOf } from '../../../shared/engine/zoom'
import type { CameraLayout, Project, ShapeKind, Spotlight, ZoomFocus, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { CommandPalette, SearchIcon, type PaletteEntry } from '../editor/CommandPalette'
import { EditorContext, type EditorServices } from '../editor/context'
import { EditorIcon } from '../editor/EditorIcon'
import { ExportDialog } from '../editor/ExportDialog'
import { blurActiveControl, installFocusRelease, isRangeInput, isTextEntry, releaseFocus } from '../editor/focus'
import { Inspector, type InspectorTab } from '../editor/Inspector'
import { KeymapContext } from '../editor/keymapContext'
import { createVideo, loadImage } from '../editor/media'
import { PreviewPlayer } from '../editor/player'
import { addShapeAt, addSpotlightAt } from '../editor/playheadItems'
import { PreviewStage } from '../editor/PreviewStage'
import { SaveIndicator } from '../editor/SaveIndicator'
import { validSelection, type Selection } from '../editor/selection'
import { ShortcutKeys } from '../editor/ShortcutKeys'
import { ShortcutsDialog } from '../editor/ShortcutsDialog'
import { addChapterAt, addTitleAt } from '../editor/titleItems'
import { Timeline, type TimelineHandle } from '../editor/Timeline'
import { Transport } from '../editor/Transport'
import { videoTrackDuration } from '../editor/videoTrack'
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
  const opened = openedWithoutStems(data.project, data.missingStems)
  const project = correctProjectMedia(opened, { duration, width: screen.videoWidth, height: screen.videoHeight })
  const store = new EditStore(project)
  const saver = new Autosaver(store, {
    save: (p, meta) => window.api.saveProject(withRecordedStems(p, data.project), meta),
    saveSync: (p, meta) => window.api.saveProjectSync(withRecordedStems(p, data.project), meta)
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

/** What the editor's components read from context: the session's services and the current shortcuts. */
function EditorProviders({ services, keymap, children }: { services: EditorServices; keymap: Keymap; children: ReactNode }): JSX.Element {
  return (
    <EditorContext.Provider value={services}>
      <KeymapContext.Provider value={keymap}>{children}</KeymapContext.Provider>
    </EditorContext.Provider>
  )
}

function EditorSession({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const { data, store, saver, player } = session
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const services = useMemo<EditorServices>(() => ({ store, player }), [store, player])
  const cursor = data.cursor
  const clicks = useMemo(() => cursor.clicks.filter(isUsableClick), [cursor])

  const [rawSelection, setRawSelection] = useState<Selection>(null)
  const [revealSeq, setRevealSeq] = useState(0)
  const selection = validSelection(rawSelection, project)
  const setSelection = useCallback((sel: Selection) => {
    setRawSelection(sel)
    if (sel) setRevealSeq((n) => n + 1)
  }, [])
  const [pickFocus, setPickFocus] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [background, setBackground] = useState<HTMLImageElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timelineRef = useRef<TimelineHandle>(null)
  const [tab, setTab] = useState<InspectorTab>('style')
  const [dialog, setDialog] = useState<'palette' | 'shortcuts' | null>(null)
  const [smartSpeedRequest, setSmartSpeedRequest] = useState(0)

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

  const cursorPath = useMemo(() => new SmoothedTrack(cursor.samples, project.duration, project.cursor.smoothing), [cursor.samples, project.duration, project.cursor.smoothing])
  const focusPath = useMemo(() => focusPathFor(cursor.samples, project.duration), [cursor.samples, project.duration])
  const scene: RenderScene = useMemo(() => ({ project, cursor, cursorPath, focusPath }), [project, cursor, cursorPath, focusPath])

  useEffect(() => player.setProject(project), [player, project])
  useEffect(() => player.setScene(scene, background), [player, scene, background])

  const pickZoom =
    pickFocus && selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id && z.focus.mode !== 'cursor') ?? null) : null
  useEffect(() => {
    player.setNoZoom(!!pickZoom)
    if (pickFocus && !pickZoom) setPickFocus(false)
  }, [player, pickFocus, pickZoom])
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

  const latest = useRef({ selection, pickFocus, exporting, dialog, keymap, shortcuts })
  latest.current = { selection, pickFocus, exporting, dialog, keymap, shortcuts }

  const actions = useMemo(() => {
    const newZoomFocus = (): ZoomFocus => (cursor.valid ? { mode: 'cursor' } : { mode: 'fixed', x: 0.5, y: 0.5 })

    const addZoomAt = (t: number, lead: number): void => {
      const p = store.state
      const r = insertZoom(p.zooms, t, p.duration, { lead, focus: newZoomFocus(), scale: zoomSettingsOf(p).defaultScale })
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
      const a = createAnnotation(t, store.state.duration)
      store.update((p) => ({ ...p, annotations: [...p.annotations, a] }))
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
      const sel = latest.current.selection
      const p = store.state
      const z = sel?.kind === 'zoom' ? p.zooms.find((x) => x.id === sel.id) : zoomAt(p.zooms, player.time)
      if (!z) {
        const keys = zoomLevelKeysHint(latest.current.keymap)
        showNotice(keys ? `Select a zoom first: ${keys}` : 'Select a zoom first')
        return
      }
      store.update((q) => ({ ...q, zooms: q.zooms.map((x) => (x.id === z.id ? setZoomLevel(x, level) : x)) }))
      if (sel?.kind !== 'zoom') setSelection({ kind: 'zoom', id: z.id })
    }

    /** Chapter commands: moves the playhead to the next (or previous) chapter. */
    const goToChapter = (next: boolean): void => {
      const chapters = store.state.chapters ?? []
      const c = next ? nextChapter(chapters, player.time) : previousChapter(chapters, player.time)
      if (c) return player.seek(c.t)
      const key = latest.current.keymap.addChapter[0]
      if (chapters.length) showNotice(next ? 'There is no chapter after the playhead' : 'There is no chapter before the playhead')
      else showNotice(`This video has no chapters yet${key ? `: press ${shortcutLabel(key)} to add one at the playhead` : ''}`)
    }

    /** Camera layout commands: the layout at the playhead (a new layout segment, or the one there changes). */
    const setLayout = (layout: CameraLayout): void => {
      if (!data.webcamUrl) return showNotice('This recording has no camera')
      const p = store.state
      const r = setLayoutAt(p, layout, displayTime(p.clips, player.time))
      if (!r.ok) {
        if (r.id) setSelection({ kind: 'layout', id: r.id })
        showNotice(r.reason === 'same' ? `The camera layout here already is: ${LAYOUT_NAMES[layout].toLowerCase()}` : 'No room for a new camera layout here: another one starts right after the playhead')
        return
      }
      store.update((q) => ({ ...q, layouts: r.layouts }))
      setSelection({ kind: 'layout', id: r.id })
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
        const sel = latest.current.selection
        if (!sel) return
        if (sel.kind === 'zoom') store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== sel.id) }))
        else if (sel.kind === 'annotation') store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== sel.id) }))
        else if (sel.kind === 'shape') store.update((p) => ({ ...p, shapes: (p.shapes ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'spotlight') store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'layout') store.update((p) => ({ ...p, layouts: (p.layouts ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'title') store.update((p) => ({ ...p, titles: (p.titles ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'chapter') store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((s) => s.id !== sel.id) }))
        else if (sel.kind === 'clip') return deleteClip(sel.id)
        else if (sel.kind === 'range') return cut(sel.start, sel.end)
        else return
        setSelection(null)
      },
      undo: (): void => {
        if (!store.undo()) showNotice('Nothing to undo')
      },
      redo: (): void => {
        if (!store.redo()) showNotice('Nothing to redo')
      },
      step: (delta: number): void => player.seek(stepOutput(store.state.clips, player.time, delta)),
      goToStart: (): void => player.seek(keptBounds(store.state.clips).start),
      goToEnd: (): void => player.seek(keptBounds(store.state.clips).end)
    }
  }, [cursor, data.webcamUrl, player, store, showNotice, setSelection])

  const focusFor = useCallback(
    (zoom: ZoomSegment) => {
      if (!cursor.valid) return { x: 0.5, y: 0.5 }
      // An auto zoom's own click, else where the camera would be in its middle.
      const p = zoom.anchor ?? focusPath.at((zoom.start + zoom.end) / 2)
      return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
    },
    [cursor.valid, focusPath]
  )

  const onBackgroundImage = useCallback(async () => {
    const picked = await window.api.pickBackgroundImage(store.state.id)
    if (!picked) return
    store.update((p) => ({ ...p, style: { ...p.style, background: { type: 'image', path: picked.path } } }))
    setBackgroundVersion((v) => v + 1)
  }, [store])

  const exitPick = useCallback(() => setPickFocus(false), [])

  const openExport = useCallback((): void => {
    player.pause()
    releaseFocus()
    setPickFocus(false)
    setExporting(true)
  }, [player])

  /* ---------- commands (palette and shortcuts) ---------- */

  const lastMotionBlur = useRef(store.state.effects.motionBlur || DEFAULT_EFFECTS.motionBlur)
  const commands = useMemo((): Record<CommandId, () => void> => {
    const turned = (what: string, on: boolean): void => showNotice(`${what} ${on ? 'on' : 'off'}`)
    const level = (key: string) => (): void => actions.setZoomLevelKey(ZOOM_LEVEL_PRESETS.find((p) => p.key === key)!.value)
    const showTab = (t: InspectorTab) => (): void => setTab(t)
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
      commandPalette: () => setDialog('palette')
    }
  }, [actions, cursor.valid, data.webcamUrl, openExport, showNotice, store])
  const commandsRef = useRef(commands)
  commandsRef.current = commands

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
    const unavailable: Partial<Record<CommandId, string | null>> = {
      undo: store.canUndo ? null : 'Nothing to undo',
      redo: store.canRedo ? null : 'Nothing to redo',
      split: canSplitAt(p.clips, t) ? null : clipAt(p.clips, t) ? 'Too close to the edge of a clip to split' : 'The playhead is in a cut',
      deleteSelection: selection && selection.kind !== 'gap' ? null : 'Select something on the timeline first',
      cutRange: selection?.kind === 'range' ? null : 'Select a range first: Shift+drag on the clip track',
      restoreAll: edited ? null : 'Nothing is cut, trimmed or re-timed',
      addCursorSpotlight: cursor.valid ? null : noCursor,
      toggleCursor: smoothCursor ? null : cursor.valid ? 'The recorded cursor is already in the video' : noCursor,
      toggleClickEffects: cursor.valid ? null : noCursor,
      toggleWebcam: data.webcamUrl ? null : 'This recording has no camera',
      nextChapter: nextChapter(p.chapters ?? [], t) ? null : p.chapters?.length ? 'No chapter after the playhead' : 'No chapters yet',
      prevChapter: previousChapter(p.chapters ?? [], t) ? null : p.chapters?.length ? 'No chapter before the playhead' : 'No chapters yet'
    }
    for (const k of ['layoutDefault', 'layoutCameraOnly', 'layoutScreenOnly', 'layoutSideBySide', 'layoutCameraLarge'] as const) {
      unavailable[k] = data.webcamUrl ? null : 'This recording has no camera'
    }
    for (const k of ['zoomLevel0', 'zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const) unavailable[k] = zoomTarget ? null : 'Select a zoom first'
    const on: Partial<Record<CommandId, boolean>> = {
      toggleCursor: smoothCursor && p.cursor.show,
      toggleClickEffects: cursor.valid && p.cursor.clickEffect,
      toggleMotionBlur: p.effects.motionBlur > 0,
      toggleKeystrokes: p.effects.keystrokes.show,
      toggleWebcam: !!data.webcamUrl && p.webcam.show
    }
    return PALETTE_COMMANDS.map((info) => ({ info, shortcuts: keymap[info.id], unavailable: unavailable[info.id] ?? null, on: info.toggle ? !!on[info.id] : undefined }))
    // Recomputed when the palette opens or something it shows changes, not on every playhead move.
  }, [dialog, project, selection, keymap, cursor.valid, data.webcamUrl, store, player])

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
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (L.pickFocus) setPickFocus(false)
        else setSelection(null)
        return
      }
      if (!chord || !id) return
      // A focused slider keeps its own arrow, Home and End keys.
      if (isRangeInput(target) && isSliderKey(chord)) return
      e.preventDefault()
      if (chord.key === 'Space') {
        // A focused toggle or button must not also react to Space (on key up).
        blurActiveControl()
        spaceDown = true
      }
      if (e.repeat && !commandInfo(id).repeat) return
      commandsRef.current[id]()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (spaceDown && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault()
        spaceDown = false
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
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
    <EditorProviders services={services} keymap={keymap}>
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
              // An empty name would leave a blank row in the library.
              if (!store.state.name.trim()) store.update((p) => ({ ...p, name: 'Untitled recording' }), 'name')
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
          <button className="btn command-button" onClick={() => setDialog('palette')} title="Search every editor command" aria-label="Command palette">
            <SearchIcon size={14} />
            <span>Commands</span>
            {keymap.commandPalette[0] && <ShortcutKeys accelerator={keymap.commandPalette[0]} />}
          </button>
          <button className="btn ghost icon-btn" onClick={() => setDialog('shortcuts')} title={withShortcut('Keyboard shortcuts', keymap.shortcuts)} aria-label="Keyboard shortcuts">
            <EditorIcon name="keyboard" />
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
            />
            <Transport
              clips={project.clips}
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
            project={project}
            selection={selection}
            revealSeq={revealSeq}
            onSelect={setSelection}
            cursor={cursor}
            hasWebcam={!!data.webcamUrl}
            pickFocus={pickFocus}
            onPickFocus={setPickFocus}
            focusFor={focusFor}
            onBackgroundImage={onBackgroundImage}
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
          clicks={clicks}
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
        {dialog === 'palette' && <CommandPalette entries={paletteEntries} onRun={runFromPalette} onClose={closeDialog} />}
        {dialog === 'shortcuts' && <ShortcutsDialog keymap={keymap} onChange={changeKeymap} onClose={closeDialog} />}
      </div>
    </EditorProviders>
  )
}
