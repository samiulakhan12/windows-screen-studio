/**
 * Clip tab, a cut selected: the Cut style section (docs/design/editing-polish.md §2.1, §12): "Cut 5
 * of 37" with Previous cut, Next cut and Play this cut; the radio group of the cut's own style (or
 * the same as every cut) with the chosen style's options; what Smooth gives this cut; the notes of
 * Calm motion and the flash rule. Trimmed starts and ends have none.
 */
import { CALM_NOTE, cutOf, CUT_KINDS, FLASH_NOTE, hereLine } from '../../../../shared/editor/cutsCopy'
import { cutAt, cutNumber, joinName, smoothHere, withCutJoin } from '../../../../shared/editor/joinsEdit'
import { resolvedJoin } from '../../../../shared/render/joins'
import type { CutJoin, JoinKind, Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { useGroup } from '../groupContext'
import { JoinOptions, keepArrows } from './JoinOptions'
import './cuts.css'

export function CutStyleSection(props: { project: Project; gap: { start: number; end: number } }): JSX.Element | null {
  const { store } = useEditor()
  const { command } = useGroup()
  const { project, gap } = props
  const cut = cutAt(project, gap.end)
  const number = cutNumber(project, gap.end)
  if (!cut || !number) return null
  const clip = cut.clip
  const own: CutJoin | null = project.joins?.cuts?.find((c) => c.clip === clip) ?? null
  const every = project.joins?.all ?? null
  const shown: JoinKind = (own ?? every)?.kind ?? 'cut'
  const choice: 'same' | JoinKind = own ? own.kind : 'same'
  const set = (join: CutJoin | null, key?: string): void => store.update((p) => withCutJoin(p, clip, join), key)
  const drawn = resolvedJoin(project, cut.index)
  const note = shown === 'slide' && project.effects.calm ? CALM_NOTE : shown === 'dip' && drawn?.kind === 'crossfade' ? FLASH_NOTE : null
  const ownJoin = own ? stripClip(own) : null
  return (
    <div className="cut-style-section" data-testid="cut-style-section">
      <div className="cut-nav">
        <span className="cut-number" data-testid="cut-number">
          {cutOf(number.n, number.of)}
        </span>
        <button className="btn small" data-testid="cut-prev" disabled={number.n <= 1} onClick={() => command('previousCut')}>
          Previous cut
        </button>
        <button className="btn small" data-testid="cut-next" disabled={number.n >= number.of} onClick={() => command('nextCut')}>
          Next cut
        </button>
        <button className="btn small" data-testid="cut-play" onClick={() => command('playCut')}>
          Play this cut
        </button>
      </div>
      <span className="field-label" aria-hidden="true">
        Cut style
      </span>
      <div className="cut-radios cut-style" role="radiogroup" aria-label="Cut style" data-testid="cut-style" onKeyDown={keepArrows}>
        <label className={`chip ${choice === 'same' ? 'active' : ''}`} data-kind="same">
          <input type="radio" name="cut-style" checked={choice === 'same'} onChange={() => set(null)} />
          Same as every cut ({joinName(every?.kind ?? 'cut')})
        </label>
        {CUT_KINDS.map((k) => (
          <label key={k} className={`chip ${choice === k ? 'active' : ''}`} data-kind={k}>
            <input type="radio" name="cut-style" checked={choice === k} onChange={() => set({ kind: k })} />
            {joinName(k)}
          </label>
        ))}
      </div>
      {ownJoin && <JoinOptions join={ownJoin} brand={project.brand?.colors ?? []} name="cut-own" onChange={set} />}
      {shown === 'smooth' && (
        <p className="hint" data-testid="cut-here">
          {hereLine(smoothHere(project, cut.index))}
        </p>
      )}
      {note && (
        <p className="hint" data-testid="cut-note">
          {note}
        </p>
      )}
    </div>
  )
}

/** A cut's own style without its clip id (the join its options edit). */
function stripClip(style: CutJoin & { clip?: string }): CutJoin {
  const { clip: _clip, ...join } = style
  return join
}
