/**
 * The models a provider or service lists (docs/design/smart-tools.md §10.4). Part P5 writes this
 * file; the contracts' stub refuses.
 */
import type { ListedModel } from '../../shared/api/ai'
import type { AiProviderKind } from '../../shared/types'
import type { AiProviderStore } from './keyStore'
import type { ServiceStore } from './serviceStore'

export async function listModels(target: unknown, deps: { providers(): AiProviderStore; services(): ServiceStore }): Promise<ListedModel[]> {
  void target
  void deps
  throw new Error('Model lists are not part of this build.')
}

export function filterModels(kind: AiProviderKind, ids: readonly string[], field: 'text' | 'transcription'): string[] {
  void kind
  void field
  return [...ids]
}
