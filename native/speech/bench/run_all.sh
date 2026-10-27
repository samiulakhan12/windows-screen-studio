#!/bin/sh
# Final benchmark: every model at 4 threads on the 105.7 s LibriSpeech clip, VAD on (and a few off).
S=$(cd "$(dirname "$0")/.." && pwd)
B=$S/ssw-whisper/target/x86_64-unknown-linux-gnu/release/ssw-whisper; M=$S/dl/models; A=$S/dl/speech/clip.wav; R=$S/results/final
mkdir -p $R
for m in tiny.en tiny base-q5_1 base small large-v3-turbo-q5_0; do
  python3 -I $S/scripts/bench.py "$m t4 vad" $R/$m.vad.jsonl -- $B transcribe --model $M/ggml-$m.bin --audio $A --threads 4 --vad-model $M/ggml-silero-v6.2.0.bin
  python3 -I $S/scripts/eval_words.py $S/dl/speech/truth.json $R/$m.vad.jsonl
done
for m in base small; do
  python3 -I $S/scripts/bench.py "$m t4 novad" $R/$m.novad.jsonl -- $B transcribe --model $M/ggml-$m.bin --audio $A --threads 4
  python3 -I $S/scripts/eval_words.py $S/dl/speech/truth.json $R/$m.novad.jsonl
done
