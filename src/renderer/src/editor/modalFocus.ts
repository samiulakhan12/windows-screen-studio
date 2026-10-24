import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/**
 * Keyboard behaviour of a modal dialog: Tab and Shift+Tab stay inside it (even after a mouse
 * click moved focus off a button, see focus.ts), Esc closes it unless a control inside
 * already handled Esc (calling preventDefault), and focus goes back to where it was when the
 * dialog closes.
 */
export function useModalFocus(ref: RefObject<HTMLElement>, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  // Read while rendering: by the time effects run, autoFocus has already moved focus into the dialog.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(() => {
    const onTab = (e: KeyboardEvent): void => {
      const box = ref.current
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
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true })
    }
  }, [ref, previous])
}
