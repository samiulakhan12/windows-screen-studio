/**
 * The downloaded beds (docs/design/editing-polish.md §10.3, §14 rule 3): pinned downloads from the
 * chosen source only, SHA-256 checked, size capped, and copies into a project.
 *
 * Contracts step: the exported signatures of part P5 (§17.5), stubs: no URL is allowed, nothing is
 * listed or downloaded (SOUND_LIBRARY_SOURCE is null until the release exists). Part P5 writes the
 * bodies.
 */
import type { SoundLibraryState } from "../../shared/api/soundLibrary";

/** Whether a download may request `url` (the first request and every redirect). */
export function allowSoundUrl(url: URL, testBase?: string | null): boolean {
  void url;
  void testBase;
  return false;
}

export async function listLibrary(): Promise<SoundLibraryState[]> {
  return [];
}

export async function downloadBed(
  id: string,
  opts: { signal: AbortSignal; onProgress(p: number): void },
): Promise<SoundLibraryState> {
  void opts;
  throw new Error(
    `The music bed ${JSON.stringify(id).slice(0, 80)} cannot be downloaded yet.`,
  );
}

export async function removeDownloadedBeds(): Promise<void> {}

/** Copies bed `id` into the project as music-<n>.ogg (its hash checked again). */
export async function useBed(
  projectDir: string,
  id: string,
): Promise<{ file: string }> {
  void projectDir;
  throw new Error(
    `The music bed ${JSON.stringify(id).slice(0, 80)} is not available yet.`,
  );
}
