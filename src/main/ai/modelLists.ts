/**
 * The models a provider or service lists (docs/design/smart-tools.md §10.4), for a saved one
 * (`{ providerId }`) or a form not saved yet (`{ draft }`). Main asks the provider with the key only,
 * never project text: 20 s, 4 MB, 2,000 ids, redirects refused (listFetch.ts). The list lives for
 * the session in the renderer; nothing is stored.
 *
 * Which key a draft uses: its own when it has one. Without one, the stored key of the entry
 * `draft.id` names only when the draft's kind (and, for a service, its origin) are that entry's;
 * otherwise "Enter the API key for the new address." and nothing is sent. So an edited address,
 * typed wrong or sent by a compromised page, never receives the stored key.
 */
import { AI_PROVIDER_KINDS, type AiProviderInfo, type ListedModel } from '../../shared/api/ai'
import { filterModels as filterFor } from '../../shared/ai/modelFilter'
import { readBaseUrl } from '../../shared/ai/baseUrl'
import type { AiProviderKind } from '../../shared/types'
import { validateProviderInput, type AiProviderStore } from './keyStore'
import { clientFor } from './providers'
import { SERVICE_ID_RE, SERVICE_MESSAGES, validateServiceInput, type ServiceStore } from './serviceStore'
import { scrubSecrets } from './secrets'
import type { AiClient } from './types'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The ids of `ids` model field `field` offers for a provider of `kind` (shared with the renderer's combobox). */
export function filterModels(kind: AiProviderKind, ids: readonly string[], field: 'text' | 'transcription'): string[] {
  return filterFor(kind, ids, field)
}

/** The client a target lists its models with. */
async function clientOf(target: unknown, deps: { providers(): AiProviderStore; services(): ServiceStore }): Promise<AiClient> {
  if (!isObject(target)) throw new Error('Invalid provider.')
  if ('providerId' in target) {
    const id = target.providerId
    if (typeof id !== 'string') throw new Error('Invalid provider.')
    const { info, apiKey } = SERVICE_ID_RE.test(id) ? deps.services().get(id) : deps.providers().get(id)
    return clientFor(info, apiKey, deps.services())
  }
  const draft = target.draft
  if (!isObject(draft)) throw new Error('Invalid provider.')
  if (draft.service !== undefined) {
    // A service's form: its address checked first; the stored key only at the stored origin.
    const input = validateServiceInput({ ...draft, model: typeof draft.model === 'string' && draft.model.trim() ? draft.model : 'x' })
    const url = readBaseUrl(input.service.baseUrl)
    if (!url.ok) throw new Error(url.message)
    const apiKey = deps.services().keyForDraft(input)
    const info: AiProviderInfo = {
      id: input.id ?? 'svcdraft',
      kind: 'openai',
      label: input.label,
      model: input.model ?? 'x',
      maskedKey: '',
      createdAt: '',
      service: { preset: input.service.preset, baseUrl: url.baseUrl, host: url.host, loopback: url.loopback, json: 'text', ...(input.service.keepNoData ? { keepNoData: true } : {}) }
    }
    return clientFor(info, apiKey, { setJsonMode: () => undefined })
  }
  // A built-in provider's form: the stored key only for the same kind.
  const input = validateProviderInput(draft)
  let apiKey = input.apiKey ?? null
  if (!apiKey) {
    if (input.id === undefined) throw new Error(SERVICE_MESSAGES.key)
    const stored = deps.providers().get(input.id)
    if (stored.info.kind !== input.kind) throw new Error(SERVICE_MESSAGES.newAddress)
    apiKey = stored.apiKey
  }
  const info: AiProviderInfo = { id: input.id ?? 'aidraft', kind: input.kind, label: input.label, model: input.model ?? AI_PROVIDER_KINDS[input.kind].defaultModel, maskedKey: '', createdAt: '' }
  return clientFor(info, apiKey)
}

/**
 * The models `target` can use: ids for both model fields (the renderer keeps those of its field with
 * filterModels), with OpenRouter's prices and whether a model takes a strict schema. Rejects with a
 * message to show, any key scrubbed from it.
 */
export async function listModels(target: unknown, deps: { providers(): AiProviderStore; services(): ServiceStore }): Promise<ListedModel[]> {
  try {
    const client = await clientOf(target, deps)
    if (!client.models) throw new Error('This provider cannot list its models.')
    return await client.models(AbortSignal.timeout(20_000))
  } catch (err) {
    throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err)))
  }
}
