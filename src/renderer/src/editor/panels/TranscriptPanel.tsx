import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { displayTime } from '../../../../shared/editor/clips'
import { cutFlags, cutWords, restoreWords, transcriptWords, wordIndexAt, wordsRange, type TranscriptWord } from '../../../../shared/editor/transcript'
import { applySuggestions, refreshSuggestions, reviewSuggestions, SUGGESTION_LABELS, type EditSuggestion } from '../../../../shared/editor/transcriptReview'
import {
  clickSelection,
  moveSelection,
  selectAll,
  SELECTION_KEYS,
  selectionSpan,
  validWordSelection,
  type SelectionKey,
  type WordSelection
} from '../../../../shared/editor/transcriptSelection'
import { eventKeyName } from '../../../../shared/editor/shortcuts'
import { planOf, videoTimeAt } from '../../../../shared/engine/freeze'
import { formatTime } from '../../../../shared/engine/project'
import { outputDuration } from '../../../../shared/engine/timeline'
import type { Clip, Project, Transcript } from '../../../../shared/types'
import { requestCaptions } from '../captionItems'
import { useEditor } from '../context'
import { EditorIcon } from '../EditorIcon'
import { Section } from '../controls'
import type { InspectorProps } from '../Inspector'
import './transcript.css'

/*
 * Edit by text (NW-04, NW-01; docs/design/edit-by-text.md): the transcript word by word. Deleting
 * words cuts them from the video (ordinary clips, one undo step); cut words stay, struck through,
 * to restore. Find fillers and retakes lists suggested cuts to keep or remove.
 */

/** Captions shown per page. */
const PAGE = 40
/** Above this share of estimated word times the tab says cuts may be less exact. */
const ESTIMATED_HINT = 0.1

/** The review list of each project while the editor is open (the tab is unmounted while another is open). */
const reviewMemory = new Map<string, { transcript: Transcript; items: EditSuggestion[] }>()

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const seconds = (s: number): string => `${s.toFixed(1)} s`

/** Whether two clip lists are the same edit. */
const sameClips = (a: readonly Clip[], b: readonly Clip[]): boolean =>
  a.length === b.length && a.every((c, i) => c.start === b[i].start && c.end === b[i].end && c.speed === b[i].speed)

export function TranscriptPanel(props: InspectorProps & { onOpenCaptions: () => void }): JSX.Element {
  const { project, onNotice, onSelect } = props
  const words = useMemo(() => transcriptWords(project.transcript), [project.transcript])
  if (words.length === 0) return <TranscriptIntro project={project} onOpenCaptions={props.onOpenCaptions} />
  return <TranscriptEditor project={project} transcript={project.transcript as Transcript} words={words} onNotice={onNotice} onSelect={onSelect} />
}

function TranscriptIntro({ project, onOpenCaptions }: { project: Project; onOpenCaptions: () => void }): JSX.Element {
  const make = (): void => {
    onOpenCaptions()
    requestCaptions({ kind: 'generate' })
  }
  return (
    <div className="transcript-panel">
      <Section title="Edit by text">
        <p className="hint">Cut the video by deleting words, like editing a document.</p>
        {project.hasAudio ? (
          <p className="hint">This video has no transcript yet. Make captions first: the transcript comes with them.</p>
        ) : (
          <p className="hint">This recording has no sound to make a transcript from.</p>
        )}
        <button className="btn primary" onClick={make} disabled={!project.hasAudio} data-testid="transcript-make-captions">
          <EditorIcon name="captions" size={15} /> Make captions
        </button>
      </Section>
    </div>
  )
}

function TranscriptEditor({
  project,
  transcript,
  words,
  onNotice,
  onSelect
}: {
  project: Project
  transcript: Transcript
  words: TranscriptWord[]
  onNotice: (message: string) => void
  onSelect: InspectorProps['onSelect']
}): JSX.Element {
  const { store, player } = useEditor()
  const clips = project.clips
  const flags = useMemo(() => cutFlags(words, clips), [words, clips])
  const cutCount = useMemo(() => flags.reduce((n, f) => n + (f ? 1 : 0), 0), [flags])
  const estimated = useMemo(() => words.filter((w) => w.estimated).length / words.length > ESTIMATED_HINT, [words])
  const plan = planOf(project)

  const [rawSel, setRawSel] = useState<WordSelection | null>(null)
  /** Selecting words leaves no timeline item selected: Delete with the focus outside the list (on a button just clicked) must not remove a hidden one. */
  const setSel = (next: WordSelection | null): void => {
    setRawSel(next)
    if (next) onSelect(null)
  }
  const sel = validWordSelection(rawSel, words.length)
  const span = sel ? selectionSpan(sel) : null
  const selectedCut = span ? flags.slice(span[0], span[1] + 1) : []
  const canCut = selectedCut.some((f) => !f)
  const canRestore = selectedCut.some((f) => f)

  // The word under the playhead, re-rendered only when it changes.
  const wordsRef = useRef(words)
  wordsRef.current = words
  const currentAt = useCallback(() => wordIndexAt(wordsRef.current, displayTime(store.state.clips, player.time)), [store, player])
  const current = useSyncExternalStore(player.subscribe, currentAt)
  const playing = useSyncExternalStore(player.subscribe, player.getPlaying)

  /* ---------- the review list ---------- */

  const [review, setReviewState] = useState(() => {
    const kept = reviewMemory.get(project.id)
    return kept && kept.transcript === transcript ? kept.items : null
  })
  const setReview = (items: EditSuggestion[] | null): void => {
    setReviewState(items)
    if (items) reviewMemory.set(project.id, { transcript, items })
    else reviewMemory.delete(project.id)
  }
  // A new transcript (regenerated captions, an edited caption) makes the list stale.
  const reviewFor = useRef(transcript)
  useEffect(() => {
    if (reviewFor.current === transcript) return
    reviewFor.current = transcript
    setReviewState(null)
    reviewMemory.delete(project.id)
  }, [transcript, project.id])
  // Rows whose words were cut since (a Remove, the timeline, undo) go; undo brings them back.
  const shownReview = useMemo(() => (review ? refreshSuggestions(review, words, clips, project.duration) : null), [review, words, clips, project.duration])
  const suggested = useMemo(() => {
    const marks = new Set<number>()
    for (const s of shownReview ?? []) for (let i = s.first; i <= s.last; i++) marks.add(i)
    return marks
  }, [shownReview])

  /* ---------- edits ---------- */

  const cut = (): void => {
    if (!span) return
    const [a, b] = span
    const before = store.state.clips
    if (flags.slice(a, b + 1).every((f) => f)) return onNotice('Already cut. Press Restore to bring it back')
    const range = wordsRange(words, a, b, store.state.duration)
    const next = cutWords(before, words, [[a, b]], store.state.duration)
    // Nothing changes only when the range is empty (zero-length words between touching ones) or
    // when nothing would be left (cutRange keeps no piece shorter than a clip may be).
    if (sameClips(next, before)) return onNotice(range.end - range.start > 1e-9 ? 'That would cut the whole video' : 'Too short to cut on its own. Select more words')
    store.update((p) => ({ ...p, clips: cutWords(p.clips, words, [[a, b]], p.duration) }))
    // Counted from the result: a short word left between two cuts goes with them (no clip is that short).
    const after = cutFlags(words, next)
    const newly = after.reduce((n, f, i) => n + (f && !flags[i] ? 1 : 0), 0)
    const saved = seconds(outputDuration(before) - outputDuration(next))
    onNotice(newly > 0 ? `Cut ${plural(newly, 'word')} (${saved})` : `Cut ${saved}`)
  }

  const restore = (): void => {
    if (!span) return
    const [a, b] = span
    if (flags.slice(a, b + 1).every((f) => !f)) return
    const before = store.state.clips
    const next = restoreWords(before, words, a, b, store.state.duration)
    if (sameClips(next, before)) return onNotice('Could not restore this here. Use Undo, or restore the cut on the timeline')
    store.update((p) => ({ ...p, clips: restoreWords(p.clips, words, a, b, p.duration) }))
    const after = cutFlags(words, next)
    const back = flags.reduce((n, f, i) => n + (f && !after[i] ? 1 : 0), 0)
    onNotice(`Restored ${plural(back, 'word')}`)
  }

  /** The buttons act like the keys, and give the focus back to the words (Delete goes on cutting there, not on the editor's selection). */
  const refocus = (fn: () => void) => (): void => {
    fn()
    listRef.current?.focus({ preventScroll: true })
  }

  const find = (): void => {
    const items = reviewSuggestions(words, store.state.clips, store.state.duration, transcript.language)
    setReview(items)
    // Said either way (the list appears below the words, out of the focus's way).
    onNotice(items.length > 0 ? `Found ${plural(items.length, 'filler or retake', 'fillers and retakes')}` : 'No fillers or retakes found')
  }

  const removeSuggestions = (items: EditSuggestion[]): number => {
    const before = store.state.clips
    const r = applySuggestions(before, words, items, store.state.duration)
    if (r.clips === before || sameClips(r.clips, before)) {
      onNotice('That would cut the whole video')
      return 0
    }
    store.update((p) => ({ ...p, clips: applySuggestions(p.clips, words, items, p.duration).clips }))
    return r.saved
  }

  const removeOne = (s: EditSuggestion): void => {
    const saved = removeSuggestions([s])
    if (saved > 0) onNotice(`Removed 1 (${seconds(saved)})`)
  }
  const keepOne = (s: EditSuggestion): void => setReview((review ?? []).filter((x) => x.id !== s.id))
  const removeAll = (): void => {
    const items = shownReview ?? []
    if (items.length === 0) return
    const saved = removeSuggestions(items)
    if (saved <= 0) return
    setReview(null)
    onNotice(`Removed ${items.length} (${seconds(saved)})`)
  }

  const goTo = (i: number): void => {
    const w = words[i]
    if (w) player.seek(w.start)
  }

  /* ---------- selection: pointer and keys ---------- */

  const listRef = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  useEffect(() => {
    const end = (): void => void (drag.current = null)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])

  const wordOf = (target: EventTarget | null): number | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-w]') : null
    return el ? Number(el.dataset.w) : null
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const i = wordOf(e.target)
    if (i === null) return
    // No native text selection: the words are the selection.
    e.preventDefault()
    listRef.current?.focus({ preventScroll: true })
    const next = clickSelection(sel, i, e.shiftKey)
    setSel(next)
    drag.current = next.anchor
    if (!e.shiftKey) goTo(i)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (drag.current === null || !(e.buttons & 1)) return
    const i = wordOf(document.elementFromPoint(e.clientX, e.clientY))
    if (i !== null && (!sel || sel.focus !== i)) setSel({ anchor: drag.current, focus: i })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const own = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (plain && SELECTION_KEYS.includes(e.key)) {
      own()
      const key = e.key as SelectionKey
      // On a page turned to with Earlier or Later the arrows start there (its first word, or its
      // last going back), not from a focus on another page; Shift keeps the anchor.
      let next: WordSelection | null
      if (key !== 'Home' && key !== 'End' && shown.length > 0 && (!sel || pageOfWord(sel.focus) !== shownPage)) {
        const w = key === 'ArrowLeft' || key === 'ArrowUp' ? shown[shown.length - 1].last : shown[0].first
        next = e.shiftKey && sel ? { anchor: sel.anchor, focus: w } : { anchor: w, focus: w }
      } else next = moveSelection(sel, key, e.shiftKey, words)
      setSel(next)
      // The page shows the focused word, also when the focus stays where it was (Home on word 0).
      if (next) setPage(pageOfWord(next.focus))
    } else if (plain && (e.key === 'Delete' || e.key === 'Backspace')) {
      own()
      cut()
    } else if (plain && !e.shiftKey && e.key === 'Enter') {
      own()
      if (sel) goTo(sel.focus)
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && eventKeyName(e) === 'A') {
      // Read as the editor reads it: Ctrl+A on any layout (Cyrillic, Greek, Bangla) is the A key.
      own()
      setSel(selectAll(words))
    } else if (plain && e.key === 'Escape' && sel) {
      own()
      setSel(null)
    }
  }

  /* ---------- pages and scrolling ---------- */

  const paragraphs = useMemo(() => {
    const out: { caption: string; first: number; last: number }[] = []
    for (const w of words) {
      const last = out[out.length - 1]
      if (last && last.caption === w.caption) last.last = w.index
      else out.push({ caption: w.caption, first: w.index, last: w.index })
    }
    return out
  }, [words])
  const pageOfWord = useCallback(
    (i: number): number => {
      let lo = 0
      let hi = paragraphs.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (paragraphs[mid].first <= i) lo = mid
        else hi = mid - 1
      }
      return Math.floor(lo / PAGE)
    },
    [paragraphs]
  )
  const pages = Math.max(1, Math.ceil(paragraphs.length / PAGE))
  const [page, setPage] = useState(0)
  const focus = sel?.focus ?? -1
  useEffect(() => {
    if (focus >= 0) setPage(pageOfWord(focus))
  }, [focus, pageOfWord])
  // While playing, the page turns when the word being said moves onto another page (Earlier and
  // Later stay where they were put until then).
  const followed = useRef(-1)
  useEffect(() => {
    if (!playing || current < 0) return
    const p = pageOfWord(current)
    if (p !== followed.current) {
      followed.current = p
      setPage(p)
    }
  }, [playing, current, pageOfWord])
  const shownPage = Math.min(page, pages - 1)
  const shown = paragraphs.slice(shownPage * PAGE, shownPage * PAGE + PAGE)

  useEffect(() => {
    if (focus < 0) return
    listRef.current?.querySelector(`#tw-${focus}`)?.scrollIntoView({ block: 'nearest' })
  }, [focus, shownPage])
  useEffect(() => {
    const list = listRef.current
    if (!playing || current < 0 || !list || list === document.activeElement) return
    list.querySelector(`#tw-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [playing, current, shownPage])

  /* ---------- view ---------- */

  const timeOf = (i: number): string => formatTime(videoTimeAt(clips, plan, words[i].start))

  return (
    <div className="transcript-panel">
      <Section title="Transcript" aside={<span className="hint transcript-count">{`${plural(words.length, 'word')} · ${cutCount} cut`}</span>}>
        <div className="row start transcript-tools">
          <button className="btn small" onClick={refocus(cut)} disabled={!canCut} title="Cut the selected words (Delete)">
            <EditorIcon name="scissors" size={14} /> Cut
          </button>
          <button className="btn small" onClick={refocus(restore)} disabled={!canRestore} title="Bring the selected words back">
            <EditorIcon name="restore" size={14} /> Restore
          </button>
          <button className="btn small" onClick={refocus(find)} data-testid="transcript-find">
            <EditorIcon name="sparkle" size={14} /> Find fillers and retakes
          </button>
        </div>
        <p className="hint">Select words and press Delete to cut them. Click a word to go there.</p>
        {estimated && <p className="hint">Some word times are estimated: cuts there may be less exact.</p>}
        {pages > 1 && (
          <div className="row transcript-pager">
            <button className="btn small" disabled={shownPage === 0} onClick={refocus(() => setPage(shownPage - 1))}>
              Earlier
            </button>
            <span className="hint">
              {shownPage * PAGE + 1}–{Math.min(paragraphs.length, (shownPage + 1) * PAGE)} of {paragraphs.length}
            </span>
            <button className="btn small" disabled={shownPage >= pages - 1} onClick={refocus(() => setPage(shownPage + 1))}>
              Later
            </button>
          </div>
        )}
        <div
          ref={listRef}
          className="transcript-words"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Transcript words"
          aria-activedescendant={focus >= 0 && pageOfWord(focus) === shownPage ? `tw-${focus}` : undefined}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKeyDown}
          data-testid="transcript-words"
        >
          {shown.map((p) => (
            <p key={p.caption} className="transcript-para" role="group" aria-label={`At ${timeOf(p.first)}`}>
              <span className="transcript-time" aria-hidden="true">
                {timeOf(p.first)}
              </span>
              {words.slice(p.first, p.last + 1).map((w) => {
                const i = w.index
                const selected = !!span && i >= span[0] && i <= span[1]
                const classes = ['tw']
                if (flags[i]) classes.push('cut')
                if (selected) classes.push('selected')
                if (i === current) classes.push('current')
                if (i === focus) classes.push('focus')
                if (suggested.has(i)) classes.push('suggested')
                // A space after each word: the line can wrap there.
                return (
                  <Fragment key={i}>
                    <span id={`tw-${i}`} data-w={i} role="option" aria-selected={selected} aria-label={flags[i] ? `${w.text}, cut` : w.text} className={classes.join(' ')}>
                      {w.text}
                    </span>{' '}
                  </Fragment>
                )
              })}
            </p>
          ))}
        </div>
      </Section>
      {shownReview && (
        <ReviewSection
          items={shownReview}
          words={words}
          timeOf={timeOf}
          onGo={goTo}
          onKeep={keepOne}
          onRemove={removeOne}
          onRemoveAll={removeAll}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  )
}

/** Up to this many words of a suggestion are quoted; more end in "…". */
const QUOTE_WORDS = 12
/** Words before a suggestion shown dimmed, for context. */
const CONTEXT_WORDS = 4

function ReviewSection({
  items,
  words,
  timeOf,
  onGo,
  onKeep,
  onRemove,
  onRemoveAll,
  onClose
}: {
  items: EditSuggestion[]
  words: TranscriptWord[]
  timeOf: (i: number) => string
  onGo: (i: number) => void
  onKeep: (s: EditSuggestion) => void
  onRemove: (s: EditSuggestion) => void
  onRemoveAll: () => void
  onClose: () => void
}): JSX.Element {
  const total = items.reduce((s, x) => s + x.saved, 0)
  const text = (a: number, b: number): string =>
    words
      .slice(a, b + 1)
      .map((w) => w.text)
      .join(' ')
  return (
    <Section title={`Fillers and retakes (${items.length})`}>
      {items.length === 0 ? (
        <p className="hint">No fillers or retakes found. Some captions leave fillers out. Captions made on this PC keep most of them.</p>
      ) : (
        <p className="hint">{`Nothing is cut until you choose. Removing all saves ${seconds(total)}.`}</p>
      )}
      <ul className="review-list" data-testid="transcript-review">
        {items.map((s) => {
          const long = s.last - s.first + 1 > QUOTE_WORDS
          const from = Math.max(0, s.first - CONTEXT_WORDS)
          return (
            <li key={s.id} className="review-row" data-kind={s.kind}>
              <button className="review-text" onClick={() => onGo(s.first)} title="Go to it">
                <span className="review-kind">{SUGGESTION_LABELS[s.kind]}</span>
                <span className="review-time">{timeOf(s.first)}</span>
                <span className="review-quote">
                  {from < s.first && <span className="review-context">{`${text(from, s.first - 1)} `}</span>}
                  <strong>{long ? `${text(s.first, s.first + QUOTE_WORDS - 1)}…` : text(s.first, s.last)}</strong>
                </span>
              </button>
              <div className="review-actions">
                <button className="btn small ghost" onClick={() => onKeep(s)} aria-label={`Keep ${SUGGESTION_LABELS[s.kind].toLowerCase()} at ${timeOf(s.first)}`}>
                  Keep
                </button>
                <button className="btn small" onClick={() => onRemove(s)} aria-label={`Remove ${SUGGESTION_LABELS[s.kind].toLowerCase()} at ${timeOf(s.first)}`}>
                  Remove
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="row start">
        {items.length > 0 && (
          <button className="btn primary small" onClick={onRemoveAll}>
            Remove all
          </button>
        )}
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
    </Section>
  )
}
