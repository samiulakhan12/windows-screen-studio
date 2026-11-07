/**
 * Text tab, after Chapters: Progress bar on the video and its settings (docs/design/editing-polish.md
 * §2.4, §12): Place, Look, Chapter names (with two chapters or more), Colour and Show only when a
 * chapter starts. Each change is one update.
 */
import { useEffect, useRef } from 'react'
import { withChapterBar } from '../../../../shared/render/chapterBar'
import type { ChapterBar, Project } from '../../../../shared/types'
import { useEditor } from '../context'
import { Section } from '../controls'
import { RadioChips, Switch } from './RadioChips'
import './magnifier.css'

export const BAR_HINT = 'A thin bar that fills as the video plays, split at your chapters when there are any.'
export const FEW_CHAPTERS = 'Add chapters to split the bar. With one or none it is a plain progress bar.'

let focusWanted = false
/** The Effects tab's "Progress bar…" asks the section to take the focus once it shows. */
export function requestProgressBarFocus(): void {
  focusWanted = true
}

export function ChapterBarSection(props: { project: Project }): JSX.Element {
  const { project } = props
  const { store } = useEditor()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusWanted) return
    focusWanted = false
    const input = box.current?.querySelector<HTMLInputElement>('[data-testid="progress-bar-toggle"]')
    input?.scrollIntoView?.({ block: 'center' })
    input?.focus()
  }, [])
  const bar = project.chapterBar
  const on = bar?.show === true
  const set = (patch: Partial<ChapterBar>, key?: string): void => store.update((p) => withChapterBar(p, patch), key)
  const chapters = project.chapters?.length ?? 0
  return (
    <Section title="Progress bar">
      <div className="progress-bar-section" ref={box}>
        <Switch id="progress-bar-toggle" label="Progress bar on the video" checked={on} onChange={(show) => set({ show })} hint={BAR_HINT} />
        {on && bar && (
          <>
            <RadioChips<ChapterBar['place']>
              id="progress-bar-place"
              label="Place"
              value={bar.place}
              onChange={(place) => set({ place })}
              options={[
                { value: 'auto', label: 'Auto', title: 'At the top, or at the bottom when the captions sit in the top half' },
                { value: 'top', label: 'Top' },
                { value: 'bottom', label: 'Bottom' }
              ]}
            />
            <RadioChips<ChapterBar['style']>
              id="progress-bar-look"
              label="Look"
              value={bar.style}
              onChange={(style) => set({ style })}
              options={[
                { value: 'float', label: 'Floating', title: 'Rounded, inset from the edges' },
                { value: 'edge', label: 'Edge', title: 'Full width, flush with the edge' }
              ]}
            />
            {chapters >= 2 ? (
              <RadioChips<ChapterBar['labels']>
                id="progress-bar-labels"
                label="Chapter names"
                value={bar.labels}
                onChange={(labels) => set({ labels })}
                options={[
                  { value: 'current', label: 'Current chapter' },
                  { value: 'all', label: 'All chapters' },
                  { value: 'none', label: 'None' }
                ]}
              />
            ) : (
              <p className="hint">{FEW_CHAPTERS}</p>
            )}
            <BarColours project={project} bar={bar} onChange={(color, key) => set({ color }, key)} />
            <Switch id="progress-bar-only" label="Show only when a chapter starts" checked={bar.onlyAtChapters === true} onChange={(onlyAtChapters) => set({ onlyAtChapters })} />
          </>
        )}
      </div>
    </Section>
  )
}

/** The bar's colour (§2.4): the brand colours first, then white (the default without a brand), and any colour. */
function BarColours({ project, bar, onChange }: { project: Project; bar: ChapterBar; onChange: (color: string, key?: string) => void }): JSX.Element {
  const brand = (project.brand?.colors ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map((c) => c.toLowerCase())
  const swatches = [...brand.map((c, i) => ({ color: c, name: `Brand colour ${i + 1}, ${c}` })), ...(brand.includes('#ffffff') ? [] : [{ color: '#ffffff', name: 'White' }])]
  const value = (bar.color ?? brand[0] ?? '#ffffff').toLowerCase()
  const custom = !swatches.some((s) => s.color === value)
  return (
    <div className="field">
      <span className="field-label" id="progress-bar-colour-label">
        Colour
      </span>
      <div className="shape-colors progress-bar-colours" role="radiogroup" aria-labelledby="progress-bar-colour-label" data-testid="progress-bar-colour">
        {swatches.map((s) => (
          <button
            key={s.color}
            type="button"
            role="radio"
            aria-checked={value === s.color}
            aria-label={s.name}
            title={s.name}
            className={`shape-color ${value === s.color ? 'active' : ''}`}
            style={{ background: s.color }}
            onClick={() => onChange(s.color)}
          />
        ))}
        <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Other colour" style={custom ? { background: value } : undefined}>
          <input type="color" aria-label="Other colour" value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), 'progress-bar-colour')} />
        </label>
      </div>
    </div>
  )
}
