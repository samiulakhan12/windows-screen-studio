/**
 * Captions › Clean up (docs/design/captions-studio.md §2.9, §11.7): capitals, full stops and
 * spaces, numbers as digits, the word list, bleeping, and the AI fix (the AI tools' Fix captions,
 * moved here). Tidy captions is one undo step; its changes are recorded for Review. The choices
 * (not the word list) are saved in prefs captionCleanup, which Make my captions great's tidy step
 * uses too. Mounted by the Captions tab with props { project: Project } (§14.4).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { cleanupNotice, DEFAULT_CLEANUP, readCleanupChoices, tidyCaptions, WORD_LIST_LIMITS, WORD_LIST_MAX, type CleanupChoices, type TextResult, type WordListEntry } from '../../../../shared/captions/cleanup'
import { applyTextResult } from '../../../../shared/captions/edit'
import type { Project } from '../../../../shared/types'
import { currentWordList, ipcMessage, loadWordList, onSectionRequest, onWordList, saveWordList, takeSectionRequest } from '../captionItems'
import { useEditor } from '../context'
import { useReturnFocus } from '../returnFocus'
import { Chips, Section } from '../controls'
import { useTextChoiceList } from '../../ai/textChoices'
import { CostLine } from '../../ai/CostLine'
import { runCostText } from '../../ai/useCost'
import { LocalProgress } from '../../ai/LocalProgress'

const DIGITS: { value: CleanupChoices['digits']; label: string }[] = [
  { value: 'above-ten', label: 'Above ten' },
  { value: 'all', label: 'All' },
  { value: 'off', label: 'Off' }
]
const BLEEP: { value: CleanupChoices['bleep']; label: string; title?: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'standard', label: 'Standard' },
  { value: 'strict', label: 'Strict', title: 'Also words that are only rude in some places' }
]
const BLEEP_SOUND: { value: CleanupChoices['bleepSound']; label: string }[] = [
  { value: 'tone', label: 'Tone' },
  { value: 'silence', label: 'Silence' }
]

/** A labelled checkbox (the Toggle look) whose input carries the test id. */
function Check(props: { testid: string; label: string; title?: string; checked: boolean; onChange: (on: boolean) => void; inputRef?: RefObject<HTMLInputElement> }): JSX.Element {
  return (
    <label className="toggle" title={props.title}>
      <span>{props.label}</span>
      <input ref={props.inputRef} type="checkbox" data-testid={props.testid} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  )
}

/** Why Fix captions with AI ticked nothing; it goes once a provider is added. */
const NO_PROVIDER = 'To fix spelling with AI, add an AI provider first: the button is in the AI tools section.'

/** Numbers the AI fix's requests, so each has its own request id. */
let cleanupSeq = 0

/** Drops a run's answer and stops the provider's request (cancelAiText). */
function stopRun(run: { cancelled: boolean; id: string }): void {
  run.cancelled = true
  void window.api.cancelAiText(run.id).catch(() => undefined)
}

/** "flow in, flowen" → ["flow in", "flowen"]. */
const heardForms = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean).slice(0, WORD_LIST_LIMITS.heard)

export function CleanupSection({ project }: { project: Project }): JSX.Element {
  const { store } = useEditor()
  // The providers, services and On this PC (smart-tools.md §20.0), each named by the place its text goes.
  const listed = useTextChoiceList('cleanup')
  const providers = listed ?? []
  const [choices, setChoices] = useState<CleanupChoices>({ ...DEFAULT_CLEANUP })
  const words = useSyncExternalStore(onWordList, currentWordList)
  const [provider, setProvider] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The AI fix's request id while it runs: AI on this PC shows its progress beside Cancel, and Stop reaches it. */
  const [running, setRunning] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [addingWord, setAddingWord] = useState(false)
  const [term, setTerm] = useState('')
  const [heard, setHeard] = useState('')
  const aiBox = useRef<HTMLInputElement>(null)
  const termBox = useRef<HTMLInputElement>(null)
  const firstRemove = useRef<HTMLButtonElement>(null)
  // Closed with the keyboard, the word form gives the focus back to Add a word, or to the new word's Remove once the list is full.
  const wordForm = useReturnFocus<HTMLFormElement>(addingWord, () => firstRemove.current)
  const closeWordForm = (keyed?: boolean): void => {
    wordForm.closing(keyed)
    setAddingWord(false)
  }
  const focusAi = useRef(false)
  const live = useRef(true)
  /** The AI fix under way: its request id, so Cancel (or the section going) stops the provider's request too. */
  const run = useRef<{ cancelled: boolean; id: string } | null>(null)
  useEffect(
    () => () => {
      live.current = false
      if (run.current) stopRun(run.current)
    },
    []
  )

  /** The saved choices have been read; until then a request for the AI fix waits for them (`wantAi`). */
  const loaded = useRef(false)
  const wantAi = useRef(false)
  /** The AI fix ticked on top of `c`, and saved: the other choices stay as they were. */
  const tickAi = (c: CleanupChoices): CleanupChoices => {
    const next = { ...c, ai: true }
    void window.api.setPref('captionCleanup', next).catch(() => undefined)
    return next
  }

  // The saved choices and the word list.
  useEffect(() => {
    void loadWordList()
    window.api
      .getPref('captionCleanup')
      .then((raw) => {
        if (!live.current) return
        loaded.current = true
        const saved = readCleanupChoices(raw)
        // A request that came while they loaded ticks the AI fix on top of them, not of the defaults.
        if (wantAi.current) {
          wantAi.current = false
          setChoices(tickAi(saved))
        } else setChoices(saved)
      })
      .catch(() => {
        if (!live.current) return
        loaded.current = true
        // Unread, the saved choices are not overwritten: the AI fix is ticked for this visit only.
        if (wantAi.current) {
          wantAi.current = false
          setChoices((c) => ({ ...c, ai: true }))
        }
      })
  }, [])

  // Fix captions with AI (aiCleanup) opens Clean up with the AI fix ticked and focused (§2.14).
  useEffect(() => {
    const take = (): void => {
      if (!takeSectionRequest('cleanup')) return
      // Mounted by the request, the section has not read the saved choices yet: the tick waits for them.
      if (loaded.current) setChoices(tickAi)
      else wantAi.current = true
      focusAi.current = true
    }
    take()
    return onSectionRequest(take)
  }, [])
  useEffect(() => {
    if (focusAi.current && aiBox.current) {
      focusAi.current = false
      aiBox.current.focus()
    } else if (focusAi.current && listed?.length === 0) {
      // No provider: the tick box is not shown, so there is nothing to focus; say what comes first.
      focusAi.current = false
      setStatus(NO_PROVIDER)
    }
  })
  // Added in Settings over the editor, a provider makes that message wrong: it goes (the focus stays put).
  useEffect(() => {
    if (status === NO_PROVIDER && listed?.length) setStatus('')
  }, [status, listed])
  useEffect(() => {
    if (addingWord) termBox.current?.focus()
  }, [addingWord])

  const choose = (patch: Partial<CleanupChoices>): void => {
    const next = { ...choices, ...patch }
    setChoices(next)
    void window.api.setPref('captionCleanup', next).catch(() => undefined)
  }

  const chosen = providers.find((p) => p.id === provider) ?? providers[0] ?? null
  const ai = choices.ai && !!chosen

  const tidy = async (): Promise<void> => {
    if (busy || !store.state.transcript?.segments.length) return
    setError(null)
    setStatus('')
    const list = currentWordList()
    let fix: TextResult | undefined
    let cost = ''
    let leftOut: string | undefined
    const before = store.state.transcript.segments
    // The provider fixes the captions as rules 1–4 leave them, so its answer goes on top of them
    // (rule 6) and keeps the word list's terms, the digits, the capitals and the full stops.
    const asked = ai && chosen ? (tidyCaptions(store.state, { ...choices, ai: false, bleep: 'off', words: list }).project.transcript?.segments ?? before) : before
    if (ai && chosen) {
      const mine = { cancelled: false, id: `captions-cleanup-${++cleanupSeq}` }
      run.current = mine
      setBusy(true)
      setRunning(mine.id)
      try {
        const result = await window.api.aiText(chosen.id, { task: 'cleanup', segments: asked }, mine.id)
        if (mine.cancelled || !live.current) return
        // What the run cost, for the notice (smart-tools.md §11.6).
        cost = runCostText(result.usage, chosen)
        if (result.task === 'cleanup') fix = result
        else leftOut = 'The AI fix was left out: the provider answered something else.'
      } catch (err) {
        if (mine.cancelled || !live.current) return
        leftOut = `The AI fix was left out: ${ipcMessage(err).replace(/\.?$/, '.')}`
      } finally {
        // Only the run still going: a cancelled run's late answer leaves the next run busy (and its Cancel).
        if (run.current === mine) {
          run.current = null
          if (live.current) {
            setBusy(false)
            setRunning(null)
          }
        }
      }
    }
    // The AI fix only onto the captions it was made from (edits made meanwhile would be lost), and
    // only when it kept their ids and times (applyTextResult, as Fix captions did).
    if (fix && store.state.transcript?.segments !== before) {
      fix = undefined
      leftOut = 'The AI fix was left out: the captions changed while the provider worked.'
    } else if (fix && !applyTextResult(asked, fix.segments)) {
      fix = undefined
      leftOut = "The AI fix was left out: the provider changed the captions' timing or left some out."
    }
    let out: ReturnType<typeof tidyCaptions> | null = null
    // One undo step for the rules, the AI fix and the bleeps.
    store.seal()
    store.update((p) => {
      out = tidyCaptions(p, { ...choices, ai: !!fix, words: list, ...(fix ? { fix } : {}) })
      return out.project
    })
    store.seal()
    const r = out as ReturnType<typeof tidyCaptions> | null
    if (r) setStatus([cleanupNotice({ changed: r.changed, bleeped: r.bleeped, estimated: r.estimated }), fix ? cost : ''].filter(Boolean).join(' '))
    // A fix left out stands out from the notice.
    if (leftOut) setError(leftOut)
  }

  const cancel = (): void => {
    if (run.current) stopRun(run.current)
    run.current = null
    setBusy(false)
    setRunning(null)
    setStatus('Tidy captions was cancelled; nothing was changed.')
  }

  const saveWords = (next: readonly WordListEntry[]): Promise<void> =>
    saveWordList(next).catch((err: unknown) => setError(`The word list could not be saved: ${ipcMessage(err)}`))
  const addWord = async (): Promise<void> => {
    const t = term.replace(/\s+/g, ' ').trim()
    if (!t) return
    const keyed = wordForm.byKey()
    const rest = words.filter((w) => w.term.toLowerCase() !== t.toLowerCase())
    // Saved before the form closes, so Add a word is already off when this word fills the list.
    await saveWords([{ term: t, heard: heardForms(heard) }, ...rest])
    setTerm('')
    setHeard('')
    closeWordForm(keyed)
  }

  return (
    <div data-testid="caption-cleanup">
      <Section title="Clean up">
        <Check testid="cleanup-caps" label="Capital letters" title="At the start of sentences, and “I”" checked={choices.caps} onChange={(caps) => choose({ caps })} />
        <Check testid="cleanup-punct" label="Full stops and spaces" title="A full stop before a pause, no space before punctuation" checked={choices.punct} onChange={(punct) => choose({ punct })} />
        <div className="field" data-testid="cleanup-digits">
          <span>Numbers as digits</span>
          <Chips label="Numbers as digits" value={choices.digits} options={DIGITS} onChange={(digits) => choose({ digits })} />
        </div>

        <div className="field" data-testid="cleanup-words">
          <span>Word list</span>
          <ul className="caption-list" aria-label="Word list">
            {words.map((w, i) => (
              <li key={w.term} className="caption-row">
                <span className="caption-text">
                  {w.term}
                  {w.heard.length > 0 && <span className="hint"> — also heard as: {w.heard.join(', ')}</span>}
                </span>
                <button
                  ref={i === 0 ? firstRemove : undefined}
                  className="btn small ghost"
                  aria-label={`Remove ${w.term} from the word list`}
                  onClick={() => void saveWords(words.filter((x) => x !== w))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {addingWord ? (
            <form
              ref={wordForm.form}
              className="captions-suggestion"
              onSubmit={(e) => {
                e.preventDefault()
                void addWord()
              }}
            >
              <label className="field">
                <span>Word</span>
                <input ref={termBox} className="captions-select" value={term} maxLength={WORD_LIST_LIMITS.chars} onChange={(e) => setTerm(e.target.value)} />
              </label>
              <label className="field">
                <span>Also heard as (comma between)</span>
                <input className="captions-select" value={heard} onChange={(e) => setHeard(e.target.value)} />
              </label>
              <div className="row start">
                <button type="submit" className="btn small primary" disabled={!term.trim()}>
                  Add
                </button>
                <button type="button" className="btn small ghost" onClick={() => closeWordForm()}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="row start">
              <button ref={wordForm.opener} className="btn small" disabled={words.length >= WORD_LIST_MAX} onClick={() => setAddingWord(true)}>
                Add a word
              </button>
            </div>
          )}
        </div>

        <div className="field" data-testid="cleanup-bleep">
          <span>Bleep swear words</span>
          <Chips label="Bleep swear words" value={choices.bleep} options={BLEEP} onChange={(bleep) => choose({ bleep })} />
        </div>
        {choices.bleep !== 'off' && (
          <div className="field" data-testid="cleanup-bleep-sound">
            <span>Bleep sound</span>
            <Chips label="Bleep sound" value={choices.bleepSound} options={BLEEP_SOUND} onChange={(bleepSound) => choose({ bleepSound })} />
          </div>
        )}

        {providers.length > 0 && (
          <>
            <Check testid="cleanup-ai" inputRef={aiBox} label="Also fix spelling and misheard words with AI" checked={choices.ai} onChange={(on) => choose({ ai: on })} />
            {choices.ai && (
              <label className="field">
                <span>Provider</span>
                <select className="captions-select" data-testid="cleanup-ai-provider" value={chosen?.id ?? ''} onChange={(e) => setProvider(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        <div className="row start">
          <button
            id="cleanup-run"
            className="btn small primary"
            data-testid="cleanup-run"
            aria-describedby={ai ? 'cleanup-cost-fix' : undefined}
            disabled={busy || !project.transcript?.segments.length}
            onClick={() => void tidy()}
          >
            {busy ? 'Working…' : 'Tidy captions'}
          </button>
          {busy && (
            <button className="btn small ghost" onClick={cancel}>
              Cancel
            </button>
          )}
          <LocalProgress requestId={running} onStop={cancel} />
        </div>
        {/* What Fix spelling with AI sends, where, and what it costs (smart-tools.md §11.5), part P5's. */}
        {ai && (
          <CostLine
            id="cleanup-cost"
            choice={chosen}
            full
            actions={[{ key: 'fix', label: 'Fix spelling', buttonId: 'cleanup-run', request: () => ({ task: 'cleanup', segments: store.state.transcript?.segments ?? [] }) }]}
          />
        )}
        {error && (
          <p className="captions-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint" role="status">
          {status}
        </p>
        <p className="hint">Tidy changes are listed in Review mode. The word list also helps Generate captions spell these words.</p>
      </Section>
    </div>
  )
}
