import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LoadedProject } from '../../../shared/api'
import { createAnnotation } from '../../../shared/editor/annotations'
import { Autosaver } from '../../../shared/editor/autosave'
import { canSplitAt, clipAt, correctProjectMedia, restoreRange, stepOutput } from '../../../shared/editor/clips'
import { EditStore } from '../../../shared/editor/editStore'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { clamp } from '../../../shared/engine/math'
import { cutRange, keptBounds, outputDuration, removeClip, splitAt } from '../../../shared/engine/timeline'
import { insertZoom, isUsableClick, ZOOM_TRANSITION } from '../../../shared/engine/zoom'
import type { Project, ZoomFocus, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { EditorContext, type EditorServices } from '../editor/context'
import { EditorIcon } from '../editor/EditorIcon'
import { ExportDialog } from '../editor/ExportDialog'
import { blurActiveControl, installFocusRelease, isRangeInput, isTextEntry, releaseFocus } from '../editor/focus'
import { Inspector } from '../editor/Inspector'
import { createVideo, loadImage } from '../editor/media'
import { PreviewPlayer } from '../editor/player'
import { PreviewStage } from '../editor/PreviewStage'
import { SaveIndicator } from '../editor/SaveIndicator'
import { validSelection, type Selection } from '../editor/selection'
import { Timeline, type TimelineHandle } from '../editor/Timeline'
import { Transport } from '../editor/Transport'
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
  try {
    await whenMetadata(screen)
  } catch (err) {
    for (const v of [screen, webcam]) v?.removeAttribute('src')
    throw err
  }
  // Correct duration and size from the file before anything (or any undo step) depends on them.
  const project = correctProjectMedia(data.project, { duration: screen.duration, width: screen.videoWidth, height: screen.videoHeight })
  const store = new EditStore(project)
  const saver = new Autosaver(store, {
    save: (p, meta) => window.api.saveProject(p, meta),
    saveSync: (p, meta) => window.api.saveProjectSync(p, meta)
  })
  if (project !== data.project) saver.markDirty()
  const player = new PreviewPlayer(screen, webcam, project)
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

  useEffect(() => {
    if (data.backgroundUrl) void loadImage(data.backgroundUrl).then(setBackground).catch(() => undefined)
  }, [data])

  /* ---------- scene + preview ---------- */

  const cursorPath = useMemo(() => new SmoothedTrack(cursor.samples, project.duration, project.cursor.smoothing), [cursor.samples, project.duration, project.cursor.smoothing])
  const focusPath = useMemo(() => new SmoothedTrack(cursor.samples, project.duration, 1), [cursor.samples, project.duration])
  const scene: RenderScene = useMemo(() => ({ project, cursor, cursorPath, focusPath }), [project, cursor, cursorPath, focusPath])

  useEffect(() => player.setProject(project), [player, project])
  useEffect(() => player.setScene(scene, background), [player, scene, background])

  const pickZoom =
    pickFocus && selection?.kind === 'zoom' ? (project.zooms.find((z) => z.id === selection.id && z.focus.mode === 'fixed') ?? null) : null
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

  /* ---------- edit actions (stable; they read the store, not render-time values) ---------- */

  const latest = useRef({ selection, pickFocus, exporting })
  latest.current = { selection, pickFocus, exporting }

  const actions = useMemo(() => {
    const newZoomFocus = (): ZoomFocus => (cursor.valid ? { mode: 'cursor' } : { mode: 'fixed', x: 0.5, y: 0.5 })

    const addZoomAt = (t: number, lead: number): void => {
      const p = store.state
      const r = insertZoom(p.zooms, t, p.duration, { lead, focus: newZoomFocus() })
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

    return {
      togglePlay: (): void => player.toggle(),
      addZoomAt,
      addZoom: (): void => addZoomAt(player.time, ZOOM_TRANSITION),
      addZoomFromTrack: (t: number): void => addZoomAt(t, 0),
      addTextAt,
      addText: (): void => addTextAt(player.time),
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
      deleteSelection: (): void => {
        const sel = latest.current.selection
        if (!sel) return
        if (sel.kind === 'zoom') store.update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== sel.id) }))
        else if (sel.kind === 'annotation') store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== sel.id) }))
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
  }, [cursor, player, store, showNotice, setSelection])

  const focusFor = useCallback(
    (zoom: ZoomSegment) => {
      if (!cursor.valid) return { x: 0.5, y: 0.5 }
      const p = focusPath.at((zoom.start + zoom.end) / 2)
      return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
    },
    [cursor.valid, focusPath]
  )

  const onBackgroundImage = useCallback(async () => {
    const picked = await window.api.pickBackgroundImage(store.state.id)
    if (!picked) return
    setBackground(await loadImage(picked.url))
    store.update((p) => ({ ...p, style: { ...p.style, background: { type: 'image', path: picked.path } } }))
  }, [store])

  const exitPick = useCallback(() => setPickFocus(false), [])

  const openExport = (): void => {
    player.pause()
    releaseFocus()
    setPickFocus(false)
    setExporting(true)
  }

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
      const target = e.target instanceof Element ? e.target : null
      if (isTextEntry(target)) {
        // Typing: only leave the field. Ctrl+Z stays the field's own undo.
        if (e.key === 'Escape' || (e.key === 'Enter' && target instanceof HTMLInputElement)) {
          e.preventDefault()
          ;(target as HTMLElement).blur()
        }
        return
      }
      const key = e.key.toLowerCase()
      if (e.ctrlKey || e.metaKey) {
        if (e.altKey) return
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) actions.redo()
          else actions.undo()
        } else if (key === 'y') {
          e.preventDefault()
          actions.redo()
        }
        return
      }
      if (e.altKey) return
      if (e.code === 'Space' || e.key === ' ') {
        // Prevent a focused toggle or button from also reacting to Space.
        e.preventDefault()
        blurActiveControl()
        spaceDown = true
        if (!e.repeat) actions.togglePlay()
        return
      }
      const onSlider = isRangeInput(target)
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
          if (onSlider) return
          e.preventDefault()
          actions.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30))
          return
        case 'Home':
        case 'End':
          if (onSlider) return
          e.preventDefault()
          if (e.key === 'Home') actions.goToStart()
          else actions.goToEnd()
          return
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          actions.deleteSelection()
          return
        case 'Escape':
          if (L.pickFocus) setPickFocus(false)
          else setSelection(null)
          return
        case '+':
        case '=':
          timelineRef.current?.zoomIn()
          return
        case '-':
        case '_':
          timelineRef.current?.zoomOut()
          return
      }
      if (e.repeat) return
      if (key === 'z') actions.addZoom()
      else if (key === 't') actions.addText()
      else if (key === 's') actions.split()
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
  }, [actions])

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
    <EditorContext.Provider value={services}>
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
            <button className="btn ghost icon-btn" onClick={actions.undo} disabled={!store.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
              <EditorIcon name="undo" />
            </button>
            <button className="btn ghost icon-btn" onClick={actions.redo} disabled={!store.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
              <EditorIcon name="redo" />
            </button>
          </div>
          <SaveIndicator saver={saver} />
          <div className="tb-spacer" />
          <button className="btn primary" onClick={openExport}>
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
          annotations={project.annotations}
          clicks={clicks}
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
      </div>
    </EditorContext.Provider>
  )
}
