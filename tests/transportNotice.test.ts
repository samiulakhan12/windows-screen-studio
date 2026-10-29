import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'

/*
 * The notice under the preview and its button (docs/design/vertical-video.md §2.1, §2.3): after
 * Make a vertical version the message is long and the safe-zone control narrows the transport row,
 * so only the message may give way (an ellipsis); Open original stays whole and can be pressed. A
 * notice with a button does not go while the pointer is over it or focus is in it.
 */

type Handler = (e: unknown) => void
type El = ReactElement<{
  className?: string
  role?: string
  title?: string
  children?: ReactNode
  onClick?: () => void
  onMouseEnter?: Handler
  onMouseLeave?: Handler
  onFocus?: Handler
  onBlur?: Handler
}>
interface Notice {
  TransportNotice: (props: { text: string; action?: { label: string; run: () => void } | null; alert?: boolean; onHold?: (held: boolean) => void }) => unknown
  Transport: { type: (props: Record<string, unknown>) => unknown }
}

// The transport row is called as a function, with React's hooks swapped for a few lines and its
// contexts (the editor's player, the keymap) answered here, as tests/followSection.test.ts does.
const player = { time: 0, holdElapsed: 0, subscribe: () => () => undefined, getPlaying: () => false }
vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useContext: () => ({ ...DEFAULT_KEYMAP, player })
}))

// A .tsx module: imported by path, as the Node typecheck of tests/ does not compile JSX.
const TRANSPORT = '../src/renderer/src/editor/Transport'
const { TransportNotice, Transport } = (await import(/* @vite-ignore */ TRANSPORT)) as Notice

/** The transport row (its own elements; components inside it are not called). */
function transportRow(props: Record<string, unknown>): El {
  const noop = (): void => undefined
  const out = Transport.type({ clips: [], notice: null, onTogglePlay: noop, onSplit: noop, onAddZoom: noop, onAddText: noop, ...props }) as El
  return elements(out.props.children).find((e) => /\btransport\b/.test(e.props.className ?? ''))!
}

const kids = (node: ReactNode): ReactNode[] => (Array.isArray(node) ? node.flatMap(kids) : [node])
const elements = (node: ReactNode): El[] => kids(node).filter((n): n is El => isValidElement(n))
const text = (node: ReactNode): string => kids(node).map((n) => (typeof n === 'string' ? n : isValidElement(n) ? text((n as El).props.children) : '')).join('')
/** `root` and every element under it. */
const all = (root: El): El[] => [root, ...elements(root.props.children).flatMap(all)]

const MESSAGE = 'Made a vertical version. Your original “Billing demo” is unchanged.'

describe('the notice and its button', () => {
  it('keeps the message in its own box, with the button beside it, not inside it', () => {
    const run = vi.fn()
    const notice = TransportNotice({ text: MESSAGE, action: { label: 'Open original', run } }) as El
    expect(notice.props.className).toBe('notice has-action')
    expect(notice.props.role).toBeUndefined()
    const [message, button] = elements(notice.props.children)
    expect(message.props.className).toBe('notice-text')
    expect(text(message)).toBe(MESSAGE)
    // Cut short in a narrow row, the whole message is still its title.
    expect(message.props.title).toBe(MESSAGE)
    expect(all(message).some((e) => e.type === 'button')).toBe(false)
    expect(button.type).toBe('button')
    expect(text(button)).toBe('Open original')
    button.props.onClick?.()
    expect(run).toHaveBeenCalledOnce()
    // Read whole by the status region and by the existing selectors (.notice:has-text).
    expect(text(notice)).toBe(`${MESSAGE}Open original`)
  })

  it('shows the message alone without a button, as an alert when it is an error', () => {
    const plain = TransportNotice({ text: 'Nothing to undo' }) as El
    // The pill as before (ui.e2e): one line, cut with an ellipsis.
    expect(plain.props.className).toBe('notice')
    expect(elements(plain.props.children).map((e) => e.props.className)).toEqual(['notice-text'])
    expect((TransportNotice({ text: 'Could not make the copy: a copy is already being made.', alert: true }) as El).props.role).toBe('alert')
  })
})

describe('a notice with a button stays while it is used', () => {
  const doc = { activeElement: null as unknown }
  vi.stubGlobal('document', doc)
  /** The notice's box: what it contains, and whether the pointer is over it. */
  const box = (inside: unknown[], hovered: boolean): unknown => ({ contains: (n: unknown) => inside.includes(n), matches: (s: string) => s === ':hover' && hovered })

  it('the pointer over it or focus in it holds it; leaving both lets it go', () => {
    const onHold = vi.fn()
    const n = TransportNotice({ text: MESSAGE, action: { label: 'Open original', run: () => undefined }, onHold }) as El
    const button = {}
    n.props.onMouseEnter?.({})
    expect(onHold).toHaveBeenLastCalledWith(true)
    // The pointer leaves while the button has focus (Tab): it stays.
    doc.activeElement = button
    onHold.mockClear()
    n.props.onMouseLeave?.({ currentTarget: box([button], false) })
    expect(onHold).not.toHaveBeenCalled()
    // Focus leaves too: it goes.
    n.props.onBlur?.({ currentTarget: box([button], false), relatedTarget: null })
    expect(onHold).toHaveBeenLastCalledWith(false)
    // Focus in it holds it; focus leaving while the pointer is over it does not let it go.
    onHold.mockClear()
    n.props.onFocus?.({})
    expect(onHold).toHaveBeenLastCalledWith(true)
    onHold.mockClear()
    n.props.onBlur?.({ currentTarget: box([button], true), relatedTarget: null })
    expect(onHold).not.toHaveBeenCalled()
    // The pointer then leaves, with nothing in it focused: it goes.
    doc.activeElement = null
    n.props.onMouseLeave?.({ currentTarget: box([button], false) })
    expect(onHold).toHaveBeenLastCalledWith(false)
    // Focus moving within it does not let it go.
    onHold.mockClear()
    n.props.onBlur?.({ currentTarget: box([button], false), relatedTarget: button })
    expect(onHold).not.toHaveBeenCalled()
  })

  it('a notice without a button goes on time, whatever the pointer does', () => {
    const onHold = vi.fn()
    const n = TransportNotice({ text: 'Zoom added', onHold }) as El
    expect([n.props.onMouseEnter, n.props.onMouseLeave, n.props.onFocus, n.props.onBlur]).toEqual([undefined, undefined, undefined, undefined])
  })
})

/* ---------- the stylesheet ---------- */

const css = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
/** The values of `prop` on `selector`, in source order. */
const values = (selector: string, prop: string): string[] =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .flatMap((m) => [...m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, 'g'))].map((d) => d[1].trim()))

describe('a tall frame\'s transport row wraps in a narrow window (editor.css)', () => {
  it('only a tall frame\'s row (with the safe-zone control) is marked to wrap', () => {
    expect(transportRow({ tall: true }).props.className).toBe('transport tall')
    expect(transportRow({ tall: false }).props.className).toBe('transport')
    expect(transportRow({}).props.className).toBe('transport')
  })

  it('it wraps, keeping the notice wide enough to read; other rows lay out as before', () => {
    expect(values('.transport.tall', 'flex-wrap')).toEqual(['wrap'])
    expect(values('.transport.tall .notice-slot', 'flex')).toEqual(['1 0 160px'])
    expect(values('.transport', 'flex-wrap')).toEqual([])
    expect(values('.notice-slot', 'flex')).toEqual(['1'])
  })
})

describe('only the message gives way (editor.css)', () => {
  it('a notice is the one-line pill as before; one with a button is a row that does not clip it', () => {
    expect(values('.notice-slot .notice', 'display')).toEqual([])
    expect(values('.notice-slot .notice', 'max-width')).toEqual(['100%'])
    expect(values('.notice-slot .notice', 'white-space')).toEqual(['nowrap'])
    expect(values('.notice-slot .notice', 'text-overflow')).toEqual(['ellipsis'])
    expect(values('.notice-slot .notice.has-action', 'display')).toEqual(['flex'])
  })

  it('in that row the message shrinks with an ellipsis; the button keeps its size', () => {
    expect(values('.notice-slot .notice.has-action .notice-text', 'min-width')).toEqual(['0'])
    expect(values('.notice-slot .notice.has-action .notice-text', 'overflow')).toEqual(['hidden'])
    expect(values('.notice-slot .notice.has-action .notice-text', 'text-overflow')).toEqual(['ellipsis'])
    expect(values('.notice-slot .notice.has-action .link', 'flex')).toEqual(['none'])
  })
})
