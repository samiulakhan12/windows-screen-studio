/**
 * Captions Studio test 40 (docs/design/captions-studio.md §11.6): each rule of Auto style, the gate
 * that never replaces a look picked by hand, the brand body font, and the first captions.
 */
import { describe, expect, it } from 'vitest'
import { autoStyle, autoStyleAllowed, autoStyleOnFirstCaptions, cameraLed, suggestedTile } from '../src/shared/captions/autoStyle'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment } from '../src/shared/types'
import { captions, SQUARE, studioProject, TALL, WIDE } from './p4Fixtures'

const segs = captions(['Hello and welcome to the show', 'Today we look at the export', 'Thanks for watching'])

describe('auto style (test 40)', () => {
  it('2a: a tall camera-led video gets Bold Pop, at Lower instead of Bottom', () => {
    const p = studioProject({ segments: segs, camera: 'large', aspect: '9:16' })
    expect(cameraLed(p, TALL)).toBe(true)
    const r = autoStyle(p, TALL)!
    expect(r.tile).toBe('bold-pop')
    expect(r.reason).toBe('Bold Pop: you are on camera in a tall video')
    expect(r.studio.from).toBe('bold-pop')
    if (studioPreset('bold-pop')!.look.layout.position === 'bottom') expect(r.studio.layout.position).toBe('lower')
    expect(r.studio.layout.words).toBe(studioPreset('bold-pop')!.look.layout.words)
  })

  it('2a: 4 words when speech is fast; no spoken mark or word motion when most word times are guesses', () => {
    const fast: CaptionSegment[] = [{ id: 'f', start: 0, end: 3, text: 'one two three four five six seven eight nine ten eleven twelve', words: undefined }]
    const p = studioProject({ segments: fast, camera: 'large' })
    expect(autoStyle(p, TALL)!.studio.layout.words).toBe(4)
    const guessed: CaptionSegment[] = [{ id: 'g', start: 0, end: 10, text: 'slow words here', words: [{ text: 'slow', start: 0, end: 1, estimated: true }, { text: 'words', start: 1, end: 2, estimated: true }, { text: 'here', start: 2, end: 3 }] }]
    const g = autoStyle(studioProject({ segments: guessed, camera: 'large' }), TALL)!
    expect(g.studio.spoken).toBe('none')
    expect(g.studio.motion.word).toBe('none')
    // Nor a spoken word growing or tilting at a guessed time; with real word times it does as Bold Pop comes.
    expect(g.studio.motion.spokenScale).toBeUndefined()
    expect(g.studio.motion.spokenTilt).toBeUndefined()
    expect(autoStyle(p, TALL)!.studio.motion).toMatchObject({ spokenScale: 1.18, spokenTilt: -2 })
  })

  it('2b: a tall screen recording gets Clean Short', () => {
    expect(autoStyle(studioProject({ segments: segs }), TALL)).toMatchObject({ tile: 'clean-short', reason: 'Clean Short: a screen recording for phones' })
  })

  it('3: square frames, camera-led or not', () => {
    const cam = autoStyle(studioProject({ segments: segs, camera: 'large' }), SQUARE)!
    expect(cam).toMatchObject({ tile: 'highlight-box', reason: 'Highlight Box: a square video for feeds' })
    expect(cam.studio.layout).toMatchObject({ words: 5, lines: 2 })
    const screen = autoStyle(studioProject({ segments: segs }), SQUARE)!
    expect(screen).toMatchObject({ tile: 'clean-short', reason: 'Clean Short: a square screen recording' })
    expect(screen.studio.layout.words).toBe(4)
  })

  it('4 and 5: wide frames, with two named speakers or not', () => {
    const two = segs.map((s, i) => ({ ...s, speaker: i % 2 ? 'Priya' : 'Sam' }))
    const named = autoStyle(studioProject({ segments: two }), WIDE)!
    expect(named).toMatchObject({ tile: 'subtitle', reason: 'Subtitle with names and a colour per speaker' })
    expect(named.studio.speakerColors).toBe(true)
    expect(autoStyle(studioProject({ segments: segs }), WIDE)).toMatchObject({ tile: 'subtitle', reason: 'Subtitle: clean subtitles for a long video' })
  })

  it('1: the brand kit’s caption style wins', () => {
    const brand = { ...studioPreset('neon')!.look, from: 'mine:x' }
    expect(autoStyle(studioProject({ segments: segs }), TALL, brand)).toMatchObject({ tile: 'brand', reason: "Your brand kit's caption style", studio: { from: 'brand' } })
  })

  it('never replaces a look picked by hand; a project on the default is unpicked; a legacy pick stays', () => {
    const picked = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, picked: true } })
    expect(autoStyleAllowed(picked)).toBe(false)
    expect(autoStyle(picked, WIDE)).toBeNull()
    expect(autoStyleAllowed(studioProject({ segments: segs }))).toBe(true)
    expect(autoStyleAllowed(studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, show: false, showSpeaker: true, track: 'bn' } }))).toBe(true)
    expect(autoStyleAllowed(studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, preset: 'boxed' } }))).toBe(false)
    expect(autoStyleAllowed(studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, studio: studioPreset('neon')!.look } }))).toBe(true)
  })

  it('a brand body font in captions.font does not block it and becomes the look’s text font', () => {
    const p = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, font: 'brandfont1' } })
    expect(autoStyleAllowed(p)).toBe(true)
    expect(autoStyle(p, WIDE)!.studio.text.font).toBe('brandfont1')
  })

  it('Chinese, Japanese and Thai keep their case and get 24 / 16 characters', () => {
    const r = autoStyle(studioProject({ segments: captions(['我们今天学习如何导出视频']), language: 'zh' }), TALL)!
    expect(r.studio.text.case).toBe('asis')
    expect(r.studio.layout).toMatchObject({ chars: 24, tallChars: 16 })
  })

  it('runs on the first captions only, with no record', () => {
    const before = studioProject()
    const after = studioProject({ segments: segs, captions: { ...DEFAULT_CAPTIONS, show: true } })
    const out = autoStyleOnFirstCaptions(before, after, TALL)
    expect(out.captions?.studio?.from).toBe('clean-short')
    expect(out.captions?.preset).toBe(studioPreset('clean-short')!.fallback)
    expect(out.captions?.picked).toBeUndefined()
    expect(out.captions?.show).toBe(true)
    expect(out.captionAuto).toBeUndefined()
    // Captions there already: unchanged.
    expect(autoStyleOnFirstCaptions(after, { ...after }, TALL).captions).toBe(after.captions)
  })

  it('the Suggested badge: Karaoke Fill in a wide camera-led project', () => {
    expect(suggestedTile(studioProject({ segments: segs, camera: 'large' }), WIDE)).toBe('karaoke-fill')
    expect(suggestedTile(studioProject({ segments: segs }), WIDE)).toBe('subtitle')
    expect(suggestedTile(studioProject({ segments: segs, camera: 'large' }), TALL)).toBe('bold-pop')
  })
})
