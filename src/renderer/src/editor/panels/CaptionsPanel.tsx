import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AiProviderInfo, AiTextRequest, AiTextResult, TranscribeOptions } from '../../../../shared/api/ai'
import { cleanCaptionText, CAPTION_MAX_CHARS } from '../../../../shared/captions/captionData'
import { applyTextResult, findInCaptions, mergeWithNext, readSuggestedChapters, replaceInCaptions, splitCaption } from '../../../../shared/captions/edit'
import { captionIndexAt } from '../../../../shared/captions/layout'
import { CAPTION_COLORS, CAPTION_PRESETS, CAPTION_SIZE, captionsOf, HIGHLIGHT_COLORS, withPreset } from '../../../../shared/captions/settings'
import { subtitleFile, SUBTITLE_FORMATS, type SubtitleFormat } from '../../../../shared/captions/subtitles'
import { displayTime } from '../../../../shared/editor/clips'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { chapterNear, createChapter } from '../../../../shared/editor/titles'
import { formatTime } from '../../../../shared/engine/project'
import { viewingTime } from '../../../../shared/render/overlays'
import type { CaptionPreset, CaptionSegment, CaptionSettings, Project, Transcript } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { SearchIcon } from '../CommandPalette'
import {
  cancelTranscription,
  clearTranscriptionError,
  ipcMessage,
  onCaptionsRequest,
  onTranscriptionJob,
  showCaption,
  takeCaptionsRequest,
  transcribe,
  transcriptionJob,
  type CaptionsRequest
} from '../captionItems'
import { useEditor } from '../context'
import { Chips, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import '../captions.css'

/* ---------- Captions and transcript ---------- */

/** Spoken languages offered for transcription and translation (BCP-47), after "Detect automatically". */
export const CAPTION_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'bn', name: 'Bengali' },
  { code: 'hi', name: 'Hindi' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'mr', name: 'Marathi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' }
]

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** Opens the app settings at the AI providers (the settings dialog listens for it). */
const openAiSettings = (): void => void window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'ai' } }))

/** Choices remembered for this session (the tab is unmounted while another one is open). */
const remembered: { provider: string; language: string; source: TranscribeOptions['source']; textProvider: string; translateTo: string; format: SubtitleFormat } = {
  provider: '',
  language: '',
  source: 'auto',
  textProvider: '',
  translateTo: 'en',
  format: 'srt'
}

/** Sent by the settings when providers are added, changed or removed. */
const AI_PROVIDERS_CHANGED = 'ssw:ai-providers-changed'

/** Whether a node removed from the page was the settings dialog (it is rendered straight into the body). */
const isSettingsDialog = (n: Node): boolean => n instanceof Element && n.classList.contains('settings-backdrop')

/**
 * The configured AI providers: read when the tab opens, when the window gets the focus back
 * (the settings may have changed), when the settings say they changed (AI_PROVIDERS_CHANGED) and
 * when the settings dialog closes. Null while the first read is under way.
 */
function useAiProviders(): { providers: AiProviderInfo[] | null; error: string | null; reload: () => void } {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    window.api
      .listAiProviders()
      .then((list) => {
        if (n !== seq.current) return
        setProviders(Array.isArray(list) ? list : [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (n !== seq.current) return
        setProviders([])
        setError(ipcMessage(err))
      })
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    window.addEventListener(AI_PROVIDERS_CHANGED, reload)
    // The dialog closing: only the body's own children are watched, so this costs nothing while editing.
    const closed = new MutationObserver((changes) => {
      if (changes.some((c) => Array.from(c.removedNodes).some(isSettingsDialog))) reload()
    })
    closed.observe(document.body, { childList: true })
    return () => {
      seq.current++
      window.removeEventListener('focus', reload)
      window.removeEventListener(AI_PROVIDERS_CHANGED, reload)
      closed.disconnect()
    }
  }, [reload])
  return { providers, error, reload }
}

const providerLabel = (p: AiProviderInfo, transcription = false): string => `${p.label || KIND_NAMES[p.kind]} · ${(transcription ? p.transcriptionModel : p.model) || KIND_NAMES[p.kind]}`

export function CaptionsPanel(props: InspectorProps): JSX.Element {
  const { project } = props
  const services = useEditor()
  const { providers, error: listError, reload } = useAiProviders()
  const transcript = project.transcript
  const [focusId, setFocusId] = useState<string | null>(null)
  const [exportNow, setExportNow] = useState(0)
  const [generateNow, setGenerateNow] = useState(0)

  // What the commands and the caption track ask for (also a request made just before the tab opened).
  useEffect(() => {
    const take = (): void => {
      const r: CaptionsRequest | null = takeCaptionsRequest()
      if (!r) return
      if (r.kind === 'focus') setFocusId(r.id)
      else if (r.kind === 'export') setExportNow((n) => n + 1)
      else setGenerateNow((n) => n + 1)
    }
    take()
    return onCaptionsRequest(take)
  }, [])

  const selectedId = props.selection?.kind === 'caption' ? props.selection.id : null

  return (
    <div className="captions-panel">
      {!transcript && <CaptionsIntro />}
      <GenerateSection project={project} providers={providers} listError={listError} reload={reload} request={generateNow} />
      {transcript && (
        <>
          <LookSection project={project} />
          <TranscriptSection
            project={project}
            transcript={transcript}
            selectedId={selectedId}
            focusId={focusId}
            onFocused={() => setFocusId(null)}
            onSelect={props.onSelect}
            onNotice={props.onNotice}
          />
          <AiToolsSection providers={providers} onNotice={props.onNotice} services={services} />
          <ExportSection project={project} transcript={transcript} request={exportNow} onNotice={props.onNotice} />
        </>
      )}
    </div>
  )
}

function CaptionsIntro(): JSX.Element {
  return (
    <Section title="Captions">
      <div className="captions-intro">
        <EditorIcon name="captions" size={28} />
        <p>
          Captions put what you say on the video, so it is understood with the sound off. An AI provider of your choice writes them from the recording&apos;s
          sound; you can then fix the text, restyle them, translate them and export them as subtitles.
        </p>
      </div>
    </Section>
  )
}

/* ---------- generating ---------- */

function GenerateSection({
  project,
  providers,
  listError,
  reload,
  request
}: {
  project: Project
  providers: AiProviderInfo[] | null
  listError: string | null
  reload: () => void
  request: number
}): JSX.Element {
  const services = useEditor()
  const job = useSyncExternalStore(onTranscriptionJob, transcriptionJob)
  const capable = useMemo(() => (providers ?? []).filter((p) => !!p.transcriptionModel), [providers])
  const [provider, setProvider] = useState(remembered.provider)
  const [language, setLanguage] = useState(remembered.language)
  const [source, setSource] = useState<TranscribeOptions['source']>(remembered.source)
  const [open, setOpen] = useState(false)
  const chosen = capable.find((p) => p.id === provider) ?? capable[0] ?? null
  const stems = project.audioStems
  const hasTranscript = !!project.transcript
  const mine = job && job.projectId === project.id ? job : null
  const generateRef = useRef<HTMLButtonElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    remembered.provider = provider
    remembered.language = language
    remembered.source = source
  }, [provider, language, source])

  const start = (): void => {
    if (!chosen || mine?.running) return
    if (hasTranscript && !window.confirm('Replace the captions with new ones? Your changes to the current captions are replaced too (Undo brings them back).')) return
    clearTranscriptionError()
    const options: TranscribeOptions = { providerId: chosen.id, source: stems ? source : 'auto' }
    if (language) options.language = language
    // Once it worked the form closes: the summary shows the new captions and the job's notice.
    void transcribe(services, options).then((ok) => {
      if (ok) setOpen(false)
    })
  }
  const startRef = useRef(start)
  startRef.current = start

  // The "Generate captions" command: starts right away when it can, else shows what is missing.
  const handled = useRef(0)
  useEffect(() => {
    if (!request || request === handled.current || providers === null) return
    handled.current = request
    setOpen(true)
    if (capable.length && project.hasAudio && !hasTranscript) startRef.current()
    else (capable.length ? generateRef : addRef).current?.focus()
  }, [request, providers, capable.length, project.hasAudio, hasTranscript])

  if (hasTranscript && !open && !mine?.running && !mine?.error) {
    return (
      <Section title="Generate">
        <p className="hint">
          {project.transcript!.segments.length} captions by {KIND_NAMES[project.transcript!.provider]}
          {project.transcript!.language ? ` (${CAPTION_LANGUAGES.find((l) => l.code === project.transcript!.language)?.name ?? project.transcript!.language})` : ''}.
        </p>
        {mine?.notice && (
          <div className="captions-suggestion" role="status">
            <p className="hint warn">{mine.notice}</p>
            <button className="link" onClick={clearTranscriptionError}>
              Dismiss
            </button>
          </div>
        )}
        <button className="btn" onClick={() => setOpen(true)}>
          <Icon name="refresh" size={15} /> Regenerate captions…
        </button>
      </Section>
    )
  }

  if (mine?.running) {
    const p = mine.progress
    const phase = mine.stopping ? 'Stopping…' : !p ? 'Starting…' : p.phase === 'extracting' ? 'Preparing the sound…' : p.phase === 'uploading' ? 'Sending the sound…' : p.phase === 'transcribing' ? 'Transcribing…' : 'Finishing…'
    // Moving until a part is done: a recording sent in one part reports 0 of 1 until it is finished.
    const share = p && p.total > 0 && p.done > 0 ? Math.min(1, p.done / p.total) : null
    return (
      <Section title="Generating captions">
        <div className="captions-progress" role="status" aria-live="polite">
          <span className="captions-phase">
            {phase}
            {p && p.total > 1 ? ` Part ${Math.min(p.done + 1, p.total)} of ${p.total}.` : ''}
          </span>
          <div className={`captions-bar ${share === null ? 'busy' : ''}`}>
            <span style={share === null ? undefined : { width: `${Math.round(share * 100)}%` }} />
          </div>
        </div>
        <button className="btn" onClick={cancelTranscription} disabled={!!mine.stopping}>
          Cancel
        </button>
      </Section>
    )
  }

  const none = providers !== null && capable.length === 0
  return (
    <Section title={hasTranscript ? 'Regenerate captions' : 'Generate captions'}>
      {providers === null && <p className="hint">Looking for your AI providers…</p>}
      {none && (
        <div className="captions-empty">
          <p>
            {providers!.length === 0
              ? 'Add an AI provider with your own API key to make captions. Transcription works with OpenAI and Gemini.'
              : 'None of your AI providers can transcribe: Claude cannot listen to audio. Add an OpenAI or Gemini key to make captions (Claude can still fix and translate them).'}
          </p>
          <button ref={addRef} className="btn primary" onClick={openAiSettings}>
            <EditorIcon name="gear" size={15} /> Add an AI provider
          </button>
          {listError && <p className="hint warn">Your providers could not be read: {listError}</p>}
          <button className="link" onClick={reload}>
            Check again
          </button>
        </div>
      )}
      {capable.length > 0 && (
        <>
          <label className="field">
            <span>Provider</span>
            <select className="captions-select" aria-label="Transcription provider" value={chosen?.id ?? ''} onChange={(e) => setProvider(e.target.value)}>
              {capable.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerLabel(p, true)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Spoken language</span>
            <select className="captions-select" aria-label="Spoken language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">Detect automatically</option>
              {CAPTION_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {stems && (
            <div className="field">
              <span>Sound</span>
              <Chips<NonNullable<TranscribeOptions['source']>>
                label="Sound to transcribe"
                value={source ?? 'auto'}
                onChange={setSource}
                options={[
                  { value: 'auto', label: 'Auto', title: 'The microphone when it was recorded on its own, else all the sound' },
                  { value: 'mic', label: 'Microphone', disabled: !stems.mic, title: stems.mic ? 'Only your voice' : 'The microphone was not recorded on its own' },
                  { value: 'mixed', label: 'Mixed sound', title: 'The microphone and the computer sound together' }
                ]}
              />
            </div>
          )}
          {!project.hasAudio && <p className="hint warn">This recording has no sound to transcribe.</p>}
          <div className="row start captions-actions">
            <button ref={generateRef} className="btn primary" disabled={!project.hasAudio} onClick={start}>
              <EditorIcon name="captions" size={15} /> {hasTranscript ? 'Regenerate' : 'Generate captions'}
            </button>
            {hasTranscript && (
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Close
              </button>
            )}
          </div>
          <p className="hint">The recording&apos;s sound is sent to {chosen ? KIND_NAMES[chosen.kind] : 'the provider'} with your key; it is billed to your account.</p>
        </>
      )}
      {mine?.error && (
        <div className="captions-error" role="alert">
          <p>Captions could not be made: {mine.error}</p>
          <button className="link" onClick={clearTranscriptionError}>
            Dismiss
          </button>
        </div>
      )}
    </Section>
  )
}

/* ---------- look ---------- */

function LookSection({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  const s = captionsOf(project)
  const set = (patch: Partial<CaptionSettings>, key?: string): void => store.update((p) => ({ ...p, captions: { ...captionsOf(p), ...patch } }), key)
  return (
    <Section title="Look">
      <Toggle label="Show captions" checked={s.show} onChange={(show) => set({ show })} title="Draw the captions on the video (preview and export)" />
      <div className="field">
        <span>Style</span>
        <div className="caption-presets" role="group" aria-label="Caption style">
          {CAPTION_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`caption-preset ${p.value} ${s.preset === p.value ? 'active' : ''}`}
              aria-pressed={s.preset === p.value}
              title={p.title}
              onClick={() => store.update((q) => ({ ...q, captions: withPreset(captionsOf(q), p.value) }))}
            >
              <PresetSample preset={p.value} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
      <Chips<CaptionSettings['position']>
        label="Position"
        value={s.position}
        onChange={(position) => set({ position })}
        options={[
          { value: 'bottom', label: 'Bottom' },
          { value: 'middle', label: 'Middle' },
          { value: 'top', label: 'Top' }
        ]}
      />
      <Slider label="Size" value={s.size} min={CAPTION_SIZE.min} max={CAPTION_SIZE.max} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(size) => set({ size }, 'caption-size')} />
      <div className="field">
        <span>Text colour</span>
        <ColorDots label="Text colour" value={s.color} presets={CAPTION_COLORS} onChange={(color, key) => set({ color }, key ?? undefined)} mergeKey="caption-color" />
      </div>
      <div className="field">
        <span>Highlight colour</span>
        <ColorDots label="Highlight colour" value={s.highlightColor} presets={HIGHLIGHT_COLORS} onChange={(highlightColor, key) => set({ highlightColor }, key ?? undefined)} mergeKey="caption-highlight" />
        {!(s.preset === 'karaoke' || s.preset === 'bold') && <span className="hint">Lights up the spoken word in the Bold and Karaoke styles.</span>}
      </div>
      <Chips<CaptionSettings['background']>
        label="Background"
        value={s.background}
        onChange={(background) => set({ background })}
        options={[
          { value: 'none', label: 'None', title: 'Text with a thin outline' },
          { value: 'box', label: 'Box', title: 'A dark box behind each line' },
          { value: 'shadow', label: 'Shadow', title: 'A soft shadow behind the text' }
        ]}
      />
      <Chips<CaptionSettings['maxLines']>
        label="Lines"
        value={s.maxLines}
        onChange={(maxLines) => set({ maxLines })}
        options={[
          { value: 1, label: 'One line' },
          { value: 2, label: 'Up to two lines' }
        ]}
      />
      <p className="hint">Long captions show part by part. The preview shows them as the export draws them.</p>
    </Section>
  )
}

/** "Aa" in the preset's look. */
function PresetSample({ preset }: { preset: CaptionPreset }): JSX.Element {
  return (
    <span className={`caption-sample ${preset}`} aria-hidden="true">
      {preset === 'bold' ? 'AA' : preset === 'karaoke' ? <><em>A</em>a</> : 'Aa'}
    </span>
  )
}

/** Preset colours and a "pick any colour" dot (the look of the Shapes panel's). */
function ColorDots({ label, value, presets, onChange, mergeKey }: { label: string; value: string; presets: string[]; onChange: (color: string, key: string | null) => void; mergeKey: string }): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  return (
    <div className="shape-colors" role="group" aria-label={label}>
      {presets.map((c) => (
        <button key={c} className={`shape-color ${v === c ? 'active' : ''}`} style={{ background: c }} title={c} aria-label={`${label} ${c}`} aria-pressed={v === c} onClick={() => onChange(c, null)} />
      ))}
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}

/* ---------- transcript ---------- */

/** Captions listed at once; the list pages through longer transcripts. */
const PAGE = 150

const setSegments = (p: Project, segments: CaptionSegment[]): Project => (p.transcript ? { ...p, transcript: { ...p.transcript, segments } } : p)

function TranscriptSection({
  project,
  transcript,
  selectedId,
  focusId,
  onFocused,
  onSelect,
  onNotice
}: {
  project: Project
  transcript: Transcript
  selectedId: string | null
  focusId: string | null
  onFocused: () => void
  onSelect: InspectorProps['onSelect']
  onNotice: (message: string) => void
}): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const segments = transcript.segments
  const clips = project.clips
  const listRef = useRef<HTMLOListElement>(null)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [showFind, setShowFind] = useState(false)
  const matches = useMemo(() => findInCaptions(segments, find), [segments, find])
  const matchIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches])
  const matchCount = matches.reduce((n, m) => n + m.count, 0)

  // The caption under the playhead (re-rendered only when it changes, not on every frame).
  const currentAt = useCallback(() => {
    const i = captionIndexAt(store.state.transcript?.segments ?? [], displayTime(store.state.clips, player.time))
    return i < 0 ? '' : (store.state.transcript?.segments[i].id ?? '')
  }, [store, player])
  const currentId = useSyncExternalStore(player.subscribe, currentAt)
  const playing = useSyncExternalStore(player.subscribe, player.getPlaying)

  const anchorId = focusId ?? selectedId ?? currentId
  const anchor = Math.max(0, segments.findIndex((s) => s.id === anchorId))
  const [page, setPage] = useState(() => Math.floor(anchor / PAGE))
  const pages = Math.max(1, Math.ceil(segments.length / PAGE))
  useEffect(() => {
    if (anchorId) setPage(Math.floor(anchor / PAGE))
  }, [anchorId, anchor])
  const shownPage = Math.min(page, pages - 1)
  const shown = segments.slice(shownPage * PAGE, shownPage * PAGE + PAGE)

  // Keeps the caption being played (or just selected) in view.
  useEffect(() => {
    const id = playing ? currentId : selectedId
    if (!id) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-caption-row="${CSS.escape(id)}"]`)
    if (row && !row.contains(document.activeElement)) row.scrollIntoView({ block: 'nearest' })
  }, [playing, currentId, selectedId, shownPage])

  // A double-click on the track: the cursor goes into that caption's text.
  useEffect(() => {
    if (!focusId) return
    const field = listRef.current?.querySelector<HTMLTextAreaElement>(`[data-caption-row="${CSS.escape(focusId)}"] textarea`)
    if (!field) return
    field.scrollIntoView({ block: 'nearest' })
    field.focus()
    field.select()
    onFocused()
  }, [focusId, shownPage, onFocused])

  const go = (id: string): void => {
    onSelect({ kind: 'caption', id })
    const list = store.state.transcript?.segments ?? []
    showCaption(player, list, list.findIndex((s) => s.id === id), store.state.clips)
  }

  const setText = (id: string, raw: string): void => {
    // While typing: one line, but spaces kept; cleaned when the field is left.
    const text = raw.replace(/[\r\n]+/g, ' ').slice(0, CAPTION_MAX_CHARS)
    store.update((p) => setSegments(p, (p.transcript?.segments ?? []).map((s) => (s.id === id ? { ...s, text } : s))), `caption-text:${id}`)
  }
  const tidyText = (id: string): void => {
    const seg = store.state.transcript?.segments.find((s) => s.id === id)
    if (!seg) return
    const text = cleanCaptionText(seg.text)
    if (text === seg.text && text) return
    // A caption whose text was all deleted goes, as Replace all and loading a project do (part of the typing's undo step).
    store.replace((p) => setSegments(p, (p.transcript?.segments ?? []).flatMap((s) => (s.id !== id ? [s] : text ? [{ ...s, text }] : []))))
    if (!text && selectedId === id) onSelect(null)
  }

  const split = (id: string): void => {
    const next = splitCaption(store.state.transcript?.segments ?? [], id, displayTime(store.state.clips, player.time))
    if (!next) return onNotice('Move the playhead inside this caption, between two of its words, to split it there')
    store.update((p) => setSegments(p, next))
  }
  const merge = (id: string): void => {
    const next = mergeWithNext(store.state.transcript?.segments ?? [], id)
    if (next) store.update((p) => setSegments(p, next))
  }
  const remove = (id: string): void => {
    store.update((p) => setSegments(p, (p.transcript?.segments ?? []).filter((s) => s.id !== id)))
    if (selectedId === id) onSelect(null)
  }
  const replaceAll = (): void => {
    const r = replaceInCaptions(store.state.transcript?.segments ?? [], find, replace)
    if (!r.count) return onNotice(`"${find}" is not in the captions`)
    store.update((p) => setSegments(p, r.segments))
    onNotice(`Replaced ${r.count} ${r.count === 1 ? 'time' : 'times'}`)
  }

  const playheadIn = (s: CaptionSegment): boolean => {
    const t = displayTime(clips, player.time)
    return t > s.start && t < s.end
  }

  return (
    <Section
      title={`Transcript (${segments.length})`}
      aside={
        <button className={`btn ghost icon-btn ${showFind ? 'active' : ''}`} title="Find and replace" aria-label="Find and replace" aria-pressed={showFind} onClick={() => setShowFind((v) => !v)}>
          <SearchIcon size={14} />
        </button>
      }
    >
      {showFind && (
        <div className="captions-find">
          <input className="tc-input" aria-label="Find in captions" placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
          <input className="tc-input" aria-label="Replace with" placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
          <div className="row start">
            <span className="hint">{find ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}` : 'Ignores upper and lower case'}</span>
            <button className="btn small" disabled={!matchCount} onClick={replaceAll}>
              Replace all
            </button>
          </div>
        </div>
      )}
      {segments.length === 0 && <p className="hint">Every caption was deleted. Regenerate them above, or undo.</p>}
      {pages > 1 && (
        <div className="row captions-pager">
          <button className="btn small" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>
            Earlier
          </button>
          <span className="hint">
            {shownPage * PAGE + 1}–{Math.min(segments.length, (shownPage + 1) * PAGE)} of {segments.length}
          </span>
          <button className="btn small" disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)}>
            Later
          </button>
        </div>
      )}
      <ol className="caption-list" ref={listRef}>
        {shown.map((s, k) => {
          const isLast = shownPage * PAGE + k === segments.length - 1
          return (
            <li
              key={s.id}
              data-caption-row={s.id}
              className={`caption-row ${selectedId === s.id ? 'selected' : ''} ${currentId === s.id ? 'current' : ''} ${find && matchIds.has(s.id) ? 'match' : ''}`}
            >
              <button className="caption-time" title="Go to this caption" onClick={() => go(s.id)}>
                {formatTime(viewingTime(clips, s.start))}
              </button>
              <textarea
                className="caption-text"
                rows={Math.min(4, Math.max(1, Math.ceil(s.text.length / 34)))}
                aria-label={`Caption at ${formatTime(viewingTime(clips, s.start))}`}
                value={s.text}
                onFocus={() => selectedId !== s.id && onSelect({ kind: 'caption', id: s.id })}
                onChange={(e) => setText(s.id, e.target.value)}
                onBlur={() => tidyText(s.id)}
              />
              <div className="caption-tools">
                <button className="btn ghost icon-btn" title="Split at the playhead" aria-label="Split at the playhead" onClick={() => split(s.id)} disabled={!playheadIn(s) && currentId !== s.id}>
                  <EditorIcon name="scissors" size={14} />
                </button>
                <button className="btn ghost icon-btn" title="Merge with the next caption" aria-label="Merge with the next caption" onClick={() => merge(s.id)} disabled={isLast}>
                  <Icon name="plus" size={14} />
                </button>
                <button className="btn ghost icon-btn" title={withShortcut('Delete this caption', keymap.deleteSelection)} aria-label="Delete this caption" onClick={() => remove(s.id)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      <p className="hint">Times are where each caption plays in the video. Drag captions on the caption track to change their timing.</p>
    </Section>
  )
}

/* ---------- AI tools ---------- */

type AiTask = 'cleanup' | 'translate' | 'chapters' | 'title' | 'summary'

/** Control characters of an AI answer as spaces (`keepLines`: line breaks stay), trimmed. */
const plainAnswer = (text: string, keepLines = false): string =>
  (keepLines ? text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/[\u0000-\u001f\u007f]+/g, ' ')).trim()

function AiToolsSection({
  providers,
  onNotice,
  services
}: {
  providers: AiProviderInfo[] | null
  onNotice: (message: string) => void
  services: ReturnType<typeof useEditor>
}): JSX.Element {
  const { store } = services
  const [provider, setProvider] = useState(remembered.textProvider)
  const [translateTo, setTranslateTo] = useState(remembered.translateTo)
  const [busy, setBusy] = useState<AiTask | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const list = providers ?? []
  const chosen = list.find((p) => p.id === provider) ?? list[0] ?? null
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    []
  )
  useEffect(() => {
    remembered.textProvider = provider
    remembered.translateTo = translateTo
  }, [provider, translateTo])

  const run = async (task: AiTask): Promise<void> => {
    if (!chosen || busy) return
    const before = store.state.transcript
    if (!before?.segments.length) return
    setBusy(task)
    setError(null)
    setTitle(null)
    setSummary(null)
    const request: AiTextRequest = { task, segments: before.segments }
    // The language's name: the provider is told to translate "into" it, and a code such as 'it' or 'id' reads as a word.
    if (task === 'translate') request.targetLanguage = CAPTION_LANGUAGES.find((l) => l.code === translateTo)?.name ?? translateTo
    let result: AiTextResult
    try {
      result = await window.api.aiText(chosen.id, request)
    } catch (err) {
      if (live.current) {
        setBusy(null)
        setError(ipcMessage(err))
      }
      return
    }
    if (live.current) setBusy(null)
    const fail = (message: string): void => (live.current ? setError(message) : onNotice(message))
    if (!result || typeof result !== 'object' || result.task !== task) return fail('The provider answered something else; nothing was changed.')
    if (result.task === 'cleanup' || result.task === 'translate') {
      // Only onto the captions it was made from: edits made meanwhile would be lost.
      if (store.state.transcript?.segments !== before.segments) return fail('The captions changed while the provider worked; nothing was replaced. Try again.')
      const next = applyTextResult(before.segments, result.segments)
      if (!next) return fail('The provider changed the captions’ timing or left some out, so its answer was not used.')
      const language = result.task === 'translate' ? translateTo : before.language
      store.update((p) => (p.transcript ? { ...p, transcript: { ...p.transcript, segments: next, ...(language ? { language } : {}) } } : p))
      const name = CAPTION_LANGUAGES.find((l) => l.code === translateTo)?.name ?? translateTo
      onNotice(result.task === 'translate' ? `Captions translated to ${name} (Undo brings the original back)` : 'Captions fixed (Undo brings the original back)')
    } else if (result.task === 'chapters') {
      const found = readSuggestedChapters(result.chapters, store.state.duration)
      const existing = store.state.chapters ?? []
      const added = found.filter((c, i) => !chapterNear(existing, c.t) && !found.slice(0, i).some((d) => Math.abs(d.t - c.t) < 0.1)).map((c) => createChapter(c.t, c.title))
      if (!added.length) return fail(found.length ? 'The suggested chapters are already there.' : 'The provider suggested no chapters.')
      store.update((p) => ({ ...p, chapters: [...(p.chapters ?? []), ...added] }))
      onNotice(`Added ${added.length} ${added.length === 1 ? 'chapter' : 'chapters'} (see the Text tab)`)
    } else if (result.task === 'title') {
      const text = typeof result.text === 'string' ? plainAnswer(result.text).replace(/^["“'\s]+|["”'\s]+$/g, '').slice(0, 120) : ''
      if (!text) return fail('The provider suggested no title.')
      if (live.current) setTitle(text)
    } else if (result.task === 'summary') {
      const text = typeof result.text === 'string' ? plainAnswer(result.text, true).slice(0, 4000) : ''
      if (!text) return fail('The provider wrote no summary.')
      if (live.current) setSummary(text)
    }
  }

  const label = (task: AiTask, text: string): string => (busy === task ? 'Working…' : text)
  return (
    <Section title="AI tools">
      {providers !== null && list.length === 0 ? (
        <div className="captions-empty">
          <p>Add an AI provider to fix, translate and summarise your captions. OpenAI, Gemini and Claude all can.</p>
          <button className="btn" onClick={openAiSettings}>
            <EditorIcon name="gear" size={15} /> Add an AI provider
          </button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Provider</span>
            <select className="captions-select" aria-label="AI provider for text" value={chosen?.id ?? ''} onChange={(e) => setProvider(e.target.value)} disabled={!list.length}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <div className="captions-ai">
            <button className="btn" disabled={!chosen || !!busy} onClick={() => void run('cleanup')} title="Fix spelling, punctuation and misheard words; the timing stays">
              {label('cleanup', 'Fix captions')}
            </button>
            <div className="captions-translate">
              <button className="btn" disabled={!chosen || !!busy} onClick={() => void run('translate')} title="Replace the text with a translation; the timing stays">
                {label('translate', 'Translate to…')}
              </button>
              <select className="captions-select" aria-label="Translate to" value={translateTo} onChange={(e) => setTranslateTo(e.target.value)}>
                {CAPTION_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" disabled={!chosen || !!busy} onClick={() => void run('chapters')} title="Chapters from what is said, added to the chapter strip">
              {label('chapters', 'Suggest chapters')}
            </button>
            <button className="btn" disabled={!chosen || !!busy} onClick={() => void run('title')} title="A name for this recording from what is said">
              {label('title', 'Suggest a title')}
            </button>
            <button className="btn" disabled={!chosen || !!busy} onClick={() => void run('summary')} title="A short summary of what is said, to copy into a description">
              {label('summary', 'Summarize')}
            </button>
          </div>
          {title && (
            <div className="captions-suggestion" role="status">
              <p>
                Suggested title: <strong>{title}</strong>
              </p>
              <div className="row start">
                <button
                  className="btn small primary"
                  onClick={() => {
                    store.update((p) => ({ ...p, name: title }))
                    setTitle(null)
                    onNotice('Recording renamed')
                  }}
                >
                  Rename the recording
                </button>
                <button className="btn small ghost" onClick={() => setTitle(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {summary && (
            <div className="captions-suggestion" role="status">
              <p>Summary:</p>
              <p className="captions-summary">{summary}</p>
              <div className="row start">
                <button
                  className="btn small primary"
                  onClick={() =>
                    void navigator.clipboard.writeText(summary).then(
                      () => onNotice('Summary copied'),
                      () => onNotice('The summary could not be copied')
                    )
                  }
                >
                  Copy
                </button>
                <button className="btn small ghost" onClick={() => setSummary(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="hint warn" role="alert">
              {error}
            </p>
          )}
          <p className="hint">Each tool sends the caption text (not the sound) to {chosen ? KIND_NAMES[chosen.kind] : 'the provider'}. Undo reverts any change.</p>
        </>
      )}
    </Section>
  )
}

/* ---------- subtitle files ---------- */

function ExportSection({ project, transcript, request, onNotice }: { project: Project; transcript: Transcript; request: number; onNotice: (message: string) => void }): JSX.Element {
  const [format, setFormat] = useState<SubtitleFormat>(remembered.format)
  const [saving, setSaving] = useState(false)
  const latest = useRef({ project, format })
  latest.current = { project, format }
  const buttonRef = useRef<HTMLButtonElement>(null)

  const save = useCallback(async (): Promise<void> => {
    const { project: p, format: f } = latest.current
    const segments = p.transcript?.segments ?? []
    if (!segments.length) return onNotice('There are no captions to export')
    setSaving(true)
    try {
      const file = await window.api.saveCaptions(p.name, f, subtitleFile(segments, p.clips, f))
      if (file) onNotice(`Captions saved: ${file}`)
    } catch (err) {
      onNotice(`The captions could not be saved: ${ipcMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }, [onNotice])

  // The "Export captions…" command.
  const handled = useRef(0)
  useEffect(() => {
    if (!request || request === handled.current) return
    handled.current = request
    buttonRef.current?.focus()
    void save()
  }, [request, save])

  return (
    <Section title="Export captions">
      <Chips<SubtitleFormat>
        label="Subtitle format"
        value={format}
        onChange={(f) => {
          remembered.format = f
          setFormat(f)
        }}
        options={SUBTITLE_FORMATS}
      />
      <button ref={buttonRef} className="btn" disabled={saving || !transcript.segments.length} onClick={() => void save()}>
        <EditorIcon name="captions" size={15} /> {saving ? 'Saving…' : 'Export captions…'}
      </button>
      <p className="hint">Times follow your cuts and speed changes, like the exported video. Captions are drawn on the video when Show captions is on.</p>
    </Section>
  )
}
