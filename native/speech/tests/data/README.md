# Recorded helper output for the word refinement tests

`spike-base-q5_1-clip.jsonl` (32,250 bytes) is what the spike's helper printed for the 105.7 s
reference clip with `ggml-base-q5_1.bin`, 4 threads and the speech detector on: the `speech`
line, five chunks of **unrefined** `segment` lines (raw DTW word times, before the pull-in, the
onset snap and the monotonic pass), and a `result` line whose `words` are the same words refined
once over the whole run. A cargo test feeds the segment lines chunk by chunk to `words.rs` and
checks that the per-chunk refinement (§5.2 of docs/design/offline-captions.md) stays close to
the whole-run words: at least 95 % of the words identical (±1 ms) and none more than 150 ms
apart. Measured with a Python model of the rules: 222 of 226 words identical, the other 4 starts
up to 120 ms apart (the first chunk's median is not the whole run's); ends identical. Against
the forced-aligned truth the per-chunk words do as well as the whole-run ones (start median
45 ms both, 92.4 % within 200 ms against 91.9 %).

Source audio: LibriSpeech test-clean, speaker 7729, chapter 102255, utterances 0008, 0011, 0012,
0016, 0018, 0021, 0026, 0027, 0031, 0033, 0034, 0035, 0038, 0040, 0042, 0046, joined with 0.4 s
pauses (`bench/fetch_speech.py`). LibriSpeech is by Vassil Panayotov, Guoguo Chen, Daniel Povey
and Sanjeev Khudanpur, licensed CC BY 4.0 (https://www.openslr.org/12); the recognised text above
derives from it. The audio itself is not in the repository.
