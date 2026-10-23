import { useRef, useState } from 'react'
import { outputDuration } from '../../../shared/engine/timeline'
import type { ExportSettings, Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import type { RenderScene } from '../render/compositor'
import { exportDimensions, exportVideo } from './exporter'

interface Props {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  onClose: () => void
}

type Phase = { kind: 'settings' } | { kind: 'running'; progress: number } | { kind: 'done'; path: string } | { kind: 'error'; message: string }

const SETTINGS_KEY = 'export-settings'

function loadSettings(): ExportSettings {
  const fallback: ExportSettings = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<ExportSettings>) } : fallback
  } catch {
    return fallback
  }
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={String(o.value)} className={`chip ${o.value === value ? 'active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ExportDialog(props: Props): JSX.Element {
  const [settings, setSettings] = useState<ExportSettings>(loadSettings)
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' })
  const abort = useRef<AbortController | null>(null)
  const dims = exportDimensions(props.project, settings)
  const length = outputDuration(props.project.clips)

  const set = (patch: Partial<ExportSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    } catch {
      // Ignore: remembered settings are a convenience.
    }
  }

  const start = async (): Promise<void> => {
    const safeName = props.project.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Recording'
    const outputPath = await window.api.chooseExportPath(safeName, settings.format)
    if (!outputPath) return
    abort.current = new AbortController()
    setPhase({ kind: 'running', progress: 0 })
    try {
      await exportVideo({
        project: props.project,
        scene: props.scene,
        screenUrl: props.screenUrl,
        webcamUrl: props.webcamUrl,
        background: props.background,
        settings,
        outputPath,
        signal: abort.current.signal,
        onProgress: (progress) => setPhase({ kind: 'running', progress })
      })
      setPhase({ kind: 'done', path: outputPath })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setPhase({ kind: 'settings' })
      else setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="overlay modal-backdrop">
      <div className="modal" role="dialog" aria-label="Export">
        <header className="modal-head">
          <h2>Export</h2>
          {phase.kind !== 'running' && (
            <button className="btn ghost" onClick={props.onClose} title="Close">
              <Icon name="x" />
            </button>
          )}
        </header>

        {phase.kind === 'settings' && (
          <>
            <div className="form-row">
              <span>Format</span>
              <Choice value={settings.format} onChange={(format) => set({ format })} options={[{ value: 'mp4', label: 'MP4' }, { value: 'gif', label: 'GIF' }]} />
            </div>
            <div className="form-row">
              <span>Resolution</span>
              <Choice
                value={settings.resolution}
                onChange={(resolution) => set({ resolution })}
                options={[
                  { value: 720, label: '720p' },
                  { value: 1080, label: '1080p' },
                  { value: 1440, label: '1440p' },
                  { value: 2160, label: '4K' }
                ]}
              />
            </div>
            {settings.format === 'mp4' && (
              <>
                <div className="form-row">
                  <span>Frame rate</span>
                  <Choice value={settings.fps} onChange={(fps) => set({ fps })} options={[{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }]} />
                </div>
                <div className="form-row">
                  <span>Quality</span>
                  <Choice
                    value={settings.quality}
                    onChange={(quality) => set({ quality })}
                    options={[
                      { value: 'high', label: 'Studio' },
                      { value: 'medium', label: 'Web' },
                      { value: 'small', label: 'Small file' }
                    ]}
                  />
                </div>
              </>
            )}
            <p className="hint">
              {dims.width}×{dims.height} · {dims.fps} fps · {Math.round(length * 10) / 10}s
              {settings.format === 'gif' ? ' · GIFs are capped at 540p / 15 fps' : ''}
            </p>
            <footer className="modal-foot">
              <button className="btn" onClick={props.onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void start()}>
                <Icon name="download" size={16} /> Export {settings.format.toUpperCase()}
              </button>
            </footer>
          </>
        )}

        {phase.kind === 'running' && (
          <>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${phase.progress * 100}%` }} />
            </div>
            <p className="hint">Rendering… {Math.round(phase.progress * 100)}%</p>
            <footer className="modal-foot">
              <button className="btn" onClick={() => abort.current?.abort()}>
                Cancel export
              </button>
            </footer>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <p className="success">
              <Icon name="check" /> Export finished
            </p>
            <p className="hint path">{phase.path}</p>
            <footer className="modal-foot">
              <button className="btn" onClick={() => void window.api.showItemInFolder(phase.path)}>
                <Icon name="folder" size={16} /> Show in folder
              </button>
              <button className="btn primary" onClick={props.onClose}>
                Done
              </button>
            </footer>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="error">Export failed</p>
            <pre className="error-detail">{phase.message}</pre>
            <footer className="modal-foot">
              <button className="btn" onClick={() => setPhase({ kind: 'settings' })}>
                Back
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
