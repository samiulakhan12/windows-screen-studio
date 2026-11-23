#!/usr/bin/env python3
"""Reads an evaluation set with ssw-ocr (the fixture build's `readImage`) and scores the reads with
scripts/privacy/score_reader.py's rules, for the helper's tests R4, R10, R17 and R18
(native/ocr/tests/cli.rs).

  python3 -I -B native/ocr/tests/eval_reads.py --helper EXE --models DIR --set DIR --work DIR
      [--areas whole|planned] [--reader paddle|windows]

careful-long (docs/design/auto-blur.md §5.6, question 16): a line is read again with the small
recogniser when its tiny read has a stand-in rule hit or a confidence under 0.9
(rules.py may_hold_secret_narrow), or a run of 16 or more token characters after cleaning.

--areas planned reads each frame through areas cut the way a settle read's are (§5.4): every
planted text's row from its start to 64 px past the text, 64 px above and below, merged where
they overlap, so the bucket padding, packing, tiling and seam joins are what is measured (R17).

Prints one JSON line: the scorer's numbers for the configuration (patternRecall, padded99,
inReaderLines99, ...). Runs no network and writes only under --work.
"""
import argparse
import gzip
import json
import os
import re
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "scripts", "privacy"))

from rules import may_hold_secret_narrow  # noqa: E402

CLEAN = str.maketrans({"θ": "0", "Θ": "0", "ø": "0", "Ø": "0", "⊘": "0"})
LONG = re.compile(r"[A-Za-z0-9_\-+/.~]{16,}")
PINS = [
    ("PP-OCRv6_tiny_det_onnx/inference.onnx", 1780590, "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8"),
    ("PP-OCRv6_tiny_rec_onnx/inference.onnx", 4462639, "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6"),
    ("PP-OCRv6_tiny_rec_onnx/inference.yml", 55571, "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1"),
    ("PP-OCRv6_small_rec_onnx/inference.onnx", 21159378, "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634"),
    ("PP-OCRv6_small_rec_onnx/inference.yml", 150579, "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1"),
]


def load_truth(d):
    p = os.path.join(d, "truth.json")
    if os.path.exists(p):
        return json.load(open(p))
    return json.load(gzip.open(p + ".gz"))


def planned_areas(f, pad=64):
    """The areas a settle read would cut around each planted text (§5.4): its rectangles padded by
    `pad` above and below and on the right, and on the left as far as the start of its row (the
    row's label: a form's label sits at the row's start, so the read around a changed value holds
    it), merged where they overlap."""
    W, H = f["width"], f["height"]
    boxes = []
    for it in f["items"]:
        for x, y, w, h in it["rects"]:
            boxes.append([0, max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)])
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    boxes[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    boxes.pop(j)
                    merged = True
                    break
            if merged:
                break
    return [[a[0], a[1], a[2] - a[0], a[3] - a[1]] for a in boxes]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--helper", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--set", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--areas", default="whole", choices=["whole", "planned"])
    ap.add_argument("--reader", default="paddle", choices=["paddle", "windows"])
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    truth = load_truth(a.set)
    # The scorer reads truth.json and the PNGs from one folder.
    score_set = os.path.join(a.work, "set")
    os.makedirs(score_set, exist_ok=True)
    json.dump(truth, open(os.path.join(score_set, "truth.json"), "w"))
    for f in truth["frames"]:
        link = os.path.join(score_set, f["file"])
        if not os.path.exists(link):
            os.symlink(os.path.abspath(os.path.join(a.set, f["file"])), link)

    p = subprocess.Popen([a.helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    nid = [0]

    def send(o):
        nid[0] += 1
        o["id"] = nid[0]
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()
        return nid[0]

    def wait(i):
        while True:
            line = p.stdout.readline()
            if not line:
                raise SystemExit("the helper ended")
            e = json.loads(line)
            if e.get("id") == i:
                return e

    models = [{"file": f, "path": os.path.join(a.models, f), "bytes": b, "sha256": s} for f, b, s in PINS]
    e = wait(send({"op": "open", "protocol": 1, "reader": a.reader, "models": models, "ffmpeg": "ffmpeg"}))
    if "opened" not in e:
        raise SystemExit(f"open failed: {e}")
    frames = []
    for f in truth["frames"]:
        areas = planned_areas(f) if a.areas == "planned" else []
        rid = send({"op": "readImage", "png": os.path.abspath(os.path.join(a.set, f["file"])), "areas": areas})
        e = wait(rid)
        if "error" in e:
            raise SystemExit(f"{f['file']}: {e['error']}")
        lines = e["read"]["lines"]
        pick = [i for i, L in enumerate(lines) if may_hold_secret_narrow(L["variants"][0]["text"], L["variants"][0]["conf"]) or LONG.search(L["variants"][0]["text"].translate(CLEAN))]
        if pick and a.reader == "paddle":
            c = wait(send({"op": "careful", "read": rid, "lines": pick}))
            for i, vs in zip(pick, c["careful"]):
                lines[i]["variants"].extend(vs)
        else:
            send({"op": "release", "read": rid})
        out = []
        for L in lines:
            x, y, w, h = L["box"]
            out.append({"quad": L["quad"], "bbox": [x, y, x + w, y + h], "variants": L["variants"]})
        frames.append({"file": f["file"], "detMs": 0, "recMs": 0, "carefulMs": 0, "lines": out, "carefulLines": len(pick)})
    p.stdin.close()
    p.wait()
    config = f"ssw-ocr-{a.reader}-{a.areas}"
    reads = os.path.join(a.work, f"{config}.json")
    json.dump({"config": config, "det": "tiny", "rec": "tiny", "careful": "small", "loadMs": 0, "rssStartMb": 0, "rssLoadedMb": 0, "peakRssMb": 0, "frames": frames}, open(reads, "w"))
    scores = os.path.join(a.work, f"{config}-score.json")
    subprocess.run([sys.executable, "-I", "-B", os.path.join(REPO, "scripts", "privacy", "score_reader.py"), "score", "--set", score_set, "--json", scores, reads], check=True, stdout=sys.stderr)
    r = json.load(open(scores))[config]
    print(json.dumps({k: r[k] for k in ["items", "patternRecall", "padded99", "inReaderLines99", "exactFolded", "falseHits"]}))


if __name__ == "__main__":
    main()
