/**
 * Whether main's answer to a job says it was cancelled (docs/design/output-and-languages.md §9.6):
 * its English "Cancelled.", or the errors.cancelled message where main words it in the UI language.
 * Until every cancel carries a code, the renderer accepts both.
 */
import { t } from '../../../shared/i18n/t'

export const isCancel = (message: string): boolean => message === 'Cancelled.' || message === t('errors.cancelled')
