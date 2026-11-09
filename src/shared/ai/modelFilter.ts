/**
 * Which of a provider's models each model field offers (docs/design/smart-tools.md §10.4). OpenAI's
 * list (and a service's, which speaks its API) holds speech, picture, embedding and moderation models
 * too: the text field leaves those and the transcription models out, and the transcription field
 * keeps only ids with "whisper" or "transcribe". Gemini's list is already its generateContent
 * models, which do both. Claude cannot transcribe. Pure.
 */
import type { AiProviderKind } from '../types'

/** Models neither field uses: speech, pictures, embeddings and moderation. */
export const UNUSED_MODEL_RE = /(^|[/:._-])(tts|dall-e|gpt-image|embedding|moderation)|text-embedding|omni-moderation/i
const TRANSCRIBE_RE = /whisper|transcribe/i

/** The ids of `ids` model field `field` offers for a provider of `kind`. */
export function filterModels(kind: AiProviderKind, ids: readonly string[], field: 'text' | 'transcription'): string[] {
  if (kind === 'anthropic') return field === 'text' ? [...ids] : []
  if (kind === 'gemini') return ids.filter((id) => !UNUSED_MODEL_RE.test(id))
  if (field === 'transcription') return ids.filter((id) => TRANSCRIBE_RE.test(id))
  return ids.filter((id) => !UNUSED_MODEL_RE.test(id) && !TRANSCRIBE_RE.test(id))
}
