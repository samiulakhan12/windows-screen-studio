/**
 * A selected speech bubble's options (Colour, Tail) (docs/design/editing-polish.md §2.3).
 *
 * Contracts step: the exported signature of part P3 (§17.3), mounted by the Text and Shapes tabs;
 * the stub shows nothing. Part P3 writes the body.
 */
import type { Project } from "../../../../shared/types";
import type { Selection } from "../selection";

export function BubbleSection(props: {
  project: Project;
  selection: Selection;
}): JSX.Element | null {
  void props;
  return null;
}
