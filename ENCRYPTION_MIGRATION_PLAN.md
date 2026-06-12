# Repo Encryption & History Purge Plan

**Goal:** Keep all code hosted on GitHub and runnable by GitHub Actions (to keep
free unlimited Actions minutes, which require a PUBLIC repo), while making the
code unreadable to anyone without the key — in the repo contents, in git
history, and in Actions logs.

**Status quo (why this is urgent):**
- `talharhshdh/discord-to-whatsapp` is **PUBLIC**.
- `browser_data/youtube-cookies.txt` (live Google session cookies) is tracked
  and has been in public history across multiple commits.
- Actions **run logs on a public repo are publicly viewable**. The current
  workflows echo `DASHBOARD_DOMAIN`, worker IDs, and `cat container-manager.log`
  on failure — all visible to anyone.
- Traffic shows ~4,000 clones / 151 unique cloners in 14 days. Most are our own
  runners, but assume third parties have full copies of history.

**Chosen approach:** `git-crypt` (symmetric key mode) on a **brand-new public
repo**, with the old repo flipped private immediately and deleted after
migration. git-crypt encrypts file *contents* transparently: you work in
plaintext locally, GitHub stores AES-encrypted blobs, CI unlocks with a key
stored in GitHub Secrets.

**Why not just make the repo private?** Private repos get only 2,000 free
Actions minutes/month. The bridge alone runs ~43,000 min/month (24/7) plus up
to 5 browser workers — that would cost roughly $300–500+/month. Public repo +
encryption keeps the free compute.

---

## Phase 0 — Immediate containment (do this TODAY, before anything else)

1. **Flip the old repo to private right now:**
   `gh repo edit talharhshdh/discord-to-whatsapp --visibility private --accept-visibility-change-consequences`
   This instantly hides code, history, and all past Actions logs from the
   public. (Actions will start burning the 2,000 free private minutes —
   acceptable for the few days of migration; pause the cron schedule in
   `run-bridge.yml` if migration takes longer.)
2. **Rotate every credential that was ever in the repo or echoed in logs:**
   - [ ] Google account: sign out all sessions / change password →
         invalidates `youtube-cookies.txt`. Re-export fresh cookies later.
   - [ ] Discord bot token (regenerate in Discord Developer Portal).
   - [ ] WhatsApp session: assume `creds.json` handling was sound (it came
         from a secret, not the repo) but rotate if it was ever committed —
         check with `git log --all -- 'auth_info/*'`.
   - [ ] Cloudflare R2 access keys (regenerate; update `ENV_FILE` secret).
   - [ ] Cloudflare tunnel tokens (if ever committed or logged).
   - [ ] `PAT_TOKEN` (regenerate; scope it to only the new repo,
         fine-grained, `actions:write` only).
   - [ ] Anything else in `.env` — treat the whole file as leaked.
3. **Audit history for other secrets** before deciding rotation is complete:
   `git log --all --diff-filter=A --name-only | sort -u` and review anything
   that looks like creds, cookies, tokens, session state.

---

## Phase 1 — Set up git-crypt locally

1. Install: `sudo apt-get install git-crypt` (WSL) — devs on other machines
   need it too.
2. In the repo: `git-crypt init`
3. Export the symmetric key and store it OUTSIDE the repo:
   ```bash
   git-crypt export-key ~/secure/discord-bridge.gitcrypt.key
   ```
   Put a copy in a password manager. **This key is the whole ballgame — if
   it's lost, the repo is unreadable; if it leaks, encryption is void.**
4. Create `.gitattributes` at repo root — encrypt everything, with explicit
   plaintext exceptions (GitHub must be able to read these):
   ```gitattributes
   * filter=git-crypt diff=git-crypt
   .gitattributes !filter !diff
   .gitignore !filter !diff
   .github/** !filter !diff
   README.md !filter !diff
   ```
   - `.github/workflows/*` MUST stay plaintext — GitHub parses them to run
     jobs. They become the only readable code, so they will be rewritten as a
     minimal bootstrap (Phase 3).
   - Replace `README.md` with a one-line decoy (or encrypt it too by removing
     the exception — then the repo page shows binary garbage, which is fine).
5. **Stop tracking secrets that should never be in git at all** (encrypted or
   not): add `browser_data/youtube-cookies.txt` to `.gitignore` and move
   cookie provisioning to the `ENV_FILE`/R2 flow like `creds.json`.
6. Verify before any commit: `git-crypt status` must show every file as
   `encrypted` except the allowlist above. Files already committed before
   git-crypt was added are NOT retroactively encrypted — irrelevant here
   because we start a fresh history (Phase 4), but it's why the fresh history
   is mandatory, not optional.

---

## Phase 2 — GitHub setup (new repo)

1. Create a fresh repo with a **non-descriptive name** (the old name
   `discord-to-whatsapp` itself leaks what the project does), e.g.
   `talharhshdh/bridge-runtime`. Create it **private first**; flip to public
   only after the encryption guard (Phase 3.4) passes on a test push.
2. **Secrets** (Settings → Secrets and variables → Actions) — re-add all
   (secrets do not transfer between repos), with rotated values:
   - `GIT_CRYPT_KEY` — new: `base64 -w0 ~/secure/discord-bridge.gitcrypt.key`
   - `ENV_FILE` — rotated contents
   - `CREDS_JSON` — current WhatsApp creds
   - `PAT_TOKEN` — new fine-grained PAT scoped to this repo only
3. **Settings hardening:**
   - Actions → General → Workflow permissions → **Read repository contents**
     only; uncheck "Allow GitHub Actions to create and approve pull requests".
   - Actions → General → **Artifact and log retention → 1 day** (public logs
     age out fast).
   - Actions → General → Fork pull request workflows: **require approval for
     all outside collaborators**.
   - Branch protection on `main`: require PRs or at least block force pushes
     from anyone but you.
   - Do NOT enable `ACTIONS_STEP_DEBUG` / `ACTIONS_RUNNER_DEBUG` variables.
4. **Never** add `pull_request` / `pull_request_target` triggers to workflows.
   Current triggers (push to main, `workflow_dispatch`, `repository_dispatch`,
   `schedule`) are safe: fork PRs can't reach secrets through them.

---

## Phase 3 — Workflow changes (unlock + log hygiene)

### 3.1 Unlock step — insert in BOTH workflows, immediately after checkout and
**before** `setup-node` (its `cache: npm` hashes `package-lock.json`, which is
ciphertext until unlocked), before `pip install`, before anything reads files:

```yaml
- name: Unlock repository
  env:
    GIT_CRYPT_KEY: ${{ secrets.GIT_CRYPT_KEY }}
  run: |
    sudo apt-get install -y git-crypt
    keyfile=$(mktemp)
    printf '%s' "$GIT_CRYPT_KEY" | base64 -d > "$keyfile"
    git-crypt unlock "$keyfile"
    rm -f "$keyfile"
    echo "unlocked"
```
Never `set -x` in this step; never echo the key or any file contents.

### 3.2 Log hygiene (public logs!)

- App output must NOT stream to the job log. Change
  `timeout 18000 npm start` → `timeout 18000 npm start > bridge.log 2>&1`;
  same for the browser worker script. If logs are needed for debugging,
  upload `bridge.log` to R2 at teardown — never as an Actions artifact and
  never `cat` it in a step.
- Remove `echo "🌍 Dashboard: https://${DASHBOARD_DOMAIN}"` and the
  `cat container-manager.log` failure path (upload to R2 instead).
- Right after sourcing `.env` in any step, mask derived values that GitHub's
  auto-masking won't catch (masking only matches whole secret values /
  whole lines of multiline secrets, not substrings):
  ```bash
  echo "::add-mask::$DASHBOARD_DOMAIN"
  echo "::add-mask::$R2_ACCOUNT_ID"
  echo "::add-mask::$R2_BUCKET_NAME"
  ```
- Strip architecture-revealing comments and step names from the workflow
  YAMLs themselves (they stay plaintext and public). Step names like
  "Restore creds.json from GitHub Secret" → "Prepare runtime". Move all real
  logic into encrypted shell scripts (e.g. `src/scripts/ci-bootstrap.sh`) and
  have workflow steps just call them — the workflow then reveals almost
  nothing.

### 3.3 Worker callback URLs

`worker_api.py` / browser workers expose trycloudflare URLs; ensure no step
prints them. Audit `src/scripts/browser-worker.sh` for `echo`s of URLs/tokens
— it runs with output going to the public log today.

### 3.4 Encryption guard (CI tripwire — makes this fail-closed)

First step of every job, before unlock, fail the run if any tracked file
slipped in unencrypted:

```yaml
- name: Verify nothing is plaintext
  run: |
    sudo apt-get install -y git-crypt
    bad=$(git-crypt status | grep 'not encrypted' \
      | grep -v -E '\.gitattributes|\.gitignore|^\s*not encrypted: \.github/|README\.md' || true)
    if [ -n "$bad" ]; then echo "PLAINTEXT FILES DETECTED"; echo "$bad"; exit 1; fi
```

Also add a local pre-push hook with the same check so it never even leaves a
dev machine.

---

## Phase 4 — Fresh history & purging the old repo

A force-pushed `git filter-repo` rewrite is NOT sufficient on GitHub: old
commits stay reachable by SHA, in PR refs, and in caches until GitHub Support
runs a GC, and any existing clone keeps everything anyway. The foolproof path
is **new repo + delete old repo**:

1. Archive the old history privately (do not lose it):
   `git bundle create ~/secure/discord-whatsapp-archive.bundle --all`
2. In the working tree (with git-crypt configured per Phase 1, cookies file
   untracked, workflows rewritten per Phase 3), create a fresh history:
   ```bash
   rm -rf .git
   git init -b main
   git-crypt init && git-crypt unlock ~/secure/discord-bridge.gitcrypt.key  # re-bind key
   git add -A
   git commit -m "init"            # generic message; commit messages stay public forever
   git remote add origin git@github.com:talharhshdh/bridge-runtime.git
   git push -u origin main
   ```
   Note: with a fresh `git init`, instead of `git-crypt init` + unlock, the
   simpler correct sequence is: copy nothing from the old `.git`, run
   `git-crypt init`, **export and KEEP THE SAME key only if you re-import
   it** — otherwise re-export the new key and update `GIT_CRYPT_KEY`. To
   reuse the existing key: `git-crypt unlock ~/secure/discord-bridge.gitcrypt.key`.
3. Verify on github.com that file contents render as binary garbage
   (`GITCRYPT` magic bytes) and only `.github/`, `.gitattributes`,
   `.gitignore`, README are readable. Run one full Actions cycle on the
   private new repo; check the public-equivalent logs for leaks.
4. Flip new repo to **public** (restores free minutes). Re-enable the cron.
5. **Delete the old repo** (`gh repo delete talharhshdh/discord-to-whatsapp`).
   Deleting removes code, history, issues, and all old Actions logs.
   Forks: there are none (verified, forkCount=0), so nothing survives the
   delete on GitHub's side. What you cannot undo: copies already cloned by
   third parties — which is exactly why Phase 0 rotation is mandatory and
   not optional.
6. Going forward: commit messages, branch names, and file paths in the NEW
   repo are public. Keep commit messages generic ("update", "fix"). File
   *names* are also visible (git-crypt encrypts contents, not paths) — if
   path names like `youtube-dl.ts` are too revealing, that's the cost of
   git-crypt; see "tarball variant" below if full opacity is ever required.

---

## Phase 5 — Developer workflow after migration

- New machine / fresh clone:
  ```bash
  git clone git@github.com:talharhshdh/bridge-runtime.git
  cd bridge-runtime
  git-crypt unlock ~/secure/discord-bridge.gitcrypt.key
  ```
  After unlock, everything is normal: plaintext working tree, normal
  `git add/commit/push`, real local diffs. Files encrypt automatically on
  push via the filter; you never run an "encrypt" command.
- Key distribution: password manager / encrypted channel only. Never commit
  it, never put it in `.env`, never paste it into an issue or chat that
  GitHub can see.
- Adding teammates later: either share the symmetric key, or switch to
  git-crypt GPG mode (`git-crypt add-gpg-user`) for per-person revocable
  access.
- `dashboard/`, `src-go/` sub-builds: nothing changes; they read plaintext
  from the unlocked working tree.

---

## Residual risks (what this does NOT protect against — be honest)

| Risk | Status |
|---|---|
| File **contents** in repo/history | Encrypted (AES) — protected |
| File names, paths, sizes, commit count | **Visible.** Mitigated by generic repo name; accept or use tarball variant |
| Workflow YAMLs | **Public.** Mitigated by moving logic into encrypted scripts |
| Actions run logs | **Public.** Mitigated by Phase 3.2 + 1-day retention; one bad `echo` still leaks — the tripwire doesn't catch log output |
| Anyone with write access to the repo | Can read `GIT_CRYPT_KEY` via a malicious workflow — keep collaborator list at zero, protect the PAT |
| GitHub itself / runner memory | Sees plaintext at runtime — unavoidable while running on GitHub-hosted runners |
| git-crypt deterministic encryption | Identical file versions produce identical ciphertext (reveals reverts/duplicates) — acceptable here |
| Already-cloned copies of the old repo | Unfixable — handled by rotating every credential (Phase 0) |

**Fully-opaque alternative (only if filenames/structure must also be hidden):**
public repo contains only `.github/workflows/` + a single `code.tar.age`
encrypted with [age]; CI decrypts the tarball and runs; real development
happens in a private repo or locally. Worse DX (no per-file history on
GitHub), only worth it if path names are themselves sensitive.

---

## Execution checklist (in order)

- [ ] 0.1 Flip old repo private (instant, reversible)
- [ ] 0.2 Rotate: Google session, Discord token, R2 keys, tunnel tokens, PAT
- [ ] 0.3 Update `ENV_FILE` / `CREDS_JSON` secrets with rotated values
- [ ] 1.x git-crypt init, export key → password manager, `.gitattributes`,
        untrack cookies file, `git-crypt status` clean
- [ ] 3.x Rewrite both workflows: unlock step, output→file, masks, generic
        step names, tripwire step; move logic into encrypted scripts
- [ ] 2.x Create new private repo, add 4 secrets, settings hardening
- [ ] 4.1 Bundle-archive old history locally
- [ ] 4.2 Fresh `git init` + single commit + push to new repo
- [ ] 4.3 Verify encryption on github.com + one green Actions run, audit its log
- [ ] 4.4 Flip new repo public; confirm free-runner usage; re-enable cron
- [ ] 4.5 Delete old repo
- [ ] 5.x Re-clone on dev machines + unlock; store key backup offline
