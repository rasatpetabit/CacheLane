#!/usr/bin/env python3
"""Stage 2a Class B canary — real-credential smoke for the LiteLLM lane.

Scratch proxy (deployed artifact, scratch CACHELANE_HOME) with upstream the
REAL LiteLLM at 127.0.0.1:4000. Structural assertions only — never
byte-equality, since two live generations differ legitimately.
Never prints the credential.
"""
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time

SCRATCH = "/tmp/claude-1000/-home-ras/47e268fb-4ce5-45a5-a476-d61fe7fd91d8/scratchpad/canary-litellm-home-b"
PROXY_PORT = 7442
DEPLOY = "/srv/cachelane"

key = json.load(open(os.path.expanduser("~/.pi/agent/models.json")))["providers"]["litellm"]["apiKey"]
AUTH = {"authorization": f"Bearer {key}", "content-type": "application/json"}

RESULTS = []


def record(probe, ok, detail):
    RESULTS.append((probe, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {probe}: {detail}")


def req(port, method, path, body=None, timeout=60):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path, body=body, headers=AUTH)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, data


def wait_port(port, deadline=20):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


import shutil
shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(SCRATCH)
cfg = json.load(open(os.path.expanduser("~/.cachelane-litellm/config.json")))
cfg["proxy"]["port"] = PROXY_PORT
# upstream stays 127.0.0.1:4000 — the real LiteLLM
json.dump(cfg, open(f"{SCRATCH}/config.json", "w"), indent=1)

proxy = subprocess.Popen(
    ["/usr/bin/node", "dist/cli/index.cjs", "proxy"],
    cwd=DEPLOY, env=dict(os.environ, CACHELANE_HOME=SCRATCH),
    stdout=open(f"{SCRATCH}/proxy.stdout", "wb"), stderr=subprocess.STDOUT,
)
try:
    if not wait_port(PROXY_PORT):
        record("setup", False, "scratch proxy never opened its port")
        sys.exit(1)

    # B0 — model roster through the proxy (plain-forward path), pick a model
    s, b = req(PROXY_PORT, "GET", "/v1/models")
    models = [m["id"] for m in json.loads(b).get("data", [])] if s == 200 else []
    pick = next((m for m in models if "qwen" in m.lower()), models[0] if models else None)
    record("B0 roster via proxy", s == 200 and bool(models),
           f"status {s}, {len(models)} models, picked {pick!r}")
    if not pick:
        sys.exit(1)

    # B1 — non-streaming completion, real credential
    body = json.dumps({"model": pick, "max_tokens": 16,
                       "messages": [{"role": "user", "content": "Reply with the single word: canary"}]})
    s, b = req(PROXY_PORT, "POST", "/v1/chat/completions", body)
    ok, why = False, f"status {s}"
    if s == 200:
        try:
            j = json.loads(b)
            content = j["choices"][0]["message"]["content"]
            ok = bool(content) and "usage" in j
            why = f"status 200, content={content[:40]!r}, usage present={'usage' in j}"
        except Exception as e:
            why = f"status 200 but malformed: {e}"
    record("B1 non-streaming", ok, why)

    # B2 — streaming completion: ordered chunks, terminal [DONE]
    body = json.dumps({"model": pick, "max_tokens": 16, "stream": True,
                       "messages": [{"role": "user", "content": "Count: 1 2 3"}]})
    conn = http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=60)
    conn.request("POST", "/v1/chat/completions", body=body, headers=AUTH)
    r = conn.getresponse()
    arrivals, buf = [], b""
    while True:
        piece = r.read1(65536)
        if not piece:
            break
        arrivals.append(time.monotonic())
        buf += piece
    conn.close()
    frames = buf.count(b"data:")
    ok = r.status == 200 and frames >= 2 and buf.rstrip().endswith(b"data: [DONE]")
    record("B2 streaming", ok,
           f"status {r.status}, {frames} data frames in {len(arrivals)} reads, "
           f"terminal DONE={buf.rstrip().endswith(b'data: [DONE]')}")

    # B3 — FIDELITY probe, not a security assertion. The gateway is deliberately
    # auth-less on a trusted network (enforced in compile-litellm.mjs:703-709 and
    # asserted by two test suites), so a bogus key returning 200 is CORRECT. What
    # this checks is that the proxy MIRRORS upstream behaviour rather than
    # inventing its own: proxied status must equal direct-to-upstream status.
    conn = http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=30)
    conn.request("POST", "/v1/chat/completions",
                 body=json.dumps({"model": pick, "max_tokens": 4,
                                  "messages": [{"role": "user", "content": "x"}]}),
                 headers={"authorization": "Bearer sk-definitely-wrong",
                          "content-type": "application/json"})
    r = conn.getresponse()
    r.read()
    conn.close()
    proxied_status = r.status
    direct = http.client.HTTPConnection("127.0.0.1", 4000, timeout=30)
    direct.request("POST", "/v1/chat/completions",
                   body=json.dumps({"model": pick, "max_tokens": 4,
                                    "messages": [{"role": "user", "content": "x"}]}),
                   headers={"authorization": "Bearer sk-definitely-wrong",
                            "content-type": "application/json"})
    dr = direct.getresponse()
    dr.read()
    direct.close()
    record("B3 bogus-key behaviour mirrors upstream", proxied_status == dr.status,
           f"proxied {proxied_status} vs direct {dr.status} — equal means the proxy neither "
           f"adds nor removes auth behaviour (open-auth gateway is by design)")

    # B4 — proxy recorded the turns with route: proxy (scratch home, own DB)
    s, hb = req(PROXY_PORT, "GET", "/healthz")
    record("B4 proxy healthy after", s == 200 and json.loads(hb)["inflight"] == 0,
           f"/healthz {s} {hb.decode()[:60]}")

finally:
    proxy.send_signal(signal.SIGTERM)
    try:
        proxy.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proxy.kill()

fails = [r for r in RESULTS if not r[1]]
print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURE(S)'} "
      f"({len(RESULTS)} probes, real upstream 127.0.0.1:4000)")
sys.exit(1 if fails else 0)
