/**
 * Inspector › Graphics (docs/design/captions-studio.md §2.11, §10.5): Add pop-ups from captions,
 * the Add menu and the list of graphics; or, with a graphic selected, its fields. Every change is
 * one undo step (typing: one per pause, merge key `graphic-text:<id>`); the list and the timeline
 * row lead to the same fields, so nothing needs a mouse.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AiProviderInfo } from '../../../../shared/api/ai'
import { captionLanguage } from '../../../../shared/captions/captionTracks'
import { emojiEntry, EMOJI_LIST } from '../../../../shared/captions/emojiList'
import { DEFAULT_GREAT_OPTIONS, readGreatOptions, resolveGreatOptions, type GreatOptions } from '../../../../shared/captions/great'
import { planGraphics } from '../../../../shared/captions/graphicRules'
import { GRAPHIC_TEXT_MAX, LIST_ITEM_MAX } from '../../../../shared/captions/studioData'
import { STUDIO_BASE } from '../../../../shared/captions/studioPresets'
import { displayTime } from '../../../../shared/editor/clips'
import { editorFrame } from '../../../../shared/editor/followEdit'
import { captionAccentColor, captionTextColor, GRAPHIC_COLORS, GRAPHIC_NAMES, GRAPHIC_SIZE, GRAPHIC_SOUNDS, ITEM_MOTIONS } from '../../../../shared/editor/groupEdit'
import { deleteGraphics, placeGraphicAt, updateGraphic } from '../../../../shared/editor/graphicsEdit'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { formatTime } from '../../../../shared/engine/project'
import type { CounterGraphic, Graphic, KeywordGraphic, ListGraphic, Project } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import { lastInputWasKey } from '../focus'
import { addGraphicAt, showGraphic } from '../graphicItems'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'
import { useListSelect } from '../listSelect'
import { LookButtons } from '../LookButtons'
import type { Selection } from '../selection'
import { FontPicker } from './FontPicker'
import './graphics.css'

/** What a row, a block and the Selection view call a graphic: “Auto Save”, 🔥 fire, $1.2M, List: 3 steps. */
export function graphicLabel(g: Graphic): string {
  switch (g.kind) {
    case 'keyword':
      return `“${g.text}”`
    case 'emoji': {
      const e = emojiEntry(g.emoji)
      return e ? `${e.text} ${e.name}` : 'Emoji'
    }
    case 'counter':
      return `${g.prefix}${g.to.toFixed(g.decimals)}${g.suffix}${g.label ? ` ${g.label}` : ''}`
    case 'list':
      return `List: ${g.title?.trim() || `${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}`}`
  }
}

/** The kinds the generator makes, as chips (§2.11), in the order of Make my captions great's options. */
export type GenerateKind = 'keywords' | 'emoji' | 'counters' | 'lists' | 'speakers' | 'chapters' | 'quotes'
const GENERATE_CHIPS: readonly { id: GenerateKind; label: string }[] = [
  { id: 'keywords', label: 'Keywords' },
  { id: 'emoji', label: 'Emoji' },
  { id: 'counters', label: 'Counters' },
  { id: 'lists', label: 'Lists' },
  { id: 'speakers', label: 'Speakers' },
  { id: 'chapters', label: 'Chapters' },
  { id: 'quotes', label: 'Quotes' }
]

const ADD_KINDS: readonly { kind: Graphic['kind']; label: string }[] = [
  { kind: 'keyword', label: 'Keyword pop-up' },
  { kind: 'emoji', label: 'Emoji' },
  { kind: 'counter', label: 'Counter' },
  { kind: 'list', label: 'List card' }
]

/** Items a list card holds at most (§2.11). */
export const MAX_LIST_ITEMS = 7

/**
 * The graphic the Add menu just added with the keyboard: its first field takes the focus when its
 * fields show, as the menu item that had it goes (the focus would fall to the page).
 */
let addedByKey: string | null = null

/** What a run made: graphics and automatic title cards (lower thirds, chapter titles, quote cards) that were not there before. */
export function madeCount(before: Project, after: Project): number {
  const had = new Set([...(before.graphics ?? []).map((g) => g.id), ...(before.titles ?? []).map((c) => c.id)])
  return [...(after.graphics ?? []), ...(after.titles ?? []).filter((c) => c.auto)].filter((x) => !had.has(x.id)).length
}

/** "Added 6 pop-ups (Undo removes them)" (§10.2). */
export const addedNotice = (n: number): string =>
  n === 0 ? 'No pop-ups to add: nothing in the captions called for one' : `Added ${n} ${n === 1 ? 'pop-up' : 'pop-ups'} (Undo removes ${n === 1 ? 'it' : 'them'})`

/**
 * Make my captions great's saved options (prefs `captionsGreat`), read with its reader; `save`
 * writes them back with a change (the Graphics tab's Sound on pop-ups is one of them, §2.11).
 */
function useGreatOptions(): { options: GreatOptions; save: (patch: Partial<GreatOptions>) => void; read: boolean } {
  const [options, setOptions] = useState<GreatOptions>(DEFAULT_GREAT_OPTIONS)
  const [read, setRead] = useState(false)
  useEffect(() => {
    let live = true
    window.api.getPref('captionsGreat').then(
      (raw) => {
        if (!live) return
        setOptions(readGreatOptions(raw))
        setRead(true)
      },
      () => live && setRead(true)
    )
    return () => {
      live = false
    }
  }, [])
  const save = (patch: Partial<GreatOptions>): void => {
    const next = { ...options, ...patch }
    setOptions(next)
    window.api.setPref('captionsGreat', next).catch((err: unknown) => console.warn('The pop-up options could not be saved:', err))
  }
  return { options, save, read }
}

/** The configured AI providers (Quotes needs one); [] until read, and when there are none. */
function useProviders(): AiProviderInfo[] {
  const [list, setList] = useState<AiProviderInfo[]>([])
  useEffect(() => {
    let live = true
    window.api.listAiProviders().then(
      (l) => live && setList(Array.isArray(l) ? l : []),
      () => live && setList([])
    )
    return () => {
      live = false
    }
  }, [])
  return list
}

export function GraphicsPanel(props: { project: Project; selection: Selection }): JSX.Element {
  const { project, selection } = props
  const graphic = selection?.kind === 'graphic' ? project.graphics?.find((g) => g.id === selection.id) : undefined
  return (
    <div className="graphics-panel" data-testid="graphics-panel">
      {graphic ? (
        <SelectedGraphic project={project} graphic={graphic} />
      ) : (
        <>
          <GenerateSection project={project} />
          <GraphicsList project={project} />
        </>
      )}
    </div>
  )
}

/* ---------- Add pop-ups from captions, the Add menu ---------- */

function GenerateSection({ project }: { project: Project }): JSX.Element {
  const services = useEditor()
  const { store } = services
  const group = useGroup()
  const providers = useProviders()
  const great = useGreatOptions()
  const frame = useMemo(() => {
    const f = editorFrame(project)
    return { w: f.outW, h: f.outH }
  }, [project])
  const [picked, setPicked] = useState<Partial<Record<GenerateKind, boolean>>>({})
  const hasCaptions = !!project.transcript?.segments.length
  // The chips start as Make my captions great's options resolve for this project (§2.11).
  const resolved = useMemo(() => (great.read && hasCaptions ? resolveGreatOptions(great.options, project, frame) : null), [great.read, great.options, hasCaptions, project, frame])
  const chips = GENERATE_CHIPS.filter((c) => c.id !== 'quotes' || providers.length > 0)
  const on = (id: GenerateKind): boolean => picked[id] ?? (resolved ? (id === 'quotes' ? resolved.quotes && providers.length > 0 : resolved[id]) : false)

  const generate = (): void => {
    const before = store.state
    store.seal()
    store.update((p) =>
      planGraphics(p, {
        keywords: on('keywords'),
        emoji: on('emoji'),
        counters: on('counters'),
        lists: on('lists'),
        speakers: on('speakers'),
        chapters: on('chapters'),
        // Quote cards come from the AI provider's `marks` answer, which part P4's runner gathers
        // (greatRun.ts); asked without it, the planner makes none and keeps those made.
        quotes: on('quotes'),
        sound: great.options.sound
      })
    )
    store.seal()
    group.notice(addedNotice(madeCount(before, store.state)))
  }

  const select = (id: string): void => group.select([itemKey('graphic', id)], itemKey('graphic', id))
  return (
    <Section title="Add pop-ups from captions">
      {!hasCaptions && <p className="hint">Generate captions first: pop-ups are made from what is said.</p>}
      <div className="field">
        <span id="graphics-kinds-label">Make</span>
        <div className="chips" role="group" aria-labelledby="graphics-kinds-label">
          {chips.map((c) => (
            <button key={c.id} type="button" className={`chip ${on(c.id) ? 'active' : ''}`} aria-pressed={on(c.id)} disabled={!hasCaptions} onClick={() => setPicked((x) => ({ ...x, [c.id]: !on(c.id) }))}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Sound on pop-ups</span>
        <select data-testid="graphics-sound" value={great.options.sound} onChange={(e) => great.save({ sound: e.target.value as GreatOptions['sound'] })}>
          {GRAPHIC_SOUNDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="graphics-actions">
        <button type="button" className="btn primary" data-testid="graphics-generate" disabled={!hasCaptions || !chips.some((c) => on(c.id))} onClick={generate}>
          <EditorIcon name="sparkle" size={16} /> Add pop-ups from captions
        </button>
        <AddMenu
          onAdd={(kind, byKey) =>
            addGraphicAt(services, kind, {
              onSelect: (sel) => {
                if (sel?.kind !== 'graphic') return
                addedByKey = byKey ? sel.id : null
                select(sel.id)
              },
              onNotice: group.notice
            })
          }
        />
      </div>
      {/* TODO(phase B): "Pop-ups made here are listed in Review mode." comes back with Review mode. */}
      <p className="hint">Drag one in the preview to place it yourself.</p>
    </Section>
  )
}

/** The Add menu (§2.11): Keyword pop-up, Emoji, Counter, List card; arrow keys move, Escape closes and returns to the button. */
function AddMenu({ onAdd }: { onAdd: (kind: Graphic['kind'], byKey: boolean) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') close(false)
  }
  return (
    <div className="graphics-add">
      <button ref={buttonRef} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} data-testid="graphics-add" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={16} /> Add
      </button>
      {open && (
        <div ref={menuRef} className="graphics-add-menu" role="menu" aria-label="Add a pop-up" onKeyDown={onKeyDown}>
          {ADD_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid={`graphics-add-${k.kind}`}
              onClick={() => {
                close(false)
                onAdd(k.kind, lastInputWasKey())
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- the list ---------- */

function GraphicsList({ project }: { project: Project }): JSX.Element | null {
  const { player } = useEditor()
  const group = useGroup()
  const list = useListSelect()
  const graphics = project.graphics ?? []
  if (!graphics.length) return null
  const keys = graphics.map((g) => itemKey('graphic', g.id))
  return (
    <Section
      title={`Pop-ups (${graphics.length})`}
      aside={
        graphics.length > 1 ? (
          <button className="link small" onClick={() => list.selectAll(keys)} title={`Select all ${graphics.length} pop-ups to edit them together`}>
            Select all
          </button>
        ) : undefined
      }
    >
      <ul className="item-list graphics-list" aria-label="Pop-ups">
        {graphics.map((g) => {
          const key = itemKey('graphic', g.id)
          return (
            <li key={g.id}>
              <button
                data-graphic-item={g.id}
                className={list.member(key) ? 'active' : ''}
                {...list.row(key, () => {
                  group.select([key], key)
                  showGraphic(player, project, g)
                })}
              >
                <GraphicKindIcon kind={g.kind} />
                <span>{graphicLabel(g)}</span>
                <span className="muted">
                  {formatTime(g.start, false)} · {GRAPHIC_NAMES[g.kind]}
                  {g.auto ? ' · automatic' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** A small mark per kind: keyword, emoji, counter, list. */
export function GraphicKindIcon({ kind, size = 15 }: { kind: Graphic['kind']; size?: number }): JSX.Element {
  const d =
    kind === 'keyword'
      ? 'M4 7h16v10H4zM8 12h8'
      : kind === 'emoji'
        ? 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 10h.01M15 10h.01M8.5 14.5a4 4 0 0 0 7 0'
        : kind === 'counter'
          ? 'M4 18l4-12M10 18l4-12M3 10h12M2 14h12M18 8v10'
          : 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={d} />
    </svg>
  )
}

/* ---------- the selected graphic ---------- */

function SelectedGraphic({ project, graphic: g }: { project: Project; graphic: Graphic }): JSX.Element {
  const { store, player } = useEditor()
  const group = useGroup()
  const keymap = useKeymap()
  const id = g.id
  const set = (patch: Partial<Graphic>, key?: string): void => store.update((p) => updateGraphic(p, id, patch), key)
  const followsCaptions = g.color === undefined && g.accent === undefined
  // Added from the Add menu with the keyboard: its first field takes the focus as it shows (autoFocus works once, on mount).
  const first = addedByKey === id
  useEffect(() => {
    if (addedByKey === id) addedByKey = null
  }, [id])
  return (
    <Section title={`Selected ${GRAPHIC_NAMES[g.kind].toLowerCase()}`} aside={<span className="muted small">{formatTime(g.start)} – {formatTime(g.end)}</span>}>
      {g.kind === 'keyword' && <KeywordFields g={g} set={set} first={first} />}
      {g.kind === 'emoji' && <EmojiPicker value={g.emoji} onPick={(emoji) => set({ emoji })} first={first} />}
      {g.kind === 'counter' && <CounterFields g={g} set={set} first={first} />}
      {g.kind === 'list' && <ListFields g={g} set={set} playhead={() => displayTime(project.clips, player.time)} first={first} />}

      <Slider label="Size" value={g.size} min={GRAPHIC_SIZE.min} max={GRAPHIC_SIZE.max} step={0.005} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(size) => set({ size }, `graphic-size:${id}`)} />
      <div className="field">
        <span>Colours</span>
        <Toggle
          label="Same as the captions"
          checked={followsCaptions}
          onChange={(same) => set(same ? { color: undefined, accent: undefined } : { color: captionTextColor(project), accent: captionAccentColor(project) })}
        />
        {!followsCaptions && (
          <div className="graphics-colors">
            <ColorDots label="Text colour" value={g.color ?? captionTextColor(project)} onChange={(color, key) => set({ color }, key ?? undefined)} mergeKey={`graphic-color:${id}`} />
            <ColorDots label="Accent" value={g.accent ?? captionAccentColor(project)} onChange={(accent, key) => set({ accent }, key ?? undefined)} mergeKey={`graphic-accent:${id}`} />
          </div>
        )}
      </div>
      <FontPicker
        project={project}
        value={g.font}
        catalogue
        language={captionLanguage(project)}
        bangla={(project.captions?.studio ?? STUDIO_BASE).text.scripts?.bengali?.font}
        testId="graphic-font"
        defaultLabel="Same as the captions"
        apply={(p, font) => updateGraphic(p, id, { font })}
      />
      <label className="field">
        <span>Comes in</span>
        <select value={g.enter.kind} onChange={(e) => set({ enter: { ...g.enter, kind: e.target.value as Graphic['enter']['kind'] } })}>
          {ITEM_MOTIONS.filter((m) => m.value !== 'typewriter' || g.kind === 'keyword').map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Goes out</span>
        <select value={g.exit.kind} onChange={(e) => set({ exit: { ...g.exit, kind: e.target.value as Graphic['exit']['kind'] } })}>
          {ITEM_MOTIONS.filter((m) => m.value !== 'typewriter' || g.kind === 'keyword').map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Position</span>
        <p className="hint graphics-place" data-testid="graphic-place">
          {g.place === 'auto' ? 'Placed automatically' : 'Placed by you'}
          {g.place !== 'auto' && (
            <button type="button" className="link" onClick={() => store.update((p) => placeGraphicAt(p, id, 'auto'))}>
              Place automatically
            </button>
          )}
        </p>
        {g.place === 'auto' && <p className="hint">Kept clear of the captions, the cursor and your camera. Drag it in the preview to place it yourself.</p>}
      </div>
      <div className="field">
        <span>Sound</span>
        <Chips<'none' | 'pop' | 'ding'> label="Sound" value={g.sound ?? 'none'} onChange={(v) => set({ sound: v === 'none' ? undefined : v })} options={[...GRAPHIC_SOUNDS]} />
      </div>
      {/* TODO(phase B): "; Review mode lists it until then" comes back with Review mode. */}
      {g.auto && <p className="hint">Made automatically. Editing it makes it yours.</p>}
      <LookButtons itemKey={itemKey('graphic', id)} />
      <button
        type="button"
        className="btn ghost danger"
        data-testid="graphic-delete"
        title={withShortcut('Delete this pop-up', keymap.deleteSelection)}
        onClick={() => {
          store.update((p) => deleteGraphics(p, [id]))
          group.select([], null)
        }}
      >
        <Icon name="trash" size={16} /> Delete pop-up
      </button>
    </Section>
  )
}

type SetGraphic = (patch: Partial<Graphic>, key?: string) => void

function KeywordFields({ g, set, first }: { g: KeywordGraphic; set: SetGraphic; first: boolean }): JSX.Element {
  return (
    <>
      <label className="field">
        <span>Text</span>
        <input className="tc-input" aria-label="Text" maxLength={GRAPHIC_TEXT_MAX} value={g.text} autoFocus={first} onChange={(e) => set({ text: e.target.value.replace(/[\r\n]+/g, ' ') }, `graphic-text:${g.id}`)} />
      </label>
      <div className="field">
        <span>Look</span>
        <Chips<KeywordGraphic['look']>
          label="Look"
          value={g.look}
          onChange={(look) => set({ look } as Partial<Graphic>)}
          options={[
            { value: 'card', label: 'Card' },
            { value: 'plain', label: 'Plain' },
            { value: 'outline', label: 'Outline' },
            { value: 'tag', label: 'Tag' }
          ]}
        />
      </div>
      {g.anchor && (
        <>
          <p className="hint">Replaces its caption words while it shows.</p>
          <Toggle label="Replace the caption" checked={g.replace !== false} onChange={(on) => set({ replace: on ? undefined : false } as Partial<Graphic>)} />
        </>
      )}
    </>
  )
}

/** A searchable picker over the emoji the bundled font draws (§2.11): by name, the first 96 matches. */
function EmojiPicker({ value, onPick, first }: { value: string; onPick: (key: string) => void; first: boolean }): JSX.Element {
  const [query, setQuery] = useState('')
  const current = emojiEntry(value)
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => (q ? EMOJI_LIST.filter((e) => e.name.includes(q)) : EMOJI_LIST).slice(0, 96), [q])
  return (
    <div className="field emoji-picker">
      <span>Emoji</span>
      <p className="emoji-current" aria-live="polite">
        {current ? (
          <>
            <span className="emoji-glyph" aria-hidden="true">
              {current.text}
            </span>{' '}
            {current.name}
          </>
        ) : (
          'Not in this version of Flown'
        )}
      </p>
      <input className="tc-input" type="search" aria-label="Search emoji by name" placeholder="Search: fire, bulb, check…" value={query} autoFocus={first} onChange={(e) => setQuery(e.target.value)} />
      <div className="emoji-grid" role="group" aria-label="Emoji">
        {matches.map((e) => (
          <button key={e.key} type="button" className={`emoji-cell ${e.key === value ? 'active' : ''}`} aria-pressed={e.key === value} aria-label={e.name} title={e.name} onClick={() => onPick(e.key)}>
            {e.text}
          </button>
        ))}
        {matches.length === 0 && <p className="hint">No emoji called “{query}”.</p>}
      </div>
    </div>
  )
}

/** A number field that writes finite values only. */
function NumberField({ label, value, step, autoFocus, onChange }: { label: string; value: number; step?: number; autoFocus?: boolean; onChange: (v: number) => void }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="tc-input"
        type="number"
        aria-label={label}
        step={step ?? 1}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(v)) onChange(v)
        }}
      />
    </label>
  )
}

function CounterFields({ g, set, first }: { g: CounterGraphic; set: SetGraphic; first: boolean }): JSX.Element {
  const typed = `graphic-text:${g.id}`
  const step = g.decimals ? 10 ** -g.decimals : 1
  return (
    <>
      <div className="graphics-pair">
        <NumberField label="From" value={g.from} step={step} autoFocus={first} onChange={(from) => set({ from } as Partial<Graphic>, typed)} />
        <NumberField label="To" value={g.to} step={step} onChange={(to) => set({ to } as Partial<Graphic>, typed)} />
      </div>
      <div className="field">
        <span>Decimals</span>
        <Chips<0 | 1 | 2>
          label="Decimals"
          value={g.decimals}
          onChange={(decimals) => set({ decimals } as Partial<Graphic>)}
          options={[
            { value: 0, label: '0' },
            { value: 1, label: '1' },
            { value: 2, label: '2' }
          ]}
        />
      </div>
      <div className="graphics-pair">
        <label className="field">
          <span>Before</span>
          <input className="tc-input" aria-label="Before" maxLength={8} placeholder="$" value={g.prefix} onChange={(e) => set({ prefix: e.target.value } as Partial<Graphic>, typed)} />
        </label>
        <label className="field">
          <span>After</span>
          <input className="tc-input" aria-label="After" maxLength={8} placeholder="%" value={g.suffix} onChange={(e) => set({ suffix: e.target.value } as Partial<Graphic>, typed)} />
        </label>
      </div>
      <label className="field">
        <span>Label</span>
        <input className="tc-input" aria-label="Label" maxLength={GRAPHIC_TEXT_MAX} placeholder="growth" value={g.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined } as Partial<Graphic>, typed)} />
      </label>
      <Slider label="Count for" value={g.countFor} min={0.4} max={5} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(countFor) => set({ countFor } as Partial<Graphic>, `graphic-count:${g.id}`)} />
    </>
  )
}

function ListFields({ g, set, playhead, first }: { g: ListGraphic; set: SetGraphic; playhead: () => number; first: boolean }): JSX.Element {
  const typed = `graphic-text:${g.id}`
  const setItems = (items: ListGraphic['items'], key?: string): void => set({ items } as Partial<Graphic>, key)
  const at = (): number => Math.min(Math.max(playhead(), g.start), g.end)
  return (
    <>
      <label className="field">
        <span>Title</span>
        <input className="tc-input" aria-label="Title" maxLength={LIST_ITEM_MAX} value={g.title ?? ''} autoFocus={first} onChange={(e) => set({ title: e.target.value || undefined } as Partial<Graphic>, typed)} />
      </label>
      <ol className="graphics-items" aria-label="Items">
        {g.items.map((it, i) => (
          <li key={i} className="graphics-item">
            <input
              className="tc-input"
              aria-label={`Item ${i + 1}`}
              maxLength={LIST_ITEM_MAX}
              value={it.text}
              onChange={(e) => setItems(g.items.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)), typed)}
            />
            <span className="muted small">Show at {formatTime(it.at, false)}</span>
            <button type="button" className="btn ghost small" aria-label={`Show item ${i + 1} from the playhead`} onClick={() => setItems(g.items.map((x, k) => (k === i ? { ...x, at: at() } : x)))}>
              Playhead
            </button>
            {g.items.length > 1 && (
              <button type="button" className="btn ghost icon-btn small" aria-label={`Remove item ${i + 1}`} title="Remove" onClick={() => setItems(g.items.filter((_, k) => k !== i))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      {g.items.length < MAX_LIST_ITEMS && (
        <button type="button" className="btn" onClick={() => setItems([...g.items, { text: `Point ${g.items.length + 1}`, at: at() }])}>
          Add item
        </button>
      )}
      <div className="field">
        <span>Marker</span>
        <Chips<ListGraphic['marker']>
          label="Marker"
          value={g.marker}
          onChange={(marker) => set({ marker } as Partial<Graphic>)}
          options={[
            { value: 'number', label: '1 2 3' },
            { value: 'bullet', label: 'Bullets' },
            { value: 'check', label: 'Ticks' }
          ]}
        />
      </div>
    </>
  )
}

/** Preset colours and a "pick any colour" dot (the look of the Shapes panel's). */
function ColorDots({ label, value, onChange, mergeKey }: { label: string; value: string; onChange: (color: string, key: string | null) => void; mergeKey: string }): JSX.Element {
  const v = value.toLowerCase()
  const custom = !GRAPHIC_COLORS.includes(v)
  return (
    <div className="shape-colors" role="group" aria-label={label}>
      {GRAPHIC_COLORS.map((c) => (
        <button key={c} type="button" className={`shape-color ${v === c ? 'active' : ''}`} style={{ background: c }} title={c} aria-label={`${label} ${c}`} aria-pressed={v === c} onClick={() => onChange(c, null)} />
      ))}
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
