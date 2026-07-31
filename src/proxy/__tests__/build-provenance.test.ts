import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildSha } from "../server.js";

describe("resolveBuildSha", () => {
  it("prefers the installed runtime SHA when no environment override exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-sha-"));
    try {
      const shaPath = path.join(dir, "GIT_SHA");
      fs.writeFileSync(shaPath, "runtime-sha\n");
      expect(resolveBuildSha(undefined, shaPath, dir)).toBe("runtime-sha");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
