#!/usr/bin/env python3
"""tract against ONNX Runtime on the reader's own models and real inputs from the evaluation set.

  python3 -I scripts/privacy/tract_parity.py --set DIR --models DIR --parity PATH/TO/parity --work DIR [--frames 3 --lines 40]

Writes detection inputs (whole 1920x1088 tiles) and recognition inputs (line crops of several
widths) as raw little-endian f32, runs ONNX Runtime (one thread) on them, runs the tract `parity`
binary (native/ocr's bench, or the scratch crate) on the same files in both of its modes
(concrete: shape declared before optimising; symbolic: the ONNX file's own dynamic dims), and
reports the largest differences, the decoded text per line and the detection map's pixels on
the other side of the 0.2 threshold.
"""
import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import ppocr  # noqa: E402


def run_tract(binary, model, mode, work, inputs, repeat=1):
    args = [binary, model, mode, work] + [f"{p}:{'x'.join(map(str, s))}" for p, s in inputs] + ["--repeat", str(repeat)]
    t0 = time.perf_counter()
    r = subprocess.run(args, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout)[-2000:]}
    rows = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
    return {"rows": [x for x in rows if "input" in x], "summary": rows[-1], "stderr": r.stderr[-400:], "wallS": round(wall, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--parity", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--frames", type=int, default=3)
    ap.add_argument("--lines", type=int, default=36)
    ap.add_argument("--recs", default="tiny,small,medium")
    ap.add_argument("--dets", default="tiny,small,medium")
    ap.add_argument("--det-modes", default="declared,concrete,subst")
    ap.add_argument("--rec-modes", default="declared,concrete,subst,symbolic,symbolic-n1")
    ap.add_argument("--repeat", type=int, default=1)
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    truth = json.load(open(os.path.join(a.set, "truth.json")))
    picks = [f["file"] for f in truth["frames"]]
    picks = [picks[0], picks[10], picks[6]][: a.frames]  # dark editor 100%, light CRM 150%, 11 px logs
    md = lambda size, k: os.path.join(a.models, f"PP-OCRv6_{size}_{k}_onnx")
    report = {"frames": picks, "det": {}, "rec": {}}

    det_tiny = ppocr.Detector(md("tiny", "det"))
    crops = []
    det_inputs = []
    for fi, name in enumerate(picks):
        img = cv2.imread(os.path.join(a.set, name))
        x, _ = det_tiny.preprocess(img)
        p = os.path.join(a.work, f"det{fi}.f32")
        x.astype("<f4").tofile(p)
        det_inputs.append((p, list(x.shape), img.shape[:2]))
        boxes, _, _ = det_tiny(img)
        for q in boxes:
            c, _ = ppocr.rotate_crop(img, q)
            if c.shape[0] >= 4 and c.shape[1] >= 4:
                crops.append(c)
    # Line crops of many widths: spread across the sorted widths.
    crops.sort(key=lambda c: c.shape[1] / c.shape[0])
    idx = np.linspace(0, len(crops) - 1, min(a.lines, len(crops))).round().astype(int)
    crops = [crops[i] for i in sorted(set(idx))]

    for size in a.dets.split(","):
        det = ppocr.Detector(md(size, "det"))
        refs, ort_ms = [], []
        for p, s, hw in det_inputs:
            x = np.fromfile(p, "<f4").reshape(s)
            t0 = time.perf_counter()
            refs.append(det.sess.run(None, {"x": x})[0])
            ort_ms.append(round((time.perf_counter() - t0) * 1e3))
        report["det"][size] = {"ortMs": ort_ms}
        for mode in a.det_modes.split(","):
            tr = run_tract(a.parity, os.path.join(md(size, "det"), "inference.onnx"), mode, a.work, [(p, s) for p, s, _ in det_inputs])
            if "error" in tr:
                report["det"][size][mode] = {"error": tr["error"][:600]}
                print("det", size, mode, "ERROR", tr["error"][:300], file=sys.stderr)
                continue
            rows = []
            for (p, s, hw), ref, trow in zip(det_inputs, refs, tr["rows"]):
                got = np.fromfile(trow["out"], "<f4").reshape(trow["shapeOut"])
                d = np.abs(ref - got)
                flips = int(((ref > 0.2) != (got > 0.2)).sum())
                b_ref = det.boxes(ref[0, 0][: hw[0], : hw[1]])
                b_got = det.boxes(got[0, 0][: hw[0], : hw[1]])
                same_boxes = len(b_ref) == len(b_got) and all(np.abs(x - y).max() <= 1 for x, y in zip(b_ref, b_got))
                rows.append({"input": os.path.basename(p), "maxAbs": float(d.max()), "meanAbs": float(d.mean()), "pixels": int(d.size), "flipsAt0.2": flips,
                             "boxesOrt": len(b_ref), "boxesTract": len(b_got), "sameBoxesWithin1px": same_boxes, "tractMs": trow["ms"]})
            report["det"][size][mode] = {"rows": rows, "tract": tr["summary"], "wallS": tr["wallS"]}
            print("det", size, mode, json.dumps(rows), tr["summary"], file=sys.stderr)

    for size in a.recs.split(","):
        rec = ppocr.Recogniser(md(size, "rec"))
        inputs, refs, ort_ms = [], [], []
        for i, c in enumerate(crops):
            x, rw, img_w = rec.tensor(c)
            p = os.path.join(a.work, f"rec{i:02d}_{size}.f32")
            x.astype("<f4").tofile(p)
            inputs.append((p, list(x.shape), rw, img_w, c.shape[1]))
            t0 = time.perf_counter()
            refs.append(rec.sess.run(None, {"x": x})[0])
            ort_ms.append((time.perf_counter() - t0) * 1e3)
        out = {}
        for mode in a.rec_modes.split(","):
            tr = run_tract(a.parity, os.path.join(md(size, "rec"), "inference.onnx"), mode, a.work, [(p, s) for p, s, *_ in inputs], a.repeat)
            if "error" in tr:
                out[mode] = {"error": tr["error"][:600]}
                print("rec", size, mode, "ERROR", tr["error"][:300], file=sys.stderr)
                continue
            maxabs, same_steps, steps, same_text, n = 0.0, 0, 0, 0, 0
            diffs = []
            tract_ms = []
            for (p, s, rw, img_w, cw), ref, trow in zip(inputs, refs, tr["rows"]):
                got = np.fromfile(trow["out"], "<f4").reshape(trow["shapeOut"])
                maxabs = max(maxabs, float(np.abs(ref - got).max()))
                same_steps += int((ref[0].argmax(1) == got[0].argmax(1)).sum())
                steps += ref.shape[1]
                t_ref = rec.decode(ref[0], rw, img_w, cw)["text"]
                t_got = rec.decode(got[0], rw, img_w, cw)["text"]
                same_text += t_ref == t_got
                n += 1
                tract_ms.append(trow["ms"][-1])
                if t_ref != t_got:
                    diffs.append([t_ref, t_got])
            out[mode] = {"lines": n, "maxAbs": maxabs, "sameArgmaxSteps": f"{same_steps}/{steps}", "sameText": f"{same_text}/{n}", "textDiffs": diffs[:5],
                         "tractMsMean": round(float(np.mean(tract_ms)), 1), "ortMsMean": round(float(np.mean(ort_ms)), 1), "tract": tr["summary"], "wallS": tr["wallS"]}
            print("rec", size, mode, json.dumps({k: v for k, v in out[mode].items() if k != "tract"}), tr["summary"], file=sys.stderr)
        widths = sorted({s[3] for _, s, *_ in inputs})
        report["rec"][size] = {"widths": widths, **out}
    json.dump(report, open(os.path.join(a.work, "parity.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
