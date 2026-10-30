import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parseLatestYml, topLevel, updateMetaProblems } = require('../scripts/lib/updateMeta.cjs')

const SHA = 'q83vEjRWeA=='
const LATEST = `version: 0.7.1
files:
  - url: Flown-Setup-0.7.1.exe
    sha512: ${SHA}
    size: 1234
path: Flown-Setup-0.7.1.exe
sha512: ${SHA}
releaseDate: '2026-10-30T10:00:00.000Z'
`
const APP_UPDATE = `owner: samiulakhan12
repo: windows-screen-studio
provider: github
releaseType: release
updaterCacheDirName: flown-updater
`
const publish = { provider: 'github', owner: 'samiulakhan12', repo: 'windows-screen-studio', releaseType: 'release' }
const good = { appUpdateText: APP_UPDATE, latestText: LATEST, publish, version: '0.7.1', installerName: 'Flown-Setup-0.7.1.exe', installerSha512: SHA, installerSize: 1234 }

describe('update metadata checks (verify-dist, docs/design/auto-update.md §4)', () => {
  it('reads the files electron-builder writes', () => {
    expect(topLevel(APP_UPDATE)).toMatchObject({ owner: 'samiulakhan12', provider: 'github' })
    expect(parseLatestYml(LATEST)).toEqual({ version: '0.7.1', path: 'Flown-Setup-0.7.1.exe', sha512: SHA, files: [{ url: 'Flown-Setup-0.7.1.exe', sha512: SHA, size: 1234 }] })
    expect(topLevel(LATEST).releaseDate).toBe('2026-10-30T10:00:00.000Z')
  })

  it('passes a build whose metadata is right', () => {
    expect(updateMetaProblems(good)).toEqual([])
  })

  it('catches a missing or wrong app-update.yml', () => {
    expect(updateMetaProblems({ ...good, appUpdateText: null })[0]).toMatch(/app-update.yml is missing/)
    expect(updateMetaProblems({ ...good, appUpdateText: APP_UPDATE.replace('samiulakhan12', 'someone-else') })[0]).toMatch(/points at someone-else\/windows-screen-studio/)
    expect(updateMetaProblems({ ...good, appUpdateText: APP_UPDATE.replace('github', 'generic') })[0]).toMatch(/provider is generic/)
    expect(updateMetaProblems({ ...good, appUpdateText: APP_UPDATE.replace(/updaterCacheDirName.*\n/, '') })[0]).toMatch(/updaterCacheDirName/)
  })

  it('catches latest.yml for another version, installer, checksum or size', () => {
    expect(updateMetaProblems({ ...good, latestText: null })[0]).toMatch(/latest.yml is missing/)
    expect(updateMetaProblems({ ...good, version: '0.7.2' })).toContain('latest.yml version is 0.7.1, expected 0.7.2')
    expect(updateMetaProblems({ ...good, installerName: 'Flown-Setup-0.7.2.exe' }).join('\n')).toMatch(/path is Flown-Setup-0.7.1.exe[\s\S]*files has no Flown-Setup-0.7.2.exe/)
    expect(updateMetaProblems({ ...good, installerSha512: 'other' })).toEqual(["latest.yml sha512 does not match the installer's", "latest.yml files[].sha512 does not match the installer's"])
    expect(updateMetaProblems({ ...good, installerSize: 99 })).toEqual(['latest.yml files[].size is 1234, the installer has 99 bytes'])
    // Without a blockmap electron-builder writes no size: nothing to compare.
    expect(updateMetaProblems({ ...good, latestText: LATEST.replace(/    size: 1234\n/, ''), installerSize: 99 })).toEqual([])
  })
})
