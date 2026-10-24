/**
 * Files the user picks into a project folder (a logo, background music) are stored under a new
 * name each time: <base>.<ext> (older projects), then <base>-<n>.<ext> for the n-th pick. A
 * pick never overwrites the file in use, so undo can go back to it, and the folder keeps the
 * latest few picks and the one the saved project uses.
 */

/** A pick's files: `re` matches <base>(-<n>)?.<ext> with the number as its first group. */
export interface PickedFiles {
  base: string
  re: RegExp
  /** How many of the latest picks a folder keeps (besides the ones in use). */
  keep: number
}

/** The pick number of file `name` (0 for <base>.<ext>), or -1 when it is not one. */
export function pickNumber(files: PickedFiles, name: string): number {
  const m = files.re.exec(name)
  return m ? (m[1] ? Number(m[1].slice(1)) : 0) : -1
}

/** The file name of a new pick with extension `ext`, after the files already in the folder. */
export function nextPickFile(files: PickedFiles, existing: readonly string[], ext: string): string {
  const last = existing.reduce((n, name) => Math.max(n, pickNumber(files, name)), 0)
  return `${files.base}-${last + 1}.${ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg')}`
}

/** Picks in a folder that can go after a new pick: all but the newest few and the files in `keep`. */
export function stalePickFiles(files: PickedFiles, existing: readonly string[], keep: ReadonlySet<string>): string[] {
  const picks = existing.filter((name) => pickNumber(files, name) >= 0).sort((a, b) => pickNumber(files, b) - pickNumber(files, a))
  return picks.slice(files.keep).filter((name) => !keep.has(name))
}
