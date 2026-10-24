/** Messages between the person segmenter (personSegmenter.ts) and its worker (segmentation.worker.ts). */

export type ToWorker =
  /** Load the model; answered with `ready` or `failed`. */
  | { type: 'init' }
  /** Find the person in an RGBA picture; answered with `mask` (same id) or `failed`. */
  | { type: 'segment'; id: number; width: number; height: number; pixels: ArrayBuffer }

export type FromWorker =
  | { type: 'ready' }
  /** RGBA pixels of the same size as the picture: white, alpha = person. */
  | { type: 'mask'; id: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: 'failed'; id?: number; reason: string }
