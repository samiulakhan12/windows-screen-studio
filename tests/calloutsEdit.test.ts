import { describe, expect, it } from 'vitest'
import {
  addBadge,
  addBubble,
  badgeLanguage,
  badgeSpot,
  badgeTextError,
  bubbleSpot,
  countWithOptions,
  fromOutput,
  moveBody,
  movePin,
  newShapeForPlayhead,
  setBubbleTail,
  setFollowsZoom,
  withBadge,
  withBadgesByChapter,
  withBubbleColor,
  withCallout,
  withCalm
} from '../src/shared/editor/calloutsEdit'
import { applyField, copyLook, fieldsFor, GROUP_FIELDS, pasteLook, sharedMotions, type FieldCtx, type GroupField } from '../src/shared/editor/groupEdit'
import { EditStore } from '../src/shared/editor/editStore'
import { migrateProject } from '../src/shared/engine/project'
import { toOutput } from '../src/shared/engine/outputPoint'
import { DEFAULT_ZOOM_STYLE } from '../src/shared/engine/zoom'
import { calloutOf } from '../src/shared/render/calloutData'
import { CALLOUT_DEFAULTS } from '../src/shared/render/callouts'
import { titleShowTime } from '../src/shared/render/titleCards'
import type { Annotation, Project } from '../src/shared/types'
import { p20, shape, text, title } from './groupFixture'

/*
 * Adding and editing animated callouts (docs/design/editing-polish.md §2.3, §7.1, §19.1 test 79,
 * and the editing half of test 78): new badges, bubbles and shapes with their kind's motion and
 * place, old items never given one, the group fields' shared motions, Copy look, pins and bodies.
 */

const ctx: FieldCtx = { crop: null, cursorValid: true, style: DEFAULT_ZOOM_STYLE, background: { type: 'color', color: '#202020' } }
const field = (id: string): GroupField => GROUP_FIELDS.find((f) => f.id === id)!
const added = (p: Project, id: string): Annotation => p.annotations.find((a) => a.id === id)!

/** A 1920 × 1080 frame zoomed 2× on (0.6, 0.4) of a recording drawn over the whole frame. */
const rect = { x: 0, y: 0, w: 1920, h: 1080 }
const cam = { scale: 2, cx: 0.6, cy: 0.4 }
const view = { w: 1920, h: 1080, toOut: toOutput(rect, cam), fromOut: fromOutput(rect, cam) }

describe('new badges (test 79)', () => {
  it('pop in, number themselves and start one entrance before the playhead', () => {
    const p = p20()
    const { project, id } = addBadge(p, 5, { pin: { x: 0.5, y: 0.5 }, x: 0.5, y: 0.5 }, null)
    const a = added(project, id)
    expect(a.style).toBe('badge')
    expect(a.number).toBe('auto')
    expect(a.enter).toEqual(CALLOUT_DEFAULTS.badge.enter)
    expect(a.exit).toEqual(CALLOUT_DEFAULTS.badge.exit)
    expect(a.enter).toEqual({ kind: 'pop', duration: 0.24, strength: 1 })
    expect(a.start).toBeCloseTo(5 - 0.24, 9)
    expect(a.size).toBe(0.045)
    expect(a.color).toBeUndefined()
    expect(a.numbering).toBeUndefined()
    expect(p.annotations).toHaveLength(0)
  })

  it("take the brand kit's first colour and Bangla digits with Bangla captions or transcript", () => {
    const p = { ...p20(), brand: { colors: ['#E4572E', '#29335C'] } }
    const a = added(...((r) => [r.project, r.id] as const)(addBadge(p, 5, { pin: null, x: 0.3, y: 0.3 }, 'bn')))
    expect(a.color).toBe('#e4572e')
    expect(a.numbering).toBe('bn')
    expect(a.pin).toBeUndefined()
    expect(badgeLanguage({ transcript: { language: 'bn' } } as Project)).toBe('bn')
    expect(badgeLanguage({ captions: { track: 'bn' }, transcript: { language: 'en' } } as Project)).toBe('bn')
    expect(badgeLanguage({} as Project)).toBeNull()
    const en = addBadge(p20(), 5, { pin: null, x: 0.3, y: 0.3 }, 'en')
    expect(added(en.project, en.id).numbering).toBeUndefined()
  })

  it('land 1.2 badge widths up and to the left of the cursor, inside the frame, or at the view centre', () => {
    const d = 1.75 * 0.045 * 1080
    const cursor = { x: 0.62, y: 0.45 }
    const tip = view.toOut(cursor.x, cursor.y)
    const spot = badgeSpot(view, cursor)
    expect(spot.x * 1920).toBeCloseTo(tip.x - 1.2 * d, 6)
    expect(spot.y * 1080).toBeCloseTo(tip.y - 1.2 * d, 6)
    // The pin is the point of the recording shown there.
    const back = view.toOut(spot.pin.x, spot.pin.y)
    expect(back.x).toBeCloseTo(spot.x * 1920, 6)
    expect(back.y).toBeCloseTo(spot.y * 1080, 6)
    // Near the top-left corner it is kept inside the frame.
    const corner = badgeSpot(view, view.fromOut(20, 30))
    expect(corner.x * 1920).toBeCloseTo(d / 2, 6)
    expect(corner.y * 1080).toBeCloseTo(d / 2, 6)
    // No cursor: the centre of what the preview shows.
    const centre = badgeSpot(view, null)
    expect([centre.x, centre.y]).toEqual([0.5, 0.5])
    expect(centre.pin.x).toBeCloseTo(0.6, 9)
    expect(centre.pin.y).toBeCloseTo(0.4, 9)
  })
})

describe('new bubbles (test 79)', () => {
  it("pop in from the tip; the tip is on the cursor, the body toward the frame's centre", () => {
    const right = bubbleSpot(view, { x: 0.7, y: 0.5 })
    expect(right.pin).toEqual({ x: 0.7, y: 0.5 })
    expect(right.body).toEqual({ dx: -0.12, dy: -0.1 })
    const left = bubbleSpot(view, { x: 0.45, y: 0.5 })
    expect(left.body).toEqual({ dx: 0.12, dy: -0.1 })
    const tip = view.toOut(0.45, 0.5)
    expect(left.x * 1920).toBeCloseTo(tip.x + 0.12 * 1080, 6)
    const { project, id } = addBubble(p20(), 4, right)
    const b = added(project, id)
    expect(b.style).toBe('bubble')
    expect(b.pin).toEqual({ x: 0.7, y: 0.5 })
    expect(b.body).toEqual({ dx: -0.12, dy: -0.1 })
    expect(b.enter).toEqual({ kind: 'pop', duration: 0.26, strength: 1 })
    expect(b.exit).toEqual({ kind: 'pop', duration: 0.18, strength: 0.25 })
    expect(b.text).toBe('')
    expect(b.start).toBeCloseTo(4 - 0.26, 9)
  })
})

describe('new shapes and old items (test 79)', () => {
  it('addShapeAt writes the defaults: arrows and lines draw, boxes draw, highlights wipe; privacy shapes none', () => {
    const p = p20()
    const at = (kind: Parameters<typeof newShapeForPlayhead>[0]) => newShapeForPlayhead(kind, 5, p, null)
    expect(at('arrow').enter).toEqual({ kind: 'draw', duration: 0.35, strength: 1 })
    expect(at('line').enter).toEqual({ kind: 'draw', duration: 0.35, strength: 1 })
    expect(at('rect').enter).toEqual({ kind: 'draw', duration: 0.45, strength: 1 })
    expect(at('ellipse').exit).toEqual({ kind: 'fade', duration: 0.18, strength: 1 })
    expect(at('highlight').enter).toEqual({ kind: 'wipe', duration: 0.28, strength: 1 })
    expect(at('arrow').start).toBeCloseTo(5 - 0.35, 9)
    expect(at('rect').start).toBeCloseTo(5 - 0.45, 9)
    for (const kind of ['blur', 'pixelate'] as const) {
      const s = at(kind)
      expect(s.enter).toBeUndefined()
      expect(s.exit).toBeUndefined()
      expect(s.start).toBe(5)
    }
    // On a 2× clip, one entrance of viewing time is twice the source time.
    expect(newShapeForPlayhead('arrow', 5, p, null, 2).start).toBeCloseTo(5 - 0.7, 9)
  })

  it('old items are never given a motion: they load and save without one', () => {
    const old = p20({ annotations: [text('t1', 1, 4)], shapes: [shape('s1', 'arrow', 1, 4), shape('s2', 'rect', 2, 5)], titles: [title('c1', 2, 6)] })
    const read = migrateProject(JSON.parse(JSON.stringify(old)) as Record<string, unknown>)
    expect(JSON.stringify(read.shapes)).toBe(JSON.stringify(old.shapes))
    expect(read.shapes!.every((s) => !s.enter && !s.exit)).toBe(true)
    expect(read.annotations.every((a) => !a.enter && !a.exit)).toBe(true)
    expect(read.titles!.every((c) => !c.enter && !c.exit)).toBe(true)
  })
})

describe('the group fields (test 79)', () => {
  const p = p20({
    annotations: [text('t1', 1, 4), { ...text('b1', 2, 5), style: 'badge', number: 'auto' } as Annotation],
    shapes: [shape('s1', 'arrow', 1, 4), shape('s2', 'highlight', 1, 4), shape('s3', 'rect', 1, 4), shape('s4', 'blur', 1, 4)],
    titles: [title('c1', 2, 6), title('c2', 7, 9)]
  })

  it('offer the motions every selected item allows', () => {
    const sections = fieldsFor(p, ['shape:s1', 'shape:s2', 'shape:s3', 'shape:s4'])
    const mark = sections.find((s) => s.cls === 'mark')!
    const enter = mark.fields.find((f) => f.field.id === 'mark.enter')!
    const options = (f: GroupField): unknown[] => (f.control.type === 'chips' ? f.control.options.map((o) => o.value) : [])
    // An arrow, a highlight and a box share Fade (and Default); the blur is a privacy shape, outside.
    expect(options(enter.field)).toEqual(['default', 'fade'])
    expect(enter.targets).toEqual(['shape:s1', 'shape:s2', 'shape:s3'])
    expect(options(fieldsFor(p, ['shape:s1', 'shape:s3'])[0].fields.find((f) => f.field.id === 'mark.enter')!.field)).toEqual(['default', 'fade', 'pop', 'grow', 'draw'])
    expect(options(fieldsFor(p, ['shape:s1', 'shape:s3'])[0].fields.find((f) => f.field.id === 'mark.exit')!.field)).toEqual(['default', 'fade', 'pop', 'grow'])
    // A text and a badge: the badge's entrances (no slides, typewriter or wipe).
    const text2 = fieldsFor(p, ['annotation:t1', 'annotation:b1'])[0]
    expect(options(text2.fields.find((f) => f.field.id === 'text.enter')!.field)).toEqual(['default', 'fade', 'pop', 'rise', 'drop', 'grow'])
    expect(sharedMotions('title', 'enter', [p.titles![0]])).toEqual(['default', 'fade', 'pop', 'rise', 'slide-left', 'slide-right', 'grow', 'typewriter', 'wipe'])
    // Blur is never offered.
    const callouts = GROUP_FIELDS.filter((x) => /^(text|mark|title)\.(enter|exit)$/.test(x.id))
    expect(callouts.map((f) => f.id)).toEqual(['text.enter', 'text.exit', 'mark.enter', 'mark.exit', 'title.enter', 'title.exit'])
    for (const f of callouts) expect(options(f)).not.toContain('blur')
  })

  it('change every selected item in one update', () => {
    const store = new EditStore(p)
    const keys = ['shape:s1', 'shape:s2', 'shape:s3'] as const
    store.update((q) => applyField(q, field('mark.enter'), [...keys], 'fade', ctx).project)
    expect(store.state.shapes!.slice(0, 3).map((s) => s.enter?.kind)).toEqual(['fade', 'fade', 'fade'])
    // The kind's default length where the item had no motion.
    expect(store.state.shapes![0].enter).toEqual({ kind: 'fade', duration: 0.35, strength: 1 })
    expect(store.state.shapes![3].enter).toBeUndefined()
    store.undo()
    expect(store.state).toBe(p)
    // A motion one of them does not allow changes only the others; Default removes it.
    const drawn = applyField(p, field('mark.enter'), [...keys], 'draw', ctx).project
    expect(drawn.shapes!.map((s) => s.enter?.kind)).toEqual(['draw', undefined, 'draw', undefined])
    const back = applyField(drawn, field('mark.enter'), [...keys], 'default', ctx).project
    expect(back.shapes!.every((s) => !('enter' in s))).toBe(true)
    // Sound: an effect, then the project's rule.
    const loud = applyField(p, field('title.sound'), ['title:c1', 'title:c2'], 'sfx:pop-soft', ctx).project
    expect(loud.titles!.map((c) => c.sound)).toEqual(['sfx:pop-soft', 'sfx:pop-soft'])
    expect(applyField(loud, field('title.sound'), ['title:c1'], 'project', ctx).project.titles![0].sound).toBeUndefined()
    expect(applyField(p, field('text.sound'), ['annotation:t1'], 'sfx:nope', ctx).project).toBe(p)
  })

  it('Copy look carries enter, exit, sound, colour and numbering', () => {
    const from = { ...text('b2', 1, 3), style: 'badge', number: 'auto', color: '#e4572e', numbering: 'bn', enter: { kind: 'grow', duration: 0.4, strength: 1 }, exit: { kind: 'pop', duration: 0.2, strength: 1 }, sound: 'none' } as Annotation
    const to = { ...text('b3', 4, 6), style: 'badge', number: 'auto' } as Annotation
    const q = p20({ annotations: [from, to] })
    const look = copyLook(q, 'annotation:b2', ctx)!
    for (const id of ['text.enter', 'text.exit', 'text.sound', 'text.color', 'text.numbering']) expect(id in look.values).toBe(true)
    const pasted = pasteLook(q, ['annotation:b3'], look, ctx).project.annotations[1]
    expect(pasted.enter).toEqual({ kind: 'grow', duration: 0.24, strength: 1 })
    expect(pasted.exit?.kind).toBe('pop')
    expect(pasted.sound).toBe('none')
    expect(pasted.color).toBe('#e4572e')
    expect(pasted.numbering).toBe('bn')
  })
})

describe('motions, pins and options', () => {
  it('withCallout keeps to what the item allows; null is the default', () => {
    const p = p20({ shapes: [shape('s1', 'highlight', 1, 4), shape('s2', 'blur', 1, 4)], titles: [title('c1', 2, 6)] })
    expect(withCallout(p, { kind: 'shape', id: 's1' }, { enter: { kind: 'draw', duration: 0.3, strength: 1 } })).toBe(p)
    const wiped = withCallout(p, { kind: 'shape', id: 's1' }, { enter: { kind: 'wipe', duration: 9, strength: 1 }, sound: 'sfx:pop-soft' })
    expect(wiped.shapes![0].enter).toEqual({ kind: 'wipe', duration: 1.5, strength: 1 })
    expect(wiped.shapes![0].sound).toBe('sfx:pop-soft')
    expect(withCallout(wiped, { kind: 'shape', id: 's1' }, { enter: null, sound: null }).shapes![0]).toEqual(p.shapes![0])
    expect(withCallout(p, { kind: 'shape', id: 's2' }, { enter: { kind: 'fade', duration: 0.3, strength: 1 } })).toBe(p)
    const typed = withCallout(p, { kind: 'title', id: 'c1' }, { enter: { kind: 'typewriter', duration: 0.8, strength: 1 } })
    expect(typed.titles![0].enter?.kind).toBe('typewriter')
  })

  it('moving a pin or a body writes where it shows to x, y (test 78)', () => {
    const { project, id } = addBubble(p20(), 4, { pin: { x: 0.4, y: 0.5 }, body: { dx: 0.12, dy: -0.1 }, x: 0.5, y: 0.4 })
    const moved = movePin(project, id, { x: 0.45, y: 0.55 }, { x: 0.31, y: 0.62 })
    const a = added(moved, id)
    expect(a.pin).toEqual({ x: 0.45, y: 0.55 })
    expect([a.x, a.y]).toEqual([0.31, 0.62])
    const body = added(moveBody(moved, id, { dx: -0.3, dy: 4 }, { x: 0.2, y: 0.9 }), id)
    expect(body.body).toEqual({ dx: -0.3, dy: 1 })
    expect([body.x, body.y]).toEqual([0.2, 0.9])
    expect(calloutOf(body).body).toEqual({ dx: -0.3, dy: 1 })
  })

  it('Follows the zoom and Tail', () => {
    const { project, id } = addBadge(p20(), 4, { pin: { x: 0.4, y: 0.5 }, x: 0.5, y: 0.4 }, null)
    const off = setFollowsZoom(project, id, false, { pin: { x: 0.4, y: 0.5 }, shownAt: { x: 0.52, y: 0.41 } })
    expect(added(off, id).pin).toBeUndefined()
    expect([added(off, id).x, added(off, id).y]).toEqual([0.52, 0.41])
    const on = setFollowsZoom(off, id, true, { pin: { x: 0.41, y: 0.5 }, shownAt: { x: 0.52, y: 0.41 } })
    expect(added(on, id).pin).toEqual({ x: 0.41, y: 0.5 })
    const b = addBubble(p20(), 4, { pin: { x: 0.4, y: 0.5 }, body: { dx: 0.12, dy: -0.1 }, x: 0.5, y: 0.4 })
    const none = added(setBubbleTail(b.project, b.id, null, { x: 0.5, y: 0.4 }), b.id)
    expect(none.pin).toBeUndefined()
    expect(none.body).toBeUndefined()
    expect(added(withBubbleColor(b.project, b.id, '#1D1D24'), b.id).color).toBe('#1d1d24')
  })

  it("a badge's number, text, Count with, Start from and colour", () => {
    const { project, id } = addBadge(p20(), 4, { pin: null, x: 0.5, y: 0.4 }, null)
    const own = added(withBadge(project, id, { number: 'text', text: 'ক্ষাAB12' }), id)
    expect(own.number).toBeUndefined()
    expect(own.text).toBe('ক্ষাAB')
    expect(badgeTextError('ক্ষাAB')).toBeNull()
    expect(badgeTextError('ক্ষাABC')).toBe('At most 3 letters')
    const a = added(withBadge(project, id, { numbering: 'A', startAt: 5.4, color: '#FFD60A' }), id)
    expect([a.numbering, a.startAt, a.color]).toEqual(['A', 5, '#ffd60a'])
    const back = added(withBadge(withBadge(project, id, { numbering: 'A', startAt: 5 }), id, { numbering: '1', startAt: null, color: null }), id)
    expect(back).toEqual(added(project, id))
    expect(withBadgesByChapter(project, false).effects.badgesByChapter).toBe(false)
  })

  it('Count with offers Bangla always and the caption or transcript language when it has digits of its own', () => {
    expect(countWithOptions({} as Project).map((o) => o.value)).toEqual(['1', 'A', 'bn'])
    expect(countWithOptions({ transcript: { language: 'hi' } } as Project).map((o) => o.value)).toEqual(['1', 'A', 'bn', 'hi'])
    expect(countWithOptions({ transcript: { language: 'fr' } } as Project).map((o) => o.value)).toEqual(['1', 'A', 'bn'])
    const bn = countWithOptions({} as Project).find((o) => o.value === 'bn')!
    expect(bn.lang).toBe('bn')
    expect(bn.sample).toBe('১ ২ ৩')
  })

  it('Calm motion is written on, and removed when turned off', () => {
    const p = p20()
    const on = withCalm(p, true)
    expect(on.effects.calm).toBe(true)
    const off = withCalm(on, false)
    expect('calm' in off.effects).toBe(false)
    expect(withCalm(p, false)).toBe(p)
  })

  it("a title card's show time is past its own entrance", () => {
    const clips = [{ id: 'c', start: 0, end: 20, speed: 1 }]
    expect(titleShowTime({ start: 2, end: 8 }, 0, clips)).toBeCloseTo(2.36, 9)
    expect(titleShowTime({ start: 2, end: 8, enter: { kind: 'typewriter', duration: 1.2, strength: 1 } }, 0, clips)).toBeCloseTo(3.21, 9)
  })
})
