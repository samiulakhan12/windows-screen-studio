import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Tab in a modal dialog (useModalFocus): focus never leaves it for the page behind the scrim. The
 * hook runs with React's hooks swapped for plain ones (its effect runs at once) on a page small
 * enough for it: elements that contain each other, the focus, and the window's keydown listeners.
 */

class FakeNode {
  parent: FakeNode | null = null
  contains(n: unknown): boolean {
    for (let x: unknown = n; x; x = (x as FakeNode).parent) if (x === this) return true
    return false
  }
}
class FakeElement extends FakeNode {
  children: FakeElement[] = []
  offsetParent: object | null = {}
  isConnected = true
  /** The `inert` attribute (the Review panel sets it on the Inspector it covers). */
  inert = false
  constructor(readonly name: string) {
    super()
  }
  append(...kids: FakeElement[]): this {
    for (const k of kids) {
      k.parent = this
      this.children.push(k)
    }
    return this
  }
  focus(): void {
    doc.activeElement = this
  }
  /** Only `[inert]` is looked for here: this element or the nearest container that is inert. */
  closest(selector: string): FakeElement | null {
    if (selector !== '[inert]') return null
    for (let x: FakeNode | null = this; x; x = x.parent) if (x instanceof FakeElement && x.inert) return x
    return null
  }
  /** Every focusable element inside, in order (the buttons; not the dialog itself, whose tabindex is -1). */
  querySelectorAll(): FakeElement[] {
    return this.children.flatMap((k) => [...(k.name.startsWith('button') ? [k] : []), ...k.querySelectorAll()])
  }
}

const body = new FakeElement('body')
const doc = { activeElement: body as FakeElement, body }
const keydown: ((e: KeyboardEventLike) => void)[] = []
interface KeyboardEventLike {
  key: string
  shiftKey: boolean
  defaultPrevented: boolean
  preventDefault(): void
}

vi.stubGlobal('Node', FakeNode)
vi.stubGlobal('HTMLElement', FakeElement)
vi.stubGlobal('document', doc)
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: (e: KeyboardEventLike) => void) => {
    if (type === 'keydown') keydown.push(fn)
  },
  removeEventListener: () => undefined
})
vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRef: (current: unknown) => ({ current }),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useEffect: (fn: () => void) => void fn()
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const MODAL_FOCUS = '../src/renderer/src/editor/modalFocus'
const { useModalFocus } = (await import(/* @vite-ignore */ MODAL_FOCUS)) as { useModalFocus: (ref: { current: unknown }, onClose: () => void) => void }

/** A key pressed: the hook's listeners see it, and the browser moves the focus only when none prevented that (here it is left where it was). */
function press(key: string, shiftKey = false): KeyboardEventLike {
  const e: KeyboardEventLike = {
    key,
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true
    }
  }
  for (const fn of keydown) fn(e)
  return e
}

let editorButton: FakeElement
let overlay: FakeElement
let dialog: FakeElement
let write: FakeElement
let close: FakeElement
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  keydown.length = 0
  editorButton = new FakeElement('button: Publish (behind the scrim)')
  write = new FakeElement('button: Write all')
  close = new FakeElement('button: Close')
  dialog = new FakeElement('dialog').append(new FakeElement('header'), new FakeElement('main').append(write), new FakeElement('footer').append(close))
  overlay = new FakeElement('overlay').append(dialog)
  body.children = []
  body.append(editorButton, overlay)
  editorButton.focus()
  onClose = vi.fn<() => void>()
  useModalFocus({ current: dialog }, onClose)
})

describe('A modal dialog keeps Tab inside it (useModalFocus)', () => {
  it('with the dialog itself focused (no button to focus yet), Shift+Tab goes to its last control, not the page behind', () => {
    dialog.focus()
    const e = press('Tab', true)
    expect(e.defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(close)
  })

  it('with the dialog itself focused, Tab goes to its first control', () => {
    dialog.focus()
    const e = press('Tab')
    expect(e.defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(write)
  })

  it('wraps from the last control to the first and back', () => {
    close.focus()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(write)
    expect(press('Tab', true).defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(close)
  })

  it('leaves Tab between its own controls to the browser', () => {
    write.focus()
    expect(press('Tab').defaultPrevented).toBe(false)
    expect(doc.activeElement).toBe(write)
  })

  it('brings the focus back in from the page', () => {
    editorButton.focus()
    expect(press('Tab', true).defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(close)
  })
})

describe('A dialog covered by a panel (inside an inert part of the page) keeps no keys', () => {
  // Captions Studio's "Make my captions great" options stay open in the Inspector when Shift+R opens
  // the Review panel over it, which makes the Inspector inert: Tab and Esc belong to the Review panel.
  let keep: FakeElement
  let remove: FakeElement
  beforeEach(() => {
    keep = new FakeElement('button: Keep')
    remove = new FakeElement('button: Remove')
    body.append(new FakeElement('review panel').append(keep, remove))
    overlay.inert = true
    keep.focus()
  })

  it('leaves Tab and Shift+Tab in the panel over it to the browser', () => {
    expect(press('Tab').defaultPrevented).toBe(false)
    expect(doc.activeElement).toBe(keep)
    remove.focus()
    expect(press('Tab', true).defaultPrevented).toBe(false)
    expect(doc.activeElement).toBe(remove)
  })

  it('does not close on Esc', () => {
    expect(press('Escape').defaultPrevented).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps Tab and Esc again once the panel is gone', () => {
    overlay.inert = false
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(doc.activeElement).toBe(write)
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
