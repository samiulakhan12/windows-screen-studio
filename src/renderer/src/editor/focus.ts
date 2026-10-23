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

/**
 * After a pointer interaction with a button, toggle or slider finishes
 * (including the click it produces), moves focus off that control. Keyboard
 * users who Tab to a control keep it focused, since they produce no pointer
 * events, and only the control the pointer pressed is ever blurred.
 */
export function installFocusRelease(): () => void {
  let timer = 0
  let pressed: Element | null = null
  const onPointerDown = (e: PointerEvent): void => {
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
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerUp, true)
  }
}
