import { useEffect, useRef, useState } from 'react'
import { contentRect } from '../../../shared/engine/layout'
import { outputDuration } from '../../../shared/engine/timeline'
import type { ExportCapabilities } from '../../../shared/api/export'
import type { ExportSettings, Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import type { RenderScene } from '../render/compositor'
import { avcConfigs, supportedAvcConfig } from '../render/encoders'
import { exportDimensions, exportVideo, GIF_FPS, GIF_MAX_HEIGHT, type ExportProgress } from './exporter'
import './exportDialog.css'

interface Props {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  onClose: () => void
}

type Phase =
  | { kind: 'settings' }
  | { kind: 'running'; progress: ExportProgress | null }
  | { kind: 'done'; path: string; encoder: string; seconds: number; bytes: number }
  | { kind: 'error'; message: string; detail: string }

type CopyState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'copied' } | { kind: 'failed'; message: string }

const SETTINGS_KEY = 'export-settings'
const DEFAULTS: ExportSettings = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }
const RESOLUTIONS: { value: ExportSettings['resolution']; label: string }[] = [
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '1440p' },
  { value: 2160, label: '4K' }
]

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function loadSettings(): ExportSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<ExportSettings>
    return {
      format: pick(raw.format, ['mp4', 'gif'] as const, DEFAULTS.format),
      resolution: pick(raw.resolution, [720, 1080, 1440, 2160] as const, DEFAULTS.resolution),
      fps: pick(raw.fps, [30, 60] as const, DEFAULTS.fps),
      quality: pick(raw.quality, ['high', 'medium', 'small'] as const, DEFAULTS.quality),
      encoder: pick(raw.encoder, ['auto', 'software'] as const, DEFAULTS.encoder)
    }
  } catch {
    return DEFAULTS
  }
}

function Choice<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string; title?: string; className?: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={String(o.value)} className={`chip ${o.value === value ? 'active' : ''} ${o.className ?? ''}`} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CopyIcon(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d="M9 9h11v11H9zM5 15H4V4h11v1" />
    </svg>
  )
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return s ? `${m} min ${s} s` : `${m} min`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** First line is the readable reason; anything after a blank line is ffmpeg's log. */
function splitError(err: unknown): { message: string; detail: string } {
  const text = err instanceof Error ? err.message : String(err)
  const [message, ...rest] = text.split(/\n\s*\n/)
  return { message: message.trim() || 'The export failed.', detail: rest.join('\n\n').trim() }
}

export function ExportDialog(props: Props): JSX.Element {
  const [settings, setSettings] = useState<ExportSettings>(loadSettings)
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' })
  const [caps, setCaps] = useState<ExportCapabilities | null>(null)
  const [webCodecsGpu, setWebCodecsGpu] = useState<boolean | null>(null)
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })
  const [showDetail, setShowDetail] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const gif = settings.format === 'gif'
  const resolution = gif ? (Math.min(settings.resolution, GIF_MAX_HEIGHT) as ExportSettings['resolution']) : settings.resolution
  const dims = exportDimensions(props.project, settings)
  const length = outputDuration(props.project.clips)

  useEffect(() => {
    let live = true
    window.api
      .exportCapabilities()
      .then((c) => live && setCaps(c))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    setWebCodecsGpu(null)
    void supportedAvcConfig(avcConfigs(dims.width, dims.height, dims.fps, settings.quality, true)).then((c) => live && setWebCodecsGpu(!!c))
    return () => {
      live = false
    }
  }, [dims.width, dims.height, dims.fps, settings.quality])

  // Leaving the dialog (or the editor) stops a running export.
  useEffect(() => () => abort.current?.abort(), [])

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
    const controller = new AbortController()
    abort.current = controller
    setCopy({ kind: 'idle' })
    setShowDetail(false)
    setPhase({ kind: 'running', progress: null })
    try {
      const result = await exportVideo({
        project: props.project,
        scene: props.scene,
        screenUrl: props.screenUrl,
        webcamUrl: props.webcamUrl,
        background: props.background,
        settings,
        outputPath,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setPhase({ kind: 'running', progress })
        }
      })
      setPhase({ kind: 'done', path: outputPath, ...result })
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) setPhase({ kind: 'settings' })
      else setPhase({ kind: 'error', ...splitError(err) })
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  const copyFile = async (file: string): Promise<void> => {
    setCopy({ kind: 'busy' })
    const r = await window.api.copyFileToClipboard(file).catch((e: unknown) => ({ ok: false as const, message: String(e) }))
    setCopy(r.ok ? { kind: 'copied' } : { kind: 'failed', message: r.message })
  }

  // Honest size info: the recording drawn larger than it was captured is an upscale.
  const sourceH = props.project.height
  const drawnHeight = (height: number): number => {
    const d = exportDimensions(props.project, { ...settings, resolution: height as ExportSettings['resolution'] })
    return contentRect(d.width, d.height, props.project.width, props.project.height, props.project.style.padding).h
  }
  const upscaled = (height: number): boolean => drawnHeight(height) > sourceH * 1.05
  const resolutionOptions = RESOLUTIONS.filter((r) => !gif || r.value <= GIF_MAX_HEIGHT).map((r) => ({
    ...r,
    className: upscaled(r.value) ? 'upscale' : '',
    title: upscaled(r.value) ? `Larger than the recording (${props.project.width}×${props.project.height}): it will be upscaled` : undefined
  }))
  const gpuNames = caps?.hardwareEncoders.length ? caps.hardwareEncoders.map((e) => e.replace('h264_', '').toUpperCase()).join(', ') : ''
  const gpuHint =
    webCodecsGpu === null && !caps
      ? 'Checking for a GPU encoder…'
      : webCodecsGpu
        ? 'GPU encoding is available.'
        : gpuNames
          ? `GPU encoder found: ${gpuNames}.`
          : 'No GPU encoder found; Auto uses the software encoder (x264).'

  const running = phase.kind === 'running'
  return (
    <div className="overlay modal-backdrop">
      <div className="modal export-modal" role="dialog" aria-modal="true" aria-label="Export">
        <header className="modal-head">
          <h2>Export</h2>
          {!running && (
            <button className="btn ghost" onClick={props.onClose} title="Close">
              <Icon name="x" />
            </button>
          )}
        </header>

        {phase.kind === 'settings' && (
          <>
            <div className="form-row">
              <span>Format</span>
              <Choice
                value={settings.format}
                onChange={(format) => set({ format, ...(format === 'gif' && settings.resolution > GIF_MAX_HEIGHT ? { resolution: 1080 } : {}) })}
                options={[
                  { value: 'mp4', label: 'MP4' },
                  { value: 'gif', label: 'GIF' }
                ]}
              />
            </div>
            <div className="form-row">
              <span>Resolution</span>
              <Choice
                value={resolution}
                onChange={(resolution) => set({ resolution })}
                options={resolutionOptions}
              />
            </div>
            {!gif && (
              <>
                <div className="form-row">
                  <span>Frame rate</span>
                  <Choice
                    value={settings.fps}
                    onChange={(fps) => set({ fps })}
                    options={[
                      { value: 30, label: '30 fps' },
                      { value: 60, label: '60 fps' }
                    ]}
                  />
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
                <div className="form-row">
                  <span>Encoder</span>
                  <div className="export-encoder">
                    <Choice
                      value={settings.encoder}
                      onChange={(encoder) => set({ encoder })}
                      options={[
                        { value: 'auto', label: 'Auto (GPU when available)' },
                        { value: 'software', label: 'Software' }
                      ]}
                    />
                    <p className="hint">{settings.encoder === 'auto' ? gpuHint : 'x264 on the CPU: slower, smallest files, works everywhere.'}</p>
                  </div>
                </div>
              </>
            )}
            <div className="export-summary">
              <p className="hint">
                {dims.width}×{dims.height} · {dims.fps} fps · {formatDuration(length)}
                {gif ? ` · GIFs play at ${GIF_FPS} fps` : ''}
              </p>
              {upscaled(resolution) && (
                <p className="hint warn">
                  Larger than the recording ({props.project.width}×{props.project.height}): the video is upscaled and may look soft.
                </p>
              )}
              {gif && length > 30 && <p className="hint warn">Long GIFs get very large; MP4 is better for clips over 30 s.</p>}
            </div>
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

        {phase.kind === 'running' && <RunningView progress={phase.progress} gif={gif} onCancel={() => abort.current?.abort()} />}

        {phase.kind === 'done' && (
          <>
            <p className="success">
              <Icon name="check" /> Export finished
            </p>
            <p className="hint path">{phase.path}</p>
            <p className="hint">
              {formatBytes(phase.bytes)} · exported in {formatDuration(phase.seconds)} · {phase.encoder}
            </p>
            {copy.kind === 'failed' && <p className="hint warn">{copy.message}</p>}
            <footer className="modal-foot">
              <button className="btn" onClick={() => void copyFile(phase.path)} disabled={copy.kind === 'busy'} title="Copy the file to paste it into a chat, an email or a folder">
                {copy.kind === 'copied' ? <Icon name="check" size={16} /> : <CopyIcon />} {copy.kind === 'copied' ? 'Copied' : 'Copy'}
              </button>
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
            <p className="error export-error">Export failed: {phase.message}</p>
            {phase.detail && (
              <>
                <button className="btn ghost small export-detail-toggle" onClick={() => setShowDetail((v) => !v)}>
                  {showDetail ? 'Hide details' : 'Show details'}
                </button>
                {showDetail && <pre className="error-detail">{phase.detail}</pre>}
              </>
            )}
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

function RunningView({ progress, gif, onCancel }: { progress: ExportProgress | null; gif: boolean; onCancel: () => void }): JSX.Element {
  const finalizing = progress?.phase === 'finalizing'
  const fraction = progress && progress.frames > 0 ? progress.frame / progress.frames : 0
  let status = 'Preparing…'
  if (progress?.phase === 'rendering') {
    const parts = [`Rendering… ${Math.floor(fraction * 100)}%`]
    if (progress.fps > 0) parts.push(`${progress.fps.toFixed(progress.fps < 10 ? 1 : 0)} fps`)
    if (progress.eta !== null) parts.push(`about ${formatDuration(progress.eta)} left`)
    status = parts.join(' · ')
  } else if (finalizing) {
    status = gif ? 'Finalizing… building the GIF' : 'Finalizing…'
  }
  return (
    <>
      <div className={`progress ${finalizing ? 'indeterminate' : ''}`}>
        <div className="progress-bar" style={{ width: finalizing ? undefined : `${fraction * 100}%` }} />
      </div>
      <p className="hint export-status">{status}</p>
      {progress && (
        <p className="hint">
          Encoder: {progress.encoder}
          {progress.notice ? ` · ${progress.notice}` : ''}
        </p>
      )}
      <footer className="modal-foot">
        <button className="btn" onClick={onCancel}>
          Cancel export
        </button>
      </footer>
    </>
  )
}
