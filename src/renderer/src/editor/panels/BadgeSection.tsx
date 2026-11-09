/**
 * A selected step badge's options (docs/design/editing-polish.md §2.3, §7.3, §12): Number
 * (Automatic or your own text, checked by graphemes as it is typed), Count with (Bangla digits
 * always offered), Restart at each chapter, Start from, Colour (the brand's colours first) and
 * Follows the zoom. Each change is one update.
 */
import { useState } from 'react'
import { badgeTextError, countWithOptions, setFollowsZoom, withBadge, withBadgesByChapter } from '../../../../shared/editor/calloutsEdit'
import { SHAPE_COLORS } from '../../../../shared/editor/shapes'
import { badgesByChapterOf, calloutOf } from '../../../../shared/render/calloutData'
import { BADGE_FILL, badgeLabels } from '../../../../shared/render/callouts'
import { outputChapters } from '../../../../shared/render/chapters'
import { planOf } from '../../../../shared/engine/freeze'
import type { Annotation, Project } from '../../../../shared/types'
import { pausedScene, pinUnder, shownAt } from '../calloutView'
import { useEditor } from '../context'
import type { Selection } from '../selection'
import { RadioRow, SwatchRow, SwitchRow } from './calloutControls'
import { useTabOf } from './CalloutSection'
import './callouts.css'

/** The badge colours: the brand kit's first, then the default blue and the shape palette (§2.3). */
export function badgeSwatches(project: Pick<Project, 'brand'>): { color: string; name: string }[] {
  const out: { color: string; name: string }[] = []
  ;(project.brand?.colors ?? []).forEach((c, i) => out.push({ color: c.toLowerCase(), name: `Brand colour ${i + 1}, ${c.toLowerCase()}` }))
  for (const c of [BADGE_FILL, ...SHAPE_COLORS]) if (!out.some((o) => o.color === c)) out.push({ color: c, name: c === BADGE_FILL ? `Blue, ${c}` : c })
  return out
}

/** How many chapters the video has (the restart switch is offered from two). */
const chapterCount = (p: Project): number => (p.clips.length ? outputChapters(p.chapters ?? [], p.clips, planOf(p)).length : 0)

export function BadgeSection(props: { project: Project; selection: Selection }): JSX.Element | null {
  const { store, player } = useEditor()
  const [ref, tab] = useTabOf()
  const sel = props.selection
  const a = sel?.kind === 'annotation' ? props.project.annotations.find((x) => x.id === sel.id) : undefined
  if (!a || a.style !== 'badge') return null
  return (
    <div ref={ref} className="callout-mount">
      {(tab === null || tab === 'text') && <Badge project={props.project} badge={a} update={(fn, key) => store.update(fn, key)} player={player} />}
    </div>
  )
}

function Badge({
  project,
  badge,
  update,
  player
}: {
  project: Project
  badge: Annotation
  update: (fn: (p: Project) => Project, key?: string) => void
  player: ReturnType<typeof useEditor>['player']
}): JSX.Element {
  const c = calloutOf(badge)
  const id = badge.id
  const auto = c.number === 'auto'
  const label = badgeLabels(project).get(id)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? c.text
  const error = badgeTextError(text)
  const chapters = chapterCount(project)
  const restart = badgesByChapterOf(project.effects, chapters)
  const counts = countWithOptions(project)
  return (
    <section className="insp-section callout-section" data-testid="badge-section">
      <h3>
        <span>Step badge</span>
      </h3>
      <RadioRow
        id="badge-number"
        label="Number"
        value={auto ? 'auto' : 'text'}
        options={[
          { value: 'auto', label: label ? `Automatic (${label})` : 'Automatic' },
          { value: 'text', label: 'Your own text' }
        ]}
        onChange={(v) => update((p) => withBadge(p, id, { number: v }))}
      />
      {!auto && (
        <label className="field callout-field">
          <span>Badge text</span>
          <input
            type="text"
            data-testid="badge-text"
            value={text}
            aria-invalid={!!error}
            aria-describedby={error ? 'badge-text-error' : undefined}
            onChange={(e) => {
              const v = e.target.value
              setDraft(v)
              // Written while it fits; more than 3 letters (as a reader counts them) shows the error instead.
              if (!badgeTextError(v)) update((p) => withBadge(p, id, { text: v }), `badge-text:${id}`)
            }}
            onBlur={() => setDraft(null)}
          />
          {error && (
            <span className="callout-error" id="badge-text-error" data-testid="badge-text-error" role="alert">
              {error}
            </span>
          )}
        </label>
      )}
      {auto && (
        <>
          <RadioRow
            id="badge-count-with"
            label="Count with"
            value={c.numbering}
            options={counts.map((o) => ({
              value: o.value,
              label: o.value === 'bn' ? `Bangla digits, ${o.sample}` : o.lang ? `${o.label}, ${o.sample}` : o.label,
              content: o.lang ? (
                <>
                  <span lang={o.lang}>{o.sample}</span> ({o.label})
                </>
              ) : undefined
            }))}
            onChange={(v) => update((p) => withBadge(p, id, { numbering: v }))}
          />
          <SwitchRow
            id="badge-restart"
            label="Restart at each chapter"
            checked={restart && chapters >= 2}
            disabled={chapters < 2}
            hint={chapters < 2 ? 'Add two chapters or more to count again in each.' : undefined}
            onChange={(on) => update((p) => withBadgesByChapter(p, on))}
          />
          <label className="field callout-field">
            <span>Start from</span>
            <input
              type="number"
              data-testid="badge-start-from"
              min={1}
              max={999}
              step={1}
              value={c.startAt ?? ''}
              placeholder="Counts on"
              onChange={(e) => {
                const v = e.target.value.trim()
                const n = Number(v)
                if (v === '') update((p) => withBadge(p, id, { startAt: null }), `badge-start:${id}`)
                else if (Number.isInteger(n) && n >= 1 && n <= 999) update((p) => withBadge(p, id, { startAt: n }), `badge-start:${id}`)
              }}
            />
          </label>
        </>
      )}
      <SwatchRow id="badge-colour" label="Colour" value={c.color ?? BADGE_FILL} swatches={badgeSwatches(project)} onChange={(color) => update((p) => withBadge(p, id, { color }))} />
      <SwitchRow
        id="badge-follows-zoom"
        label="Follows the zoom"
        checked={!!c.pin}
        hint={c.pin ? 'Stays on its spot in the recording while the camera zooms and pans.' : 'Stays at one place in the frame.'}
        onChange={(on) => {
          const scene = pausedScene(player)
          if (!scene) return
          // Where it shows at its start: the point of the recording there (kept on the picture, as off it the badge is not drawn), or that place in the frame.
          const pin = c.pin ?? pinUnder(scene, badge.start, { x: badge.x, y: badge.y })
          const m = { pin, shownAt: shownAt(scene, badge.start, pin) }
          update((p) => setFollowsZoom(p, id, on, m))
        }}
      />
    </section>
  )
}
