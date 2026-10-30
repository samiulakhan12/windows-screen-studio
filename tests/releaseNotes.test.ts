import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script without types
import { notesFor } from '../scripts/release-notes.mjs'

const MD = `# Release notes

## 0.7.1

- **Updates**: Flown updates itself.

### Known issues

- One.

## 0.7.0

- **Import a video**.
`

describe('release notes for a GitHub release (docs/RELEASING.md)', () => {
  it('takes one version section, without its heading, up to the next version', () => {
    expect(notesFor(MD, '0.7.1')).toBe('- **Updates**: Flown updates itself.\n\n### Known issues\n\n- One.')
    expect(notesFor(MD, '0.7.0')).toBe('- **Import a video**.')
  })

  it('has nothing for a missing or empty section', () => {
    expect(notesFor(MD, '0.7.2')).toBeNull()
    expect(notesFor('## 0.7.3\n\n## 0.7.2\n- x', '0.7.3')).toBeNull()
    expect(notesFor(MD, '0.7')).toBeNull()
  })

  it('the script refuses to make a release without notes', () => {
    const script = path.resolve(__dirname, '..', 'scripts', 'release-notes.mjs')
    const missing = spawnSync(process.execPath, [script, '99.0.0'], { encoding: 'utf8' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/no "## 99.0.0" section/)
    expect(spawnSync(process.execPath, [script, 'latest'], { encoding: 'utf8' }).status).toBe(2)
    const shipped = spawnSync(process.execPath, [script, '0.7.0'], { encoding: 'utf8' })
    expect(shipped.status).toBe(0)
    expect(shipped.stdout).toMatch(/Import a video/)
  })
})
