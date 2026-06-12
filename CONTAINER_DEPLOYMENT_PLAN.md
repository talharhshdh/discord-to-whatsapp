# Container Deployment System — Production-Ready Implementation Plan

Scope: `src-go/container-manager/` (Go daemon, port 18080) + `dashboard/src/components/BetaGoContainerPanel.tsx` (main dashboard UI) + the `/api/go/*` proxy in `src/libs/dashboard-server.ts`.
(`src-go/dashboard/` is an in-built UI testing sandbox and is out of scope.)

---

## 1. Current State

### Go backend (`src-go/container-manager/main.go`, ~1400 lines)
- **5 endpoints:** `GET /sessions`, `POST /start`, `POST /stop`, `POST /compose/parse`, `POST /compose/deploy`
- Single container deploy: `docker pull` + `docker run -d --rm` with env vars and a single port mapping
- Cloudflare tunnels: quick (trycloudflare) and custom-domain (auto tunnel creation, ingress config, DNS CNAME), tunnel reuse on redeploy
- Compose: parse/normalize YAML, env merge, host-port injection, `compose up -d`, per-service tunnels
- Persistence: `auth_info/go_sessions.json` + R2 sync via a `node -e` bridge; container/tunnel restore on daemon boot

### Dashboard UI (`BetaGoContainerPanel.tsx`, ~770 lines)
- Single-container deploy form (image, container/host port, name, env text area, tunnel mode)
- Compose tab: YAML editor → parse → per-service domain routing + env overrides + volume backup checkboxes
- Sessions list (5s poll), edit/redeploy for single containers, stop, webhook URL copy

---

## 2. Gap Analysis

### 2.1 Backend — missing features

| # | Gap | Impact |
|---|-----|--------|
| B1 | **No container state truth.** Sessions are never reconciled with `docker ps`/`docker inspect`. `--rm` makes crashed containers vanish without a trace. | UI shows dead deployments as "active" indefinitely. |
| B2 | **No restart policy.** `--rm` is incompatible with `--restart`; a crashed app stays down until manual redeploy. | No self-healing — disqualifying for production. |
| B3 | **No logs endpoint** (`docker logs` tail or follow). | Impossible to debug a deployment from the UI. |
| B4 | **No metrics** (`docker stats`: CPU/mem/net). | No visibility into resource usage. |
| B5 | **No lifecycle ops** — no restart/pause; stop+delete-everything is the only operation. | Restarting an app destroys its tunnel/DNS. |
| B6 | **No private registry auth** (`docker login` / `--config`). | Can only deploy public images. |
| B7 | **No volume support for single containers**; compose volume **R2 backup is a UI-only stub** — `backupVolumes` is never sent to the backend and nothing implements backup/restore. | Data loss on any redeploy; the checkbox lies to the user. |
| B8 | **No resource limits** (`--memory`, `--cpus`). | One container can starve the host (which also runs the bridge). |
| B9 | **Single port mapping only**; compose long-syntax ports unsupported. | Multi-port apps can't deploy. |
| B10 | **Synchronous, opaque deploys.** `docker pull` of a large image blocks the HTTP request for minutes with zero feedback; no job model. | Timeouts, double-submits, terrible UX. |
| B11 | **No deployment history / rollback.** | A bad redeploy has no undo. |
| B12 | **Compose stacks are second-class:** no per-service status/logs/restart, original YAML not stored, so stacks can't be edited/redeployed from the sessions list. | Stacks are deploy-once, stop-only. |
| B13 | **No health endpoint** (docker reachable? cloudflared installed? CF creds set?). | UI can't distinguish "daemon down" from "no deployments". |
| B14 | **Tunnel processes unsupervised.** cloudflared PIDs are tracked but never watched; a dead tunnel = silently unreachable app. | Outages with no signal. |

### 2.2 Backend — correctness/security bugs (from `CODE_AUDIT_FINDINGS.md`, must fix first)

- 🔴 Cloudflare API failures silently swallowed (every CF call is `if err == nil` with no status/`success` check) → "successful" deploys with dead URLs
- 🔴 `nextPort = 16000` resets on every restart → port-bind collisions with restored containers
- 🔴 Tunnel secret is 16 bytes (two 4-byte `generateHash()` calls), not the required ≥32; `rand.Read` error ignored
- 🔴 `GET /sessions` leaks `TunnelToken`, `WebhookSecret`, `Password` through the publicly-tunneled dashboard proxy
- 🟡 Stop deletes the session record **before** stopping resources → leaked containers/tunnels on failure
- 🟡 Quick-tunnel timeout leaves an orphaned running container with no session
- 🟡 Custom-domain mode with missing CF creds silently no-ops yet reports success
- 🟡 CORS preflight incomplete on `/start` and `/stop`
- 🔵 ~500 lines of tunnel logic duplicated between `handleStartContainer` and `startServiceTunnel`
- 🔵 Image name passed unvalidated to `docker` (a value starting with `-` becomes a flag)

### 2.3 UI — missing features (`BetaGoContainerPanel.tsx`)

| # | Gap |
|---|-----|
| U1 | No status indicator per workload (running / exited / restarting / tunnel-down) or health badge |
| U2 | No logs viewer |
| U3 | No stats (CPU/mem) on cards |
| U4 | No Restart button (only Edit→full redeploy, and Stop→destroy) |
| U5 | Compose sessions render as a generic card: no per-service breakdown, no per-service URL/status/logs, **no Edit for stacks** |
| U6 | Volume backup checkboxes collected in state but never sent (`api.deployCompose` doesn't accept them) |
| U7 | No deploy progress — button shows "Provisioning…" for potentially minutes (image pull) with no steps |
| U8 | No confirmation dialog on Stop, which irreversibly deletes the tunnel + DNS record |
| U9 | Single `result` string banner for all feedback; successive actions overwrite each other; no toasts |
| U10 | Deploy form lacks: multiple ports, volumes, resource limits, restart policy, registry credentials, command override |
| U11 | No daemon health/offline state — proxy 502s surface as raw fetch errors |
| U12 | No deployment history / rollback UI |

---

## 3. Implementation Plan

### Phase 1 — Correctness & security hardening (foundation, do first)

All in `src-go/container-manager/`; refactor `main.go` into `server.go`, `sessions.go`, `docker.go`, `tunnel.go`, `compose.go`.

1. **`cfRequest` helper** that checks HTTP status *and* the API `success` flag, returns typed errors; every CF call goes through it. Deploy fails loudly if tunnel/DNS provisioning fails.
2. **Fix tunnel secret:** 32 bytes from `crypto/rand` (check the error), base64-encode.
3. **Persist port allocation:** on load, `nextPort = max(session hostPorts, 16000) + 1`; probe with a TCP listen before assigning; also detect conflicts against `docker ps` port bindings.
4. **Redact secrets** from `GET /sessions` (strip `TunnelToken`, `WebhookSecret`, `Password` in the response DTO). Webhook URL composition moves server-side (Node already knows the secret via its own session view, or add an internal-only `?internal=1` honored only from the proxy with a shared header).
5. **Fix stop ordering:** stop container → cleanup tunnel/DNS → only then delete the session; add `force: true` to delete the record anyway. Return per-step results.
6. **Cleanup orphans:** on quick-tunnel timeout or any post-`docker run` failure, stop the container before returning the error.
7. **Deduplicate tunnel logic:** one `provisionTunnel(opts) (TunnelResult, error)` used by both single and compose paths.
8. **CORS middleware + JSON error helper** applied uniformly; correct HTTP status codes (400/404/409/500/502).
9. **Replace `--rm` with `--restart unless-stopped`** + explicit `docker rm -f` during stop/redeploy. (Prerequisite for B1/B2 — keeps exited containers inspectable.)
10. **Validate inputs:** image reference regex (reject leading `-`), port ranges, domain hostname format; `--` separator before positional docker args.

**Acceptance:** failed CF provisioning returns an error to the UI; daemon restart never causes port collisions; `/sessions` response contains no secrets; a deploy that fails at any step leaves no orphaned container/tunnel/DNS record.

### Phase 2 — Real container state (truth layer)

1. **Reconciler goroutine** (every 30s + on demand): `docker ps -a --format json` + `docker compose -f … ps --format json` per stack → set `status` (`running | exited | restarting | missing`), `exitCode`, `health` on each session/service. Persist.
2. **`GET /api/go/containers/inspect?sessionId=`** → live `docker inspect` summary (state, health, image digest, started-at, port bindings).
3. **`docker events`** subscription (die/start/health_status) for near-instant updates; reconciler remains the fallback.
4. **Tunnel watchdog:** poll tracked cloudflared PIDs; on death, restart the tunnel (custom mode: same token; quick mode: re-run + re-capture URL) and mark `tunnelStatus` on the session.
5. **UI:** status dot + badge on every card (green running / amber restarting / red exited with exit code / gray missing), tunnel status indicator.

**Acceptance:** killing a container manually is reflected in the UI within 30s; killing cloudflared restores the tunnel automatically.

### Phase 3 — Logs & metrics

1. **`GET /api/go/containers/logs?sessionId=&service=&tail=200`** → `docker logs --tail N` (compose: `docker compose logs <service>`), JSON `{lines: [...]}`.
2. **`GET /api/go/containers/logs/stream?...`** → SSE follow mode (`docker logs -f` piped as `data:` events). The Node proxy already pipes responses, so streaming passes through; verify no buffering and add `X-Accel-Buffering: no`.
3. **`GET /api/go/containers/stats?sessionId=`** → `docker stats --no-stream --format json` (CPU %, mem used/limit, net I/O).
4. **UI:** "Logs" button per workload (and per compose service) opening a modal — monospace viewer, tail-size selector, Follow toggle (SSE), copy/download. Compact CPU/mem readout on each card, refreshed with the 5s poll.

### Phase 4 — Full deploy options & async deploys

1. **Extend `StartRequest`:**
   - `ports: [{host, container, protocol}]` (multiple)
   - `volumes: [{name | hostPath, containerPath, readOnly}]` — bind paths validated against an allowlist root (e.g. `<root>/volumes/`)
   - `memoryLimitMB`, `cpus`
   - `restartPolicy` (`unless-stopped` default | `on-failure` | `no`)
   - `registryAuth: {server, username, password}` → `docker --config <tmpdir> login` scoped per deploy, tmpdir deleted afterwards; credentials **never** written to sessions
   - `command`, `args` override
2. **Async deploy job model:** `POST /start` and `POST /compose/deploy` return `{jobId}` immediately. A job runs phases `validating → pulling → starting → tunneling → done|error`, capturing `docker pull` progress lines. **`GET /api/go/containers/jobs/:id`** returns phase + recent log lines. Jobs are in-memory with a small ring buffer; completed jobs expire after 10 min.
3. **UI:** Advanced (collapsible) section in the deploy form for ports list, volumes, limits, restart policy, registry creds; deploy button drives a progress stepper polling the job endpoint, showing pull progress and the failing phase on error.

**Acceptance:** a 2 GB image deploy shows live pull progress and never times out; a private GHCR image deploys with credentials that don't appear in `go_sessions.json` or `/sessions`.

### Phase 5 — Compose as a first-class citizen

1. **Wire `backupVolumes`** through `api.deployCompose` → request → session metadata.
2. **Implement volume backup/restore:** `docker run --rm -v <vol>:/data -v <stage>:/backup alpine tar czf /backup/<vol>.tar.gz /data` → upload to R2. Go-native S3 client (aws-sdk-go-v2 against the R2 endpoint) — also replaces the brittle `node -e require('./dist/...')` bridge for session-state sync. Endpoints: `POST /volumes/backup`, `POST /volumes/restore`, `GET /volumes/backups?sessionId=`. Optional cron-style schedule per stack.
3. **Store the original YAML + service settings** in the compose session metadata.
4. **Per-service operations:** restart (`docker compose restart <svc>`), logs, stats — `service` param on the Phase 2/3 endpoints.
5. **UI — compose session card:** expandable per-service rows (name, image, status, URL if routed, Restart, Logs); **Edit Stack** button that reopens the compose tab pre-filled with stored YAML + settings and redeploys with the existing `sessionId` (backend already supports `sessionId` reuse).
6. **Parser upgrades** (`parser.go`): long-syntax ports, `/tcp|/udp` suffixes, `depends_on`/`healthcheck` passthrough (stop dropping unknown keys when rewriting — modify only `environment` and `ports` in the original map, which `handleDeployCompose` already does; ensure parse-preview shows the same).

**Acceptance:** a deployed stack can be edited and redeployed from the sessions list; a Postgres volume can be backed up to R2 and restored into a fresh deploy.

### Phase 6 — History, rollback, webhooks

1. **Deployment history:** append each deploy (config snapshot, image digest from `docker inspect`, timestamp, outcome) to `auth_info/go_deployments.json`, capped at 20 per session.
2. **`POST /api/go/containers/rollback`** `{sessionId, deploymentIndex}` → redeploy that config snapshot via the normal start path (tunnel reuse applies).
3. **Webhook redeploy hardening:** verify the existing Node `/api/webhook/docker/:sessionId` path end-to-end with the new async job model (return jobId); add `POST /webhook/regenerate` for secret rotation.
4. **UI:** History list inside the Edit modal (image@digest, when, status) with one-click Rollback; webhook section with regen button.

### Phase 7 — UI production polish

1. Toast notifications (success/error, stacking) replacing the single `result` banner.
2. **Stop confirmation dialog** enumerating exactly what will be destroyed (container, tunnel, DNS record, volumes kept/removed choice).
3. Daemon health banner: call `GET /api/go/health` (Phase 8) on mount; on proxy 502 show "Go container daemon offline" with retry, instead of raw errors.
4. Workload list: search/filter, group single vs compose, sort by status.
5. Deploy form UX: image name validation hint, port-conflict pre-check (`GET /ports/check`), keyboard-accessible modals, loading skeletons.

### Phase 8 — Ops & reliability

1. **`GET /api/go/health`** → `{docker: ok|fail, cloudflared: found|missing, cfCreds: configured|partial|none, version, uptime}`.
2. **Graceful shutdown:** SIGTERM → persist sessions, leave containers running (restore path already handles re-attach), kill nothing.
3. **Structured logging** (slog, JSON) with per-request IDs; deploy audit trail.
4. **Tests:** exec-indirection interface (`type runner interface{ Run(cmd...) }`) so handlers are testable without Docker; table tests for parser (long syntax, env forms, port forms), tunnel-reuse decision logic, port allocator, reconciler state mapping. CI: `go vet`, `go test`, `staticcheck` in the existing GHA workflow (pin Go via `actions/setup-go`).
5. **Daemon supervision:** document/systemd-unit or keep the existing GHA start loop but make it fail loudly (audit finding).

---

## 4. Suggested order & rough effort

| Phase | Depends on | Effort |
|-------|-----------|--------|
| 1 Hardening | — | 1–2 days |
| 2 State truth | 1 (no `--rm`) | 1 day |
| 3 Logs/metrics | 2 | 1 day |
| 4 Deploy options + jobs | 1 | 2 days |
| 5 Compose first-class | 2, 4 | 2–3 days |
| 6 History/rollback | 4 | 1 day |
| 7 UI polish | 2 | 1–2 days |
| 8 Ops/tests | 1 | 2 days |

Phases 3/4 are parallelizable; Phase 7 can start any time after Phase 2.

## 5. Key files

| Area | Files |
|------|-------|
| Go daemon | `src-go/container-manager/main.go` → split into `server.go`, `docker.go`, `tunnel.go`, `compose.go`, `sessions.go`, `jobs.go`, `reconciler.go`, `backup.go`, `parser.go` |
| UI | `dashboard/src/components/BetaGoContainerPanel.tsx` (split into `go-containers/` subcomponents: `DeployForm`, `ComposeEditor`, `WorkloadCard`, `ComposeStackCard`, `LogsModal`, `HistoryModal`), `dashboard/src/api.ts` |
| Proxy/webhook | `src/libs/dashboard-server.ts` (`/api/go/*` streaming passthrough, webhook → job model) |
| CI | `.github/workflows/run-bridge.yml` (setup-go, fail-loud start, `go test`) |
