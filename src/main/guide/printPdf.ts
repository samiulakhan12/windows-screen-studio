/**
 * Printing a guide to PDF in a hidden, sandboxed window with scripts off (docs/design/smart-tools.md
 * §5.7). Part P1 writes this file; the contracts' stub refuses to print and sweeps nothing.
 */
export const PRINT_PARTITION = 'guide-print'
export const PRINT_DIR = 'tmp/guide-print'

export async function printGuidePdf(html: string, opts: { page: 'A4' | 'Letter'; steps: number; signal?: AbortSignal }): Promise<Buffer> {
  void html
  void opts
  throw new Error('Guides are not part of this build.')
}

/** Deletes the guide-*.html files a crash left in `dir`; the names deleted. */
export async function sweepGuidePrint(dir: string): Promise<string[]> {
  void dir
  return []
}
