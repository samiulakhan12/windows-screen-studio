/**
 * Every phrase of guides and demos in English and Bangla (docs/design/smart-tools.md §15). Part P1
 * writes it; the contracts' stub gives its exported names.
 */
import type { Project } from '../types'

/** Part P1 lists every phrase of §15. */
export interface GuideWords {
  step: string
}

export const GUIDE_WORDS: Record<'en' | 'bn', GuideWords> = { en: { step: 'Step' }, bn: { step: 'ধাপ' } }

export function guideLanguage(project: Project): 'en' | 'bn' {
  return project.guide?.language ?? (project.transcript?.language?.toLowerCase().startsWith('bn') ? 'bn' : 'en')
}
