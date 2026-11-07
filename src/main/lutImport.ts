/**
 * Importing a .cube LUT into a project (docs/design/editing-polish.md §9.5, §14 rule 1): read with
 * its size checked first, parsed strictly (rejected before anything is copied), hashed, and copied
 * as lut-<n>.cube.
 *
 * Contracts step: the exported signature of part P4 (§17.4), a stub that refuses. Part P4 writes
 * the body.
 */
export async function importLut(
  projectDir: string,
  source: string,
): Promise<{ file: string; sha256: string; title: string; size: number }> {
  void projectDir;
  void source;
  throw new Error("Importing LUTs is not available yet.");
}
