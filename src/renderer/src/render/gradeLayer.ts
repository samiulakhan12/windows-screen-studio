/**
 * Grading the screen and the camera (docs/design/editing-polish.md §9.1, §9.3): one WebGL2 shader,
 * or the same maths on the CPU, applied to each source picture before it is drawn.
 *
 * Contracts step: the exported signatures of part P4 (§17.4). drawFrame and the webcam layer call
 * gradeScreen and gradeCamera for every picture; without a grade (every project from before) they
 * return their input and make no context. The stubs always return their input. Part P4 writes the
 * bodies.
 */
import type { CubeLut } from "../../../shared/render/cubeLut";
import type { ColorGrade } from "../../../shared/types";
import type { FrameImage } from "./compositor";

export function gradeBackend(): "gl" | "cpu" {
  return "cpu";
}

/** Why the CPU path is used, or null. */
export function gradeBackendReason(): string | null {
  return null;
}

/** The screen's picture graded (its input without a grade, or with `compare`). */
export function gradeScreen(
  target: CanvasRenderingContext2D,
  frame: FrameImage,
  grade: ColorGrade | undefined,
  lut: CubeLut | null,
  compare?: boolean,
): FrameImage {
  void target;
  void grade;
  void lut;
  void compare;
  return frame;
}

/** The camera's picture graded (its input without a grade, or with `compare`). */
export function gradeCamera(
  target: CanvasRenderingContext2D,
  frame: FrameImage,
  grade: ColorGrade | undefined,
  lut: CubeLut | null,
  compare?: boolean,
): FrameImage {
  void target;
  void grade;
  void lut;
  void compare;
  return frame;
}

/** Drops the grade's copies kept for `target`. */
export function releaseGrade(target: CanvasRenderingContext2D): void {
  void target;
}

/** Tests and e2e only: the backend to use (null: choose). */
export function forceGradeBackend(b: "gl" | "cpu" | null): void {
  void b;
}
