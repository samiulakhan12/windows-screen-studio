/**
 * The safety net's note (docs/design/publish-pack.md §4.8), as the Publish dialog's cards and the
 * Captions tab's suggested title and summary show it, and its words for a notice. The net never
 * changes the text: it names what to check.
 */
import { saidLinks, shownPart, shownRun, type SaidLinks } from '../../../shared/publish/check'
import { publishSegments } from '../../../shared/publish/pack'
import { projectYoutubeChapters } from '../../../shared/publish/youtube'
import type { Project } from '../../../shared/types'
import './publish.css'

/**
 * What was said in `project`, for the net: the captions of the edited video (but the links an AI
 * wrote into them), the recording's name and its chapter titles.
 */
export const projectSaid = (project: Pick<Project, 'transcript' | 'clips' | 'freezes' | 'chapters' | 'name'>): SaidLinks =>
  saidLinks(publishSegments(project), { title: project.name, chapters: projectYoutubeChapters(project).chapters.map((c) => c.title) })

/** shownCheck's, remembered for the last stretches of each `said` (a note is drawn again on every change of its text). */
const shown = new WeakMap<SaidLinks, Map<string, string>>()

/** How a noted stretch shows: the part of it that is noted (shownPart), with what is invisible in it shown (shownRun). */
export function shownCheck(run: string, said: SaidLinks): string {
  let memo = shown.get(said)
  if (!memo) shown.set(said, (memo = new Map()))
  let out = memo.get(run)
  if (out === undefined) {
    out = shownRun(shownPart(run, said))
    if (memo.size >= 64) memo.delete(memo.keys().next().value as string)
    memo.set(run, out)
  }
  return out
}

/** The net's words for `runs` (linksToCheck against `said`), for a notice; '' for none. */
export const checkText = (runs: readonly string[], said: SaidLinks): string =>
  runs.length ? `Check ${runs.length === 1 ? 'this link' : 'these links'} before you post: ${runs.map((r) => shownCheck(r, said)).join(', ')}` : ''

/**
 * The note under a text the net notes `runs` in (null for none): `id` is for the text's
 * aria-describedby, so a screen reader hears it with the text. Called as a function, not a component.
 */
export function checkNote(runs: readonly string[], said: SaidLinks, id: string): JSX.Element | null {
  if (!runs.length) return null
  return (
    <div className="publish-check" role="note" id={id} data-testid="publish-check">
      <p className="publish-check-title">{runs.length === 1 ? 'Check this link before you post:' : 'Check these links before you post:'}</p>
      <ul>
        {runs.map((run) => (
          <li key={run}>
            <code>{shownCheck(run, said)}</code>
          </li>
        ))}
      </ul>
      <p className="publish-check-why">
        {runs.length === 1
          ? "It is not in what was said, the recording's name or its chapters. Nothing was changed: post it only if you know where it goes."
          : "They are not in what was said, the recording's name or its chapters. Nothing was changed: post them only if you know where they go."}
      </p>
    </div>
  )
}
