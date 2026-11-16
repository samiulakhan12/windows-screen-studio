/**
 * A message whose values or tags are elements (docs/design/output-and-languages.md §9.1): a keycap
 * component in a sentence, a link button inside a hint. Like <T>, it renders the parts as a fragment,
 * so the DOM around it does not change; `<kbd>` and `<b>` map to <kbd> and <strong> unless the caller
 * gives its own tags.
 */
import { Fragment, type ReactNode } from 'react'
import { tNodes, type MessageKey, type RichTag } from '../../../../shared/i18n/t'

const DEFAULT_TAGS: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> = {
  kbd: (c) => <kbd>{c}</kbd>,
  b: (c) => <strong>{c}</strong>
}

export function Rich(props: { k: MessageKey; values?: Record<string, string | number | ReactNode>; tags?: Partial<Record<RichTag, (chunks: ReactNode[]) => ReactNode>> }): JSX.Element {
  const parts = tNodes<ReactNode>(props.k, props.values ?? {}, { ...DEFAULT_TAGS, ...props.tags } as Partial<Record<RichTag, (chunks: (string | ReactNode)[]) => ReactNode>>)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  )
}
