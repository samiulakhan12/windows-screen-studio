import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cropView } from '../src/shared/engine/crop'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { copyLook, GROUP_FIELDS, ITEM_MOTIONS, pasteLook, type FieldCtx } from '../src/shared/editor/groupEdit'
import { DEFAULT_ZOOM_STYLE, focusPathFor } from '../src/shared/engine/zoom'
import { calloutPlace } from '../src/shared/render/callouts'
import type { Annotation, Chapter, CursorTrack, Project, Shape, TitleCard } from '../src/shared/types'

/*
 * The callout panels (docs/design/editing-polish.md §2.3, §12, §19.1 test 45) without a DOM: the
 * components are called as functions (as tests/followSection.test.ts does), with React's hooks
 * swapped for a few lines and the editor's contexts answered here.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

let store: { state: Project; updates: number; keys: (string | undefined)[]; update: (fn: (p: Project) => Project, key?: string) => void; beginGesture(): void; endGesture(): void }
const player = { time: 4, moving: false, pausedFrame: (): { scene: unknown } | null => null, subscribe: () => () => undefined }
const commands: string[] = []
const contexts: { group?: unknown; keymap?: unknown } = {}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemo: (fn: () => unknown) => fn(),
  useRef: (init: unknown) => ({ current: init }),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useContext: (ctx: unknown) => {
    if (ctx === contexts.keymap) return KEYMAP
    if (ctx === contexts.group) return { command: (id: string) => commands.push(id), notice: () => undefined, select: () => undefined }
    return { store, player }
  }
}))

const { DEFAULT_KEYMAP: KEYMAP } = await import('../src/shared/editor/shortcuts')
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const P = '../src/renderer/src/editor/'
type Component = (props: unknown) => unknown
const { CalloutSection, PRIVACY_NOTE } = (await import(/* @vite-ignore */ `${P}panels/CalloutSection`)) as { CalloutSection: Component; PRIVACY_NOTE: string }
const { BadgeSection } = (await import(/* @vite-ignore */ `${P}panels/BadgeSection`)) as { BadgeSection: Component }
const { BubbleSection } = (await import(/* @vite-ignore */ `${P}panels/BubbleSection`)) as { BubbleSection: Component }
const { CalmMotionRow, CALM_HINT } = (await import(/* @vite-ignore */ `${P}panels/CalmMotionRow`)) as { CalmMotionRow: Component; CALM_HINT: string }
const { calloutMapping } = (await import(/* @vite-ignore */ `${P}calloutView`)) as { calloutMapping: (scene: unknown, t: number) => { frame: Parameters<typeof calloutPlace>[2] } }
contexts.group = ((await import(/* @vite-ignore */ `${P}groupContext`)) as { GroupContext: unknown }).GroupContext
contexts.keymap = ((await import(/* @vite-ignore */ `${P}keymapContext`)) as { KeymapContext: unknown }).KeymapContext

/** Every element under `root`, components called. */
function render(root: El): El[] {
  const out: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
    out.push(el)
    walk(el.props.children)
  }
  walk(root)
  return out
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}
const byId = (els: El[], id: string): El | undefined => els.find((e) => e.props['data-testid'] === id)
/** A select's option labels, and its <label>'s text. */
const optionsOf = (els: El[], id: string): string[] => {
  const select = byId(els, id)!
  return render({ type: 'div', props: { children: select.props.children } })
    .filter((e) => e.type === 'option')
    .map((o) => textOf(o.props.children))
}
const labelOf = (els: El[], id: string): string => {
  const label = els.find((e) => e.type === 'label' && render({ type: 'div', props: { children: e.props.children } }).some((x) => x.props['data-testid'] === id))!
  return textOf((label.props.children as unknown[])[0])
}
const radios = (els: El[], id: string): El[] => render({ type: 'div', props: { children: byId(els, id)!.props.children } }).filter((e) => e.props.role === 'radio')
const choose = (els: El[], id: string, value: string): void => (byId(els, id)!.props.onChange as (e: unknown) => void)({ target: { value } })

const shape = (id: string, kind: Shape['kind'], extra: Partial<Shape> = {}): Shape => ({ id, kind, start: 2, end: 6, x: 0.2, y: 0.2, w: 0.3, h: 0.2, color: '#ff3b30', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5, ...extra })
const text = (id: string, extra: Partial<Annotation> & Record<string, unknown> = {}): Annotation => ({ id, start: 2, end: 6, text: 'Save it', x: 0.5, y: 0.4, size: 0.05, style: 'pill', ...extra }) as Annotation
const card: TitleCard = { id: 'c1', start: 2, end: 6, title: 'Intro', style: 'centered', background: 'blur' } as TitleCard

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 } })
  return {
    ...p,
    annotations: [text('t1'), text('b1', { style: 'badge', number: 'auto', text: '' }), text('u1', { style: 'bubble', text: 'Click', pin: { x: 0.4, y: 0.5 }, body: { dx: 0.12, dy: -0.1 } })],
    shapes: [shape('s1', 'arrow'), shape('s2', 'line'), shape('s3', 'rect'), shape('s4', 'ellipse'), shape('s5', 'highlight'), shape('s6', 'blur'), shape('s7', 'pixelate')],
    titles: [card],
    ...extra
  }
}

beforeEach(() => {
  commands.length = 0
  player.pausedFrame = () => null
  store = {
    state: project(),
    updates: 0,
    keys: [],
    update(fn, key) {
      const next = fn(store.state)
      if (next === store.state) return
      store.updates++
      store.keys.push(key)
      store.state = next
    },
    beginGesture() {},
    endGesture() {}
  }
})

const section = (selection: unknown): El[] => render({ type: CalloutSection, props: { project: store.state, selection } })
const GRAPHICS = Object.fromEntries(ITEM_MOTIONS.map((o) => [o.value, o.label]))

describe('CalloutSection (test 45)', () => {
  it('labels Comes in and Goes out, with the Graphics tab’s motion names', () => {
    const els = section({ kind: 'annotation', id: 't1' })
    expect(textOf(els.find((e) => e.type === 'h3'))).toBe('Animation')
    expect(labelOf(els, 'callout-enter')).toBe('Comes in')
    expect(labelOf(els, 'callout-exit')).toBe('Goes out')
    expect(optionsOf(els, 'callout-enter')).toEqual(['Default', GRAPHICS.fade, GRAPHICS.pop, GRAPHICS.rise, GRAPHICS.drop, GRAPHICS['slide-left'], GRAPHICS['slide-right'], GRAPHICS.grow, GRAPHICS.typewriter, 'Wipe'])
    expect(optionsOf(els, 'callout-exit')).toEqual(['Default', 'Fade', 'Pop', 'Rise', 'Slide left', 'Slide right', 'Grow'])
    expect(labelOf(els, 'callout-sound')).toBe('Sound')
    expect(optionsOf(els, 'callout-sound').slice(0, 2)).toEqual(['Same as the project', 'None'])
    expect(optionsOf(els, 'callout-sound').length).toBeGreaterThan(2)
  })

  it('Draw only for arrows, lines and boxes, Wipe for highlights and texts, nothing for blur and pixelate', () => {
    for (const id of ['s1', 's2', 's3', 's4']) {
      const enter = optionsOf(section({ kind: 'shape', id }), 'callout-enter')
      expect(enter).toEqual(['Default', 'Fade', 'Pop', 'Grow', 'Draw'])
      expect(optionsOf(section({ kind: 'shape', id }), 'callout-exit')).toEqual(['Default', 'Fade', 'Pop', 'Grow'])
    }
    expect(optionsOf(section({ kind: 'shape', id: 's5' }), 'callout-enter')).toEqual(['Default', 'Fade', 'Wipe'])
    expect(optionsOf(section({ kind: 'shape', id: 's5' }), 'callout-exit')).toEqual(['Default', 'Fade'])
    expect(optionsOf(section({ kind: 'annotation', id: 't1' }), 'callout-enter')).not.toContain('Draw')
    expect(optionsOf(section({ kind: 'title', id: 'c1' }), 'callout-enter')).toEqual(['Default', 'Fade', 'Pop', 'Rise', 'Slide left', 'Slide right', 'Grow', 'Typewriter', 'Wipe'])
    for (const id of ['s6', 's7']) {
      const els = section({ kind: 'shape', id })
      expect(byId(els, 'callout-enter')).toBeUndefined()
      expect(byId(els, 'callout-exit')).toBeUndefined()
      expect(els.some((e) => e.type === 'p' && textOf(e) === PRIVACY_NOTE)).toBe(true)
    }
    // Nothing for a selection that is not a callout.
    expect(section({ kind: 'zoom', id: 'z' })).toEqual([])
  })

  it('one update per change: Comes in, Speed, Goes out, Sound', () => {
    choose(section({ kind: 'shape', id: 's1' }), 'callout-enter', 'draw')
    expect(store.updates).toBe(1)
    expect(store.state.shapes![0].enter).toEqual({ kind: 'draw', duration: 0.35, strength: 1 })
    const speed = byId(section({ kind: 'shape', id: 's1' }), 'callout-speed')!
    expect(speed.props).toMatchObject({ type: 'range', 'aria-label': 'Speed', 'aria-valuetext': '0.35 seconds', min: 0.1, max: 1.5 })
    ;(speed.props.onChange as (e: unknown) => void)({ target: { value: '0.6' } })
    expect(store.updates).toBe(2)
    expect(store.state.shapes![0].enter!.duration).toBe(0.6)
    choose(section({ kind: 'shape', id: 's1' }), 'callout-exit', 'pop')
    choose(section({ kind: 'shape', id: 's1' }), 'callout-sound', 'none')
    expect(store.updates).toBe(4)
    expect(store.state.shapes![0].exit?.kind).toBe('pop')
    expect(store.state.shapes![0].sound).toBe('none')
    // Default takes the motion away again; the Speed row goes with it.
    choose(section({ kind: 'shape', id: 's1' }), 'callout-enter', 'default')
    expect(store.state.shapes![0].enter).toBeUndefined()
    expect(byId(section({ kind: 'shape', id: 's1' }), 'callout-speed')).toBeUndefined()
    expect(store.updates).toBe(5)
    // The Play toggle names its effect and is off until an effect is chosen.
    choose(section({ kind: 'shape', id: 's1' }), 'callout-sound', 'sfx:pop-soft')
    const play = byId(section({ kind: 'shape', id: 's1' }), 'callout-sound-play')!
    expect(play.props['aria-pressed']).toBe(false)
    expect(String(play.props['aria-label'])).toMatch(/^Play /)
    expect(play.props.disabled).toBe(false)
  })

  it('Copy look carries the motions', () => {
    const ctx: FieldCtx = { crop: null, cursorValid: true, style: DEFAULT_ZOOM_STYLE, background: { type: 'color', color: '#202020' } }
    choose(section({ kind: 'shape', id: 's3' }), 'callout-enter', 'grow')
    choose(section({ kind: 'shape', id: 's3' }), 'callout-exit', 'pop')
    const look = copyLook(store.state, 'shape:s3', ctx)!
    expect(look.values['mark.enter']).toBe('grow')
    expect(look.values['mark.exit']).toBe('pop')
    const pasted = pasteLook(store.state, ['shape:s4'], look, ctx).project.shapes![3]
    expect(pasted.enter?.kind).toBe('grow')
    expect(pasted.exit?.kind).toBe('pop')
    expect(GROUP_FIELDS.find((f) => f.id === 'mark.enter')!.look).toBe(true)
  })
})

describe('BadgeSection, BubbleSection and Calm motion', () => {
  it("a badge's Number, its own text checked by graphemes, and Count with's Bangla sample", () => {
    const els = render({ type: BadgeSection, props: { project: store.state, selection: { kind: 'annotation', id: 'b1' } } })
    expect(byId(els, 'badge-section')).toBeDefined()
    expect(radios(els, 'badge-number').map((r) => textOf(r.props.children))).toEqual(['Automatic (1)', 'Your own text'])
    const counts = radios(els, 'badge-count-with')
    expect(counts.map((r) => r.props['data-value'])).toEqual(['1', 'A', 'bn'])
    const bn = counts[2]
    expect(bn.props['aria-label']).toBe('Bangla digits, ১ ২ ৩')
    expect(render({ type: 'div', props: { children: bn.props.children } }).some((e) => e.props.lang === 'bn')).toBe(true)
    ;(bn.props.onClick as () => void)()
    expect(store.state.annotations[1].numbering).toBe('bn')
    expect(store.updates).toBe(1)
    ;(radios(els, 'badge-number')[1].props.onClick as () => void)()
    expect(store.state.annotations[1].number).toBeUndefined()
    const own = render({ type: BadgeSection, props: { project: store.state, selection: { kind: 'annotation', id: 'b1' } } })
    const field = byId(own, 'badge-text')!
    expect(field.props.maxLength).toBeUndefined()
    ;(field.props.onChange as (e: unknown) => void)({ target: { value: 'ক্ষা' } })
    expect(store.state.annotations[1].text).toBe('ক্ষা')
    ;(field.props.onChange as (e: unknown) => void)({ target: { value: 'ABCD' } })
    expect(store.state.annotations[1].text).toBe('ক্ষা')
    expect(store.updates).toBe(3)
    // Not shown for anything but a badge.
    expect(render({ type: BadgeSection, props: { project: store.state, selection: { kind: 'annotation', id: 't1' } } })).toEqual([])
  })

  it("Restart at each chapter counts the user's chapters, as the numbering does: found chapters waiting for review restart nothing (smart-tools.md §7.7)", () => {
    const found = (id: string, t: number): Chapter => ({ id, t, title: `Part ${id}`, auto: { by: 'find', from: ['page'], name: 'number' } })
    const badge = (): El[] => render({ type: BadgeSection, props: { project: store.state, selection: { kind: 'annotation', id: 'b1' } } })
    const restart = (): El => byId(badge(), 'badge-restart')!
    store.state = project({ chapters: [found('f1', 0), found('f2', 4), found('f3', 7)] })
    expect(restart().props).toMatchObject({ disabled: true, checked: false, 'aria-describedby': 'badge-restart-hint' })
    expect(textOf(badge().find((e) => e.props.id === 'badge-restart-hint'))).toBe('Keep or add two chapters or more to count again in each.')
    // Two kept: offered, and on as the numbering then restarts.
    store.state = { ...store.state, chapters: store.state.chapters!.map((c) => (c.id === 'f3' ? c : { id: c.id, t: c.t, title: c.title })) }
    expect(restart().props).toMatchObject({ disabled: false, checked: true })
  })

  it("a bubble's Colour and Tail; Add step badge and Add speech bubble run the commands", () => {
    const els = render({ type: BubbleSection, props: { project: store.state, selection: { kind: 'annotation', id: 'u1' } } })
    expect(byId(els, 'bubble-section')).toBeDefined()
    expect(radios(els, 'bubble-colour').map((r) => r.props['aria-label'])).toEqual(['White', 'Dark'])
    ;(radios(els, 'bubble-colour')[1].props.onClick as () => void)()
    expect(store.state.annotations[2].color).toBe('#1d1d24')
    expect(radios(els, 'bubble-tail').map((r) => textOf(r.props.children))).toEqual(['Pointing', 'None'])
    ;(byId(els, 'add-step-badge')!.props.onClick as () => void)()
    ;(byId(els, 'add-speech-bubble')!.props.onClick as () => void)()
    expect(commands).toEqual(['addStepBadge', 'addSpeechBubble'])
    // Without a bubble selected, the add buttons still show.
    const none = render({ type: BubbleSection, props: { project: store.state, selection: null } })
    expect(byId(none, 'bubble-section')).toBeUndefined()
    expect(byId(none, 'add-step-badge')).toBeDefined()
  })

  it('Calm motion: a switch with its hint, written in one update and removed when off', () => {
    const els = render({ type: CalmMotionRow, props: { project: store.state } })
    const sw = byId(els, 'calm-motion')!
    expect(sw.props.role).toBe('switch')
    expect(els.some((e) => e.type === 'p' && textOf(e) === CALM_HINT)).toBe(true)
    ;(sw.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    expect(store.state.effects.calm).toBe(true)
    ;(byId(render({ type: CalmMotionRow, props: { project: store.state } }), 'calm-motion')!.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect('calm' in store.state.effects).toBe(false)
    expect(store.updates).toBe(2)
  })
})

describe('Follows the zoom and Tail: Pointing keep the pin on the picture (§2.3)', () => {
  const track = { valid: false, samples: [], clicks: [], keys: [] } as unknown as CursorTrack
  /** The editor's scene for `p` (the drawn project in the crop's view), as the paused preview holds it. */
  const sceneOf = (p: Project): unknown => {
    const view = cropView(p, track)
    return { project: view.project, cursor: view.cursor, cursorPath: new SmoothedTrack(view.cursor.samples, p.duration, p.cursor.smoothing), focusPath: focusPathFor(view.cursor.samples, p.duration), ...(view.crop ? { crop: view.crop } : {}) }
  }
  /** How annotation `id` is drawn at its start (null: not drawn). */
  const placeAtStart = (id: string): ReturnType<typeof calloutPlace> => {
    const a = store.state.annotations.find((x) => x.id === id)!
    return calloutPlace(a, a.style === 'badge' ? '1' : null, calloutMapping(sceneOf(store.state), a.start).frame, (t, px) => t.length * px * 0.55)
  }

  it('a badge on the padding turned to follow the zoom is still drawn, on the picture’s edge', () => {
    store.state = project({ annotations: [text('b1', { style: 'badge', number: 'auto', text: '', x: 0.02, y: 0.5 })] })
    player.pausedFrame = () => ({ scene: sceneOf(store.state) })
    expect(placeAtStart('b1')).not.toBeNull()
    const els = render({ type: BadgeSection, props: { project: store.state, selection: { kind: 'annotation', id: 'b1' } } })
    ;(byId(els, 'badge-follows-zoom')!.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    const a = store.state.annotations[0]
    expect(store.updates).toBe(1)
    expect(a.pin!.x).toBeGreaterThanOrEqual(0)
    expect(placeAtStart('b1')).not.toBeNull()
    // Where it shows at its start is written to x, y: where it is drawn, beside the padding.
    expect(a.x).toBeGreaterThan(0.02)
    expect(a.y).toBeCloseTo(0.5, 6)
  })

  it('Tail: Pointing on a bubble near the bottom points at the picture, the body above its tip', () => {
    store.state = project({ annotations: [text('u2', { style: 'bubble', text: 'Click', x: 0.5, y: 0.97 })] })
    player.pausedFrame = () => ({ scene: sceneOf(store.state) })
    const els = render({ type: BubbleSection, props: { project: store.state, selection: { kind: 'annotation', id: 'u2' } } })
    ;(radios(els, 'bubble-tail')[0].props.onClick as () => void)()
    const a = store.state.annotations[0]
    expect(store.updates).toBe(1)
    expect(a.pin!.y).toBeLessThanOrEqual(1)
    expect(a.body).toEqual({ dx: 0, dy: -0.12 })
    const place = placeAtStart('u2')!
    expect(place.pin).not.toBeNull()
    expect(place.tail).not.toBeNull()
    // x, y: where the body shows at its start, 0.12 S above the tip.
    const S = 1080
    expect(a.x).toBeCloseTo(place.pin!.x / 1920, 6)
    expect(a.y).toBeCloseTo((place.pin!.y - 0.12 * S) / 1080, 6)
    // Away from the edges it is as before: the tip 0.12 S below the body, which stays where it is.
    store.state = project({ annotations: [text('u3', { style: 'bubble', text: 'Click', x: 0.5, y: 0.4 })] })
    player.pausedFrame = () => ({ scene: sceneOf(store.state) })
    const mid = render({ type: BubbleSection, props: { project: store.state, selection: { kind: 'annotation', id: 'u3' } } })
    ;(radios(mid, 'bubble-tail')[0].props.onClick as () => void)()
    const b = store.state.annotations[0]
    expect(b.x).toBeCloseTo(0.5, 9)
    expect(b.y).toBeCloseTo(0.4, 9)
    expect(placeAtStart('u3')!.tail).not.toBeNull()
  })
})
