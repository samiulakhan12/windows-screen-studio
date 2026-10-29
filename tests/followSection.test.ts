import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_IDS, commandInfo } from '../src/shared/editor/commands'
import { followStatus } from '../src/shared/editor/followEdit'
import { checkShortcut, DEFAULT_KEYMAP, findConflicts, reservedReason } from '../src/shared/editor/shortcuts'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import type { AspectRatio, Project, ReframeSettings } from '../src/shared/types'

/*
 * Style › Vertical framing (docs/design/vertical-video.md §2.5, test 56) without a DOM: the section
 * is called as a function, as tests/zoomPanelCrop.test.ts renders the Zoom tab, with React's hooks
 * swapped for a few lines and its contexts (the editor's store and player, the keymap, the group's
 * commands and the section's own cursor flag) answered here. The view's limits (part P1's
 * followLimits) are answered by each test.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

const limitsOf = vi.hoisted(() => ({ value: null as null | { base: { w: number; h: number }; level: number; mag: number; fit: number; cap: number } }))
vi.mock('../src/shared/engine/reframe', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  followLimits: () => limitsOf.value
}))

let store: { state: Project; updates: number; update: (fn: (p: Project) => Project, key?: string) => void }
const player = { time: 0, subscribe: () => () => undefined }
let env = { cursorValid: true, reveal: 0 }
const commands: string[] = []
const contexts: { follow?: unknown; group?: unknown; keymap?: unknown } = {}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemo: (fn: () => unknown) => fn(),
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useContext: (ctx: unknown) => {
    if (ctx === contexts.follow) return env
    if (ctx === contexts.keymap) return DEFAULT_KEYMAP
    if (ctx === contexts.group) return { command: (id: string) => commands.push(id) }
    return { store, player }
  }
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/editor/panels/FollowSection'
const GROUP = '../src/renderer/src/editor/groupContext'
const KEYMAP = '../src/renderer/src/editor/keymapContext'
const section = (await import(/* @vite-ignore */ SECTION)) as { FollowSection: (props: unknown) => unknown; FollowEnvContext: unknown }
contexts.follow = section.FollowEnvContext
contexts.group = ((await import(/* @vite-ignore */ GROUP)) as { GroupContext: unknown }).GroupContext
contexts.keymap = ((await import(/* @vite-ignore */ KEYMAP)) as { KeymapContext: unknown }).KeymapContext

/** The section for the store's project (vw × vh: the recording as cropped): every element under it, components called. */
function render(vw = 1920, vh = 1080, onMakeVertical: () => void = () => undefined): El[] {
  const out: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
    out.push(el)
    walk(el.props.children)
  }
  walk({ type: section.FollowSection, props: { project: store.state, vw, vh, onMakeVertical } })
  return out
}

/** The text of an element (its strings, nested). */
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}
const byId = (els: El[], id: string): El | undefined => els.find((e) => e.props['data-testid'] === id)
const ids = (els: El[]): string[] => els.map((e) => e.props['data-testid'] as string).filter(Boolean)
const hints = (els: El[]): string[] => els.filter((e) => e.type === 'p').map((e) => textOf(e))
/** The checkbox, range or chip buttons inside the element with `id`. */
const inputIn = (els: El[], id: string): El => {
  const all: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
    all.push(el)
    walk(el.props.children)
  }
  walk(byId(els, id)!.props.children)
  return all.find((e) => e.type === 'input')!
}
const chipsIn = (els: El[], id: string): string[] => {
  const host = byId(els, id)!
  const all: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
    if (el.type === 'button') all.push(el)
    walk(el.props.children)
  }
  walk(host.props.children)
  return all.map((b) => `${textOf(b)}|${b.props.title}`)
}

const capture = { method: 'native', cursorInVideo: false, region: null, target: 'screen' } as const

function project(aspect: AspectRatio, reframe?: Partial<ReframeSettings> | null, extra: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture })
  const out: Project = { ...p, style: { ...p.style, aspectRatio: aspect }, ...extra }
  return reframe ? { ...out, reframe: { ...DEFAULT_REFRAME, ...reframe } } : out
}
const withCamera = (p: Project): Project => ({ ...p, hasWebcam: true, webcam: { ...p.webcam, show: true } })

beforeEach(() => {
  env = { cursorValid: true, reveal: 0 }
  commands.length = 0
  limitsOf.value = { base: { w: 0.3164, h: 1 }, level: 1, mag: 1.78, fit: 0.3164, cap: 1.69 }
  store = {
    state: project('9:16'),
    updates: 0,
    update(fn) {
      const next = fn(store.state)
      if (next === store.state) return
      store.updates++
      store.state = next
    }
  }
})

describe('followStatus (test 56)', () => {
  it('says unavailable, off, following or no-input', () => {
    expect(followStatus(project('16:9'), true, 1920, 1080)).toBe('unavailable')
    expect(followStatus(project('auto', { mode: 'follow' }), true, 1920, 1080)).toBe('unavailable')
    expect(followStatus(project('9:16', { mode: 'follow' }), true, 1080, 1920)).toBe('unavailable')
    expect(followStatus(project('9:16'), true, 1920, 1080)).toBe('off')
    expect(followStatus(project('9:16', { mode: 'fit' }), true, 1920, 1080)).toBe('off')
    expect(followStatus(project('9:16', { mode: 'follow' }), true, 1920, 1080)).toBe('following')
    expect(followStatus(project('1:1', { mode: 'follow' }), false, 1440, 1080)).toBe('no-input')
    expect(followStatus(project('4:3', { mode: 'follow' }), true, 1920, 1080)).toBe('following')
    // The recording as cropped decides: a 1:1 frame of a 1200 × 1080 crop cannot follow.
    expect(followStatus(project('1:1', { mode: 'follow' }), true, 1200, 1080)).toBe('unavailable')
  })
})

describe('the Vertical framing section (test 56)', () => {
  it('shows nothing where neither this frame nor a 9:16 one could follow (a tall recording)', () => {
    store.state = project('16:9')
    const els = render(1080, 1920)
    expect(ids(els)).toEqual([])
    expect(els.some((e) => typeof e.type === 'string')).toBe(false)
  })

  it('shows only the callout where this frame cannot follow but a 9:16 one could', () => {
    store.state = project('16:9')
    const made = vi.fn()
    const els = render(1920, 1080, made)
    expect(ids(els)).toEqual(['framing-section', 'vertical-callout'])
    expect(textOf(byId(els, 'vertical-callout'))).toBe('Making a Short?Make a vertical version')
    ;(els.find((e) => e.type === 'button')!.props.onClick as () => void)()
    expect(made).toHaveBeenCalledTimes(1)
    for (const aspect of ['auto', '16:9'] as const) {
      store.state = project(aspect)
      expect(ids(render())).toContain('vertical-callout')
    }
  })

  it('off: the toggle with its hint, and the text toggle in a tall frame', () => {
    const els = render()
    expect(ids(els)).toEqual(['framing-section', 'follow-toggle', 'app-safe-toggle'])
    expect(inputIn(els, 'follow-toggle').props).toMatchObject({ 'aria-label': 'Follow the action', checked: false })
    expect(hints(els)).toEqual([
      'Your whole screen is shrunk to fit this shape. Turn this on to crop in and follow your cursor, clicks and typing.',
      "Places captions, key presses, your logo and lower-third titles where TikTok, Reels and Shorts don't put buttons."
    ])
    // A square frame has no text toggle.
    store.state = project('1:1')
    expect(ids(render())).toEqual(['framing-section', 'follow-toggle'])
  })

  it('following: the status, how close, movement, Hold the view here and the tip', () => {
    store.state = project('9:16', { mode: 'follow' })
    const els = render()
    expect(ids(els)).toEqual(['framing-section', 'follow-toggle', 'follow-status', 'follow-level', 'follow-pace', 'follow-hold', 'app-safe-toggle'])
    expect(byId(els, 'follow-status')!.props['data-state']).toBe('following')
    expect(hints(els)).toContain('Following your cursor, clicks and typing.')
    expect(hints(els)).toContain('Drag the picture to aim the view. Zooms still work inside it.')
    expect(hints(els)).toContain('A stray click pulled the view away? Ignore the click (Zoom › Selected click) and the view stays put.')
    expect(hints(els)).not.toContain('Limited to keep the picture sharp.')
    expect(inputIn(els, 'follow-level').props).toMatchObject({ 'aria-label': 'How close', min: 1, max: 2, step: 0.05, value: 1 })
    expect(chipsIn(els, 'follow-pace')).toEqual(['Calm|Moves less, and more slowly', 'Balanced|Follows each new place you work in', 'Lively|Reacts sooner and moves faster'])
    expect(textOf(byId(els, 'follow-hold'))).toBe('Hold the view here')
    expect(byId(els, 'follow-hold')!.props.title).toBe('Hold the view here (R)')
    ;(byId(els, 'follow-hold')!.props.onClick as () => void)()
    expect(commands).toEqual(['holdView'])
  })

  it('without cursor data: the no-input status and where the view rests (left to right only while the view has the full height)', () => {
    env.cursorValid = false
    store.state = project('9:16', { mode: 'follow' })
    let els = render()
    expect(byId(els, 'follow-status')!.props['data-state']).toBe('no-input')
    expect(hints(els)).toContain('This recording has no cursor data, so the view stays where you put it.')
    expect(hints(els).some((h) => h.startsWith('A stray click'))).toBe(false)
    expect(ids(els)).toContain('follow-rest-x')
    expect(ids(els)).not.toContain('follow-rest-y')
    expect(inputIn(els, 'follow-rest-x').props).toMatchObject({ 'aria-label': 'Left to right', min: 0, max: 1, step: 0.01, value: 0.5 })
    // Closer than the full height: top to bottom too.
    limitsOf.value = { base: { w: 0.211, h: 0.667 }, level: 1.5, mag: 2.67, fit: 0.211, cap: 1.12 }
    els = render()
    expect(ids(els)).toContain('follow-rest-y')
    // One update per change, stored in the full frame.
    ;(inputIn(els, 'follow-rest-x').props.onChange as (e: unknown) => void)({ target: { value: '0' } })
    expect(store.updates).toBe(1)
    expect(store.state.reframe?.rest).toEqual({ x: 0, y: 0.5 })
    // Cropped to the right half, the slider shows and sets positions in the view.
    store.state = { ...store.state, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }
    els = render(960, 1080)
    expect(inputIn(els, 'follow-rest-x').props.value).toBe(0)
    ;(inputIn(els, 'follow-rest-x').props.onChange as (e: unknown) => void)({ target: { value: '0.5' } })
    expect(store.state.reframe?.rest).toEqual({ x: 0.75, y: 0.5 })
  })

  it('says when How close is limited to keep the picture sharp', () => {
    store.state = project('9:16', { mode: 'follow', level: 2 })
    limitsOf.value = { base: { w: 0.18, h: 0.56 }, level: 1.69, mag: 3, fit: 0.18, cap: 1 }
    expect(hints(render())).toContain('Limited to keep the picture sharp.')
  })

  it('the camera chips: a tall frame with the camera shown; the band size with a band; square frames keep the bubble', () => {
    store.state = withCamera(project('9:16', { mode: 'follow' }))
    let els = render()
    expect(chipsIn(els, 'follow-camera')).toEqual([
      'Band on top|Your camera above the screen',
      'Band at the bottom|Your camera under the screen',
      'Bubble|Your camera bubble over the screen, as in the Camera tab'
    ])
    expect(inputIn(els, 'follow-band').props).toMatchObject({ 'aria-label': 'Camera size', min: 0.2, max: 0.5, step: 0.01, value: 0.32 })
    expect(hints(els).some((h) => h.startsWith('The apps put their captions'))).toBe(false)
    store.state = withCamera(project('9:16', { mode: 'follow', camera: 'bottom' }))
    expect(hints(render())).toContain('The apps put their captions over the bottom of the video, so a band on top usually stays clearer.')
    store.state = withCamera(project('9:16', { mode: 'follow', camera: 'bubble' }))
    els = render()
    expect(ids(els)).toContain('follow-camera')
    expect(ids(els)).not.toContain('follow-band')
    // No camera shown: no chips.
    store.state = project('9:16', { mode: 'follow' })
    expect(ids(render())).not.toContain('follow-camera')
    store.state = { ...withCamera(project('9:16', { mode: 'follow' })), webcam: { ...withCamera(project('9:16')).webcam, show: false } }
    expect(ids(render())).not.toContain('follow-camera')
    // Square: the bubble, said once.
    store.state = withCamera(project('1:1', { mode: 'follow', camera: 'bubble' }))
    els = render()
    expect(ids(els)).not.toContain('follow-camera')
    expect(ids(els)).not.toContain('follow-band')
    expect(hints(els)).toContain('Square videos keep the camera bubble.')
  })

  it('Follow the action writes the settings in one update; off keeps them with mode fit', () => {
    const toggle = (on: boolean): void => (inputIn(render(), 'follow-toggle').props.onChange as (e: unknown) => void)({ target: { checked: on } })
    toggle(true)
    expect(store.updates).toBe(1)
    expect(store.state.reframe).toEqual(DEFAULT_REFRAME)
    toggle(false)
    expect(store.updates).toBe(2)
    expect(store.state.reframe).toEqual({ ...DEFAULT_REFRAME, mode: 'fit' })
    toggle(true)
    expect(store.state.reframe).toEqual(DEFAULT_REFRAME)
    // A square frame starts with the bubble and text placed as before.
    store.state = project('1:1')
    toggle(true)
    expect(store.state.reframe).toEqual({ ...DEFAULT_REFRAME, camera: 'bubble', appSafe: false })
  })

  it('Keep text clear of app buttons never turns following on', () => {
    ;(inputIn(render(), 'app-safe-toggle').props.onChange as (e: unknown) => void)({ target: { checked: true } })
    expect(store.updates).toBe(1)
    expect(store.state.reframe).toEqual({ ...DEFAULT_REFRAME, mode: 'fit', appSafe: true })
    expect(inputIn(render(), 'follow-toggle').props.checked).toBe(false)
    expect(inputIn(render(), 'app-safe-toggle').props.checked).toBe(true)
  })

  it('the movement and the camera are one update each', () => {
    store.state = withCamera(project('9:16', { mode: 'follow' }))
    const click = (id: string, label: string): void => {
      const all: El[] = []
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk)
        if (!node || typeof node !== 'object' || !('props' in node)) return
        const el = node as El
        if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
        if (el.type === 'button') all.push(el)
        walk(el.props.children)
      }
      walk(byId(render(), id)!.props.children)
      ;(all.find((b) => textOf(b) === label)!.props.onClick as () => void)()
    }
    click('follow-pace', 'Calm')
    click('follow-camera', 'Band at the bottom')
    expect(store.updates).toBe(2)
    expect(store.state.reframe).toMatchObject({ pace: 'calm', camera: 'bottom', mode: 'follow' })
  })

  it('View at the playhead: a zoom with a fixed point at the playhead', () => {
    store.state = project('9:16', { mode: 'follow' }, { zooms: [{ id: 'z', start: 2, end: 5, scale: 1, focus: { mode: 'fixed', x: 0.3, y: 0.4 }, auto: false }] })
    player.time = 1
    expect(ids(render())).not.toContain('follow-view-x')
    player.time = 3
    const els = render()
    expect(inputIn(els, 'follow-view-x').props).toMatchObject({ 'aria-label': 'Left to right', value: 0.3 })
    expect(inputIn(els, 'follow-view-y').props).toMatchObject({ 'aria-label': 'Top to bottom', value: 0.4 })
    ;(inputIn(els, 'follow-view-x').props.onChange as (e: unknown) => void)({ target: { value: '0.6' } })
    expect(store.updates).toBe(1)
    expect(store.state.zooms[0].focus).toEqual({ mode: 'fixed', x: 0.6, y: 0.4 })
    player.time = 0
  })

  it('notes that the tilt and the device frame are left out while following', () => {
    store.state = project('9:16', { mode: 'follow' })
    const note = 'The 3D tilt and the device frame are left out while the view follows the action.'
    expect(hints(render())).not.toContain(note)
    store.state = { ...store.state, style: { ...store.state.style, frame: { kind: 'browser', theme: 'light' } } }
    expect(hints(render())).toContain(note)
    store.state = { ...project('9:16', { mode: 'follow' }), tilt: { enabled: true, rotateX: 10, rotateY: 0, perspective: 0.5, animate: 'none' } }
    expect(hints(render())).toContain(note)
    store.state = { ...project('9:16', { mode: 'fit' }), tilt: { enabled: true, rotateX: 10, rotateY: 0, perspective: 0.5, animate: 'none' } }
    expect(hints(render())).not.toContain(note)
  })
})

describe('the commands of §2.11 (test 56)', () => {
  it('Hold the view here on R and Show safe zones on G, free of conflicts and reserved keys', () => {
    expect(DEFAULT_KEYMAP.holdView).toEqual(['R'])
    expect(DEFAULT_KEYMAP.toggleSafeZones).toEqual(['G'])
    const conflicts = findConflicts(DEFAULT_KEYMAP)
    expect(conflicts.get('R')).toBeUndefined()
    expect(conflicts.get('G')).toBeUndefined()
    expect(reservedReason('R')).toBeNull()
    expect(reservedReason('G')).toBeNull()
    expect(checkShortcut('R', 'holdView')).toEqual({ ok: true, accelerator: 'R' })
    expect(checkShortcut('G', 'toggleSafeZones')).toEqual({ ok: true, accelerator: 'G' })
    for (const id of ['makeVertical', 'makeSquare', 'duplicateVideo', 'toggleFollow'] as const) expect(DEFAULT_KEYMAP[id]).toEqual([])
    expect(COMMAND_IDS).toEqual(expect.arrayContaining(['makeVertical', 'makeSquare', 'duplicateVideo', 'toggleFollow', 'holdView', 'toggleSafeZones']))
    expect(commandInfo('toggleSafeZones')).toMatchObject({ title: 'Show safe zones', toggle: true })
    expect(commandInfo('holdView').title).toBe('Hold the view here')
  })
})
