import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "health-dual.mjs"), "utf8");

test("claude probe uses a real Anthropic model id, not model=probe", () => {
  assert.match(source, /model:\s*"claude-haiku-4-5"/);
  assert.doesNotMatch(source, /model:\s*"probe"/);
});

test("claude probe still uses an invalid key so it stays a cheap path check", () => {
  assert.match(source, /invalid-probe-key/);
  assert.match(source, /\/v1\/messages/);
});
