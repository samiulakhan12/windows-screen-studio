/**
 * Make a shorter version (docs/design/smart-tools.md §2.4, §8.6): a dialog with the length (30,
 * 60 or 90 s; a length at or above the video's own disabled with the reason), Focus on, Shape and
 * Captions, a line saying what it keeps, and Make the copy. The copy keeps the most useful
 * sentences in order with smooth cuts; Review in the copy lists each cut, so any sentence can be
 * brought back. This video never changes.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DuplicateProgress, SceneScan } from '../../../shared/api/projects'
import { clipSentences } from '../../../shared/clips/sentences'
import { planShort, shortCopy, SHORT_LENGTHS, type ShortLength, type ShortPlan } from '../../../shared/clips/short60'
import { planOf, videoDuration } from '../../../shared/engine/freeze'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import type { CursorTrack, Project } from '../../../shared/types'
import { useEditor } from '../editor/context'
import { useGroup } from '../editor/groupContext'
import { useModalFocus } from '../editor/modalFocus'
import './clips.css'
import { ClipCopyError, CLIPS_WORDS, ipcMessage, makeClipCopies, readScreen, settledFlush, textMeasure } from './clipsRun'
import { ShapeField, useClipShapes, useShortClipsPref } from './ShortClipsPanel'

/** Focus on is read this long after the last key. */
const FOCUS_WAIT_MS = 300
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** "This video is already 52 s": why a length at or above the video's own is not offered. */
export const alreadyText = (L: number): string => `This video is already ${Math.floor(L + 1e-6)} s`

/** The line under the choices (§2.4): what the shorter version keeps, or why there is none. */
export function shortLine(plan: ShortPlan | null, L: number, smooth: boolean): string {
  if (!plan) return CLIPS_WORDS.shortNeedsCaptions
  if (!plan.ok) return plan.reason === 'no-captions' ? CLIPS_WORDS.shortNeedsCaptions : plan.reason === 'too-short' ? alreadyText(L) : CLIPS_WORDS.tooLittle
  return `Keeps ${plural(plan.sentences, 'sentence')}, ${plan.seconds.toFixed(1)} s${smooth ? ', smooth cuts' : ''}`
}

export function ShortVersionDialog(props: { project: Project; cursor: CursorTrack; vw: number; vh: number; onClose(): void; onOpen(id: string): void }): JSX.Element {
  const { project, cursor, vw, vh, onClose, onOpen } = props
  const { store } = useEditor()
  const group = useGroup()
  const ids = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  const [pref, setPref] = useShortClipsPref()
  const shapes = useClipShapes(project, vw, vh, pref.shape)
  const L = project.clips?.length ? videoDuration(project.clips, planOf(project)) : 0
  const hasCaptions = !!project.transcript?.segments.some((s) => s.text.trim())
  const offered = SHORT_LENGTHS.filter((s) => s < L - 1e-6)
  const [length, setLength] = useState<ShortLength | null>(() => (offered.includes(60) ? 60 : (offered[offered.length - 1] ?? null)))
  const [focus, setFocus] = useState('')
  const [focusUsed, setFocusUsed] = useState('')
  useEffect(() => {
    if (focus === focusUsed) return
    const timer = setTimeout(() => setFocusUsed(focus), FOCUS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [focus, focusUsed])

  // The screen, for the sentences said near a change of screen (read once per recording).
  const [scan, setScan] = useState<SceneScan | null>(null)
  const [reading, setReading] = useState(false)
  const live = useRef(true)
  const readCtrl = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!hasCaptions || offered.length === 0) return
    const ctrl = new AbortController()
    readCtrl.current = ctrl
    setReading(true)
    readScreen(project, ctrl.signal, () => undefined)
      .then((s) => live.current && setScan(s))
      .catch(() => undefined)
      .finally(() => live.current && setReading(false))
    return () => ctrl.abort()
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const track = useMemo(() => effectiveTrack(cursor, project), [cursor, project.inputEdits, project.capture, project.width, project.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useMemo((): ShortPlan | null => {
    if (!hasCaptions) return null
    if (length === null) return { ok: false, reason: 'too-short' }
    return planShort(project, clipSentences(project, { track, scan, focus: focusUsed }), { seconds: length, focus: focusUsed })
  }, [hasCaptions, length, project, track, scan, focusUsed])
  const smooth = !project.joins?.all

  const [making, setMaking] = useState<DuplicateProgress | 'start' | null>(null)
  const [made, setMade] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      live.current = false
      controller.current?.abort()
      readCtrl.current?.abort()
    },
    []
  )
  // Esc stops a copy being made (the half-made copy is removed); otherwise it closes, as Cancel does.
  useModalFocus(boxRef, () => (controller.current ? controller.current.abort() : onClose()))

  const make = async (): Promise<void> => {
    if (controller.current || length === null) return
    const now = store.state
    // The plan again on the project as it is now (an edit since the line was shown).
    const fresh = planShort(now, clipSentences(now, { track: effectiveTrack(cursor, now), scan, focus: focusUsed }), { seconds: length, focus: focusUsed })
    if (!fresh.ok) return setError(shortLine(fresh, L, smooth))
    const ctrl = new AbortController()
    controller.current = ctrl
    setError(null)
    setMaking('start')
    try {
      const copy = shortCopy(now, fresh, { shape: shapes.shape, captions: pref.captions, measure: textMeasure() })
      const out = await makeClipCopies([copy], { sourceId: now.id, flush: settledFlush(store), signal: ctrl.signal, onProgress: (_i, _n, p) => live.current && p && setMaking(p) })
      if (live.current && out.made[0]) setMade(out.made[0])
    } catch (err) {
      if (live.current && !ctrl.signal.aborted) setError(err instanceof ClipCopyError ? err.message : `Could not make the copy: ${ipcMessage(err)}`)
    } finally {
      if (controller.current === ctrl) controller.current = null
      if (live.current) setMaking(null)
    }
  }

  const titleId = `${ids}-title`
  const lineId = `${ids}-line`
  const total = making && making !== 'start' && making.total > 0 ? making.total : 0
  const share = total > 0 && making && making !== 'start' ? Math.min(1, Math.max(0, making.done / total)) : 0
  const name = project.name.trim() || 'Untitled recording'
  return (
    <div className="overlay modal-backdrop">
      <div className="modal short-version" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={lineId} ref={boxRef} tabIndex={-1} data-testid="short-version">
        <header className="modal-head">
          <h2 id={titleId}>Make a shorter version</h2>
        </header>
        {made ? (
          <>
            <p className="short-line" id={lineId} role="status" data-testid="short-made">
              Made “{made.name}”. Your original “{name}” is unchanged. Review in the copy lists each cut, so you can bring any sentence back.
            </p>
            <footer className="modal-foot">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn primary" autoFocus onClick={() => onOpen(made.id)}>
                Open the copy
              </button>
            </footer>
          </>
        ) : (
          <>
            <fieldset className="clips-field">
              <legend>Length</legend>
              <div className="clips-choices">
                {SHORT_LENGTHS.map((s) => {
                  const ok = offered.includes(s)
                  return (
                    <label key={s}>
                      <input type="radio" name={`${ids}-length`} value={s} checked={length === s} disabled={!ok || making !== null} onChange={() => setLength(s)} aria-describedby={ok ? undefined : `${ids}-why-${s}`} />
                      {s} s
                      {!ok && (
                        <span className="clips-why-not" id={`${ids}-why-${s}`}>
                          ({alreadyText(L)})
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <div className="clips-field">
              <label className="clips-label" htmlFor={`${ids}-focus`}>
                Focus on (optional)
              </label>
              <input id={`${ids}-focus`} type="text" placeholder="billing, export" value={focus} onChange={(e) => setFocus(e.target.value)} disabled={making !== null} data-testid="short-focus" />
            </div>
            <ShapeField name={`${ids}-shape`} shapes={shapes} onPick={(shape) => setPref({ ...pref, shape })} />
            {hasCaptions && (
              <label className="clips-choices clips-field">
                <input type="checkbox" checked={pref.captions} onChange={(e) => setPref({ ...pref, captions: e.target.checked })} disabled={making !== null} data-testid="short-captions" />
                Captions
              </label>
            )}
            <p className="short-line" id={lineId} data-testid="short-line">
              {shortLine(plan, L, smooth)}
              {reading ? ` ${CLIPS_WORDS.looking}` : ''}
            </p>
            {making && (
              <div className="clips-progress" role="progressbar" aria-label="Copied" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                <div style={{ width: `${share * 100}%` }} />
              </div>
            )}
            {error && (
              <p className="clips-error" role="alert" data-testid="short-error">
                {error}
              </p>
            )}
            <footer className="modal-foot">
              {!hasCaptions && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onClose()
                    group.command('generateCaptions')
                  }}
                >
                  Make captions
                </button>
              )}
              <button type="button" className="btn" onClick={() => (controller.current ? controller.current.abort() : onClose())} data-testid="short-cancel">
                {making ? 'Stop' : 'Cancel'}
              </button>
              <button type="button" className="btn primary" autoFocus={hasCaptions} disabled={!plan?.ok || making !== null} onClick={() => void make()} data-testid="short-make">
                Make the copy
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
