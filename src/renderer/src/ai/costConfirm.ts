/**
 * The question before a run that costs more than the amount set in Settings (docs/design/smart-tools.md
 * §11.5). Part P5 writes it; the contracts' stub never asks.
 */
import type { TextChoice } from '../../../shared/api/ai'
import type { CostEstimate } from '../../../shared/ai/cost'

export function confirmCost(estimate: CostEstimate, choice: TextChoice): Promise<boolean> {
  void estimate
  void choice
  return Promise.resolve(true)
}
