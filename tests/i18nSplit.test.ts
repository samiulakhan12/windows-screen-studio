/**
 * The split of the extraction (docs/design/output-and-languages.md §10.5): each file goes to one part
 * by the design's rules, every stylesheet to X7 alone (never P6's scripts.css), and a file two rules
 * claim or no rule claims is listed for the lead instead of being guessed.
 */
import { describe, expect, it } from 'vitest'

type Split = { parts: Record<string, { files: string[]; namespaces: string[] }>; conflicts: { file: string; parts: string[] }[]; unclaimed: string[] }
const split = require('../scripts/i18n/lib/split.cjs') as {
  PARTS: Record<string, { files: string[]; namespaces: string[]; css?: boolean }>
  expand(glob: string): string[]
  splitParts(candidates: string[], parts?: object, never?: string[]): Split
  candidatesOf(root?: string): string[]
}

describe('splitting the extraction between X1-X7', () => {
  it('lists a file two rules claim and a file no rule claims, and gives stylesheets to the stylesheet part only', () => {
    const parts = {
      A: { title: 'a', namespaces: ['a'], files: ['src/a/**', 'src/shared/{x,y}.ts'] },
      B: { title: 'b', namespaces: ['b'], files: ['src/a/both.ts'] },
      C: { title: 'c', namespaces: [], css: true, files: ['src/**/*.css'] }
    }
    const r = split.splitParts(['src/a/one.tsx', 'src/a/both.ts', 'src/shared/y.ts', 'src/other.ts', 'src/a/look.css', 'src/i18n/scripts.css'], parts, ['src/i18n/scripts.css'])
    expect(r.parts.A.files).toEqual(['src/a/one.tsx', 'src/shared/y.ts'])
    expect(r.parts.C.files).toEqual(['src/a/look.css'])
    expect(r.conflicts).toEqual([{ file: 'src/a/both.ts', parts: ['A', 'B'] }])
    expect(r.unclaimed).toEqual(['src/other.ts'])
    expect(split.expand('a/{b,c}/{d,e}.ts')).toEqual(['a/b/d.ts', 'a/b/e.ts', 'a/c/d.ts', 'a/c/e.ts'])
  })

  it('follows the design’s table on this tree, with each part’s namespaces', () => {
    const r = split.splitParts(split.candidatesOf())
    const owner = (file: string) => Object.entries(r.parts).find(([, p]) => p.files.includes(file))?.[0]
    expect(owner('src/renderer/src/views/Editor.tsx')).toBe('X1')
    expect(owner('src/shared/editor/commands.ts')).toBe('X1')
    expect(owner('src/renderer/src/editor/LayoutTrack.tsx')).toBe('X2')
    expect(owner('src/shared/audio/voiceCopy.ts')).toBe('X2')
    expect(owner('src/renderer/src/editor/panels/CaptionsPanel.tsx')).toBe('X3')
    expect(owner('src/shared/speech/speechCopy.ts')).toBe('X3')
    expect(owner('src/renderer/src/views/NotesWindow.tsx')).toBe('X4')
    expect(owner('src/shared/review/copy.ts')).toBe('X4')
    expect(owner('src/renderer/src/views/Home.tsx')).toBe('X5')
    expect(owner('src/renderer/src/editor/ExportDialog.tsx')).toBe('X5')
    expect(owner('src/renderer/src/styles.css')).toBe('X7')
    expect(owner('src/renderer/src/i18n/scripts.css')).toBeUndefined()
    // The other account's files and the parts' own files are never split.
    for (const p of Object.values(r.parts)) for (const f of p.files) expect(f).not.toMatch(/recorder\/|views\/Toolbar\.|main\/recording\/|recordingIpc|reviewOverlay|proArgs/)
    expect(r.parts.X5.namespaces).toEqual(['home', 'export', 'settings', 'errors', 'main'])
    expect(r.parts.X1.namespaces).toEqual(['editor', 'timeline', 'commands', 'keys'])
  })
})
