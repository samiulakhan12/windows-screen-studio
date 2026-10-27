# Speech detector model

`ggml-silero-v6.2.0.bin` is Silero VAD v6.2.0 (a voice activity detector) converted to the ggml
format by the whisper.cpp project. It ships in the installer (extraResources:
`resources/speech/`) and is read only by the speech helper `ssw-speech` (`native/speech`), which
runs it on one thread to tell speech from keyboard noise, clicks and fans for Remove silences,
Smart speed, music ducking and the camera director (docs/design/offline-captions.md §3.5).
Nothing is downloaded at run time for it.

- Source: https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin
  (repository ggml-org/whisper-vad at commit 9ffd54a1e1ee413ddf265af9913beaf518d1639b, 2025-11-17)
- Size: 885,098 bytes
- SHA-256: 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
- Licence: MIT, "Copyright (c) 2020-present Silero Team" (Silero VAD); the ggml conversion
  repository is MIT as well. The notice is in resources/THIRD_PARTY_NOTICES.txt.

`src/shared/speech/catalog.ts` `VAD_MODEL` pins the same size and hash; `tests/speechContracts.test.ts`
checks this file against it, and the main process checks the hash before the first use in a
session.
