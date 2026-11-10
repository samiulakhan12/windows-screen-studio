/**
 * Confirmations in the UI language (docs/design/output-and-languages.md §9.6). In English,
 * window.confirm(message) exactly as today. In another language Chromium's own dialog would still
 * say "OK" and "Cancel" in English, so main shows a message box owned by this window whose buttons
 * are the action and Cancel in the UI language ("মুছুন" and "বাতিল"); if main cannot ask, the
 * question is still asked through window.confirm.
 */
import { t, uiLanguage, type MessageKey } from '../../../shared/i18n/t'

/** Asks `message`; true when the user chose the action named by `action`. */
export async function askConfirm(message: string, action: MessageKey): Promise<boolean> {
  if (uiLanguage() === 'en') return window.confirm(message)
  try {
    return await window.api.confirm({ message, action: t(action), cancel: t('main.confirm.cancel') })
  } catch {
    return window.confirm(message)
  }
}
