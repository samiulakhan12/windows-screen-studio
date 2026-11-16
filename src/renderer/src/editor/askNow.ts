/**
 * The captions' questions through askConfirm (docs/design/output-and-languages.md §9.6) where the
 * code went on in the same click: in English the answer is window.confirm's, given at once as
 * before, so what it starts still starts in that click; in another language main asks with the
 * action and Cancel in the UI language, and the answer comes later.
 */
import { uiLanguage, type MessageKey } from '../../../shared/i18n/t'
import { askConfirm } from '../i18n/askConfirm'

/** The answer to `message`: now in English (window.confirm), later in another language. */
export function askNow(message: string, action: MessageKey): boolean | Promise<boolean> {
  return uiLanguage() === 'en' ? window.confirm(message) : askConfirm(message, action)
}

/** Runs `go` once `answer` is yes: at once for an answer already given. */
export function whenYes(answer: boolean | Promise<boolean>, go: () => void): void {
  if (typeof answer === 'boolean') {
    if (answer) go()
    return
  }
  void answer.then((yes) => {
    if (yes) go()
  })
}
