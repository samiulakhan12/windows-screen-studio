// Word and character error rates for Bangla transcripts (the Bangla model's benchmark,
// scripts/bench-bangla.mjs; docs/design/offline-captions.md §14). Pure, no dependencies.
//
// Normalisation, applied identically to the reference and the hypothesis:
//   1. the legacy khanda ta (ত + ্ + ZWJ) becomes ৎ, and অ + া becomes আ;
//   2. zero-width and soft characters are dropped (ZWSP, ZWNJ, ZWJ, WJ, BOM, soft hyphen);
//   3. Unicode NFC (whisper's byte tokens can leave ো as ে + া);
//   4. Bengali and Devanagari digits become ASCII; a comma between two digits is dropped;
//   5. lower case (Latin words);
//   6. punctuation (the dari । and ॥ included), symbols and control characters become spaces;
//      combining marks (vowel signs, hasanta, chandrabindu, anusvara, visarga, nukta) are kept, so
//      Bangla words are never split apart (whisper's English normaliser would split them);
//   7. whitespace collapsed to single spaces and trimmed.
// WER = word edits / reference words; CER = code point edits / reference code points (spaces
// kept, as jiwer counts them).

const ZERO_WIDTH = /[​‌‍⁠﻿­]/g

/** The text as it is scored (see above). */
export function normaliseBangla(text) {
  let s = String(text ?? '')
  s = s.replace(/ত্‍/g, 'ৎ').replace(/অা/g, 'আ')
  s = s.replace(ZERO_WIDTH, '')
  s = s.normalize('NFC')
  s = s.replace(/[০-৯]/g, (d) => String(d.codePointAt(0) - 0x09e6)).replace(/[०-९]/g, (d) => String(d.codePointAt(0) - 0x0966))
  s = s.replace(/(\d),(?=\d)/g, '$1')
  s = s.toLowerCase()
  // A dot between digits is part of the number (3.5); every other punctuation, symbol or control character is a space.
  s = s.replace(/(\d)\.(?=\d)/g, '$1')
  s = s.replace(/[\p{P}\p{S}\p{C}]/gu, (c) => (c === '' ? c : ' ')).replace(//g, '.')
  return s.replace(/\s+/g, ' ').trim()
}

/** Levenshtein distance between two sequences. */
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** WER and CER of `hypothesis` against `reference`, both normalised first, with the counts. */
export function scoreBangla(reference, hypothesis) {
  const ref = normaliseBangla(reference)
  const hyp = normaliseBangla(hypothesis)
  const refWords = ref ? ref.split(' ') : []
  const hypWords = hyp ? hyp.split(' ') : []
  const refChars = [...ref]
  const wordEdits = editDistance(refWords, hypWords)
  const charEdits = editDistance(refChars, [...hyp])
  return {
    wer: refWords.length ? wordEdits / refWords.length : hypWords.length ? 1 : 0,
    cer: refChars.length ? charEdits / refChars.length : hyp.length ? 1 : 0,
    words: refWords.length,
    hypothesisWords: hypWords.length,
    wordEdits,
    charEdits,
    reference: ref,
    hypothesis: hyp
  }
}
