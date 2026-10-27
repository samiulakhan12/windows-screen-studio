"""Start a transcription with --stdin-control, cancel after N seconds (close stdin or send "cancel"),
and report how fast the sidecar stops. Usage: cancel_test.py <close|line> <seconds> -- <cmd...>"""
import json, subprocess, sys, time
mode, after = sys.argv[1], float(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1:]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
time.sleep(after)
t0 = time.monotonic()
if mode == "close":
    p.stdin.close()
else:
    p.stdin.write(b"cancel\n"); p.stdin.flush()
out = p.stdout.read().decode().splitlines()
code = p.wait()
dt = time.monotonic() - t0
last = json.loads(out[-1]) if out else None
segs = sum(1 for l in out if '"type":"segment"' in l)
prog = [json.loads(l)["percent"] for l in out if '"type":"progress"' in l]
print(json.dumps({"mode": mode, "cancel_after_s": after, "stop_latency_s": round(dt, 3), "exit": code, "last": last, "segments_before_cancel": segs, "last_progress": prog[-1] if prog else None}))
