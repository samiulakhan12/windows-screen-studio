/**
 * Clip tab, no cut selected: the Cuts section (docs/design/editing-polish.md §2.1): Every cut,
 * Smooth all cuts, Give them the same style.
 *
 * Contracts step: the exported signature of part P1 (§17.1), mounted by ClipPanel; the stub shows
 * nothing. Part P1 writes the body.
 */
import type { Project } from "../../../../shared/types";

export function CutsSection(props: { project: Project }): JSX.Element | null {
  void props;
  return null;
}
