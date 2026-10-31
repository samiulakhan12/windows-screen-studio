import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const HAS_TOOLS = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0

/** The `run: |` script of the step called `name` in .github/workflows/release.yml. */
function stepScript(name: string): string {
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n')
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |')
  expect(at).toBeGreaterThan(-1)
  expect(run).toBeGreaterThan(at)
  const indent = (l: string): number => l.length - l.trimStart().length
  const by = indent(lines[run + 1])
  const body: string[] = []
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && indent(l) < by) break
    body.push(l.slice(by))
  }
  return body.join('\n')
}

// Stands in for gh: `release view` finds a release when FAKE_RELEASE is set; `api` answers
// FAKE_REFS (through the --jq filter) or fails when FAKE_DOWN is set.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "release view" ]; then [ -n "$FAKE_RELEASE" ]; exit; fi
if [ "$1" = "api" ]; then
  [ -n "$FAKE_DOWN" ] && { echo "HTTP 502" >&2; exit 1; }
  while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && filter=$2; shift; done
  printf '%s' "$FAKE_REFS" | jq -r "$filter"
  exit
fi
exit 99
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Runs the check job's Version step for package.json version 0.7.2, as GitHub runs it (bash -e). */
function checkVersion(fake: { release?: boolean; refs?: { ref: string }[]; down?: boolean }): { status: number | null; out: string; output: string; gh: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-release-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.7.2' }))
  fs.writeFileSync(path.join(dir, 'step.sh'), stepScript('Version'))
  fs.writeFileSync(path.join(dir, 'output'), '')
  fs.writeFileSync(path.join(dir, 'gh.log'), '')
  const r = spawnSync('bash', ['-e', 'step.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_OUTPUT: path.join(dir, 'output'),
      FAKE_LOG: path.join(dir, 'gh.log'),
      FAKE_RELEASE: fake.release ? '1' : '',
      FAKE_REFS: JSON.stringify(fake.refs ?? []),
      FAKE_DOWN: fake.down ? '1' : ''
    }
  })
  const read = (f: string): string => fs.readFileSync(path.join(dir, f), 'utf8')
  return { status: r.status, out: r.stdout, output: read('output'), gh: read('gh.log').split('\n').filter(Boolean) }
}

describe.skipIf(!HAS_TOOLS)('the Release workflow check (docs/design/auto-update.md §4)', () => {
  it('lets a new version through', () => {
    const r = checkVersion({})
    expect(r.status).toBe(0)
    expect(r.output).toBe('version=0.7.2\n')
    expect(r.gh).toContain('api repos/owner/repo/git/matching-refs/tags/v0.7.2 --jq map(select(.ref == "refs/tags/v0.7.2")) | length')
  })

  it('stops when the version has a release, draft or published', () => {
    const r = checkVersion({ release: true })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::A release v0\.7\.2 already exists/)
    expect(r.output).toBe('')
  })

  it('stops when the version has a tag whose release was deleted (a new draft would take the old commit)', () => {
    const r = checkVersion({ refs: [{ ref: 'refs/tags/v0.7.2' }] })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::A tag v0\.7\.2 already exists/)
    expect(r.output).toBe('')
    // Only that exact tag counts.
    expect(checkVersion({ refs: [{ ref: 'refs/tags/v0.7.20' }] }).status).toBe(0)
  })

  it('stops when GitHub cannot say whether the tag exists', () => {
    const r = checkVersion({ down: true })
    expect(r.status).not.toBe(0)
    expect(r.output).toBe('')
  })
})
