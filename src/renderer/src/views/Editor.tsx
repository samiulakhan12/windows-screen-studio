import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoadedProject } from '../../../shared/api'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { outputSize } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import { keptBounds, normalizeClips, outputDuration, sourceToOutput } from '../../../shared/engine/timeline'
import { newZoomId, normalizeZooms, ZOOM_TRANSITION } from '../../../shared/engine/zoom'
import type { Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { ExportDialog } from '../editor/ExportDialog'
import { Inspector } from '../editor/Inspector'
import { createVideo, loadImage } from '../editor/media'
import { Timeline } from '../editor/Timeline'
import { drawFrame, type RenderScene } from '../render/compositor'

const PREVIEW_HEIGHT = 720

export function Editor({ projectId, onClose }: { projectId: string; onClose: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedZoom, setSelectedZoom] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [background, setBackground] = useState<HTMLImageElement | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLVideoElement | null>(null)
  const webcamRef = useRef<HTMLVideoElement | null>(null)
  const dirty = useRef(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<Project | null>(null)

  // Load project + media.
  useEffect(() => {
    let disposed = false
    window.api
      .loadProject(projectId)
      .then((data) => {
        if (disposed) return
        const screen = createVideo(data.screenUrl)
        const webcam = data.webcamUrl ? createVideo(data.webcamUrl) : null
        if (webcam) webcam.muted = true
        screen.addEventListener('seeked', () => (dirty.current = true))
        screen.addEventListener('loadeddata', () => (dirty.current = true))
        webcam?.addEventListener('seeked', () => (dirty.current = true))
        screen.addEventListener('loadedmetadata', () => {
          // MediaRecorder timing can differ slightly from the encoded file; trust the file.
          // Likewise the encoded frame size can differ from the capture track's reported size.
          const d = screen.duration
          const { videoWidth: w, videoHeight: h } = screen
          setProject((p) => {
            if (!p) return p
            let next = p
            if (w > 0 && h > 0 && (p.width !== w || p.height !== h)) next = { ...next, width: w, height: h }
            if (Number.isFinite(d) && Math.abs(p.duration - d) >= 0.05) {
              const clips = p.clips.map((c) => (Math.abs(c.end - p.duration) < 0.05 ? { ...c, end: d } : c))
              next = { ...next, duration: d, clips: normalizeClips(clips, d), zooms: normalizeZooms(p.zooms, d) }
            }
            return next
          })
        })
        screenRef.current = screen
        webcamRef.current = webcam
        setLoaded(data)
        setProject(data.project)
        const start = keptBounds(data.project.clips).start
        setTime(start)
        screen.currentTime = start
        if (data.backgroundUrl) void loadImage(data.backgroundUrl).then(setBackground).catch(() => undefined)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      disposed = true
      for (const v of [screenRef.current, webcamRef.current]) {
        if (!v) continue
        v.pause()
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [projectId])

  // Debounced auto-save.
  useEffect(() => {
    if (!project || !loaded) return
    latest.current = project
    dirty.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void window.api.saveProject(project), 500)
  }, [project, loaded])

  // Flush pending save on unmount.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (latest.current) void window.api.saveProject(latest.current)
    },
    []
  )

  const update = useCallback((fn: (p: Project) => Project) => setProject((p) => (p ? fn(p) : p)), [])

  const samples = loaded?.cursor.samples
  const duration = project?.duration ?? 0
  const smoothing = project?.cursor.smoothing ?? 0.6
  const cursorPath = useMemo(() => new SmoothedTrack(samples ?? [], duration, smoothing), [samples, duration, smoothing])
  const focusPath = useMemo(() => new SmoothedTrack(samples ?? [], duration, 1), [samples, duration])
  const scene: RenderScene | null = useMemo(
    () => (project && loaded ? { project, cursor: loaded.cursor, cursorPath, focusPath } : null),
    [project, loaded, cursorPath, focusPath]
  )

  const size = project ? outputSize(project.style.aspectRatio, project.width, project.height, PREVIEW_HEIGHT) : { width: 1280, height: 720 }

  const seek = useCallback(
    (t: number) => {
      const screen = screenRef.current
      if (!screen || !project) return
      const clamped = clamp(t, 0, project.duration)
      screen.currentTime = clamped
      if (webcamRef.current) webcamRef.current.currentTime = Math.max(0, clamped - project.webcamOffset)
      setTime(clamped)
      dirty.current = true
    },
    [project]
  )

  const togglePlay = useCallback(() => {
    const screen = screenRef.current
    if (!screen || !project) return
    if (screen.paused) {
      const bounds = keptBounds(project.clips)
      if (screen.currentTime >= bounds.end - 0.05 || screen.currentTime < bounds.start) seek(bounds.start)
      void screen.play()
      if (webcamRef.current) void webcamRef.current.play()
      setPlaying(true)
    } else {
      screen.pause()
      webcamRef.current?.pause()
      setPlaying(false)
    }
  }, [project, seek])

  // Render loop.
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const bgRef = useRef(background)
  bgRef.current = background
  useEffect(() => {
    dirty.current = true
  }, [scene, background, size.width, size.height])

  useEffect(() => {
    let raf = 0
    let lastUi = 0
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const screen = screenRef.current
      const canvas = canvasRef.current
      const sc = sceneRef.current
      if (!screen || !canvas || !sc) return
      const playingNow = !screen.paused
      if (playingNow) {
        const t = screen.currentTime
        if (t >= keptBounds(sc.project.clips).end) {
          screen.pause()
          webcamRef.current?.pause()
          setPlaying(false)
        }
        const cam = webcamRef.current
        if (cam) {
          const want = t - sc.project.webcamOffset
          if (Math.abs(cam.currentTime - want) > 0.15) cam.currentTime = Math.max(0, want)
        }
        if (now - lastUi > 50) {
          lastUi = now
          setTime(t)
        }
      }
      if (!playingNow && !dirty.current) return
      dirty.current = false
      const ctx = canvas.getContext('2d')
      if (ctx) drawFrame(ctx, canvas.width, canvas.height, screen.currentTime, sc, { screen, webcam: webcamRef.current, background: bgRef.current })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const addZoomAt = useCallback(
    (t: number) => {
      if (!project) return
      const start = clamp(t - ZOOM_TRANSITION, 0, project.duration)
      const id = newZoomId()
      const zooms = normalizeZooms(
        [...project.zooms, { id, start, end: Math.min(project.duration, start + 3), scale: 2, focus: { mode: 'cursor' }, auto: false }],
        project.duration
      )
      setProject({ ...project, zooms })
      if (zooms.some((z) => z.id === id)) setSelectedZoom(id)
    },
    [project]
  )

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZoom) {
        update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== selectedZoom) }))
        setSelectedZoom(null)
      } else if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey) {
        addZoomAt(time)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        seek(time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, selectedZoom, update, addZoomAt, seek, time])

  if (error) {
    return (
      <div className="app">
        <header className="titlebar">
          <button className="btn ghost" onClick={onClose}>
            <Icon name="back" /> Back
          </button>
        </header>
        <div className="center-message error">Could not open this recording: {error}</div>
      </div>
    )
  }

  if (!project || !loaded || !scene) {
    return (
      <div className="app">
        <div className="overlay">
          <div className="spinner" />
          <p>Opening recording…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app editor">
      <header className="titlebar">
        <button className="btn ghost" onClick={onClose} title="Back to recordings">
          <Icon name="back" />
        </button>
        <input className="title-input" value={project.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
        <div className="tb-spacer" />
        <button className="btn primary" onClick={() => setExporting(true)}>
          <Icon name="download" size={16} /> Export
        </button>
      </header>

      <div className="editor-body">
        <div className="stage">
          <div className="canvas-wrap">
            <canvas
              ref={canvasRef}
              width={size.width}
              height={size.height}
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
              onClick={togglePlay}
            />
          </div>
          <div className="transport">
            <button className="btn round" onClick={togglePlay} title="Play / pause (Space)">
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <span className="timecode">
              {formatTime(sourceToOutput(project.clips, time) ?? 0)} <span className="muted">/ {formatTime(outputDuration(project.clips))}</span>
            </span>
            <div className="tb-spacer" />
            <button className="btn ghost" onClick={() => addZoomAt(time)} title="Add zoom at playhead (Z)">
              <Icon name="zoom" size={16} /> Add zoom
            </button>
          </div>
        </div>
        <Inspector
          project={project}
          update={update}
          selectedZoom={selectedZoom}
          setSelectedZoom={setSelectedZoom}
          clicks={loaded.cursor.clicks}
          cursorValid={loaded.cursor.valid}
          hasWebcam={!!loaded.webcamUrl}
          onBackgroundImage={async () => {
            const picked = await window.api.pickBackgroundImage(project.id)
            if (!picked) return
            setBackground(await loadImage(picked.url))
            update((p) => ({ ...p, style: { ...p.style, background: { type: 'image', path: picked.path } } }))
          }}
        />
      </div>

      <Timeline
        project={project}
        update={update}
        time={time}
        onSeek={seek}
        clicks={loaded.cursor.clicks}
        selectedZoom={selectedZoom}
        setSelectedZoom={setSelectedZoom}
        onAddZoom={addZoomAt}
      />

      {exporting && (
        <ExportDialog
          project={project}
          scene={scene}
          screenUrl={loaded.screenUrl}
          webcamUrl={loaded.webcamUrl}
          background={background}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  )
}
