import { describe, expect, it, vi } from 'vitest'

/*
 * What the import dialog tells a screen reader, without a DOM: React's hooks are swapped for
 * stand-ins (as in polishDialog.test.ts) and the dialog's element tree is read.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => undefined
}))
// Tab and Esc are not what is tested, and the hook reads the real document.
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const DIALOG = '../src/renderer/src/import/ImportDialog'
const { ImportDialog } = (await import(/* @vite-ignore */ DIALOG)) as { ImportDialog: (props: unknown) => El | null }

/** Every element in the tree (child components are not called). */
function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as El
  out.push(el)
  walk(el.props.children, out)
  return out
}

/** The dialog showing `view`. */
function render(view: unknown): El[] {
  const importer = { view, busy: true, pick: () => undefined, drop: () => undefined, cancel: () => undefined, close: () => undefined, open: () => undefined }
  const box = ImportDialog({ importer }) as El
  return walk((box.type as (props: unknown) => unknown)(box.props), [])
}

describe('Import dialog: what a screen reader reads', () => {
  it('describes the dialog with the notes when the import ends with some', () => {
    const notes = ['The sound in this video could not be read, so it was imported without sound.']
    const out = render({ kind: 'done', fileName: 'demo.mp4', projectId: 'rec-1', notes })
    const dialog = out.find((e) => e.props.role === 'dialog')
    const list = out.find((e) => e.type === 'ul')
    expect(list?.props.id).toBeTruthy()
    expect(dialog?.props['aria-describedby']).toBe(list?.props.id)
  })

  it('has no description while running or after a refusal (those announce themselves)', () => {
    for (const view of [
      { kind: 'running', fileName: 'demo.mp4', stage: 'converting', progress: 0.5, startedAt: 0 },
      { kind: 'failed', fileName: 'demo.mp4', error: 'This file is empty.' }
    ]) {
      expect(render(view).find((e) => e.props.role === 'dialog')?.props['aria-describedby']).toBeUndefined()
    }
  })
})
