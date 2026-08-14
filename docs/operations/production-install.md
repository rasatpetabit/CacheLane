# How this host installs CacheLane into `/srv/cachelane`

This is the production install path on this fleet. It is not `npm install -g cachelane`.
The npm CLI and `cachelane install` wire a single-user Claude Code home; this document is
the dual systemd lanes that actually serve traffic here.

**Kind:** current-state operator doc. Last derived: checkout `scripts/install-runtime.sh`,
`scripts/prune-runtime-backups.sh`, live units under `/etc/systemd/system/`, and
`/srv/cachelane/{GIT_SHA,INSTALLED_AT,package.json}`.

## Surfaces — do not collapse them

| Surface | Path | What it is |
|---|---|---|
| Checkout | `/srv/dev/ai/cachelane` | Syncthing-replicated source. Agents edit here. |
| Install | `/srv/cachelane` | Versioned production copy. Units `WorkingDirectory` here. |
| Runtime | `cachelane-claude.service`, `cachelane-litellm.service`, `cachelane-healthcheck.{service,timer}` | What systemd starts. `ExecStart=/usr/bin/node dist/cli/index.cjs proxy`. |

Checkout HEAD and install `GIT_SHA` are allowed to disagree. Compare them before claiming
the running process has a given commit:

```bash
git -C /srv/dev/ai/cachelane rev-parse HEAD
cat /srv/cachelane/GIT_SHA /srv/cachelane/INSTALLED_AT
```

The process loads `/srv/cachelane/dist/cli/index.cjs`, not anything under `/srv/dev`.

## Installer

Run as the service user, **not under sudo**. The script self-escalates (`sudo tee`,
`sudo systemctl`) and derives `User=` and `CACHELANE_HOME` from `$HOME`/`$USER`. Root
rewrites both units to `/root/.cachelane-*` and orphans the real databases.

```bash
# dry run: stage, npm ci, build, native-module smoke — no unit rewrite
CACHELANE_DEPLOY_DRY_RUN=1 scripts/install-runtime.sh

# apply: snapshot /srv/cachelane, prune backups, rewrite units, drain-restart
scripts/install-runtime.sh
```

Always invoke the script from the **checkout** (`/srv/dev/ai/cachelane/scripts/install-runtime.sh`).
`/srv/cachelane/scripts/` is a snapshot of whatever SHA was last installed. Running the
installer from the install tree can silently revert later scripts (healthcheck metric
export is the recorded case).

Env knobs the script itself reads:

| Variable | Default | Role |
|---|---|---|
| `CACHELANE_INSTALL` | `/srv/cachelane` | Destination tree |
| `CACHELANE_BACKUP_KEEP` | `2` | Keep-N for `<install>.backup-<ts>` siblings; validated 0–3 **before** any snapshot |
| `CACHELANE_DRAIN_TIMEOUT_SEC` | `300` | Per-lane drain wait; timeout aborts rather than force-restart |
| `CACHELANE_READY_TIMEOUT_SEC` | `30` | New process must listen after restart |
| `CACHELANE_DEPLOY_DRY_RUN` | unset | Non-empty → no unit rewrite / no restart |

## Keep-N snapshots

Each apply copies the live install to `/srv/cachelane.backup-<ts>`, then
`scripts/prune-runtime-backups.sh` keeps the newest N (default 2, hard max 3).
A bad keep value aborts **before** the snapshot is written.

There is no automation that reads those siblings back. Rollback of the **runtime
tree** is a re-run of the installer from a known checkout SHA. Rollback of
**client** config (`~/.pi`, `~/.claude`) is `scripts/rollback-client-config.sh` —
see [runbook-litellm.md](../runbook-litellm.md). Do not `cp -r /srv/cachelane`
beside it.

## Units the installer writes

| Unit | `CACHELANE_HOME` | Listen | Upstream (from that home's `config.json`, not the unit) |
|---|---|---|---|
| `cachelane-claude.service` | `~/.cachelane-claude` | `127.0.0.1` + that home's `proxy.port` (this host: **7333**) | this host: `api.anthropic.com:443` TLS |
| `cachelane-litellm.service` | `~/.cachelane-litellm` | this host: **7332** | this host: `127.0.0.1:4000` plain HTTP |
| `cachelane-healthcheck.timer` | n/a | n/a | `OnUnitActiveSec=60s` → `/usr/local/sbin/cachelane-healthcheck` |

Both proxy units: `WorkingDirectory=/srv/cachelane`, `MemoryMax=512M`,
`ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths` limited to that
lane's home (plus the LiteLLM unit's `~/.cachelane-openai` and `~/.cachelane-smoke`
symlinks). Missing ReadWritePaths directories crash the unit at NAMESPACE setup —
`mkdir` the path, then restart; do not delete the symlink targets.

Legacy **user** units `cachelane-smoke.service` and `cachelane-anthropic.service`
are disabled by the installer. The live Claude unit is `cachelane-claude.service`.

Healthcheck: local `GET /healthz` only (no upstream, no SQLite, no pipeline). Three
consecutive misses plus an idle drain are required before a restart. Prefer the
`/healthz` `inflight` field over ESTABLISHED sockets so keep-alive clients do not
block drain forever.

## `Documentation=` (fixed 2026-08-14)

Both proxy units set

```
Documentation=file:///srv/cachelane/docs/runbook-litellm.md
```

`scripts/install-runtime.sh` copies `docs/` into the install and writes the
unit with `$INSTALL` in the path, so production does **not** resolve a doc
through `/srv/dev`. This replaces the earlier `file:///srv/dev/...` value. A
unit still carrying `/srv/dev` in `Documentation=` is an un-reinstalled pre-fix
tree — run `install-runtime.sh` again to converge.

## After install

```bash
node /srv/cachelane/scripts/health-dual.mjs
curl -fsS http://127.0.0.1:7332/healthz
curl -fsS http://127.0.0.1:7333/healthz
```

Lane flags and client wiring: [lane-state.md](lane-state.md).
Claude marker gates: [runbook-claude-effectiveness.md](../runbook-claude-effectiveness.md).
LiteLLM client rollback: [runbook-litellm.md](../runbook-litellm.md).
