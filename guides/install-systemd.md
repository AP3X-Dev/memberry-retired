# Install: systemd Production

Run MemBerry under systemd on a Linux server — the MCP server (and wiki viewer)
as long-running services, plus the nightly/periodic background timers. Use this
when you want the server managed by the host's init system rather than by Docker
Compose's `restart: unless-stopped`.

The unit templates live in [`deploy/systemd/`](../deploy/systemd/). They ship
with **placeholders** — substitute your own values before installing:

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `<INSTALL_DIR>` | Absolute path to the cloned MemBerry repo | `/opt/memberry` |
| `<USER>` | The system user the services run as | `memberry` |
| `<ENV_FILE>` | Path to the environment file (see below) | `/etc/memberry/env` |

These templates assume you run the **databases** (Neo4j + Redis) yourself —
either via `./scripts/setup.sh --db-only` (Docker) or as native services — and
run the **MCP server on the host** with `tsx`. The `@memberry/*` workspace
packages export TypeScript source, so the units invoke `npx tsx …` (matching
`npm run dev`), not a compiled `node dist/…`.

## 1. Prerequisites on the server

- Node.js 20+ on `PATH` (the units call `/usr/bin/npx`).
- Neo4j and Redis reachable at the URIs in your env file.
- The repo cloned at `<INSTALL_DIR>` with dependencies installed:

  ```bash
  cd <INSTALL_DIR>
  npm install
  ```

## 2. Create the environment file

systemd loads configuration from an `EnvironmentFile`. Start from
[`.env.example`](../.env.example) and write the values to `<ENV_FILE>` (e.g.
`/etc/memberry/env`). At minimum set the database connection and the API token:

```ini
# <ENV_FILE>  (e.g. /etc/memberry/env)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<your-neo4j-password>
REDIS_URL=redis://:<your-redis-password>@localhost:6379
MEMBERRY_API_TOKEN=<your-bearer-token>
OPENAI_API_KEY=<optional>
MEMBERRY_MODEL_EXTRACTION=
MEMBERRY_MODEL_SYNTHESIS=
MEMBERRY_MODEL_DREAM=
MEMBERRY_CONSOLIDATION_ENABLED=true
MEMBERRY_CONSOLIDATION_AUTO_APPLY=true
MEMBERRY_WIKI_AUTOREFRESH=true
MEMBERRY_WIKI_OUTPUT_DIR=<INSTALL_DIR>/wiki
MEMBERRY_ADMISSION_SHADOW_ENABLED=false
MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS=50
```

`MEMBERRY_ADMISSION_SHADOW_ENABLED=true` records content-free baseline-parity
recommendations after successful episodic stores. It is default-off, bounded to
32 unresolved writes and a 50ms wait by default, and has no retry or repair loop.
A process crash between the episode commit and sidecar commit can leave a gap.
Authenticated `/readyz` reports process-lifetime counters, stopping/skipped
shutdown work, and a closed failure code; it explicitly reports that history is
incomplete, durable retry and self-healing are false, and never returns 503 only
because this optional observer is degraded. Shutdown stops new observations,
drains already-started writes for at most one second, then closes the driver.
Rollback is to set the flag to `false` (or unset it) and restart; existing
sidecars remain inert audit evidence and are not deleted automatically.

Lock it down — it holds secrets:

```bash
sudo install -d -m 0750 /etc/memberry
sudo install -m 0640 /etc/memberry/env /etc/memberry/env   # adjust owner to <USER>
```

## 3. The MCP server unit

`deploy/systemd/memberry-mcp.service` (template):

```ini
[Unit]
Description=MemBerry MCP Server
After=network.target docker.service

[Service]
Type=simple
User=<USER>
WorkingDirectory=<INSTALL_DIR>
ExecStartPre=/usr/bin/mkdir -p <INSTALL_DIR>/wiki
ExecStart=/usr/bin/npx tsx packages/mcp/src/server.ts
Restart=always
RestartSec=5
EnvironmentFile=<ENV_FILE>
Environment=NODE_ENV=production
Environment=MEMBERRY_EXPORT_PATH=<INSTALL_DIR>/.memberry
Environment=MCP_PORT=3101
Environment=HOST=0.0.0.0
Environment=MEMBERRY_CONSOLIDATION_ENABLED=true
Environment=MEMBERRY_CONSOLIDATION_AUTO_APPLY=true
Environment=MEMBERRY_WIKI_AUTOREFRESH=true
Environment=MEMBERRY_WIKI_OUTPUT_DIR=<INSTALL_DIR>/wiki

[Install]
WantedBy=multi-user.target
```

> **Network exposure:** `HOST=0.0.0.0` makes the server listen on all
> interfaces. As with Docker server mode, the bearer token (`MEMBERRY_API_TOKEN`)
> is then the only gate — keep it secret. To restrict to loopback only, set
> `HOST=127.0.0.1`. Do not expose Neo4j/Redis on the LAN.

An optional drop-in, `memberry-mcp-readyz.conf`, runs an authenticated readiness
check as `ExecStartPost` after the server starts:

```ini
[Service]
ExecStartPost=/usr/bin/npx tsx packages/mcp/src/readyz-check.ts
Environment=MEMBERRY_READYZ_TIMEOUT_MS=15000
Environment=MEMBERRY_READYZ_INTERVAL_MS=500
```

Install it under `systemd/system/memberry-mcp.service.d/` to enable.

The MCP process now owns the normal memory lifecycle: it debounces successful
stores by `project:*` scope, performs an immediate startup catch-up, repeats the
catch-up every 15 minutes, retries transient failures with bounded exponential
backoff, and republishes the wiki after safe applied mutations. `/readyz`
includes the coordinator's last success/error and pending retry state. No timer
unit or manual `berry_consolidate` call is needed for healthy operation.

`MEMBERRY_CONSOLIDATION_AUTO_APPLY=true` does not authorize silent corrections:
core policy auto-applies only corroborated promotion and positive reinforcement.
Correction, contradiction, supersede, and decay proposals remain review-only.

## 4. The wiki viewer unit (optional)

`deploy/systemd/memberry-wiki.service` (template) compiles the wiki on start and
serves it on port `3200`:

```ini
[Unit]
Description=MemBerry Wiki Viewer
After=network.target docker.service memberry-mcp.service

[Service]
Type=simple
User=<USER>
WorkingDirectory=<INSTALL_DIR>
ExecStartPre=/usr/bin/npx tsx packages/wiki/src/cli.ts compile --output <INSTALL_DIR>/wiki
ExecStart=/usr/bin/npx tsx packages/wiki/src/cli.ts serve --output <INSTALL_DIR>/wiki --port 3200
Restart=always
RestartSec=10
EnvironmentFile=<ENV_FILE>
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

By default the viewer binds all interfaces (`0.0.0.0`), so a systemd deploy is
LAN-reachable on `:3200`. Set `MEMBERRY_WIKI_HOST=127.0.0.1` in `<ENV_FILE>` to
restrict it to loopback-only (falls back to `MEMBERRY_HOST`, then `HOST`).

## 5. The background timers

Three periodic jobs ship as `oneshot` services paired with timers. Each unit
sets `WorkingDirectory=<INSTALL_DIR>` and `EnvironmentFile=<ENV_FILE>`.

### Dream pass — nightly gap-filling + abductive hypotheses

`memberry-dream.service` runs the dream engine for a scope; `memberry-dream.timer`
fires it nightly at 03:30 (`Persistent=true` catches up after downtime):

```ini
# memberry-dream.service (ExecStart)
ExecStart=/usr/bin/npx tsx packages/core/src/cli.ts dream --scope project:<your-tag>
TimeoutStartSec=600
```

```ini
# memberry-dream.timer
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
Unit=memberry-dream.service
```

> Replace the hard-coded `--scope project:<your-tag>` with your project tag.

### Snapshot — nightly memory export + commit

`memberry-snapshot.service` exports memory to `<INSTALL_DIR>/.memberry` and
commits it (the snapshot path is force-added since `.memberry/` is gitignored);
`memberry-snapshot.timer` fires nightly at 03:00:

```ini
# memberry-snapshot.service (ExecStart)
ExecStart=/usr/bin/npx tsx packages/core/src/cli.ts snapshot --path ./.memberry --commit
```

### Wiki recompile — every 6 hours (optional safety net)

`memberry-wiki-compile.service` recompiles the wiki; `memberry-wiki-compile.timer`
fires every 6 hours. Live MCP publication already keeps the wiki current; retain
this persistent timer only as a belt-and-suspenders recovery check:

```ini
# memberry-wiki-compile.service (ExecStart)
ExecStart=/usr/bin/npx tsx packages/wiki/src/cli.ts compile --output <INSTALL_DIR>/wiki
```

```ini
# memberry-wiki-compile.timer
[Timer]
OnCalendar=*-*-* 00/6:00:00
Persistent=true
```

## 6. Install and enable

After substituting `<INSTALL_DIR>`, `<USER>`, and `<ENV_FILE>` in the templates:

```bash
sudo cp deploy/systemd/memberry-*.service deploy/systemd/memberry-*.timer /etc/systemd/system/
sudo systemctl daemon-reload

# Long-running services
sudo systemctl enable --now memberry-mcp.service
sudo systemctl enable --now memberry-wiki.service        # optional

# Periodic timers
sudo systemctl enable --now memberry-dream.timer
sudo systemctl enable --now memberry-snapshot.timer
sudo systemctl enable --now memberry-wiki-compile.timer
```

Check status and logs:

```bash
systemctl status memberry-mcp.service
journalctl -u memberry-mcp.service -f
systemctl list-timers 'memberry-*'
curl http://localhost:3101/healthz
```
