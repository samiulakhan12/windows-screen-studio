import { describe, expect, it } from 'vitest'
import { copyItems, duplicateItems, pasteItems, pasteNotice } from '../src/shared/editor/groupClipboard'
import { applyField, copyLook, deleteItems, fieldsFor, fieldValue, GROUP_FIELDS, lookClassOf, LOOK_CLASS_WORDS, pasteLook, type FieldCtx } from '../src/shared/editor/groupEdit'
import { groupMovePlan, moveGroup, setGroupLength, setGroupStart } from '../src/shared/editor/groupMove'
import { countOf, GROUP_KINDS, itemKey, projectItems, selectAllStep, trackOfKind, validGroup } from '../src/shared/editor/multiSelect'
import { projectSnapSegments } from '../src/shared/editor/snapping'
import { MAX_GRAPHICS } from '../src/shared/captions/studioData'
import { studioPreset } from '../src/shared/captions/studioPresets'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { CounterGraphic, Graphic, KeywordGraphic, ListGraphic, Project } from '../src/shared/types'
import { p20 } from './groupFixture'

/*
 * Motion graphics as a group kind (docs/design/captions-studio.md §2.11, §10.5, test 33): the
 * selection, GROUP_KINDS and its track, Delete, moves and lengths, group edits, looks, copy and
 * paste, and snapping.
 */

const motion = { kind: 'pop' as const, duration: 0.24, strength: 1 }
const fade = { kind: 'fade' as const, duration: 0.18, strength: 1 }
const keyword = (id: string, start: number, end: number, extra: Partial<KeywordGraphic> = {}): KeywordGraphic => ({
  id,
  kind: 'keyword',
  start,
  end,
  place: 'auto',
  size: 0.09,
  enter: motion,
  exit: fade,
  text: 'Auto Save',
  look: 'card',
  ...extra
})
const counter = (id: string, start: number, end: number, extra: Partial<CounterGraphic> = {}): CounterGraphic => ({
  id,
  kind: 'counter',
  start,
  end,
  place: 'auto',
  size: 0.11,
  enter: motion,
  exit: fade,
  from: 0,
  to: 300,
  decimals: 0,
  prefix: '',
  suffix: '%',
  locale: 'en',
  countFor: 1.2,
  ...extra
})
const list = (id: string, start: number, end: number): ListGraphic => ({
  id,
  kind: 'list',
  start,
  end,
  place: 'auto',
  size: 0.045,
  enter: motion,
  exit: fade,
  marker: 'number',
  items: [
    { text: 'Open settings', at: start + 0.5 },
    { text: 'Click export', at: start + 1.5 }
  ]
})
const withGraphics = (graphics: Graphic[], extra: Partial<Project> = {}): Project => ({ ...p20(), graphics, ...extra })
const ctx = (p: Project): FieldCtx => ({ crop: null, cursorValid: true, style: { defaultScale: 2, easing: 'smooth', transition: 0.6 } as never, background: p.style.background })

interface SelectionModule {
  validSelection(sel: unknown, p: Project): unknown
  selectionKey(sel: unknown): string
  groupKeyOf(sel: unknown): string | null
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SELECTION = '../src/renderer/src/editor/selection'
const selection = (await import(/* @vite-ignore */ SELECTION)) as SelectionModule

describe('the graphic kind', () => {
  it('is a selection that lasts while its graphic does', () => {
    const p = withGraphics([keyword('g1', 2, 4)])
    expect(selection.validSelection({ kind: 'graphic', id: 'g1' }, p)).toEqual({ kind: 'graphic', id: 'g1' })
    expect(selection.validSelection({ kind: 'graphic', id: 'gone' }, p)).toBeNull()
    expect(selection.validSelection({ kind: 'graphic', id: 'g1' }, p20())).toBeNull()
    expect(selection.groupKeyOf({ kind: 'graphic', id: 'g1' })).toBe('graphic:g1')
  })

  it('is the last group kind, on its own Graphics row', () => {
    expect(GROUP_KINDS.at(-1)).toBe('graphic')
    expect(trackOfKind('graphic')).toBe('graphics')
    const items = projectItems(withGraphics([counter('g2', 6, 9), keyword('g1', 2, 4)]))
    expect(items.filter((x) => x.kind === 'graphic').map((x) => [x.key, x.track, x.start, x.end])).toEqual([
      ['graphic:g1', 'graphics', 2, 4],
      ['graphic:g2', 'graphics', 6, 9]
    ])
    expect(selectAllStep(items, [], 'graphics').keys).toEqual(['graphic:g1', 'graphic:g2'])
    expect(countOf(2, 'graphic')).toBe('2 pop-ups')
    expect(LOOK_CLASS_WORDS.graphic).toEqual(['pop-up', 'pop-ups'])
  })

  it('leaves the group when its graphic is gone', () => {
    const g = { keys: [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')], anchor: itemKey('graphic', 'g2'), stamp: 1 }
    expect(validGroup(g, withGraphics([keyword('g1', 2, 4)])).keys).toEqual(['graphic:g1'])
  })

  it('snaps: its blocks are targets of the other drags', () => {
    expect(projectSnapSegments(withGraphics([keyword('g1', 2, 4)]), { layouts: false })).toContainEqual({ owner: 'graphic:g1', label: 'Pop-up', start: 2, end: 4 })
  })
})

describe('Delete', () => {
  it('removes the selected graphics in one project, and the key with the last one', () => {
    const p = withGraphics([keyword('g1', 2, 4), counter('g2', 6, 9)])
    const one = deleteItems(p, [itemKey('graphic', 'g1')])
    expect(one.graphics!.map((g) => g.id)).toEqual(['g2'])
    const none = deleteItems(p, [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')])
    expect(none).not.toHaveProperty('graphics')
  })
})

describe('moving and lengths', () => {
  it('moves graphics with the group, a list card’s items with it', () => {
    const p = withGraphics([list('g1', 2, 6), keyword('g2', 3, 4)])
    const keys = [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')]
    const q = moveGroup(p, groupMovePlan(p, keys), 1.5)
    const [l, k] = q.graphics! as [ListGraphic, KeywordGraphic]
    expect([l.start, l.end, k.start, k.end]).toEqual([3.5, 7.5, 4.5, 5.5])
    expect(l.items.map((it) => it.at)).toEqual([4, 5])
  })

  it('stops at the recording’s ends and sets a start', () => {
    const p = withGraphics([keyword('g1', 18, 19.5)])
    const plan = groupMovePlan(p, [itemKey('graphic', 'g1')])
    expect(plan.max).toBeCloseTo(0.5)
    expect(plan.maxWhy).toBe('end')
    expect(setGroupStart(p, [itemKey('graphic', 'g1')], 5).project.graphics![0].start).toBe(5)
  })

  it('sets the length of every graphic of the group', () => {
    const p = withGraphics([keyword('g1', 2, 4), list('g2', 5, 9)])
    const { project } = setGroupLength(p, [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')], 3)
    expect(project.graphics!.map((g) => g.end - g.start)).toEqual([3, 3])
    expect((project.graphics![1] as ListGraphic).items.map((it) => it.at)).toEqual([5.5, 6.5])
  })
})

describe('group edits', () => {
  const caption = { ...DEFAULT_CAPTIONS, studio: studioPreset('bold-pop')!.look }

  it('show a Pop-ups section with size, colours, motion and sound', () => {
    const p = withGraphics([keyword('g1', 2, 4), counter('g2', 6, 9)])
    const [section] = fieldsFor(p, [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')])
    expect(section.cls).toBe('graphic')
    expect(section.fields.map((f) => f.field.id)).toEqual(['graphic.size', 'graphic.color', 'graphic.accent', 'graphic.enter', 'graphic.exit', 'graphic.sound'])
  })

  it('write one value to every graphic in one project; Mixed before', () => {
    const p = withGraphics([keyword('g1', 2, 4), counter('g2', 6, 9)])
    const keys = [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')]
    const size = GROUP_FIELDS.find((f) => f.id === 'graphic.size')!
    expect(fieldValue(p, size, keys, ctx(p))).toEqual({ mixed: true, value: 0.09 })
    const r = applyField(p, size, keys, 0.15, ctx(p))
    expect(r.applied).toBe(2)
    expect(r.project.graphics!.map((g) => g.size)).toEqual([0.15, 0.15])
    const sound = GROUP_FIELDS.find((f) => f.id === 'graphic.sound')!
    const pop = applyField(r.project, sound, keys, 'pop', ctx(p)).project
    expect(pop.graphics!.map((g) => g.sound)).toEqual(['pop', 'pop'])
    expect(applyField(pop, sound, keys, 'none', ctx(p)).project.graphics!.every((g) => !('sound' in g))).toBe(true)
  })

  it('read a graphic without its own colour as the captions’, and writing the captions’ colour follows them again', () => {
    const p = withGraphics([keyword('g1', 2, 4), keyword('g2', 5, 6, { color: '#22d3ee' })], { captions: caption })
    const keys = [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')]
    const color = GROUP_FIELDS.find((f) => f.id === 'graphic.color')!
    expect(fieldValue(p, color, [keys[0]], ctx(p))).toEqual({ mixed: false, value: caption.studio.theme.text })
    const same = applyField(p, color, keys, caption.studio.theme.text, ctx(p)).project
    expect(same.graphics!.every((g) => !('color' in g))).toBe(true)
    const red = applyField(p, color, keys, '#FF5C8A', ctx(p)).project
    expect(red.graphics!.map((g) => g.color)).toEqual(['#ff5c8a', '#ff5c8a'])
  })

  it('never give a counter the typewriter (keywords only)', () => {
    const p = withGraphics([keyword('g1', 2, 4), counter('g2', 6, 9)])
    const enter = GROUP_FIELDS.find((f) => f.id === 'graphic.enter')!
    const q = applyField(p, enter, [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')], 'typewriter', ctx(p)).project
    expect(q.graphics!.map((g) => g.enter.kind)).toEqual(['typewriter', 'pop'])
  })

  it('copy one graphic’s look and paste it on another', () => {
    const p = withGraphics([keyword('g1', 2, 4, { size: 0.2, sound: 'ding', color: '#ffe14d' }), counter('g2', 6, 9)])
    expect(lookClassOf(p, itemKey('graphic', 'g2'))).toBe('graphic')
    const look = copyLook(p, itemKey('graphic', 'g1'), ctx(p))!
    expect(look.label).toBe('Keyword pop-up')
    const g2 = pasteLook(p, [itemKey('graphic', 'g2')], look, ctx(p)).project.graphics![1]
    expect([g2.size, g2.sound, g2.color]).toEqual([0.2, 'ding', '#ffe14d'])
  })
})

describe('copy, paste and duplicate', () => {
  it('pastes a graphic as the user’s, free of its caption words, list items moved with it', () => {
    const auto = { by: 'keyword' as const, via: 'rules' as const, caption: 'c1' }
    const p = withGraphics([keyword('g1', 2, 4, { auto, anchor: { caption: 'c1', from: 0, to: 1, text: 'Auto Save' }, replace: false }), list('g2', 4, 6)])
    const clip = copyItems(p, [itemKey('graphic', 'g1'), itemKey('graphic', 'g2')])!
    const r = pasteItems(p, clip, 12)
    expect(r.keys).toHaveLength(2)
    const pasted = r.project.graphics!.filter((g) => !['g1', 'g2'].includes(g.id))
    expect(pasted.map((g) => [g.kind, g.start])).toEqual([
      ['keyword', 12],
      ['list', 14]
    ])
    expect(pasted[0]).not.toHaveProperty('auto')
    expect(pasted[0]).not.toHaveProperty('anchor')
    expect(pasted[0]).not.toHaveProperty('replace')
    expect((pasted[1] as ListGraphic).items.map((it) => it.at)).toEqual([14.5, 15.5])
    expect(r.keys).toEqual(pasted.map((g) => itemKey('graphic', g.id)))
  })

  it('duplicates right after itself', () => {
    const p = withGraphics([counter('g1', 2, 4)])
    const r = duplicateItems(p, [itemKey('graphic', 'g1')])
    expect(r.project.graphics!.map((g) => g.start)).toEqual([2, 4])
  })

  it('skips graphics past the limit of a project, and says so', () => {
    const many = Array.from({ length: MAX_GRAPHICS }, (_, i) => keyword(`k${i}`, 1, 2))
    const p = withGraphics(many)
    const r = pasteItems(p, copyItems(p, [itemKey('graphic', 'k0')])!, 5)
    expect(r.keys).toEqual([])
    expect(r.project).toBe(p)
    expect(pasteNotice(r, 1)).toBe(`Nothing pasted: 1 pop-up would go past the limit of ${MAX_GRAPHICS}`)
  })
})
