/**
 * Step badges and speech bubbles in the Text tab (docs/design/editing-polish.md §2.3, §12): the
 * buttons that add them at the playhead (the same commands as the palette's), and a selected
 * bubble's Colour (White, Dark, the brand's colours) and Tail (Pointing or None). Each change is
 * one update.
 */
import { setBubbleTail, withBubbleColor } from '../../../../shared/editor/calloutsEdit'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { calloutOf } from '../../../../shared/render/calloutData'
import { BUBBLE_BODY, BUBBLE_FILL } from '../../../../shared/render/callouts'
import type { Annotation, Project } from '../../../../shared/types'
import { calloutMapping, pausedScene, pinUnder } from '../calloutView'
import { useEditor } from '../context'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'
import type { Selection } from '../selection'
import { RadioRow, SwatchRow } from './calloutControls'
import { useTabOf } from './CalloutSection'
import './callouts.css'

/** A bubble's colours: White (dark text, a thin outline), Dark, then the brand's (§2.3). */
export function bubbleSwatches(project: Pick<Project, 'brand'>): { color: string; name: string }[] {
  const out = [
    { color: BUBBLE_FILL, name: 'White' },
    { color: '#1d1d24', name: 'Dark' }
  ]
  ;(project.brand?.colors ?? []).forEach((c, i) => {
    if (!out.some((o) => o.color === c.toLowerCase())) out.push({ color: c.toLowerCase(), name: `Brand colour ${i + 1}, ${c.toLowerCase()}` })
  })
  return out
}

export function BubbleSection(props: { project: Project; selection: Selection }): JSX.Element | null {
  const { store, player } = useEditor()
  const group = useGroup()
  const keymap = useKeymap()
  const [ref, tab] = useTabOf()
  const sel = props.selection
  const a = sel?.kind === 'annotation' ? props.project.annotations.find((x) => x.id === sel.id) : undefined
  const bubble = a && a.style === 'bubble' ? a : null
  if (tab !== null && tab !== 'text') return <div ref={ref} className="callout-mount" />
  return (
    <div ref={ref} className="callout-mount">
      {bubble && <Bubble project={props.project} bubble={bubble} update={(fn) => store.update(fn)} player={player} />}
      <section className="insp-section">
        <h3>
          <span>Step badges and speech bubbles</span>
        </h3>
        <div className="callout-add" role="group" aria-label="Add a step badge or a speech bubble">
          <button type="button" className="btn" data-testid="add-step-badge" title={withShortcut('A numbered circle beside the cursor: 1, 2, 3', keymap.addStepBadge)} onClick={() => group.command('addStepBadge')}>
            Add step badge
          </button>
          <button type="button" className="btn" data-testid="add-speech-bubble" title={withShortcut('A rounded box with a tail pointing at the cursor', keymap.addSpeechBubble)} onClick={() => group.command('addSpeechBubble')}>
            Add speech bubble
          </button>
        </div>
        <p className="hint">They stay on their spot in the recording while the camera zooms, as shapes do.</p>
      </section>
    </div>
  )
}

function Bubble({ project, bubble, update, player }: { project: Project; bubble: Annotation; update: (fn: (p: Project) => Project) => void; player: ReturnType<typeof useEditor>['player'] }): JSX.Element {
  const c = calloutOf(bubble)
  const id = bubble.id
  return (
    <section className="insp-section callout-section" data-testid="bubble-section">
      <h3>
        <span>Speech bubble</span>
      </h3>
      <SwatchRow id="bubble-colour" label="Colour" value={c.color ?? BUBBLE_FILL} swatches={bubbleSwatches(project)} onChange={(color) => update((p) => withBubbleColor(p, id, color === BUBBLE_FILL ? null : color))} />
      <RadioRow
        id="bubble-tail"
        label="Tail"
        value={c.pin ? 'pointing' : 'none'}
        options={[
          { value: 'pointing', label: 'Pointing' },
          { value: 'none', label: 'None' }
        ]}
        onChange={(v) => {
          const scene = pausedScene(player)
          if (!scene) return
          if (v === 'none' && c.pin) {
            // The body stays where it shows at the bubble's start.
            const m = calloutMapping(scene, bubble.start)
            const tip = m.view.toOut(c.pin.x, c.pin.y)
            const body = c.body ?? BUBBLE_BODY
            const S = Math.min(m.view.w, m.view.h)
            update((p) => setBubbleTail(p, id, null, { x: (tip.x + body.dx * S) / m.view.w, y: (tip.y + body.dy * S) / m.view.h }))
          } else if (v === 'pointing' && !c.pin) {
            // A tail pointing down from the body, at what shows just below it: kept on the picture (off it, no tail is drawn), the body above it.
            const m = calloutMapping(scene, bubble.start)
            const S = Math.min(m.view.w, m.view.h)
            const body = { dx: 0, dy: -0.12 }
            const pin = pinUnder(scene, bubble.start, { x: bubble.x, y: bubble.y - (body.dy * S) / m.view.h })
            const tip = m.view.toOut(pin.x, pin.y)
            update((p) => setBubbleTail(p, id, { pin, body }, { x: tip.x / m.view.w, y: (tip.y + body.dy * S) / m.view.h }))
          }
        }}
      />
    </section>
  )
}
