/**
 * The chat format of each pinned model, written by Flown (docs/design/smart-tools.md §9.6): the
 * helper never reads or runs a GGUF's own Jinja template. The prompt is a list of parts whose
 * `special` says whether the helper parses special tokens in it: only the template's own pieces
 * are special; the system and user text are not, so text such as `<turn|>` or `</think>` in a
 * transcript is read as plain characters and cannot close the user turn. As a second guard every
 * control and user-defined token string of the pinned vocabularies is broken with a zero-width
 * joiner in that text (breakSpecialTokens).
 *
 * The pieces were checked against each pinned file's own template rendered for a sample with
 * thinking off (tests/fixtures/llm/<id>-chat.txt, scripts/llm-special-tokens.mjs).
 */

export interface ChatPart {
  t: string
  special: boolean
}

/**
 * Every CONTROL and USER_DEFINED token string of each pinned vocabulary (tokenizer.ggml.tokens
 * whose token_type is 3 or 4), as scripts/llm-special-tokens.mjs saved them in
 * tests/fixtures/llm/<id>-special.json; tests/chatFormat.test.ts checks they agree.
 */
export const SPECIAL_TOKENS: Readonly<Record<'qwen' | 'gemma', readonly string[]>> = Object.freeze({
  gemma: Object.freeze([
    '<pad>', '<bos>', '<unk>', '<mask>', '<|tool>', '<tool|>', '<|tool_call>', '<tool_call|>', '<|tool_response>', '<tool_response|>', '<|"|>', '<|think|>',
    '<|channel>', '<channel|>', '<|turn>', '<turn|>', '<|image>', '<|audio>', '<|image|>', '<|audio|>', '<image|>', '<audio|>', '<|video|>'
  ]),
  qwen: Object.freeze([
    '<|endoftext|>', '<|im_start|>', '<|im_end|>', '<|object_ref_start|>', '<|object_ref_end|>', '<|box_start|>', '<|box_end|>', '<|quad_start|>', '<|quad_end|>',
    '<|vision_start|>', '<|vision_end|>', '<|vision_pad|>', '<|image_pad|>', '<|video_pad|>', '<tool_call>', '</tool_call>', '<|fim_prefix|>', '<|fim_middle|>',
    '<|fim_suffix|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<tool_response>', '</tool_response>', '<think>', '</think>', '<|audio_start|>', '<|audio_end|>',
    '<tts_pad>', '<tts_text_bos>', '<tts_text_eod>', '<tts_text_bos_single>', '<|audio_pad|>'
  ])
})

/** The template's own pieces around the system and user text, thinking off (§9.6). */
const PIECES: Readonly<Record<'qwen' | 'gemma', readonly [string, string, string]>> = {
  // Gemma 4: no <|think|> in the system turn, as the template writes it with enable_thinking false.
  gemma: ['<|turn>system\n', '<turn|>\n<|turn>user\n', '<turn|>\n<|turn>model\n'],
  // Qwen3.5: the empty think block is what the template writes with thinking off.
  qwen: ['<|im_start|>system\n', '<|im_end|>\n<|im_start|>user\n', '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n']
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MATCHERS: Readonly<Record<'qwen' | 'gemma', RegExp>> = {
  gemma: new RegExp([...SPECIAL_TOKENS.gemma].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g'),
  qwen: new RegExp([...SPECIAL_TOKENS.qwen].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g')
}

/** U+200D ZERO WIDTH JOINER, put after the first character of every special token string. */
const ZWJ = '‍'

/** `text` with every control and user-defined token string of `family`'s vocabulary broken by a zero-width joiner. */
export function breakSpecialTokens(text: string, family: 'qwen' | 'gemma'): string {
  return text.replace(MATCHERS[family], (m) => m.slice(0, 1) + ZWJ + m.slice(1))
}

/**
 * The chat for `system` and `user` in `family`'s format: the template's pieces special, the text
 * (trimmed, as both templates trim it; special token strings broken) not.
 */
export function chatParts(family: 'qwen' | 'gemma', system: string, user: string): ChatPart[] {
  const [open, between, close] = PIECES[family]
  return [
    { t: open, special: true },
    { t: breakSpecialTokens(system.trim(), family), special: false },
    { t: between, special: true },
    { t: breakSpecialTokens(user.trim(), family), special: false },
    { t: close, special: true }
  ]
}

/** The parts' text joined (tests compare it with the template's own rendering). */
export function chatPrompt(family: 'qwen' | 'gemma', system: string, user: string): string {
  return chatParts(family, system, user)
    .map((p) => p.t)
    .join('')
}
