/**
 * Publish (NW-13, docs/design/publish-pack.md §5): the copy to post with the video, written from its
 * captions and chapters with the user's AI provider. Every item is plain text in a textarea, editable,
 * copied exactly as shown; the YouTube description gets its chapter timestamps from the timeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'
import { notedPieces, saidLinks, type Noted, type Said as Spoken } from '../../../shared/publish/check'
import { BLOCKER_TEXT, PUBLISH_KINDS, PUBLISH_LABELS, PUBLISH_LENGTHS, PUBLISH_TONES, publishBlocker, publishSegments, transcriptKey, type PublishKind, type PublishPrefs } from '../../../shared/publish/pack'
import { plainText, xLength, X_LIMIT } from '../../../shared/publish/text'
import { composeYoutubeDescription, descriptionBody, descriptionToCheck, parseTags, projectYoutubeChapters, YOUTUBE_DESCRIPTION_MAX } from '../../../shared/publish/youtube'
import { userChapters } from '../../../shared/chapters/pending'
import { youtubeChapters } from '../../../shared/render/chapters'
import type { Project } from '../../../shared/types'
import { useEditor } from '../editor/context'
import { Chips } from '../editor/controls'
import { EditorIcon } from '../editor/EditorIcon'
import { useModalFocus } from '../editor/modalFocus'
import { useAiProviders } from '../editor/panels/CaptionsPanel'
import { checkNote, NotedConfirm, type NotedAsk } from './checkNote'
import { loadPublishPrefs, savePublishPrefs } from './publishPrefs'
import { editItem, isRunning, itemRequestId, packRequest, seedItem, stopAll, stopItem, usePackItems, writeItem, type PackItem, type WriteContext } from './publishRun'
import { textChoicesOf } from '../ai/textChoices'
import { useLocalAiReady } from '../ai/localAiState'
import { CostLine } from '../ai/CostLine'
import { LocalProgress, LocalWritten } from '../ai/LocalProgress'
import './publish.css'

/** A choice in the provider list: its name and model ("OpenAI · gpt-…"), or On this PC alone (smart-tools.md §20.0). */
const providerLabel = (c: TextChoice): string => (c.kind === 'local' ? c.label : `${c.label} · ${c.model || c.place}`)
/** Where the copy pack's text goes, by the chosen place (never "OpenAI" for a service, test 103). */
const sendsText = (c: TextChoice): string => (c.kind === 'local' ? 'Writes from the caption text on this PC: nothing is sent.' : `Sends the caption text (not the sound) to ${c.place}.`)
const openAiSettings = (): void => void window.dispatchEvent(new CustomEvent('ssw:open-settings', { detail: { section: 'ai' } }))

/** Most characters each card's counter measures against (X counts its own way). */
const LIMITS: Partial<Record<PublishKind, number>> = { youtube: YOUTUBE_DESCRIPTION_MAX, linkedin: 3000, xpost: X_LIMIT }

/** Longest text a card takes while editing. */
const EDIT_MAX = 25_000

/** How long a card's message ("X post copied") shows. */
const SAID_MS = 4000

export interface PublishDialogProps {
  project: Project
  /** An item a palette command asked to write as the dialog opens (n changes per request). */
  request: { kind: PublishKind; n: number } | null
  onClose: () => void
  /** Closes the dialog and runs the Captions tab's Generate captions. */
  onGenerateCaptions: () => void
  /** Closes the dialog and opens Text › Chapters at Find chapters (smart-tools.md §2.3). */
  onFindChapters?: () => void
  /** Closes the dialog and opens the Short clips panel (smart-tools.md §2.4). */
  onShortClips?: () => void
}

/** What a card's last action did, said on that card; `alert` when it failed. */
interface Said {
  kind: PublishKind
  text: string
  alert?: boolean
}

export function PublishDialog({ project, request, onClose, onGenerateCaptions, onFindChapters, onShortClips }: PublishDialogProps): JSX.Element {
  const { store } = useEditor()
  const boxRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const { providers } = useAiProviders()
  // The providers, services and On this PC (smart-tools.md §20.0); null while the providers are read.
  const localReady = useLocalAiReady()
  const choices = useMemo(() => (providers === null ? null : textChoicesOf(providers, 'youtube', localReady)), [providers, localReady])
  const [prefs, setPrefs] = useState<PublishPrefs>(loadPublishPrefs)
  const items = usePackItems(project.id)
  // What the edited video says: nothing that was cut is sent, and bleeped words go masked (made again when the bleeps change).
  const { transcript, clips, bleeps } = project
  const segments = useMemo(() => publishSegments({ transcript, clips, bleeps }), [transcript, clips, bleeps])
  const blocker = publishBlocker(project, segments)
  const list = choices ?? []
  const chosen = list.find((p) => p.id === prefs.provider) ?? list[0] ?? null
  const key = useMemo(() => transcriptKey(segments), [segments])
  const youtube = useMemo(() => projectYoutubeChapters(project), [project])
  const chapterTitles = useMemo(() => youtube.chapters.map((c) => c.title), [youtube])
  // The user's chapters only vouch for a link: a found chapter waiting for review never does (smart-tools.md §7.7).
  const userTitles = useMemo(
    () => (project.chapters?.some((c) => c.auto) ? projectYoutubeChapters({ ...project, chapters: userChapters(project) }).chapters.map((c) => c.title) : chapterTitles),
    [project, chapterTitles]
  )
  // What was said, for the link check (§4.8): the captions (not those an AI wrote a link into), the name, the chapter
  // titles. Read once per change of the captions, name or chapters, never per keystroke in a card.
  const said = useMemo(() => saidLinks(segments, { title: project.name, chapters: userTitles }), [segments, project.name, userTitles])
  // The confirm a noted text asks for before it is copied or used (§4.8).
  const [ask, setAsk] = useState<NotedAsk | null>(null)
  /** Runs `run` at once when `text` has nothing the check notes, else after the confirm. */
  const confirmed = (what: string, action: NotedAsk['action'], text: string, run: () => void): void => {
    const pieces = piecesOf(text, said)
    if (pieces.length) setAsk({ what, action, text, pieces, said, run })
    else run()
  }

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
    if (!chosen || blocker) return null
    return contextFor(chosen)
  }
  /** What a run with `c` sends besides the item (also the cost line's requests). */
  const contextFor = (c: TextChoice): WriteContext => {
    const chapters = chapterTitles
    return {
      providerId: c.id,
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

  // Write all or the empty state's button; the dialog itself while there is none (no sound, too
  // little speech) or it is disabled (providers loading), so the focus never stays behind the scrim.
  const focusFirst = (): void => {
    const first = firstRef.current
    if (first && !first.disabled) first.focus()
    else boxRef.current?.focus()
  }
  useEffect(() => {
    focusFirst()
  }, [providers === null, !!blocker]) // eslint-disable-line react-hooks/exhaustive-deps

  // The item a palette command asked for, once the providers are known: its card is shown, with the
  // focus on its text. After the focus above, which would scroll the dialog back to Write all. Its
  // Write is pressed, so the cost line asks its question first, as for a click (smart-tools.md §11.5).
  const handled = useRef(0)
  useEffect(() => {
    if (!request || request.n === handled.current || providers === null) return
    handled.current = request.n
    if (context()) document.getElementById(`publish-${request.kind}-write`)?.click()
    const card = document.querySelector<HTMLElement>(`[data-publish-card="${request.kind}"]`)
    card?.scrollIntoView({ block: 'nearest' })
    card?.querySelector<HTMLElement>('.publish-text')?.focus({ preventScroll: true })
  }, [request, providers]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = PUBLISH_KINDS.filter((k) => isRunning(items[k].status))
  const done = PUBLISH_KINDS.filter((k) => items[k].status === 'done').length

  // Stop all goes once nothing runs: when it had the focus, the focus goes to Write all, not the
  // page. Only then: a mouse click leaves the focus on the page too (focus.ts, or a click beside the
  // dialog after Tab), and the dialog must not scroll back up to Write all when the last item comes
  // in. Losing the focus with the window (another app) does not count: it is still Stop all's.
  const stopAllRef = useRef<HTMLButtonElement>(null)
  const stopAllFocused = useRef(false)
  useEffect(() => {
    if (!running.length && stopAllFocused.current && document.activeElement === document.body) focusFirst()
  }, [running.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Said on the card, not in the editor's notice: that one shows behind the dialog.
  const [notice, setNotice] = useState<Said | null>(null)
  const saidTimer = useRef(0)
  const say = (kind: PublishKind, text: string, alert = false): void => {
    setNotice({ kind, text, alert })
    window.clearTimeout(saidTimer.current)
    saidTimer.current = window.setTimeout(() => setNotice(null), SAID_MS)
  }
  useEffect(() => () => window.clearTimeout(saidTimer.current), [])

  const copy = (kind: PublishKind, text: string, what: string): void =>
    confirmed(what, 'Copy anyway', text, () => {
      void navigator.clipboard.writeText(text).then(
        () => say(kind, `${what} copied`),
        () => say(kind, `${what} could not be copied`, true)
      )
    })

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
          <button ref={firstRef} className="btn primary" data-testid="publish-write-all" aria-describedby={chosen ? 'publish-cost' : undefined} disabled={!chosen} onClick={() => write(PUBLISH_KINDS)}>
            <EditorIcon name="sparkle" size={15} /> {done ? 'Write all again' : 'Write all'}
          </button>
          <span className="publish-progress" role="status" data-testid="publish-progress">
            {running.length ? `Writing… ${done} of ${PUBLISH_KINDS.length} done` : ''}
          </span>
          {running.length > 0 && (
            <button
              ref={stopAllRef}
              className="btn ghost"
              onClick={() => stopAll(project.id)}
              onBlur={() => {
                if (document.hasFocus()) stopAllFocused.current = false
              }}
            >
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
              spoken={said}
              said={notice?.kind === kind ? notice : null}
              onWrite={() => write([kind])}
              onStop={() => stopItem(project.id, kind)}
              onEdit={(change) => editItem(project.id, kind, change)}
              onCopy={(text, what) => copy(kind, text, what)}
              onUseForExports={(text) => {
                const description = descriptionBody(text)
                if (!description) return
                // What any export's description file can have (with these chapters, or fewer): asked about first when the check notes anything in it.
                confirmed(PUBLISH_LABELS[kind], 'Use anyway', descriptionToCheck(description, youtube.chapters, youtube.duration, youtube.credit), () => {
                  store.update((p) => ({ ...p, publish: { description } }))
                  say(kind, "The export's description file will use this text")
                })
              }}
              onStopForExports={() => {
                store.update((p) => {
                  const { publish: _gone, ...rest } = p
                  return rest
                })
                say(kind, "The export's description is back to the standard one")
              }}
              onRename={(name) =>
                // The name counts as said once it is the recording's: asked about first when the check notes anything in it.
                confirmed(PUBLISH_LABELS[kind], 'Use anyway', name, () => {
                  store.update((p) => ({ ...p, name }))
                  say(kind, 'Recording renamed')
                })
              }
              onFindChapters={onFindChapters}
              requestId={isRunning(items[kind].status) ? itemRequestId(project.id, kind) : null}
              costId={chosen ? `publish-cost-${kind}` : undefined}
            />
          ))}
        </div>
        {/* What each card's Write sends, where, and what it costs, with Write all (smart-tools.md §11.5), part P5's. */}
        <CostLine
          id="publish-cost"
          choice={chosen}
          actions={PUBLISH_KINDS.map((kind) => ({
            key: kind,
            label: PUBLISH_LABELS[kind],
            buttonId: `publish-${kind}-write`,
            request: chosen && !blocker ? (): AiTextRequest => packRequest(kind, contextFor(chosen)) : null
          }))}
        />
        {onShortClips && (
          <p className="hint">
            <button type="button" className="link" data-testid="publish-short-clips" onClick={onShortClips}>
              Make short clips for Shorts and Reels…
            </button>
          </p>
        )}
      </>
    )
  }

  return (
    <div className="overlay modal-backdrop">
      <div
        className="publish-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        ref={boxRef}
        tabIndex={-1}
        data-testid="publish-dialog"
        onFocus={(e) => {
          stopAllFocused.current = (e.target as EventTarget) === stopAllRef.current
        }}
      >
        <header className="modal-head">
          <h2 id="publish-title">
            <EditorIcon name="transcript" size={18} /> Publish
          </h2>
        </header>
        <p className="hint">Text to post with your video, written from its captions and chapters. Check it before you post.</p>
        {body}
        <footer className="modal-foot">
          <p className="hint publish-sends">{chosen && !blocker ? sendsText(chosen) : ''}</p>
          <button className="btn" onClick={close}>
            Close
          </button>
        </footer>
        {ask && <NotedConfirm ask={ask} onClose={() => setAsk(null)} />}
      </div>
    </div>
  )
}

/** From this video length (seconds) the YouTube card offers Find chapters when there are none (smart-tools.md §2.3). */
const FIND_CHAPTERS_FROM = 120

interface CardProps {
  kind: PublishKind
  item: PackItem
  stale: boolean
  canWrite: boolean
  youtube: ReturnType<typeof projectYoutubeChapters>
  saved: string | null
  /** What was said, for the link check's notes. */
  spoken: Spoken
  said: Said | null
  onWrite: () => void
  onStop: () => void
  onEdit: (change: Partial<Pick<PackItem, 'text' | 'tags'>>) => void
  onCopy: (text: string, what: string) => void
  onUseForExports: (text: string) => void
  onStopForExports: () => void
  onRename: (name: string) => void
  /** Opens Find chapters (the YouTube card of a video without chapters). */
  onFindChapters?: () => void
  /** The card's run now (AI on this PC shows its progress beside Stop, smart-tools.md §20.0), or null. */
  requestId?: string | null
  /** The cost line's sentence for this card's Write. */
  costId?: string
}

/** notedPieces, remembered for the last texts of each `said` (a card is drawn again on every change of the dialog). */
const checked = new WeakMap<Spoken, Map<string, Noted[]>>()
function piecesOf(text: string, said: Spoken): Noted[] {
  let memo = checked.get(said)
  if (!memo) checked.set(said, (memo = new Map()))
  let pieces = memo.get(text)
  if (!pieces) {
    pieces = notedPieces(text, said)
    if (memo.size >= 32) memo.delete(memo.keys().next().value as string)
    memo.set(text, pieces)
  }
  return pieces
}

/** A card's status line (role status): "Written" is how a screen reader hears the text is ready. */
const STATUS_TEXT: Record<PackItem['status'], string> = { idle: 'Not written yet', waiting: 'Waiting…', writing: 'Writing…', done: 'Written', error: '' }
/** "Written" only for new text: a stopped run says so, and a card the user emptied is not written. */
const statusText = (item: PackItem): string => (item.stopped ? 'Stopped' : item.status === 'done' && !item.text.trim() ? STATUS_TEXT.idle : STATUS_TEXT[item.status])

function Card({ kind, item, stale, canWrite, youtube, saved, spoken, said, onWrite, onStop, onEdit, onCopy, onUseForExports, onStopForExports, onRename, onFindChapters, requestId = null, costId }: CardProps): JSX.Element {
  const label = PUBLISH_LABELS[kind]
  const id = `publish-${kind}`
  const busy = isRunning(item.status)
  const isYoutube = kind === 'youtube'
  const chapters = isYoutube && youtube.chapters.length ? youtubeChapters(youtube.chapters, youtube.duration) : null
  // The YouTube text is saved for exports and copied the same way, so the export's file is what Copy gives.
  const body = isYoutube ? descriptionBody(item.text) : ''
  // With a library bed, its credit is the last line (editing polish §10.10).
  const copied = isYoutube ? composeYoutubeDescription(body, youtube.chapters, youtube.duration, youtube.credit) : item.text.trim()
  const limit = LIMITS[kind]
  const count = kind === 'xpost' ? xLength(item.text.trim()) : [...copied].length
  const over = limit !== undefined && count > limit
  const tags = parseTags(item.tags)
  const text = item.text.trim()
  const cleanTitle = kind === 'title' ? plainText(item.text, { max: 150, oneLine: true }) : ''
  const isSaved = saved !== null && saved === body
  // The link check (§4.8): what is copied or used for exports, read for anything link-like nobody said. Never changes the text.
  const checks = [...new Set(piecesOf(isYoutube ? `${descriptionToCheck(body, youtube.chapters, youtube.duration, youtube.credit)}\n${tags.join(', ')}` : copied, spoken).map((p) => p.text))]

  return (
    <section className="publish-card" data-publish-card={kind} data-status={item.status} aria-labelledby={`${id}-title`}>
      <header className="publish-card-head">
        <h3 id={`${id}-title`}>{label}</h3>
        <span className="publish-state" role="status">
          {busy && <span className="publish-spinner" aria-hidden="true" />}
          {statusText(item)}
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
        aria-describedby={checks.length && !busy ? `${id}-check` : undefined}
        onChange={(e) => onEdit({ text: e.target.value.slice(0, EDIT_MAX) })}
      />
      {!busy && checkNote(checks, `${id}-check`, spoken)}
      <LocalWritten show={!!item.local && !busy && !!text} />
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
          ) : youtube.duration >= FIND_CHAPTERS_FROM && onFindChapters ? (
            // A video of 2 minutes or more with no chapters (smart-tools.md §2.3).
            <p className="hint">
              Add chapters so viewers can jump:{' '}
              <button type="button" className="link" data-testid="publish-find-chapters" onClick={onFindChapters}>
                Find chapters
              </button>
            </p>
          ) : (
            <p className="hint">No chapters: add some in the Text tab and they appear here with their times.</p>
          )}
          {youtube.credit && (
            <p className="hint">
              Last line, for the music: {youtube.credit}
            </p>
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
          <>
            <button className="btn small" onClick={onStop}>
              Stop
            </button>
            <LocalProgress requestId={requestId} onStop={onStop} returnFocus={`publish-${kind}-write`} />
          </>
        ) : (
          <button id={`publish-${kind}-write`} className="btn small" aria-describedby={costId} disabled={!canWrite} onClick={onWrite}>
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
        {/* The name counts as said: a title with a note is asked about first (§4.8). */}
        {kind === 'title' && !busy && (
          <button className="btn small ghost" disabled={!cleanTitle} aria-describedby={checks.length ? `${id}-check` : undefined} onClick={() => onRename(cleanTitle)}>
            Rename the recording
          </button>
        )}
        <span className="publish-said" role="status">
          {said && !said.alert ? said.text : ''}
        </span>
        {said?.alert && (
          <span className="publish-said warn" role="alert">
            {said.text}
          </span>
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
