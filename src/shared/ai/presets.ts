/**
 * The services More services offers (docs/design/smart-tools.md §10.5) and the name a service goes
 * by. Part P5 writes this file; the contracts' stub gives the presets' fixed data and names a
 * service by its host.
 */
import type { AiProviderInfo, ServicePreset } from '../api/ai'

export const SERVICE_PRESETS: Readonly<Record<ServicePreset, { label: string; baseUrl: string | null; host: string | null; keyNeeded: boolean; free: boolean; priceService: string | null }>> = {
  azure: { label: 'Azure OpenAI', baseUrl: null, host: null, keyNeeded: true, free: false, priceService: 'azure' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', keyNeeded: true, free: false, priceService: 'openrouter' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', keyNeeded: true, free: false, priceService: 'groq' },
  together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', host: 'api.together.xyz', keyNeeded: true, free: false, priceService: 'together' },
  ollama: { label: 'Ollama on this PC', baseUrl: 'http://localhost:11434/v1', host: 'localhost:11434', keyNeeded: false, free: true, priceService: null },
  lmstudio: { label: 'LM Studio on this PC', baseUrl: 'http://localhost:1234/v1', host: 'localhost:1234', keyNeeded: false, free: true, priceService: null },
  other: { label: 'Other address', baseUrl: null, host: null, keyNeeded: true, free: false, priceService: null }
}

export function presetApplies(preset: ServicePreset, host: string): boolean {
  void preset
  void host
  return false
}

/** The name every hint and cost line uses for a service: its host. */
export function serviceName(info: Pick<AiProviderInfo, 'label' | 'service'>): string {
  return info.service?.host ?? info.label
}
