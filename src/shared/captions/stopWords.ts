/**
 * Stop words for auto emphasis (docs/design/captions-studio.md §11.1): short function-word lists
 * per language (en, bn, hi, es, fr, de, pt), written for Flown, CC0-1.0. Negations, "only",
 * "every" and superlatives are never in them.
 *
 * CONTRACT (part P4): the lists are to be written.
 */
export const STOP_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {}
