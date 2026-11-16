import { AI_PROVIDER_KINDS, type AiProviderInfo } from '../../../shared/api/ai'
import { t } from '../../../shared/i18n/t'

/** "Error invoking remote method 'x': Error: message" (or TypeError: …) -> "message". */
export const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** What a provider of `kind` can do, in a sentence. */
export const canDo = (kind: AiProviderInfo['kind']): string => (AI_PROVIDER_KINDS[kind].canTranscribe ? t('settings.ai.canTranscribeDo') : t('settings.ai.serviceCanDo'))
