/**
 * AI on this PC as an AiClient (docs/design/smart-tools.md §9.6): each json(prompt) is one helper
 * request, with the local limits. Part P4 writes this file; until then the contracts' stub refuses.
 */
import type { WebContents } from 'electron'
import type { AiTextRequest } from '../../shared/api/ai'
import type { TextLimits } from '../../shared/captions/transcriptText'
import type { AiClient } from '../ai/types'

export async function localTextClient(ctx: { sender: WebContents; requestId?: string }): Promise<AiClient & { limits(request: AiTextRequest): TextLimits }> {
  void ctx
  throw new Error('AI on this PC is not part of this build.')
}
