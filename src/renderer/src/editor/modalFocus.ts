import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/** For each open dialog, where focus may go back to when it closes, best first. */
const returnTargets = new WeakMap<Element, HTMLElement[]>()

/**
 * Where focus should go back to when a dialog opened now closes: the focused element, then
 * (when that is inside another dialog that closes as this one opens, as when a palette command
 * opens the shortcuts dialog) wherever that dialog would have sent it.
 */
function targetsFromHere(): HTMLElement[] {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return []
  const outer = active.closest('[aria-modal="true"]')
  return [active, ...((outer && returnTargets.get(outer)) ?? [])]
}

/**
 * Keyboard behaviour of a modal dialog: Tab and Shift+Tab stay inside it (even after a mouse
 * click moved focus off a button, see focus.ts), Esc closes it unless a control inside
 * already handled Esc (calling preventDefault), and focus goes back to where it was when the
 * dialog closes, unless something else took it meanwhile (a dialog the closing one opened).
 */
export function useModalFocus(ref: RefObject<HTMLElement>, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  // Read while rendering: by the time effects run, autoFocus has already moved focus into the dialog.
  const [targets] = useState(targetsFromHere)
  useEffect(() => {
    // Kept: by the time the cleanup runs, React has detached the ref.
    const box = ref.current
    if (box) returnTargets.set(box, targets)
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !box) return
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && box.contains(active)
      if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onTab, true)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onTab, true)
      window.removeEventListener('keydown', onEscape)
      // Only once the dialog is gone (not when this effect merely runs again), and only when its
      // focus was lost with it: a dialog opened in its place has already focused its own field.
      const active = document.activeElement
      if (box?.isConnected || (active && active !== document.body)) return
      targets.find((el) => el.isConnected)?.focus({ preventScroll: true })
    }
  }, [ref, targets])
}
