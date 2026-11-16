/**
 * A message with rich tags as React children, made where it is shown (docs/design/output-and-languages.md
 * §9.1): the same nodes <T> renders (each part in a keyed fragment, the user's own text in <bdi>
 * outside English), but as a plain call, so the parts sit directly in the element that shows them.
 * English adds no element.
 */
import { Fragment, type ReactNode } from 'react'
import { tNodes, userPlaceholders, type MessageKey, type MessageValues, type RichTag } from '../../../shared/i18n/t'

export function richText(k: MessageKey, values: MessageValues, tags: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>>): ReactNode[] {
  const shown: Record<string, string | number | ReactNode> = { ...values }
  for (const name of userPlaceholders(k)) {
    const v = shown[name]
    if (typeof v === 'string') shown[name] = <bdi>{v}</bdi>
  }
  return tNodes<ReactNode>(k, shown, tags as Partial<Record<RichTag, (chunks: (string | ReactNode)[]) => ReactNode>>).map((p, i) => <Fragment key={i}>{p}</Fragment>)
}
