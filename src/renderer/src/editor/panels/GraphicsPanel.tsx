/**
 * Inspector › Graphics (docs/design/captions-studio.md §2.11, §10.5): Add pop-ups from captions,
 * the Add menu and the list of graphics; or, with a graphic selected, its fields. Every change is
 * one undo step (typing: one per pause, merge key `graphic-text:<id>`); the list and the timeline
 * row lead to the same fields, so nothing needs a mouse.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AiProviderInfo } from '../../../../shared/api/ai'
import { graphicLanguage, graphicWords } from '../../../../shared/render/graphics'
import { emojiEntry, EMOJI_LIST } from '../../../../shared/captions/emojiList'
import { DEFAULT_GREAT_OPTIONS, readGreatOptions, resolveGreatOptions, type GreatOptions } from '../../../../shared/captions/great'
import { readGraphicSound } from '../../../../shared/audio/soundFxData'
import { ORIGINAL_SOUNDS, sfxGroupsFor } from '../../../../shared/audio/sfxChoices'
import { planGraphics } from '../../../../shared/captions/graphicRules'
import { GRAPHIC_TEXT_MAX, LIST_ITEM_MAX } from '../../../../shared/captions/studioData'
import { STUDIO_BASE } from '../../../../shared/captions/studioPresets'
import { displayTime } from '../../../../shared/editor/clips'
import { editorFrame } from '../../../../shared/editor/followEdit'
import { captionAccentColor, captionTextColor, GRAPHIC_COLORS, GRAPHIC_NAMES, GRAPHIC_SIZE, ITEM_MOTIONS } from '../../../../shared/editor/groupEdit'
import { deleteGraphics, placeGraphicAt, updateGraphic } from '../../../../shared/editor/graphicsEdit'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { fmt } from '../../../../shared/i18n/fmt'
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
import { t } from '../../../../shared/i18n/t'
import { NumberField } from '../../i18n/NumberField'

/** What a row, a block and the Selection view call a graphic: “Auto Save”, 🔥 fire, $1.2M, List: 3 steps. */
export function graphicLabel(g: Graphic): string {
  switch (g.kind) {
    case 'keyword':
      return t('text.graphicsPanel.keywordLabel', { text: g.text })
    case 'emoji': {
      const e = emojiEntry(g.emoji)
      return e ? `${e.text} ${e.name}` : t('text.graphicsPanel.emoji')
    }
    case 'counter':
      return `${g.prefix}${g.to.toFixed(g.decimals)}${g.suffix}${g.label ? ` ${g.label}` : ''}`
    case 'list':
      return g.title?.trim() ? t('text.graphicsPanel.listLabel', { title: g.title.trim() }) : t('text.graphicsPanel.listItems', { count: g.items.length, n: fmt.count(g.items.length) })
  }
}

/** The kinds the generator makes, as chips (§2.11), in the order of Make my captions great's options. */
export type GenerateKind = 'keywords' | 'emoji' | 'counters' | 'lists' | 'speakers' | 'chapters' | 'quotes'
const GENERATE_CHIPS: readonly { id: GenerateKind; readonly label: string }[] = (['keywords', 'emoji', 'counters', 'lists', 'speakers', 'chapters', 'quotes'] as const).map((id) => ({
  id,
  get label() {
    return t(`text.graphicsPanel.generate.${id}` as const)
  }
}))

const ADD_KINDS: readonly { kind: Graphic['kind']; readonly label: string }[] = (['keyword', 'emoji', 'counter', 'list'] as const).map((kind) => ({
  kind,
  get label() {
    return t(`text.graphicsPanel.addKind.${kind}` as const)
  }
}))

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
  t('text.graphicsPanel.added', { count: n, n: fmt.count(n) })

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
    <Section title={t('text.graphicsPanel.addPopUpsFrom')}>
      {!hasCaptions && <p className="hint">{t('text.graphicsPanel.generateCaptionsFirstPop')}</p>}
      <div className="field">
        <span id="graphics-kinds-label">{t('text.graphicsPanel.make')}</span>
        <div className="chips" role="group" aria-labelledby="graphics-kinds-label">
          {chips.map((c) => (
            <button key={c.id} type="button" className={`chip ${on(c.id) ? 'active' : ''}`} aria-pressed={on(c.id)} disabled={!hasCaptions} onClick={() => setPicked((x) => ({ ...x, [c.id]: !on(c.id) }))}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t('text.graphicsPanel.soundOnPopUps')}</span>
        <select data-testid="graphics-sound" value={great.options.sound} onChange={(e) => great.save({ sound: (readGraphicSound(e.target.value) ?? 'none') as GreatOptions['sound'] })}>
          <PopUpSoundOptions />
        </select>
      </label>
      <div className="graphics-actions">
        <button type="button" className="btn primary" data-testid="graphics-generate" disabled={!hasCaptions || !chips.some((c) => on(c.id))} onClick={generate}>
          <EditorIcon name="sparkle" size={16} /> {t('text.graphicsPanel.addPopUpsFrom2')}
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
      <p className="hint">{t('text.graphicsPanel.popUpsMadeHere')}</p>
    </Section>
  )
}

/** The keys the Add menu keeps (Left and Right do nothing there). */
const MENU_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

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
    if (e.key === 'Tab') return close(false)
    if (!MENU_KEYS.has(e.key)) return
    // The menu's keys are its own, as the copy menu's: never the editor's shortcuts (Home and End
    // move the playhead there; Left and Right move the selected pop-up, or step a frame).
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return close(true)
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    else if (e.key === 'Home' || e.key === 'End') items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
  }
  return (
    <div className="graphics-add">
      <button ref={buttonRef} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} data-testid="graphics-add" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={16} /> {t('common.action.add')}
      </button>
      {open && (
        <div ref={menuRef} className="graphics-add-menu" role="menu" aria-label={t('text.graphicsPanel.addAPopUp')} onKeyDown={onKeyDown}>
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
      title={t('text.graphicsPanel.popUps', { n: fmt.count(graphics.length) })}
      aside={
        graphics.length > 1 ? (
          <button className="link small" onClick={() => list.selectAll(keys)} title={t('text.graphicsPanel.selectAllPopUps', { n: fmt.count(graphics.length) })}>
            {t('common.action.selectAll')}
          </button>
        ) : undefined
      }
    >
      <ul className="item-list graphics-list" aria-label={t('text.graphicsPanel.popUpsList')}>
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
                  {fmt.clock(g.start, 'whole')} · {GRAPHIC_NAMES[g.kind]}
                  {g.auto ? ` · ${t('text.graphicsPanel.automatic')}` : ''}
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
    <Section title={t('text.graphicsPanel.selectedKind', { kind: g.kind })} aside={<span className="muted small">{fmt.clock(g.start)} – {fmt.clock(g.end)}</span>}>
      {g.kind === 'keyword' && <KeywordFields g={g} set={set} first={first} />}
      {g.kind === 'emoji' && <EmojiPicker value={g.emoji} onPick={(emoji) => set({ emoji })} first={first} />}
      {g.kind === 'counter' && <CounterFields g={g} set={set} first={first} />}
      {g.kind === 'list' && <ListFields g={g} set={set} playhead={() => displayTime(project.clips, player.time)} first={first} />}

      <Slider label={t('common.label.size')} value={g.size} min={GRAPHIC_SIZE.min} max={GRAPHIC_SIZE.max} step={0.005} format={(v) => t('text.textPanel.sizePercent', { n: fmt.number(Math.round(v * 1000) / 10) })} onChange={(size) => set({ size }, `graphic-size:${id}`)} />
      <div className="field">
        <span>{t('common.label.colours')}</span>
        <Toggle
          label={t('text.graphicsPanel.sameAsTheCaptions')}
          checked={followsCaptions}
          onChange={(same) => set(same ? { color: undefined, accent: undefined } : { color: captionTextColor(project), accent: captionAccentColor(project) })}
        />
        {!followsCaptions && (
          <div className="graphics-colors">
            <ColorDots label={t('common.label.textColour')} value={g.color ?? captionTextColor(project)} onChange={(color, key) => set({ color }, key ?? undefined)} mergeKey={`graphic-color:${id}`} />
            <ColorDots label={t('text.graphicsPanel.accent')} value={g.accent ?? captionAccentColor(project)} onChange={(accent, key) => set({ accent }, key ?? undefined)} mergeKey={`graphic-accent:${id}`} />
          </div>
        )}
      </div>
      <FontPicker
        project={project}
        value={g.font}
        catalogue
        language={graphicLanguage(project, g)}
        letters={graphicWords(g).join('\n')}
        bangla={(project.captions?.studio ?? STUDIO_BASE).text.scripts?.bengali?.font}
        testId="graphic-font"
        defaultLabel={t('text.graphicsPanel.sameAsTheCaptions')}
        apply={(p, font) => updateGraphic(p, id, { font })}
      />
      <label className="field">
        <span>{t('text.graphicsPanel.comesIn')}</span>
        <select value={g.enter.kind} onChange={(e) => set({ enter: { ...g.enter, kind: e.target.value as Graphic['enter']['kind'] } })}>
          {ITEM_MOTIONS.filter((m) => m.value !== 'typewriter' || g.kind === 'keyword').map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('text.graphicsPanel.goesOut')}</span>
        <select value={g.exit.kind} onChange={(e) => set({ exit: { ...g.exit, kind: e.target.value as Graphic['exit']['kind'] } })}>
          {ITEM_MOTIONS.filter((m) => m.value !== 'typewriter' || g.kind === 'keyword').map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>{t('common.label.position')}</span>
        <p className="hint graphics-place" data-testid="graphic-place">
          {g.place === 'auto' ? t('text.graphicsPanel.placedAutomatically') : t('text.graphicsPanel.placedByYou')}
          {g.place !== 'auto' && (
            <button type="button" className="link" onClick={() => store.update((p) => placeGraphicAt(p, id, 'auto'))}>
              {t('text.graphicsPanel.placeAutomatically')}
            </button>
          )}
        </p>
        {g.place === 'auto' && <p className="hint">{t('text.graphicsPanel.keptClearOfThe')}</p>}
      </div>
      <label className="field">
        <span>{t('common.label.sound')}</span>
        {/* None, the Original group (as they always sounded), then the library's effects (editing polish §10.7). */}
        <select aria-label={t('common.label.sound')} value={g.sound ?? 'none'} onChange={(e) => set({ sound: readGraphicSound(e.target.value) })}>
          <PopUpSoundOptions />
        </select>
      </label>
      {g.auto && <p className="hint">{t('text.graphicsPanel.madeAutomaticallyEditingIt')}</p>}
      <LookButtons itemKey={itemKey('graphic', id)} />
      <button
        type="button"
        className="btn ghost danger"
        data-testid="graphic-delete"
        title={withShortcut(t('text.graphicsPanel.deleteThisPopUp'), keymap.deleteSelection)}
        onClick={() => {
          store.update((p) => deleteGraphics(p, [id]))
          group.select([], null)
        }}
      >
        <Icon name="trash" size={16} /> {t('text.graphicsPanel.deletePopUp')}
      </button>
    </Section>
  )
}

type SetGraphic = (patch: Partial<Graphic>, key?: string) => void

function KeywordFields({ g, set, first }: { g: KeywordGraphic; set: SetGraphic; first: boolean }): JSX.Element {
  return (
    <>
      <label className="field">
        <span>{t('common.label.text')}</span>
        <input className="tc-input" aria-label={t('common.label.text')} maxLength={GRAPHIC_TEXT_MAX} value={g.text} autoFocus={first} onChange={(e) => set({ text: e.target.value.replace(/[\r\n]+/g, ' ') }, `graphic-text:${g.id}`)} />
      </label>
      <div className="field">
        <span>{t('common.label.look')}</span>
        <Chips<KeywordGraphic['look']>
          label={t('common.label.look')}
          value={g.look}
          onChange={(look) => set({ look } as Partial<Graphic>)}
          options={[
            { value: 'card', label: t('text.graphicsPanel.look.card') },
            { value: 'plain', label: t('text.graphicsPanel.look.plain') },
            { value: 'outline', label: t('text.graphicsPanel.look.outline') },
            { value: 'tag', label: t('text.graphicsPanel.look.tag') }
          ]}
        />
      </div>
      {g.anchor && (
        <>
          <p className="hint">{t('text.graphicsPanel.replacesItsCaptionWords')}</p>
          <Toggle label={t('text.graphicsPanel.replaceTheCaption')} checked={g.replace !== false} onChange={(on) => set({ replace: on ? undefined : false } as Partial<Graphic>)} />
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
      <span>{t('text.graphicsPanel.emoji')}</span>
      <p className="emoji-current" aria-live="polite">
        {current ? (
          <>
            <span className="emoji-glyph" aria-hidden="true">
              {current.text}
            </span>{' '}
            {current.name}
          </>
        ) : (
          t('text.graphicsPanel.notInThisVersion')
        )}
      </p>
      <input className="tc-input" type="search" aria-label={t('text.graphicsPanel.searchEmojiByName')} placeholder={t('text.graphicsPanel.searchFireBulbCheck')} value={query} autoFocus={first} onChange={(e) => setQuery(e.target.value)} />
      <div className="emoji-grid" role="group" aria-label={t('text.graphicsPanel.emoji')}>
        {matches.map((e) => (
          <button key={e.key} type="button" className={`emoji-cell ${e.key === value ? 'active' : ''}`} aria-pressed={e.key === value} aria-label={e.name} title={e.name} onClick={() => onPick(e.key)}>
            {e.text}
          </button>
        ))}
        {matches.length === 0 && <p className="hint">{t('text.graphicsPanel.noEmojiCalled', { query })}</p>}
      </div>
    </div>
  )
}

/** A number field that writes finite values only (NumberField: the UI's digits outside English, §11.1). */
function NumberRow({ label, value, step, autoFocus, onChange }: { label: string; value: number; step?: number; autoFocus?: boolean; onChange: (v: number) => void }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <NumberField
        className="tc-input"
        aria-label={label}
        step={step ?? 1}
        value={value}
        autoFocus={autoFocus}
        onValue={(v) => {
          if (Number.isFinite(v)) onChange(v)
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
        <NumberRow label={t('text.graphicsPanel.from')} value={g.from} step={step} autoFocus={first} onChange={(from) => set({ from } as Partial<Graphic>, typed)} />
        <NumberRow label={t('text.graphicsPanel.to')} value={g.to} step={step} onChange={(to) => set({ to } as Partial<Graphic>, typed)} />
      </div>
      <div className="field">
        <span>{t('text.graphicsPanel.decimals')}</span>
        <Chips<0 | 1 | 2>
          label={t('text.graphicsPanel.decimals')}
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
          <span>{t('text.graphicsPanel.before')}</span>
          <input className="tc-input" aria-label={t('text.graphicsPanel.before')} maxLength={8} placeholder="$" value={g.prefix} onChange={(e) => set({ prefix: e.target.value } as Partial<Graphic>, typed)} />
        </label>
        <label className="field">
          <span>{t('text.graphicsPanel.after')}</span>
          <input className="tc-input" aria-label={t('text.graphicsPanel.after')} maxLength={8} placeholder="%" value={g.suffix} onChange={(e) => set({ suffix: e.target.value } as Partial<Graphic>, typed)} />
        </label>
      </div>
      <label className="field">
        <span>{t('text.graphicsPanel.label')}</span>
        <input className="tc-input" aria-label={t('text.graphicsPanel.label')} maxLength={GRAPHIC_TEXT_MAX} placeholder={t('text.graphicsPanel.growth')} value={g.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined } as Partial<Graphic>, typed)} />
      </label>
      <Slider label={t('text.graphicsPanel.countFor')} value={g.countFor} min={0.4} max={5} step={0.1} format={(v) => t('text.graphicsPanel.seconds', { n: fmt.number(v, { max: 1 }) })} onChange={(countFor) => set({ countFor } as Partial<Graphic>, `graphic-count:${g.id}`)} />
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
        <span>{t('common.label.title')}</span>
        <input className="tc-input" aria-label={t('common.label.title')} maxLength={LIST_ITEM_MAX} value={g.title ?? ''} autoFocus={first} onChange={(e) => set({ title: e.target.value || undefined } as Partial<Graphic>, typed)} />
      </label>
      <ol className="graphics-items" aria-label={t('text.graphicsPanel.items')}>
        {g.items.map((it, i) => (
          <li key={i} className="graphics-item">
            <input
              className="tc-input"
              aria-label={t('text.graphicsPanel.item', { n: fmt.count(i + 1) })}
              maxLength={LIST_ITEM_MAX}
              value={it.text}
              onChange={(e) => setItems(g.items.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)), typed)}
            />
            <span className="muted small">{t('text.graphicsPanel.showAt', { time: fmt.clock(it.at, 'whole') })}</span>
            <button type="button" className="btn ghost small" aria-label={t('text.graphicsPanel.showItemFromThe', { n: fmt.count(i + 1) })} onClick={() => setItems(g.items.map((x, k) => (k === i ? { ...x, at: at() } : x)))}>
              {t('text.graphicsPanel.playhead')}
            </button>
            {g.items.length > 1 && (
              <button type="button" className="btn ghost icon-btn small" aria-label={t('text.graphicsPanel.removeItem', { n: fmt.count(i + 1) })} title={t('common.action.remove')} onClick={() => setItems(g.items.filter((_, k) => k !== i))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      {g.items.length < MAX_LIST_ITEMS && (
        <button type="button" className="btn" onClick={() => setItems([...g.items, { text: `Point ${g.items.length + 1}`, at: at() }])}>
          {t('text.graphicsPanel.addItem')}
        </button>
      )}
      <div className="field">
        <span>{t('text.graphicsPanel.marker')}</span>
        <Chips<ListGraphic['marker']>
          label={t('text.graphicsPanel.marker')}
          value={g.marker}
          onChange={(marker) => set({ marker } as Partial<Graphic>)}
          options={[
            { value: 'number', label: '1 2 3' },
            { value: 'bullet', label: t('text.graphicsPanel.marker.bullet') },
            { value: 'check', label: t('text.graphicsPanel.marker.check') }
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
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label })} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}

/** The sounds a pop-up can have: None, Captions Studio's own (Original), then the library's effects, pop-ups' first (§10.7). */
function PopUpSoundOptions(): JSX.Element {
  return (
    <>
      <option value="none">{t('common.state.none')}</option>
      <optgroup label={t('text.graphicsPanel.original')}>
        {ORIGINAL_SOUNDS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </optgroup>
      {sfxGroupsFor('pop-ups').map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}
