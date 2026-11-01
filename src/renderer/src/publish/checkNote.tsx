/**
 * The link check's note and confirm (docs/design/publish-pack.md §4.8), as the Publish dialog's cards
 * and the Captions tab's suggested title, summary and chapters show them. The check never changes the
 * text: the note names what to check, and the confirm asks before noted text is copied or used.
 */
import { useEffect, useRef } from 'react'
import { inContext, saidLinks, shownRun, type Noted, type Said } from '../../../shared/publish/check'
import { publishSegments } from '../../../shared/publish/pack'
import { projectYoutubeChapters } from '../../../shared/publish/youtube'
import type { Project } from '../../../shared/types'
import { useModalFocus } from '../editor/modalFocus'
import './publish.css'

/**
 * What was said in `project`, for the check: the captions of the edited video (but those an AI wrote
 * a link into), the recording's name and its chapter titles.
 */
export const projectSaid = (project: Pick<Project, 'transcript' | 'clips' | 'freezes' | 'chapters' | 'name'>): Said =>
  saidLinks(publishSegments(project), { title: project.name, chapters: projectYoutubeChapters(project).chapters.map((c) => c.title) })

/** Why a piece is listed, for one piece or several. */
const why = (count: number): string =>
  count === 1
    ? "It has a link, address or file name that is not in what was said, the recording's name or its chapters. Nothing was changed: post it only if you know where it goes."
    : "Each has a link, address or file name that is not in what was said, the recording's name or its chapters. Nothing was changed: post them only if you know where they go."

/**
 * The note under a text the check notes `pieces` in (null for none). `id` is for the aria-describedby
 * of the text field or the buttons it is about, so a screen reader hears it with them. Called as a
 * function, not a component.
 */
export function checkNote(pieces: readonly string[], id: string): JSX.Element | null {
  if (!pieces.length) return null
  return (
    <div className="publish-check" role="note" id={id} data-testid="publish-check">
      <p className="publish-check-title">{pieces.length === 1 ? 'Check this before you post:' : 'Check these before you post:'}</p>
      <ul>
        {pieces.map((piece) => (
          <li key={piece}>
            <code>{shownRun(piece)}</code>
          </li>
        ))}
      </ul>
      <p className="publish-check-why">{why(pieces.length)}</p>
    </div>
  )
}

/** A confirm the check asks for: what is about to leave the app or become the recording's data. */
export interface NotedAsk {
  /** What it is about ("LinkedIn post", "Suggested title"). */
  what: string
  /** The action, said on its button. */
  action: 'Copy anyway' | 'Use anyway'
  /** The text that would be copied or used, and its noted pieces (check.ts notedPieces). */
  text: string
  pieces: readonly Noted[]
  /** Copies or uses it. */
  run: () => void
}

/**
 * Asks before noted text is copied or used (§4.8): one dialog per action, listing each noted piece
 * exactly (invisible characters shown by their code) with a few characters around it. The focus starts
 * on Cancel, Esc cancels, Tab stays inside, and the focus then goes back to the button that asked.
 */
export function NotedConfirm({ ask, onClose }: { ask: NotedAsk; onClose: () => void }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useModalFocus(boxRef, onClose)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  return (
    <div className="overlay modal-backdrop publish-confirm-scrim">
      <div className="publish-confirm" role="alertdialog" aria-modal="true" aria-labelledby="publish-confirm-title" aria-describedby="publish-confirm-why" ref={boxRef} data-testid="publish-confirm">
        <h2 id="publish-confirm-title">
          {ask.what}: check {ask.pieces.length === 1 ? 'this' : 'these'} before you {ask.action === 'Copy anyway' ? 'copy it' : 'use it'}
        </h2>
        <p id="publish-confirm-why">{why(ask.pieces.length)}</p>
        <ul className="publish-confirm-list">
          {ask.pieces.map((p) => {
            const shown = inContext(ask.text, p)
            return (
              <li key={`${p.start}:${p.end}`}>
                <code>
                  <span className="publish-confirm-context">{shown.before}</span>
                  <mark>{shown.piece}</mark>
                  <span className="publish-confirm-context">{shown.after}</span>
                </code>
              </li>
            )
          })}
        </ul>
        <div className="publish-confirm-actions">
          <button ref={cancelRef} className="btn primary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => {
              onClose()
              ask.run()
            }}
          >
            {ask.action}
          </button>
        </div>
      </div>
    </div>
  )
}
