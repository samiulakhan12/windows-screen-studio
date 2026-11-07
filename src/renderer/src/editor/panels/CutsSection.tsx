/**
 * Clip tab, no cut selected: the Cuts section (docs/design/editing-polish.md §2.1, §12): the count
 * of cuts, Every cut and its options, Smooth all cuts (disabled with its hint when every cut is
 * already smooth), and Give them the same style for cuts that have their own. Each change is one
 * store.update (a slider's drag merges into one); notices go to the transport's live region.
 */
import { cutsLine, CUT_KINDS, ownLine } from '../../../../shared/editor/cutsCopy'
import { cutCount, cutsWithoutOwnStyle, giveSameStyle, joinName, withJoinAll } from '../../../../shared/editor/joinsEdit'
import { undoHint } from '../../../../shared/editor/shortcuts'
import type { CutJoin, JoinKind, Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Section } from '../controls'
import { runSmoothAllCuts } from '../cutCommands'
import { EditorIcon } from '../EditorIcon'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'
import { JoinOptions } from './JoinOptions'
import './cuts.css'

export function CutsSection(props: { project: Project }): JSX.Element | null {
  const { store } = useEditor()
  const { notice } = useGroup()
  const keymap = useKeymap()
  const { project } = props
  const n = cutCount(project)
  if (n === 0) return null
  const all: CutJoin | null = project.joins?.all ?? null
  const every: JoinKind = all?.kind ?? 'cut'
  const own = n - cutsWithoutOwnStyle(project)
  const smooth = every === 'smooth'
  const setAll = (join: CutJoin, key?: string): void => store.update((p) => withJoinAll(p, join), key)
  return (
    <div className="cuts-section" data-testid="cuts-section">
      <Section title="Cuts">
        <p className="hint">{cutsLine(n)}</p>
        <label className="field cut-every">
          <span className="field-label">Every cut</span>
          <select data-testid="cut-every" aria-label="Every cut" value={every} onChange={(e) => setAll({ kind: e.target.value as JoinKind })}>
            {CUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {joinName(k)}
              </option>
            ))}
          </select>
        </label>
        {all && <JoinOptions join={all} brand={project.brand?.colors ?? []} name="cut-every" onChange={setAll} />}
        <button
          className="btn"
          data-testid="cut-smooth-all"
          disabled={smooth}
          title={smooth ? 'Every cut is already smooth' : 'Crossfades on the screen, punch-ins on the camera'}
          onClick={() => runSmoothAllCuts(store, notice, undoHint(keymap))}
        >
          <EditorIcon name="sparkle" size={16} /> Smooth all cuts
        </button>
        {smooth && <p className="hint">Every cut is already smooth</p>}
        {own > 0 && (
          <>
            <p className="hint">{ownLine(own)}</p>
            <button
              className="btn ghost"
              data-testid="cut-same-style"
              onClick={() => {
                store.update(giveSameStyle)
                notice(`Every cut has the same style${undoHint(keymap)}`)
              }}
            >
              Give them the same style
            </button>
          </>
        )}
      </Section>
    </div>
  )
}
