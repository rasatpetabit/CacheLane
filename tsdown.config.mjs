import { defineConfig } from "tsdown";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts"],
  format: ["esm", "cjs"],
  outExtensions({ format }) {
    return format === "es"
      ? { js: ".js", dts: ".d.ts" }
      : { js: ".cjs", dts: ".d.cts" };
  },
  dts: true,
  clean: true,
  shims: true,
  target: "node22",
  async onSuccess() {
    const srcDir = path.join("src", "storage", "migrations");
    const destDir = path.join("dist", "migrations");
    fs.mkdirSync(destDir, { recursive: true });
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".sql"));
    for (const file of files) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  },
});
