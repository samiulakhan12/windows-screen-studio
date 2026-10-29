/**
 * Focus rules for editor shortcuts: they work wherever focus is, except while
 * the user is typing into a text field. Controls such as sliders, toggles and
 * buttons must not keep focus after a mouse interaction, or they would swallow
 * Space and the arrow keys.
 */

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'])

export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
}

export const isRangeInput = (el: Element | null): boolean => el instanceof HTMLInputElement && el.type === 'range'

/** Controls that should hand keyboard focus back to the editor after a mouse click or drag. */
function isTransientControl(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLButtonElement) return true
  return el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'checkbox' || el.type === 'radio')
}

export function blurActiveControl(): void {
  const el = document.activeElement
  if (isTransientControl(el)) el.blur()
}

/** Blurs whatever has focus unless it is a text field the pointer is interacting with. */
export function releaseFocus(target?: EventTarget | null): void {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return
  if (target instanceof Node && el.contains(target) && isTextEntry(el)) return
  el.blur()
}

/** The element that has focus when the keyboard moved it there (Tab, a shortcut); null after a pointer press. Kept by installFocusRelease. */
let keyboardFocus: Element | null = null

/**
 * A checkbox the keyboard moved focus to, which keeps Space (its only key). One the pointer
 * focused does not, even before installFocusRelease blurs it. Told apart by how focus arrived:
 * :focus-visible is no guide while a key is handled, as Chromium matches it on whatever has focus
 * once any key is pressed.
 */
export function isKeyboardToggle(el: Element | null): boolean {
  return el instanceof HTMLInputElement && el.type === 'checkbox' && el === keyboardFocus && el === document.activeElement
}

/**
 * After a pointer interaction with a button, toggle or slider finishes
 * (including the click it produces), moves focus off that control. Keyboard
 * users who Tab to a control keep it focused, since they produce no pointer
 * events, and only the control the pointer pressed is ever blurred. Also
 * notes whether focus came from the keyboard or the pointer (isKeyboardToggle).
 */
export function installFocusRelease(): () => void {
  let timer = 0
  let pressed: Element | null = null
  // The last input: a key (Tab, a shortcut) or a pointer press. Focus moves after it.
  let byKey = false
  const onKeyDown = (): void => {
    byKey = true
  }
  const onFocusIn = (e: FocusEvent): void => {
    keyboardFocus = byKey && e.target instanceof Element ? e.target : null
  }
  const onPointerDown = (e: PointerEvent): void => {
    byKey = false
    keyboardFocus = null
    pressed = e.target instanceof Element ? e.target : null
  }
  const onPointerUp = (): void => {
    const target = pressed
    window.clearTimeout(timer)
    // The click (and a label's forwarded click) is dispatched after pointerup in the same task.
    timer = window.setTimeout(() => {
      const el = document.activeElement
      if (!target || !isTransientControl(el)) return
      if (el === target || el.contains(target) || target.closest('label')?.contains(el)) el.blur()
    }, 0)
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('focusin', onFocusIn, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  return () => {
    window.clearTimeout(timer)
    keyboardFocus = null
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerUp, true)
  }
}
