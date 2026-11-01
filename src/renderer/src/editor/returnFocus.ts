/**
 * A form that opens in place of the button that opened it (Save as my style, Add a word, Add a
 * language): the keyboard that closes it (Escape, Enter, Save, Cancel, Close) goes back to that
 * button instead of falling to the page, where typed keys would run editor shortcuts. A click
 * leaves the focus where clicks leave it (focus.ts), and focus the user has already moved
 * elsewhere (a translation ending later) stays there.
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
  /** Call just before the form closes; `keyed` is byKey() when the action that closes it started earlier (a save, a translation). */
  closing(keyed?: boolean): void
}

export function useReturnFocus<F extends HTMLElement = HTMLElement>(open: boolean): ReturnFocus<F> {
  const opener = useRef<HTMLButtonElement>(null)
  const form = useRef<F>(null)
  const back = useRef(false)
  useEffect(() => {
    const go = !open && back.current
    back.current = false
    if (go) opener.current?.focus()
  }, [open])
  const inForm = (): boolean => {
    const el = document.activeElement
    return !el || el === document.body || !!form.current?.contains(el)
  }
  const byKey = (): boolean => lastInputWasKey() && inForm()
  const closing = (keyed = byKey()): void => {
    back.current = keyed && inForm()
  }
  return { opener, form, byKey, closing }
}
