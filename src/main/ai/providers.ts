import type { AiProviderInfo } from '../../shared/api/ai'
import { modelDefaults } from './modelList'
import type { AiClient } from './types'

/**
 * A client for provider `info` with its key. Each provider's SDK is loaded the first time it is
 * used (they are large, and most sessions never call one), not when the app starts.
 */
export async function clientFor(info: AiProviderInfo, apiKey: string): Promise<AiClient> {
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
