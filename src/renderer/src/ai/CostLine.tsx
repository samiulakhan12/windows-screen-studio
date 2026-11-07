/**
 * The cost line under a group of AI tools (docs/design/smart-tools.md §2.7, §11.5): what is sent
 * and where, each action's cost or time, and each button's own sentence. Part P5 writes it; the
 * contracts' stub shows nothing.
 */
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'

export function CostLine(props: {
  id: string
  choice: TextChoice | null
  actions: readonly { key: string; label: string; buttonId: string; request: AiTextRequest | (() => AiTextRequest) | null }[]
  full?: boolean
  transcribeSeconds?: number
}): JSX.Element | null {
  void props
  return null
}
