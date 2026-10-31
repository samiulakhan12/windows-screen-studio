import { useEffect, useState } from 'react'
import { AI_PROVIDER_KINDS } from '../../../shared/api/ai'
import type { ModelDefaults, ModelList } from '../../../shared/ai/modelList'
import type { AiProviderKind } from '../../../shared/types'

/** Main's last answer, shown until it answers again. */
let last: ModelList | null = null

/**
 * The suggested AI models main has (NW-15): asked each time Settings or the provider form opens, as
 * main refreshes its list while Flown runs; until it answers, its last answer (null at first).
 */
export function useModelList(): ModelList | null {
  const [list, setList] = useState<ModelList | null>(last)
  useEffect(() => {
    let live = true
    void window.api
      .getAiModelList()
      .catch(() => null)
      .then((l) => {
        if (l) last = l
        if (live) setList(l ?? last)
      })
    return () => {
      live = false
    }
  }, [])
  return list
}

/** A kind's suggested models: the list's, or the built-in ones until it answers. */
export function suggestedModels(list: ModelList | null, kind: AiProviderKind): ModelDefaults {
  return list?.providers[kind] ?? { model: AI_PROVIDER_KINDS[kind].defaultModel, transcriptionModel: AI_PROVIDER_KINDS[kind].defaultTranscriptionModel }
}

/** Today on this PC, YYYY-MM-DD. */
export function today(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
