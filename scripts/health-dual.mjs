#!/usr/bin/env node
/**
 * Dual-path CacheLane health: OpenAI→LiteLLM :7332 + Claude→Anthropic :7333.
 * Exit 0 only if both listen and respond to a cheap probe shape.
 */
import { createConnection } from "node:net";

const checks = [
  { name: "openai-litellm", host: "127.0.0.1", port: 7332, path: "/v1/models", auth: "Bearer noauth" },
  { name: "claude-anthropic", host: "127.0.0.1", port: 7333, path: "/v1/messages", method: "POST" },
];

function tcpOpen(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.end(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

async function httpProbe({ host, port, path, method = "GET", auth }) {
  const headers = { host: `${host}:${port}` };
  if (auth) headers.authorization = auth;
  let body = "";
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = "invalid-probe-key";
    body = JSON.stringify({ model: "probe", max_tokens: 1, messages: [{ role: "user", content: "x" }] });
    headers["content-length"] = Buffer.byteLength(body);
  }
  const res = await fetch(`http://${host}:${port}${path}`, { method, headers, body: body || undefined });
  // For CC path, 401/400 from Anthropic via proxy still means proxy+upstream path is alive.
  return { status: res.status, ok: res.status > 0 };
}

const results = [];
for (const c of checks) {
  const listen = await tcpOpen(c.host, c.port);
  let http = null;
  if (listen) {
    try {
      http = await httpProbe(c);
    } catch (e) {
      http = { status: 0, ok: false, error: String(e) };
    }
  }
  results.push({ ...c, listen, http });
}

const allOk = results.every((r) => r.listen && r.http && r.http.ok);
console.log(JSON.stringify({ ok: allOk, results, ts: new Date().toISOString() }, null, 2));
process.exit(allOk ? 0 : 1);
