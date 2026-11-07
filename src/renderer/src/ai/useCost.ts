/**
 * The estimate of one request with one choice (docs/design/smart-tools.md §11.1). Part P5 writes it;
 * the contracts' stub knows nothing.
 */
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'
import type { CostEstimate } from '../../../shared/ai/cost'

export function useCost(choice: TextChoice | null, request: AiTextRequest | null): CostEstimate | null {
  void choice
  void request
  return null
}
