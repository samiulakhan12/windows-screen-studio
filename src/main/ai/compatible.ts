/**
 * A service that speaks OpenAI's Chat Completions API (docs/design/smart-tools.md §10.3): no
 * redirects, the stored origin only, the JSON mode found by Save and check. Part P5 writes this
 * file; the contracts' stub refuses every request.
 */
import type { AiProviderInfo, ServiceInfo } from '../../shared/api/ai'
import type { ServiceStore } from './serviceStore'
import type { AiClient } from './types'

const NOT_IN_BUILD = 'Services are not part of this build.'

export function compatibleClient(info: AiProviderInfo, apiKey: string | null, store: Pick<ServiceStore, 'setJsonMode'>): AiClient {
  void info
  void apiKey
  void store
  return {
    test: () => Promise.reject(new Error(NOT_IN_BUILD)),
    json: () => Promise.reject(new Error(NOT_IN_BUILD))
  }
}

export async function probeJsonMode(client: AiClient, signal: AbortSignal): Promise<ServiceInfo['json']> {
  void client
  void signal
  return 'text'
}

export function noRedirectFetch(origin: string): typeof fetch {
  void origin
  return () => Promise.reject(new Error(NOT_IN_BUILD))
}
