/**
 * Where the keyboard goes when the Inspector view that holds it goes away (E-06,
 * docs/design/multi-select.md §5.2).
 *
 * Call keepInspectorFocus just before a change that can take away the Inspector view or rail
 * button holding the keyboard: a group deleted, cut or cleared, Ctrl+A or a list's "Select all"
 * opening the Selection view, a group narrowed to one item. When focus was in the Inspector and
 * the change drops it to the page, it goes to the open tab's rail button (the Selection button
 * while that view shows), so the keyboard is not sent back to the top of the window. Focus that
 * stays on a control, or that was elsewhere, is left alone.
 */
export function keepInspectorFocus(): void {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || !el.closest('.inspector')) return
  window.setTimeout(() => {
    const now = document.activeElement
    if (now instanceof HTMLElement && now !== document.body && now.isConnected) return
    document.querySelector<HTMLButtonElement>('.inspector .insp-tabs button.active')?.focus()
  }, 0)
}
