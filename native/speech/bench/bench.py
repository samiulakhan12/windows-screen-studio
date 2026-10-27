"""Run one sidecar command, save its JSON lines, print wall time, CPU time and peak RSS.
Usage: python3 -I bench.py <label> <out.jsonl> -- <cmd...>"""
import json, resource, subprocess, sys, time
label, out = sys.argv[1], sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
t0 = time.monotonic()
p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
wall = time.monotonic() - t0
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
open(out, "wb").write(p.stdout)
if p.stderr:
    open(out + ".stderr", "wb").write(p.stderr)
res = None
for line in p.stdout.decode().splitlines():
    j = json.loads(line)
    if j["type"] in ("result", "vad", "error", "cancelled"):
        res = j
print(json.dumps({"label": label, "exit": p.returncode, "wall_s": round(wall, 2), "cpu_s": round(ru.ru_utime + ru.ru_stime, 2),
                  "peak_rss_mb": round(ru.ru_maxrss / 1024, 1),
                  "timing": res.get("timing") if res else None, "duration": res.get("duration") if res else None,
                  "rtf_wall": round(wall / res["duration"], 4) if res and res.get("duration") else None,
                  "n_words": len(res.get("words", [])) if res else None, "language": res.get("language") if res else None}))
