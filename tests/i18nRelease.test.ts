/**
 * Test 68 (docs/design/output-and-languages.md §16.4, §19.5, §23.1): predist's step 5 fails when
 * config.json says "fail" and a string has no key (and only reports it before then); verify-dist fails
 * when the built catalogues grow by more than 1 MB over the previous release. Also the checks
 * workflow: read-only, actions pinned by commit, no install scripts, no secrets.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree, writeTree } from './i18nFixtures'

const release = require('../scripts/i18n/lib/release.cjs') as {
  BUILT_GROWTH_LIMIT: number
  stringsCheckArgs(config: { scan: string }, args: string[]): string[]
  stringsStep(root: string, args: string[], run?: typeof spawnSync): string | null
  builtGrowth(root: string): { bytes: number; growth: number; problem: string | null }
}

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))
const quiet: typeof spawnSync = ((cmd: string, args: string[], opts: object) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' })) as typeof spawnSync
const CHECK = [path.join(REPO, 'scripts/i18n/check.mjs'), '--report']

describe('test 68: the release checks', () => {
  it('runs check.mjs with --report until config.json says "fail", and without it from then on', () => {
    expect(release.stringsCheckArgs({ scan: 'report' }, ['check.mjs', '--report'])).toEqual(['check.mjs', '--report'])
    expect(release.stringsCheckArgs({ scan: 'fail' }, ['check.mjs', '--report'])).toEqual(['check.mjs'])
    const predist = fs.readFileSync(path.join(REPO, 'scripts/predist.mjs'), 'utf8')
    expect(predist).toContain("stringsStep(root, [path.join(root, 'scripts', 'i18n', 'check.mjs'), '--report'])")
    expect(predist).toMatch(/if \(problem\) fail\(problem\)/)
    expect(predist).toMatch(/\ncheckStrings\(\)\n/)
  })

  it('stops predist when the scan fails and a string has no key, and only reports it before S4', () => {
    const root = makeTree({
      ...englishTree({ codecs: { 'row.codec': 'Codec' } }),
      ...toolsTree({ scan: 'report' }),
      'src/shared/i18n/built/shipped.json': [],
      'src/renderer/src/a.tsx': "import { t } from '../../shared/i18n/t'\nexport const A = () => <p title={t('codecs.row.codec')}>Plain text</p>\n"
    })
    trees.push(root)
    expect(release.stringsStep(root, CHECK, quiet)).toBeNull()
    writeTree(root, toolsTree({ scan: 'fail' }))
    expect(release.stringsStep(root, CHECK, quiet)).toBe('the string and catalogue checks failed (scripts/i18n/check.mjs, see above).')
    // A part's own file fails even before S4.
    writeTree(root, toolsTree({ scan: 'report', failFor: ['src/renderer/src/a.tsx'] }))
    expect(release.stringsStep(root, CHECK, quiet)).not.toBeNull()
    writeTree(root, { 'src/renderer/src/a.tsx': "import { t } from '../../shared/i18n/t'\nexport const A = () => <p>{t('codecs.row.codec')}</p>\n", ...toolsTree({ scan: 'fail' }) })
    expect(release.stringsStep(root, CHECK, quiet)).toBeNull()
  })

  it('fails verify-dist when the built catalogues grow by more than 1 MB over the previous release', () => {
    const root = makeTree({ 'scripts/i18n/built-baseline.json': { release: '0.8.0', bytes: 500_000 }, 'src/shared/i18n/built/shipped.json': [] })
    trees.push(root)
    const built = path.join(root, 'src/shared/i18n/built')
    fs.writeFileSync(path.join(built, 'bn.json'), 'x'.repeat(1_500_000 - 3))
    expect(release.builtGrowth(root)).toMatchObject({ bytes: 1_500_000, growth: 1_000_000, problem: null })
    fs.writeFileSync(path.join(built, 'bn.main.json'), 'y')
    const grown = release.builtGrowth(root)
    expect(grown.problem).toBe('the built catalogues grew by 1000001 B since 0.8.0 (500000 B -> 1500001 B), more than the 1000000 B allowed')
    writeTree(root, { 'scripts/i18n/built-baseline.json': { bytes: 'many' } })
    expect(() => release.builtGrowth(root)).toThrow(/needs the previous release/)
    const verify = fs.readFileSync(path.join(REPO, 'scripts/verify-dist.mjs'), 'utf8')
    expect(verify).toContain('const built = builtGrowth(root)')
    expect(verify).toMatch(/if \(built\.problem\) fail\(/)
    // This repository's baseline reads, and its built catalogues are within it.
    expect(release.builtGrowth(REPO).problem).toBeNull()
  })

  it('runs the checks in CI with read-only rights, pinned actions and no install scripts', () => {
    const yml = fs.readFileSync(path.join(REPO, '.github/workflows/checks.yml'), 'utf8')
    expect(yml).toMatch(/^on:\n {2}push:\n {2}pull_request:\n/m)
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m)
    const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBe(2)
    for (const u of uses) expect(u).toMatch(/^actions\/(checkout|setup-node)@[0-9a-f]{40}$/)
    expect(yml).toContain('persist-credentials: false')
    expect(yml).toContain('run: npm ci --ignore-scripts')
    expect(yml).not.toMatch(/secrets\.|write-all|: write/)
    for (const step of ['npm run typecheck', 'npm run i18n:check', 'npx vitest run tests/i18n*.test.ts']) expect(yml).toContain(step)
  })
})
