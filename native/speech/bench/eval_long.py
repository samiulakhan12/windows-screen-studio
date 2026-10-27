"""Word timing of a long run made of N repeats of the clip: evaluate each repeat on its own window.
Usage: eval_long.py truth.json run.jsonl clip_seconds repeats"""
import difflib, json, re, statistics, sys
truth = json.load(open(sys.argv[1]))["words"]; one = float(sys.argv[3]); n = int(sys.argv[4])
res = [json.loads(l) for l in open(sys.argv[2]) if '"type":"result"' in l][0]["words"]
norm = lambda s: re.sub(r"[^a-z0-9']", "", s.lower())
ref = [norm(w["word"]) for w in truth]
ds, de, per = [], [], []
for k in range(n):
    hyp = [w for w in res if k * one <= w["start"] < (k + 1) * one and norm(w["text"])]
    hn = [norm(w["text"]) for w in hyp]
    sm = difflib.SequenceMatcher(a=ref, b=hn, autojunk=False)
    m = 0
    for a, b, l in sm.get_matching_blocks():
        for i in range(l):
            ds.append(hyp[b + i]["start"] - k * one - truth[a + i]["start"]); de.append(hyp[b + i]["end"] - k * one - truth[a + i]["end"]); m += 1
    per.append(m)
a = lambda xs: sorted(abs(x) for x in xs)
print(json.dumps({"repeats": n, "matched_per_repeat_min": min(per), "matched_per_repeat_max": max(per), "matched_total": len(ds),
  "start_median_abs_ms": round(1000 * statistics.median(a(ds))), "start_p90_abs_ms": round(1000 * a(ds)[int(0.9 * len(ds))]), "start_within_200ms": round(sum(abs(x) <= 0.2 for x in ds) / len(ds), 3),
  "end_median_abs_ms": round(1000 * statistics.median(a(de))), "end_p90_abs_ms": round(1000 * a(de)[int(0.9 * len(de))]), "end_within_200ms": round(sum(abs(x) <= 0.2 for x in de) / len(de), 3)}))
