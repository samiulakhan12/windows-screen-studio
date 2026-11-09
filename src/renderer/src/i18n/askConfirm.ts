/**
 * Confirmations in the UI language (docs/design/output-and-languages.md §9.6): in English
 * window.confirm(message) exactly as today; in other languages main's dialog with buttons named after
 * the action and Cancel. Part P6; the stub is today's window.confirm.
 */
import type { MessageKey } from '../../../shared/i18n/t'

/** Asks `message`; true when the user chose the action named by `action`. Part P6. */
export async function askConfirm(message: string, action: MessageKey): Promise<boolean> {
  void action
  return window.confirm(message)
}
