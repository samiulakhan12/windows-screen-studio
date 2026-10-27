"""Compare sidecar word timings with forced-aligned LibriSpeech word times.
Usage: python3 -I eval_words.py <truth.json> <run.jsonl> [--legacy]"""
import difflib, json, re, statistics, sys
truth = json.load(open(sys.argv[1]))["words"]
res = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
res = [r for r in res if r["type"] == "result"][0]
words = res["words"]
legacy = "--legacy" in sys.argv
norm = lambda s: re.sub(r"[^a-z0-9']", "", s.lower().replace("’", "'"))
# split hyphenated words and numbers the way LibriSpeech writes them is out of scope: compare tokens
hyp = [(norm(w["text"]), w) for w in words if norm(w["text"])]
ref = [(norm(w["word"]), w) for w in truth]
sm = difflib.SequenceMatcher(a=[r[0] for r in ref], b=[h[0] for h in hyp], autojunk=False)
ds, de = [], []
for a, b, n in sm.get_matching_blocks():
    for k in range(n):
        r, h = ref[a + k][1], hyp[b + k][1]
        hs, he = (h["legacy"] if legacy else (h["start"], h["end"]))
        ds.append(hs - r["start"]); de.append(he - r["end"])
# word error rate by edit distance on normalized tokens
def wer(r, h):
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))
mono = all(words[i]["start"] >= words[i - 1]["start"] - 1e-9 and words[i]["end"] >= words[i]["start"] for i in range(1, len(words)))
nonover = sum(1 for i in range(1, len(words)) if words[i]["start"] < words[i - 1]["end"] - 1e-6)
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
absr = lambda xs: [abs(x) for x in xs]
print(json.dumps({
    "run": sys.argv[2].rsplit("/", 1)[-1] + (" legacy" if legacy else ""), "ref_words": len(ref), "hyp_words": len(hyp), "matched": len(ds),
    "wer": round(wer([r[0] for r in ref], [h[0] for h in hyp]), 4), "monotonic": mono, "overlaps": nonover,
    "start_err_ms": {"mean": round(1000 * statistics.mean(ds)), "median_abs": round(1000 * statistics.median(absr(ds))), "p90_abs": round(1000 * q(absr(ds), 0.9)),
                     "within_100ms": round(sum(abs(x) <= 0.1 for x in ds) / len(ds), 3), "within_200ms": round(sum(abs(x) <= 0.2 for x in ds) / len(ds), 3)},
    "end_err_ms": {"mean": round(1000 * statistics.mean(de)), "median_abs": round(1000 * statistics.median(absr(de))), "p90_abs": round(1000 * q(absr(de), 0.9)),
                   "within_100ms": round(sum(abs(x) <= 0.1 for x in de) / len(de), 3), "within_200ms": round(sum(abs(x) <= 0.2 for x in de) / len(de), 3)},
}))
