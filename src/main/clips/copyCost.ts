/**
 * What copies of a project cost on disk (docs/design/smart-tools.md §8.5 step 6): whether their
 * media can be linked, the bytes of a full copy and the free space. Part P3 writes this file; the
 * contracts register its channel (projects:copyCost) and the stub refuses.
 */
import type { CopyCost } from '../../shared/api/projects'

export async function copyCost(sourceId: unknown): Promise<CopyCost> {
  void sourceId
  throw new Error('Short clips are not part of this build.')
}
