# Speech fixtures

Real speech for the speech helper's tests and the offline captions end-to-end test
(docs/design/offline-captions.md §10). 16 kHz mono FLAC.

| File | Length | Bytes | SHA-256 | What | Licence |
|---|---|---|---|---|---|
| `jfk-16k.flac` | 11.00 s | 203,328 | 80a62044368118b450aeff6fbb32ad70d0c3d69bc70445ff8adf9b68aa23b99f | John F. Kennedy's inaugural address excerpt: "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country." | Public domain (a work of the US government) |
| `ls-1272-128104-0000.flac` | 5.86 s | 118,059 | 4d57e6cae976e27bbee56afcbe58d2586d6133bc77ef6f8f1c82239a40d386e4 | LibriSpeech dev-clean 1272-128104-0000: "MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES AND WE ARE GLAD TO WELCOME HIS GOSPEL" | CC BY 4.0 |
| `bn-fleurs-blog-18s.flac` | 18.84 s | 332,056 | 7001f6eeaba70244112d26502f2826861dd1c49b4ae907b4357df1b71b07acd8 | Bangla read speech, FLEURS `bn_in` test, sentence 1990; its transcript is `bn-fleurs-blog-18s.txt` (459 bytes, UTF-8, SHA-256 9a911ffd774c2da43e71e84e2c19b3d4b8b0476a794e2a4bd49303925209763f) | CC BY 4.0 (the sentence text: FLoRes, CC BY-SA 4.0) |

Sources (converted with ffmpeg to 16 kHz mono FLAC):

- `jfk.wav` from https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7/jfk.wav
  (1,940,478 bytes, SHA-256 aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8).
- `librispeech_asr_demo_validation_0.wav` from the same dataset and commit (187,404 bytes,
  SHA-256 799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46); its samples are
  identical to row 0 of hf-internal-testing/librispeech_asr_dummy, which gives the transcript.

- `bn-fleurs-blog-18s.flac`: Google's FLEURS (Hugging Face dataset google/fleurs, config `bn_in`,
  split `test`, revision 70bb2e84b976b7e960aa89f1c648e09c59f894dd), archive
  `data/bn_in/audio/test.tar.gz` (SHA-256
  6c1cc66b258b711d49e5bcd8e5508c18484c8cbcbe76d323ad46947756029b0f), member
  `test/13256991909939569674.wav`, sentence id 1990, converted from 32-bit float WAV to 16-bit 16 kHz
  mono (nothing else changed; its samples decode to exactly that 16-bit WAV), then to FLAC.
  `bn-fleurs-blog-18s.txt` is its `raw_transcription` from `data/bn_in/test.tsv`.

Attribution for the LibriSpeech clip: V. Panayotov, G. Chen, D. Povey and S. Khudanpur,
"LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015; corpus at
https://www.openslr.org/12, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

Attribution for the Bangla clip: A. Conneau, M. Ma, S. Khanuja, Y. Zhang, V. Axelrod, S. Dalmia,
J. Riesa, C. Rivera and A. Bapna, "FLEURS: Few-shot Learning Evaluation of Universal
Representations of Speech", arXiv:2205.12446, 2022 (Google); https://huggingface.co/datasets/google/fleurs,
licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The sentence comes from FLoRes
(Meta AI), whose card states CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
These files are used by tests only and are not shipped in the app.

The Bangla clip is the benchmark of the Bangla model (docs/design/offline-captions.md §14):
`npm run bench:bangla -- --model <ggml-bengaliai-whisper-medium-q5_0.bin>` transcribes it with the
helper and the app's arguments and prints WER and CER against `bn-fleurs-blog-18s.txt`; the end
to end test uses it as Bangla sound.

The Whisper model the tests transcribe with is not committed (43.5 MB): `npm run
fetch:test-speech` downloads the catalog's `whisper-tiny` (ggml-tiny-q8_0.bin) once from its pinned
address into `.cache/test-speech/` (or `SSW_TEST_SPEECH_CACHE`), checks its SHA-256 and reuses it.

Who uses them: `tests/native/speech.spec.ts` (`npm run test:native`, decoded with ffmpeg-static),
`scripts/smoke-speech-wine.sh` and the offline captions end-to-end test. The native tests join JFK
and the LibriSpeech clip where a language detection must hear 10 s of speech: JFK alone holds
about 7.9 s of it.
