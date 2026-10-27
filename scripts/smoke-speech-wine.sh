#!/usr/bin/env bash
# Smoke test of the two Windows speech helpers under wine (docs/design/offline-captions.md §10.2;
# optional in CI). Needs: node scripts/build-native.mjs (native/bin/ssw-speech.exe and
# ssw-speech-compat.exe), npm run fetch:test-speech, npm ci (ffmpeg-static), wine (64-bit),
# x86_64-w64-mingw32-objdump (or objdump), python3.
#
#   scripts/smoke-speech-wine.sh
#   SSW_SPEECH_CLIP=clip.wav scripts/smoke-speech-wine.sh   # also report each build's speed on that WAV
#   SSW_SPEECH_CLIP_MODEL=/path/ggml-base-q5_1.bin          # ... with this model instead of the test model
#
# Checks: both exes import only the allowed system DLLs; `cpu` (with sse42 and bmi2); `vad` (WAV
# and stdin) and `transcribe` on JFK from a non-ASCII folder; a `cancel` line ends a run with exit
# code 2 within 1 s; the compatible exe gives the same words as the standard one.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
std="$root/native/bin/ssw-speech.exe"
compat="$root/native/bin/ssw-speech-compat.exe"
model_dir="${SSW_TEST_SPEECH_CACHE:-$root/.cache/test-speech}"
model=ggml-tiny-q8_0.bin
vad_model="$root/resources/speech/ggml-silero-v6.2.0.bin"
ffmpeg=$(cd "$root" && node -p "require('ffmpeg-static')")
# A UTF-8 locale, or wine mangles the non-ASCII paths before the helper sees them.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export WINEDEBUG=${WINEDEBUG:--all}
export WINEPREFIX=${WINEPREFIX:-$root/.cache/wine}

fail() {
  echo "smoke-speech-wine: FAIL $*" >&2
  exit 1
}
ok() { echo "smoke-speech-wine: ok   $*"; }

for f in "$std" "$compat" "$model_dir/$model" "$vad_model" "$ffmpeg"; do
  [ -e "$f" ] || fail "missing $f (build-native.mjs, npm run fetch:test-speech, npm ci)"
done
command -v wine >/dev/null || fail "wine is not installed"
objdump=$(command -v x86_64-w64-mingw32-objdump || command -v objdump) || fail "objdump is missing"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dir="$work/modèle-тест"
mkdir -p "$dir"
cp "$model_dir/$model" "$vad_model" "$dir/"
win() { winepath -w "$1" 2>/dev/null; }

# 1. Imports: the verify-dist allow-list (scripts/lib/packaging.cjs SPEECH_IMPORTS).
allowed=$(cd "$root" && node -p "require('./scripts/lib/packaging.cjs').SPEECH_IMPORTS.map((n) => n.toLowerCase()).join(' ')")
for exe in "$std" "$compat"; do
  imports=$("$objdump" -p "$exe" | sed -n 's/^\s*DLL Name: //p' | sort -u | tr '\n' ' ')
  for dll in $imports; do
    case " $allowed " in *" ${dll,,} "*) ;; *) fail "$(basename "$exe") imports $dll (allowed: $allowed)" ;; esac
  done
  ok "$(basename "$exe") imports: $imports"
done

# 2. cpu (the compatible build is the one the app probes with).
wine "$compat" cpu >"$work/cpu.json" 2>"$work/cpu.err" || { rc=$?; fail "cpu exited $rc ($(tail -3 "$work/cpu.err"))"; }
python3 -I -c '
import json, sys
v = json.loads(open(sys.argv[1]).read().splitlines()[0])
assert v["type"] == "cpu" and all(isinstance(v[k], bool) for k in ("sse42", "avx", "avx2", "fma", "f16c", "bmi2")), v
' "$work/cpu.json" || fail "bad cpu line: $(cat "$work/cpu.json")"
ok "cpu: $(head -1 "$work/cpu.json")"

# 3. Audio: JFK, then JFK + the LibriSpeech clip, 16 kHz mono s16 WAVs in the non-ASCII folder.
fx="$root/tests/fixtures/speech"
"$ffmpeg" -v error -nostdin -y -i "$fx/jfk-16k.flac" -ac 1 -ar 16000 -c:a pcm_s16le "$dir/jfk.wav"
"$ffmpeg" -v error -nostdin -y -i "$fx/jfk-16k.flac" -i "$fx/ls-1272-128104-0000.flac" \
  -filter_complex '[0][1]concat=n=2:v=0:a=1' -ac 1 -ar 16000 -c:a pcm_s16le "$dir/speech.wav"
"$ffmpeg" -v error -nostdin -y -i "$dir/speech.wav" -filter_complex 'aloop=loop=11:size=2e9' -c:a pcm_s16le "$dir/long.wav"

check_vad() {
  python3 -I -c '
import base64, json, sys
v = [json.loads(l) for l in open(sys.argv[1]) if l.strip()][-1]
assert v["type"] == "vad", v
p = base64.b64decode(v["probs"])
assert len(p) == v["n"] and abs(v["audio_s"] - 11.0) < 0.1, (len(p), v["n"], v["audio_s"])
# The rules of Silero and of speechFromProbs in the app: on at 0.5, off below 0.35, pauses under
# 100 ms joined, speech under 250 ms dropped.
raw, on = [], None
for i, b in enumerate(p):
    if on is None and b >= 128: on = i
    elif on is not None and b < 90: raw.append([on, i]); on = None
if on is not None: raw.append([on, len(p)])
rs = []
for r in raw:
    if rs and r[0] - rs[-1][1] <= 3: rs[-1][1] = r[1]
    else: rs.append(r)
rs = [r for r in rs if r[1] - r[0] >= 8]
assert rs and 0.1 <= rs[0][0] * 0.032 <= 0.6 and 10.4 <= rs[-1][1] * 0.032 <= 11.0, rs
audio_s = v["audio_s"]
print(f"speech {[(round(a * 0.032, 2), round(b * 0.032, 2)) for a, b in rs]} in {audio_s} s")
' "$1"
}
for exe in "$std" "$compat"; do
  wine "$exe" vad --vad-model "$(win "$dir/ggml-silero-v6.2.0.bin")" --audio "$(win "$dir/jfk.wav")" --low-priority >"$work/vad.json" 2>"$work/vad.err" ||
    { rc=$?; fail "$(basename "$exe") vad exited $rc ($(tail -3 "$work/vad.err"))"; }
  msg=$(check_vad "$work/vad.json") || fail "$(basename "$exe") vad (WAV): $(head -c 300 "$work/vad.json")"
  ok "$(basename "$exe") vad (WAV, non-ASCII folder): $msg"
  "$ffmpeg" -v error -nostdin -i "$dir/jfk.wav" -f f32le - | wine "$exe" vad --vad-model "$(win "$dir/ggml-silero-v6.2.0.bin")" --audio - --format f32le --threads 1 >"$work/vad2.json" 2>"$work/vad2.err" ||
    { rc=$?; fail "$(basename "$exe") vad from stdin exited $rc ($(tail -3 "$work/vad2.err"))"; }
  msg=$(check_vad "$work/vad2.json") || fail "$(basename "$exe") vad (stdin): $(head -c 300 "$work/vad2.json")"
  ok "$(basename "$exe") vad (f32le on stdin): $msg"
done

# 4. transcribe with the test model, from the non-ASCII folder.
transcribe() { # exe audio out [extra args]
  local exe=$1 audio=$2 out=$3
  shift 3
  wine "$exe" transcribe --model-dir "$(win "$dir")" --model "$model" --audio "$(win "$audio")" \
    --vad-model "$(win "$dir/ggml-silero-v6.2.0.bin")" --threads "${SSW_SMOKE_THREADS:-4}" --low-priority "$@" >"$out" 2>"$out.err" </dev/null
}
words() {
  python3 -I -c '
import json, re, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
res = [l for l in lines if l["type"] == "result"]
assert res, lines[-1:]
words = [w for l in lines if l["type"] == "segment" for w in l["words"]]
for a, b in zip(words, words[1:]):
    assert b["start"] >= a["end"], (a, b)
print(" ".join(re.sub(r"[^a-z0-9]", "", w["text"].lower()) for w in words))
print(json.dumps(res[0]))
' "$1"
}
for exe in "$std" "$compat"; do
  name=$(basename "$exe" .exe)
  transcribe "$exe" "$dir/speech.wav" "$work/$name.jsonl" || { rc=$?; fail "$name transcribe exited $rc ($(tail -5 "$work/$name.jsonl.err"))"; }
  words "$work/$name.jsonl" >"$work/$name.words" || fail "$name: bad output $(tail -2 "$work/$name.jsonl")"
  grep -q "americans" "$work/$name.words" && grep -q "country" "$work/$name.words" || fail "$name heard: $(head -1 "$work/$name.words")"
  ok "$name transcribe: $(grep -o '"build":"[a-z]*"' "$work/$name.jsonl") $(tail -1 "$work/$name.words")"
done
[ "$(head -1 "$work/ssw-speech.words")" = "$(head -1 "$work/ssw-speech-compat.words")" ] ||
  fail "the builds heard different words:\n  $(head -1 "$work/ssw-speech.words")\n  $(head -1 "$work/ssw-speech-compat.words")"
ok "both builds heard the same $(head -1 "$work/ssw-speech.words" | wc -w) words: $(head -1 "$work/ssw-speech.words")"

# 5. cancel: a `cancel` line after `ready` ends the run with exit code 2 within 1 s.
node - "$std" "$(win "$dir")" "$model" "$(win "$dir/long.wav")" "$(win "$dir/ggml-silero-v6.2.0.bin")" <<'EOF' || fail "cancel"
const { spawn } = require('node:child_process')
const [exe, dir, model, audio, vad] = process.argv.slice(2)
const child = spawn('wine', [exe, 'transcribe', '--model-dir', dir, '--model', model, '--audio', audio, '--vad-model', vad, '--threads', '2', '--stdin-control'], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let sent = 0
let lineAt = 0
child.stdout.on('data', (d) => {
  buf += d
  if (sent && !lineAt && /"type":"cancelled"/.test(buf)) lineAt = Date.now()
  if (!sent && /"type":"segment"/.test(buf)) {
    sent = Date.now()
    child.stdin.write('cancel\n')
  }
})
const timer = setTimeout(() => {
  console.error('no exit within 60 s')
  child.kill('SIGKILL')
}, 60000)
child.on('close', (code) => {
  clearTimeout(timer)
  const ms = Date.now() - sent
  const cancelled = /"type":"cancelled"/.test(buf)
  console.log(`smoke-speech-wine: ${code === 2 && cancelled && sent && ms <= 1000 ? 'ok  ' : 'FAIL'} cancel: exit ${code} ${ms} ms after the cancel line${cancelled ? `, cancelled line after ${lineAt - sent} ms` : ''}`)
  process.exit(code === 2 && cancelled && sent && ms <= 1000 ? 0 : 1)
})
EOF

# 6. Speed of each build on a longer WAV (SSW_SPEECH_CLIP), for the report.
if [ -n "${SSW_SPEECH_CLIP:-}" ]; then
  clip_model=${SSW_SPEECH_CLIP_MODEL:-$dir/$model}
  cp "$clip_model" "$dir/" 2>/dev/null || true
  model=$(basename "$clip_model")
  cp "$SSW_SPEECH_CLIP" "$dir/clip.wav"
  for exe in "$std" "$compat"; do
    start=$(date +%s.%N)
    transcribe "$exe" "$dir/clip.wav" "$work/clip.jsonl" || { rc=$?; fail "$(basename "$exe") on the clip exited $rc"; }
    end=$(date +%s.%N)
    python3 -I -c '
import json, sys
r = [json.loads(l) for l in open(sys.argv[1]) if l.strip()][-1]
wall = float(sys.argv[3]) - float(sys.argv[2])
d, rtf, lang = r["duration"], r["timing"]["rtf"], r["language"]
print(f"smoke-speech-wine: speed {sys.argv[4]} with {sys.argv[5]}: {d:.1f} s of audio in {wall:.1f} s wall (RTF {wall / d:.3f}; helper rtf {rtf}, language {lang!r})")
' "$work/clip.jsonl" "$start" "$end" "$(basename "$exe")" "$model"
  done
fi
echo "smoke-speech-wine: all checks passed"
