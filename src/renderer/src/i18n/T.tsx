/**
 * A message in the renderer (docs/design/output-and-languages.md §9.1): <T k="export.codec.hevc.title" />
 * renders the text as a fragment, so the DOM around it does not change. Rich tags map to the
 * caller's nodes; outside English the user's own text in a placeholder is wrapped in <bdi> (§13.3).
 * English adds no element.
 */
import { Fragment, type ReactNode } from 'react'
import { tNodes, userPlaceholders, type MessageKey, type MessageValues, type RichTag } from '../../../shared/i18n/t'

export function T(props: { k: MessageKey; values?: MessageValues; tags?: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> }): JSX.Element {
  const values: Record<string, string | number | ReactNode> = { ...(props.values ?? {}) }
  for (const name of userPlaceholders(props.k)) {
    const v = values[name]
    if (typeof v === 'string') values[name] = <bdi>{v}</bdi>
  }
  const parts = tNodes<ReactNode>(props.k, values, (props.tags ?? {}) as Partial<Record<RichTag, (chunks: (string | ReactNode)[]) => ReactNode>>)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  )
}
