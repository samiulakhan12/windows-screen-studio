/**
 * A form that opens in place of the button that opened it (Save as my style, Add a word, Add a
 * language): the keyboard that closes it (Escape, Enter, Save, Cancel, Close) goes back to that
 * button instead of falling to the page, where typed keys would run editor shortcuts. A click
 * leaves the focus where clicks leave it (focus.ts), and focus the user has already moved
 * elsewhere (a save ending later) stays there.
 */
import { useEffect, useRef, type FocusEvent, type RefObject } from 'react'
import { lastInputWasKey } from './focus'

export interface ReturnFocus<F extends HTMLElement> {
  /** The button that opens the form. */
  opener: RefObject<HTMLButtonElement>
  /** The form (or the box standing for it). */
  form: RefObject<F>
  /**
   * Whether the keyboard works the form now: the last input was a key and the focus is in the form
   * (or fell to the page, as from a button disabled while it works).
   */
  byKey(): boolean
  /**
   * Call just before the form closes; `keyed` is byKey() taken when the action that closes it
   * started earlier (a save). A click since then leaves the focus alone.
   */
  closing(keyed?: boolean): void
}

/**
 * `fallback` takes the focus when the opener cannot, as the form has filled what it adds to (Add a
 * word turns off at 500 words).
 */
export function useReturnFocus<F extends HTMLElement = HTMLElement>(open: boolean, fallback?: () => HTMLElement | null): ReturnFocus<F> {
  const opener = useRef<HTMLButtonElement>(null)
  const form = useRef<F>(null)
  const back = useRef(false)
  useEffect(() => {
    const go = !open && back.current
    back.current = false
    if (!go) return
    const button = opener.current
    ;(button && !button.disabled ? button : fallback?.())?.focus()
  }, [open])
  const inForm = (): boolean => {
    const el = document.activeElement
    return !el || el === document.body || !!form.current?.contains(el)
  }
  const byKey = (): boolean => lastInputWasKey() && inForm()
  const closing = (keyed = true): void => {
    back.current = keyed && byKey()
  }
  return { opener, form, byKey, closing }
}

/**
 * A button shown only while a tool works (its Stop, Cancel): when it goes, pressed or with the work
 * ending, while the keyboard is on it, the focus goes to the element with the id `to` (the tool's
 * own button, working again by then) instead of falling to the page, where typed keys would run
 * editor shortcuts. A click leaves the focus where clicks leave it (focus.ts), and focus moved
 * elsewhere stays there. Spread the result on the button; call it whether or not the button shows.
 */
export function useStopFocus(shown: boolean, to: string | undefined): { onFocus(): void; onBlur(e: FocusEvent<HTMLElement>): void } {
  /** Whether the button has the focus (kept when it goes with it, cleared when the focus moved on). */
  const focused = useRef(false)
  const backTo = useRef(to)
  if (shown) backTo.current = to
  useEffect(() => {
    if (!shown) return
    return () => {
      const had = focused.current
      focused.current = false
      if (!had || !lastInputWasKey()) return
      const active = document.activeElement
      if (active && active !== document.body) return
      const el = backTo.current ? document.getElementById(backTo.current) : null
      el?.focus({ preventScroll: true })
    }
  }, [shown])
  return {
    onFocus: () => void (focused.current = true),
    onBlur: (e) => {
      // Focus that moved elsewhere leaves the button in place; a button taken away with the focus on it is not there any more.
      const button = e.currentTarget
      setTimeout(() => {
        if (button.isConnected && document.activeElement !== button) focused.current = false
      }, 0)
    }
  }
}
