"""Fetch LibriSpeech test-clean utterances (CC-BY-4.0) with forced-aligned word times from the
HF datasets-server (gilkeyio/librispeech-alignments @ 0daa1eb4) and build one long clip.
Usage: python3 -I fetch_speech.py <outdir> <target_seconds>"""
import json, os, subprocess, sys, urllib.request
import numpy as np

out, target = sys.argv[1], float(sys.argv[2])
API = "https://datasets-server.huggingface.co/rows?dataset=gilkeyio/librispeech-alignments&config=default&split=test_clean&offset={}&length=100"
rows = []
for off in range(0, 600, 100):
    with urllib.request.urlopen(API.format(off)) as r:
        rows += [x["row"] for x in json.load(r)["rows"]]
# One speaker and chapter, in reading order: a natural long recording.
from collections import defaultdict
dur = defaultdict(float)
for r in rows:
    dur[r["id"].rsplit("-", 1)[0]] += max((w["end"] for w in r["words"]), default=0)
spk = max(dur, key=dur.get)
mine = sorted([r for r in rows if r["id"].startswith(spk + "-")], key=lambda r: int(r["id"].rsplit("-", 1)[1]))
pcm, truth, t = [], [], 0.0
gap = np.zeros(int(16000 * 0.4), dtype=np.float32)  # a short pause between utterances
for r in mine:
    flac = os.path.join(out, r["id"] + ".flac")
    if not os.path.exists(flac):
        urllib.request.urlretrieve(r["audio"][0]["src"], flac)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", flac, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32)
    for w in r["words"]:
        if w["word"]:
            truth.append({"word": w["word"], "start": round(t + w["start"], 3), "end": round(t + w["end"], 3)})
    pcm += [a, gap]
    t += (len(a) + len(gap)) / 16000
    if t >= target:
        break
x = np.concatenate(pcm)
pcm16 = (np.clip(x, -1, 1) * 32767).astype("<i2")
import wave
with wave.open(os.path.join(out, "clip.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm16.tobytes())
json.dump({"speaker_chapter": spk, "ids": [r["id"] for r in mine if r["id"]], "seconds": len(x) / 16000, "words": truth,
           "transcript": " ".join(r["transcript"] for r in mine)}, open(os.path.join(out, "truth.json"), "w"))
print(spk, len(x) / 16000, "s", len(truth), "words")
