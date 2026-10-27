"""Print the word-level diff and the worst timing errors (debug aid). Usage: worst.py truth.json run.jsonl"""
import difflib, json, re, sys
truth = json.load(open(sys.argv[1]))["words"]
res = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
words = [r for r in res if r["type"] == "result"][0]["words"]
norm = lambda s: re.sub(r"[^a-z0-9']", "", s.lower())
hyp = [(norm(w["text"]), w) for w in words if norm(w["text"])]
ref = [(norm(w["word"]), w) for w in truth]
sm = difflib.SequenceMatcher(a=[r[0] for r in ref], b=[h[0] for h in hyp], autojunk=False)
for op, a0, a1, b0, b1 in sm.get_opcodes():
    if op != "equal":
        print(op, [r[0] for r in ref[a0:a1]], "->", [h[0] for h in hyp[b0:b1]])
errs = []
for a, b, n in sm.get_matching_blocks():
    for k in range(n):
        r, h = ref[a + k][1], hyp[b + k][1]
        prev_gap = r["start"] - ref[a + k - 1][1]["end"] if a + k > 0 else None
        errs.append((abs(h["start"] - r["start"]), r["word"], r["start"], h["start"], r["end"], h["end"], prev_gap))
for e in sorted(errs, reverse=True)[:12]:
    print("start err %.2f %-12s ref %.2f-%.2f hyp %.2f-%.2f gap_before %s" % (e[0], e[1], e[2], e[4], e[3], e[5], None if e[6] is None else round(e[6], 2)))
