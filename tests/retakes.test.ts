import { describe, expect, it } from 'vitest'
import { findRetakes, RETAKE_WINDOW, SENTENCE_PAUSE, sentencesOf } from '../src/shared/editor/retakes'
import type { TranscriptWord } from '../src/shared/editor/transcript'

/**
 * Words said 0.1 s apart; "|" before a word is a pause of `pause` seconds; "#" before a word starts
 * a new caption (with no pause).
 */
function say(text: string, pause = 1): TranscriptWord[] {
  const out: TranscriptWord[] = []
  let at = 0
  let caption = 0
  for (let raw of text.split(' ')) {
    if (raw.startsWith('#')) {
      caption++
      raw = raw.slice(1)
    }
    if (raw.startsWith('|')) {
      at += pause
      raw = raw.slice(1)
    }
    out.push({ index: out.length, caption: `c${caption}`, text: raw, start: at, end: at + 0.3, estimated: false })
    at += 0.4
  }
  return out
}

const spans = (w: TranscriptWord[], lang?: string): string[] => findRetakes(w, lang).map((m) => `${m.kind}: ${w.slice(m.span[0], m.span[1] + 1).map((x) => x.text).join(' ')}`)

describe('sentences', () => {
  it('end at . ? ! … and the Bangla full stop, at long pauses, and at a caption end before a short pause', () => {
    const w = say('One two. Three? Four |five #six seven। eight… nine')
    expect(sentencesOf(w)).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
      [4, 6],
      [7, 7],
      [8, 8]
    ])
    // A caption change without a pause does not end one; with a pause of 0.3 s it does.
    expect(sentencesOf(say('one #two three'))).toEqual([[0, 2]])
    expect(sentencesOf(say('one #|two three', 0.3))).toEqual([
      [0, 0],
      [1, 2]
    ])
    expect(sentencesOf(say('one |two three', 0.3))).toEqual([[0, 2]])
  })

  it('uses SENTENCE_PAUSE', () => {
    expect(sentencesOf(say('a |b', SENTENCE_PAUSE))).toEqual([
      [0, 0],
      [1, 1]
    ])
    expect(sentencesOf(say('a |b', SENTENCE_PAUSE - 0.2))).toEqual([[0, 1]])
  })
})

describe('retakes', () => {
  it('suggests a false start, keeping the later take', () => {
    const w = say('So the first thing |So the first thing you do is open settings.')
    expect(spans(w)).toEqual(['retake: So the first thing'])
  })

  it('suggests a sentence said again with small changes', () => {
    const w = say('Today we will look at the new export dialog. Today we are going to look at the new export dialog.')
    expect(spans(w)).toEqual(['retake: Today we will look at the new export dialog.'])
  })

  it('keeps only the last of three takes', () => {
    const w = say('Click the big button. Click the big blue button. Click the big blue button now.')
    expect(spans(w)).toEqual(['retake: Click the big button.', 'retake: Click the big blue button.'])
  })

  it('takes a short sentence between two takes along', () => {
    const w = say('Open the file menu. Sorry, again. Open the file menu first.')
    expect(spans(w)).toEqual(['retake: Open the file menu. Sorry, again.'])
  })

  it('does not reach over a long sentence between two takes', () => {
    const w = say('Open the file menu. Then I will show you something quite different here today. Open the file menu first.')
    expect(spans(w)).toEqual([])
  })

  it('needs the later take within RETAKE_WINDOW', () => {
    const near = say(`Open the file menu. |Open the file menu first.`, RETAKE_WINDOW - 1)
    expect(spans(near)).toHaveLength(1)
    const far = say(`Open the file menu. |Open the file menu first.`, RETAKE_WINDOW + 1)
    expect(spans(far)).toEqual([])
  })

  it('needs the same start: different sentences with shared words are not retakes', () => {
    const w = say('Open the menu and save it. Then later you open the menu and save it.')
    expect(spans(w)).toEqual([])
    const unlike = say('The cat sat down. A dog ran off quickly.')
    expect(spans(unlike)).toEqual([])
  })

  it('takes two-word sentences only when the next starts with the same two words', () => {
    expect(spans(say('So now. |So now we export.'))).toEqual(['retake: So now.'])
    expect(spans(say('So now. |Now so we export.'))).toEqual([])
  })

  it('ignores fillers when comparing takes', () => {
    const w = say('Um open the file menu. Open the uh file menu first.')
    expect(spans(w)).toEqual(['retake: Um open the file menu.'])
  })

  it('suggests stutters, the first run, fillers after it included', () => {
    expect(spans(say('I think I think this works'))).toEqual(['repeat: I think'])
    expect(spans(say('the the end'))).toEqual(['repeat: the'])
    expect(spans(say('I, um, I said so'))).toEqual(['repeat: I, um,'])
  })

  it('skips words often doubled on purpose', () => {
    expect(spans(say('I know that that is true'))).toEqual([])
    expect(spans(say('it is very very good'))).toEqual([])
  })

  it('does not count repeats far apart in time', () => {
    expect(spans(say('the |the end', 2))).toEqual([])
  })

  it('leaves out stutters inside a retake', () => {
    const w = say('The the first thing. The first thing you do is open settings.')
    expect(spans(w)).toEqual(['retake: The the first thing.'])
  })
})
