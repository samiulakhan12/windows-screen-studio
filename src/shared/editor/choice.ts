/**
 * Options of a chip row or a select whose words are messages (docs/design/output-and-languages.md
 * §9.1): a table built when its module loads holds these, and the words are made when they are read,
 * where the option is shown.
 */
import { t, type MessageKey } from '../i18n/t'

export interface Choice<V> {
  value: V
  readonly label: string
  readonly title?: string
}

/** An option whose label (and tooltip) are the messages `label` and `title`, made when read. */
export function choice<V>(value: V, label: MessageKey, title?: MessageKey): Choice<V> {
  return title
    ? {
        value,
        get label() {
          return t(label)
        },
        get title() {
          return t(title)
        }
      }
    : {
        value,
        get label() {
          return t(label)
        }
      }
}
