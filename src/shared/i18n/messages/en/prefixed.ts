/** A namespace's messages under their full keys ("codecs" + "hevc.title" → "codecs.hevc.title"). */
export function prefixed(ns: string, messages: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, text] of Object.entries(messages)) out[`${ns}.${key}`] = text
  return out
}
