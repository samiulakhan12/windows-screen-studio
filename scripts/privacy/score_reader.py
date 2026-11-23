#!/usr/bin/env python3
"""Scores a screen-text reader on the privacy evaluation set (tests/fixtures/privacy-eval).

  python3 -I scripts/privacy/score_reader.py read  --set DIR --models DIR --config tiny --out reads/tiny.json
  python3 -I scripts/privacy/score_reader.py score --set DIR reads/*.json [--json out.json]

`read` runs one reader configuration (one process, ONNX Runtime on one thread) over every frame and
writes each line's quad, box, text, confidence, per-character x ranges and timings, plus the
process's peak memory. `score` turns reads into covers with rules.py and measures them against
truth.json:
  pattern recall  an on-by-default item at least half covered by covers the rules made;
  covered         an item 99% or more inside the covers, each grown by a pad of
                  max(3 px, 0.25 x the line height) on every side (as Flown pads a cover);
  exact text      the item's text (spaces dropped) inside the text of the lines over it;
  false hits      ordinary or off-by-default items 30% or more covered, and covers that touch no
                  on-by-default item.
QR codes are found with OpenCV's QRCodeDetector (a stand-in for the helper's QR reader), not OCR.

Configurations: tiny (tiny det + tiny rec), careful (tiny + a second read with the small
recogniser of lines that may hold a secret), tinydet-smallrec, small (small det + small rec),
medium (medium det + medium rec).
"""
import argparse
import json
import os
import resource
import statistics
import sys
import time
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

CONFIGS = {
    "tiny": ("tiny", "tiny", None),
    "careful": ("tiny", "tiny", "small"),
    "tinydet-smallrec": ("tiny", "small", None),
    "small": ("small", "small", None),
    "smalldet-careful": ("small", "tiny", "small"),
    "careful-narrow": ("tiny", "tiny", "small"),
    "medium": ("medium", "medium", None),
}


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def cmd_read(a):
    import ppocr
    from rules import may_hold_secret, may_hold_secret_narrow

    if a.config == "careful-narrow":
        may_hold_secret = may_hold_secret_narrow  # noqa: F811

    det_name, rec_name, careful_name = CONFIGS[a.config]
    md = lambda size, k: os.path.join(a.models, f"PP-OCRv6_{size}_{k}_onnx")
    rss0 = rss_mb()
    t0 = time.perf_counter()
    det = ppocr.Detector(md(det_name, "det"), fit=a.fit)
    rec = ppocr.Recogniser(md(rec_name, "rec"))
    careful = ppocr.Recogniser(md(careful_name, "rec")) if careful_name else None
    load_ms = (time.perf_counter() - t0) * 1e3
    rss_loaded = rss_mb()
    truth = json.load(open(os.path.join(a.set, "truth.json")))
    frames = []
    for f in truth["frames"]:
        if a.only and a.only not in f["file"]:
            continue
        img = cv2.imread(os.path.join(a.set, f["file"]), cv2.IMREAD_COLOR)
        c0 = time.process_time()
        boxes, det_ms, _ = det(img)
        det_cpu = (time.process_time() - c0) * 1e3
        c1 = time.process_time()
        lines, rec_ms, careful_ms, careful_n = [], 0.0, 0.0, 0
        for q in boxes:
            crop, rotated = ppocr.rotate_crop(img, q)
            if crop.shape[0] < 2 or crop.shape[1] < 2:
                continue
            r, ms = rec(crop)
            rec_ms += ms
            x0, y0 = float(q[:, 0].min()), float(q[:, 1].min())
            x1, y1 = float(q[:, 0].max()), float(q[:, 1].max())
            to_abs = lambda sp: [] if rotated else [[x0 + s0, x0 + s1] for s0, s1 in sp]
            variants = [{"model": rec_name, "text": r["text"], "conf": r["conf"], "spans": to_abs(r["spans"])}]
            if careful and may_hold_secret(r["text"], r["conf"]):
                r2, ms2 = careful(crop)
                careful_ms += ms2
                careful_n += 1
                variants.append({"model": careful_name, "text": r2["text"], "conf": r2["conf"], "spans": to_abs(r2["spans"])})
            lines.append({"quad": q.round(1).tolist(), "bbox": [x0, y0, x1, y1], "variants": variants})
        all_cpu = (time.process_time() - c1) * 1e3
        frames.append({"file": f["file"], "detCpuMs": round(det_cpu, 1), "recAndCarefulCpuMs": round(all_cpu, 1), "loadAvg": round(os.getloadavg()[0], 2), "detMs": round(det_ms, 1), "recMs": round(rec_ms, 1), "carefulMs": round(careful_ms, 1), "lines": lines, "carefulLines": careful_n})
        print(f"{a.config} {f['file']}: {len(lines)} lines det {det_ms:.0f} ms rec {rec_ms:.0f} ms careful {careful_ms:.0f} ms ({careful_n})", file=sys.stderr)
    out = {"config": a.config, "det": det_name, "rec": rec_name, "careful": careful_name, "fit": a.fit, "threads": 1, "loadMs": round(load_ms, 1),
           "rssStartMb": round(rss0, 1), "rssLoadedMb": round(rss_loaded, 1), "peakRssMb": round(rss_mb(), 1), "frames": frames}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"))


PAD_CHARS = float(os.environ.get("PRIVACY_PAD_CHARS", "1.0"))  # horizontal pad, in characters of the cover's line


def rect_mask(shape, rects, pad_fn=None):
    m = np.zeros(shape, bool)
    for r in rects:
        x0, y0, x1, y1 = r[:4]
        p = pad_fn(r) if pad_fn else 0
        x0, y0 = max(0, int(np.floor(x0 - p))), max(0, int(np.floor(y0 - p)))
        x1, y1 = min(shape[1], int(np.ceil(x1 + p))), min(shape[0], int(np.ceil(y1 + p)))
        if x1 > x0 and y1 > y0:
            m[y0:y1, x0:x1] = True
    return m


def ink_rects(img, it):
    """Each of an item's rectangles shrunk to its ink: the pixels that differ from the rectangle's
    own border colour (its local background), grown by 1 px. What a cover must hide."""
    out = []
    for x, y, w, h in it["rects"]:
        sub = img[y : y + h, x : x + w].astype(np.int32)
        if sub.size == 0:
            continue
        border = np.concatenate([sub[0], sub[-1], sub[:, 0], sub[:, -1]])
        bg = np.median(border, axis=0)
        ink = np.abs(sub - bg).sum(axis=2) > 60
        ys, xs = np.nonzero(ink)
        if len(xs) == 0:
            out.append([x, y, w, h])
            continue
        x0, x1 = max(x, x + xs.min() - 1), min(x + w, x + xs.max() + 2)
        y0, y1 = max(y, y + ys.min() - 1), min(y + h, y + ys.max() + 2)
        out.append([int(x0), int(y0), int(x1 - x0), int(y1 - y0)])
    return out


def item_fraction(mask, it, key="rects"):
    tot = cov = 0
    for x, y, w, h in it[key]:
        sub = mask[y : y + h, x : x + w]
        tot += sub.size
        cov += int(sub.sum())
    return cov / tot if tot else 0.0


CONFUSABLE = str.maketrans({"O": "0", "o": "0", "Q": "0", "I": "1", "l": "1", "|": "1", "×": "x"})


def fold(t):
    return unicodedata.normalize("NFKC", t).replace(" ", "").translate(CONFUSABLE)


def find_qr(img):
    """QR codes by their finder patterns (OpenCV's ArUco-based detector, then the classic one)."""
    out = []
    for make in (getattr(cv2, "QRCodeDetectorAruco", None), cv2.QRCodeDetector):
        if make is None:
            continue
        ok, pts = make().detectMulti(img)
        if ok and pts is not None and len(pts):
            for p in pts:
                b = [float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())]
                if not any(abs(b[0] - o[0]) < 8 and abs(b[1] - o[1]) < 8 for o in out):
                    out.append(b)
    return out


def cmd_score(a):
    from rules import find

    truth = json.load(open(os.path.join(a.set, "truth.json")))
    names = truth["listedNames"]
    tf = {f["file"]: f for f in truth["frames"]}
    qr_cache = {}
    results = {}
    for path in a.reads:
        rd = json.load(open(path))
        per_kind, rows = {}, []
        found = covered = exact = folded = total = in_lines = covered_layout = 0
        line_misses = []
        fh_ord = fh_off = stray = 0
        n_ord = n_off = 0
        cov_fracs, misses, exact_misses = [], [], []
        times = []
        for fr in rd["frames"]:
            f = tf[fr["file"]]
            shape = (f["height"], f["width"])
            lines = fr["lines"]
            covers = find(lines, names)
            if fr["file"] not in qr_cache:
                qr_cache[fr["file"]] = find_qr(cv2.imread(os.path.join(a.set, fr["file"])))
            qr_boxes = [{"kind": "qr", "rule": "qr", "box": b, "line": -1} for b in qr_cache[fr["file"]]]
            allc = covers + qr_boxes
            line_h = lambda c: (lines[c["line"]]["bbox"][3] - lines[c["line"]]["bbox"][1]) if c["line"] >= 0 else 0

            def char_w(c):
                if c["line"] < 0:
                    return 0.0
                L = lines[c["line"]]
                n = max(1, len(L["variants"][-1]["text"]))
                return (L["bbox"][2] - L["bbox"][0]) / n

            def padded(c):
                if c["line"] < 0:  # a QR code: two modules' worth around it
                    p = max(4.0, 0.04 * (c["box"][2] - c["box"][0]))
                    return [c["box"][0] - p, c["box"][1] - p, c["box"][2] + p, c["box"][3] + p]
                py = max(3.0, 0.25 * line_h(c))
                px = max(py, PAD_CHARS * char_w(c))
                x0, y0, x1, y1 = c["box"]
                return [x0 - px, y0 - py, x1 + px, y1 + py]

            raw_mask = rect_mask(shape, [c["box"] for c in allc])
            pad_mask = rect_mask(shape, [padded(c) for c in allc])
            # The reader alone: every item under the (padded) boxes of the lines it found.
            line_mask = rect_mask(shape, [padded({"box": L["bbox"], "line": i}) for i, L in enumerate(lines)] + [padded(c) for c in qr_boxes])
            on_items = [it for it in f["items"] if it["on"]]
            img = cv2.imread(os.path.join(a.set, fr["file"]))
            for it in on_items:
                it["ink"] = ink_rects(img, it)
            for it in f["items"]:
                frac_raw = item_fraction(raw_mask, it)
                if it["on"]:
                    total += 1
                    frac_pad = item_fraction(pad_mask, it, "ink")
                    frac_layout = item_fraction(pad_mask, it)
                    covered_layout += frac_layout >= 0.99
                    k = per_kind.setdefault(it["kind"], {"n": 0, "found": 0, "covered": 0, "exact": 0})
                    k["n"] += 1
                    ok_found = frac_raw >= 0.5
                    ok_cov = frac_pad >= 0.99
                    ok_line = item_fraction(line_mask, it, "ink") >= 0.99
                    in_lines += ok_line
                    if not ok_line:
                        line_misses.append({"id": it["id"], "kind": it["kind"], "text": it["text"], "inLines": round(item_fraction(line_mask, it, "ink"), 2)})
                    # exact text: the lines over each of the item's rectangles, in reading order
                    over = []
                    for x, y, w, h in it["rects"]:
                        for L in lines:
                            bx0, by0, bx1, by1 = L["bbox"]
                            if bx0 < x + w and bx1 > x and by0 < y + h and by1 > y and L not in over:
                                over.append(L)
                    texts = ["".join(L["variants"][i]["text"] for L in over) for i in (0, -1)] if over else [""]
                    want = it["text"].replace(" ", "")
                    ok_exact = it["kind"] == "qr" or any(want in t.replace(" ", "") for t in texts)
                    ok_folded = ok_exact or any(fold(want) in fold(t) for t in texts)
                    folded += ok_folded
                    found += ok_found
                    covered += ok_cov
                    exact += ok_exact
                    k["found"] += ok_found
                    k["covered"] += ok_cov
                    k["exact"] += ok_exact
                    cov_fracs.append(frac_pad)
                    if not ok_exact:
                        exact_misses.append({"id": it["id"], "kind": it["kind"], "text": it["text"], "read": [t[:160] for t in texts]})
                    if not (ok_found and ok_cov):
                        misses.append({"id": it["id"], "kind": it["kind"], "text": it["text"], "found": round(frac_raw, 2), "padded": round(frac_pad, 2), "read": [t[:120] for t in texts]})
                elif it["kind"] == "ordinary":
                    n_ord += 1
                    if frac_raw >= 0.3:
                        fh_ord += 1
                        rows.append({"falseHit": it["id"], "text": it["text"], "frac": round(frac_raw, 2)})
                else:
                    n_off += 1
                    if frac_raw >= 0.3:
                        fh_off += 1
                        rows.append({"offHit": it["id"], "kind": it["kind"], "text": it["text"], "frac": round(frac_raw, 2)})
            on_mask = rect_mask(shape, [[x, y, x + w, y + h] for it in on_items for x, y, w, h in it["rects"]])
            for c in allc:
                x0, y0, x1, y1 = [int(round(v)) for v in c["box"]]
                if x1 <= x0 or y1 <= y0 or not on_mask[max(0, y0) : y1, max(0, x0) : x1].any():
                    stray += 1
                    rows.append({"stray": fr["file"], "kind": c["kind"], "rule": c["rule"], "box": [x0, y0, x1, y1], "text": lines[c["line"]]["variants"][-1]["text"][:80] if c["line"] >= 0 else "qr"})
            times.append(fr["detMs"] + fr["recMs"] + fr["carefulMs"])
        qr_n = per_kind.get("qr", {"n": 0})["n"]
        text_n = total - qr_n
        text_found = found - per_kind.get("qr", {}).get("found", 0)
        text_cov = covered - per_kind.get("qr", {}).get("covered", 0)
        lines_n = [len(fr["lines"]) for fr in rd["frames"]]
        results[rd["config"]] = {
            "models": {"det": rd["det"], "rec": rd["rec"], "careful": rd["careful"]},
            "items": total,
            "patternRecall": round(100 * found / total, 1),
            "padded99": round(100 * covered / total, 1),
            "padded99LayoutBox": round(100 * covered_layout / total, 1),
            "meanPaddedCoverage": round(100 * float(np.mean(cov_fracs)), 2),
            "exactText": round(100 * exact / total, 1),
            "exactFolded": round(100 * folded / total, 1),
            "inReaderLines99": round(100 * in_lines / total, 1),
            "lineMisses": line_misses,
            "textOnly": {"items": text_n, "patternRecall": round(100 * text_found / text_n, 1), "padded99": round(100 * text_cov / text_n, 1),
                         "exactText": round(100 * (exact - qr_n) / text_n, 1)},
            "falseHits": {"ordinary": f"{fh_ord}/{n_ord}", "offByDefault": f"{fh_off}/{n_off}", "strayCovers": stray},
            "perKind": {k: {**v, "recall": round(100 * v["found"] / v["n"], 1)} for k, v in sorted(per_kind.items())},
            "msPerFrame": {"mean": round(statistics.mean(times)), "median": round(statistics.median(times)), "max": round(max(times)),
                           "detMean": round(statistics.mean(fr["detMs"] for fr in rd["frames"])),
                           "recMean": round(statistics.mean(fr["recMs"] for fr in rd["frames"])),
                           "carefulMean": round(statistics.mean(fr["carefulMs"] for fr in rd["frames"])),
                           "linesMean": round(statistics.mean(lines_n), 1),
                           "carefulLineShare": round(sum(fr["carefulLines"] for fr in rd["frames"]) / max(1, sum(lines_n)), 3)},
            "loadMs": rd["loadMs"], "peakRssMb": rd["peakRssMb"], "rssLoadedMb": rd["rssLoadedMb"], "fit": rd.get("fit"),
            "misses": misses, "exactMisses": exact_misses, "falseHitRows": rows,
        }
        r = results[rd["config"]]
        print(f"{rd['config']:18s} lines {r['inReaderLines99']:5.1f}  recall {r['patternRecall']:5.1f}  padded99 {r['padded99']:5.1f}  exact {r['exactText']:5.1f}/{r['exactFolded']:5.1f}  "
              f"text-only {r['textOnly']['patternRecall']:5.1f}/{r['textOnly']['padded99']:5.1f}  ord {r['falseHits']['ordinary']} off {r['falseHits']['offByDefault']} stray {stray}  "
              f"ms/frame {r['msPerFrame']['mean']} (det {r['msPerFrame']['detMean']}, rec {r['msPerFrame']['recMean']}, careful {r['msPerFrame']['carefulMean']})  peak {rd['peakRssMb']} MB")
    if a.json:
        json.dump(results, open(a.json, "w"), indent=1, ensure_ascii=False)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("read")
    r.add_argument("--set", required=True)
    r.add_argument("--models", required=True)
    r.add_argument("--config", required=True, choices=sorted(CONFIGS))
    r.add_argument("--out", required=True)
    r.add_argument("--fit", default="pad", choices=["pad", "stretch"])
    r.add_argument("--only", default=None)
    s = sub.add_parser("score")
    s.add_argument("--set", required=True)
    s.add_argument("--json", default=None)
    s.add_argument("reads", nargs="+")
    a = p.parse_args()
    {"read": cmd_read, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
