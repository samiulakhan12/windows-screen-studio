#!/usr/bin/env python3
"""Builds a "careful-long" read set from two read runs of the same frames: careful-narrow's trigger, plus any line whose cleaned
first read holds a run of 16+ token characters (re-read with the small recogniser).
Small variants come from the careful-narrow reads (narrow trigger) or the careful reads."""
import json, re, sys
narrow, broad, out = sys.argv[1:4]
N = json.load(open(narrow)); B = json.load(open(broad))
CLEAN = str.maketrans({"θ": "0", "Θ": "0", "ø": "0", "Ø": "0", "⊘": "0"})
LONG = re.compile(r"[A-Za-z0-9_\-+/.~]{16,}")
added = total = rered = 0
for fn, fb in zip(N["frames"], B["frames"]):
    assert fn["file"] == fb["file"]
    bykey = {tuple(L["bbox"]): L for L in fb["lines"]}
    extra_ms = 0.0
    for L in fn["lines"]:
        total += 1
        if len(L["variants"]) > 1:
            rered += 1
            continue
        t = L["variants"][0]["text"].translate(CLEAN)
        if LONG.search(t):
            b = bykey.get(tuple(L["bbox"]))
            if b and len(b["variants"]) > 1 and b["variants"][0]["text"] == L["variants"][0]["text"]:
                L["variants"].append(b["variants"][-1]); added += 1; rered += 1
            else:
                print("no broad variant for", fn["file"], L["bbox"], file=sys.stderr)
    fn["carefulLines"] = sum(1 for L in fn["lines"] if len(L["variants"]) > 1)
N["config"] = "careful-long"
json.dump(N, open(out, "w"))
print(f"lines {total}, re-read {rered} ({rered/total:.1%}), added by the long-token trigger {added}")

# Usage (the reads of the same set, made by score_reader.py read):
#   python3 -I scripts/privacy/careful_long.py reads/careful-narrow.json reads/careful.json reads/careful-long.json
#   python3 -I scripts/privacy/score_reader.py score --set SET reads/careful-long.json
# Every line careful-long re-reads is re-read by careful too, with the same tiny boxes and text,
# so its small-recogniser variant is taken from the careful run.
