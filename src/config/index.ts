import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CURRENT_CONFIG_VERSION, DEFAULT_CONFIG } from "./defaults.js";
import type { CachelaneConfig } from "../types/index.js";

export { CURRENT_CONFIG_VERSION } from "./defaults.js";

const configSchema = z.object({
  version: z.literal(1),
  pruner: z.object({
    enabled: z.boolean(),
    k: z.number().int().min(1).max(10),
    mode: z.enum(["default", "conservative", "aggressive"]),
  }),
  keepalive: z.object({
    policy: z.enum(["off", "static", "adaptive", "auto"]),
    interval_seconds: z.number().int().positive(),
    idle_threshold_seconds: z.number().int().positive(),
    large_prefix_threshold_tokens: z.number().int().positive(),
  }),
  classification: z.object({
    pin: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    sliding_window_turns: z.number().int().positive(),
  }),
  telemetry: z.object({
    opt_in: z.boolean(),
    endpoint: z.string().default(""),
  }),
  proxy: z
    .object({
      port: z.number().int().positive(),
      host: z.string(),
      drain_timeout_ms: z.number().int().nonnegative(),
      upstream_host: z.string(),
      upstream_port: z.number().int().positive(),
      upstream_ssl: z.boolean(),
      upstream_path_prefix: z.string().default(""),
    })
    .default(DEFAULT_CONFIG.proxy),
  features: z
    .object({
      auto_proxy: z.boolean(),
      k_pruner: z.boolean(),
      keepalive: z.boolean(),
      mutation_enabled: z.boolean().default(true),
      marker_strategy: z
        .enum(["passthrough", "prefix_only", "candidate"])
        .default("prefix_only"),
      // Defaulted, not required: zod strips unknown keys, so without an entry
      // here the field would be undefined at runtime no matter what the file
      // said — the experiment arm would be unsettable from config.
      //
      // .catch() as well as .default(): a bare enum makes an invalid value fail
      // the WHOLE parse, and loadConfig's error path then replaces the entire
      // config with DEFAULT_CONFIG. On a production file that deliberately has
      // mutation_enabled, k_pruner and pruner.enabled set to false, one typo
      // here would silently turn all three back on. Contain the bad value.
      elision_mode: z.enum(["legacy", "stateless"]).default("legacy").catch("legacy"),
    })
    .default(DEFAULT_CONFIG.features),
  health: z
    .object({
      fallback_warning_threshold_pct: z.number().nonnegative(),
      fallback_window_turns: z.number().int().positive(),
    })
    .default(DEFAULT_CONFIG.health),
  logging: z
    .object({
      level: z.enum(["error", "warn", "info", "debug"]),
      max_file_bytes: z.number().int().positive(),
      max_files: z.number().int().positive(),
    })
    .default(DEFAULT_CONFIG.logging),
  compression: z
    .object({
      enabled: z.boolean().default(DEFAULT_CONFIG.compression.enabled),
      mode: z.enum(["lossless", "balanced", "aggressive"]).default(DEFAULT_CONFIG.compression.mode),
      exclude: z.array(z.string()).default(DEFAULT_CONFIG.compression.exclude),
      json_max_array_items: z.number().int().positive().default(DEFAULT_CONFIG.compression.json_max_array_items),
      compressors: z
        .object({
          json: z.boolean().default(DEFAULT_CONFIG.compression.compressors.json),
          log: z.boolean().default(DEFAULT_CONFIG.compression.compressors.log),
          shell: z.boolean().default(DEFAULT_CONFIG.compression.compressors.shell),
        })
        .default(DEFAULT_CONFIG.compression.compressors),
      shell_profiles: z
        .record(z.string(), z.boolean())
        .default(DEFAULT_CONFIG.compression.shell_profiles ?? {}),
      retention: z
        .object({
          enabled: z.boolean().default(DEFAULT_CONFIG.compression.retention.enabled),
          min_original_tokens: z.number().int().nonnegative().default(DEFAULT_CONFIG.compression.retention.min_original_tokens),
          ttl_days: z.number().int().positive().default(DEFAULT_CONFIG.compression.retention.ttl_days),
        })
        .default(DEFAULT_CONFIG.compression.retention),
    })
    .default(DEFAULT_CONFIG.compression),
});

function assertSupportedVersion(raw: unknown): void {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    typeof (raw as { version: unknown }).version === "number" &&
    (raw as { version: number }).version > CURRENT_CONFIG_VERSION
  ) {
    throw new Error(
      `config schema version ${(raw as { version: number }).version} is newer than supported (${CURRENT_CONFIG_VERSION})`,
    );
  }
}

/**
 * Read a config for provenance without creating it or substituting defaults.
 * Report generation must not present a default route as if it came from the
 * selected database's current config.
 */
export function loadConfigStrict(configPath: string): CachelaneConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config does not exist at ${configPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `config at ${configPath} is malformed JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  assertSupportedVersion(raw);
  try {
    return configSchema.parse(raw) as CachelaneConfig;
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    throw new Error(`config at ${configPath} failed schema validation`);
  }
}

export function loadConfig(configPath: string): CachelaneConfig {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    console.warn(`[cachelane] config at ${configPath} is malformed — falling back to defaults`);
    return { ...DEFAULT_CONFIG };
  }

  assertSupportedVersion(raw);

  try {
    return configSchema.parse(raw) as CachelaneConfig;
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    console.warn(
      `[cachelane] config at ${configPath} failed validation — falling back to SAFE defaults`,
      err.message,
    );
    return safeFallbackConfig();
  }
}

/**
 * The fallback used when a config file cannot be validated.
 *
 * Returning plain DEFAULT_CONFIG here is how a single unparseable field turns
 * into an incident: the defaults enable mutation, k_pruner and the pruner, so a
 * config that deliberately disabled all three — which is exactly how production
 * is currently held safe — would silently have them switched back on by a typo.
 *
 * A configuration we could not understand is not a mandate to start rewriting
 * requests. Everything else falls back to defaults; the switches that change
 * what gets sent upstream fall back to off.
 */
function safeFallbackConfig(): CachelaneConfig {
  return {
    ...DEFAULT_CONFIG,
    pruner: { ...DEFAULT_CONFIG.pruner, enabled: false },
    features: {
      ...DEFAULT_CONFIG.features,
      k_pruner: false,
      mutation_enabled: false,
      elision_mode: "legacy",
    },
  };
}

// The fallback workspace id MUST be cwd-independent. The proxy runs inside the
// MCP server (spawned by Claude Code from an arbitrary cwd) while `cachelane
// report` runs from the user's terminal; a cwd-derived id would split writes
// and reads across two workspaces, leaving the report empty. Set
// CACHELANE_WORKSPACE_ID to partition projects within the shared global DB.
export const DEFAULT_WORKSPACE_ID = "ws_default";

export function defaultWorkspaceId(): string {
  return DEFAULT_WORKSPACE_ID;
}
