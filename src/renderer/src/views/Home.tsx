import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProcessingProgress, RegionSelection, UnfinishedRecording, WindowCaptureSupport } from '../../../shared/api/recording'
import { formatTime } from '../../../shared/engine/project'
import type { CaptureSource, ProjectSummary } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { runRecording, type RecordingPhase } from '../recorder/controller'
import { cameras, listInputDevices, meterMicrophone, microphones, onDevicesChanged, type InputDevices } from '../recorder/devices'
import { CameraPreview, Keys, RecordingOptions } from '../recorder/RecordingOptions'
import { friendlyError, PROCESSING_DEFERRED, SOURCE_GONE, type RecorderError } from '../../../shared/recording/errors'
import { hotkeyLabel, type HotkeyAction } from '../../../shared/recording/hotkeys'
import { applyRecordingPatch, DEFAULT_RECORDING_SETTINGS, type RecordingSettings, type RecordingSettingsPatch } from '../../../shared/recording/settings'
import '../recorder/recorder.css'

const PREFS_KEY = 'recorder-prefs'

type Mode = 'screen' | 'window' | 'region'
type SourceKind = CaptureSource['kind']

interface Prefs {
  micId: string | null
  cameraId: string | null
  systemAudio: boolean
  /** Record keyboard activity: shortcuts for the keystroke overlay and when typing happened (never which keys). */
  captureKeys: boolean
  mode: Mode
  /** Last area picked on each screen. */
  regions: Record<string, RegionSelection>
  /** The recording options section is unfolded. */
  optionsOpen: boolean
}

const DEFAULT_PREFS: Prefs = { micId: null, cameraId: null, systemAudio: true, captureKeys: true, mode: 'screen', regions: {}, optionsOpen: false }

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
      if (!['screen', 'window', 'region'].includes(p.mode)) p.mode = 'screen'
      if (!p.regions || typeof p.regions !== 'object') p.regions = {}
      return p
    }
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  return { ...DEFAULT_PREFS }
}

interface ErrorState {
  message: string
  privacy: 'microphone' | 'camera' | null
}

const toErrorState = (err: unknown): ErrorState => {
  const e = friendlyError(err)
  return { message: e.message, privacy: e.privacy }
}

const PHASE_LABEL: Record<RecordingPhase, string> = {
  preparing: 'Preparing…',
  countdown: 'Starting…',
  recording: 'Recording…',
  saving: 'Saving…'
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

/** The recording options (app settings, kept by the main process), from the last visit to Home. */
let settingsCache: RecordingSettings | null = null

/** Notices from a recording that went straight to the editor, shown when Home is next opened. */
let carriedNotices: string[] = []

/**
 * Capture sources from the last listing, kept across visits to Home so returning from
 * the editor shows them at once; each kind is refreshed in the background, and only
 * the kind the current tab needs is listed (thumbnails cost the main process time).
 */
let sourceCache: CaptureSource[] = []

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * What window recordings get on this PC: asked when the Windows tab is shown, and kept once
 * the answer is that they get effects. A "no" is asked again on the next visit (a first start
 * of the helper can be too slow for the check), meanwhile showing the last answer.
 */
let windowSupport: Promise<WindowCaptureSupport> | null = null
/** The answer, once known (so returning to Home shows the hint at once). */
let knownWindowSupport: WindowCaptureSupport | null = null

function loadWindowSupport(): Promise<WindowCaptureSupport> {
  windowSupport ??= window.api.getWindowCaptureSupport().then(
    (s) => {
      if (!s.effects) windowSupport = null
      return (knownWindowSupport = s)
    },
    (err: unknown) => {
      console.warn('Could not check window capture support:', err)
      windowSupport = null
      return { effects: false, smoothCursor: false }
    }
  )
  return windowSupport
}

/** Says plainly what a window recording gets on this PC (shown once that is known). */
function WindowHint({ support, onArea }: { support: WindowCaptureSupport | null; onArea: () => void }): JSX.Element | null {
  if (!support) return null
  if (support.effects) {
    return (
      <p className="hint window-hint" data-support={support.smoothCursor ? 'full' : 'effects'}>
        {support.smoothCursor
          ? 'Window recordings get auto zoom, click highlights and the smooth cursor.'
          : 'Window recordings get auto zoom and click highlights. The Windows cursor stays in the video, so there is no smooth cursor: native window capture is not available on this PC.'}{' '}
        Moving the window is fine; a resized window is fitted into its starting size.
      </p>
    )
  }
  return (
    <p className="hint window-hint" data-support="none">
      Window recordings keep the Windows cursor in the video and have no auto zoom, click highlights or smooth cursor here.{' '}
      <button type="button" className="link-btn" onClick={onArea}>
        Record an area instead
      </button>{' '}
      to get them.
    </p>
  )
}

function RegionIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="icon">
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
      <rect x="8" y="8" width="8" height="8" rx="1" strokeDasharray="2 2" />
    </svg>
  )
}

function KeyboardIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="icon">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </svg>
  )
}

/** Whether the page is visible (the window is hidden while recording, minimised, …). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/** A device problem with a button to the Windows privacy setting that fixes it. */
function DeviceProblem({ problem, isWindows }: { problem: RecorderError; isWindows: boolean }): JSX.Element {
  return (
    <span className="device-warning device-problem" role="status">
      {problem.message}
      {problem.privacy && isWindows && (
        <button type="button" className="link-btn" onClick={() => void window.api.openPrivacySettings(problem.privacy!)}>
          Open privacy settings
        </button>
      )}
    </span>
  )
}

export function Home({ onOpenProject }: { onOpenProject: (id: string) => void }): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>(sourceCache)
  const [selected, setSelected] = useState<string | null>(null)
  const [inputs, setInputs] = useState<InputDevices>({ devices: [], blocked: { microphone: null, camera: null } })
  const [micProblem, setMicProblem] = useState<RecorderError | null>(null)
  const [camProblem, setCamProblem] = useState<RecorderError | null>(null)
  const [settings, setSettings] = useState<RecordingSettings>(() => settingsCache ?? DEFAULT_RECORDING_SETTINGS)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [unfinished, setUnfinished] = useState<UnfinishedRecording[]>([])
  const [phase, setPhase] = useState<RecordingPhase | null>(null)
  const [busy, setBusy] = useState<ProcessingProgress | null>(null)
  const [error, setError] = useState<ErrorState | null>(null)
  const [windowCapture, setWindowCapture] = useState<WindowCaptureSupport | null>(knownWindowSupport)
  const [notices, setNotices] = useState<string[]>(() => {
    const carried = carriedNotices
    carriedNotices = []
    return carried
  })
  // A ref, not state: a double click delivers both clicks before React re-renders.
  const running = useRef(false)
  const meterBar = useRef<HTMLDivElement>(null)
  /** Frees the camera preview at once (a recording is about to open the camera). */
  const releaseCamera = useRef<(() => void) | null>(null)
  const pageVisible = usePageVisible()
  const tab = prefs.mode
  const sourceKind: SourceKind = tab === 'window' ? 'window' : 'screen'

  const refreshSources = useCallback(async (kind: SourceKind) => {
    try {
      let list = await window.api.getSources([kind])
      // There is always at least one screen; an empty list is a capturer hiccup.
      for (let i = 0; i < 2 && kind === 'screen' && list.length === 0; i++) {
        await sleep(700)
        list = await window.api.getSources([kind])
      }
      sourceCache = [...sourceCache.filter((s) => s.kind !== kind), ...list]
      setSources(sourceCache)
    } catch (err) {
      setError(toErrorState(err))
    }
  }, [])

  const refreshLibrary = useCallback(async () => {
    const [list, pending] = await Promise.all([window.api.listProjects(), window.api.listUnfinishedRecordings()])
    setProjects(list)
    setUnfinished(pending)
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      setInputs(await listInputDevices())
    } catch (err) {
      console.warn('Could not list media devices:', err)
    }
  }, [])

  useEffect(() => {
    let live = true
    window.api.getAppSettings().then(
      (s) => {
        settingsCache = s.recording
        if (live) setSettings(s.recording)
      },
      (err: unknown) => console.warn('Could not read the recording options:', err)
    )
    return () => {
      live = false
    }
  }, [])

  const updateSettings = useCallback(async (patch: RecordingSettingsPatch): Promise<void> => {
    // Shown at once; the main process validates and saves it.
    setSettings((current) => applyRecordingPatch(current, patch))
    try {
      const saved = await window.api.updateRecordingSettings(patch)
      settingsCache = saved.recording
      setSettings(saved.recording)
    } catch (err) {
      setError(toErrorState(err))
      void window.api.getAppSettings().then((s) => setSettings((settingsCache = s.recording)))
    }
  }, [])

  const setHotkey = useCallback(
    async (action: HotkeyAction, accelerator: string): Promise<string | null> => {
      if (accelerator) {
        const check = await window.api.checkHotkey(action, accelerator).catch((err: unknown) => ({ ok: false as const, message: friendlyError(err).message }))
        if (!check.ok) return check.message
        accelerator = check.accelerator
      }
      await updateSettings({ hotkeys: { [action]: accelerator } })
      return null
    },
    [updateSettings]
  )

  useEffect(() => {
    void refreshLibrary()
    // Enumerate once and on plug/unplug: never open the camera or mic just to list them.
    void refreshDevices()
    const offDevices = onDevicesChanged(() => void refreshDevices())
    const offProgress = window.api.onProcessing((p) => {
      if (!p.done) {
        setBusy(p)
        return
      }
      // The end of a run this Home did not start (it was reloaded meanwhile).
      if (!running.current) {
        setBusy(null)
        void refreshLibrary()
      }
    })
    return () => {
      offDevices()
      offProgress()
    }
  }, [refreshLibrary, refreshDevices])

  // Lists the kind of source the current tab shows (again on every visit, in the background).
  useEffect(() => {
    void refreshSources(sourceKind)
  }, [refreshSources, sourceKind])

  useEffect(() => {
    if (tab !== 'window') return
    let live = true
    void loadWindowSupport().then((s) => live && setWindowCapture(s))
    return () => {
      live = false
    }
  }, [tab])

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Ignore: preferences are a convenience.
    }
  }, [prefs])

  const update = (patch: Partial<Prefs>): void => setPrefs((p) => ({ ...p, ...patch }))
  const { devices, blocked } = inputs
  const mics = microphones(devices)
  const cams = cameras(devices)
  const listed = devices.length > 0
  const micMissing = listed && !!prefs.micId && !mics.some((m) => m.deviceId === prefs.micId)
  const camMissing = listed && !!prefs.cameraId && !cams.some((c) => c.deviceId === prefs.cameraId)
  const isWindows = window.api.platform === 'win32'

  const visible = sources.filter((s) => s.kind === sourceKind)
  // Screens default to the first one; windows must be picked explicitly.
  const current = visible.some((s) => s.id === selected) ? selected : tab !== 'window' ? (visible[0]?.id ?? null) : null
  const region = tab === 'region' && current ? (prefs.regions[current] ?? null) : null
  const idle = phase === null && !busy
  const canStart = idle && !!current && (tab !== 'region' || !!region)

  // Live level of the selected microphone, only while Home is idle and on screen.
  const meteredMic = idle && pageVisible && listed && !micMissing ? prefs.micId : null
  // Camera preview: the same rule; nothing runs for it otherwise.
  const previewedCam = idle && pageVisible && listed && !camMissing ? prefs.cameraId : null
  useEffect(() => {
    setMicProblem(null)
    const bar = meterBar.current
    if (!meteredMic || !bar) return
    return meterMicrophone(meteredMic, bar, setMicProblem)
  }, [meteredMic])

  const pickRegion = async (sourceId: string): Promise<void> => {
    if (running.current) return
    setSelected(sourceId)
    setError(null)
    try {
      const picked = await window.api.pickRegion(sourceId)
      if (picked) setPrefs((p) => ({ ...p, regions: { ...p.regions, [sourceId]: picked } }))
    } catch (err) {
      setError(toErrorState(err))
      void refreshSources('screen')
    }
  }

  const record = async (): Promise<void> => {
    if (running.current || !current) return
    running.current = true
    // The recorder opens the camera at full size in a moment: free the preview's hold on it now.
    releaseCamera.current?.()
    setError(null)
    setNotices([])
    const warnings: string[] = []
    const warn = (w: string): void => {
      warnings.push(w)
      // Shown on the processing overlay too, e.g. why a recording stopped by itself.
      setNotices([...new Set(warnings)])
    }
    if (micMissing) warn('The selected microphone is not connected, so the recording has no microphone.')
    if (camMissing) warn('The selected camera is not connected, so the recording has no camera.')
    let opened = false
    try {
      const id = await runRecording(
        {
          sourceId: current,
          region: tab === 'region' ? (region?.region ?? null) : null,
          systemAudio: prefs.systemAudio && isWindows,
          micId: micMissing ? null : prefs.micId,
          cameraId: camMissing ? null : prefs.cameraId,
          captureKeys: prefs.captureKeys
        },
        { onPhase: setPhase, onWarning: warn }
      )
      if (id) {
        opened = true
        carriedNotices = [...new Set(warnings)]
        onOpenProject(id)
      }
    } catch (err) {
      const state = toErrorState(err)
      if (state.message === PROCESSING_DEFERRED) warnings.push(state.message)
      else setError(state)
      if (state.message === SOURCE_GONE || /no longer available/.test(state.message)) void refreshSources(sourceKind)
    } finally {
      running.current = false
      if (!opened) {
        setNotices([...new Set(warnings)])
        setPhase(null)
        setBusy(null)
        void refreshLibrary()
      }
    }
  }

  const recover = async (item: UnfinishedRecording): Promise<void> => {
    if (running.current) return
    running.current = true
    setError(null)
    setNotices([])
    setBusy({ message: 'Recovering recording…', progress: null })
    try {
      onOpenProject(await window.api.recoverRecording(item.id))
    } catch (err) {
      const state = toErrorState(err)
      if (state.message === PROCESSING_DEFERRED) setNotices([state.message])
      else setError(state)
      setBusy(null)
      void refreshLibrary()
    } finally {
      running.current = false
    }
  }

  const removeUnfinished = async (item: UnfinishedRecording): Promise<void> => {
    if (!confirm(`Delete this unfinished recording (${formatBytes(item.bytes)})? This cannot be undone.`)) return
    await window.api.deleteProject(item.id)
    void refreshLibrary()
  }

  const setTab = (mode: Mode): void => {
    update({ mode })
    setError(null)
  }

  const overlay = busy ?? (phase === 'saving' ? { message: 'Saving recording…', progress: null } : null)
  // With a microphone selected the live meter tells whether it can be opened; without
  // one, say why the list may only show unnamed devices.
  const micHint = prefs.micId ? (micMissing ? null : micProblem) : blocked.microphone
  // A selected camera's preview tells whether it can be opened, like the microphone meter.
  const camBlocked = prefs.cameraId ? (camMissing ? null : (camProblem ?? blocked.camera)) : blocked.camera
  const stopKey = settings.hotkeys.stop ? hotkeyLabel(settings.hotkeys.stop) : ''

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" />
          Screen Studio <span className="muted">for Windows</span>
        </div>
      </header>

      <main className="home">
        <section className="panel sources">
          <div className="panel-head">
            <div className="segmented">
              <button className={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
                <Icon name="monitor" size={16} /> Screens
              </button>
              <button className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
                <Icon name="window" size={16} /> Windows
              </button>
              <button className={tab === 'region' ? 'active' : ''} onClick={() => setTab('region')}>
                <RegionIcon /> Area
              </button>
            </div>
            <button className="btn ghost" onClick={() => void refreshSources(sourceKind)} title="Refresh">
              <Icon name="refresh" size={16} />
            </button>
          </div>
          {tab === 'region' && (
            <p className="hint">Click a screen, then drag over the part you want to record.</p>
          )}
          <div className="source-grid">
            {visible.map((s) => (
              <button
                key={s.id}
                className={`source ${current === s.id ? 'selected' : ''}`}
                onClick={() => (tab === 'region' ? void pickRegion(s.id) : setSelected(s.id))}
              >
                {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="source-placeholder" aria-hidden="true" />}
                <span>{s.name}</span>
              </button>
            ))}
            {visible.length === 0 && <p className="muted empty">No {tab === 'window' ? 'windows' : 'screens'} found.</p>}
          </div>
          {tab === 'region' && region && current && (
            <div className="region-summary">
              <RegionIcon />
              <span className="region-dims">
                Area {region.width} × {region.height}
              </span>
              <button className="btn" onClick={() => void pickRegion(current)} disabled={!idle}>
                Change area
              </button>
            </div>
          )}
          {tab === 'window' && <WindowHint support={windowCapture} onArea={() => setTab('region')} />}
        </section>

        <aside className="panel record-panel">
          <h2>New recording</h2>
          <label className="field">
            <span>
              <Icon name="mic" size={16} /> Microphone
            </span>
            <select value={micMissing ? '' : (prefs.micId ?? '')} onChange={(e) => update({ micId: e.target.value || null })}>
              <option value="">No microphone</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || 'Microphone'}
                </option>
              ))}
            </select>
            {prefs.micId && !micMissing && (
              <div className={`mic-meter ${micProblem ? 'unavailable' : ''}`} title="Microphone level" aria-hidden="true">
                <div className="mic-meter-fill" ref={meterBar} />
              </div>
            )}
            {micMissing && <span className="device-warning">Your microphone is disconnected.</span>}
            {micHint && <DeviceProblem problem={micHint} isWindows={isWindows} />}
          </label>
          <label className="field">
            <span>
              <Icon name="camera" size={16} /> Camera
            </span>
            <select value={camMissing ? '' : (prefs.cameraId ?? '')} onChange={(e) => update({ cameraId: e.target.value || null })}>
              <option value="">No camera</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || 'Camera'}
                </option>
              ))}
            </select>
            {camMissing && <span className="device-warning">Your camera is disconnected.</span>}
            {camBlocked && <DeviceProblem problem={camBlocked} isWindows={isWindows} />}
          </label>
          {previewedCam && <CameraPreview deviceId={previewedCam} release={releaseCamera} onProblem={setCamProblem} />}
          <label className={`toggle ${!isWindows ? 'disabled' : ''}`}>
            <span>
              <Icon name="volume" size={16} /> System audio
            </span>
            <input
              type="checkbox"
              checked={prefs.systemAudio && isWindows}
              disabled={!isWindows}
              onChange={(e) => update({ systemAudio: e.target.checked })}
            />
          </label>
          <label
            className="toggle"
            title="Records shortcuts such as Ctrl + C for the keystroke overlay, and when you type so auto zoom can follow your typing. Which keys you type is never recorded."
          >
            <span>
              <KeyboardIcon /> Record keyboard activity
            </span>
            <input type="checkbox" aria-label="Record keyboard activity" checked={prefs.captureKeys} onChange={(e) => update({ captureKeys: e.target.checked })} />
          </label>
          <p className="hint toggle-hint">Shortcuts and when you type, never which keys.</p>
          <RecordingOptions
            settings={settings}
            open={prefs.optionsOpen}
            onToggle={() => update({ optionsOpen: !prefs.optionsOpen })}
            onChange={(patch) => void updateSettings(patch)}
            onHotkey={setHotkey}
            disabled={!idle}
            isWindows={isWindows}
          />
          <div className="record-footer">
            <button className="btn record" disabled={!canStart} onClick={() => void record()}>
              <span className="rec-dot" /> {phase ? PHASE_LABEL[phase] : tab === 'region' && !region ? 'Select an area first' : 'Start recording'}
            </button>
            <p className="hint">
              Stop with the floating bar{stopKey ? (
                <>
                  {' '}
                  or <Keys label={stopKey} />
                </>
              ) : null}
              .
            </p>
          </div>
          {notices.length > 0 && (
            <div className="notice">
              {notices.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
          )}
          {error && (
            <div className="home-error" role="alert">
              <span>{error.message}</span>
              {error.privacy && isWindows && (
                <button className="btn" onClick={() => void window.api.openPrivacySettings(error.privacy!)}>
                  Open privacy settings
                </button>
              )}
            </div>
          )}
        </aside>

        <section className="panel library">
          <div className="panel-head">
            <h2>Recent recordings</h2>
          </div>
          {projects.length === 0 && unfinished.length === 0 ? (
            <p className="muted empty">Your recordings will show up here.</p>
          ) : (
            <ul className="project-list">
              {unfinished.length > 0 && <li className="section-label">Unfinished recordings</li>}
              {unfinished.map((u) => (
                <li key={u.id} className="unfinished">
                  <div className="unfinished-info" title={u.error ?? undefined}>
                    <span className="project-name">{new Date(u.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <span className="muted">
                      {u.status === 'interrupted' ? 'Interrupted' : 'Processing failed'} · {formatBytes(u.bytes)}
                      {u.error ? ` · ${u.error}` : ''}
                    </span>
                  </div>
                  <button className="btn" disabled={!idle} onClick={() => void recover(u)} title="Turn the saved footage into a project">
                    {u.status === 'interrupted' ? 'Recover' : 'Retry'}
                  </button>
                  <button className="btn ghost" title="Show in Explorer" onClick={() => void window.api.revealProject(u.id)}>
                    <Icon name="folder" size={16} />
                  </button>
                  <button className="btn ghost danger" title="Delete" disabled={!idle} onClick={() => void removeUnfinished(u)}>
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
              {unfinished.length > 0 && projects.length > 0 && <li className="section-label">Projects</li>}
              {projects.map((p) => (
                <li key={p.id}>
                  <button className="project-open" onClick={() => onOpenProject(p.id)}>
                    <Icon name="film" />
                    <span className="project-name">{p.name}</span>
                    <span className="muted">{formatTime(p.duration, false)}</span>
                  </button>
                  <button className="btn ghost" title="Show in Explorer" onClick={() => void window.api.revealProject(p.id)}>
                    <Icon name="folder" size={16} />
                  </button>
                  <button
                    className="btn ghost danger"
                    title="Delete"
                    onClick={async () => {
                      if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return
                      await window.api.deleteProject(p.id)
                      void refreshLibrary()
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {overlay && (
        <div className="overlay" role="status">
          <div className="spinner" />
          <p>{overlay.message}</p>
          {overlay.progress !== null && (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(overlay.progress * 100)}%` }} />
              </div>
              <span className="muted">{Math.round(overlay.progress * 100)}%</span>
            </>
          )}
          {notices.length > 0 && (
            <div className="overlay-notices">
              {notices.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
          )}
          {busy && (
            <button className="btn" onClick={() => void window.api.finishProcessingLater()} title="Keep the recording and convert it later from Unfinished recordings">
              Finish later
            </button>
          )}
        </div>
      )}
    </div>
  )
}
