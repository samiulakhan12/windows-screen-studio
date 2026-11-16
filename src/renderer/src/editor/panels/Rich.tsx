/**
 * A message whose values or tags are elements (docs/design/output-and-languages.md §9.1): a keycap
 * component in a sentence, a link button inside a hint. Like <T>, it renders the parts as a fragment,
 * so the DOM around it does not change; `<kbd>` and `<b>` map to <kbd> and <strong> unless the caller
 * gives its own tags. A value given as a node keeps its own text node, so a sentence around a name keeps
 * today's text nodes in English. Outside English a placeholder the meta marks as the user's text is
 * isolated in <bdi> (§13.3), node or string, as <T> does; English adds no element.
 */
import { Fragment, type ReactNode } from 'react'
import { tNodes, userPlaceholders, type MessageKey, type RichTag } from '../../../../shared/i18n/t'

const DEFAULT_TAGS: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> = {
  kbd: (c) => <kbd>{c}</kbd>,
  b: (c) => <strong>{c}</strong>
}

export function Rich(props: { k: MessageKey; values?: Record<string, string | number | ReactNode>; tags?: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> }): JSX.Element {
  const values: Record<string, string | number | ReactNode> = { ...(props.values ?? {}) }
  for (const name of userPlaceholders(props.k)) if (name in values && typeof values[name] !== 'number') values[name] = <bdi>{values[name]}</bdi>
  const parts = tNodes<ReactNode>(props.k, values, { ...DEFAULT_TAGS, ...props.tags } as Partial<Record<RichTag, (chunks: (string | ReactNode)[]) => ReactNode>>)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  )
}
