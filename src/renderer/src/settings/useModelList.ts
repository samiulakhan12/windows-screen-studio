import { useEffect, useState } from 'react'
import { AI_PROVIDER_KINDS } from '../../../shared/api/ai'
import type { ModelDefaults, ModelList } from '../../../shared/ai/modelList'
import type { AiProviderKind } from '../../../shared/types'

let asked: Promise<ModelList | null> | null = null

/** The suggested AI models main has (NW-15): asked once per window, null until it answers. */
export function useModelList(): ModelList | null {
  const [list, setList] = useState<ModelList | null>(null)
  useEffect(() => {
    let live = true
    asked ??= window.api.getAiModelList().catch(() => null)
    void asked.then((l) => {
      if (live) setList(l)
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
