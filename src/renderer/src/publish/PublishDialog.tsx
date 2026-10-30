/**
 * Publish (NW-13, docs/design/publish-pack.md §5): the copy to post with the video, written from its
 * captions and chapters with the user's AI provider. Every item is plain text in a textarea, editable,
 * copied exactly as shown; the YouTube description gets its chapter timestamps from the timeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiProviderInfo } from '../../../shared/api/ai'
import { BLOCKER_TEXT, PUBLISH_KINDS, PUBLISH_LABELS, PUBLISH_LENGTHS, PUBLISH_TONES, publishBlocker, transcriptKey, type PublishKind, type PublishPrefs } from '../../../shared/publish/pack'
import { plainText, xLength, X_LIMIT } from '../../../shared/publish/text'
import { composeYoutubeDescription, parseTags, projectYoutubeChapters, YOUTUBE_DESCRIPTION_MAX } from '../../../shared/publish/youtube'
import { youtubeChapters } from '../../../shared/render/chapters'
import type { Project } from '../../../shared/types'
import { useEditor } from '../editor/context'
import { Chips } from '../editor/controls'
import { EditorIcon } from '../editor/EditorIcon'
import { useModalFocus } from '../editor/modalFocus'
import { useAiProviders } from '../editor/panels/CaptionsPanel'
import { loadPublishPrefs, savePublishPrefs } from './publishPrefs'
import { editItem, isRunning, seedItem, stopAll, stopItem, usePackItems, writeItem, type PackItem, type WriteContext } from './publishRun'
import './publish.css'

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }
const providerLabel = (p: AiProviderInfo): string => `${p.label || KIND_NAMES[p.kind]} · ${p.model || KIND_NAMES[p.kind]}`
const openAiSettings = (): void => void window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'ai' } }))

/** Most characters each card's counter measures against (X counts its own way). */
const LIMITS: Partial<Record<PublishKind, number>> = { youtube: YOUTUBE_DESCRIPTION_MAX, linkedin: 3000, xpost: X_LIMIT }

/** Longest text a card takes while editing. */
const EDIT_MAX = 25_000

export interface PublishDialogProps {
  project: Project
  /** An item a palette command asked to write as the dialog opens (n changes per request). */
  request: { kind: PublishKind; n: number } | null
  onClose: () => void
  /** Closes the dialog and runs the Captions tab's Generate captions. */
  onGenerateCaptions: () => void
  onNotice: (message: string) => void
}

export function PublishDialog({ project, request, onClose, onGenerateCaptions, onNotice }: PublishDialogProps): JSX.Element {
  const { store } = useEditor()
  const boxRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const { providers } = useAiProviders()
  const [prefs, setPrefs] = useState<PublishPrefs>(loadPublishPrefs)
  const items = usePackItems(project.id)
  const blocker = publishBlocker(project)
  const list = providers ?? []
  const chosen = list.find((p) => p.id === prefs.provider) ?? list[0] ?? null
  const segments = project.transcript?.segments
  const key = useMemo(() => transcriptKey(segments ?? []), [segments])
  const youtube = useMemo(() => projectYoutubeChapters(project), [project])

  // The description saved for exports shows in an empty YouTube card (a new session).
  useEffect(() => {
    if (project.publish?.description) seedItem(project.id, 'youtube', project.publish.description)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const close = (): void => {
    stopAll(project.id)
    onClose()
  }
  useModalFocus(boxRef, close)

  const choose = (change: Partial<PublishPrefs>): void => {
    const next = { ...prefs, ...change }
    setPrefs(next)
    savePublishPrefs(next)
  }

  const context = (): WriteContext | null => {
    if (!chosen || blocker || !segments) return null
    const chapters = youtube.chapters.map((c) => c.title)
    return {
      providerId: chosen.id,
      segments,
      tone: prefs.tone,
      length: prefs.length,
      context: { title: project.name, ...(chapters.length ? { chapters } : {}) },
      key
    }
  }
  const write = (kinds: readonly PublishKind[]): void => {
    const ctx = context()
    if (!ctx) return
    for (const kind of kinds) void writeItem(project.id, kind, ctx)
  }

  // The item a palette command asked for, once the providers are known.
  const handled = useRef(0)
  useEffect(() => {
    if (!request || request.n === handled.current || providers === null) return
    handled.current = request.n
    if (context()) write([request.kind])
    document.querySelector<HTMLElement>(`[data-publish-card="${request.kind}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [request, providers]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    firstRef.current?.focus()
  }, [providers === null, !!blocker]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = PUBLISH_KINDS.filter((k) => isRunning(items[k].status))
  const done = PUBLISH_KINDS.filter((k) => items[k].status === 'done').length

  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => onNotice(`${what} copied`),
      () => onNotice(`${what} could not be copied`)
    )
  }

  let body: JSX.Element
  if (providers !== null && list.length === 0) {
    body = (
      <div className="publish-empty">
        <p>Add an AI provider to write the copy. OpenAI, Gemini and Claude all can.</p>
        <button
          ref={firstRef}
          className="btn primary"
          onClick={() => {
            close()
            openAiSettings()
          }}
        >
          <EditorIcon name="gear" size={15} /> Add an AI provider
        </button>
      </div>
    )
  } else if (blocker) {
    body = (
      <div className="publish-empty" data-testid="publish-blocked" data-blocker={blocker}>
        <p>{BLOCKER_TEXT[blocker]}</p>
        {blocker === 'no-captions' && (
          <button ref={firstRef} className="btn primary" onClick={onGenerateCaptions}>
            <EditorIcon name="captions" size={15} /> Generate captions
          </button>
        )}
      </div>
    )
  } else {
    body = (
      <>
        <div className="publish-options">
          <label className="field">
            <span>AI provider</span>
            <select aria-label="AI provider" value={chosen?.id ?? ''} onChange={(e) => choose({ provider: e.target.value })} disabled={!list.length}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Tone</span>
            <Chips label="Tone" value={prefs.tone} options={[...PUBLISH_TONES]} onChange={(tone) => choose({ tone })} />
          </div>
          <div className="field">
            <span>Length</span>
            <Chips label="Length" value={prefs.length} options={[...PUBLISH_LENGTHS]} onChange={(length) => choose({ length })} />
          </div>
        </div>
        <div className="publish-run">
          <button ref={firstRef} className="btn primary" data-testid="publish-write-all" disabled={!chosen} onClick={() => write(PUBLISH_KINDS)}>
            <EditorIcon name="sparkle" size={15} /> {done ? 'Write all again' : 'Write all'}
          </button>
          <span className="publish-progress" role="status" data-testid="publish-progress">
            {running.length ? `Writing… ${done} of ${PUBLISH_KINDS.length} done` : ''}
          </span>
          {running.length > 0 && (
            <button className="btn ghost" onClick={() => stopAll(project.id)}>
              Stop all
            </button>
          )}
        </div>
        <div className="publish-cards">
          {PUBLISH_KINDS.map((kind) => (
            <Card
              key={kind}
              kind={kind}
              item={items[kind]}
              stale={!!items[kind].writtenFrom && items[kind].writtenFrom !== key}
              canWrite={!!chosen}
              youtube={youtube}
              saved={project.publish?.description ?? null}
              onWrite={() => write([kind])}
              onStop={() => stopItem(project.id, kind)}
              onEdit={(change) => editItem(project.id, kind, change)}
              onCopy={copy}
              onUseForExports={(text) => {
                const description = plainText(text, { max: 3000, keepLinks: true })
                if (!description) return
                store.update((p) => ({ ...p, publish: { description } }))
                onNotice("The export's description file will use this text")
              }}
              onStopForExports={() => {
                store.update((p) => {
                  const { publish: _gone, ...rest } = p
                  return rest
                })
                onNotice("The export's description is back to the standard one")
              }}
              onRename={(name) => {
                store.update((p) => ({ ...p, name }))
                onNotice('Recording renamed')
              }}
            />
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="overlay modal-backdrop">
      <div className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title" ref={boxRef} tabIndex={-1} data-testid="publish-dialog">
        <header className="modal-head">
          <h2 id="publish-title">
            <EditorIcon name="transcript" size={18} /> Publish
          </h2>
        </header>
        <p className="hint">Text to post with your video, written from its captions and chapters. Check it before you post.</p>
        {body}
        <footer className="modal-foot">
          <p className="hint publish-sends">{chosen && !blocker ? `Sends the caption text (not the sound) to ${KIND_NAMES[chosen.kind]}.` : ''}</p>
          <button className="btn" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

interface CardProps {
  kind: PublishKind
  item: PackItem
  stale: boolean
  canWrite: boolean
  youtube: ReturnType<typeof projectYoutubeChapters>
  saved: string | null
  onWrite: () => void
  onStop: () => void
  onEdit: (change: Partial<Pick<PackItem, 'text' | 'tags'>>) => void
  onCopy: (text: string, what: string) => void
  onUseForExports: (text: string) => void
  onStopForExports: () => void
  onRename: (name: string) => void
}

const STATUS_TEXT: Record<PackItem['status'], string> = { idle: 'Not written yet', waiting: 'Waiting…', writing: 'Writing…', done: '', error: '' }

function Card({ kind, item, stale, canWrite, youtube, saved, onWrite, onStop, onEdit, onCopy, onUseForExports, onStopForExports, onRename }: CardProps): JSX.Element {
  const label = PUBLISH_LABELS[kind]
  const id = `publish-${kind}`
  const busy = isRunning(item.status)
  const isYoutube = kind === 'youtube'
  const chapters = isYoutube && youtube.chapters.length ? youtubeChapters(youtube.chapters, youtube.duration) : null
  const copied = isYoutube ? composeYoutubeDescription(item.text, youtube.chapters, youtube.duration) : item.text.trim()
  const limit = LIMITS[kind]
  const count = kind === 'xpost' ? xLength(item.text.trim()) : [...copied].length
  const over = limit !== undefined && count > limit
  const tags = parseTags(item.tags)
  const text = item.text.trim()
  const isSaved = saved !== null && saved === plainText(item.text, { max: 3000, keepLinks: true })

  return (
    <section className="publish-card" data-publish-card={kind} data-status={item.status} aria-labelledby={`${id}-title`}>
      <header className="publish-card-head">
        <h3 id={`${id}-title`}>{label}</h3>
        <span className="publish-state" role="status">
          {busy && <span className="publish-spinner" aria-hidden="true" />}
          {STATUS_TEXT[item.status]}
        </span>
      </header>
      {item.error && (
        <p className="hint warn" role="alert">
          {item.error}
        </p>
      )}
      {stale && !busy && <p className="hint">Written from older captions: Regenerate to update.</p>}
      <textarea
        className="publish-text"
        aria-label={`${label} text`}
        value={item.text}
        rows={kind === 'title' ? 1 : kind === 'xpost' ? 3 : 6}
        placeholder={busy ? '' : 'Not written yet.'}
        readOnly={busy}
        onChange={(e) => onEdit({ text: e.target.value.slice(0, EDIT_MAX) })}
      />
      {isYoutube && (
        <div className="publish-youtube">
          <p className="publish-sub">Chapters (from your timeline)</p>
          {chapters ? (
            <>
              <pre className="publish-chapters" data-testid="publish-chapters">
                {chapters.text}
              </pre>
              {chapters.problems.map((p) => (
                <p key={p} className="hint">
                  {p}
                </p>
              ))}
            </>
          ) : (
            <p className="hint">No chapters: add some in the Text tab and they appear here with their times.</p>
          )}
          <label className="field">
            <span>Tags</span>
            <textarea className="publish-tags" aria-label="YouTube tags" rows={2} value={item.tags} readOnly={busy} onChange={(e) => onEdit({ tags: e.target.value.slice(0, 2000) })} />
          </label>
        </div>
      )}
      <div className="publish-actions">
        <button className="btn small primary" disabled={!text || busy} onClick={() => onCopy(copied, label)}>
          Copy
        </button>
        {isYoutube && (
          <button className="btn small" disabled={!tags.length || busy} onClick={() => onCopy(tags.join(', '), 'Tags')}>
            Copy tags
          </button>
        )}
        {busy ? (
          <button className="btn small" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="btn small" disabled={!canWrite} onClick={onWrite}>
            {item.text ? 'Regenerate' : 'Write'}
          </button>
        )}
        {isYoutube &&
          !busy &&
          (isSaved ? (
            <button className="btn small ghost" onClick={onStopForExports}>
              Stop using for exports
            </button>
          ) : (
            <button className="btn small ghost" disabled={!text} onClick={() => onUseForExports(item.text)} title="Save this description next to each export (Export › Also save › Description)">
              {saved ? 'Update for exports' : 'Use for exports'}
            </button>
          ))}
        {kind === 'title' && !busy && (
          <button className="btn small ghost" disabled={!text} onClick={() => onRename(plainText(text, { max: 150, oneLine: true, keepLinks: true }))}>
            Rename the recording
          </button>
        )}
        {limit !== undefined && (
          <span className={`publish-count ${over ? 'over' : ''}`} aria-label={`${count} of ${limit} characters`}>
            {count} / {limit}
          </span>
        )}
      </div>
      {isYoutube && isSaved && <p className="hint">Saved: exports with Also save › Description use this text and the chapters.</p>}
    </section>
  )
}
