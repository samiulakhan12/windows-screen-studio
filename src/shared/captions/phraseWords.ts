/**
 * The words line breaks look at (docs/design/captions-studio.md §8.3): join words per language,
 * sentence and clause ends, numbers and their units, and the Chinese and Japanese line rules
 * (kinsoku). The word lists were written for Flown (CC0-1.0).
 */

/** Words a line should not end with and may start with (§8.3), by language; other languages use punctuation and pauses only. */
export const JOIN_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['and', 'but', 'or', 'so', 'because', 'that', 'which', 'when', 'while', 'if', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into', 'than'],
  bn: ['এবং', 'কিন্তু', 'অথবা', 'যে', 'কারণ'],
  hi: ['और', 'लेकिन', 'या', 'कि', 'क्योंकि'],
  es: ['y', 'e', 'o', 'u', 'pero', 'porque', 'que', 'cuando', 'mientras', 'si', 'a', 'de', 'del', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'desde', 'hasta', 'entre', 'como'],
  fr: ['et', 'mais', 'ou', 'donc', 'car', 'parce', 'que', 'qui', 'quand', 'si', 'à', 'au', 'aux', 'de', 'du', 'en', 'dans', 'sur', 'pour', 'avec', 'par', 'sans', 'vers', 'chez', 'entre', 'comme'],
  de: ['und', 'aber', 'oder', 'denn', 'weil', 'dass', 'wenn', 'als', 'ob', 'zu', 'von', 'vom', 'in', 'im', 'an', 'am', 'auf', 'für', 'mit', 'aus', 'bei', 'nach', 'über', 'durch', 'um'],
  pt: ['e', 'mas', 'ou', 'porque', 'que', 'quando', 'enquanto', 'se', 'a', 'de', 'do', 'da', 'em', 'no', 'na', 'com', 'por', 'para', 'sem', 'sobre', 'desde', 'até', 'entre', 'como']
}

/**
 * Words a line should not end with though a line may well start with them (§8.3: "a line ends in
 * 'the'"): articles and determiners, by language. Like the join words, a break after one costs +4,
 * but a break before one earns nothing.
 */
export const END_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'a', 'an', 'my', 'your', 'our', 'their', 'its', 'his', 'her'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'mi', 'tu', 'su'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', 'mon', 'ma', 'mes', 'ton', 'ta', 'son', 'sa', 'ses', 'ce', 'cette'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'mein', 'dein', 'sein', 'ihr'],
  pt: ['o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'meu', 'minha', 'seu', 'sua']
}

/**
 * Postpositions, which go with the word before them ("ঢাকা থেকে", "दिल्ली से"): a line should not
 * start with one (§8.3), so a break before one costs +4, by language.
 */
export const POST_WORDS: Readonly<Record<string, readonly string[]>> = {
  bn: ['জন্য', 'থেকে', 'দিয়ে', 'সাথে'],
  hi: ['के', 'की', 'का', 'में', 'से', 'पर']
}

/**
 * Words that go with the number before them (§8.3: "300 percent", "5 million"): units, magnitudes
 * and currencies. A break between a number and one of these costs +8.
 */
export const UNIT_WORDS: ReadonlySet<string> = new Set([
  '%', 'percent', 'percentage', 'points', 'times', 'x', '×', 'k', 'm', 'b', 'bn', 'thousand', 'million', 'millions', 'billion', 'billions', 'trillion', 'lakh', 'lakhs', 'crore', 'crores',
  'dollars', 'dollar', 'euros', 'euro', 'pounds', 'pound', 'rupees', 'rupee', 'taka', 'yen', 'usd', 'eur', 'gbp', 'inr', 'bdt',
  'px', 'pixels', 'pixel', 'ms', 's', 'sec', 'secs', 'seconds', 'second', 'min', 'mins', 'minutes', 'minute', 'hours', 'hour', 'h', 'days', 'day', 'weeks', 'months', 'years', 'year',
  'kb', 'mb', 'gb', 'tb', 'fps', 'hz', 'khz', 'mhz', 'ghz', 'km', 'cm', 'mm', 'kg', 'g', 'lb', 'lbs', 'users', 'people',
  'শতাংশ', 'টাকা', 'হাজার', 'লাখ', 'কোটি', 'প্রতিশত', 'प्रतिशत', 'रुपये', 'हज़ार', 'हजार', 'लाख', 'करोड़',
  'prozent', 'millones', 'millionen', 'milhões', 'mil', 'mille'
])

/** A currency sign standing alone before its number ("$ 5"). */
export const CURRENCY = /^[$€£¥₹৳₽₩]$/u

/** A word that ends a sentence (§8.2, §8.3). */
export const SENTENCE_END = /[.!?…।۔。！？]["'”’)\]]*$/u
/** A word that ends a clause. */
export const CLAUSE_END = /[,;:–—、，；：]["'”’)\]]*$/u
/** Never at the start of a line (closing punctuation, the prolonged sound mark; §8.3 kinsoku). */
export const NO_LINE_START = /^[、。，．・：；？！ー」』）】〉》〕…]/u
/** Never at the end of a line (opening punctuation). */
export const NO_LINE_END = /[「『（【〈《〔]$/u
