import { describe, expect, it } from 'vitest'
import { CUE_WORDS, cutName, LEAD_WORDS, sentenceName } from '../src/shared/smart/sentenceName'

/*
 * The sentenceName and cutName cases of test 39 (docs/design/smart-tools.md §22.1, written in the
 * contracts step) and the rule-2 case of test 118: names from the first sentence said (§7.5 rule 2)
 * and the first sentence cut short (rule 4), never holding a link or a path.
 */

describe('sentenceName (§7.5 rule 2)', () => {
  it('removes cue words, lead-ins and fillers, cuts at the clause, and capitalises', () => {
    expect(sentenceName("Now let's set up billing, which takes a minute.", 'en')).toBe('Set up billing')
    expect(sentenceName('So, okay, first we open the settings page', 'en')).toBe('Open the settings page')
    expect(sentenceName('Next we open settings', 'en')).toBe('Open settings')
    expect(sentenceName('Um, so you can export the report because it is done', 'en')).toBe('Export the report')
    expect(sentenceName('Moving on, set up the export and then share it', 'en')).toBe('Set up the export')
    expect(sentenceName('Step 3: open the settings; then save', 'en')).toBe('Open the settings')
    expect(sentenceName("I'm going to open the dashboard so that we can see totals", 'en')).toBe('Open the dashboard')
  })

  it('takes 2 to 8 words after the clause cut (test 118), else none', () => {
    expect(sentenceName("Now let's open the quarterly billing report for the team, then share it", 'en')).toBe('Open the quarterly billing report for the team')
    expect(sentenceName('Open the billing settings page to look at totals', 'en')).toBeNull()
    expect(sentenceName('Now export.', 'en')).toBeNull()
    expect(sentenceName('', 'en')).toBeNull()
  })

  it('reads only the first sentence', () => {
    expect(sentenceName('Open the settings. Then click save and close everything else now please', 'en')).toBe('Open the settings')
  })

  it('works in Bangla: its cue and lead words, and its own cut words', () => {
    expect(sentenceName('এখন আমরা সেটিংস পাতাটি খুলব।', 'bn')).toBe('আমরা সেটিংস পাতাটি খুলব')
    expect(sentenceName('তো, এবার বিলিং ঠিক করব কারণ এটা জরুরি', 'bn')).toBe('বিলিং ঠিক করব')
    // Without a language, both lists are read.
    expect(sentenceName('এবার বিলিং ঠিক করব')).toBe('বিলিং ঠিক করব')
    expect(sentenceName('Next we open settings')).toBe('Open settings')
  })

  it('never names from a link, an address or a path, whoever said it', () => {
    expect(sentenceName('Now open example.com in the browser', 'en')).toBeNull()
    expect(sentenceName('Next we open C:\\Users\\sam\\notes', 'en')).toBeNull()
    expect(sentenceName('Then write to sam@example.org about it', 'en')).toBeNull()
  })

  it('lists the cue and lead words of §7.3 and §7.5', () => {
    expect(CUE_WORDS.en.common).toEqual(['now', 'next', 'first', 'then', 'so', 'okay', "let's"])
    expect(CUE_WORDS.en.section).toContain('moving on')
    expect(CUE_WORDS.bn.section).toContain('ধাপ #')
    expect(LEAD_WORDS.en).toContain("we're going to")
    expect(LEAD_WORDS.bn).toContain('চলুন')
  })
})

describe('cutName (§7.5 rule 4)', () => {
  it('cuts at a word boundary to at most 40 graphemes, without trailing punctuation', () => {
    const name = cutName('So this is a really long sentence that keeps going and going well past forty characters.')!
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].length).toBeLessThanOrEqual(40)
    expect(name).toBe('So this is a really long sentence that')
    expect(cutName('Wait for it…')).toBe('Wait for it')
    expect(cutName('Short one!')).toBe('Short one')
    expect(cutName('  ')).toBeNull()
  })

  it('never cuts inside a conjunct (ক্ষ, স্ত্র)', () => {
    const word = 'স্ত্র'.repeat(30)
    const name = cutName(word)!
    expect(name.length % 'স্ত্র'.length).toBe(0)
    expect(name.endsWith('র')).toBe(true)
    const k = cutName(`${'ক্ষ'.repeat(25)} ${'ক্ষ'.repeat(25)}`)!
    expect(k).toBe('ক্ষ'.repeat(25))
    expect(cutName('ক্ষ'.repeat(50), 7)).toBe('ক্ষ'.repeat(7))
  })

  it('is null for a link or a path', () => {
    expect(cutName('see https://example.com/start for the rest of the steps today')).toBeNull()
    expect(cutName('files live in /home/sam/projects')).toBeNull()
  })
})
