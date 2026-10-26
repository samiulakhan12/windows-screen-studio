import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { pictureTime, planOf, videoDuration, videoTimeAt, videoToSource } from '../../../shared/engine/freeze'
import { styleContentRect } from '../../../shared/engine/layout'
import { outputDuration, outputToSource } from '../../../shared/engine/timeline'
import type { ExportCapabilities } from '../../../shared/api/export'
import { hasSoundtrack } from '../../../shared/audio/settings'
import { outputChapters, youtubeChapters, type OutputChapter } from '../../../shared/render/chapters'
import { clickSoundJob } from '../../../shared/render/clickSound'
import { exportProject, exportSize, LOW_BPP, MAX_EXPORT_SIDE, MB, sizeError, targetBitrates, type ExportSize } from '../../../shared/render/exportPlan'
import {
  applyPreset,
  BATCH_ASPECTS,
  batchFileNames,
  batchItems,
  EXPORT_PRESETS,
  FORMAT_LABELS,
  normalizeOptions,
  presetById,
  RESOLUTION_LABELS,
  safeFileName,
  TARGET_MB_RANGE,
  tweakOptions,
  type ExportOptions,
  type ExportPreset
} from '../../../shared/render/exportPresets'
import type { AspectRatio, ExportFormat, ExportSettings, Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import type { RenderScene } from '../render/compositor'
import { avcConfigs, supportedAvcConfig, vp9Configs } from '../render/encoders'
import { EditorContext } from './context'
import { AspectGlyph, PresetBadge } from './exportIcons'
import { ExportPreview } from './ExportPreview'
import { exportBatch, exportVideo, GIF_FPS, GIF_MAX_HEIGHT, renderThumbnail, type BatchJob, type BatchStatus, type ExportProgress, type ExportResult } from './exporter'
import { useModalFocus } from './modalFocus'
import './exportDialog.css'
import './titles.css'

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
  | ({ kind: 'done'; path: string; targetMB?: number; limit?: { label: string; maxMB: number } } & ExportResult)
  | { kind: 'batch'; jobs: BatchJob[]; statuses: BatchStatus[]; folder: string; finished: boolean }
  | { kind: 'error'; message: string; detail: string }

type CopyState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'copied' } | { kind: 'failed'; message: string }
type ThumbState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved'; path: string; width: number; height: number } | { kind: 'failed'; message: string }

const SETTINGS_KEY = 'export-settings'
const MODE_KEY = 'export-mode'
const BATCH_KEY = 'export-batch'
const OPEN_KEY = 'export-settings-open'

const RESOLUTIONS: ExportSettings['resolution'][] = [720, 1080, 1440, 2160]
const FORMATS: { value: ExportFormat; label: string; title: string }[] = [
  { value: 'mp4', label: 'MP4', title: 'H.264 video with AAC audio: plays everywhere' },
  { value: 'mov', label: 'MOV', title: 'H.264 in a QuickTime movie, for Final Cut, Premiere and Keynote' },
  { value: 'webm', label: 'WebM', title: 'VP9 video with Opus audio, for the web' },
  { value: 'gif', label: 'GIF', title: 'An animated image that plays silently and loops (15 fps)' },
  { value: 'm4a', label: 'M4A', title: 'The soundtrack only (AAC), nothing is rendered' }
]

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore: remembered settings are a convenience.
  }
}

function loadBatch(): { presets: string[]; aspects: AspectRatio[] } {
  const raw = readJson<{ presets?: unknown; aspects?: unknown }>(BATCH_KEY, {})
  const presets = Array.isArray(raw.presets) ? raw.presets.filter((p): p is string => typeof p === 'string' && !!presetById(p)) : []
  const aspects = Array.isArray(raw.aspects) ? raw.aspects.filter((a): a is AspectRatio => (BATCH_ASPECTS as readonly string[]).includes(a as string)) : []
  return { presets, aspects }
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T | null
  /** `pressed` makes a chip a toggle of its own (multi-select rows). */
  options: { value: T; label: string; title?: string; className?: string; disabled?: boolean; icon?: JSX.Element; pressed?: boolean }[]
  onChange: (v: T) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`chip ${(o.pressed ?? o.value === value) ? 'active' : ''} ${o.className ?? ''}`}
          title={o.title}
          aria-pressed={o.pressed ?? o.value === value}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
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

/** 0:07, 2:20 */
export function formatClock(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0')
  return `${m}:${sec}`
}

/** Puts `text` on the clipboard; the older copy command is the fallback when the page has no focus. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      area.remove()
    }
  }
}

/**
 * The video's chapters: how many go into the file, and a button that copies them as YouTube
 * timestamps ("0:00 Intro"), saying what YouTube still needs when the list does not qualify.
 */
function ChapterCopy({ chapters, length, gif }: { chapters: OutputChapter[]; length: number; gif: boolean }): JSX.Element | null {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const yt = useMemo(() => youtubeChapters(chapters, length), [chapters, length])
  useEffect(() => setState('idle'), [yt.text])
  if (!chapters.length) return null
  const copy = async (): Promise<void> => setState((await copyText(yt.text)) ? 'copied' : 'failed')
  const count = `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`
  return (
    <div className="export-chapters" data-testid="export-chapters">
      <p className="hint">{gif ? `${count} · GIFs have no chapters, other formats keep them.` : `${count}, written into the file.`}</p>
      <button className="btn small chapter-copy" onClick={() => void copy()} title="Copy the chapters as YouTube timestamps (0:00 Intro…) for the video's description">
        {state === 'copied' ? <Icon name="check" size={14} /> : <CopyIcon />} {state === 'copied' ? 'Copied' : 'Copy chapters'}
      </button>
      {state === 'failed' && <p className="hint warn">The chapters could not be copied to the clipboard.</p>}
      {yt.problems.length ? (
        yt.problems.map((p) => (
          <p key={p} className="hint warn">
            {p}
          </p>
        ))
      ) : (
        <p className="hint">Ready for YouTube: paste them into the description.</p>
      )}
    </div>
  )
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

const ratioOf = (s: { width: number; height: number }): number => s.width / s.height

/** "1080×1920 · 30 fps" for a card; GIFs and audio say what they are. */
function presetMeta(project: Project, preset: ExportPreset): string {
  const o = applyPreset({ encoder: 'auto' }, preset)
  const s = exportSize(project, o)
  if (o.format === 'm4a') return 'Audio only'
  return `${s.width}×${s.height} · ${s.fps} fps`
}

/** The one limit worth showing on a card: its size target, else the platform's longest video. */
function presetLimit(preset: ExportPreset): { text: string; title: string } | null {
  if (preset.targetSizeMB) return { text: `≤ ${preset.targetSizeMB} MB`, title: `Made to fit ${preset.targetSizeMB} MB` }
  const l = preset.limits
  if (!l?.maxSeconds) return null
  const size = l.maxMB ? ` and ${l.maxMB} MB` : ''
  return { text: `≤ ${formatClock(l.maxSeconds)}`, title: `${preset.label} takes videos up to ${formatClock(l.maxSeconds)}${size}` }
}

export function ExportDialog(props: Props): JSX.Element {
  const editor = useContext(EditorContext)
  const [options, setOptions] = useState<ExportOptions>(() => normalizeOptions(readJson(SETTINGS_KEY, {})))
  const [mode, setMode] = useState<'single' | 'batch'>(() => (readJson<string>(MODE_KEY, 'single') === 'batch' ? 'batch' : 'single'))
  const [batch, setBatch] = useState(loadBatch)
  const [settingsOpen, setSettingsOpen] = useState(() => readJson<boolean>(OPEN_KEY, true) !== false)
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' })
  const [caps, setCaps] = useState<ExportCapabilities | null>(null)
  const [webCodecsGpu, setWebCodecsGpu] = useState<boolean | null>(null)
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })
  const [thumb, setThumb] = useState<ThumbState>({ kind: 'idle' })
  const [showDetail, setShowDetail] = useState(false)
  const [targetDraft, setTargetDraft] = useState<string>(() => (options.targetSizeMB ? String(options.targetSizeMB) : ''))
  const { project } = props
  const clips = project.clips
  // Seconds of the exported video: the edit and its pause freezes.
  const plan = planOf(project)
  const length = videoDuration(clips, plan)
  // The thumbnail and preview frame, in output seconds: the playhead when the dialog opens.
  const [frameAt, setFrameAt] = useState(() => Math.min(length, videoTimeAt(clips, plan, editor?.player.time ?? clips[0].start)))
  // Its sound's source time (a freeze at the edit's end holds the edit's last frame), the picture
  // drawn there (a freeze's frame), and whether it is frozen (drawn sharp, as the export does).
  const shown = videoToSource(clips, plan, Math.min(frameAt, Math.max(0, length - 1e-3)))
  const frameSound = shown.hold?.end ? outputToSource(clips, Math.max(0, outputDuration(clips) - 1e-3)).time : shown.time
  const frameSource = pictureTime(clips, plan, frameSound)
  const frameHeld = !!shown.hold || plan.stills.some((s) => s.at === frameSource)
  const abort = useRef<AbortController | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  const gif = options.format === 'gif'
  const audioOnly = options.format === 'm4a'
  const resolution = gif ? (Math.min(options.resolution, GIF_MAX_HEIGHT) as ExportSettings['resolution']) : options.resolution
  const drawn = useMemo(() => exportProject(project, options), [project, options])
  const dims = exportSize(project, options)
  const hasClickSounds = useMemo(() => !!clickSoundJob(project, props.scene.cursor, clips), [project, props.scene.cursor, clips])
  const hasSound = hasSoundtrack(project, hasClickSounds)
  const preset = presetById(options.preset)
  const chapters = useMemo(() => outputChapters(project.chapters ?? [], clips, plan), [project.chapters, clips, plan])

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
    const configs = options.format === 'webm' ? vp9Configs : avcConfigs
    void supportedAvcConfig(configs(dims.width, dims.height, dims.fps, options.quality, true)).then((c) => live && setWebCodecsGpu(!!c))
    return () => {
      live = false
    }
  }, [dims.width, dims.height, dims.fps, options.quality, options.format])

  // Leaving the dialog (or the editor) stops a running export.
  useEffect(() => () => abort.current?.abort(), [])

  const running = phase.kind === 'running' || (phase.kind === 'batch' && !phase.finished)

  // Keyboard users start on the main action of each step (Export, Done, Back).
  useEffect(() => {
    primary.current?.focus()
  }, [phase.kind, phase.kind === 'batch' && phase.finished])

  // Tab stays inside the dialog: the editor behind it (Back, Undo, the name field) must not be
  // reachable, since leaving the editor would abort a running export. Escape is handled below.
  useModalFocus(boxRef, () => undefined)

  // Escape closes the dialog like its Close button, which only exists while no export
  // runs (Cancel export is a deliberate click). Captured first so the editor behind
  // the dialog never sees the key.
  useEffect(() => {
    if (running) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      onClose.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [running])

  const save = (next: ExportOptions): void => {
    setOptions(next)
    writeJson(SETTINGS_KEY, next)
  }
  const set = (patch: Partial<ExportOptions>): void => save(tweakOptions(options, patch))
  const pickPreset = (p: ExportPreset): void => {
    const next = applyPreset(options, p)
    save(next)
    setTargetDraft(next.targetSizeMB ? String(next.targetSizeMB) : '')
  }
  const setModeSaved = (m: 'single' | 'batch'): void => {
    setMode(m)
    writeJson(MODE_KEY, m)
  }
  const setBatchSaved = (next: typeof batch): void => {
    setBatch(next)
    writeJson(BATCH_KEY, next)
  }
  const toggleSettings = (): void => {
    setSettingsOpen(!settingsOpen)
    writeJson(OPEN_KEY, !settingsOpen)
  }
  const commitTarget = (text: string): void => {
    setTargetDraft(text)
    const mb = Number(text.replace(',', '.'))
    if (!text.trim()) set({ targetSizeMB: undefined })
    else if (Number.isFinite(mb) && mb >= TARGET_MB_RANGE.min && mb <= TARGET_MB_RANGE.max) set({ targetSizeMB: Math.round(mb * 10) / 10 })
  }

  const baseName = safeFileName(project.name)
  const source = { project, scene: props.scene, screenUrl: props.screenUrl, webcamUrl: props.webcamUrl, background: props.background }

  const start = async (): Promise<void> => {
    const outputPath = await window.api.chooseExportPath(baseName, options.format)
    if (!outputPath) return
    const controller = new AbortController()
    abort.current = controller
    setCopy({ kind: 'idle' })
    setShowDetail(false)
    setPhase({ kind: 'running', progress: null })
    try {
      const result = await exportVideo({
        ...source,
        settings: options,
        outputPath,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setPhase({ kind: 'running', progress })
        }
      })
      setPhase({ kind: 'done', path: outputPath, targetMB: options.targetSizeMB, limit: preset?.limits?.maxMB ? { label: preset.label, maxMB: preset.limits.maxMB } : undefined, ...result })
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) setPhase({ kind: 'settings' })
      else setPhase({ kind: 'error', ...splitError(err) })
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  const items = useMemo(() => batchItems(batch.presets, batch.aspects, options), [batch, options])
  const startBatch = async (): Promise<void> => {
    if (items.length === 0) return
    const folder = await window.api.chooseExportFolder()
    if (!folder) return
    const names = batchFileNames(project.name, items)
    const jobs: BatchJob[] = items.map((it, i) => ({ key: it.key, label: it.label, fileName: names[i], options: it.options }))
    const controller = new AbortController()
    abort.current = controller
    setCopy({ kind: 'idle' })
    setPhase({ kind: 'batch', jobs, statuses: jobs.map(() => ({ state: 'waiting' })), folder, finished: false })
    const update = (i: number, status: BatchStatus): void =>
      setPhase((p) => (p.kind === 'batch' ? { ...p, statuses: p.statuses.map((s, j) => (j === i ? status : s)) } : p))
    try {
      await exportBatch(source, folder, jobs, update, controller.signal)
    } finally {
      if (abort.current === controller) abort.current = null
      setPhase((p) => (p.kind === 'batch' ? { ...p, finished: true } : p))
    }
  }

  const saveThumbnail = async (): Promise<void> => {
    const file = await window.api.chooseExportPath(`${baseName} - thumbnail`, 'png')
    if (!file) return
    setThumb({ kind: 'busy' })
    try {
      const shot = await renderThumbnail({ ...source, settings: options, time: frameSource, soundTime: frameSound, held: frameHeld })
      await window.api.saveThumbnail(file, shot.png)
      setThumb({ kind: 'saved', path: file, width: shot.width, height: shot.height })
    } catch (err) {
      setThumb({ kind: 'failed', message: splitError(err).message })
    }
  }

  const copyFile = async (file: string): Promise<void> => {
    setCopy({ kind: 'busy' })
    const r = await window.api.copyFileToClipboard(file).catch((e: unknown) => ({ ok: false as const, message: String(e) }))
    setCopy(r.ok ? { kind: 'copied' } : { kind: 'failed', message: r.message })
  }

  // Honest size info: the real output size of each choice (very wide or tall recordings
  // are limited on their long side), and whether the recording is drawn larger than it was captured.
  const sizeFor = (height: number): ExportSize => exportSize(project, { ...options, resolution: height as ExportSettings['resolution'] })
  const upscaled = (height: number): boolean => {
    const d = sizeFor(height)
    return styleContentRect(d.width, d.height, project.width, project.height, drawn.style).h > project.height * 1.05
  }
  const resolutionOptions = RESOLUTIONS.filter((r) => !gif || r <= GIF_MAX_HEIGHT).map((r) => {
    const d = sizeFor(r)
    const notes = [`${d.width}×${d.height}`]
    if (d.capped) notes.push(`limited to ${MAX_EXPORT_SIDE} px on the long side`)
    if (upscaled(r)) notes.push(`larger than the recording (${project.width}×${project.height}): it will be upscaled`)
    return { value: r, label: RESOLUTION_LABELS[r], className: upscaled(r) ? 'upscale' : '', title: notes.join('; ') }
  })
  const projectAspect = project.style.aspectRatio
  const aspectOptions = (['project', ...BATCH_ASPECTS] as const).map((a) => {
    const ratio = a === 'project' ? ratioOf(exportSize(project, { ...options, aspect: undefined })) : ratioOf(exportSize(project, { ...options, aspect: a }))
    return {
      value: a as string,
      label: a === 'project' ? 'Project' : a,
      title: a === 'project' ? `The project's own shape (${projectAspect === 'auto' ? 'Auto' : projectAspect}, Style panel)` : `Export in ${a}; the project keeps its own shape`,
      icon: <AspectGlyph ratio={ratio} />
    }
  })
  const gpuNames = caps?.hardwareEncoders.length ? caps.hardwareEncoders.map((e) => e.replace('h264_', '').toUpperCase()).join(', ') : ''
  const gpuHint =
    options.format === 'webm'
      ? webCodecsGpu
        ? 'GPU VP9 encoding is available.'
        : webCodecsGpu === null
          ? 'Checking for a GPU encoder…'
          : 'No GPU VP9 encoder here; WebM uses the software encoder (libvpx).'
      : webCodecsGpu
        ? 'GPU encoding is available.'
        : gpuNames
          ? `GPU encoder found: ${gpuNames}.`
          : webCodecsGpu === null || !caps
            ? 'Checking for a GPU encoder…'
            : 'No GPU encoder found; Auto uses the software encoder (x264).'
  const softwareHint = options.format === 'webm' ? 'libvpx on the CPU: slower, works everywhere.' : 'x264 on the CPU: slower, smallest files, works everywhere.'

  // Size target advice, before exporting.
  const target = options.targetSizeMB
  const targetInfo =
    target && !gif ? targetBitrates({ targetMB: target, seconds: length, hasAudio: hasSound, format: options.format, width: dims.width, height: dims.height, fps: dims.fps }) : null
  const limits = preset?.limits
  const warnings: { key: string; text: string; cls?: string }[] = []
  if (!audioOnly && dims.capped) {
    warnings.push({
      key: 'capped',
      cls: 'export-capped',
      text: `This recording is very ${project.width >= project.height ? 'wide' : 'tall'}, so the video is limited to ${MAX_EXPORT_SIDE} pixels on its long side.`
    })
  }
  if (!audioOnly && upscaled(resolution)) {
    warnings.push({ key: 'upscale', cls: 'warn', text: `Larger than the recording (${project.width}×${project.height}): the video is upscaled and may look soft.` })
  }
  if (!audioOnly && project.transcript?.segments.length) warnings.push({ key: 'captions', cls: 'export-captions', text: `Captions are drawn on the video when Show captions is on (now ${project.captions?.show === false ? 'off' : 'on'}, in the Captions tab, where Export captions saves them as SRT or VTT).` })
  if (gif && length > 30) warnings.push({ key: 'gif', cls: 'warn', text: 'Long GIFs get very large; MP4 is better for clips over 30 s.' })
  if (audioOnly && !hasSound) warnings.push({ key: 'silent', cls: 'warn', text: 'This recording has no sound to export.' })
  if (limits?.maxSeconds && length > limits.maxSeconds) {
    warnings.push({ key: 'len', cls: 'warn', text: `${preset!.label} takes videos up to ${formatClock(limits.maxSeconds)}; this one is ${formatClock(length)}. Trim it first.` })
  }
  if (targetInfo && !targetInfo.feasible) {
    warnings.push({ key: 'target', cls: 'warn', text: `${target} MB is too small for ${formatClock(length)} of video. Choose a larger size or shorten the clip.` })
  } else if (targetInfo && targetInfo.bpp < LOW_BPP && !audioOnly) {
    warnings.push({ key: 'target', cls: 'warn', text: `${target} MB is tight for ${dims.width}×${dims.height} at ${dims.fps} fps; a lower resolution or 30 fps will look sharper.` })
  }

  const exportLabel = `Export ${FORMAT_LABELS[options.format]}`
  const settingsName = preset ? preset.label : 'Custom'

  return (
    <div className="overlay modal-backdrop">
      <div ref={boxRef} className={`modal export-modal ${phase.kind === 'settings' ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label="Export">
        <header className="modal-head">
          <h2>Export</h2>
          {phase.kind === 'settings' && (
            <div className="segmented export-mode" role="tablist" aria-label="Export mode">
              <button role="tab" aria-selected={mode === 'single'} className={mode === 'single' ? 'active' : ''} onClick={() => setModeSaved('single')}>
                One file
              </button>
              <button role="tab" aria-selected={mode === 'batch'} className={mode === 'batch' ? 'active' : ''} onClick={() => setModeSaved('batch')}>
                Batch
              </button>
            </div>
          )}
          <span className="tb-spacer" />
          {!running && (
            <button className="btn ghost" onClick={props.onClose} title="Close">
              <Icon name="x" />
            </button>
          )}
        </header>

        {phase.kind === 'settings' && (
          <>
            <div className="export-body">
              <aside className="export-side">
                <div className={`export-preview ${audioOnly ? 'audio-only' : ''}`}>
                  <ExportPreview {...source} options={options} time={frameSource} soundTime={frameSound} held={frameHeld} box={{ width: 236, height: 236 }} />
                  {audioOnly && <span className="export-preview-badge">Audio only</span>}
                </div>
                <label className="export-frame">
                  <span className="slider-head">
                    <span>Frame</span>
                    <span className="muted">{formatClock(frameAt, true)}</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Thumbnail frame"
                    min={0}
                    max={Math.max(0.001, length)}
                    step={1 / 30}
                    value={frameAt}
                    onChange={(e) => {
                      setFrameAt(Number(e.target.value))
                      setThumb({ kind: 'idle' })
                    }}
                  />
                </label>
                <button className="btn export-thumb" onClick={() => void saveThumbnail()} disabled={thumb.kind === 'busy'} title="Save this frame as a PNG at the export size">
                  <Icon name="image" size={16} /> {thumb.kind === 'busy' ? 'Saving…' : 'Save thumbnail'}
                </button>
                {thumb.kind === 'saved' && (
                  <p className="hint export-thumb-status">
                    Saved {thumb.width}×{thumb.height} PNG.{' '}
                    <button className="link" onClick={() => void window.api.showItemInFolder(thumb.path)}>
                      Show in folder
                    </button>
                  </p>
                )}
                {thumb.kind === 'failed' && <p className="hint warn">{thumb.message}</p>}
                <ChapterCopy chapters={chapters} length={length} gif={mode === 'single' && gif} />

                <div className="export-summary">
                  {mode === 'single' ? (
                    <p className="hint export-size">
                      {audioOnly ? 'Audio only' : `${dims.width}×${dims.height} · ${dims.fps} fps`} · {formatDuration(length)}
                      {gif ? ` · GIFs play at ${GIF_FPS} fps` : ''}
                      {target ? ` · ${gif ? 'up to' : 'about'} ${target} MB` : ''}
                    </p>
                  ) : (
                    <>
                      <p className="hint export-size">
                        {items.length === 0 ? 'Tick the files to export.' : `${items.length} file${items.length === 1 ? '' : 's'} · ${formatDuration(length)} each, into one folder:`}
                      </p>
                      {items.length > 0 && (
                        <ul className="export-batch-files">
                          {batchFileNames(project.name, items).map((name, i) => {
                            const s = exportSize(project, items[i].options)
                            return (
                              <li key={items[i].key} title={name}>
                                <AspectGlyph ratio={ratioOf(s)} size={12} />
                                <span className="name">{name}</span>
                                <span className="muted">{items[i].options.format === 'm4a' ? 'audio' : `${s.width}×${s.height}`}</span>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </>
                  )}
                  {mode === 'single' &&
                    warnings.map((w) => (
                      <p key={w.key} className={`hint ${w.cls ?? ''}`}>
                        {w.text}
                      </p>
                    ))}
                </div>
              </aside>

              <div className="export-main">
                <div className="export-section-head">
                  <span>{mode === 'single' ? 'Destination' : 'Files to export'}</span>
                  {mode === 'batch' && batch.presets.length + batch.aspects.length > 0 && (
                    <button className="link" onClick={() => setBatchSaved({ presets: [], aspects: [] })}>
                      Clear
                    </button>
                  )}
                </div>
                <div className="preset-grid" role={mode === 'single' ? 'radiogroup' : 'group'} aria-label="Destinations">
                  {EXPORT_PRESETS.map((p) => {
                    const on = mode === 'single' ? options.preset === p.id : batch.presets.includes(p.id)
                    const limit = presetLimit(p)
                    return (
                      <button
                        key={p.id}
                        className={`preset-card ${on ? 'active' : ''}`}
                        role={mode === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={on}
                        data-preset={p.id}
                        onClick={() => {
                          if (mode === 'single') pickPreset(p)
                          else setBatchSaved({ ...batch, presets: on ? batch.presets.filter((x) => x !== p.id) : [...batch.presets, p.id] })
                        }}
                      >
                        <PresetBadge icon={p.icon} />
                        <span className="preset-text">
                          <span className="preset-label">{p.label}</span>
                          <span className="preset-meta">
                            {presetMeta(project, p)}
                            {limit ? (
                              <span className="preset-limit" title={limit.title}>
                                {' '}
                                · {limit.text}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {mode === 'batch' && <span className={`preset-check ${on ? 'on' : ''}`}>{on && <Icon name="check" size={12} />}</span>}
                      </button>
                    )
                  })}
                </div>

                {mode === 'batch' && (
                  <div className="form-row export-batch-aspects">
                    <span>Also</span>
                    <div className="export-batch-also">
                      <Choice<string>
                        value={null}
                        options={BATCH_ASPECTS.map((a) => ({
                          value: a,
                          label: a,
                          pressed: batch.aspects.includes(a),
                          disabled: audioOnly,
                          title: `The settings below in ${a}`,
                          icon: <AspectGlyph ratio={ratioOf(exportSize(project, { ...options, aspect: a }))} />
                        }))}
                        onChange={(a) =>
                          setBatchSaved({
                            ...batch,
                            aspects: batch.aspects.includes(a as AspectRatio) ? batch.aspects.filter((x) => x !== a) : [...batch.aspects, a as AspectRatio]
                          })
                        }
                      />
                      <p className="hint">The settings below, in more shapes.</p>
                    </div>
                  </div>
                )}

                <button className="export-section-head toggle-head" onClick={toggleSettings} aria-expanded={settingsOpen}>
                  <span>
                    Settings <span className="muted">· {mode === 'single' ? settingsName : 'for “Also” and the encoder'}</span>
                  </span>
                  <span className={`chevron ${settingsOpen ? 'open' : ''}`} aria-hidden="true">
                    <Icon name="back" size={14} />
                  </span>
                </button>
                {settingsOpen && (
                  <div className="export-settings">
                    <div className="form-row">
                      <span>Format</span>
                      <Choice
                        value={options.format}
                        onChange={(format) => set({ format, maxWidth: undefined, ...(format === 'gif' && options.resolution > GIF_MAX_HEIGHT ? { resolution: 1080 } : {}) })}
                        options={FORMATS.map((f) => ({ ...f, disabled: f.value === 'm4a' && !hasSound, title: f.value === 'm4a' && !hasSound ? 'This recording has no sound' : f.title }))}
                      />
                    </div>
                    {!audioOnly && (
                      <div className="form-row">
                        <span>Resolution</span>
                        <Choice value={resolution} onChange={(r) => set({ resolution: r, maxWidth: undefined })} options={resolutionOptions} />
                      </div>
                    )}
                    {!audioOnly && (
                      <div className="form-row">
                        <span>Aspect</span>
                        <Choice value={options.aspect ?? 'project'} onChange={(a) => set({ aspect: a === 'project' ? undefined : (a as AspectRatio) })} options={aspectOptions} />
                      </div>
                    )}
                    {!gif && !audioOnly && (
                      <div className="form-row">
                        <span>Frame rate</span>
                        <Choice
                          value={options.fps}
                          onChange={(fps) => set({ fps })}
                          options={[
                            { value: 30, label: '30 fps' },
                            { value: 60, label: '60 fps' }
                          ]}
                        />
                      </div>
                    )}
                    {!gif && !audioOnly && (
                      <div className="form-row">
                        <span>Quality</span>
                        <div className="export-stack">
                          <Choice
                            value={target ? null : options.quality}
                            disabled={!!target}
                            onChange={(quality) => set({ quality })}
                            options={[
                              { value: 'high', label: 'Studio' },
                              { value: 'medium', label: 'Web' },
                              { value: 'small', label: 'Small file' }
                            ]}
                          />
                          {target ? <p className="hint">Set by the target size.</p> : null}
                        </div>
                      </div>
                    )}
                    <div className="form-row">
                      <span>Target size</span>
                      <div className="export-target">
                        <input
                          type="number"
                          inputMode="decimal"
                          aria-label="Target size in MB"
                          placeholder="Off"
                          min={TARGET_MB_RANGE.min}
                          max={TARGET_MB_RANGE.max}
                          step={1}
                          value={targetDraft}
                          onChange={(e) => commitTarget(e.target.value)}
                        />
                        <span className="muted">MB</span>
                        {target ? (
                          <button className="btn ghost small" onClick={() => commitTarget('')}>
                            Off
                          </button>
                        ) : (
                          <span className="hint">{gif ? 'Shrinks the GIF until it fits' : 'Aims for this file size'}</span>
                        )}
                      </div>
                    </div>
                    {!gif && !audioOnly && (
                      <div className="form-row">
                        <span>Encoder</span>
                        <div className="export-stack">
                          <Choice
                            value={options.encoder}
                            onChange={(encoder) => set({ encoder })}
                            options={[
                              { value: 'auto', label: 'Auto (GPU when available)' },
                              { value: 'software', label: 'Software' }
                            ]}
                          />
                          <p className="hint">{options.encoder === 'auto' ? gpuHint : softwareHint}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <footer className="modal-foot">
              <button className="btn" onClick={props.onClose}>
                Cancel
              </button>
              {mode === 'single' ? (
                <button ref={primary} className="btn primary" onClick={() => void start()} disabled={audioOnly && !hasSound}>
                  <Icon name="download" size={16} /> {exportLabel}
                </button>
              ) : (
                <button ref={primary} className="btn primary" onClick={() => void startBatch()} disabled={items.length === 0}>
                  <Icon name="folder" size={16} /> Export {items.length} file{items.length === 1 ? '' : 's'}…
                </button>
              )}
            </footer>
          </>
        )}

        {phase.kind === 'running' && <RunningView progress={phase.progress} gif={gif} onCancel={() => abort.current?.abort()} />}

        {phase.kind === 'batch' && (
          <BatchView
            phase={phase}
            onCancel={() => abort.current?.abort()}
            onDone={props.onClose}
            onBack={() => setPhase({ kind: 'settings' })}
            primary={primary}
            copy={copy}
            onCopy={(f) => void copyFile(f)}
          />
        )}

        {phase.kind === 'done' && (
          <>
            <p className="success">
              <Icon name="check" /> Export finished
            </p>
            <p className="hint path">{phase.path}</p>
            <p className="hint">
              {formatBytes(phase.bytes)} · exported in {formatDuration(phase.seconds)} · {phase.encoder}
            </p>
            <SizeReport result={phase} />
            {!gif && <ChapterCopy chapters={chapters} length={length} gif={false} />}
            {copy.kind === 'failed' && <p className="hint warn">{copy.message}</p>}
            <footer className="modal-foot">
              <button className="btn" onClick={() => void copyFile(phase.path)} disabled={copy.kind === 'busy'} title="Copy the file to paste it into a chat, an email or a folder">
                {copy.kind === 'copied' ? <Icon name="check" size={16} /> : <CopyIcon />} {copy.kind === 'copied' ? 'Copied' : 'Copy'}
              </button>
              <button className="btn" onClick={() => void window.api.showItemInFolder(phase.path)}>
                <Icon name="folder" size={16} /> Show in folder
              </button>
              <button ref={primary} className="btn primary" onClick={props.onClose}>
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
              <button ref={primary} className="btn" onClick={() => setPhase({ kind: 'settings' })}>
                Back
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

/** How a finished file compares with its size target, and what was done to meet it. */
function SizeReport({ result }: { result: { bytes: number; targetMB?: number; reduced?: string; overLimit?: boolean; limit?: { label: string; maxMB: number } } }): JSX.Element | null {
  const { targetMB } = result
  const lines: { text: string; warn?: boolean }[] = []
  if (result.reduced) lines.push({ text: `To fit ${targetMB} MB the GIF was made at ${result.reduced}.` })
  if (result.overLimit) lines.push({ text: `Even at its smallest the GIF is over ${targetMB} MB. Shorten the clip or export an MP4.`, warn: true })
  else if (targetMB && !result.reduced) {
    const err = sizeError(result.bytes, targetMB)
    if (err > 0.1) lines.push({ text: `${Math.round(err * 100)}% over the ${targetMB} MB target: this encoder could not hold the rate. Try the Software encoder.`, warn: true })
    else lines.push({ text: `Target ${targetMB} MB: ${err <= 0 ? 'within the limit' : `${Math.round(err * 100)}% over`}${err < -0.1 ? ' (the video needed fewer bits)' : ''}.` })
  }
  const limit = result.limit
  if (limit && result.bytes > limit.maxMB * MB) {
    lines.push({ text: `Larger than the ${limit.maxMB} MB ${limit.label} accepts: set a target size of about ${Math.floor(limit.maxMB * 0.95)} MB and export again.`, warn: true })
  }
  if (!lines.length) return null
  return (
    <>
      {lines.map((l) => (
        <p key={l.text} className={`hint export-target-report ${l.warn ? 'warn' : ''}`}>
          {l.text}
        </p>
      ))}
    </>
  )
}

function statusText(s: BatchStatus): string {
  switch (s.state) {
    case 'waiting':
      return 'Waiting'
    case 'running': {
      const p = s.progress
      if (!p || p.phase === 'preparing') return 'Preparing…'
      if (p.phase === 'finalizing') return p.detail ?? 'Finalizing…'
      return `Rendering… ${Math.floor((p.frame / Math.max(1, p.frames)) * 100)}%`
    }
    case 'done':
      return `${formatBytes(s.bytes)} · ${formatDuration(s.seconds)}`
    case 'failed':
      return s.message
    case 'cancelled':
      return 'Cancelled'
  }
}

function BatchView({
  phase,
  onCancel,
  onDone,
  onBack,
  primary,
  copy,
  onCopy
}: {
  phase: Extract<Phase, { kind: 'batch' }>
  onCancel: () => void
  onDone: () => void
  onBack: () => void
  primary: RefObject<HTMLButtonElement>
  copy: CopyState
  onCopy: (file: string) => void
}): JSX.Element {
  const done = phase.statuses.filter((s) => s.state === 'done').length
  const failed = phase.statuses.filter((s) => s.state === 'failed').length
  const current = phase.statuses.findIndex((s) => s.state === 'running')
  const run = current >= 0 ? phase.statuses[current] : null
  const frac = run && run.state === 'running' && run.progress?.phase === 'rendering' ? run.progress.frame / Math.max(1, run.progress.frames) : run ? 1 : 0
  const overall = phase.jobs.length ? (done + failed + (current >= 0 ? frac : 0)) / phase.jobs.length : 0
  const firstDone = phase.statuses.find((s): s is Extract<BatchStatus, { state: 'done' }> => s.state === 'done')
  return (
    <>
      {phase.finished ? (
        <p className={failed ? 'error export-error' : 'success'}>
          {!failed && <Icon name="check" />}
          {failed ? `Batch finished: ${done} of ${phase.jobs.length} exported` : `Batch finished: ${done} file${done === 1 ? '' : 's'} exported`}
        </p>
      ) : (
        <>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${overall * 100}%` }} />
          </div>
          <p className="hint export-status">
            {current >= 0 ? `Exporting ${current + 1} of ${phase.jobs.length}: ${phase.jobs[current].label} · ${statusText(phase.statuses[current])}` : 'Preparing…'}
          </p>
        </>
      )}
      <p className="hint path">{phase.folder}</p>
      <ul className="batch-list">
        {phase.jobs.map((job, i) => {
          const s = phase.statuses[i]
          const p = s.state === 'running' && s.progress?.phase === 'rendering' ? s.progress.frame / Math.max(1, s.progress.frames) : null
          return (
            <li key={job.key} className={`batch-row ${s.state}`} data-state={s.state}>
              <span className="batch-icon" aria-hidden="true">
                {s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'failed' ? <Icon name="x" size={14} /> : s.state === 'running' ? <span className="batch-spinner" /> : <span className="batch-dot" />}
              </span>
              <span className="batch-text">
                <span className="batch-name" title={s.state === 'done' ? s.path : job.fileName}>
                  {s.state === 'done' ? s.path.split(/[\\/]/).pop() : job.fileName}
                </span>
                <span className="batch-status">{statusText(s)}</span>
                {p !== null && (
                  <span className="batch-bar">
                    <span style={{ width: `${p * 100}%` }} />
                  </span>
                )}
                {s.state === 'done' && (s.reduced || s.overLimit) && (
                  <span className={`batch-status ${s.overLimit ? 'warn' : ''}`}>{s.overLimit ? `Still over ${job.options.targetSizeMB} MB` : `Fitted: ${s.reduced}`}</span>
                )}
              </span>
              {s.state === 'done' && (
                <button className="btn ghost small" title="Copy the file" onClick={() => onCopy(s.path)}>
                  <CopyIcon />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {copy.kind === 'failed' && <p className="hint warn">{copy.message}</p>}
      {copy.kind === 'copied' && <p className="hint">Copied to the clipboard.</p>}
      <footer className="modal-foot">
        {phase.finished ? (
          <>
            <button className="btn" onClick={onBack}>
              Back
            </button>
            {firstDone && (
              <button className="btn" onClick={() => void window.api.showItemInFolder(firstDone.path)}>
                <Icon name="folder" size={16} /> Show in folder
              </button>
            )}
            <button ref={primary} className="btn primary" onClick={onDone}>
              Done
            </button>
          </>
        ) : (
          <button className="btn" onClick={onCancel}>
            Cancel export
          </button>
        )}
      </footer>
    </>
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
    status = progress?.detail ? `Finalizing… ${progress.detail.replace(/…$/, '').toLowerCase()}` : gif ? 'Finalizing… building the GIF' : 'Finalizing…'
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

