/**
 * AI on this PC as the text tools see it (docs/design/smart-tools.md §2.5, §9.2). Part P4 writes
 * these hooks; the contracts' stubs say no model is ready and nothing runs.
 */
import type { AiTextTask, NamesRequest } from '../../../shared/api/ai'
import type { LocalAiProgress } from '../../../shared/api/localAi'

/** Whether a model is downloaded and this PC can run it: the text tools then offer On this PC. */
export function useLocalAiReady(): boolean {
  return false
}

/** The progress of request `requestId` on this PC, or null. */
export function useLocalAiProgress(requestId: string | null): LocalAiProgress | null {
  void requestId
  return null
}

/** The catalogue's note for `task` with the model a run would use ("Small: titles often repeat the first sentence"), or null. */
export function useLocalNote(task: AiTextTask, kind?: NamesRequest['kind']): string | null {
  void task
  void kind
  return null
}
