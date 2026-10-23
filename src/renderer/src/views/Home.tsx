import { useCallback, useEffect, useState } from 'react'
import { formatTime } from '../../../shared/engine/project'
import type { CaptureSource, ProjectSummary } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { runRecording } from '../recorder/controller'

const PREFS_KEY = 'recorder-prefs'

interface Prefs {
  micId: string | null
  cameraId: string | null
  systemAudio: boolean
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) return { micId: null, cameraId: null, systemAudio: true, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { micId: null, cameraId: null, systemAudio: true }
}

async function listDevices(): Promise<MediaDeviceInfo[]> {
  // Labels are only exposed after media permission has been granted once.
  for (const constraints of [{ audio: true }, { video: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints)
      s.getTracks().forEach((t) => t.stop())
    } catch {
      // No device of this kind.
    }
  }
  return navigator.mediaDevices.enumerateDevices()
}

export function Home({ onOpenProject }: { onOpenProject: (id: string) => void }): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [selected, setSelected] = useState<string | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshSources = useCallback(async () => {
    const list = await window.api.getSources()
    setSources(list)
    setSelected((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list.find((s) => s.kind === 'screen')?.id ?? null)))
  }, [])

  const refreshProjects = useCallback(async () => setProjects(await window.api.listProjects()), [])

  useEffect(() => {
    void refreshSources()
    void refreshProjects()
    void listDevices().then(setDevices)
    return window.api.onProcessing((msg) => setBusy(msg))
  }, [refreshSources, refreshProjects])

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Ignore: preferences are a convenience.
    }
  }, [prefs])

  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const cams = devices.filter((d) => d.kind === 'videoinput')
  const isWindows = window.api.platform === 'win32'

  const record = async (): Promise<void> => {
    if (!selected) return
    setError(null)
    try {
      const id = await runRecording({
        sourceId: selected,
        systemAudio: prefs.systemAudio && isWindows,
        micId: mics.some((m) => m.deviceId === prefs.micId) ? prefs.micId : null,
        cameraId: cams.some((c) => c.deviceId === prefs.cameraId) ? prefs.cameraId : null
      })
      setBusy(null)
      if (id) onOpenProject(id)
    } catch (err) {
      setBusy(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const visible = sources.filter((s) => s.kind === tab)

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
            </div>
            <button className="btn ghost" onClick={() => void refreshSources()} title="Refresh">
              <Icon name="refresh" size={16} />
            </button>
          </div>
          <div className="source-grid">
            {visible.map((s) => (
              <button key={s.id} className={`source ${selected === s.id ? 'selected' : ''}`} onClick={() => setSelected(s.id)}>
                <img src={s.thumbnail} alt="" />
                <span>{s.name}</span>
              </button>
            ))}
            {visible.length === 0 && <p className="muted empty">No {tab === 'screen' ? 'screens' : 'windows'} found.</p>}
          </div>
          {tab === 'window' && (
            <p className="hint">Window recordings keep the system cursor; auto zoom and the smooth cursor work best with full screens.</p>
          )}
        </section>

        <aside className="panel record-panel">
          <h2>New recording</h2>
          <label className="field">
            <span>
              <Icon name="mic" size={16} /> Microphone
            </span>
            <select value={prefs.micId ?? ''} onChange={(e) => setPrefs({ ...prefs, micId: e.target.value || null })}>
              <option value="">No microphone</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>
              <Icon name="camera" size={16} /> Camera
            </span>
            <select value={prefs.cameraId ?? ''} onChange={(e) => setPrefs({ ...prefs, cameraId: e.target.value || null })}>
              <option value="">No camera</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || 'Camera'}
                </option>
              ))}
            </select>
          </label>
          <label className={`toggle ${!isWindows ? 'disabled' : ''}`}>
            <span>
              <Icon name="volume" size={16} /> System audio
            </span>
            <input
              type="checkbox"
              checked={prefs.systemAudio && isWindows}
              disabled={!isWindows}
              onChange={(e) => setPrefs({ ...prefs, systemAudio: e.target.checked })}
            />
          </label>
          <button className="btn record" disabled={!selected || !!busy} onClick={() => void record()}>
            <span className="rec-dot" /> Start recording
          </button>
          <p className="hint">
            Stop with the floating bar or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>2</kbd>.
          </p>
          {error && <p className="error">{error}</p>}
        </aside>

        <section className="panel library">
          <div className="panel-head">
            <h2>Recent recordings</h2>
          </div>
          {projects.length === 0 ? (
            <p className="muted empty">Your recordings will show up here.</p>
          ) : (
            <ul className="project-list">
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
                      void refreshProjects()
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

      {busy && (
        <div className="overlay">
          <div className="spinner" />
          <p>{busy}</p>
        </div>
      )}
    </div>
  )
}
