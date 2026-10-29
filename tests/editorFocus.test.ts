import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Space on a focused toggle (docs/design/vertical-video.md §11.3): a checkbox the keyboard moved to
 * keeps Space, so Follow the action is turned on with Tab and Space; one the pointer focused does
 * not, and Space plays, even pressed at once, before the focus release blurs it. Told apart by how
 * focus arrived, never by :focus-visible, which Chromium matches on whatever has focus once a key
 * is pressed (the fake checkbox here does the same).
 */

interface Focus {
  installFocusRelease: () => () => void
  isKeyboardToggle: (el: unknown) => boolean
}

/* ---------- a page small enough for focus.ts: elements, focus and the window's listeners ---------- */

let keyPressed = false
class FakeNode {
  parent: FakeElement | null = null
  contains(n: unknown): boolean {
    for (let x: unknown = n; x; x = (x as FakeNode).parent) if (x === this) return true
    return false
  }
}
class FakeElement extends FakeNode {
  constructor(readonly tagName: string) {
    super()
  }
  append(child: FakeElement): this {
    child.parent = this
    return this
  }
  closest(sel: string): FakeElement | null {
    for (let x: FakeElement | null = this; x; x = x.parent) if (x.tagName.toLowerCase() === sel) return x
    return null
  }
  /** As Chromium: once a key is pressed, the focused element matches :focus-visible. */
  matches(sel: string): boolean {
    return sel === ':focus-visible' && keyPressed && doc.activeElement === this
  }
}
class FakeHTMLElement extends FakeElement {
  isContentEditable = false
  blur(): void {
    if (doc.activeElement === this) move(body)
  }
}
class FakeInput extends FakeHTMLElement {
  constructor(readonly type: string) {
    super('INPUT')
  }
}
class FakeButton extends FakeHTMLElement {
  constructor() {
    super('BUTTON')
  }
}

const body = new FakeHTMLElement('BODY')
const doc = { activeElement: body as FakeElement, body }
type Listener = (e: { target: unknown }) => void
const listeners = new Map<string, Set<Listener>>()
const fire = (type: string, target: unknown): void => {
  for (const fn of listeners.get(type) ?? []) fn({ target })
}
/** Focus moves to `el`, with focusout and focusin as a browser sends them. */
function move(el: FakeElement): void {
  const from = doc.activeElement
  if (from === el) return
  doc.activeElement = el
  if (from !== body) fire('focusout', from)
  if (el !== body) fire('focusin', el)
}

vi.stubGlobal('Node', FakeNode)
vi.stubGlobal('Element', FakeElement)
vi.stubGlobal('HTMLElement', FakeHTMLElement)
vi.stubGlobal('HTMLInputElement', FakeInput)
vi.stubGlobal('HTMLButtonElement', FakeButton)
vi.stubGlobal('document', doc)
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
  removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
})

/** A key pressed (and its default action, `then`: Tab moving focus). */
function key(then?: () => void): void {
  keyPressed = true
  fire('keydown', doc.activeElement)
  then?.()
}
/** The pointer pressed on `target`; a label hands focus to its checkbox (`focuses`). */
function press(target: FakeElement, focuses: FakeElement = target): void {
  fire('pointerdown', target)
  move(focuses)
  fire('pointerup', target)
}

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const FOCUS = '../src/renderer/src/editor/focus'
const { installFocusRelease, isKeyboardToggle } = (await import(/* @vite-ignore */ FOCUS)) as Focus

let text: FakeElement
let toggle: FakeInput
let uninstall: () => void

beforeEach(() => {
  vi.useFakeTimers()
  keyPressed = false
  doc.activeElement = body
  toggle = new FakeInput('checkbox')
  text = new FakeElement('SPAN')
  // A toggle as the panels draw it: the checkbox and its text in one label.
  new FakeElement('LABEL').append(toggle).append(text)
  uninstall = installFocusRelease()
})
afterEach(() => {
  uninstall()
  vi.useRealTimers()
})

describe('Space on a toggle', () => {
  it('a toggle reached with Tab keeps Space', () => {
    key(() => move(toggle))
    key()
    expect(isKeyboardToggle(toggle)).toBe(true)
    // Again: it is still the keyboard's.
    key()
    expect(isKeyboardToggle(toggle)).toBe(true)
  })

  it('a toggle the pointer clicked does not, with Space pressed at once (before the focus release)', () => {
    press(text, toggle)
    expect(doc.activeElement).toBe(toggle)
    key()
    // Chromium already matches :focus-visible here; that is not the keyboard's focus.
    expect(toggle.matches(':focus-visible')).toBe(true)
    expect(isKeyboardToggle(toggle)).toBe(false)
    // The release then blurs it, as before.
    vi.runAllTimers()
    expect(doc.activeElement).toBe(body)
  })

  it('a pointer press takes it back from the keyboard; Tab gives it again', () => {
    key(() => move(toggle))
    press(toggle)
    expect(isKeyboardToggle(toggle)).toBe(false)
    vi.runAllTimers()
    key(() => move(toggle))
    expect(isKeyboardToggle(toggle)).toBe(true)
  })

  it('only while it has the focus, and only a checkbox', () => {
    key(() => move(toggle))
    key(() => move(body))
    expect(isKeyboardToggle(toggle)).toBe(false)
    const button = new FakeButton()
    const slider = new FakeInput('range')
    key(() => move(button))
    expect(isKeyboardToggle(button)).toBe(false)
    key(() => move(slider))
    expect(isKeyboardToggle(slider)).toBe(false)
    expect(isKeyboardToggle(null)).toBe(false)
  })

  it('a toggle reached with Tab after a click elsewhere is the keyboard\'s', () => {
    const other = new FakeButton()
    press(other)
    vi.runAllTimers()
    key(() => move(toggle))
    expect(isKeyboardToggle(toggle)).toBe(true)
  })

  it('nothing is the keyboard\'s once the editor is gone', () => {
    key(() => move(toggle))
    uninstall()
    expect(isKeyboardToggle(toggle)).toBe(false)
    uninstall = installFocusRelease()
  })
})
