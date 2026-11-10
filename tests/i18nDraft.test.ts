/**
 * The drafting script (docs/design/output-and-languages.md §15.3), tested with a fake service only: it
 * sends one namespace's English with descriptions, placeholders, plural categories, length limits, the
 * glossary and the screens' screenshots and nothing else; it writes drafts with their source hash and
 * service, keeps a failing draft with the checks' note, never replaces a reviewed or approved string,
 * and refuses to run for a service translations/README.md does not name or over plain http.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree } from './i18nFixtures'

type Entry = { text: string; state: string; sourceHash: string; draftedWith?: string; note?: string; reviewedBy?: string; approvedBy?: string }
type Request = { system: string; user: string; keys: string[]; images: { screen: string; file: string }[] }
const draft = require('../scripts/i18n/lib/draft.cjs') as {
  draftRequest(o: { lang: string; ns: string; english: Record<string, string>; meta: Record<string, object>; glossary: object[]; screens?: Record<string, string> }): Request
  parseDraftReply(text: string, keys: string[]): Record<string, string>
  applyDrafts(o: { lang: string; english: Record<string, string>; meta: Record<string, object>; existing: Record<string, Entry>; drafts: Record<string, string>; serviceName: string }): { entries: Record<string, Entry>; written: string[]; kept: string[]; noted: string[] }
  serviceNamed(readme: string, lang: string, service: string): boolean
}
const files = require('../scripts/i18n/lib/files.cjs') as { sourceHash(s: string): string }

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const english = { 'export.name': 'Export {name}', 'export.count': '{count, plural, one {{n} file} other {{n} files}}', 'export.size': '{width}×{height} · 30 fps', 'codecs.other': 'Never sent' }
const meta = {
  'export.name': { description: 'The export button.', screen: 'export-settings', maxLength: 20 },
  'export.count': { description: 'How many files.' },
  'export.size': { description: 'The size line.', digits: 'latn', dnt: ['fps'] },
  'codecs.other': { description: 'Another namespace.' }
}

describe('drafts, with a fake service', () => {
  it('asks for one namespace only, with what the drafter needs', () => {
    const req = draft.draftRequest({ lang: 'bn', ns: 'export', english, meta, glossary: [{ term: 'export', 'part of speech': 'verb', note: 'n', dnt: false, bn: 'এক্সপোর্ট' }], screens: { 'export-settings': '/shots/export-settings.png', other: '/shots/other.png' } })
    expect(req.keys).toEqual(['export.name', 'export.count', 'export.size'])
    expect(req.user).not.toContain('Never sent')
    const body = JSON.parse(req.user) as { messages: Record<string, unknown>[]; glossary: Record<string, unknown>[] }
    expect(body.messages[0]).toEqual({ key: 'export.name', english: 'Export {name}', description: 'The export button.', placeholders: ['name'], maxLength: 20, screen: 'export-settings' })
    expect(body.messages[2]).toMatchObject({ keepUnchanged: ['fps'], latinDigits: true })
    expect(body.glossary).toEqual([{ term: 'export', partOfSpeech: 'verb', note: 'n', keepUnchanged: false, bn: 'এক্সপোর্ট' }])
    expect(req.system).toContain('Plural categories you may use: other;')
    expect(draft.draftRequest({ lang: 'es', ns: 'export', english, meta, glossary: [] }).system).toContain('Plural categories you may use: many, one, other;')
    expect(req.images).toEqual([{ screen: 'export-settings', file: '/shots/export-settings.png' }])
  })

  it('reads the answer, keeping only the asked keys', () => {
    expect(draft.parseDraftReply('```json\n{"export.name": "{name} এক্সপোর্ট", "codecs.other": "x", "export.count": 3}\n```', ['export.name', 'export.count'])).toEqual({ 'export.name': '{name} এক্সপোর্ট' })
    expect(() => draft.parseDraftReply('Sure! Here you go.', ['export.name'])).toThrow(/JSON object/)
  })

  it('writes drafts with their hash and service, notes a failing one, and keeps reviewed and approved strings', () => {
    const current = (k: keyof typeof english, more: Partial<Entry>): Entry => ({ text: 'x', state: 'draft', sourceHash: files.sourceHash(english[k]), ...more })
    const existing: Record<string, Entry> = {
      'export.size': current('export.size', { text: '{width}×{height} · 30 fps', state: 'approved', reviewedBy: 'a', approvedBy: 'b' }),
      'export.count': { text: 'old', state: 'approved', sourceHash: 'stale0000000' }
    }
    const r = draft.applyDrafts({ lang: 'bn', english, meta, existing, drafts: { 'export.name': 'এক্সপোর্ট', 'export.count': '{count, plural, other {{n}টি ফাইল}}', 'export.size': 'নতুন' }, serviceName: 'Fake' })
    expect(r.written).toEqual(['export.name', 'export.count'])
    expect(r.kept).toEqual(['export.size'])
    expect(r.noted).toEqual(['export.name'])
    expect(r.entries['export.name']).toEqual({ text: 'এক্সপোর্ট', state: 'draft', sourceHash: files.sourceHash('Export {name}'), draftedWith: 'Fake', note: 'lacks the placeholder(s) {name}' })
    expect(r.entries['export.count']).toEqual({ text: '{count, plural, other {{n}টি ফাইল}}', state: 'draft', sourceHash: files.sourceHash(english['export.count']), draftedWith: 'Fake' })
    expect(r.entries['export.size']).toBe(existing['export.size'])
  })

  it('needs the service named on the language’s row of translations/README.md', () => {
    const readme = '| Language | Reviewers | Drafting service |\n|---|---|---|\n| Bangla (`bn`) | two | Example Service |\n| Hindi (`hi`) | two | not chosen yet |\n'
    expect([draft.serviceNamed(readme, 'bn', 'Example Service'), draft.serviceNamed(readme, 'hi', 'Example Service'), draft.serviceNamed(readme, 'bn', '')]).toEqual([true, false, false])
  })

  it('runs end to end against a fake service on this PC, and refuses an unnamed service or plain http', async () => {
    const root = makeTree({
      ...englishTree({ export: { name: 'Export {name}', done: 'Done' } }),
      ...toolsTree(),
      'translations/README.md': '| Language | Reviewers | Drafting service |\n|---|---|---|\n| Bangla (`bn`) | two | Fake Service |\n',
      'translations/glossary.csv': 'term,part of speech,note,do-not-translate,bn,es,hi\r\nexport,verb,,,এক্সপোর্ট,,\r\n'
    })
    trees.push(root)
    const seen: { auth?: string; body: { model: string; messages: { role: string; content: unknown }[] } }[] = []
    const server = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(data) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 'export.name': '{name} এক্সপোর্ট করুন', 'export.done': 'হয়েছে' }) } }] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const cli = (...args: string[]) =>
      promisify(execFile)(process.execPath, [path.join(REPO, 'scripts/i18n/draft.mjs'), '--root', root, '--lang', 'bn', '--ns', 'export', '--model', 'fake-1', ...args], { env: { ...process.env, FLOWN_DRAFT_API_KEY: 'test-key' } }).then(
        (r) => ({ code: 0, ...r }),
        (e: { code: number; stdout: string; stderr: string }) => e
      )
    try {
      const unnamed = await cli('--service-name', 'Other Service', '--service-url', `http://127.0.0.1:${port}/v1/chat/completions`)
      expect(unnamed.code).toBe(1)
      expect(unnamed.stderr).toContain('does not name "Other Service" for bn')
      const plain = await cli('--service-name', 'Fake Service', '--service-url', 'http://example.invalid/v1/chat/completions')
      expect(plain.code).toBe(1)
      expect(plain.stderr).toContain('must be https')
      expect(seen).toEqual([])

      const ok = await cli('--service-name', 'Fake Service', '--service-url', `http://127.0.0.1:${port}/v1/chat/completions`)
      expect(ok.code).toBe(0)
      expect(seen.length).toBe(1)
      expect(seen[0].auth).toBe('Bearer test-key')
      expect(seen[0].body.model).toBe('fake-1')
      expect(JSON.stringify(seen[0].body)).toContain('Export {name}')
      const written = JSON.parse(fs.readFileSync(path.join(root, 'translations/bn/export.json'), 'utf8')) as Record<string, Entry>
      expect(written.name).toEqual({ text: '{name} এক্সপোর্ট করুন', state: 'draft', sourceHash: files.sourceHash('Export {name}'), draftedWith: 'Fake Service' })
      expect(written.done.state).toBe('draft')
    } finally {
      server.close()
    }
  })
})
