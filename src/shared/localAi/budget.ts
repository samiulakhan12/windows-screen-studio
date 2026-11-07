/**
 * How text tasks are split for AI on this PC (docs/design/smart-tools.md §9.6): smaller batches and
 * a token budget for the transcript, and the room each answer gets. Part P4 writes this file; the
 * contracts' stub gives its exported names and the services' limits.
 */
import type { AiTextTask, NamesRequest } from '../api/ai'
import { DEFAULT_TEXT_LIMITS, type TextLimits, type TextPrompt } from '../captions/transcriptText'

/** The context the helper runs with (§9.2). */
export const LOCAL_CTX = 8192
/** Prompt tokens read between two checks for Stop (§9.2). */
export const PROMPT_BATCH = 64

export function localLimits(language: string | undefined, family: 'qwen' | 'gemma'): TextLimits {
  void language
  void family
  return DEFAULT_TEXT_LIMITS
}

export function maxTokensFor(prompt: TextPrompt, task: AiTextTask, family: 'qwen' | 'gemma', kind?: NamesRequest['kind']): number {
  void prompt
  void task
  void family
  void kind
  return 0
}
