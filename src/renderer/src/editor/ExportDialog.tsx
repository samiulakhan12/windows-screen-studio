import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { pictureTime, planOf, videoDuration, videoFrames, videoTimeAt, videoToSource } from '../../../shared/engine/freeze'
import { followSuggestion } from '../../../shared/editor/followEdit'
import { cropProject, visibleSize } from '../../../shared/engine/crop'
import { viewMagnification } from '../../../shared/engine/frameView'
import { styleContentRect } from '../../../shared/engine/layout'
import { followApplies } from '../../../shared/engine/reframeData'
import { outputDuration, outputToSource } from '../../../shared/engine/timeline'
import type { ExportCapabilities, ExportFinish, FfmpegVideoEncoder, TimelineEditor } from '../../../shared/api/export'
import { audioLook, hasSoundtrack } from '../../../shared/audio/settings'
import { exportBaseName } from '../../../shared/import/imported'
import { outputChapters, youtubeChapters, type OutputChapter } from '../../../shared/render/chapters'
import { clickSoundJob } from '../../../shared/render/clickSound'
import { exportProject, exportSize, isAudioOnly, LOW_BPP, MAX_EXPORT_SIDE, MB, sizeError, targetBitrates, type ExportSize } from '../../../shared/render/exportPlan'
import {
  applyPreset,
  BATCH_ASPECTS,
  batchFileNames,
  batchItems,
  FORMAT_LABELS,
  matchesUserPreset,
  normalizeOptions,
  presetById,
  readBatchChoice,
  shownPresets,
  type BatchChoice,
  RESOLUTION_LABELS,
  safeFileName,
  TARGET_MB_RANGE,
  tweakOptions,
  type ExportOptions,
  type ExportPreset
} from '../../../shared/render/exportPresets'
import type { AspectRatio, ExportCodec, ExportFormat, ExportSettings, Project } from '../../../shared/types'
import { fmt } from '../../../shared/i18n/fmt'
import { t, tNodes, uiLanguage, type MessageKey } from '../../../shared/i18n/t'
import { seeThrough } from '../../../shared/render/alpha'
import { stemsBlocked, timelineBlocked, editorBlocked } from '../../../shared/render/alsoSave'
import { CODEC_NAMES, codecHintValues, codecNotice, pickFormat, pickResolution, settingsRows, sizeLine, usableCodec, usableHere, type CodecUiCaps } from '../../../shared/render/exportRows'
import { codecOf, DEFAULT_CODEC, isIntermediate } from '../../../shared/render/proFormats'
import { startGuard, waitThenStart } from '../../../shared/jobs/startGuard'
import { stemJobOf } from '../../../shared/render/stems'
import { readUserPresets, USER_PRESET_LIMIT, type UserExportPreset, type UserPresetStore } from '../../../shared/render/userPresets'
import { savePreset, suggestName } from '../../../shared/render/userPresetsEdit'
import { webCodecsSupport } from '../render/proEncoders'
import { BackgroundRow, CodecRow, FPS_LABEL_ID, FrameRateRow } from './exportRows'
import { focusAfterSave, ImportPresets, SavePresetField, UserPresets } from './UserPresets'
import { Icon } from '../components/Icon'
import type { RenderScene } from '../render/compositor'
import { missingCatalogNotes, missingFonts, prepareProjectFonts } from '../render/fontLoader'
import { missingOverlays, prepareOverlays } from '../render/overlayLayer'
import { overlayLabel } from '../../../shared/editor/overlays'
import { avcConfigs, supportedAvcConfig, vp9Configs } from '../render/encoders'
import { EditorContext } from './context'
import { useGroup } from './groupContext'
import { AspectGlyph, PresetBadge } from './exportIcons'
import { ExportPreview } from './ExportPreview'
import { exportBatch, exportVideo, GIF_FPS, GIF_MAX_HEIGHT, renderThumbnail, type BatchJob, type BatchStatus, type ExportProgress, type ExportResult } from './exporter'
import { useModalFocus } from './modalFocus'
import { progressShare, useLongJob, type ExportJobLink } from './exportJobs'
import { ExportBundleOptions } from './ExportBundleOptions'
import { STREAM_FORMATS, SubtitlesField } from './panels/SubtitlesField'
import { tickedExportLanguages } from '../../../shared/captions/captionTracks'
import { partSource, partThumbnailFrame, writeBundle, type BundleRequest } from './exportBundleRun'
import { bundleKinds, chapterParts, normalizeBundle, partFileNames, perChapterBlocked, stillAcrossChapters, type BundleOptions } from '../../../shared/render/exportBundle'
import { FORMAT_EXTENSIONS } from '../../../shared/render/exportPresets'
import { ShareAfterExport } from '../share/ShareAfterExport'
import { ShareDone } from '../share/ShareDone'
import { pendingChapters } from '../../../shared/chapters/pending'
import { useAfterExport } from '../share/useShare'
import type { BatchExtras } from './exporter'
import { missingLutCount, missingLutQuestion, prepareLuts } from '../render/lutCache'
import './exportDialog.css'
import './panels/colour.css'
import './handsOff.css'
import './titles.css'
import './exportPro.css'
import { richText } from '../i18n/richText'
import { NumberField } from '../i18n/NumberField'
import { itemLabel, presetName } from './exportNames'
import { chaptersNoteText } from './exportNames'

interface Props {
  project: Project
  scene: RenderScene
  screenUrl: string
  webcamUrl: string | null
  background: HTMLImageElement | null
  onClose: () => void
  /** Closes the dialog and opens the Short clips panel (smart-tools.md §2.4: the done view's link). */
  onShortClips?: () => void
}

type Phase =
  | { kind: 'settings' }
  | { kind: 'running'; progress: ExportProgress | null; step?: 'timeline' }
  | ({ kind: 'done'; path: string; targetMB?: number; limit?: { label: string; maxMB: number }; extras?: BatchExtras; also?: AlsoDone } & ExportResult)
  | { kind: 'batch'; jobs: BatchJob[]; statuses: BatchStatus[]; folder: string; finished: boolean }
  | { kind: 'error'; message: string; detail: string }

type CopyState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'copied' } | { kind: 'failed'; message: string }

/** What an export asked of Also save's stems and timeline, and what came of them (output-and-languages §2.4). */
export interface AlsoDone {
  stems: { stem: string; path: string }[]
  stemsProblem?: string
  editors: TimelineEditor[]
  media: 'export' | 'recordings'
}

/** The steps a running export takes after its video (§2.4): stems inside the finish, then the timeline. */
export interface RunSteps {
  stems: boolean
  timeline: 'export' | 'recordings' | null
}

/** The HEVC probe as the dialog knows it (it runs once, when the dialog first needs it, §5.9). */
type HevcProbe = 'idle' | 'probing' | FfmpegVideoEncoder[]
type ThumbState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved'; path: string; width: number; height: number } | { kind: 'failed'; message: string }

const SETTINGS_KEY = 'export-settings'
const MODE_KEY = 'export-mode'
const BATCH_KEY = 'export-batch'
const OPEN_KEY = 'export-settings-open'
const BUNDLE_KEY = 'export-bundle'

/** Bundle choices without the subtitle languages, which belong to one project (Captions Studio §2.13). */
function withoutLanguages(b: BundleOptions): BundleOptions {
  const { languages: _languages, ...rest } = b
  void _languages
  return rest
}

const RESOLUTIONS: ExportSettings['resolution'][] = [720, 1080, 1440, 2160]
/** The format chips (their names stay as they are; the titles are made where they are shown). */
const formatChoices = (): { value: ExportFormat; label: string; title: string }[] => [
  { value: 'mp4', label: 'MP4', title: t('export.format.mp4') },
  { value: 'mov', label: 'MOV', title: t('export.format.mov') },
  { value: 'webm', label: 'WebM', title: t('export.format.webm') },
  { value: 'gif', label: 'GIF', title: t('export.format.gif') },
  { value: 'm4a', label: 'M4A', title: t('export.format.m4a') }
]

/** The audio a format carries with `codec` (§5.2), for the selected format chip's title. */
const audioOf = (o: ExportOptions): 'aac' | 'opus' | 'pcm' => (o.format === 'webm' ? 'opus' : o.format === 'mov' && isIntermediate(codecOf(o)) ? 'pcm' : 'aac')

/** Wave 12's destinations: their card label and title in the UI language (§2.2); the others keep their labels as before. */
const NEW_DESTINATIONS: Readonly<Record<string, { label: MessageKey; title: MessageKey }>> = {
  'portrait-post': { label: 'presets.destination.portrait.label', title: 'presets.destination.portrait.title' },
  editing: { label: 'presets.destination.editing.label', title: 'presets.destination.editing.title' },
  overlay: { label: 'presets.destination.overlay.label', title: 'presets.destination.overlay.title' }
}

const presetLabel = (p: ExportPreset): string => (NEW_DESTINATIONS[p.id] ? t(NEW_DESTINATIONS[p.id].label) : presetName(p))

/** The quality chips of the editing formats (§2.1): Best, High, Medium, with the encoder's own level as title. */
const INTERMEDIATE_TITLES: Partial<Record<ExportCodec, Record<ExportSettings['quality'], MessageKey>>> = {
  cineform: { high: 'codecs.quality.cineform.film1', medium: 'codecs.quality.cineform.high', small: 'codecs.quality.cineform.medium' },
  'prores-422': { high: 'codecs.quality.prores.hq', medium: 'codecs.quality.prores.standard', small: 'codecs.quality.prores.lt' }
}

/** Which timeline file a saved path is, by the names main gives them (§2.3), for the done view's lines; null for a sidecar. */
function timelineFileOf(file: string): 'fcpxml' | 'xmeml' | 'markers' | 'edl' | 'media' | null {
  if (/\.(srt|vtt|txt|png)$/i.test(file)) return null
  if (/\.fcpxml$/i.test(file)) return 'fcpxml'
  if (/\.xml$/i.test(file)) return 'xmeml'
  if (/ - Resolve markers( \(\d+\))?\.edl$/i.test(file)) return 'markers'
  if (/\.edl$/i.test(file)) return 'edl'
  // The recordings' copies: the "<name> media" folder (" (2)" when the name was taken), never a stem.
  if (/ media( \(\d+\))?$/i.test(file.split(/[\\/]/).pop() ?? file)) return 'media'
  return null
}

/** The stored user presets, read through the reader main uses too (anything malformed: none). */
async function loadUserPresets(): Promise<UserPresetStore> {
  try {
    return readUserPresets(await window.api.getPref('exportPresets')) ?? { version: 1, presets: [] }
  } catch {
    return { version: 1, presets: [] }
  }
}

/** The HEVC and AV1 probes of this session (main caches them too): each runs once. */
const probes = new Map<'hevc' | 'av1', Promise<FfmpegVideoEncoder[]>>()
function probe(codec: 'hevc' | 'av1'): Promise<FfmpegVideoEncoder[]> {
  let p = probes.get(codec)
  if (!p) {
    p = window.api.probeCodec(codec).catch(() => [] as FfmpegVideoEncoder[])
    probes.set(codec, p)
  }
  return p
}

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

/** The stored batch choices, read by the frozen reader (output-and-languages §4.3): an old value reads back as stored. */
function loadBatch(): BatchChoice {
  return readBatchChoice(readJson<unknown>(BATCH_KEY, {}))
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
function ChapterCopy({ chapters, length, gif, perChapter = false }: { chapters: OutputChapter[]; length: number; gif: boolean; perChapter?: boolean }): JSX.Element | null {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const yt = useMemo(() => youtubeChapters(chapters, length), [chapters, length])
  useEffect(() => setState('idle'), [yt.text])
  if (!chapters.length) return null
  const copy = async (): Promise<void> => setState((await copyText(yt.text)) ? 'copied' : 'failed')
  return (
    <div className="export-chapters" data-testid="export-chapters">
      <p className="hint">{chaptersNoteText(chapters.length, gif, perChapter)}</p>
      <button className="btn small chapter-copy" onClick={() => void copy()} title={t('export.chapters.copyTitle')}>
        {state === 'copied' ? <Icon name="check" size={14} /> : <CopyIcon />} {state === 'copied' ? t('common.state.copied') : t('export.chapters.copy')}
      </button>
      {state === 'failed' && <p className="hint warn">{t('export.chapters.copyFailed')}</p>}
      {yt.problems.length ? (
        yt.problems.map((p) => (
          <p key={p} className="hint warn">
            {p}
          </p>
        ))
      ) : (
        <p className="hint">{t('export.chapters.ready')}</p>
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
  return { message: message.trim() || t('export.error.failed'), detail: rest.join('\n\n').trim() }
}

const ratioOf = (s: { width: number; height: number }): number => s.width / s.height

/** "1080×1920 · 30 fps" for a card; GIFs and audio say what they are; a codec other than the format's own, "MOV · CineForm · 1080p60". */
function optionsMeta(project: Project, o: ExportOptions): string {
  if (isAudioOnly(o.format)) return t('export.audioOnly')
  const codec = codecOf(o)
  const standard = DEFAULT_CODEC[o.format]
  if (standard && codec !== standard) return t('presets.meta.line', { format: FORMAT_LABELS[o.format], codec: CODEC_NAMES[codec], resolution: String(o.resolution), fps: String(o.fps) })
  const s = exportSize(project, o)
  return t('export.meta.size', { width: fmt.count(s.width), height: fmt.count(s.height), fps: fmt.count(s.fps) })
}

/** A destination card's meta line. */
const presetMeta = (project: Project, preset: ExportPreset): string => optionsMeta(project, applyPreset({ encoder: 'auto' }, preset))

/** The one limit worth showing on a card: its size target, else the platform's longest video. */
function presetLimit(preset: ExportPreset): { text: string; title: string } | null {
  if (preset.targetSizeMB) return { text: t('export.limit.size', { mb: fmt.number(preset.targetSizeMB) }), title: t('export.limit.sizeTitle', { mb: fmt.number(preset.targetSizeMB) }) }
  const l = preset.limits
  if (!l?.maxSeconds) return null
  const title = { name: presetLabel(preset), length: fmt.clock(l.maxSeconds, 'whole') }
  return {
    text: t('export.limit.length', { length: fmt.clock(l.maxSeconds, 'whole') }),
    title: l.maxMB ? t('export.limit.lengthSizeTitle', { ...title, mb: fmt.number(l.maxMB) }) : t('export.limit.lengthTitle', title)
  }
}

export function ExportDialog(props: Props): JSX.Element {
  const editor = useContext(EditorContext)
  const group = useGroup()
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
  const [runSteps, setRunSteps] = useState<RunSteps>({ stems: false, timeline: null })
  const [targetDraft, setTargetDraft] = useState<string>(() => (options.targetSizeMB ? String(options.targetSizeMB) : ''))
  // Hands-off long jobs (F-12): pause, the taskbar and sleep; the export bundle (F-11).
  const job = useLongJob()
  // The subtitle languages are the project's own: never remembered between exports (Captions Studio §2.13).
  const [bundle, setBundle] = useState<BundleOptions>(() => withoutLanguages(normalizeBundle(readJson(BUNDLE_KEY, {}))))
  // Also inside the video (Captions Studio §2.13): off when the dialog opens.
  const [streams, setStreams] = useState(false)
  // The user's own presets (output-and-languages §2.2), from editor-prefs.json; null until read.
  const [store, setStore] = useState<UserPresetStore | null>(null)
  // The Save as preset field is open.
  const [naming, setNaming] = useState(false)
  const saveButton = useRef<HTMLButtonElement>(null)
  // The codec Transparent or Overlays only replaced, given back by With background in this dialog session (§2.1).
  const [replaced, setReplaced] = useState<ExportCodec | null>(null)
  // "4K with H.264 is exported at 60 fps." after picking 4K set the rate.
  const [fpsNote, setFpsNote] = useState<string | null>(null)
  // What this PC makes beyond H.264 and VP9 (§5.9): the HEVC probe, the AV1 probe, and WebCodecs at this size.
  const [hevcProbe, setHevcProbe] = useState<HevcProbe>('idle')
  const [av1Probe, setAv1Probe] = useState<FfmpegVideoEncoder[] | null>(null)
  const [webCodecs, setWebCodecs] = useState<{ hevc: boolean; av1: boolean }>({ hevc: false, av1: false })
  // Share without a server (F-22): copy to a cloud folder and post to a chat after export, per preset.
  const share = useAfterExport(options.preset)
  const { project } = props
  const clips = project.clips
  // Fonts text uses that cannot be loaded (their text is drawn with the default font) and images
  // that cannot be shown (left out): said below, so another PC's missing files are no surprise.
  const [lostFonts, setLostFonts] = useState<string[]>([])
  // Caption fonts not there (a download not made on this PC): their notes (Captions Studio §2.13).
  const [lostCaptionFonts, setLostCaptionFonts] = useState<string[]>([])
  const [lostImages, setLostImages] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void prepareProjectFonts(project).then(() => live && setLostFonts(missingFonts(project).map((f) => f.name)))
    void missingCatalogNotes(project).then((notes) => live && setLostCaptionFonts(notes))
    void prepareOverlays(project).then(() => live && setLostImages(missingOverlays(project).map(overlayLabel)))
    return () => {
      live = false
    }
  }, [project])
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
  // The HEVC probe and the save dialog before an export starts: a second Export click meanwhile does nothing.
  const [beforeStart] = useState(() => startGuard(() => abort.current !== null))
  // An Export click while the HEVC probe runs waits for it with the button saying so, then starts the
  // export the dialog shows by then (exportNow, set below); closing the dialog meanwhile starts nothing.
  const [checking, setChecking] = useState(false)
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const [afterProbe] = useState(() => waitThenStart({ waiting: setChecking, open: () => open.current }))
  const exportNow = useRef<(() => Promise<void>) | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  // What this PC makes (§2.1): HEVC as the probe found it (unknown while it has not run), AV1 on the
  // graphics card when its probe or WebCodecs found one.
  const h264Gpu = !!caps?.hardwareEncoders.length
  const uiCaps: CodecUiCaps = useMemo(
    () => ({
      hevc: hevcProbe === 'idle' || hevcProbe === 'probing' ? 'probing' : webCodecs.hevc ? 'webcodecs' : hevcProbe.length ? hevcProbe : 'none',
      av1Gpu: webCodecs.av1 || !!av1Probe?.length,
      h264Gpu
    }),
    [hevcProbe, webCodecs, av1Probe, h264Gpu]
  )
  // The settings as this PC exports them: stored HEVC where none can be made exports with the format's
  // default (§2.1). The same object while nothing changes, so the preview does not draw again.
  const effective = useMemo(() => usableCodec(options, uiCaps).options, [options, uiCaps])
  const usableNow = usableHere(uiCaps)

  const gif = effective.format === 'gif'
  const audioOnly = isAudioOnly(effective.format)
  const resolution = gif ? (Math.min(effective.resolution, GIF_MAX_HEIGHT) as ExportSettings['resolution']) : effective.resolution
  const drawn = useMemo(() => exportProject(project, effective), [project, effective])
  const dims = exportSize(project, effective)
  const hasClickSounds = useMemo(() => !!clickSoundJob(project, props.scene.cursor, clips), [project, props.scene.cursor, clips])
  const hasSound = hasSoundtrack(project, hasClickSounds)
  const preset = presetById(options.preset)
  const userPreset = (options.userPreset && store?.presets.find((p) => p.id === options.userPreset)) || null
  const chapters = useMemo(() => outputChapters(project.chapters ?? [], clips, plan), [project.chapters, clips, plan])
  const parts = useMemo(() => chapterParts(project), [project])
  const bundleHas = { captions: !!project.transcript?.segments.some((seg) => seg.text.trim()), chapters: chapters.length > 0, stillAcross: stillAcrossChapters(project, parts) }
  const perChapter = bundle.perChapter && !perChapterBlocked(bundleHas, mode) && parts.length > 0
  const partNames = useMemo(() => partFileNames(parts, FORMAT_EXTENSIONS[options.format]), [parts, options.format])
  // The rows of the Settings section (§2.1), for the settings as this PC exports them.
  const transparentShows = !effective.alpha || seeThrough(drawn, effective.alpha, dims.width, dims.height)
  const rows = settingsRows(options, uiCaps, { seeThrough: transparentShows, size: dims, seconds: length })

  useEffect(() => {
    let live = true
    void loadUserPresets().then((s) => live && setStore(s))
    return () => {
      live = false
    }
  }, [])

  // The HEVC probe runs when the Settings section first shows MP4 or MOV, or when the settings ask for HEVC (§5.9).
  const needHevc =
    (settingsOpen && (options.format === 'mp4' || options.format === 'mov')) ||
    options.codec === 'hevc' ||
    (mode === 'batch' && !!store?.presets.some((p) => p.options.codec === 'hevc' && batch.userPresets?.includes(p.id)))
  const hevcAsked = useRef(false)
  useEffect(() => {
    if (!needHevc || hevcAsked.current) return
    hevcAsked.current = true
    setHevcProbe('probing')
    void probe('hevc').then(setHevcProbe)
  }, [needHevc])
  // The AV1 probe runs when AV1 is chosen.
  const needAv1 = codecOf(effective) === 'av1'
  useEffect(() => {
    if (!needAv1 || av1Probe) return
    let live = true
    void probe('av1').then((found) => live && setAv1Probe(found))
    return () => {
      live = false
    }
  }, [needAv1, av1Probe])
  // WebCodecs HEVC and AV1 at this size and rate (only once a probe was needed: nothing runs for today's settings).
  useEffect(() => {
    if (!needHevc && !needAv1) return
    let live = true
    void webCodecsSupport(dims.width, dims.height, dims.fps)
      .then((w) => live && setWebCodecs(w))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [needHevc, needAv1, dims.width, dims.height, dims.fps])

  // A user preset that is gone no longer names the settings (as tweakOptions drops a stale destination).
  useEffect(() => {
    if (!store || !options.userPreset || store.presets.some((p) => p.id === options.userPreset)) return
    setOptions((o) => {
      const next = { ...o }
      delete next.userPreset
      return next
    })
  }, [store, options.userPreset])
  // Nor is it ticked in a batch any more.
  useEffect(() => {
    if (!store || !batch.userPresets?.length) return
    const kept = batch.userPresets.filter((id) => store.presets.some((p) => p.id === id))
    if (kept.length === batch.userPresets.length) return
    const choice: BatchChoice = { presets: batch.presets, aspects: batch.aspects }
    if (kept.length) choice.userPresets = kept
    setBatch(choice)
    writeJson(BATCH_KEY, choice)
  }, [store, batch])

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
      // A name field, a preset's menu or its delete question closes itself first (UserPresets.tsx).
      if (e.target instanceof Element && e.target.closest('[data-own-escape]')) return
      e.preventDefault()
      e.stopPropagation()
      onClose.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [running])

  // The selected user preset stays while the settings still match it, as this PC exports them (§2.2).
  const keepUserPreset = (next: ExportOptions): ExportOptions => {
    if (!next.userPreset || !store) return next
    const p = store.presets.find((q) => q.id === next.userPreset)
    if (p && matchesUserPreset(next, p, usableNow)) return next
    const out = { ...next }
    delete out.userPreset
    return out
  }
  const save = (raw: ExportOptions): void => {
    const next = keepUserPreset(raw)
    setOptions(next)
    writeJson(SETTINGS_KEY, next)
  }
  const set = (patch: Partial<ExportOptions>): void => {
    setFpsNote(null)
    save(tweakOptions(options, patch))
  }
  /** A pick of the wave 12 rows (they may switch other settings in the same step): the target size field follows. */
  const apply = (next: ExportOptions, note: string | null = null): void => {
    setFpsNote(note)
    save(next)
    if (next.targetSizeMB !== options.targetSizeMB) setTargetDraft(next.targetSizeMB ? String(next.targetSizeMB) : '')
  }
  const pickPreset = (p: ExportPreset): void => {
    const next = applyPreset(options, p)
    setFpsNote(null)
    setReplaced(null)
    save(next)
    setTargetDraft(next.targetSizeMB ? String(next.targetSizeMB) : '')
  }
  const saveStore = (next: UserPresetStore): void => {
    setStore(next)
    void window.api.setPref('exportPresets', next).catch(() => undefined)
  }
  /** Picks a user preset: its settings and its Also save choices (never the subtitle languages, §2.2). */
  const pickUserPreset = (p: UserExportPreset): void => {
    const next: ExportOptions = { ...p.options, userPreset: p.id }
    delete next.preset
    setFpsNote(null)
    setReplaced(null)
    setOptions(next)
    writeJson(SETTINGS_KEY, next)
    setTargetDraft(next.targetSizeMB ? String(next.targetSizeMB) : '')
    if (p.bundle) {
      const b: BundleOptions = { ...normalizeBundle(p.bundle), ...(bundle.languages ? { languages: bundle.languages } : {}) }
      setBundle(b)
      writeJson(BUNDLE_KEY, withoutLanguages(b))
    }
  }
  const saveAsPreset = (name: string): void => {
    if (!store) return
    const next = savePreset(store, name, effective, withoutLanguages(bundle), Date.now(), Math.random)
    setNaming(false)
    const added = next === store ? null : next.presets[next.presets.length - 1]
    // Back to Save as preset, or to the last preset (the new one, or the 50th) when the button is off.
    requestAnimationFrame(() => focusAfterSave(saveButton.current, next.presets))
    if (!added) return
    saveStore(next)
    pickUserPreset(added)
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

  const baseName = safeFileName(exportBaseName(project))
  // The subtitle languages ticked (Captions Studio §2.13, §11.10): one SRT or VTT file each, and
  // with Also inside the video one stream each (read by the exporter as subtitleLanguages and by
  // the bundle as languages, part P2's plumbing).
  const subtitleLanguages = tickedExportLanguages(project, bundle.languages)
  const source = { project, scene: props.scene, screenUrl: props.screenUrl, webcamUrl: props.webcamUrl, background: props.background, subtitleLanguages }
  /** The export settings with Also inside the video, for the formats that carry subtitle streams. */
  const streamed = (o: ExportOptions): ExportOptions => (streams && STREAM_FORMATS.includes(o.format) ? { ...o, subtitleStreams: true } : o)
  const bundleLanguages = { languages: subtitleLanguages }

  // The frame of the Frame slider, as the export at `settings` draws it (the bundle's thumbnail).
  const thumbnailOf = (settings: ExportOptions) => (): Promise<Uint8Array> =>
    renderThumbnail({ ...source, settings, time: frameSource, soundTime: frameSound, held: frameHeld }).then((shot) => shot.png)

  /**
   * The settings this export uses: as this PC exports them, after the HEVC probe when the settings ask
   * for HEVC and it is still running (§2.1).
   */
  const exportedSettings = async (): Promise<ExportOptions> => {
    if (options.codec !== 'hevc' || (hevcProbe !== 'idle' && hevcProbe !== 'probing')) return effective
    const found = await probe('hevc')
    return usableCodec(options, { ...uiCaps, hevc: webCodecs.hevc ? 'webcodecs' : found.length ? found : 'none' }).options
  }

  const start = async (): Promise<void> => {
    if (perChapter) return startChapters()
    const chosen = await beforeStart(async () => {
      const settings = await exportedSettings()
      return { settings, outputPath: await window.api.chooseExportPath(baseName, settings.format) }
    })
    if (!chosen?.outputPath) return
    const { settings } = chosen
    const outputPath = chosen.outputPath
    const controller = new AbortController()
    abort.current = controller
    setCopy({ kind: 'idle' })
    setShowDetail(false)
    // Also save (§2.3): the stems inside the export's finish, the timeline after the other files.
    const wantStems = bundle.stems === true && !stemsBlocked(settings, 'single', false, hasSound)
    const editors = timelineBlocked(settings, 'single', false) ? [] : (bundle.timelines ?? []).filter((e) => !editorBlocked(e, settings, bundle.timelineMedia ?? 'export'))
    const media = bundle.timelineMedia ?? 'export'
    setRunSteps({ stems: wantStems, timeline: editors.length ? media : null })
    setPhase({ kind: 'running', progress: null })
    const link = await job.begin(controller)
    try {
      const result = await exportVideo({
        ...source,
        settings: streamed(settings),
        outputPath,
        signal: controller.signal,
        pause: job.gate,
        ...(wantStems ? { stems: true as const } : {}),
        onProgress: (progress) => {
          if (controller.signal.aborted) return
          setPhase({ kind: 'running', progress })
          const share = progressShare(progress)
          link?.progress(share.fraction, share.pausable)
        }
      })
      link?.progress(null, false)
      // The stems main wrote next to the video, or why it could not (output-and-languages §7.6).
      const finished = result as ExportResult & Pick<ExportFinish, 'stems' | 'stemsProblem'>
      const stems = (finished.stems ?? []).map(({ stem, path }) => ({ stem, path }))
      const limit = preset?.limits?.maxMB ? { label: presetLabel(preset), maxMB: preset.limits.maxMB } : undefined
      if (result.cancelledAfterVideo) {
        // Cancelled while main wrote the stems (§7.6): the video is saved and shown as saved, the stems
        // are gone, and nothing after them (sidecars, timeline, sharing) is written or started.
        void link?.end({ kind: 'done', files: [outputPath] })
        const stemsProblem = finished.stemsProblem ?? (stems.length ? undefined : t('stems.done.cancelled'))
        setPhase({ kind: 'done', path: outputPath, targetMB: settings.targetSizeMB, limit, also: wantStems ? { stems, stemsProblem, editors: [], media } : undefined, ...result })
        return
      }
      const kinds = bundleKinds(bundle, settings.format, bundleHas)
      let timeline: BundleRequest['timeline']
      if (editors.length) {
        const shown = exportSize(project, settings)
        const exported = exportProject(project, settings)
        const frames = videoFrames(exported.clips, planOf(exported), shown.fps).times.length
        timeline = { request: { projectId: project.id, videoPath: outputPath, editors, media, stems }, exported: { fps: shown.fps, frames, width: shown.width, height: shown.height } }
        setPhase((p) => (p.kind === 'running' ? { ...p, progress: p.progress ? { ...p.progress, phase: 'finalizing', detail: undefined } : p.progress, step: 'timeline' } : p))
      }
      const extras = await writeBundle(outputPath, { project, kinds, title: project.name, thumbnail: thumbnailOf(settings), ...bundleLanguages, ...(timeline ? { timeline, signal: controller.signal } : {}) })
      // Cancel export after the video (the timeline's step) keeps the video and starts no share.
      if (!controller.signal.aborted) await share.begin(outputPath, { title: project.name, seconds: length })
      void link?.end({ kind: 'done', files: [outputPath] })
      const also: AlsoDone | undefined = wantStems || editors.length ? { stems, stemsProblem: finished.stemsProblem, editors, media } : undefined
      setPhase({ kind: 'done', path: outputPath, targetMB: settings.targetSizeMB, limit, extras, also, ...result })
    } catch (err) {
      const cancelled = controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
      void link?.end(cancelled ? { kind: 'cancelled' } : { kind: 'failed', message: splitError(err).message })
      if (cancelled) setPhase({ kind: 'settings' })
      else setPhase({ kind: 'error', ...splitError(err) })
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  // A grade's LUT that is missing or has changed (editing polish §9.5): asked about before any export starts.
  const [lutAsk, setLutAsk] = useState<{ question: string; many: boolean; go: () => void } | null>(null)
  const withLuts = async (go: () => Promise<void>): Promise<void> => {
    await prepareLuts(project)
    const question = missingLutQuestion(project)
    if (!question) return go()
    setLutAsk({
      question,
      // Both grades' LUTs (the question asks to export without them): told by the grades, not by the question's words (§9.6).
      many: missingLutCount(project) > 1,
      go: () => {
        setLutAsk(null)
        void go()
      }
    })
  }

  // The ticked user presets (§2.2), in their saved order; one that is gone is left out.
  const checkedUserPresets = useMemo(() => (store?.presets ?? []).filter((p) => batch.userPresets?.includes(p.id)), [store, batch.userPresets])
  const items = useMemo(() => batchItems(batch.presets, batch.aspects, effective, checkedUserPresets), [batch, effective, checkedUserPresets])
  /** A batch file's settings as this PC exports them, and the notice of a user preset whose codec it cannot make. */
  const itemSettings = (it: (typeof items)[number], codecCaps: CodecUiCaps = uiCaps): { options: ExportOptions; notice: MessageKey | null } => {
    const own = checkedUserPresets.some((p) => p.id === it.key) ? { ...it.options, userPreset: it.key } : it.options
    const made = usableCodec(own, codecCaps)
    const options = { ...made.options }
    delete options.userPreset
    return { options, notice: made.notice }
  }
  const startBatch = async (): Promise<void> => {
    if (items.length === 0) return
    const chosen = await beforeStart(async () => {
      const folder = await window.api.chooseExportFolder()
      // HEVC is exported only where the probe found an encoder: wait for it when a file asks for HEVC.
      return folder ? { folder, found: items.some((it) => it.options.codec === 'hevc') ? await probe('hevc') : null } : null
    })
    if (!chosen) return
    const { folder, found } = chosen
    const names = batchFileNames(project.name, items)
    const made: CodecUiCaps = found ? { ...uiCaps, hevc: webCodecs.hevc ? 'webcodecs' : found.length ? found : 'none' } : uiCaps
    const jobs: BatchJob[] = items.map((it, i) => ({ key: it.key, label: itemLabel(it, checkedUserPresets), fileName: names[i], options: streamed(itemSettings(it, made).options) }))
    await runBatch(folder, jobs, (_i, path, j) =>
      writeBundle(path, { project, kinds: bundleKinds(bundle, j.options.format, bundleHas), title: project.name, thumbnail: thumbnailOf(j.options), ...bundleLanguages })
    )
  }

  // The Export button: the export the dialog shows now (none where its button is off), started at
  // once, or after the HEVC probe when these settings ask for HEVC and it still runs (§2.1).
  const canExport = mode === 'single' ? !(audioOnly && !hasSound) : items.length > 0
  exportNow.current = canExport ? () => withLuts(mode === 'single' ? start : startBatch) : null
  const asksHevc = mode === 'single' ? options.codec === 'hevc' : items.some((it) => it.options.codec === 'hevc')
  const onExport = (): void => void afterProbe(asksHevc && (hevcProbe === 'idle' || hevcProbe === 'probing') ? probe('hevc') : null, () => exportNow.current)

  // One file per chapter (F-11): each chapter's range of the edit, into a folder, as a batch.
  const startChapters = async (): Promise<void> => {
    // As a single file: the settings as this PC exports them, after the HEVC probe when they ask for HEVC.
    const chosen = await beforeStart(async () => {
      const settings = await exportedSettings()
      return { settings, folder: await window.api.chooseExportFolder() }
    })
    if (!chosen?.folder) return
    const { settings } = chosen
    const folder = chosen.folder
    // Each part's frames and sound come from its own clips; it is drawn with the whole edit's scene.
    const sources = parts.map((part, i) => partSource(source, part, i === parts.length - 1))
    const jobs: BatchJob[] = parts.map((_part, i) => ({ key: `part-${i}`, label: partNames[i].replace(/\.[^.]+$/, ''), fileName: partNames[i], options: streamed(settings), source: sources[i] }))
    await runBatch(folder, jobs, (i, path) => {
      const part = sources[i]
      // The part's thumbnail: one second in (or its middle when shorter), as the part draws it.
      const frame = partThumbnailFrame(part.project)
      const thumbnail = (): Promise<Uint8Array> => renderThumbnail({ ...part, settings, ...frame }).then((shot) => shot.png)
      return writeBundle(path, {
        project: part.project,
        kinds: bundleKinds(bundle, settings.format, bundleHas, true),
        title: jobs[i].label,
        part: { index: i, count: parts.length, of: project.name },
        thumbnail,
        ...bundleLanguages
      })
    })
  }

  // Runs `jobs` into `folder` with the batch view, the taskbar and pause; `after` saves each file's bundle.
  const runBatch = async (folder: string, jobs: BatchJob[], after: (i: number, path: string, job: BatchJob) => Promise<BatchExtras | undefined>): Promise<void> => {
    const controller = new AbortController()
    abort.current = controller
    setCopy({ kind: 'idle' })
    setPhase({ kind: 'batch', jobs, statuses: jobs.map(() => ({ state: 'waiting' })), folder, finished: false })
    const link: ExportJobLink | null = await job.begin(controller)
    const statuses: BatchStatus[] = jobs.map(() => ({ state: 'waiting' }))
    const update = (i: number, status: BatchStatus): void => {
      statuses[i] = status
      setPhase((p) => (p.kind === 'batch' ? { ...p, statuses: p.statuses.map((s, j) => (j === i ? status : s)) } : p))
      const share = status.state === 'running' ? progressShare(status.progress) : { fraction: 1, pausable: false }
      const settled = statuses.filter((s) => s.state === 'done' || s.state === 'failed').length
      link?.progress(Math.min(1, (settled + (status.state === 'running' ? (share.fraction ?? 1) : 0)) / jobs.length), share.pausable)
    }
    try {
      await exportBatch(source, folder, jobs, update, controller.signal, { pause: job.gate, after })
    } finally {
      if (abort.current === controller) abort.current = null
      setPhase((p) => (p.kind === 'batch' ? { ...p, finished: true } : p))
      const files = statuses.flatMap((s) => (s.state === 'done' ? [s.path] : []))
      const failed = statuses.find((s): s is Extract<BatchStatus, { state: 'failed' }> => s.state === 'failed')
      const failures = statuses.filter((s) => s.state === 'failed').length
      const stopped = statuses.some((s) => s.state === 'cancelled')
      void link?.end(files.length ? { kind: 'done', files, failed: failures, stopped } : failed ? { kind: 'failed', message: failed.message } : { kind: 'cancelled' })
    }
  }

  const saveThumbnail = async (): Promise<void> => {
    const file = await window.api.chooseExportPath(`${baseName} - thumbnail`, 'png')
    if (!file) return
    setThumb({ kind: 'busy' })
    try {
      const shot = await renderThumbnail({ ...source, settings: effective, time: frameSource, soundTime: frameSound, held: frameHeld })
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
  // are limited on their long side), and whether the recording (as shown: its crop) is drawn larger than it was captured.
  const sizeFor = (height: number): ExportSize => exportSize(project, { ...options, resolution: height as ExportSettings['resolution'] })
  const visible = visibleSize(project)
  // NW-05 (docs/design/vertical-video.md §2.2, §2.9): whether this file follows the action and how
  // much larger it shows the recording (then every size is larger than recorded: one line says so
  // instead of a tag on each), and the vertical or square version suggested for a 9:16 or 1:1 output
  // (the file's, or any batch item's) of a project that does not follow.
  const follows = !audioOnly && followApplies(drawn, dims.width, dims.height, visible.width, visible.height)
  const magnify = follows ? viewMagnification(cropProject(drawn), dims.width, dims.height, visible.width, visible.height) : null
  const chosenAspects = mode === 'single' ? (audioOnly ? [] : [drawn.style.aspectRatio]) : items.filter((it) => !isAudioOnly(it.options.format)).map((it) => exportProject(project, it.options).style.aspectRatio)
  const suggestion = followSuggestion(project, chosenAspects, visible.width, visible.height)
  const upscaled = (height: number): boolean => {
    if (follows) return false
    const d = sizeFor(height)
    return styleContentRect(d.width, d.height, visible.width, visible.height, drawn.style).h > visible.height * 1.05
  }
  const resolutionOptions = RESOLUTIONS.filter((r) => !gif || r <= GIF_MAX_HEIGHT).map((r) => {
    const d = sizeFor(r)
    const notes = [`${d.width}×${d.height}`]
    if (d.capped) notes.push(t('export.resolution.capped', { side: fmt.count(MAX_EXPORT_SIDE) }))
    if (upscaled(r)) notes.push(t('export.resolution.upscaled', { width: fmt.count(visible.width), height: fmt.count(visible.height) }))
    return { value: r, label: RESOLUTION_LABELS[r], className: upscaled(r) ? 'upscale' : '', title: notes.join('; ') }
  })
  const projectAspect = project.style.aspectRatio
  const aspectOptions = (['project', ...BATCH_ASPECTS] as const).map((a) => {
    const ratio = a === 'project' ? ratioOf(exportSize(project, { ...options, aspect: undefined })) : ratioOf(exportSize(project, { ...options, aspect: a }))
    return {
      value: a as string,
      label: a === 'project' ? t('export.aspect.project') : a === '4:5' ? t('codecs.aspect.45.label') : a,
      title:
        a === 'project'
          ? t('export.aspect.projectTitle', { shape: projectAspect === 'auto' ? t('export.aspect.auto') : projectAspect })
          : a === '4:5'
            ? t('codecs.aspect.45.title')
            : t('export.aspect.title', { aspect: a }),
      icon: <AspectGlyph ratio={ratio} />
    }
  })
  const gpuNames = caps?.hardwareEncoders.length ? caps.hardwareEncoders.map((e) => e.replace('h264_', '').toUpperCase()).join(', ') : ''
  const gpuHint =
    options.format === 'webm'
      ? webCodecsGpu
        ? t('export.gpu.vp9')
        : webCodecsGpu === null
          ? t('export.gpu.checking')
          : t('export.gpu.noVp9')
      : webCodecsGpu
        ? t('export.gpu.available')
        : gpuNames
          ? t('export.gpu.found', { names: gpuNames })
          : webCodecsGpu === null || !caps
            ? t('export.gpu.checking')
            : t('export.gpu.none')
  const softwareHint = options.format === 'webm' ? t('export.software.vp9') : t('export.software.x264')

  // Size target advice, before exporting.
  const target = options.targetSizeMB
  const targetInfo =
    target && !gif ? targetBitrates({ targetMB: target, seconds: length, hasAudio: hasSound, format: options.format, width: dims.width, height: dims.height, fps: dims.fps }) : null
  const limits = preset?.limits
  const warnings: { key: string; text: string; cls?: string; testid?: string }[] = []
  if (!audioOnly && dims.capped) {
    warnings.push({
      key: 'capped',
      cls: 'export-capped',
      text: t(visible.width >= visible.height ? 'export.warn.cappedWide' : 'export.warn.cappedTall', { side: fmt.count(MAX_EXPORT_SIDE) })
    })
  }
  if (!audioOnly && upscaled(resolution)) {
    warnings.push({ key: 'upscale', cls: 'warn', text: t('export.warn.upscale', { width: fmt.count(visible.width), height: fmt.count(visible.height) }) })
  }
  if (follows) {
    warnings.push({ key: 'follow', testid: 'export-follow-on', text: t('export.warn.followOn') })
    if (magnify) {
      const times = (v: number): string => `${fmt.number(v, { min: 1, max: 1 })}×`
      const size = { width: fmt.count(visible.width), height: fmt.count(visible.height), factor: times(magnify.rest) }
      const soft = magnify.rest >= 2
      const shows = times(magnify.zoomed) !== times(magnify.rest) ? t('export.warn.magnifyZooms', { ...size, zoomed: times(magnify.zoomed) }) : t('export.warn.magnify', size)
      const text = soft ? `${shows} ${t('export.warn.magnifySoft')}` : shows
      warnings.push({ key: 'magnify', testid: 'export-magnify', cls: soft ? 'warn' : '', text })
    }
  } else if (!audioOnly && project.reframe?.mode === 'follow') {
    warnings.push({ key: 'follow', testid: 'export-follow-off', text: t('export.warn.followOff') })
  }
  if (!audioOnly && project.transcript?.segments.length) warnings.push({ key: 'captions', cls: 'export-captions', text: t(project.captions?.show === false ? 'export.warn.captionsOff' : 'export.warn.captionsOn') })
  if (!audioOnly && lostImages.length)
    warnings.push({ key: 'images', cls: 'warn', text: t('export.warn.images', { names: [...new Set(lostImages)].join(', ') }) })
  if (!audioOnly && lostFonts.length)
    warnings.push({ key: 'fonts', cls: 'warn', text: t('export.warn.fonts', { names: lostFonts.join(', ') }) })
  if (!audioOnly) for (const text of lostCaptionFonts) warnings.push({ key: `caption-font ${text}`, cls: 'warn', testid: 'export-caption-font', text })
  if (gif && length > 30) warnings.push({ key: 'gif', cls: 'warn', text: t('export.warn.longGif') })
  if (audioOnly && !hasSound) warnings.push({ key: 'silent', cls: 'warn', text: t('export.warn.silent') })
  if (limits?.maxSeconds && length > limits.maxSeconds) {
    warnings.push({ key: 'len', cls: 'warn', text: t('export.warn.tooLong', { name: presetLabel(preset!), max: fmt.clock(limits.maxSeconds, 'whole'), length: fmt.clock(length, 'whole') }) })
  }
  if (targetInfo && !targetInfo.feasible) {
    warnings.push({ key: 'target', cls: 'warn', text: t('export.warn.targetSmall', { mb: fmt.number(target!), length: fmt.clock(length, 'whole') }) })
  } else if (targetInfo && targetInfo.bpp < LOW_BPP && !audioOnly) {
    warnings.push({ key: 'target', cls: 'warn', text: t('export.warn.targetTight', { mb: fmt.number(target!), width: fmt.count(dims.width), height: fmt.count(dims.height), fps: fmt.count(dims.fps) }) })
  }

  const exportLabel = t('export.exportFormat', { format: FORMAT_LABELS[options.format] })
  const settingsName = preset ? presetLabel(preset) : t('export.custom')
  // A saved preset names the settings (§2.2): "Settings · Client review", its name in the muted part.
  const userName: ReactNode = userPreset ? <span className="muted">{uiLanguage() === 'en' ? userPreset.name : <bdi>{userPreset.name}</bdi>}</span> : null
  const formats = [...formatChoices(), { value: 'wav' as const, label: t('codecs.format.wav.label'), title: t('codecs.format.wav.title') }]
  const formatTitle = (f: ExportFormat, title: string): string =>
    f === effective.format && DEFAULT_CODEC[f] && codecOf(effective) !== DEFAULT_CODEC[f] ? t('codecs.format.made', { codec: CODEC_NAMES[codecOf(effective)], audio: audioOf(effective) }) : title
  const presetMetaOf = (o: ExportOptions): string => optionsMeta(project, o)
  const bundleOf = withoutLanguages(bundle)
  const presetsFull = (store?.presets.length ?? 0) >= USER_PRESET_LIMIT
  const stemList = useMemo(() => stemJobOf(project, effective, null)?.stems ?? [], [project, effective])
  const notEvened = audioLook(project.audio).normalize && stemList.some((x) => x === 'voice' || x === 'system' || x === 'recording')
  const codecValues = codecHintValues(effective, uiCaps, { size: dims, seconds: length }, { webCodecs: webCodecs.av1, probe: av1Probe })
  const intermediateTitles = INTERMEDIATE_TITLES[codecOf(effective)]

  return (
    <div className="overlay modal-backdrop">
      <div ref={boxRef} className={`modal export-modal ${phase.kind === 'settings' ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={t('export.title')}>
        <header className="modal-head">
          <h2>{t('export.title')}</h2>
          {phase.kind === 'settings' && (
            <div className="segmented export-mode" role="tablist" aria-label={t('export.mode')}>
              <button role="tab" aria-selected={mode === 'single'} className={mode === 'single' ? 'active' : ''} onClick={() => setModeSaved('single')}>
                {t('export.mode.single')}
              </button>
              <button role="tab" aria-selected={mode === 'batch'} className={mode === 'batch' ? 'active' : ''} onClick={() => setModeSaved('batch')}>
                {t('export.mode.batch')}
              </button>
            </div>
          )}
          <span className="tb-spacer" />
          {!running && (
            <button className="btn ghost" onClick={props.onClose} title={t('common.action.close')}>
              <Icon name="x" />
            </button>
          )}
        </header>

        {phase.kind === 'settings' && (
          <>
            <div className="export-body">
              <aside className="export-side">
                <div className={`export-preview ${audioOnly ? 'audio-only' : ''}`}>
                  <ExportPreview {...source} options={effective} time={frameSource} soundTime={frameSound} held={frameHeld} box={{ width: 236, height: 236 }} />
                  {audioOnly && <span className="export-preview-badge">{t('export.audioOnly')}</span>}
                </div>
                <label className="export-frame">
                  <span className="slider-head">
                    <span>{t('export.frame')}</span>
                    <span className="muted">{fmt.clock(frameAt, 'rounded-tenths')}</span>
                  </span>
                  <input
                    type="range"
                    aria-label={t('export.frameLabel')}
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
                <button className="btn export-thumb" onClick={() => void saveThumbnail()} disabled={thumb.kind === 'busy'} title={t('export.thumb.title')}>
                  <Icon name="image" size={16} /> {thumb.kind === 'busy' ? t('common.state.saving') : t('export.thumb.save')}
                </button>
                {thumb.kind === 'saved' && (
                  <p className="hint export-thumb-status">
                    {richText('export.thumb.saved', { width: fmt.count(thumb.width), height: fmt.count(thumb.height) })}{' '}
                    <button className="link" onClick={() => void window.api.showItemInFolder(thumb.path)}>
                      {t('common.action.showInFolder')}
                    </button>
                  </p>
                )}
                {thumb.kind === 'failed' && <p className="hint warn">{thumb.message}</p>}
                <ChapterCopy chapters={chapters} length={length} gif={mode === 'single' && gif} perChapter={perChapter} />

                <div className="export-summary">
                  {mode === 'single' ? (
                    <>
                      <p className="hint export-size">
                        {audioOnly ? <>{richText('export.summary.audioOnly', { length: fmt.duration(length) })}</> : sizeLine(effective, dims, length)}
                        {gif ? ` · ${t('export.summary.gifFps', { fps: fmt.count(GIF_FPS) })}` : ''}
                        {target ? ` · ${t(gif ? 'export.summary.upTo' : 'export.summary.about', { mb: fmt.number(target) })}` : ''}
                      </p>
                      {perChapter && (
                        <ul className="export-batch-files" data-testid="export-part-files">
                          {partNames.map((name, i) => (
                            <li key={name} title={name}>
                              <span className="name">{name}</span>
                              <span className="muted">{fmt.clock(parts[i].end - parts[i].start, 'whole')}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="hint export-size">
                        {items.length === 0 ? t('export.batch.none') : t('export.batch.summary', { count: items.length, n: fmt.count(items.length), length: fmt.duration(length) })}
                      </p>
                      {items.length > 0 && (
                        <ul className="export-batch-files">
                          {batchFileNames(project.name, items).map((name, i) => {
                            const made = itemSettings(items[i])
                            const s = exportSize(project, made.options)
                            return (
                              <li key={items[i].key} title={name}>
                                <AspectGlyph ratio={ratioOf(s)} size={12} />
                                <span className="name">{name}</span>
                                <span className="muted">{isAudioOnly(made.options.format) ? t('export.batch.audio') : `${s.width}×${s.height}`}</span>
                                {made.notice && (
                                  <span className="hint warn batch-notice" data-testid="batch-codec-notice">
                                    {t(made.notice, codecNotice(items[i].options, made.options))}
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </>
                  )}
                  {mode === 'single' &&
                    warnings.map((w) => (
                      <p key={w.key} className={`hint ${w.cls ?? ''}`} data-testid={w.testid}>
                        {w.text}
                      </p>
                    ))}
                  {suggestion && (
                    <div className="export-follow-note" data-testid="export-follow-note">
                      <p className="hint">
                        {suggestion === 'vertical'
                          ? t('export.follow.vertical')
                          : t('export.follow.square')}
                      </p>
                      <button
                        className="btn small"
                        onClick={() => {
                          props.onClose()
                          group.command(suggestion === 'vertical' ? 'makeVertical' : 'makeSquare')
                        }}
                      >
                        {suggestion === 'vertical' ? t('export.follow.makeVertical') : t('export.follow.makeSquare')}
                      </button>
                    </div>
                  )}
                </div>
              </aside>

              <div className="export-main">
                {store && (
                  <UserPresets
                    store={store}
                    selected={userPreset?.id ?? null}
                    options={effective}
                    bundle={bundleOf}
                    onPick={pickUserPreset}
                    onStore={saveStore}
                    metaOf={presetMetaOf}
                    usable={usableNow}
                    batch={
                      mode === 'batch'
                        ? {
                            checked: batch.userPresets ?? [],
                            onToggle: (id) => {
                              const ticked = batch.userPresets ?? []
                              const next = ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]
                              const choice: BatchChoice = { presets: batch.presets, aspects: batch.aspects }
                              if (next.length) choice.userPresets = next
                              setBatchSaved(choice)
                            }
                          }
                        : undefined
                    }
                  />
                )}
                <div className="export-section-head">
                  <span>{mode === 'single' ? t('export.destination') : t('export.batch.files')}</span>
                  {mode === 'batch' && batch.presets.length + batch.aspects.length + (batch.userPresets?.length ?? 0) > 0 && (
                    <button className="link" onClick={() => setBatchSaved({ presets: [], aspects: [] })}>
                      {t('export.batch.clear')}
                    </button>
                  )}
                </div>
                <div className="preset-grid" role={mode === 'single' ? 'radiogroup' : 'group'} aria-label={t('export.destinations')}>
                  {shownPresets().map((p) => {
                    const on = mode === 'single' ? options.preset === p.id : batch.presets.includes(p.id)
                    const limit = presetLimit(p)
                    return (
                      <button
                        key={p.id}
                        className={`preset-card ${on ? 'active' : ''}`}
                        role={mode === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={on}
                        data-preset={p.id}
                        title={NEW_DESTINATIONS[p.id] ? t(NEW_DESTINATIONS[p.id].title) : undefined}
                        onClick={() => {
                          if (mode === 'single') pickPreset(p)
                          else setBatchSaved({ ...batch, presets: on ? batch.presets.filter((x) => x !== p.id) : [...batch.presets, p.id] })
                        }}
                      >
                        <PresetBadge icon={p.icon} />
                        <span className="preset-text">
                          <span className="preset-label">{presetLabel(p)}</span>
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
                {store && <ImportPresets store={store} onStore={saveStore} />}

                {mode === 'batch' && (
                  <div className="form-row export-batch-aspects">
                    <span>{t('export.batch.also')}</span>
                    <div className="export-batch-also">
                      <Choice<string>
                        value={null}
                        options={BATCH_ASPECTS.map((a) => ({
                          value: a,
                          label: a,
                          pressed: batch.aspects.includes(a),
                          disabled: audioOnly,
                          title: t('export.batch.aspectTitle', { aspect: a }),
                          icon: <AspectGlyph ratio={ratioOf(exportSize(project, { ...options, aspect: a }))} />
                        }))}
                        onChange={(a) =>
                          setBatchSaved({
                            ...batch,
                            aspects: batch.aspects.includes(a as AspectRatio) ? batch.aspects.filter((x) => x !== a) : [...batch.aspects, a as AspectRatio]
                          })
                        }
                      />
                      <p className="hint">{t('export.batch.alsoHint')}</p>
                    </div>
                  </div>
                )}

                <button className="export-section-head toggle-head" onClick={toggleSettings} aria-expanded={settingsOpen}>
                  {mode === 'single' && userName ? (
                    <span>{tNodes<ReactNode>('presets.header.named', { name: userName }, {})}</span>
                  ) : (
                    <span>
                      {t('common.label.settings')} <span className="muted">· {mode === 'single' ? settingsName : t('export.settings.batch')}</span>
                    </span>
                  )}
                  <span className={`chevron ${settingsOpen ? 'open' : ''}`} aria-hidden="true">
                    <Icon name="back" size={14} />
                  </span>
                </button>
                {settingsOpen && mode === 'single' && store && (
                  <div className="export-preset-save">
                    {naming ? (
                      <SavePresetField
                        suggestion={suggestName(effective)}
                        taken={store.presets.map((p) => p.name)}
                        onSave={saveAsPreset}
                        onCancel={() => {
                          setNaming(false)
                          requestAnimationFrame(() => focusAfterSave(saveButton.current, store.presets))
                        }}
                      />
                    ) : (
                      <button ref={saveButton} type="button" className="btn small" data-testid="save-preset" disabled={presetsFull} onClick={() => setNaming(true)}>
                        {t('presets.save.button')}
                      </button>
                    )}
                    {presetsFull && !naming && <p className="hint">{t('presets.save.full', { n: fmt.count(USER_PRESET_LIMIT) })}</p>}
                  </div>
                )}
                {settingsOpen && (
                  <div className="export-settings">
                    <div className="form-row">
                      <span>{t('export.settings.format')}</span>
                      <Choice
                        value={effective.format}
                        onChange={(format) => apply(pickFormat(options, format))}
                        options={formats.map((f) => {
                          const silent = isAudioOnly(f.value) && !hasSound
                          return { ...f, disabled: silent, title: silent ? t('export.settings.noSound') : formatTitle(f.value, f.title) }
                        })}
                      />
                    </div>
                    <CodecRow
                      rows={rows}
                      options={effective}
                      onChange={(next) => {
                        setReplaced(null)
                        apply(next)
                      }}
                      hintValues={codecValues}
                      noticeValues={codecNotice(options, effective)}
                    />
                    <BackgroundRow rows={rows} options={effective} onChange={(next) => apply(next)} replaced={replaced} onReplaced={setReplaced} />
                    {!audioOnly && (
                      <div className="form-row">
                        <span>{t('export.settings.resolution')}</span>
                        <Choice
                          value={resolution}
                          onChange={(r) => {
                            const next = pickResolution(effective, r)
                            apply(next, next.fps !== effective.fps ? t('codecs.fps.4kAt60') : null)
                          }}
                          options={resolutionOptions}
                        />
                      </div>
                    )}
                    {!audioOnly && (
                      <div className="form-row">
                        <span>{t('export.settings.aspect')}</span>
                        <Choice value={effective.aspect ?? 'project'} onChange={(a) => set({ aspect: a === 'project' ? undefined : (a as AspectRatio) })} options={aspectOptions} />
                      </div>
                    )}
                    {!gif && !audioOnly && (
                      <div className="form-row">
                        <span id={FPS_LABEL_ID}>{t('export.settings.frameRate')}</span>
                        <FrameRateRow rows={rows} options={effective} onChange={(next) => apply(next)} note={fpsNote} />
                      </div>
                    )}
                    {!rows.quality.hidden && (
                      <div className="form-row">
                        <span>{t('export.settings.quality')}</span>
                        <div className="export-stack">
                          <Choice
                            value={target ? null : effective.quality}
                            disabled={!!target}
                            onChange={(quality) => set({ quality })}
                            options={
                              rows.quality.labels === 'intermediate'
                                ? [
                                    { value: 'high', label: t('codecs.quality.best'), title: intermediateTitles ? t(intermediateTitles.high) : undefined },
                                    { value: 'medium', label: t('codecs.quality.high'), title: intermediateTitles ? t(intermediateTitles.medium) : undefined },
                                    { value: 'small', label: t('codecs.quality.medium'), title: intermediateTitles ? t(intermediateTitles.small) : undefined }
                                  ]
                                : [
                                    { value: 'high', label: t('export.quality.studio') },
                                    { value: 'medium', label: t('export.quality.web') },
                                    { value: 'small', label: t('export.quality.small') }
                                  ]
                            }
                          />
                          {target ? <p className="hint">{t('export.quality.byTarget')}</p> : null}
                        </div>
                      </div>
                    )}
                    <div className="form-row">
                      <span>{t('export.target.label')}</span>
                      <div className="export-target">
                        {/* Outside English the field shows the UI's digits and reads any (NumberField, output-and-languages §11.1); English keeps today's field and its draft text. */}
                        {uiLanguage() === 'en' ? (
                          <input
                            type="number"
                            inputMode="decimal"
                            aria-label={t('export.target.field')}
                            placeholder={t('common.state.off')}
                            min={TARGET_MB_RANGE.min}
                            max={TARGET_MB_RANGE.max}
                            step={1}
                            value={targetDraft}
                            disabled={!!rows.targetSize.disabled}
                            onChange={(e) => commitTarget(e.target.value)}
                          />
                        ) : (
                          <NumberField
                            aria-label={t('export.target.field')}
                            placeholder={t('common.state.off')}
                            min={TARGET_MB_RANGE.min}
                            max={TARGET_MB_RANGE.max}
                            step={1}
                            value={targetDraft.trim() ? Number(targetDraft.replace(',', '.')) : NaN}
                            disabled={!!rows.targetSize.disabled}
                            onValue={(n) => commitTarget(Number.isFinite(n) ? String(n) : '')}
                          />
                        )}
                        <span className="muted">{t('export.target.unit')}</span>
                        {rows.targetSize.disabled ? (
                          <span className="hint" data-testid="export-target-off">
                            {t(rows.targetSize.disabled)}
                          </span>
                        ) : target ? (
                          <button className="btn ghost small" onClick={() => commitTarget('')}>
                            {t('common.state.off')}
                          </button>
                        ) : (
                          <span className="hint">{gif ? t('export.target.gif') : t('export.target.hint')}</span>
                        )}
                      </div>
                    </div>
                    {!rows.encoder.hidden && (
                      <div className="form-row">
                        <span>{t('export.settings.encoder')}</span>
                        <div className="export-stack">
                          <Choice
                            value={effective.encoder}
                            onChange={(encoder) => set({ encoder })}
                            options={[
                              { value: 'auto', label: t('export.encoder.auto') },
                              { value: 'software', label: t('export.encoder.softwareChoice'), disabled: !!rows.encoder.softwareDisabled }
                            ]}
                          />
                          {rows.encoder.softwareDisabled && <p className="hint">{t(rows.encoder.softwareDisabled)}</p>}
                          {!rows.codec?.hint && <p className="hint">{effective.encoder === 'auto' ? gpuHint : softwareHint}</p>}
                        </div>
                      </div>
                    )}
                    <SubtitlesField
                      project={project}
                      value={bundle}
                      onChange={(next) => {
                        setBundle(next)
                        writeJson(BUNDLE_KEY, withoutLanguages(next))
                      }}
                      format={options.format}
                      streams={streams}
                      onStreams={setStreams}
                    />
                    <ExportBundleOptions
                      value={bundle}
                      onChange={(next) => {
                        setBundle(next)
                        writeJson(BUNDLE_KEY, withoutLanguages(next))
                      }}
                      format={options.format}
                      has={bundleHas}
                      mode={mode}
                      chapterCount={parts.length}
                      pendingChapters={pendingChapters(project).length}
                      savedDescription={!!project.publish?.description}
                      alsoSave={{ options: effective, hasSound, stems: stemList, seconds: length, notEvened }}
                    />
                    <ShareAfterExport share={share} single={mode === 'single' && !perChapter} />
                  </div>
                )}
              </div>
            </div>
            {lutAsk && <LutQuestion question={lutAsk.question} many={lutAsk.many} back={primary} onExport={lutAsk.go} onCancel={() => setLutAsk(null)} />}
            <footer className="modal-foot">
              <button className="btn" onClick={props.onClose}>
                {t('common.action.cancel')}
              </button>
              {mode === 'single' ? (
                <button ref={primary} className="btn primary" onClick={onExport} disabled={!canExport} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
                  {perChapter ? <Icon name="folder" size={16} /> : <Icon name="download" size={16} />}{' '}
                  {checking ? t('codecs.export.checking') : perChapter ? t('export.chapters.exportParts', { count: parts.length, n: fmt.count(parts.length) }) : exportLabel}
                </button>
              ) : (
                <button ref={primary} className="btn primary" onClick={onExport} disabled={!canExport} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
                  <Icon name="folder" size={16} />{' '}
                  {checking ? (
                    t('codecs.export.checking')
                  ) : (
                    uiLanguage() === 'en' ? (
                      // English keeps today's text nodes, which the browser lays out by node (merge group, output-and-languages §9.3).
                      <>
                        {t('export.batch.exportFiles.lead')}
                        {items.length}
                        {t('export.batch.exportFiles.noun')}
                        {items.length === 1 ? '' : t('export.batch.exportFiles.s')}
                        {t('export.batch.exportFiles.end')}
                      </>
                    ) : (
                      t('export.batch.exportFiles.whole', { count: items.length, n: fmt.count(items.length) })
                    )
                  )}
                </button>
              )}
              <span className="sr-only" role="status">
                {checking ? t('codecs.export.checking') : ''}
              </span>
            </footer>
          </>
        )}

        {phase.kind === 'running' && (
          <RunningView progress={phase.progress} gif={gif} onCancel={() => abort.current?.abort()} paused={job.paused} slept={job.slept} onPause={job.toggle} steps={runSteps} step={phase.step} />
        )}

        {phase.kind === 'batch' && (
          <BatchView
            phase={phase}
            onCancel={() => abort.current?.abort()}
            onDone={props.onClose}
            onBack={() => setPhase({ kind: 'settings' })}
            primary={primary}
            copy={copy}
            onCopy={(f) => void copyFile(f)}
            paused={job.paused}
            slept={job.slept}
            onPause={job.toggle}
          />
        )}

        {phase.kind === 'done' && (
          <>
            <p className="success">
              <Icon name="check" /> {t('export.done.title')}
            </p>
            <p className="hint path">{phase.path}</p>
            <p className="hint">
              {richText('export.done.summary', { size: fmt.bytes(phase.bytes), time: fmt.duration(phase.seconds), encoder: phase.encoder })}
            </p>
            <SizeReport result={phase} />
            {phase.also ? <AlsoReport extras={phase.extras} also={phase.also} video={phase.path} /> : <ExtrasReport extras={phase.extras} />}
            <ShareDone file={phase.path} meta={{ title: project.name, seconds: length }} targets={share.targets} startError={share.error} />
            {!gif && <ChapterCopy chapters={chapters} length={length} gif={false} />}
            {props.onShortClips && (
              <p className="hint">
                <button type="button" className="link" data-testid="export-short-clips" onClick={props.onShortClips}>
                  {t('export.done.shortClips')}
                </button>
              </p>
            )}
            {copy.kind === 'failed' && <p className="hint warn">{copy.message}</p>}
            <footer className="modal-foot">
              <button className="btn" onClick={() => void copyFile(phase.path)} disabled={copy.kind === 'busy'} title={t('export.done.copyTitle')}>
                {copy.kind === 'copied' ? <Icon name="check" size={16} /> : <CopyIcon />} {copy.kind === 'copied' ? t('common.state.copied') : t('common.action.copy')}
              </button>
              <button className="btn" onClick={() => void window.api.showItemInFolder(phase.path)}>
                <Icon name="folder" size={16} /> {t('common.action.showInFolder')}
              </button>
              <button ref={primary} className="btn primary" onClick={props.onClose}>
                {t('common.action.done')}
              </button>
            </footer>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="error export-error">{richText('export.error.title', { message: phase.message })}</p>
            {phase.detail && (
              <>
                <button className="btn ghost small export-detail-toggle" onClick={() => setShowDetail((v) => !v)}>
                  {showDetail ? t('export.error.hideDetails') : t('export.error.showDetails')}
                </button>
                {showDetail && <pre className="error-detail">{phase.detail}</pre>}
              </>
            )}
            <footer className="modal-foot">
              <button ref={primary} className="btn" onClick={() => setPhase({ kind: 'settings' })}>
                {t('common.action.back')}
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
  const mb = fmt.number(targetMB ?? 0)
  if (result.reduced) lines.push({ text: t('export.size.reduced', { mb, how: result.reduced }) })
  if (result.overLimit) lines.push({ text: t('export.size.overLimit', { mb }), warn: true })
  else if (targetMB && !result.reduced) {
    const err = sizeError(result.bytes, targetMB)
    const over = fmt.count(Math.round(err * 100))
    if (err > 0.1) lines.push({ text: t('export.size.overTarget', { percent: over, mb }), warn: true })
    else lines.push({ text: t(err <= 0 ? (err < -0.1 ? 'export.size.withinFewer' : 'export.size.within') : 'export.size.over', { mb, percent: over }) })
  }
  const limit = result.limit
  if (limit && result.bytes > limit.maxMB * MB) {
    lines.push({ text: t('export.size.overPlatform', { max: fmt.number(limit.maxMB), name: limit.label, mb: fmt.count(Math.floor(limit.maxMB * 0.95)) }), warn: true })
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
      return t('export.batch.waiting')
    case 'running': {
      const p = s.progress
      if (!p || p.phase === 'preparing') return t('export.progress.preparing')
      if (p.phase === 'finalizing') return p.detail ?? t('export.progress.finalizing')
      return t('export.progress.rendering', { percent: fmt.count(Math.floor((p.frame / Math.max(1, p.frames)) * 100)) })
    }
    case 'done':
      return `${fmt.bytes(s.bytes)} · ${fmt.duration(s.seconds)}`
    case 'failed':
      return s.message
    case 'cancelled':
      return t('export.batch.cancelled')
  }
}

function BatchView({
  phase,
  onCancel,
  onDone,
  onBack,
  primary,
  copy,
  onCopy,
  paused,
  slept,
  onPause
}: {
  phase: Extract<Phase, { kind: 'batch' }>
  onCancel: () => void
  onDone: () => void
  onBack: () => void
  primary: RefObject<HTMLButtonElement>
  copy: CopyState
  onCopy: (file: string) => void
  paused: boolean
  slept: boolean
  onPause: () => void
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
          {failed
            ? t('export.batch.finishedSome', { done: fmt.count(done), total: fmt.count(phase.jobs.length) })
            : t('export.batch.finished', { count: done, n: fmt.count(done) })}
        </p>
      ) : (
        <>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${overall * 100}%` }} />
          </div>
          <p className="hint export-status">
            {current >= 0
              ? t('export.batch.exporting', { index: fmt.count(current + 1), total: fmt.count(phase.jobs.length), name: phase.jobs[current].label, status: paused ? pausedText(slept) : statusText(phase.statuses[current]) })
              : t('export.progress.preparing')}
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
                {s.state === 'done' && s.extras && <ExtrasLine extras={s.extras} />}
                {s.state === 'done' && (s.reduced || s.overLimit) && (
                  <span className={`batch-status ${s.overLimit ? 'warn' : ''}`}>{s.overLimit ? t('export.batch.stillOver', { mb: fmt.number(job.options.targetSizeMB ?? 0) }) : t('export.batch.fitted', { how: s.reduced ?? '' })}</span>
                )}
              </span>
              {s.state === 'done' && (
                <button className="btn ghost small" title={t('export.batch.copyFile')} onClick={() => onCopy(s.path)}>
                  <CopyIcon />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {copy.kind === 'failed' && <p className="hint warn">{copy.message}</p>}
      {copy.kind === 'copied' && <p className="hint">{t('export.batch.copied')}</p>}
      <footer className="modal-foot">
        {phase.finished ? (
          <>
            <button className="btn" onClick={onBack}>
              {t('common.action.back')}
            </button>
            {firstDone && (
              <button className="btn" onClick={() => void window.api.showItemInFolder(firstDone.path)}>
                <Icon name="folder" size={16} /> {t('common.action.showInFolder')}
              </button>
            )}
            <button ref={primary} className="btn primary" onClick={onDone}>
              {t('common.action.done')}
            </button>
          </>
        ) : (
          <>
            <PauseButton paused={paused} onPause={onPause} disabled={!(run && run.state === 'running' && run.progress?.phase === 'rendering') && !paused} />
            <button className="btn" onClick={onCancel}>
              {t('export.cancel')}
            </button>
          </>
        )}
      </footer>
    </>
  )
}

/** The running export's state while it waits at the pause gate (F-12). */
function pausedText(slept: boolean): string {
  return slept ? t('export.pause.slept') : t('export.pause.paused')
}

function PauseButton({ paused, onPause, disabled }: { paused: boolean; onPause: () => void; disabled: boolean }): JSX.Element {
  // aria-disabled, not disabled: the button flips between files and phases, and a disabled button
  // would drop the keyboard focus to the page.
  return (
    <button
      className="btn export-pause"
      onClick={() => !disabled && onPause()}
      aria-disabled={disabled}
      title={disabled ? t('export.pause.disabledTitle') : paused ? t('export.pause.resumeTitle') : t('export.pause.pauseTitle')}
    >
      {paused ? t('export.pause.resume') : t('export.pause.pause')}
    </button>
  )
}

/** "Also saved: Demo.srt, Demo - thumbnail.png" and the files that could not be saved (F-11). */
function ExtrasLine({ extras }: { extras: BatchExtras }): JSX.Element | null {
  const names = extras.saved.map((f) => f.split(/[\\/]/).pop())
  return (
    <>
      {names.length > 0 && <span className="batch-status">{richText('export.also.saved', { names: names.join(', ') })}</span>}
      {extras.failed.map((f) => (
        <span key={f} className="batch-status warn">
          {richText('export.also.failed', { reason: f })}
        </span>
      ))}
    </>
  )
}

function ExtrasReport({ extras }: { extras?: BatchExtras }): JSX.Element | null {
  if (!extras) return null
  const names = extras.saved.map((f) => f.split(/[\\/]/).pop())
  return (
    <div className="export-extras" data-testid="export-extras">
      {names.length > 0 && <p className="hint">{richText('export.also.saved', { names: names.join(', ') })}</p>}
      {extras.failed.map((f) => (
        <p key={f} className="hint warn">
          {richText('export.also.failed', { reason: f })}
        </p>
      ))}
    </div>
  )
}

function RunningView({
  progress,
  gif,
  onCancel,
  paused,
  slept,
  onPause,
  steps,
  step
}: {
  progress: ExportProgress | null
  gif: boolean
  onCancel: () => void
  paused: boolean
  slept: boolean
  onPause: () => void
  /** The steps after the video (output-and-languages §2.4): stems inside the finish, then the timeline. */
  steps?: RunSteps
  step?: 'timeline'
}): JSX.Element {
  const finalizing = progress?.phase === 'finalizing'
  const fraction = progress && progress.frames > 0 ? progress.frame / progress.frames : 0
  let status = t('export.progress.preparing')
  if (progress?.phase === 'rendering') {
    const parts = [t('export.progress.rendering', { percent: fmt.count(Math.floor(fraction * 100)) })]
    if (progress.fps > 0) parts.push(t('export.progress.fps', { fps: fmt.number(progress.fps, { max: progress.fps < 10 ? 1 : 0, min: progress.fps < 10 ? 1 : 0 }) }))
    if (progress.eta !== null) parts.push(t('export.progress.left', { time: fmt.duration(progress.eta) }))
    status = parts.join(' · ')
  } else if (finalizing) {
    // A step's own words inside the sentence (§9.6): English lower-cases them as before; other languages leave them.
    status = progress?.detail
      ? t('export.progress.finalizingStep', { step: fmt.inSentence(progress.detail.replace(/…$/, '')) })
      : gif
        ? t('export.progress.finalizingGif')
        : t('export.progress.finalizing')
  }
  if (paused) status = pausedText(slept)
  return (
    <>
      <div className={`progress ${finalizing ? 'indeterminate' : ''}`}>
        <div className="progress-bar" style={{ width: finalizing ? undefined : `${fraction * 100}%` }} />
      </div>
      <p className="hint export-status">{status}</p>
      <RunStep steps={steps} step={step} finalizing={finalizing} />
      {progress && (
        <p className="hint">
          {richText('export.progress.encoder', { encoder: progress.encoder })}
          {progress.notice ? ` · ${progress.notice}` : ''}
        </p>
      )}
      <footer className="modal-foot">
        <PauseButton paused={paused} onPause={onPause} disabled={progress?.phase !== 'rendering' && !paused} />
        <button className="btn" onClick={onCancel}>
          {t('export.cancel')}
        </button>
      </footer>
    </>
  )
}

/**
 * The step after the video, announced (§2.4): "Writing sound stems…" while the export finishes with
 * stems, then "Writing the timeline…" (and "Copying the recordings…" for the recordings). Nothing for
 * an export without them.
 */
export function RunStep({ steps, step, finalizing }: { steps?: RunSteps; step?: 'timeline'; finalizing: boolean }): JSX.Element | null {
  const lines: MessageKey[] =
    step === 'timeline' && steps?.timeline
      ? ['timelines.running.timeline', ...(steps.timeline === 'recordings' ? (['timelines.running.copying'] as const) : [])]
      : finalizing && steps?.stems
        ? ['stems.running']
        : []
  if (!steps?.stems && !steps?.timeline) return null
  return (
    <div role="status" data-testid="export-step">
      {lines.map((k) => (
        <p key={k} className="hint export-step">
          {t(k)}
        </p>
      ))}
    </div>
  )
}

/**
 * The done view's files when Also save asked for stems or a timeline (§2.4, §17): a list of every file
 * saved next to the video, each a link that shows it in its folder, the stems and sidecars first, then
 * each timeline file with how to open it; and a line for a step that failed after the video was saved.
 */
/**
 * The done view's line for stems that failed: main's own whole sentences about stems (no sound to
 * write, or a failure with no reason of its own) and the cancel's as they are, in the UI language; any other reason
 * ("The disk is full.") inside "The sound stems could not be saved: {reason}".
 */
export function stemsProblemLine(reason: string): string {
  return reason === t('errors.stems.failed') || reason === t('errors.stems.noSound') || reason === t('stems.done.cancelled') ? reason : t('stems.done.failed', { reason })
}

export function AlsoReport({ extras, also, video }: { extras?: BatchExtras; also: AlsoDone; video: string }): JSX.Element {
  const base = (f: string): string => f.split(/[\\/]/).pop() ?? f
  const stem = base(video).replace(/\.[^.]+$/, '')
  const saved = extras?.saved ?? []
  const sidecars = saved.filter((f) => !timelineFileOf(f))
  const timelines = saved.filter((f) => timelineFileOf(f))
  // A sidecar that failed is named by its file ("Demo.srt: …", "Demo.bn.vtt: …", "Demo - chapters.txt: …");
  // anything else is the timeline step's problem, already a whole sentence in the UI language.
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sidecarFailure = new RegExp(`^${escaped}(\\.[a-z]{2,3}(-[A-Za-z0-9]{1,8})?)?(\\.srt|\\.vtt| - chapters\\.txt| - thumbnail\\.png| - description\\.txt): `)
  const failedSidecars = (extras?.failed ?? []).filter((f) => sidecarFailure.test(f))
  const timelineProblems = (extras?.failed ?? []).filter((f) => !sidecarFailure.test(f))
  const files = [...also.stems.map((s) => s.path), ...sidecars, ...timelines]
  const linesOf = (file: string): string[] => {
    switch (timelineFileOf(file)) {
      case 'fcpxml':
        return [...(also.editors.includes('resolve') ? [t('timelines.done.resolve')] : []), ...(also.editors.includes('finalcut') ? [t('timelines.done.finalcut')] : [])]
      case 'xmeml':
        return [t('timelines.done.premiere')]
      case 'markers':
        return [t('timelines.done.markers')]
      case 'edl':
        return [t('timelines.done.edl', { video: base(video) })]
      case 'media':
        return [t('timelines.done.media')]
      default:
        return []
    }
  }
  return (
    <div className="export-extras" data-testid="export-extras">
      {files.length > 0 && (
        <>
          <p className="hint" id="export-also-saved">
            {t('export.also.savedList')}
          </p>
          <ul className="export-saved-files" aria-labelledby="export-also-saved" data-testid="export-saved-files">
            {files.map((f) => (
              <li key={f}>
                <button type="button" className="link name" title={t('common.action.showInFolder')} onClick={() => void window.api.showItemInFolder(f)}>
                  {base(f)}
                </button>
                {linesOf(f).map((line) => (
                  <span key={line} className="hint">
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {failedSidecars.map((f) => (
        <p key={f} className="hint warn">
          {richText('export.also.failed', { reason: f })}
        </p>
      ))}
      {also.stemsProblem && (
        <p className="hint warn" data-testid="export-stems-problem">
          {stemsProblemLine(also.stemsProblem)}
        </p>
      )}
      {timelineProblems.map((f) => (
        <p key={f} className="hint warn" data-testid="export-timeline-problem">
          {f}
        </p>
      ))}
    </div>
  )
}

/**
 * The question asked before an export when a grade's LUT is missing or has changed (editing polish
 * §9.5): "The camera's LUT is missing or has changed. Export without it?" Export without it, or Cancel.
 * Either answer takes the question away with the focused button: the keyboard goes back to `back`
 * (the dialog's Export) first, not to the page.
 */
export function LutQuestion(props: { question: string; many: boolean; back: RefObject<HTMLElement>; onExport: () => void; onCancel: () => void }): JSX.Element {
  const go = useRef<HTMLButtonElement>(null)
  useEffect(() => go.current?.focus(), [])
  const answer = (then: () => void) => (): void => {
    props.back.current?.focus()
    then()
  }
  return (
    <div className="export-lut-ask" role="alertdialog" aria-label={t('export.lut.label')} aria-describedby="export-lut-question" data-testid="export-lut-ask">
      <p id="export-lut-question">{props.question}</p>
      <div className="export-lut-ask-buttons">
        <button ref={go} type="button" className="btn primary" data-testid="export-lut-go" onClick={answer(props.onExport)}>
          {props.many ? t('export.lut.withoutThem') : t('export.lut.withoutIt')}
        </button>
        <button type="button" className="btn" data-testid="export-lut-cancel" onClick={answer(props.onCancel)}>
          {t('common.action.cancel')}
        </button>
      </div>
    </div>
  )
}
