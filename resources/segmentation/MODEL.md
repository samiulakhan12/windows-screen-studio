# Person segmentation model

`selfie_segmenter.tflite` is MediaPipe's Selfie Segmenter (square, 256x256 input, float16),
used for the camera's background blur. It ships inside the app (bundled by Vite into
`out/renderer/assets/`), so nothing is downloaded at run time.

- Source: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
- SHA-256: 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b
- Licence: Apache License 2.0 (MediaPipe models), see the model card at
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf

It runs with `@mediapipe/tasks-vision` (Apache 2.0), whose WebAssembly runtime is bundled the
same way (src/renderer/src/render/segmentation/segmentation.worker.ts).

The model runs on the CPU (deterministic: the same frame always gets the same mask, in the preview
and the export) inside a Web Worker. MediaPipe hands pictures to its graph as WebGL textures even
then, so the worker needs WebGL; without it the camera is drawn unblurred and the Camera panel says
why. `scripts/verify-dist.mjs` checks that the worker, the WebAssembly runtime and this model are in
the packaged app.
