import { describe, expect, it } from 'vitest'
import { redactLine } from '../src/shared/diagnostics/redact'
import { cleanTitle, lengthText, maskWebhook, parseWebhookUrl, postFailure, shareMessage, WEBHOOK_HELP, webhookBody } from '../src/shared/share/webhooks'

const SLACK = 'https://hooks.slack.com/services/T0001/B0002/abcdEFGHijklMNOPqrstUVWX'
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/AbC-dEf_123'
const TEAMS = 'https://contoso.webhook.office.com/webhookb2/aaaa-bbbb@cccc/IncomingWebhook/dddd/eeee'

describe('parseWebhookUrl', () => {
  it('accepts the three services on their own hosts', () => {
    expect(parseWebhookUrl(` ${SLACK} `)).toEqual({ service: 'slack', url: SLACK })
    expect(parseWebhookUrl(DISCORD).service).toBe('discord')
    expect(parseWebhookUrl('https://discordapp.com/api/webhooks/1/x').service).toBe('discord')
    expect(parseWebhookUrl('https://canary.discord.com/api/v10/webhooks/1/x').service).toBe('discord')
    expect(parseWebhookUrl(TEAMS).service).toBe('teams')
  })

  it.each([
    ['http://hooks.slack.com/services/T/B/x', 'Only https://'],
    ['https://hooks.slack.com.evil.io/services/T/B/x', WEBHOOK_HELP],
    ['https://evil.io/hooks.slack.com/services/T/B/x', WEBHOOK_HELP],
    ['https://hooks.slack.com:8443/services/T/B/x', WEBHOOK_HELP],
    ['https://user:pw@hooks.slack.com/services/T/B/x', WEBHOOK_HELP],
    ['https://hooks.slack.com/services/T/B/x#frag', WEBHOOK_HELP],
    ['https://hooks.slack.com/workflows/T/B/x', WEBHOOK_HELP],
    ['https://discord.com/api/webhooks/notanumber/x', WEBHOOK_HELP],
    ['https://evil.discord.com.example/api/webhooks/1/x', WEBHOOK_HELP],
    ['https://a.b.webhook.office.com/webhookb2/x', WEBHOOK_HELP],
    ['https://webhook.office.com/webhookb2/x', WEBHOOK_HELP],
    ['https://prod-01.westus.logic.azure.com/workflows/x', WEBHOOK_HELP],
    ['https://hooks.slack.com/services/T/B/x y', WEBHOOK_HELP],
    [`https://hooks.slack.com/services/${'a'.repeat(1100)}`, WEBHOOK_HELP],
    ['', WEBHOOK_HELP],
    ['not a url', WEBHOOK_HELP]
  ])('refuses %s', (url, message) => {
    expect(() => parseWebhookUrl(url)).toThrow(message)
  })

  it('refuses what is not text', () => {
    expect(() => parseWebhookUrl(42)).toThrow(WEBHOOK_HELP)
  })
})

describe('the message', () => {
  it('masks a webhook to its host and last characters', () => {
    expect(maskWebhook(SLACK)).toBe('hooks.slack.com/…/UVWX')
    expect(maskWebhook(SLACK)).not.toContain('abcd')
  })

  it('writes lengths and titles on one line', () => {
    expect(lengthText(151)).toBe('2:31')
    expect(lengthText(3723)).toBe('1:02:03')
    expect(lengthText(Number.NaN)).toBe('0:00')
    expect(cleanTitle(' a\n\tb\u0000c ')).toBe('a b c')
    expect(cleanTitle('')).toBe('Untitled')
    const long = cleanTitle('x'.repeat(300))
    expect([...long]).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
  })

  it('says the title, the length and where it went, never a path', () => {
    expect(shareMessage({ title: 'Demo', seconds: 151 })).toEqual(['New video: Demo (2:31)'])
    expect(shareMessage({ title: 'Demo', seconds: 151 }, { text: 'OneDrive › Flown' })).toEqual(['New video: Demo (2:31)', 'Saved to OneDrive › Flown'])
    expect(shareMessage({ title: 'Demo', seconds: 5 }, { text: 'OneDrive › Flown', link: 'https://1drv.ms/v/s!abc' })).toEqual(['New video: Demo (0:05)', 'Link: https://1drv.ms/v/s!abc'])
    // A link that is not https is not used.
    expect(shareMessage({ title: 'Demo', seconds: 5 }, { text: 'Dropbox › Flown', link: 'javascript:alert(1)' })[1]).toBe('Saved to Dropbox › Flown')
  })

  it('cannot ping a channel or everyone', () => {
    const lines = ['New video: <!channel> @everyone *bold* (0:05)']
    expect(JSON.parse(webhookBody('slack', lines)).text).toBe('New video: &lt;!channel&gt; @everyone *bold* (0:05)')
    const discord = JSON.parse(webhookBody('discord', lines))
    expect(discord.allowed_mentions).toEqual({ parse: [] })
    expect(discord.content).toContain('@​everyone')
    expect(discord.content).toContain('\\*bold\\*')
    expect(JSON.parse(webhookBody('teams', lines)).text).toContain('&lt;!channel&gt;')
  })

  it('keeps links clickable and refuses a body that is too long', () => {
    expect(JSON.parse(webhookBody('discord', ['Link: https://x.io/a_b'])).content).toBe('Link: https://x.io/a_b')
    expect(() => webhookBody('slack', ['x'.repeat(5000)])).toThrow('too long')
  })

  it('says what went wrong without the URL', () => {
    expect(postFailure('slack', 404)).toBe('This webhook no longer exists. Paste a new one in Settings › Share.')
    expect(postFailure('discord', 403)).toContain('Discord refused')
    expect(postFailure('teams', 429)).toBe('Microsoft Teams is busy. Try again in a minute.')
    expect(postFailure('slack', 502)).toBe('Slack had a problem (502). Try again later.')
    expect(postFailure('slack', 400)).toBe('Slack did not accept the message (400).')
    expect(postFailure('slack', 'timeout')).toBe('Slack did not answer in 15 s.')
    expect(postFailure('slack', 'redirect')).toContain('somewhere else')
  })
})

describe('the log', () => {
  it('redacts the secret part of webhook URLs', () => {
    expect(redactLine(`posting to ${SLACK} failed`)).toBe('posting to https://hooks.slack.com/services/<secret> failed')
    expect(redactLine(DISCORD)).toBe('https://discord.com/api/webhooks/<secret>')
    expect(redactLine(TEAMS)).toBe('https://contoso.webhook.office.com/webhookb2/<secret>')
  })
})
