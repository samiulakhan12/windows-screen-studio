import type { AiProviderInfo } from '../../shared/api/ai'
import { modelDefaults } from './modelList'
import type { ServiceStore } from './serviceStore'
import type { AiClient } from './types'

/**
 * A client for provider `info` with its key. Each provider's SDK is loaded the first time it is
 * used (they are large, and most sessions never call one), not when the app starts. A service
 * (`info.service`, smart-tools.md §10.3) gets part P5's compatibleClient, which saves the JSON mode
 * it finds through `services`; its key may be null (a service on this PC).
 */
export async function clientFor(info: AiProviderInfo, apiKey: string | null, services?: Pick<ServiceStore, 'setJsonMode'>): Promise<AiClient> {
  if (info.service) return (await import('./compatible')).compatibleClient(info, apiKey, services ?? { setJsonMode: () => undefined })
  if (apiKey === null) throw new Error('This provider has no key: add it again in Settings.')
  const transcriptionModel = info.transcriptionModel ?? modelDefaults(info.kind).transcriptionModel ?? ''
  switch (info.kind) {
    case 'openai':
      return (await import('./openai')).openAiClient(apiKey, info.model, transcriptionModel)
    case 'gemini':
      return (await import('./gemini')).geminiClient(apiKey, info.model, transcriptionModel)
    case 'anthropic':
      return (await import('./anthropic')).anthropicClient(apiKey, info.model)
  }
}
