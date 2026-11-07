/**
 * The chat template of each pinned model, written by Flown (docs/design/smart-tools.md §9.6): parts
 * whose `special` says whether the helper parses special tokens in them. Part P4 writes this file;
 * the contracts' stub gives its exported names.
 */

export interface ChatPart {
  t: string
  special: boolean
}

export function chatParts(family: 'qwen' | 'gemma', system: string, user: string): ChatPart[] {
  void family
  return [
    { t: system, special: false },
    { t: user, special: false }
  ]
}

export function chatPrompt(family: 'qwen' | 'gemma', system: string, user: string): string {
  return chatParts(family, system, user)
    .map((p) => p.t)
    .join('')
}

export function breakSpecialTokens(text: string, family: 'qwen' | 'gemma'): string {
  void family
  return text
}
