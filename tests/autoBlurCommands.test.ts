import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS, LANGUAGE_COMMANDS, listedCommands, PALETTE_COMMANDS, WAITING_COMMANDS, WAITING_P1, WAITING_P5 } from '../src/shared/editor/commands'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'

/*
 * The cover commands and the one AI chokepoint (docs/design/auto-blur.md §2.15, §7.5, §12.3; §17.1
 * tests 30 and 31).
 */

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(rel))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel.split(path.sep).join('/'))
  }
  return out
}

const FIVE = ['addCover', 'findPrivate', 'peekCovers', 'coverStartHere', 'coverEndHere']

describe('auto-blur contracts: commands', () => {
  it('30. Commands: the five are in COMMAND_LIST, left out of the palette and the shortcuts editor by WAITING_COMMANDS (WAITING_P1 and WAITING_P5 on lines of their own), have no default key, and each has its runner case in Editor.tsx', async () => {
    const ids = COMMANDS.map((c) => c.id)
    for (const id of FIVE) expect(ids as string[], id).toContain(id)
    // Parts P1 and P5 emptied their lines: P1's four commands work and are listed (test 74), and P5's findPrivate (test 180).
    const P1 = ['addCover', 'coverEndHere', 'coverStartHere', 'peekCovers']
    expect([...WAITING_P1]).toEqual([])
    expect([...WAITING_P5]).toEqual([])
    expect(PALETTE_COMMANDS.map((c) => c.id as string)).toContain('findPrivate')
    expect([...WAITING_COMMANDS].sort()).toEqual([...WAITING_P1, ...WAITING_P5].sort())
    for (const id of FIVE) {
      const waits = (WAITING_COMMANDS as readonly string[]).includes(id)
      expect(PALETTE_COMMANDS.map((c) => c.id as string).includes(id), id).toBe(!waits)
      expect(listedCommands(true).map((c) => c.id as string).includes(id), id).toBe(!waits)
      expect(listedCommands(false).map((c) => c.id as string).includes(id), id).toBe(!waits)
      expect(DEFAULT_KEYMAP[id as keyof typeof DEFAULT_KEYMAP], id).toEqual([])
    }
    for (const id of P1) expect(PALETTE_COMMANDS.map((c) => c.id as string), id).toContain(id)
    // Every other command is listed as before.
    expect(listedCommands(true).length).toBe(COMMANDS.length - WAITING_COMMANDS.length)
    expect(PALETTE_COMMANDS.length).toBe(COMMANDS.filter((c) => !c.hidden && !LANGUAGE_COMMANDS.includes(c.id)).length - WAITING_COMMANDS.length)
    // Each part edits one line of commands.ts: the arrays sit on lines of their own, a blank line between them.
    const source = read('src/shared/editor/commands.ts')
    expect(source).toMatch(/\nexport const WAITING_P1: readonly CommandId\[\] = \[[^\n]*\]\n\nexport const WAITING_P5: readonly CommandId\[\] = \[[^\n]*\]\n/)
    // The runner: findPrivate opens the Find dialog; the four cover commands come from coverCommands, which has each.
    const editor = read('src/renderer/src/views/Editor.tsx')
    expect(editor).toContain("findPrivate: () => setDialog('findPrivate')")
    expect(editor).toMatch(/\.\.\.coverCommands\(\{/)
    expect(editor).toContain("dialog === 'findPrivate' && <FindDialog")
    // Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
    const COVER_COMMANDS = '../src/renderer/src/privacy/coverCommands'
    const { coverCommands } = (await import(/* @vite-ignore */ COVER_COMMANDS)) as { coverCommands(d: unknown): Record<string, () => void> }
    // The runner's four cover commands (part P1's, run from the palette in test 74).
    const run = coverCommands({})
    expect(Object.keys(run).sort()).toEqual(P1)
  })

  it('31. One AI chokepoint: no file under src/renderer but aiTextFor.ts contains window.api.aiText(; each of the 9 call sites calls aiTextFor', () => {
    const callers = filesUnder('src/renderer').filter((f) => read(f).includes('window.api.aiText('))
    expect(callers).toEqual(['src/renderer/src/ai/aiTextFor.ts'])
    const sites: [string, number][] = [
      ['src/renderer/src/editor/greatRun.ts', 1],
      ['src/renderer/src/editor/panels/CleanupSection.tsx', 1],
      ['src/renderer/src/editor/panels/LanguagesSection.tsx', 1],
      ['src/renderer/src/editor/panels/CaptionsPanel.tsx', 1],
      ['src/renderer/src/editor/chaptersRun.ts', 2],
      ['src/renderer/src/clips/ShortClipsPanel.tsx', 1],
      ['src/renderer/src/publish/publishRun.ts', 1],
      ['src/renderer/src/guide/guideRun.ts', 1]
    ]
    let total = 0
    for (const [file, n] of sites) {
      const count = read(file).split('aiTextFor(').length - 1
      expect(count, file).toBe(n)
      total += count
    }
    expect(total).toBe(9)
    // Nothing else asks for AI text another way (a window.api alias).
    for (const f of filesUnder('src/renderer')) if (f !== 'src/renderer/src/ai/aiTextFor.ts') expect(read(f), f).not.toMatch(/\bapi\.aiText\b/)
  })
})
