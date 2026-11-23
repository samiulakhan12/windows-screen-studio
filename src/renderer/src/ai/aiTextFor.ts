/**
 * The one way the renderer asks an AI to write text (docs/design/auto-blur.md §7.6): the request is
 * masked for the project's secrets said aloud (maskRequest) before it leaves for main, and the
 * answer comes back as aiText gives it (with its usage and model). No other file calls aiText.
 */
import type { AiApi, AiTextRequest } from '../../../shared/api/ai'
import { maskRequest } from '../../../shared/privacy/aiRequest'
import type { Project } from '../../../shared/types'

export function aiTextFor(project: Project, providerId: string, request: AiTextRequest, requestId?: string): ReturnType<AiApi['aiText']> {
  return window.api.aiText(providerId, maskRequest(request, project), requestId)
}
