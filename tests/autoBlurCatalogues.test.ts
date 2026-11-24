import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRIVATE_KINDS } from '../src/shared/privacy/kinds'
import { t } from '../src/shared/i18n/t'

/*
 * The auto-blur messages (docs/design/auto-blur.md §2, §12.1; §17.1 test 38): every key in its
 * catalogue with a meta entry, no English message of 37f9355 changed, every new file scanned.
 */

const ROOT = path.join(__dirname, '..')
const EN = path.join(ROOT, 'src/shared/i18n/messages/en')
const json = (file: string): Record<string, string> => JSON.parse(fs.readFileSync(file, 'utf8'))
const catalogue = (ns: string): Record<string, string> => json(path.join(EN, `${ns}.json`))
const meta = (ns: string): Record<string, unknown> => json(path.join(EN, `${ns}.meta.json`))

/** The keys §12.1 adds to existing namespaces; the privacy namespace is new as a whole. */
const NEW_KEYS: Record<string, string[]> = {
  review: [
    'kind.private.chip',
    'kind.private.name',
    'kind.private.all',
    'kind.private.count',
    'polish.step.privacy',
    'polish.hint.privacy',
    'polish.hint.privacyChecked',
    'polish.result.privacy',
    'polish.result.privacyCheck',
    'polish.result.privacyListened',
    'polish.result.privacyUnfinished',
    'polish.skip.noReader',
    'versions.area.covers'
  ],
  commands: ['title.addCover', 'title.findPrivate', 'title.peekCovers', 'title.coverStartHere', 'title.coverEndHere'],
  style: ['groupEdit.count.cover', 'groupEdit.class.cover.one', 'groupEdit.class.cover.other'],
  main: ['jobs.privacyDone'],
  errors: ['timeline.hidden']
}

/** Every `privacy.…` key the tables of §2 name (each table row starts with its key). */
function designKeys(): string[] {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/design/auto-blur.md'), 'utf8')
  const two = doc.slice(doc.indexOf('\n## 2. '), doc.indexOf('\n## 3. '))
  return [...two.matchAll(/^\| `privacy\.([^`]+)`/gm)].map((m) => m[1])
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(path.join(ROOT, dir))) return []
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `${dir}/${f.split(path.sep).join('/')}`)
}

describe('auto-blur contracts: catalogues', () => {
  it('38. Catalogues: every key of §2 and §12.1 is in its catalogue with a meta entry; no message holds #; the kind sentences select on every kind id; no English message of 37f9355 changed; every new file is in failFor', () => {
    const privacy = catalogue('privacy')
    const privacyMeta = meta('privacy')
    const keys = designKeys()
    expect(keys.length).toBeGreaterThan(200)
    for (const k of keys) expect(privacy[k], `privacy.${k}`).toBeTypeOf('string')
    // Each kind's title; each kind the Find dialog offers (all but 'text', Cover this text everywhere's) its label.
    for (const k of PRIVATE_KINDS) for (const f of k === 'text' ? ['title'] : ['label', 'title']) expect(privacy[`kind.${k}.${f}`], `privacy.kind.${k}.${f}`).toBeTypeOf('string')
    for (const k of Object.keys(privacy)) expect(privacyMeta[k], `meta of privacy.${k}`).toBeTruthy()
    for (const [ns, list] of Object.entries(NEW_KEYS)) {
      const cat = catalogue(ns)
      const m = meta(ns)
      for (const k of list) {
        expect(cat[k], `${ns}.${k}`).toBeTypeOf('string')
        expect(m[k], `meta of ${ns}.${k}`).toBeTruthy()
      }
    }
    // No ICU '#': every plural names its number ({n}), formatted by fmt.
    for (const [k, v] of Object.entries(privacy)) expect(v.includes('#'), `privacy.${k}`).toBe(false)
    for (const [ns, list] of Object.entries(NEW_KEYS)) for (const k of list) expect(catalogue(ns)[k].includes('#'), `${ns}.${k}`).toBe(false)
    // Sentences that select on the kind have a branch for every kind id.
    const selecting = Object.entries(privacy).filter(([, v]) => /\{kind, select,/.test(v))
    expect(selecting.length).toBeGreaterThan(0)
    for (const [k, v] of selecting) for (const kind of PRIVATE_KINDS) expect(v, `privacy.${k} has ${kind}`).toMatch(new RegExp(`[{ ]${kind} \\{`))
    for (const kind of PRIVATE_KINDS) expect(t('privacy.review.keepKind' as never, { kind, count: 2, n: '2' } as never)).not.toContain('{')
    // English at 37f9355: each namespace's messages, without the new keys, are those of that commit.
    const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/autoblur-english-37f9355.json'), 'utf8')) as { digests: Record<string, { count: number; sha256: string }> }
    // Question 17, answered (a) by the owner on 23 November 2026: these three messages, and only they,
    // read as §0 words them; with their old texts put back, the namespace is 37f9355's.
    const Q17: Record<string, Record<string, [now: string, then: string]>> = {
      text: {
        'shape.blur.title': ['Blur (always fully applied; blurred text can sometimes be read back)', 'Blur private content (always fully applied)'],
        'shape.pixelate.title': ['Pixelate (always fully applied; pixelated text can sometimes be read back)', 'Pixelate private content (always fully applied)'],
        'calloutSection.privacyNote': ['Blur and pixelate are fully on for their whole time. Text under them can sometimes be read back; a cover hides it completely.', 'Blur and pixelate are fully on for their whole time, so nothing they hide shows.']
      }
    }
    for (const [ns, d] of Object.entries(old.digests)) {
      const added = new Set(NEW_KEYS[ns] ?? [])
      const changed = Q17[ns] ?? {}
      for (const [k, [now]] of Object.entries(changed)) expect(catalogue(ns)[k], `${ns}.${k}`).toBe(now)
      const entries = Object.entries(catalogue(ns))
        .filter(([k]) => !added.has(k))
        .map(([k, v]): [string, string] => [k, changed[k] ? changed[k][1] : v])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      expect(entries.length, ns).toBe(d.count)
      expect(crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'), ns).toBe(d.sha256)
    }
    expect(Object.keys(old.digests)).not.toContain('privacy')
    // Every new file is scanned as failing from its first commit.
    const failFor = new Set((JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/config.json'), 'utf8')) as { failFor: string[] }).failFor)
    const created = [
      ...filesUnder('src/shared/privacy'),
      ...filesUnder('src/main/privacy'),
      ...filesUnder('src/renderer/src/privacy'),
      'src/shared/api/privacy.ts',
      'src/preload/privacy.ts',
      'src/main/projectFile.ts',
      'src/renderer/src/render/coverLayer.ts',
      'src/renderer/src/render/coverGrade.ts',
      'src/renderer/src/ai/aiTextFor.ts',
      'src/shared/editor/coverGroup.ts',
      'src/shared/review/privacyReview.ts'
    ]
    for (const f of created) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
      expect(failFor.has(f), `${f} in failFor`).toBe(true)
    }
  })
})
