import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/** For each open dialog, where focus may go back to when it closes, best first. */
const returnTargets = new WeakMap<Element, HTMLElement[]>()

/** The open dialogs, the last opened last: only it hears Tab and Esc (a confirm opened over a dialog). */
const open: HTMLElement[] = []

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
 * click moved focus off a button, see focus.ts, or while the dialog itself has the focus), Esc
 * closes it unless a control inside already handled Esc (calling preventDefault), and focus goes
 * back to where it was when the dialog closes, unless something else took it meanwhile (a dialog
 * the closing one opened). When what had it is gone or disabled by then and was in a panel, the
 * focus goes to the panel's current item (aria-current), else to the first control of its nearest
 * container still there. While a dialog opened over it is open, it does none of this.
 */
export function useModalFocus(ref: RefObject<HTMLElement>, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  // Read while rendering: by the time effects run, autoFocus has already moved focus into the dialog.
  const [targets] = useState(targetsFromHere)
  // In a panel (role="region"), the focused element's containers up to the panel, nearest first:
  // when it is gone or disabled by the time the dialog closes (a redo from the palette took a row's
  // Keep button away), the first control in the nearest one still there. None outside a panel, or
  // once the panel itself is gone (a command closed it and sends the focus on itself).
  const [around] = useState(() => {
    const out: HTMLElement[] = []
    const region = targets[0]?.closest('[role="region"]')
    for (let el = region ? targets[0].parentElement : null; el; el = el.parentElement) {
      out.push(el)
      if (el === region) break
    }
    return out
  })
  useEffect(() => {
    // Kept: by the time the cleanup runs, React has detached the ref.
    const box = ref.current
    if (box) {
      returnTargets.set(box, targets)
      open.push(box)
    }
    const onTop = (): boolean => open[open.length - 1] === box
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !box || !onTop()) return
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && box.contains(active)
      // The dialog itself (focused while it has no button to focus) wraps too: from it, Shift+Tab
      // would go to the page behind the scrim.
      if (!inside || active === box || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || (box && !onTop())) return
      e.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onTab, true)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onTab, true)
      window.removeEventListener('keydown', onEscape)
      if (box && open.includes(box)) open.splice(open.lastIndexOf(box), 1)
      // Only once the dialog is gone (not when this effect merely runs again), and only when its
      // focus was lost with it: a dialog opened in its place has already focused its own field.
      const active = document.activeElement
      if (box?.isConnected || (active && active !== document.body)) return
      // The panel's current item (its roving row) before any container's first control: a footer
      // button an undo disabled has only the panel's Close before it, or the other footer button.
      const region = around[around.length - 1]
      const back =
        targets.find((el) => el.isConnected && !el.matches(':disabled')) ??
        (region?.isConnected ? region.querySelector<HTMLElement>('[aria-current="true"]:not(:disabled)') : null) ??
        around
          .filter((el) => el.isConnected)
          .map((el) => el.querySelector<HTMLElement>(FOCUSABLE))
          .find(Boolean)
      back?.focus({ preventScroll: true })
    }
  }, [ref, targets, around])
}
