import { describe, expect, it } from 'vitest'
import { readGraphicSound } from '../src/shared/audio/soundFxData'
import { ORIGINAL_SOUNDS, sfxGroups, sfxGroupsFor } from '../src/shared/audio/sfxChoices'
import { musicCredit, SOUND_EFFECTS } from '../src/shared/audio/soundLibrary'
import { DEFAULT_GREAT_OPTIONS, readGreatOptions } from '../src/shared/captions/great'
import { planGraphics, type GraphicOptions } from '../src/shared/captions/graphicRules'
import { composeYoutubeDescription, descriptionToCheck, exportDescription, projectYoutubeChapters, YOUTUBE_DESCRIPTION_MAX } from '../src/shared/publish/youtube'
import { reviewItems } from '../src/shared/review/review'
import type { MusicSettings, Project } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.7, §10.10, §19.1 tests 70 and 71):
 * Captions Studio's pop-ups take a library sound, through Make my captions great too, and Review
 * names it; a library bed's credit is the YouTube description's last line (owner decision 4).
 */

const NONE: GraphicOptions = { keywords: false, emoji: false, counters: false, lists: false, speakers: false, chapters: false, quotes: false, sound: 'none' }

describe('library sounds on pop-ups (test 70)', () => {
  it('readGreatOptions takes a catalogue SfxRef, and reads anything else as none', () => {
    expect(readGreatOptions({ sound: 'sfx:pop-soft' }).sound).toBe('sfx:pop-soft')
    expect(readGreatOptions({ sound: 'sfx:nope' }).sound).toBe('none')
    expect(readGreatOptions({ sound: 'sfx:../pop' }).sound).toBe('none')
    expect(readGreatOptions({ sound: 'ding' }).sound).toBe('ding')
    expect(readGreatOptions({ sound: 7 }).sound).toBe(DEFAULT_GREAT_OPTIONS.sound)
  })

  it('Make my captions great puts it on the pop-ups, and their Review rows name it', () => {
    const p = studioProject({ segments: captions(['Revenue grew 300% this year', 'Then quiet', 'Costs fell 20% too'], 'c', 5) })
    const out = planGraphics(p, { ...NONE, counters: true, sound: 'sfx:pop-soft' })
    const made = out.graphics!.filter((g) => g.auto)
    expect(made.length).toBeGreaterThan(0)
    for (const g of made) expect(g.sound).toBe('sfx:pop-soft')
    const rows = reviewItems(out).filter((i) => i.key.startsWith('graphic:'))
    expect(rows.length).toBe(made.length)
    for (const r of rows) expect(r.title).toMatch(/ \(with Soft pop\)$/)
    // The original sounds read as before: no "(with …)".
    const popped = planGraphics(p, { ...NONE, counters: true, sound: 'pop' })
    for (const r of reviewItems(popped).filter((i) => i.key.startsWith('graphic:'))) expect(r.title).not.toMatch(/\(with /)
  })

  it('the Sound selects: None, Original (as before), then every library effect, pop-ups first', () => {
    expect(ORIGINAL_SOUNDS).toEqual([
      { value: 'pop', label: 'Original pop' },
      { value: 'ding', label: 'Original ding' }
    ])
    const groups = sfxGroupsFor('pop-ups')
    expect(groups[0].label).toBe('Suggested')
    expect(groups[0].options.map((o) => o.value)).toEqual(SOUND_EFFECTS.filter((e) => e.uses.includes('pop-ups')).map((e) => `sfx:${e.id}`))
    const all = groups.flatMap((g) => g.options.map((o) => o.value))
    expect(all.sort()).toEqual(SOUND_EFFECTS.map((e) => `sfx:${e.id}`).sort())
    expect(sfxGroups().map((g) => g.label)).toEqual(['Whooshes', 'Pops', 'Clicks', 'Chimes'])
    // What a select gives back is read as stored: a catalogue effect, the originals, or nothing.
    for (const v of all) expect(readGraphicSound(v)).toBe(v)
    expect(readGraphicSound('none')).toBeUndefined()
  })
})

describe('the music credit (test 71, owner decision 4)', () => {
  const music: MusicSettings = { path: 'music-1.ogg', volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 }
  const base = studioProject({ segments: captions(['Hello']), duration: 60 })
  const withBed = (id: string): Project => ({ ...base, audio: { ...base.audio, music: { ...music, library: { id } } } })

  it('musicCredit names a library bed, and nothing else', () => {
    expect(musicCredit(withBed('lofi-coexistenz'))).toBe('Music: Coexistenz by Loyalty Freak Music (CC0)')
    expect(musicCredit(withBed('calm-spring-on-the-horizon'))).toBe('Music: Spring On The Horizon by HoliznaCC0 (CC0)')
    expect(musicCredit({ ...base, audio: { ...base.audio, music } })).toBeNull()
    expect(musicCredit(withBed('nope'))).toBeNull()
    expect(musicCredit(base)).toBeNull()
  })

  it('is the last line of the YouTube description, on by default when a bed is used', () => {
    const p = { ...withBed('upbeat-sweet-sun'), chapters: [{ id: 'a', t: 0, title: 'Intro' }, { id: 'b', t: 20, title: 'Settings <advanced>' }] }
    const yt = projectYoutubeChapters(p)
    expect(yt.credit).toBe('Music: Sweet Sun by Loyalty Freak Music (CC0)')
    const text = composeYoutubeDescription('How to export.', yt.chapters, yt.duration, yt.credit)
    expect(text).toBe(`${composeYoutubeDescription('How to export.', yt.chapters, yt.duration)}\n\nMusic: Sweet Sun by Loyalty Freak Music (CC0)`)
    expect(text.split('\n').at(-1)).toBe('Music: Sweet Sun by Loyalty Freak Music (CC0)')
    // The export's description file says the same as Copy.
    expect(exportDescription({ ...p, publish: { description: 'How to export.' } }, 'T', yt.duration, yt.chapters)).toBe(`${text}\n`)
    // Without a bed, or with a user's own music: the description of before.
    const own = { ...p, audio: { ...p.audio, music } }
    const plain = projectYoutubeChapters(own)
    expect(plain.credit).toBeNull()
    expect(exportDescription({ ...own, publish: { description: 'How to export.' } }, 'T', plain.duration, plain.chapters)).toBe(`${composeYoutubeDescription('How to export.', plain.chapters, plain.duration)}\n`)
    expect(composeYoutubeDescription('x', [], 10, null)).toBe(composeYoutubeDescription('x', [], 10))
    // The link check reads it too.
    expect(descriptionToCheck('How to export.', yt.chapters, yt.duration, yt.credit)).toContain('Music: Sweet Sun')
  })

  it('a long text makes room for it: the whole description stays within 5 000 characters', () => {
    const p = withBed('upbeat-sweet-sun')
    const yt = projectYoutubeChapters(p)
    const long = 'word '.repeat(2000)
    const text = composeYoutubeDescription(long, yt.chapters, yt.duration, yt.credit)
    expect([...text].length).toBeLessThanOrEqual(YOUTUBE_DESCRIPTION_MAX)
    expect(text.endsWith('\n\nMusic: Sweet Sun by Loyalty Freak Music (CC0)')).toBe(true)
  })
})

describe('the library edits (§2.6, §16)', () => {
  const base = studioProject({ segments: captions(['Hello']), duration: 60 })
  const music: MusicSettings = { path: 'music-2.ogg', volume: 0.6, ducking: 0.4, loop: false, fadeIn: 3, fadeOut: 4, library: { id: 'lofi-coexistenz' } }

  it('your own file keeps the music settings and leaves the bed behind (no credit, no bed graph)', async () => {
    const { withOwnMusic, withLibraryBed, libraryBedOf } = await import('../src/shared/audio/soundFxEdit')
    const p = { ...base, audio: { ...base.audio, music } }
    const own = withOwnMusic(p, 'music-3.mp3')
    expect(own.audio.music).toEqual({ path: 'music-3.mp3', volume: 0.6, ducking: 0.4, loop: false, fadeIn: 3, fadeOut: 4 })
    expect(libraryBedOf(own)).toBeNull()
    expect(musicCredit(own)).toBeNull()
    // A bed over no music takes today's defaults; an unknown id changes nothing.
    expect(withLibraryBed(base, 'upbeat-sweet-sun', 'music-1.ogg').audio.music).toEqual({ volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2, path: 'music-1.ogg', library: { id: 'upbeat-sweet-sun' } })
    expect(withLibraryBed(base, 'nope', 'music-1.ogg')).toBe(base)
  })

  it('a rule set to a catalogue effect or None, the volume clamped; nothing set leaves no field', async () => {
    const { withSoundRule, withSfxVolume } = await import('../src/shared/audio/soundFxEdit')
    const a = withSoundRule(base, 'titles', 'sfx:bell')
    expect(a.soundFx).toEqual({ titles: 'sfx:bell' })
    expect(withSoundRule(a, 'titles', 'sfx:bell')).toBe(a)
    expect(withSoundRule(a, 'zoomIn', 'sfx:nope' as never).soundFx).toEqual({ titles: 'sfx:bell' })
    expect('soundFx' in withSoundRule(a, 'titles', null)).toBe(false)
    expect(withSfxVolume(base, 3).soundFx).toEqual({ volume: 1 })
    expect(withSfxVolume(base, -1).soundFx).toEqual({ volume: 0 })
  })

  it('lengths and sizes as the list shows and says them', async () => {
    const { bedLength, megabytes } = await import('../src/shared/audio/soundFxEdit')
    const { soundBed } = await import('../src/shared/audio/soundLibrary')
    expect(bedLength(soundBed('upbeat-sweet-sun')!)).toEqual({ text: '1:43', spoken: '1 minute 43 seconds' })
    expect(bedLength(soundBed('corporate-one-cool-minute')!)).toEqual({ text: '1:06', spoken: '1 minute 6 seconds' })
    expect(megabytes(1025969)).toEqual({ text: '1.0 MB', spoken: '1.0 megabytes' })
  })
})
