import { useEffect, useState } from 'react'
import { ANNOTATION_SIZE } from '../../../../shared/editor/annotations'
import { displayTime } from '../../../../shared/editor/clips'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import {
  cleanChapterName,
  cleanTitle,
  sortedChapters,
  TITLE_COLORS,
  TITLE_TEXT_COLORS,
  titleColorOf,
  titleTextColorOf,
  titleVisibleAt
} from '../../../../shared/editor/titles'
import { planOf, videoTimeAt } from '../../../../shared/engine/freeze'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { chapterInVideo } from '../../../../shared/render/chapters'
import { fmt } from '../../../../shared/i18n/fmt'
import type { AnnotationStyle, Chapter, Clip, CursorTrack, Project, TitleCard } from '../../../../shared/types'
import { FindChapters } from './FindChapters'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InspectorProps } from '../Inspector'
import { useKeymap } from '../keymapContext'
import { useListSelect } from '../listSelect'
import { LookButtons } from '../LookButtons'
import type { Selection } from '../selection'
import { FirstShortcut, ShortcutKeys } from '../ShortcutKeys'
import { addChapterAt, addTitleAt, showTitle } from '../titleItems'
import { TitleStyleIcon } from '../TitleTrack'
import { FontPicker, withBrandColors } from './FontPicker'
import '../shapes.css'
import '../titles.css'
import { CalloutSection } from './CalloutSection'
import { BadgeSection } from './BadgeSection'
import { BubbleSection } from './BubbleSection'
import { ChapterBarSection } from './ChapterBarSection'
import { t } from '../../../../shared/i18n/t'
import { Rich } from './Rich'
import { TITLE_BACKGROUND_CHOICES, TITLE_STYLE_CHOICES } from '../../../../shared/editor/itemNames'

/* ---------- Text, title cards and chapters ---------- */

export function TextPanel(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const ann = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null
  const card = selection?.kind === 'title' ? ((project.titles ?? []).find((c) => c.id === selection.id) ?? null) : null
  const chapter = selection?.kind === 'chapter' ? ((project.chapters ?? []).find((c) => c.id === selection.id) ?? null) : null

  // The lists stay below a selected item, each in the same place (E-06, multi-select.md §4.7): a
  // Ctrl+click or Ctrl+Space on a row that leaves one item selected keeps the row, and its focus,
  // so the next row can be added.
  return (
    <>
      {ann && <SelectedText {...props} />}
      {card && <SelectedTitle project={project} card={card} onSelect={props.onSelect} />}
      {chapter && <SelectedChapter project={project} chapter={chapter} onSelect={props.onSelect} />}
      {/* Editing polish (docs/design/editing-polish.md §2.3, §2.4): a text's or title's animation, step badges, speech bubbles, the progress bar. */}
      <CalloutSection project={project} selection={selection ?? null} />
      <BadgeSection project={project} selection={selection ?? null} />
      <BubbleSection project={project} selection={selection ?? null} />
      <TextSection {...props} selectedId={ann?.id ?? null} />
      <TitlesSection project={project} selectedId={card?.id ?? null} onSelect={props.onSelect} />
      <ChaptersSection project={project} cursor={props.cursor} selectedId={chapter?.id ?? null} onSelect={props.onSelect} onNotice={props.onNotice} />
      <ChapterBarSection project={project} />
    </>
  )
}

/** "Press T or double-click …", following the user's shortcut ("Double-click …" without one): the values of a hint's message. */
function pressOr(accelerators: readonly string[]): { has: string; keys: JSX.Element } {
  return { has: accelerators.length ? 'yes' : 'no', keys: <FirstShortcut accelerators={accelerators} fallback="" /> }
}

/* ---------- text annotations ---------- */

function TextSection({ selectedId, ...props }: InspectorProps & { selectedId: string | null }): JSX.Element {
  const { player } = useEditor()
  const keymap = useKeymap()
  const list = useListSelect()
  const { project } = props
  return (
    <>
      <Section title={t('common.label.text')}>
        <button className="btn" onClick={props.onAddText}>
          <EditorIcon name="text" size={16} /> {t('text.textPanel.addTextAtPlayhead')}
        </button>
        <p className="hint">
          <Rich k="text.textPanel.addTextHint" values={pressOr(keymap.addText)} />
        </p>
      </Section>
      {project.annotations.length > 0 && (
        <Section title={t('text.textPanel.textInThisVideo', { n: fmt.count(project.annotations.length) })} aside={<SelectAllButton keys={project.annotations.map((a) => itemKey('annotation', a.id))} kind="annotation" />}>
          <ul className="item-list">
            {[...project.annotations]
              .sort((a, b) => a.start - b.start)
              .slice(0, 100)
              .map((a) => (
                <li key={a.id}>
                  <button
                    data-text-item={a.id}
                    className={selectedId === a.id || list.member(itemKey('annotation', a.id)) ? 'active' : ''}
                    {...list.row(
                      itemKey('annotation', a.id),
                      () => {
                        props.onSelect({ kind: 'annotation', id: a.id })
                        player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
                      },
                      selectedId === a.id
                    )}
                  >
                    <span className="muted">{fmt.clock(a.start, 'whole')}</span> {a.text || t('common.label.text')}
                  </button>
                </li>
              ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function SelectedText(props: InspectorProps): JSX.Element {
  const { store } = useEditor()
  const { project, selection } = props
  const ann = project.annotations.find((a) => selection?.kind === 'annotation' && a.id === selection.id)!
  const set = (patch: Partial<(typeof project.annotations)[number]>, key?: string): void => {
    store.update((p) => ({ ...p, annotations: p.annotations.map((a) => (a.id === ann.id ? { ...a, ...patch } : a)) }), key)
  }
  return (
    <Section title={t('text.textPanel.selectedText')} aside={<span className="muted small">{fmt.clock(ann.start)} – {fmt.clock(ann.end)}</span>}>
      <label className="field">
        <span>{t('common.label.text')}</span>
        <textarea className="text-field" rows={2} value={ann.text} onChange={(e) => set({ text: e.target.value }, `annotation-text:${ann.id}`)} placeholder={ann.style === 'bubble' ? t('text.textPanel.typeTheBubbleS') : t('text.textPanel.typeYourText')} />
      </label>
      <Chips<AnnotationStyle>
        label={t('text.textPanel.textStyle')}
        value={ann.style}
        onChange={(style) => set({ style })}
        options={[
          { value: 'pill', label: t('text.annotationStyle.pill') },
          { value: 'title', label: t('common.label.title') },
          { value: 'badge', label: t('text.annotationStyle.badge') },
          { value: 'bubble', label: t('text.annotationStyle.bubble') }
        ]}
      />
      <FontPicker project={project} value={ann.font} apply={(p, font) => ({ ...p, annotations: p.annotations.map((a) => (a.id === ann.id ? { ...a, font } : a)) })} />
      <Slider label={t('common.label.size')} value={ann.size} min={ANNOTATION_SIZE.min} max={ANNOTATION_SIZE.max} step={0.002} format={(v) => t('text.textPanel.sizePercent', { n: fmt.number(Math.round(v * 1000) / 10) })} onChange={(v) => set({ size: v }, `annotation-size:${ann.id}`)} />
      <Slider label={t('text.textPanel.positionX')} value={ann.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `annotation-pos:${ann.id}`)} />
      <Slider label={t('text.textPanel.positionY')} value={ann.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `annotation-pos:${ann.id}`)} />
      <p className="hint">{t('text.textPanel.tipDragTheText')}</p>
      <LookButtons itemKey={itemKey('annotation', ann.id)} />
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== ann.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> {t('text.textPanel.deleteText')}
      </button>
    </Section>
  )
}

/* ---------- title cards ---------- */

function TitlesSection({ project, selectedId, onSelect }: { project: Project; selectedId: string | null; onSelect: (sel: Selection) => void }): JSX.Element {
  const services = useEditor()
  const keymap = useKeymap()
  const list = useListSelect()
  const titles = project.titles ?? []
  return (
    <Section
      title={titles.length ? t('text.textPanel.titleCards', { n: fmt.count(titles.length) }) : t('text.textPanel.titleCardsNone')}
      aside={titles.length > 1 ? <SelectAllButton keys={titles.map((c) => itemKey('title', c.id))} kind="title" /> : undefined}
    >
      <div className="title-tools">
        <button className="btn" onClick={() => addTitleAt(services, { onSelect })} title={withShortcut(t('text.textPanel.addTitleTitle'), keymap.addTitle)}>
          <TitleStyleIcon style="centered" size={16} /> {t('text.textPanel.addTitleCard')}
        </button>
      </div>
      <p className="hint">
        <Rich k="text.textPanel.addTitleHint" values={pressOr(keymap.addTitle)} />
      </p>
      {titles.length > 0 && (
        <ul className="item-list title-list">
          {[...titles]
            .sort((a, b) => a.start - b.start)
            .slice(0, 100)
            .map((c) => (
              <li key={c.id}>
                <button
                  data-title-item={c.id}
                  className={selectedId === c.id || list.member(itemKey('title', c.id)) ? 'active' : ''}
                  {...list.row(
                    itemKey('title', c.id),
                    () => {
                      onSelect({ kind: 'title', id: c.id })
                      showTitle(services.player, project.clips, c)
                    },
                    selectedId === c.id
                  )}
                >
                  <TitleStyleIcon style={c.style} size={15} />
                  <span>{c.title.trim() || c.subtitle?.trim() || t('text.textPanel.title')}</span>
                  <span className="muted">{fmt.clock(c.start, 'whole')}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </Section>
  )
}

function SelectedTitle({ project, card, onSelect }: { project: Project; card: TitleCard; onSelect: (sel: Selection) => void }): JSX.Element {
  const { store } = useEditor()
  const keymap = useKeymap()
  const id = card.id
  const set = (patch: Partial<TitleCard>, key?: string): void =>
    store.update((p) => ({ ...p, titles: (p.titles ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) }), key)
  return (
    <Section title={t('text.textPanel.selectedTitleCard')} aside={<span className="muted small">{fmt.clock(card.start)} – {fmt.clock(card.end)}</span>}>
      <label className="field">
        <span>{t('text.textPanel.title')}</span>
        <textarea className="text-field" rows={2} aria-label={t('text.textPanel.title')} value={card.title} onChange={(e) => set({ title: cleanTitle(e.target.value) }, `title-text:${id}`)} placeholder={t('text.textPanel.yourTitle')} />
      </label>
      <label className="field">
        <span>{t('text.textPanel.subtitle')}</span>
        <input className="tc-input" aria-label={t('text.textPanel.subtitle')} value={card.subtitle ?? ''} onChange={(e) => set({ subtitle: cleanTitle(e.target.value) }, `title-subtitle:${id}`)} placeholder={t('text.textPanel.optional')} />
      </label>
      <div className="field">
        <span>{t('text.textPanel.style')}</span>
        <div className="title-styles" role="group" aria-label={t('text.textPanel.titleStyle')}>
          {TITLE_STYLE_CHOICES.map((s) => (
            <button key={s.value} className={`title-style ${card.style === s.value ? 'active' : ''}`} aria-pressed={card.style === s.value} title={s.title} onClick={() => set({ style: s.value })}>
              <TitleStyleIcon style={s.value} size={22} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <FontPicker project={project} value={card.font} apply={(p, font) => ({ ...p, titles: (p.titles ?? []).map((c) => (c.id === id ? { ...c, font } : c)) })} />
      <div className="field">
        <span>{t('common.label.background')}</span>
        <Chips<TitleCard['background']> label={t('common.label.background')} value={card.background} onChange={(background) => set({ background })} options={[...TITLE_BACKGROUND_CHOICES]} />
      </div>
      {card.background === 'solid' && (
        <div className="field">
          <span>{t('common.label.colour')}</span>
          <ColorDots label={t('common.label.colour')} value={titleColorOf(card)} presets={withBrandColors(project, TITLE_COLORS)} onChange={(color, key) => set({ color }, key ?? undefined)} mergeKey={`title-color:${id}`} />
        </div>
      )}
      <div className="field">
        <span>{t('common.label.textColour')}</span>
        <ColorDots label={t('common.label.textColour')} value={titleTextColorOf(card, project.style.background)} presets={withBrandColors(project, TITLE_TEXT_COLORS)} onChange={(textColor, key) => set({ textColor }, key ?? undefined)} mergeKey={`title-text-color:${id}`} />
      </div>
      <TitleOnPreview card={card} clips={project.clips} />
      <p className="hint">{t('text.textPanel.dragTheCardOn')}</p>
      <LookButtons itemKey={itemKey('title', id)} />
      <button
        className="btn ghost danger"
        title={withShortcut(t('text.textPanel.deleteTitleTitle'), keymap.deleteSelection)}
        onClick={() => {
          store.update((p) => ({ ...p, titles: (p.titles ?? []).filter((c) => c.id !== id) }))
          onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> {t('text.textPanel.deleteTitleCard')}
      </button>
    </Section>
  )
}

/** When the playhead is not on the card, a link that moves it there. */
function TitleOnPreview({ card, clips }: { card: TitleCard; clips: Clip[] }): JSX.Element | null {
  const { player } = useEditor()
  const shown = (): boolean => titleVisibleAt(card, displayTime(clips, player.time))
  const [inside, setInside] = useState(shown)
  useEffect(() => {
    const check = (): void => setInside(titleVisibleAt(card, displayTime(clips, player.time)))
    check()
    return player.subscribe(check)
  }, [card, clips, player])
  if (inside) return null
  return (
    <p className="hint">
      {t('text.textPanel.notOnScreenAt')}{' '}
      <button className="link" onClick={() => showTitle(player, clips, card)}>
        {t('text.textPanel.showItOnThe')}
      </button>
    </p>
  )
}

/** Preset colours and a "pick any colour" dot (the look of the Shapes panel's). */
function ColorDots({
  label,
  value,
  presets,
  onChange,
  mergeKey
}: {
  label: string
  value: string
  presets: string[]
  onChange: (color: string, key: string | null) => void
  mergeKey: string
}): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  return (
    <div className="shape-colors" role="group" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          className={`shape-color ${v === c ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={`${label} ${c}`}
          aria-pressed={v === c}
          onClick={() => onChange(c, null)}
        />
      ))}
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label: String(label) })} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}

/* ---------- chapters ---------- */

/** "At 0:12 in the video", or where a chapter in a cut starts the video instead, or that it is left out at the end. */
function outputNote(project: Project, t: number): string {
  const { clips } = project
  if (!chapterInVideo(clips, t)) return chapterNote('left')
  // In seconds of the exported video, as the Transport and the YouTube timestamps count them (freeze frames included).
  const at = fmt.clock(videoTimeAt(clips, planOf(project), t), 'whole')
  return chapterNote(Math.abs(displayTime(clips, t) - t) > 1e-6 ? 'cut' : 'at', at)
}

/** outputNote's words (its own `t` is a time). */
const chapterNote = (kind: 'left' | 'cut' | 'at', at = ''): string =>
  kind === 'left' ? t('text.textPanel.chapterLeftOut') : kind === 'cut' ? t('text.textPanel.chapterInCut', { at }) : t('text.textPanel.chapterAt', { at })

function SelectedChapter({ project, chapter, onSelect }: { project: Project; chapter: Chapter; onSelect: (sel: Selection) => void }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const id = chapter.id
  const set = (patch: Partial<Chapter>, key?: string): void =>
    store.update((p) => ({ ...p, chapters: (p.chapters ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) }), key)
  return (
    <Section title={t('text.textPanel.selectedChapter')} aside={<span className="muted small">{fmt.clock(chapter.t)}</span>}>
      <label className="field">
        <span>{t('common.label.name')}</span>
        <input className="tc-input" aria-label={t('text.textPanel.chapterName')} value={chapter.title} placeholder={t('text.textPanel.chapterName')} onChange={(e) => set({ title: cleanChapterName(e.target.value) }, `chapter-title:${id}`)} />
      </label>
      <p className="hint">{outputNote(project, chapter.t)}</p>
      <div className="row start title-tools">
        <button className="btn" onClick={() => player.seek(chapter.t)} title={t('text.textPanel.moveThePlayheadTo')}>
          {t('text.textPanel.goTo')}
        </button>
        <button className="btn" onClick={() => set({ t: displayTime(project.clips, player.time) })} title={t('text.textPanel.startThisChapterAt')}>
          {t('text.textPanel.moveToPlayhead')}
        </button>
        <button
          className="btn ghost danger"
          title={withShortcut(t('text.textPanel.deleteThisChapter'), keymap.deleteSelection)}
          onClick={() => {
            store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((c) => c.id !== id) }))
            onSelect(null)
          }}
        >
          <Icon name="trash" size={16} /> {t('common.action.delete')}
        </button>
      </div>
    </Section>
  )
}

function ChaptersSection({
  project,
  cursor,
  selectedId,
  onSelect,
  onNotice
}: {
  project: Project
  cursor: CursorTrack
  selectedId: string | null
  onSelect: (sel: Selection) => void
  onNotice: (message: string) => void
}): JSX.Element {
  const services = useEditor()
  const { store, player } = services
  const keymap = useKeymap()
  const list = useListSelect()
  const chapters = sortedChapters(project.chapters ?? [])
  const next = keymap.nextChapter[0]
  const prev = keymap.prevChapter[0]
  return (
    <Section
      title={chapters.length ? t('text.textPanel.chapters', { n: fmt.count(chapters.length) }) : t('text.textPanel.chaptersNone')}
      aside={chapters.length > 1 ? <SelectAllButton keys={chapters.map((c) => itemKey('chapter', c.id))} kind="chapter" /> : undefined}
    >
      <div className="title-tools">
        <button className="btn" onClick={() => addChapterAt(services, { onSelect, onNotice })} title={withShortcut(t('text.textPanel.addChapterTitle'), keymap.addChapter)}>
          <EditorIcon name="plus" size={16} /> {t('text.textPanel.addChapterAtPlayhead')}
        </button>
      </div>
      {/* Find chapters (docs/design/smart-tools.md §2.3), part P2's. */}
      <FindChapters project={project} cursor={cursor} onNotice={onNotice} />
      <p className="hint">
        <Rich k="text.textPanel.addChapterHint" values={pressOr(keymap.addChapter)} />
        {next && prev && (
          <>
            {' '}
            <Rich k="text.textPanel.chapterKeys" values={{ next: <ShortcutKeys accelerator={next} />, prev: <ShortcutKeys accelerator={prev} /> }} />
          </>
        )}
      </p>
      {chapters.length > 0 && (
        <ul className="item-list chapter-list">
          {chapters.slice(0, 200).map((c) => (
            <li key={c.id} className={`chapter-row ${selectedId === c.id || list.member(itemKey('chapter', c.id)) ? 'active' : ''}${list.member(itemKey('chapter', c.id)) ? ' in-group' : ''}`} data-chapter-item={c.id}>
              <button
                className="chapter-time"
                title={t('text.textPanel.goToThisChapter')}
                {...list.row(itemKey('chapter', c.id), () => {
                  onSelect({ kind: 'chapter', id: c.id })
                  player.seek(c.t)
                })}
              >
                {fmt.clock(videoTimeAt(project.clips, planOf(project), c.t), 'whole')}
              </button>
              {/* A found chapter not reviewed yet (smart-tools.md §2.3): said in words, not only colour, also in its name field's
                  name (§14); a weak name asks to be renamed. */}
              {c.auto && <span className="chip chapter-found">{t('text.textPanel.found')}</span>}
              <input
                id={chapterNameId(c.id)}
                className="tc-input"
                aria-label={t('text.textPanel.chapterNameAt', { time: fmt.clock(c.t, 'whole'), found: c.auto ? 'yes' : 'no' })}
                aria-describedby={c.auto && weakChapterName(c) ? `${chapterNameId(c.id)}-rename` : undefined}
                value={c.title}
                placeholder={t('text.textPanel.chapterName')}
                onChange={(e) => {
                  const title = cleanChapterName(e.target.value)
                  store.update((p) => ({ ...p, chapters: (p.chapters ?? []).map((x) => (x.id === c.id ? { ...x, title } : x)) }), `chapter-title:${c.id}`)
                }}
              />
              <button
                className="btn ghost icon-btn"
                title={t('text.textPanel.deleteThisChapter')}
                aria-label={t('text.textPanel.deleteTheChapter', { title: c.title })}
                onClick={() => {
                  store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((x) => x.id !== c.id) }))
                  if (selectedId === c.id) onSelect(null)
                }}
              >
                <Icon name="trash" size={15} />
              </button>
              {c.auto && weakChapterName(c) && (
                <span id={`${chapterNameId(c.id)}-rename`} className="hint chapter-rename">
                  {t('text.textPanel.rename')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** The id of chapter `id`'s name field: Find chapters moves the focus to the first weak name after a run (smart-tools.md §2.3). */
export const chapterNameId = (id: string): string => `chapter-name-${id}`

/** A found chapter named from a sentence cut short or a number (smart-tools.md §7.5): the list asks "Rename?". */
const weakChapterName = (c: Chapter): boolean => c.auto?.name === 'cut' || c.auto?.name === 'number'

/** A list header's "Select all": every item of the list together (E-06). */
function SelectAllButton({ keys, kind }: { keys: ReturnType<typeof itemKey>[]; kind: 'annotation' | 'title' | 'chapter' }): JSX.Element | null {
  const list = useListSelect()
  if (keys.length < 2) return null
  return (
    <button className="link small" onClick={() => list.selectAll(keys)} title={t('text.textPanel.selectAllToEdit', { kind, n: fmt.count(keys.length) })}>
      {t('common.action.selectAll')}
    </button>
  )
}
