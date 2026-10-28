import { useEffect, useState } from 'react'
import { ANNOTATION_SIZE } from '../../../../shared/editor/annotations'
import { displayTime } from '../../../../shared/editor/clips'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import {
  cleanChapterName,
  cleanTitle,
  sortedChapters,
  TITLE_BACKGROUNDS,
  TITLE_COLORS,
  TITLE_STYLES,
  TITLE_TEXT_COLORS,
  titleColorOf,
  titleTextColorOf,
  titleVisibleAt
} from '../../../../shared/editor/titles'
import { planOf, videoTimeAt } from '../../../../shared/engine/freeze'
import { formatTime } from '../../../../shared/engine/project'
import { itemKey } from '../../../../shared/editor/multiSelect'
import { chapterInVideo } from '../../../../shared/render/chapters'
import type { AnnotationStyle, Chapter, Clip, Project, TitleCard } from '../../../../shared/types'
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
import '../shapes.css'
import '../titles.css'

/* ---------- Text, title cards and chapters ---------- */

export function TextPanel(props: InspectorProps): JSX.Element {
  const { project, selection } = props
  const ann = selection?.kind === 'annotation' ? (project.annotations.find((a) => a.id === selection.id) ?? null) : null
  const card = selection?.kind === 'title' ? ((project.titles ?? []).find((c) => c.id === selection.id) ?? null) : null
  const chapter = selection?.kind === 'chapter' ? ((project.chapters ?? []).find((c) => c.id === selection.id) ?? null) : null

  if (ann) return <SelectedText {...props} />
  if (card) return <SelectedTitle project={project} card={card} onSelect={props.onSelect} />

  return (
    <>
      {chapter && <SelectedChapter project={project} chapter={chapter} onSelect={props.onSelect} />}
      <TextSection {...props} />
      <TitlesSection project={project} onSelect={props.onSelect} />
      <ChaptersSection project={project} selectedId={chapter?.id ?? null} onSelect={props.onSelect} onNotice={props.onNotice} />
    </>
  )
}

/** "Press T or double-click", following the user's shortcut ("Double-click" without one). */
function PressOr({ accelerators }: { accelerators: readonly string[] }): JSX.Element {
  if (!accelerators.length) return <>Double-click</>
  return (
    <>
      Press <FirstShortcut accelerators={accelerators} fallback="" /> or double-click
    </>
  )
}

/* ---------- text annotations ---------- */

function TextSection(props: InspectorProps): JSX.Element {
  const { player } = useEditor()
  const keymap = useKeymap()
  const list = useListSelect()
  const { project } = props
  return (
    <>
      <Section title="Text">
        <button className="btn" onClick={props.onAddText}>
          <EditorIcon name="text" size={16} /> Add text at playhead
        </button>
        <p className="hint">
          <PressOr accelerators={keymap.addText} /> the text track. Drag a text item on the timeline to change when it shows, and on the preview to move it.
        </p>
      </Section>
      {project.annotations.length > 0 && (
        <Section title={`Text in this video (${project.annotations.length})`} aside={<SelectAllButton keys={project.annotations.map((a) => itemKey('annotation', a.id))} what="text items" />}>
          <ul className="item-list">
            {[...project.annotations]
              .sort((a, b) => a.start - b.start)
              .slice(0, 100)
              .map((a) => (
                <li key={a.id}>
                  <button
                    data-text-item={a.id}
                    className={list.member(itemKey('annotation', a.id)) ? 'active' : ''}
                    {...list.row(itemKey('annotation', a.id), () => {
                      props.onSelect({ kind: 'annotation', id: a.id })
                      player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
                    })}
                  >
                    <span className="muted">{formatTime(a.start, false)}</span> {a.text || 'Text'}
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
    <Section title="Selected text" aside={<span className="muted small">{formatTime(ann.start)} – {formatTime(ann.end)}</span>}>
      <label className="field">
        <span>Text</span>
        <textarea className="text-field" rows={2} value={ann.text} onChange={(e) => set({ text: e.target.value }, `annotation-text:${ann.id}`)} placeholder="Type your text" />
      </label>
      <Chips<AnnotationStyle>
        label="Text style"
        value={ann.style}
        onChange={(style) => set({ style })}
        options={[
          { value: 'pill', label: 'Caption pill' },
          { value: 'title', label: 'Title' }
        ]}
      />
      <Slider label="Size" value={ann.size} min={ANNOTATION_SIZE.min} max={ANNOTATION_SIZE.max} step={0.002} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => set({ size: v }, `annotation-size:${ann.id}`)} />
      <Slider label="Position X" value={ann.x} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ x: v }, `annotation-pos:${ann.id}`)} />
      <Slider label="Position Y" value={ann.y} min={0} max={1} step={0.005} format={pctFmt} onChange={(v) => set({ y: v }, `annotation-pos:${ann.id}`)} />
      <p className="hint">Tip: drag the text on the preview to place it.</p>
      <LookButtons itemKey={itemKey('annotation', ann.id)} />
      <button
        className="btn ghost danger"
        onClick={() => {
          store.update((p) => ({ ...p, annotations: p.annotations.filter((a) => a.id !== ann.id) }))
          props.onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> Delete text
      </button>
    </Section>
  )
}

/* ---------- title cards ---------- */

function TitlesSection({ project, onSelect }: { project: Project; onSelect: (sel: Selection) => void }): JSX.Element {
  const services = useEditor()
  const keymap = useKeymap()
  const list = useListSelect()
  const titles = project.titles ?? []
  return (
    <Section
      title={titles.length ? `Title cards (${titles.length})` : 'Title cards'}
      aside={titles.length > 1 ? <SelectAllButton keys={titles.map((c) => itemKey('title', c.id))} what="title cards" /> : undefined}
    >
      <div className="title-tools">
        <button className="btn" onClick={() => addTitleAt(services, { onSelect })} title={withShortcut('Add a title card at the playhead', keymap.addTitle)}>
          <TitleStyleIcon style="centered" size={16} /> Add title card
        </button>
      </div>
      <p className="hint">
        An intro, a section title over the blurred video, or a lower third with a name. <PressOr accelerators={keymap.addTitle} /> the title track to add one.
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
                  className={list.member(itemKey('title', c.id)) ? 'active' : ''}
                  {...list.row(itemKey('title', c.id), () => {
                    onSelect({ kind: 'title', id: c.id })
                    showTitle(services.player, project.clips, c)
                  })}
                >
                  <TitleStyleIcon style={c.style} size={15} />
                  <span>{c.title.trim() || c.subtitle?.trim() || 'Title'}</span>
                  <span className="muted">{formatTime(c.start, false)}</span>
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
    <Section title="Selected title card" aside={<span className="muted small">{formatTime(card.start)} – {formatTime(card.end)}</span>}>
      <label className="field">
        <span>Title</span>
        <textarea className="text-field" rows={2} aria-label="Title" value={card.title} onChange={(e) => set({ title: cleanTitle(e.target.value) }, `title-text:${id}`)} placeholder="Your title" />
      </label>
      <label className="field">
        <span>Subtitle</span>
        <input className="tc-input" aria-label="Subtitle" value={card.subtitle ?? ''} onChange={(e) => set({ subtitle: cleanTitle(e.target.value) }, `title-subtitle:${id}`)} placeholder="Optional" />
      </label>
      <div className="field">
        <span>Style</span>
        <div className="title-styles" role="group" aria-label="Title style">
          {TITLE_STYLES.map((s) => (
            <button key={s.value} className={`title-style ${card.style === s.value ? 'active' : ''}`} aria-pressed={card.style === s.value} title={s.title} onClick={() => set({ style: s.value })}>
              <TitleStyleIcon style={s.value} size={22} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Background</span>
        <Chips<TitleCard['background']> label="Background" value={card.background} onChange={(background) => set({ background })} options={TITLE_BACKGROUNDS} />
      </div>
      {card.background === 'solid' && (
        <div className="field">
          <span>Colour</span>
          <ColorDots label="Colour" value={titleColorOf(card)} presets={TITLE_COLORS} onChange={(color, key) => set({ color }, key ?? undefined)} mergeKey={`title-color:${id}`} />
        </div>
      )}
      <div className="field">
        <span>Text colour</span>
        <ColorDots label="Text colour" value={titleTextColorOf(card, project.style.background)} presets={TITLE_TEXT_COLORS} onChange={(textColor, key) => set({ textColor }, key ?? undefined)} mergeKey={`title-text-color:${id}`} />
      </div>
      <TitleOnPreview card={card} clips={project.clips} />
      <p className="hint">Drag the card on the title track to change when it shows; it fades in and out. Long titles wrap and shrink to fit.</p>
      <LookButtons itemKey={itemKey('title', id)} />
      <button
        className="btn ghost danger"
        title={withShortcut('Delete this title card', keymap.deleteSelection)}
        onClick={() => {
          store.update((p) => ({ ...p, titles: (p.titles ?? []).filter((c) => c.id !== id) }))
          onSelect(null)
        }}
      >
        <Icon name="trash" size={16} /> Delete title card
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
      Not on screen at the playhead.{' '}
      <button className="link" onClick={() => showTitle(player, clips, card)}>
        Show it on the preview
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
      <label className={`shape-color custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={value} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}

/* ---------- chapters ---------- */

/** "At 0:12 in the video", or where a chapter in a cut starts the video instead, or that it is left out at the end. */
function outputNote(project: Project, t: number): string {
  const { clips } = project
  if (!chapterInVideo(clips, t)) return 'At the very end of the video, with nothing after it: exports leave it out.'
  // In seconds of the exported video, as the Transport and the YouTube timestamps count them (freeze frames included).
  const at = formatTime(videoTimeAt(clips, planOf(project), t), false)
  return Math.abs(displayTime(clips, t) - t) > 1e-6 ? `In a part that is cut: it starts at ${at} in the video, where it goes on.` : `At ${at} in the exported video.`
}

function SelectedChapter({ project, chapter, onSelect }: { project: Project; chapter: Chapter; onSelect: (sel: Selection) => void }): JSX.Element {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const id = chapter.id
  const set = (patch: Partial<Chapter>, key?: string): void =>
    store.update((p) => ({ ...p, chapters: (p.chapters ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) }), key)
  return (
    <Section title="Selected chapter" aside={<span className="muted small">{formatTime(chapter.t)}</span>}>
      <label className="field">
        <span>Name</span>
        <input className="tc-input" aria-label="Chapter name" value={chapter.title} placeholder="Chapter name" onChange={(e) => set({ title: cleanChapterName(e.target.value) }, `chapter-title:${id}`)} />
      </label>
      <p className="hint">{outputNote(project, chapter.t)}</p>
      <div className="row start title-tools">
        <button className="btn" onClick={() => player.seek(chapter.t)} title="Move the playhead to this chapter">
          Go to
        </button>
        <button className="btn" onClick={() => set({ t: displayTime(project.clips, player.time) })} title="Start this chapter at the playhead">
          Move to playhead
        </button>
        <button
          className="btn ghost danger"
          title={withShortcut('Delete this chapter', keymap.deleteSelection)}
          onClick={() => {
            store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((c) => c.id !== id) }))
            onSelect(null)
          }}
        >
          <Icon name="trash" size={16} /> Delete
        </button>
      </div>
    </Section>
  )
}

function ChaptersSection({
  project,
  selectedId,
  onSelect,
  onNotice
}: {
  project: Project
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
      title={chapters.length ? `Chapters (${chapters.length})` : 'Chapters'}
      aside={chapters.length > 1 ? <SelectAllButton keys={chapters.map((c) => itemKey('chapter', c.id))} what="chapters" /> : undefined}
    >
      <div className="title-tools">
        <button className="btn" onClick={() => addChapterAt(services, { onSelect, onNotice })} title={withShortcut('Add a chapter at the playhead', keymap.addChapter)}>
          <EditorIcon name="plus" size={16} /> Add chapter at playhead
        </button>
      </div>
      <p className="hint">
        <PressOr accelerators={keymap.addChapter} /> the strip above the title cards to add one. Chapters go into MP4, MOV, WebM and M4A exports, and the
        Export dialog copies them as YouTube timestamps.
        {next && prev && (
          <>
            {' '}
            <ShortcutKeys accelerator={next} /> and <ShortcutKeys accelerator={prev} /> jump between them.
          </>
        )}
      </p>
      {chapters.length > 0 && (
        <ul className="item-list chapter-list">
          {chapters.slice(0, 200).map((c) => (
            <li key={c.id} className={`chapter-row ${selectedId === c.id || list.member(itemKey('chapter', c.id)) ? 'active' : ''}${list.member(itemKey('chapter', c.id)) ? ' in-group' : ''}`} data-chapter-item={c.id}>
              <button
                className="chapter-time"
                title="Go to this chapter (Ctrl+click: select several)"
                {...list.row(itemKey('chapter', c.id), () => {
                  onSelect({ kind: 'chapter', id: c.id })
                  player.seek(c.t)
                })}
              >
                {formatTime(videoTimeAt(project.clips, planOf(project), c.t), false)}
              </button>
              <input
                className="tc-input"
                aria-label={`Name of the chapter at ${formatTime(c.t, false)}`}
                value={c.title}
                placeholder="Chapter name"
                onChange={(e) => {
                  const title = cleanChapterName(e.target.value)
                  store.update((p) => ({ ...p, chapters: (p.chapters ?? []).map((x) => (x.id === c.id ? { ...x, title } : x)) }), `chapter-title:${c.id}`)
                }}
              />
              <button
                className="btn ghost icon-btn"
                title="Delete this chapter"
                aria-label={`Delete the chapter "${c.title}"`}
                onClick={() => {
                  store.update((p) => ({ ...p, chapters: (p.chapters ?? []).filter((x) => x.id !== c.id) }))
                  if (selectedId === c.id) onSelect(null)
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** A list header's "Select all": every item of the list together (E-06). */
function SelectAllButton({ keys, what }: { keys: ReturnType<typeof itemKey>[]; what: string }): JSX.Element | null {
  const list = useListSelect()
  if (keys.length < 2) return null
  return (
    <button className="link small" onClick={() => list.selectAll(keys)} title={`Select all ${keys.length} ${what} to edit them together`}>
      Select all
    </button>
  )
}
