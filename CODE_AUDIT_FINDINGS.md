# Code Audit Findings — discord-whatsapp

Incremental findings file (updated as audit progresses). Severity: 🔴 high, 🟡 medium, 🔵 low.

## 1. GitHub Actions

### run-bridge.yml
- 🔴 **Concurrent bridges share one WhatsApp session.** No concurrency group; push-to-main + self-retrigger + manual dispatch can run up to 5 bridges at once, all using the same `creds.json` and all writing to the same R2 key `state.tar.gz`. Last writer wins — a stale/dying run's "Save State" (`if: always`) can overwrite the newer run's fresher creds, risking WhatsApp session logout/corruption.
- 🔴 **Cancelling the oldest run skips its final backup.** The "cancel oldest" step kills runs mid-flight; cancelled runs do not execute their `Save State` step (`if: always` does run on cancel, but only ~few-min grace; tar/upload may be killed). State between the pre-trigger backup and cancellation is lost.
- 🔴 **Secret written via `echo '${{ secrets.ENV_FILE }}'`** (lines 69, 74): breaks (and is shell-injectable) if the secret contains a single quote. Use a heredoc with quoted delimiter or `printf '%s'` from an env-var: `env: { ENV_FILE: ${{ secrets.ENV_FILE }} }` + `printf '%s' "$ENV_FILE" > .env`.
- 🟡 **Self-trigger chain has no fallback.** The cron schedule is commented out (line 7-8). If the background dispatch curl fails once (API hiccup, PAT expiry, rate limit), the bridge silently dies forever. The dispatch curl has no retry and its failure is invisible (backgrounded subshell).
- 🟡 **`.env` (full secrets) is uploaded to R2** inside `state.tar.gz` — secrets at rest in the bucket, and stale secret values get merged back on next boot (R2 copy wins for keys removed from the GitHub secret? No — secretEnv spread last wins, but *deleted* keys linger forever via R2 roundtrip).
- 🟡 **`npm install` instead of `npm ci`** (line 134) despite `cache: npm` — slower + non-reproducible installs.
- 🟡 **Go toolchain unpinned** — `go build` relies on whatever ubuntu-latest ships; no `actions/setup-go`. Container-manager start loop ignores failure (continues after 10 tries without erroring).
- 🔵 PAT_TOKEN used for same-repo dispatch/cancel; `GITHUB_TOKEN` with `permissions: actions: write` would avoid PAT-expiry single point of failure (note: GITHUB_TOKEN-triggered dispatches DO start workflows for `workflow_dispatch`... actually they don't trigger `push` events, but workflow_dispatch via GITHUB_TOKEN works).
- 🔵 Cancel-oldest step itself races when several runs start simultaneously (each cancels the same "oldest" — idempotent but noisy).

### browser-worker.yml
- 🔴 **`source .env` does not export vars to child script** (line 90-101). Only `DASHBOARD_DOMAIN`, `GITHUB_RUN_ID`, `WORKER_ID`, etc. are exported; every other `.env` var is invisible to `browser-worker.sh` unless that script re-sources `.env` itself (verify). Fix: `set -a; source .env; set +a`.
- 🟡 **Worker-count math:** limit of 5 counts *runs*, but each run spawns 3 matrix jobs → up to 15 concurrent browser workers, likely 3× more than intended.
- 🟡 Same `echo '${{ secrets.ENV_FILE }}'` quoting/injection issue as run-bridge.
- 🔵 The cancel-oldest step runs in all 3 matrix jobs simultaneously (3 identical API sweeps per run).

## 2. Containers

### src-go/container-manager/main.go
- 🔴 **Cloudflare API failures are silently swallowed everywhere.** All CF calls use `if err == nil { ... }` with no status-code or `success` check (tunnel create ~line 637, ingress PUT, DNS create). If tunnel creation fails (bad token, quota), the code proceeds, saves a session with empty `TunnelID`, and returns the custom-domain URL as if deployed. User sees "success" with a dead URL.
- 🔴 **Port allocation resets on every restart.** `nextPort = 16000` is in-memory only (line 85). After the manager restarts and restores old containers (which keep their previously assigned 16000+ host ports), new deploys re-allocate the same ports → `docker run` port-bind failures. Persist `nextPort` in `go_sessions.json` or derive it from max(existing sessions)+1.
- 🔴 **Tunnel secret is 16 bytes, not 32.** `generateHash()` returns 8 hex chars (4 random bytes); `generateHash()+generateHash()` = 16 chars, base64'd. Comment says "32 bytes hex". Cloudflare requires ≥32 bytes of tunnel secret — tunnel creation may be rejected, and `rand.Read` error is ignored.
- 🔴 **Secrets leak via sessions endpoint.** `/api/go/containers/sessions` returns `Password`, `TunnelToken`, `WebhookSecret` for every session with `Access-Control-Allow-Origin: *`. Bound to 127.0.0.1, but if the dashboard proxies `/api/go/*` through its public tunnel, every dashboard visitor gets all tunnel tokens.
- 🟡 **Orphaned containers on quick-tunnel timeout.** In `handleStartContainer`, if the quick tunnel times out (30 s), the handler returns an error but the already-started container keeps running with no session record — untracked, holding a port.
- 🟡 **Stop handler deletes the session before stopping resources.** If `docker stop` or CF cleanup fails, the session record is gone and the container/tunnel leak with no way to retry.
- 🟡 **Custom-domain mode without CF creds silently no-ops.** If `CLOUDFLARE_*` env are missing and no token supplied, no tunnel is created, no error returned — session saved, URL returned, nothing routed.
- 🟡 **`restoreDockerContainers` ignores every error** (`_ = exec.Command(...).Run()`), and runs both `docker compose up` *and* `docker-compose up` unconditionally back-to-back for compose stacks (lines 336-337) — second invocation is wasted/no-op at best.
- 🟡 **Preflight CORS incomplete on `/start` and `/stop`:** they handle OPTIONS but never send `Access-Control-Allow-Methods/Headers` (only `parse`/`deploy` do) — browser preflight from a different origin fails.
- 🔵 ~500 lines of tunnel-creation logic duplicated between `handleStartContainer` and `startServiceTunnel` — should be one function.
- 🔵 `docker pull` / `docker run` in restore path use `--rm` + `-d` but no health validation; image name from request is passed unvalidated as an arg (an image string starting with `-` would be parsed as a docker flag).
- 🔵 In restore, the stale `sess` copy is written back to the map (`sessions[sess.ID] = sess`), which can clobber concurrent updates to other metadata fields.

### Dockerfile / docker-compose.yml / entrypoint
- 🟡 **Puppeteer/Chromium env not set:** image installs Alpine `chromium` but never sets `PUPPETEER_EXECUTABLE_PATH` / `PUPPETEER_SKIP_DOWNLOAD`, so puppeteer in the prod stage will look for its own bundled Chrome (which `npm ci --only=production` may not have downloaded for Alpine/musl anyway).
- 🟡 `--repository=.../edge/testing` is applied to **all** apk packages, not just cloudflared — ffmpeg/python/chromium can come from edge/testing (unstable). Pin only cloudflared to that repo (`apk add cloudflared@testing` with named repo) or install the static binary.
- 🔵 `npm ci --only=production` is deprecated → `--omit=dev`.
- 🔵 compose `version: '3.8'` is obsolete (warning on modern compose); `./.env:/app/.env` bind: if `.env` is missing on the host, Docker creates a *directory* named `.env` and the app breaks confusingly.
- 🔵 Entrypoint starts `cf_bypasser.py` with no health check and logs to /tmp (lost on restart); if it crashes nothing restarts it.

### parser.go
- 🔵 OK overall. `mergeEnvironment` in main.go still carries a `map[interface{}]interface{}` case (yaml.v2 artifact, dead with yaml.v3). Port normalization ignores `/tcp` suffixes and long-syntax port maps (object form) — long-syntax ports would render as `map[...]` garbage strings.

## 3. Core libs

### browser-pool.ts
- 🔴 **`getActive()` mutates the map while iterating in `getNext()`** indirectly fine, but `searchViaPool` caches `activeBrowsers` once (line 456) then loops `maxAttempts = activeBrowsers.length` calling `getNext()`. If browsers get evicted mid-loop (CDP failures deregister), `getNext()` works off a *fresh* active list while the attempt counter is bounded by the *stale* length — can under- or over-iterate. Minor, but the cached-vs-live mismatch is a latent bug.
- 🔴 **`recordFailure()` → `restartWorkers()` cancels ALL active runs on 20 failures/min.** During a CAPTCHA storm this nukes every worker (including healthy ones mid-request) and respawns from scratch, amplifying downtime. The 20/min threshold is global, not per-worker.
- 🟡 **Auto-scaling spawn fights the workflow self-dispatch.** `cleanup()` calls `restartWorkers()` when active < 3 every 15 s; `restartWorkers` has a 2-min cooldown + "recent run within 4 min" guard, but `recordFailure`'s path and the workflow's own 60 s dispatch can still interleave → the spawn-loop the recent commits (`544cce4`, `40aff2b`) have been fighting. Root cause: two independent controllers (Go-less TS pool + YAML) both spawn.
- 🟡 **Hardcoded default repo `talharhshdh/discord-to-whatsapp`** (lines 253, 298) — note the git remote/PR base is `talharrshdh`? Verify; a wrong default silently no-ops all cancel/dispatch when `GITHUB_REPO` is unset.
- 🟡 **`restartWorkers` dispatch uses `repository_dispatch` (`/dispatches` event_type)** but also the workflow's manual path uses `workflow_dispatch`. Two trigger mechanisms for the same workflow — confirm both are wired, else one silently fails.
- 🔵 The `noyare pc tool` special-case (lines 572-613) is hardcoded SEO/traffic-gen logic baked into the generic search path — sets `pageErrored=true` in `finally` unconditionally (discards the page even on success path). Smells like it should be isolated/removed.
- 🔵 `searchViaPool` re-parses results up to 3× (lines 1155-1171) with no delay between — the "organic < 10 → re-extract immediately" does the same DOM read twice for no benefit (page hasn't changed).

### page-pool.ts
- 🟡 **Request-interception handler can throw `Request is already handled`.** In `acquirePage` the new-page handler calls `req.abort()/continue()` without the `isInterceptResolutionHandled()` guard that `browser-pool.ts` uses — and `searchViaPool` *also* calls `page.removeAllListeners('request')` + re-adds its own. The two interception setups race on reused pages.
- 🟡 **Connection-promise leak on success path:** `connectionPromises` is set but only deleted on error (line 115) — on success the promise entry is never cleared, so a stale resolved promise lingers; if the conn is later invalidated, `connectionPromises.delete` in `invalidateWorkerConnection` handles it, but a concurrent `acquirePage` between invalidation and re-create can await the dead promise. Minor.
- 🔵 `MAX_IDLE_PAGES` pool check uses `>=` after `busyPages.delete` — fine, but pages closed on every release once 3 idle exist; under burst this thrashes (open/close churn).

### r2-sync.ts
- 🟡 **`tar -czf state.tar.gz` includes `.env`** (secrets) — same secrets-at-rest concern as the workflow. Also `execSync` with `stdio:'ignore'` swallows tar errors; a partial/corrupt archive could be uploaded and later restored as truncated state.
- 🔵 Comment says "Windows vs Linux tar compatibility" but the command is identical for both — no actual branching.

## 4. Other (worker_api.py, dashboard-server, scripts)

### worker_api.py
- 🔴 **A fresh `SB(uc=True, xvfb=True)` browser is launched per request** (every `/scrape`, `/screenshot`, `/get_html`). Cold-start seleniumbase UC takes seconds and is single-flight — no pooling, no concurrency control. Under load the FastAPI worker serializes/melts. Pair with a browser kept warm or a semaphore.
- 🟡 **`is_captcha_present` returns `True` on ANY exception** (line 40-41) — a transient `get_title()` hiccup is treated as a captcha and aborts the scrape with 403.
- 🟡 Diagnostic files (`indeed_timeout_debug.png/.html`) written to CWD and never cleaned — accumulate across runs.
- 🔵 `uvicorn.run(host=127.0.0.1)` — only reachable via the cloudflared tunnel that targets 127.0.0.1:8000; fine, but no auth on the API at all (the tunnel URL is the only secret).

### dashboard-server.ts (auth/webhook)
- 🔴 **`/api/browsers/webhook` is unauthenticated** (excluded from auth check, line 474). Anyone who learns the dashboard URL can POST `register`/`deregister` with arbitrary `cdpUrl`, injecting a malicious CDP endpoint into the pool (SSRF: the bridge will `puppeteer.connect` to attacker-controlled `wss://` and run searches through it) or evicting real workers. Add an HMAC/shared-secret check like the docker webhook (`secret` param, line 721) already does.
- 🟡 **Auth is HTTP Basic-equivalent token in a query param** (`?token=`) — tokens land in logs, Referer headers, and browser history. The token is `base64(user:pass)` (reversible). Prefer a random session token.
- 🟡 **Timing-unsafe token compare** (`providedToken === expectedToken`) — use `crypto.timingSafeEqual`.
- 🔵 `Access-Control-Allow-Origin: *` on every response combined with credentialed cookie auth is contradictory (browsers block `*` + credentials, but server-side callers bypass) — tighten to the known dashboard origin.

### Scripts / misc
- 🔵 `cf_bypasser.py`, `llm_server.py`, `tts_server.py` started but their workflow steps are commented out (LLM/TTS disabled) — dead infra in the repo; entrypoint still launches `cf_bypasser.py` in the Docker image.
- 🔵 Many untracked debug scripts (`get-runs.ts`, `cancel-active-runs.ts`, `inspect-*.ts`, `scratch-test.ts`, `debug-evaluate.ts`) — confirm intended; they bloat the image (`COPY src/scripts`).

---

## Recommended fix priority (top to bottom)
1. **🔴 WhatsApp session integrity** — add a `concurrency` group to run-bridge.yml OR a leader-lock so only one bridge writes `state.tar.gz`; stop overwriting fresher creds with stale ones.
2. **🔴 Secure `/api/browsers/webhook`** — shared-secret/HMAC; this is a live SSRF/DoS hole.
3. **🔴 Secrets in R2** — stop archiving `.env` into `state.tar.gz`; restore env from GitHub secrets only.
4. **🔴 Container-manager** — check CF API `success`/status before declaring deploy success; persist `nextPort`; fix tunnel-secret length.
5. **🔴 worker_api.py** — pool/serialize the seleniumbase browser; don't treat every exception as captcha.
6. **🟡 Spawn-loop root cause** — unify worker spawning under ONE controller (TS pool *or* workflow self-dispatch, not both).
7. **🟡 Workflow hardening** — `npm ci`, pin Go/cloudflared, quote secret writes via env, restore the cron fallback.
8. Remaining 🟡/🔵 cleanups as time permits.

## Verification
- Lint/build: `npm run build` and `cd src-go/container-manager && go vet ./... && go test ./...` (parser_test.go exists).
- Webhook auth: after adding the secret, `curl -XPOST .../api/browsers/webhook -d '{"event":"register",...}'` without the secret must return 401.
- Container-manager: deploy a compose stack via the dashboard with bad CF creds → expect an explicit error, not a fake success URL. Restart the manager and redeploy → no port-bind collision.
- Concurrency: push twice quickly to `main` → confirm only one bridge run survives and `state.tar.gz` is not clobbered by the older run's teardown.
