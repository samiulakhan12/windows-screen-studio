#!/bin/sh
# Download pinned ggml models from Hugging Face, resumable, verified by SHA-256 (the LFS oid).
# Usage: fetch_models.sh <dir> <repo> <revision> <file>:<sha256> ...
set -eu
dir=$1; repo=$2; rev=$3; shift 3
mkdir -p "$dir"
for spec in "$@"; do
  f=${spec%%:*}; want=${spec#*:}
  url="https://huggingface.co/$repo/resolve/$rev/$f"
  part="$dir/$f.part"
  [ -f "$dir/$f" ] && { echo "have $f"; continue; }
  start=$(date +%s.%N)
  curl -sSfL -C - --retry 3 -o "$part" "$url"
  got=$(sha256sum "$part" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "SHA-256 mismatch for $f: $got" >&2; exit 1; }
  mv "$part" "$dir/$f"
  end=$(date +%s.%N)
  echo "ok $f $(stat -c %s "$dir/$f") bytes in $(echo "$end - $start" | bc) s"
done
