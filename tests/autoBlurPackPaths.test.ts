import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import { PRIVATE_TEXT_FIELDS, privateView } from '../src/shared/privacy/spoken'
import { shareMessage } from '../src/shared/share/webhooks'
import type { Bleep, Project } from '../src/shared/types'
import { base, words } from './autoBlurFixtures'

/*
 * Every path of the publishing pack masks secrets said aloud (docs/design/auto-blur.md §9 rows 20
 * and 21, §7.5, question 19 (a)): Copy, the description sidecar and the share post. The pack's
 * *Use as the recording's name* makes its title the project's name, which the description sidecar
 * (without a saved description, and for each part) and the share post carry, and which a browser
 * frame draws: the private view masks it as it masks the pack's saved description.
 */

vi.stubGlobal('window', { api: {} })
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const BUNDLE = '../src/renderer/src/editor/exportBundleRun'
const { sidecarText } = (await import(/* @vite-ignore */ BUNDLE)) as { sidecarText: (kind: string, req: unknown, language?: string) => string | null }

/** A project whose captions say a card number, bleeped by Find, named with it from the pack's title. */
function packProject(over: Partial<Project> = {}): Project {
  const said = words('k1', 1, 'My card is 4917 6123 4567 8904')
  const w = said.words!
  const bleep: Bleep = { id: 'p1', start: w[3].start - 0.05, end: w[6].end + 0.05, word: privateBleepWord('card', 'g1'), sound: 'tone', auto: true }
  return {
    ...base('pack', 30),
    name: 'Paying with 4917 6123 4567 8904',
    transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [said] },
    bleeps: [bleep],
    ...over
  }
}

const FORM = /4917|6123|4567|8904/

describe('auto-blur: the publishing pack’s paths mask secrets said aloud', () => {
  it('the private view masks the project’s name, which the pack’s title becomes; the stored name stays as written', () => {
    expect(PRIVATE_TEXT_FIELDS).toContain('name')
    const p = packProject()
    const v = privateView(p)
    expect(v.name).toBe('Paying with •••• •••• •••• ••••')
    expect(p.name).toBe('Paying with 4917 6123 4567 8904')
    // Without private bleeps, or a name without a form, the project itself.
    const plain = { ...p, bleeps: undefined }
    expect(privateView(plain)).toBe(plain)
    const named = packProject({ name: 'Paying by card' })
    expect(privateView(named)).toBe(named)
  })

  it('the description sidecar without a saved description, and each part’s, mask the name in it', () => {
    const p = packProject()
    const whole = sidecarText('description', { project: p, kinds: ['description'], title: p.name, thumbnail: async () => new Uint8Array() })!
    expect(whole).not.toMatch(FORM)
    expect(whole).toContain('Paying with •••• •••• •••• ••••')
    const part = sidecarText('description', { project: p, kinds: ['description'], title: `${p.name} - part 1`, part: { index: 0, count: 2, of: p.name }, thumbnail: async () => new Uint8Array() })!
    expect(part).not.toMatch(FORM)
    // With the pack's saved description: that text, masked.
    const saved = packProject({ publish: { description: 'Pay with 4917 6123 4567 8904 today.' } as Project['publish'] })
    const described = sidecarText('description', { project: saved, kinds: ['description'], title: saved.name, thumbnail: async () => new Uint8Array() })!
    expect(described).not.toMatch(FORM)
  })

  it('the share post is made from the masked name', () => {
    const lines = shareMessage({ title: privateView(packProject()).name, seconds: 30 })
    expect(lines.join('\n')).not.toMatch(FORM)
    // The export dialog gives the share the masked name, after the export and from its done view.
    const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')
    const shares = [...dialog.matchAll(/share\.begin\([^\n]*|<ShareDone [^\n]*/g)].map((m) => m[0])
    expect(shares).toHaveLength(2)
    for (const s of shares) {
      expect(s).not.toMatch(/title: project\.name/)
      expect(s).toMatch(/title: shownName\b/)
    }
  })
})
