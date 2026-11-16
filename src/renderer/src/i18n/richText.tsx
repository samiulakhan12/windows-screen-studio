/**
 * A message as React children, made where it is shown (docs/design/output-and-languages.md §9.1):
 * the nodes <T> renders, but as a plain call, so the parts sit directly in the element that shows
 * them. Rich tags map to the caller's nodes; outside English the user's own text is wrapped in <bdi>.
 *
 * Each string value stays a text node of its own, as `Built by {COMPANY_NAME} ·` in JSX gives
 * "Built by ", "Qbexel" and " ·": the browser lays out and anti-aliases text by its nodes, so an
 * extracted line keeps its pixels (test 10). English adds no element. Plural and select values are
 * numbers (or are not passed here as strings), since a selector must stay a plain value.
 */
import { Fragment, type ReactNode } from 'react'
import { tNodes, userPlaceholders, type MessageKey, type MessageValues, type RichTag } from '../../../shared/i18n/t'

export function richText(k: MessageKey, values: MessageValues, tags: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> = {}): ReactNode[] {
  const user = userPlaceholders(k)
  const shown: Record<string, string | number | ReactNode> = {}
  for (const [name, v] of Object.entries(values)) {
    if (typeof v !== 'string') shown[name] = v
    else shown[name] = user.includes(name) ? <bdi key={`v-${name}`}>{v}</bdi> : <Fragment key={`v-${name}`}>{v}</Fragment>
  }
  return tNodes<ReactNode>(k, shown, tags as Partial<Record<RichTag, (chunks: (string | ReactNode)[]) => ReactNode>>).map((p, i) => <Fragment key={i}>{p}</Fragment>)
}
