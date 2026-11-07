/**
 * Writing a saved guide (docs/design/smart-tools.md §5.8): the name checked, the payload checked
 * again in main, every path built here. Part P1 writes this file; the contracts' stub refuses.
 */
import type { GuideSavePayload } from '../../shared/api/guide'

const NOT_IN_BUILD = 'Guides are not part of this build.'

export function guideNameOk(name: string): boolean {
  void name
  return false
}

export function checkGuidePayload(raw: unknown): GuideSavePayload {
  void raw
  throw new Error(NOT_IN_BUILD)
}

export async function writeGuideFiles(target: string, payload: GuideSavePayload, pdf?: Buffer): Promise<{ path: string; bytes: number }> {
  void target
  void payload
  void pdf
  throw new Error(NOT_IN_BUILD)
}
