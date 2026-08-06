#!/usr/bin/env python3
"""Stage 2a Class A canary — deterministic passthrough probes for the LiteLLM lane.

Runs the DEPLOYED artifact (/srv/cachelane/dist/cli/index.cjs) with a scratch
CACHELANE_HOME whose upstream is a local mock, so byte-equality assertions are
valid. Probes A1-A6 from the remediation plan. Exit 0 iff all pass.
"""
import hashlib
import http.client
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

SCRATCH = "/tmp/claude-1000/-home-ras/47e268fb-4ce5-45a5-a476-d61fe7fd91d8/scratchpad/canary-litellm-home"
PROXY_PORT = 7440
MOCK_PORT = 7441
DEPLOY = "/srv/cachelane"

RESULTS = []


def record(probe, ok, detail):
    RESULTS.append((probe, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {probe}: {detail}")


# ---------------------------------------------------------------- mock upstream
MOCK_LOG = []          # list of dicts, one per request the mock saw
MOCK_ABORTS = []       # timestamps of writes that failed (client gone)

FIXED_JSON = json.dumps({
    "id": "chatcmpl-mockfixed", "object": "chat.completion", "model": "mock-ok",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "fixed canary body"},
                 "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 3, "total_tokens": 4},
}).encode()

SSE_EVENTS = [
    b'data: {"id":"e1","choices":[{"delta":{"content":"one"}}]}\n\n',
    b'data: {"id":"e2","choices":[{"delta":{"content":"two"}}]}\n\n',
    b'data: {"id":"e3","choices":[{"delta":{"content":"three"}}]}\n\n',
    b"data: [DONE]\n\n",
]
SSE_DELAY = 0.4


class MockHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence
        pass

    def _read_body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _chunk(self, data):
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "mock-model"}]}).encode()
        MOCK_LOG.append({"path": self.path, "method": "GET",
                         "headers": dict(self.headers)})
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("request-id", "mock-fixed-req-id")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._read_body()
        try:
            scenario = json.loads(body).get("model", "mock-ok")
        except Exception:
            scenario = "mock-ok"
        MOCK_LOG.append({"path": self.path, "method": "POST", "scenario": scenario,
                         "headers": dict(self.headers),
                         "body_sha256": hashlib.sha256(body).hexdigest(),
                         "body_len": len(body)})

        if scenario == "mock-sse":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("request-id", "mock-fixed-req-id")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            try:
                for ev in SSE_EVENTS:
                    self._chunk(ev)
                    time.sleep(SSE_DELAY)
                self._chunk(b"")
            except (BrokenPipeError, ConnectionResetError):
                MOCK_ABORTS.append(time.monotonic())
            return

        if scenario.startswith("mock-err"):
            code = int(scenario[len("mock-err"):])
            err_body = json.dumps({"error": {"code": code, "message": "mock error"}}).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("request-id", "mock-fixed-req-id")
            if code == 429:
                self.send_header("retry-after", "7")
            self.send_header("content-length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)
            return

        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("request-id", "mock-fixed-req-id")
        self.send_header("content-length", str(len(FIXED_JSON)))
        self.end_headers()
        self.wfile.write(FIXED_JSON)


# ------------------------------------------------------------------- helpers
def http_req(port, method, path, body=None, headers=None, timeout=15):
    """Plain request; returns (status, headers-dict, body-bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path, body=body, headers=headers or {})
    r = conn.getresponse()
    data = r.read()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    conn.close()
    return r.status, hdrs, data


def wait_port(port, deadline=20):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


NAMED_HEADERS = ["content-type", "retry-after", "request-id"]


def named(hdrs):
    return {k: hdrs.get(k) for k in NAMED_HEADERS if k in hdrs}


# ---------------------------------------------------------------------- main
def main():
    # scratch home
    shutil.rmtree(SCRATCH, ignore_errors=True)
    os.makedirs(SCRATCH)
    cfg = json.load(open(os.path.expanduser("~/.cachelane-litellm/config.json")))
    cfg["proxy"]["port"] = PROXY_PORT
    cfg["proxy"]["upstream_port"] = MOCK_PORT
    json.dump(cfg, open(f"{SCRATCH}/config.json", "w"), indent=1)

    mock = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ, CACHELANE_HOME=SCRATCH)
    proxy = subprocess.Popen(
        ["/usr/bin/node", "dist/cli/index.cjs", "proxy"],
        cwd=DEPLOY, env=env,
        stdout=open(f"{SCRATCH}/proxy.stdout", "wb"),
        stderr=subprocess.STDOUT,
    )
    try:
        if not wait_port(PROXY_PORT):
            record("setup", False, "scratch proxy never opened its port")
            return
        s, _, b = http_req(PROXY_PORT, "GET", "/healthz")
        record("setup", s == 200, f"scratch /healthz {s} {b[:60]!r}")

        # A1 — request headers arrive unaltered at the mock (adapter path)
        sent = {
            "authorization": "Bearer canary-test-token",
            "x-api-key": "canary-test-key",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "canary-beta-flag",
            "content-type": "application/json",
        }
        req_body = json.dumps({"model": "mock-ok",
                               "messages": [{"role": "user", "content": "hi"}]}).encode()
        MOCK_LOG.clear()
        s, h, b = http_req(PROXY_PORT, "POST", "/v1/chat/completions", req_body, sent)
        seen = {k.lower(): v for k, v in (MOCK_LOG[-1]["headers"] if MOCK_LOG else {}).items()}
        bad = [k for k in ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"]
               if seen.get(k) != sent[k]]
        record("A1 header fidelity", not bad,
               f"named request headers at mock: {'all match' if not bad else 'MISMATCH ' + str(bad)}")

        # A2 — fixed non-streaming response byte-identical via proxy vs direct
        s_d, h_d, b_d = http_req(MOCK_PORT, "POST", "/v1/chat/completions", req_body, sent)
        s_p, h_p, b_p = http_req(PROXY_PORT, "POST", "/v1/chat/completions", req_body, sent)
        ok = s_d == s_p == 200 and b_d == b_p and named(h_d) == named(h_p)
        record("A2 body byte-equality", ok,
               f"status {s_p}, body identical={b_d == b_p} ({len(b_p)}B), named headers {named(h_p)}")

        # A3 — SSE incremental delivery
        sse_body = json.dumps({"model": "mock-sse", "stream": True,
                               "messages": [{"role": "user", "content": "hi"}]}).encode()
        conn = http.client.HTTPConnection("127.0.0.1", PROXY_PORT, timeout=15)
        conn.request("POST", "/v1/chat/completions", body=sse_body, headers=sent)
        resp = conn.getresponse()
        arrivals, chunks = [], []
        while True:
            piece = resp.read1(65536)
            if not piece:
                break
            arrivals.append(time.monotonic())
            chunks.append(piece)
        conn.close()
        got = b"".join(chunks)
        spread = arrivals[-1] - arrivals[0] if len(arrivals) > 1 else 0.0
        ok = (b"[DONE]" in got and got.count(b"data:") == 4
              and len(arrivals) >= 3 and spread >= 0.5)
        record("A3 SSE incremental", ok,
               f"{len(arrivals)} read events over {spread:.2f}s (need >=3 over >=0.5s), "
               f"4 data frames={got.count(b'data:') == 4}, DONE={b'[DONE]' in got}")

        # A4 — error propagation with named headers
        a4_ok, details = True, []
        for code in (400, 429, 500):
            eb = json.dumps({"model": f"mock-err{code}",
                             "messages": [{"role": "user", "content": "x"}]}).encode()
            s_d, h_d, b_d = http_req(MOCK_PORT, "POST", "/v1/chat/completions", eb, sent)
            s_p, h_p, b_p = http_req(PROXY_PORT, "POST", "/v1/chat/completions", eb, sent)
            good = s_d == s_p == code and b_d == b_p and named(h_d) == named(h_p)
            a4_ok &= good
            details.append(f"{code}:{'ok' if good else 'MISMATCH'}"
                           + (f"(retry-after={h_p.get('retry-after')})" if code == 429 else ""))
        record("A4 error propagation", a4_ok, " ".join(details))

        # A5 — client abort mid-stream reaches the mock promptly. Must be a
        # REAL abort: http.client's sock.close() leaves the fd alive via the
        # response's makefile() ref and never sends FIN/RST (proven by the
        # direct-to-mock control), so use a raw socket with SO_LINGER=0.
        import struct
        MOCK_ABORTS.clear()
        raw = socket.create_connection(("127.0.0.1", PROXY_PORT), timeout=15)
        hdr_lines = "".join(f"{k}: {v}\r\n" for k, v in sent.items())
        raw.sendall((f"POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1\r\n"
                     f"{hdr_lines}content-length: {len(sse_body)}\r\n\r\n").encode()
                    + sse_body)
        raw.recv(65536)                        # status line + first event
        t_close = time.monotonic()
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        raw.close()                            # RST — hard client abort
        deadline = t_close + 5
        while not MOCK_ABORTS and time.monotonic() < deadline:
            time.sleep(0.1)
        lag = (MOCK_ABORTS[0] - t_close) if MOCK_ABORTS else None
        s, _, hb = http_req(PROXY_PORT, "GET", "/healthz")
        inflight = json.loads(hb).get("inflight")
        time.sleep(1)
        _, _, hb2 = http_req(PROXY_PORT, "GET", "/healthz")
        inflight2 = json.loads(hb2).get("inflight")
        ok = lag is not None and lag < 3.0 and inflight2 == 0 and s == 200
        record("A5 abort propagation", ok,
               f"mock saw upstream close {f'{lag:.2f}s' if lag is not None else 'NEVER'} "
               f"after client abort; inflight {inflight}->{inflight2}; proxy healthy={s == 200}")

        # A6 — >=1 MB request body intact
        big_content = "x" * (1024 * 1024 + 137)
        big = json.dumps({"model": "mock-ok",
                          "messages": [{"role": "user", "content": big_content}]}).encode()
        MOCK_LOG.clear()
        s, _, _ = http_req(PROXY_PORT, "POST", "/v1/chat/completions", big, sent, timeout=30)
        entry = MOCK_LOG[-1] if MOCK_LOG else {}
        ok = (s == 200 and entry.get("body_len") == len(big)
              and entry.get("body_sha256") == hashlib.sha256(big).hexdigest())
        record("A6 large body", ok,
               f"status {s}, {len(big)}B sent, mock saw {entry.get('body_len')}B, "
               f"sha256 match={entry.get('body_sha256') == hashlib.sha256(big).hexdigest()}")

    finally:
        proxy.send_signal(signal.SIGTERM)
        try:
            proxy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proxy.kill()
        mock.shutdown()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURE(S)'} "
          f"({len(RESULTS)} probes, deployed artifact {open(DEPLOY + '/GIT_SHA').read().strip()})")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
