#!/usr/bin/env bash
# The detector and recogniser plans the reader keeps for a whole Find (docs/design/auto-blur.md
# §5.5, §5.11): how long tract takes to build each fixed bucket's plan, how long one run takes,
# and the process's peak memory with every bucket's plan kept. One thread (tract's default
# executor), pinned to one CPU. Inputs are zeros: the time and memory do not depend on the pixels.
#
#   scripts/privacy/bench-buckets.sh PARITY MODELS OUT_DIR > scripts/privacy/results/tract-buckets.txt
#
# PARITY: tract-skeleton's parity tool built with --profile release-mixed.
# MODELS: the folder holding the PP-OCRv6_<size>_<det|rec>_onnx repositories (reader-models.json).
set -euo pipefail
parity=$1 models=$2 out=$3
mkdir -p "$out"
python3 -I - "$out" <<'EOF'
import sys
out = sys.argv[1]
for (h, w) in [(352, 640), (544, 960), (1088, 1920)]:
    open(f"{out}/det_{w}x{h}.f32", "wb").write(b"\0" * (4 * 3 * h * w))
for w in [320, 448, 640, 896, 1280]:
    open(f"{out}/rec_{w}.f32", "wb").write(b"\0" * (4 * 3 * 48 * w))
EOF
cpu=${CPU:-0}
det=$models/PP-OCRv6_tiny_det_onnx/inference.onnx
for s in 640x352 960x544 1920x1088; do
  w=${s%x*} h=${s#*x}
  echo "== tiny det $s alone"
  taskset -c "$cpu" "$parity" "$det" concrete "$out" "$out/det_$s.f32:1x3x${h}x${w}" --repeat 3 2>&1
done
echo "== tiny det, all three buckets in one process"
taskset -c "$cpu" "$parity" "$det" concrete "$out" "$out/det_640x352.f32:1x3x352x640" "$out/det_960x544.f32:1x3x544x960" "$out/det_1920x1088.f32:1x3x1088x1920" 2>&1
for size in small tiny; do
  echo "== $size rec, five width buckets in one process"
  taskset -c "$cpu" "$parity" "$models/PP-OCRv6_${size}_rec_onnx/inference.onnx" concrete "$out" \
    "$out/rec_320.f32:1x3x48x320" "$out/rec_448.f32:1x3x48x448" "$out/rec_640.f32:1x3x48x640" \
    "$out/rec_896.f32:1x3x48x896" "$out/rec_1280.f32:1x3x48x1280" --repeat 2 2>&1
done
uptime
