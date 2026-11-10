/**
 * Fixture trees for the i18n tools' tests (docs/design/output-and-languages.md §16, §21.7): a small
 * repository with English namespaces, translations, the tools' settings and source files, written to
 * a temporary folder the test removes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Tree = Record<string, string | object>

/** The tools of this checkout, for fixture trees that run them. */
export const REPO = path.resolve(__dirname, '..')

/** Writes `tree` (path → text, or JSON for objects) under a new temporary folder and returns it. */
export function makeTree(tree: Tree): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flown-i18n-'))
  writeTree(root, tree)
  return root
}

export function writeTree(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

export const removeTree = (root: string): void => fs.rmSync(root, { recursive: true, force: true })

const MESSAGES = 'src/shared/i18n/messages/en'

/** English namespaces as files: messages and meta by namespace. */
export function englishTree(namespaces: Record<string, Record<string, string>>, meta: Record<string, Record<string, object>> = {}): Tree {
  const tree: Tree = {}
  for (const [ns, messages] of Object.entries(namespaces)) {
    tree[`${MESSAGES}/${ns}.json`] = messages
    const own: Record<string, object> = {}
    for (const key of Object.keys(messages)) own[key] = meta[ns]?.[key] ?? { description: `The ${key} text.` }
    tree[`${MESSAGES}/${ns}.meta.json`] = own
  }
  return tree
}

/** The tools' settings of a fixture tree. */
export function toolsTree(opts: { scan?: 'report' | 'fail'; failFor?: string[]; allow?: object; pending?: object } = {}): Tree {
  return {
    'scripts/i18n/config.json': { scan: opts.scan ?? 'report', failFor: opts.failFor ?? [] },
    'scripts/i18n/allow.json': opts.allow ?? { files: [], texts: [], sites: [] },
    'scripts/i18n/pending.json': opts.pending ?? { files: [] }
  }
}
