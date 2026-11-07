/**
 * Shapes tab: Add magnifier, and a selected magnifier's panel (docs/design/editing-polish.md §2.2).
 *
 * Contracts step: the exported signature of part P2 (§17.2), mounted by ShapesPanel; the stub
 * shows nothing. Part P2 writes the body.
 */
import type { Project } from "../../../../shared/types";
import type { Selection } from "../selection";

export function MagnifierSection(props: {
  project: Project;
  selection: Selection;
}): JSX.Element {
  void props;
  return <></>;
}
