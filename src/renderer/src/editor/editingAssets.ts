/**
 * What a frame of editing polish needs loaded before it is drawn where the preview must match
 * (docs/design/editing-polish.md §9.5, §7.6, §17.0): the grades' LUT files, parsed and checked.
 * The export's prepare(), renderThumbnail and the contrast probe await it, so frame 0 is already
 * graded with them. The fonts of badges, bubbles and the progress bar's names are loaded with the
 * captions' fonts (fontLoader's catalogIdsOf adds editingFontIds). A project without a LUT (every
 * project from before) does no work here.
 */
import type { Project } from "../../../shared/types";
import { prepareLuts } from "../render/lutCache";

/** Whether `project` has anything to load before its first frame. */
export const needsEditingAssets = (project: Project): boolean =>
  !!(project.grade?.screen?.lut || project.grade?.camera?.lut);

export async function prepareEditingAssets(project: Project): Promise<void> {
  if (!needsEditingAssets(project)) return;
  await prepareLuts(project);
}
