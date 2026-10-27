"""Word timings as the protocol delivers them: words rebuilt from the `segment` lines only (the
`result` line carries no words), against forced-aligned truth (docs/design/offline-captions.md
§2.1, §5.2). Also prints what the spike's tidy() gives when run per chunk (median from the words
so far, onset snap with the run's speech ranges, monotonic across chunk joins), and the old
`result.words` when the run has them (the spike's output).
Usage: python3 -I eval_stream.py <truth.json> <run.jsonl>
Gate for workstream A (base q5_1 on the 105.7 s clip, 4 threads, speech detector on):
segment_words start median <= 50 ms and >= 90 % within 200 ms."""
import difflib, json, re, statistics, sys, copy

truth = json.load(open(sys.argv[1]))["words"]
lines = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
speech = [tuple(s) for s in next(l for l in lines if l["type"] == "speech")["segments"]]
audio_s = next(l for l in lines if l["type"] == "result")["duration"]
segs = [l for l in lines if l["type"] == "segment"]
result_words = next(l for l in lines if l["type"] == "result").get("words")

def plan_chunks(speech, audio_s, frm=0.0, max_chunk=29.0):
    out = []
    for s, e in speech:
        if e <= frm: continue
        s = max(s, frm)
        if out and e - out[-1][0] <= max_chunk: out[-1][1] = e
        else: out.append([s, e])
    pad, n = 0.25, len(out)
    res = []
    for i in range(n):
        lo = (out[i-1][1] + out[i][0]) / 2 if i > 0 else 0.0
        hi = (out[i][1] + out[i+1][0]) / 2 if i + 1 < n else audio_s
        res.append((max(out[i][0] - pad, lo, 0.0), min(out[i][1] + pad, hi, audio_s)))
    return res

chunks = plan_chunks(speech, audio_s)
by_chunk = [[] for _ in chunks]
for s in segs:
    k = max(i for i, c in enumerate(chunks) if c[0] <= s["start"] + 1e-6)
    by_chunk[k].append(s)

def tidy_words(words, median_src, speech, last_end):
    durs = sorted(d for d in median_src if d > 0)
    if not durs: return words, last_end
    median = min(durs[len(durs) // 2], 0.7)
    max_word = max(median * 2, 0.3)
    for w in words:
        if w["end"] - w["start"] > max_word: w["start"] = w["end"] - max_word
        ons = [on for on, _ in speech if w["start"] < on < w["end"] - 0.05]
        if ons: w["start"] = ons[-1]
        if w["start"] < last_end: w["start"] = last_end
        if w["end"] < w["start"]: w["end"] = w["start"]
        last_end = w["end"]
    return words, last_end

# The words main receives: every segment line's words, in order.
streamed = [w for s in segs for w in s["words"]]
# per-chunk tidy, median from the words of the run so far (seeded with the first chunk)
per_chunk, seen, last_end = [], [], float("-inf")
for group in by_chunk:
    ws = copy.deepcopy([w for s in group for w in s["words"]])
    seen += [w["end"] - w["start"] for w in ws]
    ws, last_end = tidy_words(ws, seen, speech, last_end)
    per_chunk += ws
# whole-run median (what result.words had)
whole = copy.deepcopy(streamed)
whole, _ = tidy_words(whole, [w["end"] - w["start"] for w in whole], speech, float("-inf"))

norm = lambda s: re.sub(r"[^a-z0-9']", "", s.lower().replace("’", "'"))
def ev(words):
    hyp = [(norm(w["text"]), w) for w in words if norm(w["text"])]
    ref = [(norm(w["word"]), w) for w in truth]
    sm = difflib.SequenceMatcher(a=[r[0] for r in ref], b=[h[0] for h in hyp], autojunk=False)
    ds, de = [], []
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            r, h = ref[a + k][1], hyp[b + k][1]
            ds.append(h["start"] - r["start"]); de.append(h["end"] - r["end"])
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
    A = lambda xs: [abs(x) for x in xs]
    mono = all(words[i]["start"] >= words[i-1]["end"] - 1e-6 for i in range(1, len(words)))
    return {"start": [round(1000 * statistics.median(A(ds))), round(1000 * q(A(ds), .9)), round(100 * sum(abs(x) <= .2 for x in ds) / len(ds), 1)],
            "end": [round(1000 * statistics.median(A(de))), round(1000 * q(A(de), .9)), round(100 * sum(abs(x) <= .2 for x in de) / len(de), 1)],
            "matched": len(ds), "no_overlap": mono}
out = {"run": sys.argv[2].rsplit("/", 1)[-1], "chunks": len(chunks), "segment_words": ev(streamed),
       "per_chunk_tidy_of_segment_words": ev(per_chunk), "whole_run_tidy_of_segment_words": ev(whole)}
if result_words: out["result_words"] = ev(result_words)
print(json.dumps(out))
