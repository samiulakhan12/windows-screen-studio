#!/usr/bin/env bash
# What Find's decoding costs (docs/design/auto-blur.md §5.11): a 20 s 1080p60 clip encoded as
# Flown's proxy is (libx264, constant frame rate, a key frame every 15 frames) from two
# evaluation frames scrolling at 600 px/s, then decoded by ffmpeg on one thread four ways:
# decode only, the look pass's 480x270 grey, the follow pass's half-size grey, and full-size
# RGB as a read takes it. Then one read the way §5.5 makes it: a seek to the key frame before
# the frame, decoding to it, as one ffmpeg run.
#
#   scripts/privacy/decode-speed.sh WORK_DIR > scripts/privacy/results/decode-speed.txt
set -euo pipefail
work=$1
set_dir=$(cd "$(dirname "$0")/../../tests/fixtures/privacy-eval" && pwd)
mkdir -p "$work"
clip=$work/scroll.mp4
ffmpeg -hide_banner -loglevel error -y -i "$set_dir/01-editor-0-dark-100.png" -i "$set_dir/07-logs-0-dark-100.png" \
  -filter_complex "[0][1]vstack=inputs=2,loop=loop=-1:size=1:start=0,fps=60,crop=1920:1080:0:'mod(t*600,1080)',format=yuv420p" \
  -t 20 -c:v libx264 -preset superfast -crf 17 -g 15 -threads 1 "$clip"
echo "clip: 1200 frames, $(stat -c %s "$clip") bytes"
for run in 1 2; do
  echo "== run $run: decode only"
  ffmpeg -hide_banner -benchmark -threads 1 -filter_threads 1 -i "$clip" -map 0:v:0 -f null - 2>&1 | grep bench
  echo "== run $run: look, 480x270 grey (area)"
  ffmpeg -hide_banner -benchmark -threads 1 -filter_threads 1 -i "$clip" -map 0:v:0 -vf "scale=480:270:flags=area,format=gray" -f rawvideo -y /dev/null 2>&1 | grep bench
  echo "== run $run: follow, 960x540 grey (area)"
  ffmpeg -hide_banner -benchmark -threads 1 -filter_threads 1 -i "$clip" -map 0:v:0 -vf "scale=960:540:flags=area,format=gray" -f rawvideo -y /dev/null 2>&1 | grep bench
  echo "== run $run: read, full-size RGB24"
  ffmpeg -hide_banner -benchmark -threads 1 -filter_threads 1 -i "$clip" -map 0:v:0 -vf "format=rgb24" -f rawvideo -y /dev/null 2>&1 | grep bench
done
echo "== one read: seek to the key frame at 14.85 s, decode to 14.98 s, one RGB24 frame (3 runs)"
for i in 1 2 3; do
  ffmpeg -hide_banner -benchmark -threads 1 -filter_threads 1 -ss 14.85 -i "$clip" -map 0:v:0 \
    -vf "select='gte(t,0.13)',format=rgb24" -frames:v 1 -f rawvideo -y /dev/null 2>&1 | grep bench | tr '\n' ' '
  echo
done
start=$(date +%s%N)
for i in $(seq 10); do
  ffmpeg -hide_banner -loglevel error -threads 1 -filter_threads 1 -ss 14.85 -i "$clip" -map 0:v:0 \
    -vf "select='gte(t,0.13)',format=rgb24" -frames:v 1 -f rawvideo -y /dev/null
done
echo "10 such reads one after another: $(( ($(date +%s%N) - start) / 1000000 )) ms wall, process start included"
ffmpeg -version | head -1
uptime
