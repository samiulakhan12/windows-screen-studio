/**
 * Services reached at a base URL (docs/design/smart-tools.md §10.1): userData/ai-services.json, keys
 * encrypted and bound to the origin they were entered for. Part P5 writes this file; the contracts'
 * stub keeps no services, never reads or writes a file, and refuses to save one.
 */
import type { AiProviderInfo, AiProviderInput, ServiceInfo } from '../../shared/api/ai'
import type { SecretBox } from './keyStore'

const NOT_IN_BUILD = 'Services are not part of this build.'

export class ServiceStore {
  constructor(file: string, box: SecretBox) {
    void file
    void box
  }

  list(): AiProviderInfo[] {
    return []
  }

  get(id: unknown): { info: AiProviderInfo; apiKey: string | null } {
    void id
    throw new Error('This provider no longer exists.')
  }

  keyForDraft(draft: AiProviderInput): string | null {
    void draft
    return null
  }

  save(raw: unknown, now?: Date): AiProviderInfo {
    void raw
    void now
    throw new Error(NOT_IN_BUILD)
  }

  remove(id: unknown): void {
    void id
  }

  setJsonMode(id: string, json: ServiceInfo['json']): void {
    void id
    void json
  }
}

export function validateServiceInput(input: unknown): AiProviderInput & { service: NonNullable<AiProviderInput['service']> } {
  void input
  throw new Error(NOT_IN_BUILD)
}
