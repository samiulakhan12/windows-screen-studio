/**
 * A form that opens in place of the button that opened it (Save as my style, Add a word, Add a
 * language): the keyboard that closes it (Escape, Enter, Save, Cancel, Close) goes back to that
 * button instead of falling to the page, where typed keys would run editor shortcuts. A click
 * leaves the focus where clicks leave it (focus.ts), and focus the user has already moved
 * elsewhere (a save ending later) stays there.
 */
import { useEffect, useRef, type RefObject } from 'react'
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
