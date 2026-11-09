/**
 * The services More services offers (docs/design/smart-tools.md §10.5) and the name a service goes
 * by. A preset only fills the form: every service is checked the same way. Its "no cost" and its
 * price entries apply only while the stored host is the preset's own, so a preset whose address was
 * edited to another host (Groq pointed elsewhere, Ollama on another port) is priced as Other
 * address. Pure.
 */
import type { AiProviderInfo, ServicePreset } from '../api/ai'
import { AZURE_RESOURCE_RE } from './baseUrl'

export const SERVICE_PRESETS: Readonly<Record<ServicePreset, { label: string; baseUrl: string | null; host: string | null; keyNeeded: boolean; free: boolean; priceService: string | null }>> = {
  azure: { label: 'Azure OpenAI', baseUrl: null, host: null, keyNeeded: true, free: false, priceService: 'azure' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', keyNeeded: true, free: false, priceService: 'openrouter' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', keyNeeded: true, free: false, priceService: 'groq' },
  together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', host: 'api.together.xyz', keyNeeded: true, free: false, priceService: 'together' },
  ollama: { label: 'Ollama on this PC', baseUrl: 'http://localhost:11434/v1', host: 'localhost:11434', keyNeeded: false, free: true, priceService: null },
  lmstudio: { label: 'LM Studio on this PC', baseUrl: 'http://localhost:1234/v1', host: 'localhost:1234', keyNeeded: false, free: true, priceService: null },
  other: { label: 'Other address', baseUrl: null, host: null, keyNeeded: true, free: false, priceService: null }
}

/** The presets in the order the Service select lists them (§2.6). */
export const PRESET_ORDER: readonly ServicePreset[] = ['openrouter', 'groq', 'together', 'azure', 'ollama', 'lmstudio', 'other']

/** Azure's hosts: <resource>.openai.azure.com. */
const isAzureHost = (host: string): boolean => {
  const m = /^(.+)\.openai\.azure\.com$/.exec(host)
  return !!m && AZURE_RESOURCE_RE.test(m[1])
}

/**
 * Whether preset `preset`'s own price entries and "no cost" apply to a service stored at `host`
 * (without the scheme, with its port: "localhost:11434"): only at the preset's own host; Azure at
 * any resource's; Other address never.
 */
export function presetApplies(preset: ServicePreset, host: string): boolean {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  if (preset === 'azure') return isAzureHost(h)
  const own = SERVICE_PRESETS[preset]?.host
  return !!own && h === own
}

/** The preset whose own host `host` is ('other' for none): what a service there is priced as. */
export function presetAt(host: string): ServicePreset {
  for (const p of PRESET_ORDER) if (p !== 'other' && presetApplies(p, host)) return p
  return 'other'
}

/**
 * The name every hint and cost line uses for a service (TextChoice.place): where its key and the
 * text go. A service on this PC at its preset's own address by the preset's name ("Ollama on this
 * PC"); every other by its ASCII host ("api.groq.com"), never by a name the user typed, so a hint
 * cannot say one place while the text goes to another. A provider without a service by its label.
 */
export function serviceName(info: Pick<AiProviderInfo, 'label' | 'service'>): string {
  const s = info.service
  if (!s) return info.label
  if (s.loopback && SERVICE_PRESETS[s.preset]?.free && presetApplies(s.preset, s.host)) return SERVICE_PRESETS[s.preset].label
  return s.host
}
