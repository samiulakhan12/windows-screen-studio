import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { cleanSpeakerName, SPEAKER_NAME_MAX, clearSpeakers, nextSpeakerName, renameSpeaker, setSpeaker, speakersOf, stemSpeakers } from '../../../../shared/captions/speakers'
import { captionsOf } from '../../../../shared/captions/settings'
import { t } from '../../../../shared/i18n/t'
import { askNow } from '../askNow'
import { speakerCopy } from '../captionWords'
import type { CaptionSegment, Project } from '../../../../shared/types'
import { loadAudioAnalysis } from '../audioAnalysis'
import { useEditor } from '../context'
import { Section, Toggle } from '../controls'
import './speakers.css'

/*
 * Speaker labels in the Captions tab (NW-09, docs/design/transcription.md §7.1): the speakers with
 * their names (renamed everywhere at once), "Label You and Others" from the sound tracks, a
 * speaker per caption, Show speaker names on the video and speaker names in the subtitle files.
 */

const setSegments = (p: Project, segments: CaptionSegment[]): Project => (p.transcript ? { ...p, transcript: { ...p.transcript, segments } } : p)

/** Whether the recording kept the microphone and the computer sound apart. */
export const hasBothStems = (project: Pick<Project, 'hasAudio' | 'audioStems'>): boolean => project.hasAudio && project.audioStems?.mic === true && project.audioStems?.system === true

/** Whether the Speakers section has something to show. */
export const speakersShown = (project: Project): boolean => !!project.transcript?.segments.some((s) => s.speaker) || hasBothStems(project)

/* ---------- the speakers ---------- */

export function SpeakersSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  const { store } = useEditor()
  const segments = project.transcript?.segments ?? []
  const speakers = useMemo(() => speakersOf(segments), [segments])
  const stems = hasBothStems(project)
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    []
  )

  const rename = (from: string, to: string): void => {
    const next = renameSpeaker(store.state.transcript?.segments ?? [], from, to)
    if (!next) return
    store.update((p) => setSegments(p, next))
    onNotice(speakerCopy.renamed(from, cleanSpeakerName(to)))
  }
  const remove = (): void => {
    const next = clearSpeakers(store.state.transcript?.segments ?? [])
    if (!next) return
    store.update((p) => setSegments(p, next))
    onNotice(speakerCopy.removed)
  }
  const fromStems = async (): Promise<void> => {
    if (busy) return
    // In English window.confirm answers at once (askNow), so the run starts in the click as before.
    const answer = speakers.length ? askNow(speakerCopy.replaceQuestion, 'captions.speakers.replaceAction') : true
    if (!(typeof answer === 'boolean' ? answer : await answer)) return
    setBusy(true)
    try {
      const levels = await loadAudioAnalysis(project.id, ['mic', 'system'])
      if (!levels.mic || !levels.system) return onNotice(speakerCopy.levelsFailed)
      // On the captions as they are now (an edit made while measuring is kept).
      const r = stemSpeakers(store.state.transcript?.segments ?? [], levels.mic, levels.system)
      if (!r.you && !r.others) return onNotice(speakerCopy.nothingHeard)
      store.update((p) => setSegments(p, r.segments))
      onNotice(speakerCopy.labelled(r.you, r.others))
    } catch {
      onNotice(speakerCopy.levelsFailed)
    } finally {
      if (live.current) setBusy(false)
    }
  }

  return (
    <Section title={speakerCopy.title}>
      {speakers.length > 0 && (
        <ul className="speaker-list" data-testid="speaker-list">
          {/* Keyed by place, not name: a rename keeps the field (and the focus). */}
          {speakers.map((s, i) => (
            <li key={i} className="speaker-row">
              <SpeakerName name={s.name} onRename={(to) => rename(s.name, to)} />
              <span className="hint">{speakerCopy.count(s.count)}</span>
            </li>
          ))}
        </ul>
      )}
      {!speakers.length && !stems && <p className="hint">{speakerCopy.none}</p>}
      <div className="row start">
        {stems && (
          <button className="btn small" disabled={busy || !segments.length} title={speakerCopy.labelStemsTitle} onClick={() => void fromStems()}>
            {busy ? t('common.state.working') : speakerCopy.labelStems}
          </button>
        )}
        {speakers.length > 0 && (
          <button className="btn small ghost" onClick={remove}>
            {speakerCopy.remove}
          </button>
        )}
      </div>
      {stems && <p className="hint">{speakerCopy.mixedHint}</p>}
    </Section>
  )
}

/** A speaker's name, applied on Enter or when left (never per key: a name typed through another speaker's must not merge them); Escape puts it back. */
function SpeakerName({ name, onRename }: { name: string; onRename: (to: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const commit = (): void => {
    if (draft !== name) onRename(draft)
  }
  return (
    <input
      className="tc-input speaker-name"
      aria-label={speakerCopy.nameLabel(name)}
      value={draft}
      maxLength={SPEAKER_NAME_MAX}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setDraft(name)
        }
      }}
    />
  )
}

/* ---------- a caption's speaker ---------- */

/** The option for a new speaker: a cleaned name never starts with a space. */
const NEW = ' new'

/** The speaker of one caption row: none, a speaker of the transcript, or a new one. */
export function CaptionSpeakerSelect({ segments, seg, at }: { segments: readonly CaptionSegment[]; seg: CaptionSegment; at: string }): JSX.Element {
  const { store } = useEditor()
  const names = useMemo(() => speakersOf(segments).map((s) => s.name), [segments])
  const fresh = useMemo(() => nextSpeakerName(segments), [segments])
  return (
    <select
      className="captions-select caption-speaker"
      aria-label={speakerCopy.selectLabel(at)}
      value={seg.speaker ?? ''}
      onChange={(e) => {
        const name = e.target.value === NEW ? fresh : e.target.value
        const next = setSpeaker(store.state.transcript?.segments ?? [], seg.id, name)
        if (next) store.update((p) => setSegments(p, next))
      }}
    >
      <option value="">{speakerCopy.noSpeaker}</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
      <option value={NEW}>{speakerCopy.newSpeaker(fresh)}</option>
    </select>
  )
}

/* ---------- options ---------- */

/** Look › Show speaker names (off by default), shown when there are labels. */
export function ShowSpeakerToggle({ project }: { project: Project }): JSX.Element | null {
  const { store } = useEditor()
  if (!project.transcript?.segments.some((s) => s.speaker)) return null
  const s = captionsOf(project)
  return (
    <Toggle
      label={speakerCopy.showOnVideo}
      title={speakerCopy.showOnVideoTitle}
      checked={s.showSpeaker === true}
      onChange={(on) =>
        store.update((p) => {
          const { showSpeaker: _old, ...rest } = captionsOf(p)
          return { ...p, captions: on ? { ...rest, showSpeaker: true } : rest }
        })
      }
    />
  )
}

/** Speaker names in SRT and text files, remembered for the session (the tab is unmounted while another one is open). */
let namesInFiles = false
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** The subtitle-file options the Captions tab exports with. */
export const speakerFileOptions = (): { speakerNames: boolean } => ({ speakerNames: namesInFiles })

/** Export captions › Speaker names in SRT and text, shown when there are labels. */
export function SpeakerNamesToggle({ project }: { project: Project }): JSX.Element | null {
  const on = useSyncExternalStore(subscribe, () => namesInFiles)
  if (!project.transcript?.segments.some((s) => s.speaker)) return null
  return (
    <Toggle
      label={speakerCopy.inFiles}
      title={speakerCopy.inFilesTitle}
      checked={on}
      onChange={(v) => {
        namesInFiles = v
        for (const fn of listeners) fn()
      }}
    />
  )
}
