import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { defaultCachelaneDbPath, defaultCachelaneConfigPath } from "../index.js";

const original = process.env.CACHELANE_HOME;

afterEach(() => {
  if (original === undefined) delete process.env.CACHELANE_HOME;
  else process.env.CACHELANE_HOME = original;
});

describe("MCP default paths honour CACHELANE_HOME", () => {
  // Regression: these hardcoded ~/.cachelane, so a dual-home deploy pointed both
  // MCP servers at the Claude lane's DB and the LiteLLM lane reported the wrong
  // stats. One server per lane is the supported layout — keep them distinct.
  it("resolves the db under CACHELANE_HOME when set", () => {
    process.env.CACHELANE_HOME = "/tmp/lane-a";
    expect(defaultCachelaneDbPath()).toBe(path.join("/tmp/lane-a", "cachelane.db"));
    expect(defaultCachelaneConfigPath()).toBe(path.join("/tmp/lane-a", "config.json"));
  });

  it("gives two different homes two different databases", () => {
    process.env.CACHELANE_HOME = "/tmp/lane-claude";
    const claude = defaultCachelaneDbPath();
    process.env.CACHELANE_HOME = "/tmp/lane-litellm";
    const litellm = defaultCachelaneDbPath();
    expect(claude).not.toBe(litellm);
  });

  it("falls back to ~/.cachelane when unset", () => {
    delete process.env.CACHELANE_HOME;
    expect(defaultCachelaneDbPath()).toBe(path.join(homedir(), ".cachelane", "cachelane.db"));
  });
});
