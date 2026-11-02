# Sound event model

`yamnet.tflite` is YAMNet (MobileNet-v1 trained on AudioSet, 521 sound classes, 0.975 s windows of
16 kHz mono sound, float32), as MediaPipe publishes it for its audio classifier, with its label list
packed inside. It is used by the unwanted-sound finder (docs/design/sound-finder.md) and ships
inside the app (bundled by Vite into `out/renderer/assets/`), so nothing is downloaded at run time.

- Source: https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite
- Size: 4,126,810 bytes
- SHA-256: 4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf
  (`SOUND_MODEL` in `src/shared/audio/sounds.ts`; a unit test checks the file against it)
- Licence: Apache License 2.0 (TensorFlow Models, https://github.com/tensorflow/models/tree/master/research/audioset/yamnet,
  and MediaPipe's model card)

It runs with `@mediapipe/tasks-audio` (Apache 2.0), whose WebAssembly runtime is bundled the same
way (src/renderer/src/editor/sounds/sounds.worker.ts), on the CPU inside a Web Worker. Unlike the
camera's person segmenter it needs no WebGL. `scripts/verify-dist.mjs` checks that the worker, the
WebAssembly runtime and this model are in the packaged app.
