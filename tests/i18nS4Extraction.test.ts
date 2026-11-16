/**
 * Step S4's extraction (docs/design/output-and-languages.md §10.3, §10.4): the files the parts left
 * say their words through messages that give back today's English, follow the UI language when it
 * changes (nothing is made when a module loads), and the helpers S4 added keep English as it was.
 *
 * - The Publish dialog's words (publishWords.ts) equal the English tables of pack.ts, which main
 *   keeps as data.
 * - Find chapters' and Short clips' word tables are getters: under en-XA they change, in English they
 *   are today's text.
 * - The webhook refusals and post failures (main's import graph) are errors messages with today's
 *   English, and change under en-XA.
 * - A renderer check that reads main's "Cancelled." also accepts errors.cancelled in the UI language.
 * - <Rich> adds no element in English and isolates the user's text in <bdi> outside English, as <T>.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import { setCatalogue, t } from '../src/shared/i18n/t'
import { BLOCKER_TEXT, PUBLISH_KINDS, PUBLISH_LABELS, PUBLISH_LENGTHS, PUBLISH_TONES } from '../src/shared/publish/pack'
import { blockerText, lengthOptions, publishLabel, toneOptions } from '../src/renderer/src/publish/publishWords'
import { FIND_WORDS } from '../src/renderer/src/editor/chaptersRun'
import { CLIPS_WORDS } from '../src/renderer/src/clips/clipsRun'
import { parseWebhookUrl, postFailure, webhookHelp } from '../src/shared/share/webhooks'
import { isCancel } from '../src/renderer/src/editor/cancelled'
import { Rich } from '../src/renderer/src/editor/panels/Rich'

const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, object> } }
const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as {
  pseudoCatalogue(locale: string, english: Record<string, string>, meta: Record<string, object>): { dir: 'ltr' | 'rtl'; messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
}

const english = (): void => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
function enXA(): void {
  const { messages, meta } = files.readEnglish()
  const c = pseudo.pseudoCatalogue('en-XA', messages, meta)
  setCatalogue({ language: 'es', messages: c.messages, latn: c.latn, user: c.user, formatLocale: 'en-US', dir: c.dir })
}
afterEach(english)

/** The strings and elements a <Rich> renders, flattened (it holds no state, so it can be called). */
function parts(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(parts)
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: unknown }>
    if (typeof el.type === 'symbol') return parts(el.props.children)
    return [el]
  }
  return node === undefined || node === null || node === false ? [] : [node]
}

describe('S4: the Publish dialog words equal pack.ts in English', () => {
  it('labels, tones, lengths and why nothing can be written', () => {
    for (const kind of PUBLISH_KINDS) expect(publishLabel(kind)).toBe(PUBLISH_LABELS[kind])
    expect(toneOptions()).toEqual(PUBLISH_TONES)
    expect(lengthOptions()).toEqual(PUBLISH_LENGTHS)
    for (const [blocker, text] of Object.entries(BLOCKER_TEXT)) expect(blockerText(blocker as keyof typeof BLOCKER_TEXT)).toBe(text)
  })

  it('follow the UI language', () => {
    enXA()
    expect(publishLabel('youtube')).not.toBe(PUBLISH_LABELS.youtube)
    expect(toneOptions()[0].label).not.toBe(PUBLISH_TONES[0].label)
  })
})

describe('S4: word tables are read when shown, never when a module loads', () => {
  it('FIND_WORDS and CLIPS_WORDS give English, and change with the catalogue', () => {
    expect(FIND_WORDS.tooShort).toBe('Too short for chapters: YouTube needs at least 30 seconds.')
    expect(FIND_WORDS.asking('Claude')).toBe('Asking Claude…')
    expect(CLIPS_WORDS.noRoom(1, '85 MB', '40 MB')).toBe('This copy needs 85 MB; 40 MB is free.')
    expect(CLIPS_WORDS.noRoom(3, '85 MB', '40 MB')).toBe('These 3 copies need 85 MB; 40 MB is free.')
    expect(CLIPS_WORDS.making(2, 3)).toBe('Making copy 2 of 3…')
    enXA()
    expect(FIND_WORDS.tooShort).not.toBe('Too short for chapters: YouTube needs at least 30 seconds.')
    expect(CLIPS_WORDS.intro).not.toMatch(/^The best moments/)
  })
})

describe('S4: webhook refusals and post failures (main’s import graph) are errors messages', () => {
  it('give today’s English', () => {
    expect(() => parseWebhookUrl('http://hooks.slack.com/services/T/B/x')).toThrow('Only https:// webhooks are accepted.')
    expect(() => parseWebhookUrl('nope')).toThrow(webhookHelp())
    expect(webhookHelp()).toMatch(/^Paste an incoming webhook from Slack, Discord or Microsoft Teams/)
    expect(postFailure('slack', 'timeout')).toBe('Slack did not answer in 15 s.')
    expect(postFailure('discord', 'network')).toBe('Could not reach Discord. Check the connection.')
    expect(postFailure('teams', 404)).toBe('This webhook no longer exists. Paste a new one in Settings › Share.')
    expect(postFailure('slack', 503)).toBe('Slack had a problem (503). Try again later.')
    expect(postFailure('slack', 400)).toBe('Slack did not accept the message (400).')
  })

  it('change with the catalogue and keep the service name', () => {
    enXA()
    const failure = postFailure('slack', 'network')
    expect(failure).not.toBe('Could not reach Slack. Check the connection.')
    expect(failure).toContain('Slack')
  })
})

describe('S4: cancelled jobs', () => {
  it('main’s English or errors.cancelled in the UI language both read as cancelled', () => {
    expect(isCancel('Cancelled.')).toBe(true)
    expect(isCancel('The model could not be read.')).toBe(false)
    enXA()
    expect(t('errors.cancelled')).not.toBe('Cancelled.')
    expect(isCancel(t('errors.cancelled'))).toBe(true)
    expect(isCancel('Cancelled.')).toBe(true)
  })
})

describe('S4: <Rich> and the user’s text', () => {
  it('adds no element in English: a value given as a node keeps its own place', () => {
    const out = parts(Rich({ k: 'smart.shortVersion.made', values: { copy: 'Demo (short)', name: 'Demo' } }))
    expect(out.every((p) => typeof p === 'string')).toBe(true)
    expect(out.join('')).toBe('Made “Demo (short)”. Your original “Demo” is unchanged. Review in the copy lists each cut, so you can bring any sentence back.')
  })

  it('isolates the user’s text in <bdi> outside English', () => {
    enXA()
    const out = parts(Rich({ k: 'smart.shortVersion.made', values: { copy: 'Demo (short)', name: 'Demo' } }))
    const bdi = out.filter((p): p is ReactElement<{ children: unknown }> => isValidElement(p) && (p as ReactElement).type === 'bdi')
    expect(bdi.map((b) => b.props.children)).toEqual(['Demo (short)', 'Demo'])
  })
})
