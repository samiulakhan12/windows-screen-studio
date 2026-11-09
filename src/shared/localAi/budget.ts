/**
 * How text tasks are split for AI on this PC (docs/design/smart-tools.md §9.6): smaller batches, a
 * token budget for the transcript, and the room each answer gets. Prompt tokens are estimated from
 * characters by script for each model's tokenizer (§11.2: Qwen 4.8 characters a token in English,
 * 2.04 in Bangla; Gemma 4.84 and 3.45); the prompt plus the answer's room stays within the
 * context the helper runs with, less one batch.
 */
import type { AiTextTask, NamesRequest } from '../api/ai'
import type { TextLimits, TextPrompt } from '../captions/transcriptText'

/** The context the helper runs with (§9.2). */
export const LOCAL_CTX = 8192
/** Prompt tokens read between two checks for Stop (§9.2). */
export const PROMPT_BATCH = 64
/** The most a prompt and its answer's room may take: the context less one batch (8,128). */
export const LOCAL_BUDGET = LOCAL_CTX - PROMPT_BATCH
/** Prompt tokens of the transcript (title, summary, the copy pack) and of a script's notes. */
export const LOCAL_TRANSCRIPT_TOKENS = 4500
/** The most room one answer gets (cleanup and translation). */
export const LOCAL_ANSWER_MAX = 4096
/** The room of a script draft (not a text task: Draft script's own prompt). */
export const SCRIPT_MAX_TOKENS = 2000
/** A cut-off answer is tried once more with this much more room. */
export const RETRY_ROOM = 1.5

/** Characters a token: Latin script, and every other (Bangla measured). */
export const LOCAL_TOKEN_RATIOS: Readonly<Record<'qwen' | 'gemma', { latin: number; other: number }>> = {
  qwen: { latin: 4.8, other: 2.04 },
  gemma: { latin: 4.84, other: 3.45 }
}

/** About how many tokens `text` is for `family`'s tokenizer: by its Latin and other characters. */
export function localTokens(text: string, family: 'qwen' | 'gemma'): number {
  let latin = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 0x0250) latin++
    else other++
  }
  const r = LOCAL_TOKEN_RATIOS[family]
  return Math.ceil(latin / r.latin + other / r.other)
}

/** The tokens of a whole prompt: its system and user text and the chat template's pieces. */
export function promptTokens(prompt: Pick<TextPrompt, 'system' | 'user'>, family: 'qwen' | 'gemma'): number {
  return localTokens(prompt.system, family) + localTokens(prompt.user, family) + 24
}

/**
 * The limits AI on this PC runs text tasks with (§9.6): clean-up and translation in batches of 40
 * captions or 3,000 characters; title, summary and the copy pack read evenly spaced excerpts within
 * 4,500 prompt tokens; names 12 items or 3,000 characters a request. The language and the family
 * do not change these numbers: they fit the context for either model in English and Bangla.
 */
export function localLimits(language: string | undefined, family: 'qwen' | 'gemma'): TextLimits {
  void language
  void family
  return { batchSegments: 40, batchChars: 3000, transcriptTokens: LOCAL_TRANSCRIPT_TOKENS, namesItems: 12, namesChars: 3000 }
}

/** The JSON data block after the prompt's first line, or null. */
function dataOf(prompt: Pick<TextPrompt, 'user'>): Record<string, unknown> | null {
  const at = prompt.user.indexOf('\n')
  try {
    const v = JSON.parse(at >= 0 ? prompt.user.slice(at + 1) : prompt.user) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Room for the captions of a clean-up or translation: their text in the target script × 1.3, 12 a caption, 64 more. */
function captionsRoom(prompt: TextPrompt, task: 'cleanup' | 'translate', family: 'qwen' | 'gemma'): number {
  const segments = dataOf(prompt)?.segments
  const texts = Array.isArray(segments) ? segments.map((s) => (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string' ? (s as { text: string }).text : '')) : []
  const chars = texts.reduce((n, t) => n + [...t].length, 0)
  // A translation's script is not known here: counted as the denser one (more tokens), so it never runs short.
  const tokens = task === 'translate' ? Math.ceil(chars / LOCAL_TOKEN_RATIOS[family].other) : texts.reduce((n, t) => n + localTokens(t, family), 0)
  return Math.ceil(tokens * 1.3) + 12 * texts.length + 64
}

/** The room of each task's answer (§9.6). */
const FIXED: Partial<Record<AiTextTask, number>> = { title: 80, summary: 400, youtube: 1000, linkedin: 700, xpost: 160, article: 2200, releaseNotes: 1400 }

/**
 * The most tokens `prompt`'s answer may take (§9.6): clean-up and translation ceil(text tokens ×
 * 1.3) + 12 a caption + 64, at most 4,096; title 80; summary 400; names 48 an item + 32 (notes 120
 * an item + 32); YouTube 1,000; LinkedIn 700; X 160; article 2,200; release notes 1,400. Never more
 * than leaves the prompt and its answer within LOCAL_BUDGET.
 */
export function maxTokensFor(prompt: TextPrompt, task: AiTextTask, family: 'qwen' | 'gemma', kind?: NamesRequest['kind']): number {
  let room: number
  if (task === 'cleanup' || task === 'translate') room = Math.min(LOCAL_ANSWER_MAX, captionsRoom(prompt, task, family))
  else if (task === 'names') {
    const items = dataOf(prompt)?.items
    const n = Array.isArray(items) ? items.length : 1
    room = (kind === 'note' ? 120 : 48) * n + 32
  } else room = FIXED[task] ?? 400
  return Math.max(16, Math.min(room, LOCAL_BUDGET - promptTokens(prompt, family)))
}

/** Whether a prompt with `maxTokens` of room fits the context (else it is too long for this PC). */
export function fitsContext(prompt: Pick<TextPrompt, 'system' | 'user'>, maxTokens: number, family: 'qwen' | 'gemma'): boolean {
  return promptTokens(prompt, family) + maxTokens <= LOCAL_BUDGET
}
