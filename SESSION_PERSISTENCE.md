# Session Persistence to Cloudflare R2

## ✅ Implementation Complete

All session data including SSH terminals, browsers, VSCode, and their Cloudflare tunnel URLs are now automatically backed up to Cloudflare R2.

## 📦 What Gets Backed Up

### Session Data File
- **Location**: `auth_info/sessions.json`
- **Backed up to**: Cloudflare R2 (via GitHub Actions workflow)
- **Restored on**: Every workflow restart (every 5 hours)

### Session Information Stored
For each session, we store:
- `id` - Unique session identifier
- `type` - Session type (browser, terminal, vscode, android, custom-browser)
- `url` - Access URL (includes cloudflared URL when available)
- `username` - Login username (if applicable)
- `password` - Login password (if applicable)
- `startedAt` - Session creation timestamp
- `metadata`:
  - `port` - Local port number
  - `containerName` - Docker container name
  - `targetUrl` - Target URL (for custom browsers)
  - `cloudflaredUrl` - **Cloudflare tunnel URL** ✅

## 🔄 How It Works

### 1. Session Creation
When a new session is created (terminal, browser, VSCode, etc.):
1. Session is registered in `sessionManager`
2. Cloudflared tunnel URL is captured from stderr
3. Session metadata is updated with `cloudflaredUrl`
4. **Automatically saved to `auth_info/sessions.json`**

### 2. Backup to R2
Every 5 hours when the workflow completes:
```bash
tar -czf state.tar.gz \
  --exclude='Cache' \
  --exclude='*.sock' \
  --exclude='*/proot-apps/*' \
  # ... other exclusions ...
  $(pwd)/auth_info  # ← Includes sessions.json
```

The backup is uploaded to Cloudflare R2:
```bash
aws s3 cp state.tar.gz s3://${R2_BUCKET_NAME}/state.tar.gz \
  --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
```

### 3. Restoration on Startup
When the workflow starts:
1. Downloads `state.tar.gz` from R2
2. Extracts to `/` (restores `auth_info/sessions.json`)
3. `SessionManager` constructor automatically loads sessions from disk
4. All session data (credentials, URLs) is restored

## 📝 Updated Files

### Core Session Management
- ✅ `src/libs/session-manager.ts`
  - Added `cloudflaredUrl` to session metadata
  - Added `loadSessions()` - loads from disk on startup
  - Added `saveSessions()` - saves to disk on every change
  - Added `updateSessionMetadata()` - updates and persists metadata

### Service Libraries (Now Store Cloudflared URLs)
- ✅ `src/libs/terminal.ts` - Terminal sessions
- ✅ `src/libs/vscode.ts` - VSCode sessions
- ✅ `src/libs/ssh-terminal.ts` - SSH terminal sessions
- ✅ `src/libs/browser.ts` - Browser sessions

### Workflow Configuration
- ✅ `.github/workflows/run-bridge.yml`
  - Added comprehensive exclusions for system files
  - Backs up `auth_info/` (includes `sessions.json`)
  - Restores state from R2 on startup

## 🎯 Benefits

1. **No Lost Credentials**: All usernames/passwords persist across restarts
2. **Cloudflared URLs Preserved**: Tunnel URLs are saved and restored
3. **Seamless Continuity**: Sessions survive the 5-hour workflow restarts
4. **Automatic**: No manual intervention required
5. **Efficient**: Only session metadata is stored (not process handles)

## 🔍 Example Session Data

```json
[
  {
    "id": "terminal-a3f2b1c4",
    "type": "terminal",
    "url": "https://abc-123-def.trycloudflare.com",
    "username": "dev_a3f2b1",
    "password": "x7k9m2p5",
    "startedAt": "2026-05-05T10:30:00.000Z",
    "metadata": {
      "port": 8080,
      "cloudflaredUrl": "https://abc-123-def.trycloudflare.com"
    }
  },
  {
    "id": "vscode-d5e6f7g8",
    "type": "vscode",
    "url": "https://xyz-456-ghi.trycloudflare.com",
    "password": "q3w8e1r6",
    "startedAt": "2026-05-05T10:35:00.000Z",
    "metadata": {
      "port": 9080,
      "cloudflaredUrl": "https://xyz-456-ghi.trycloudflare.com"
    }
  }
]
```

## 🚀 Usage

No changes needed! Everything is automatic:

1. **Create a session**: `.terminal`, `.vscode`, `.browser`
2. **Session is saved**: Automatically to `auth_info/sessions.json`
3. **Workflow restarts**: Sessions are restored from R2
4. **Access preserved**: All URLs and credentials available

Use `.url` command in WhatsApp to see all active sessions with their cloudflared URLs!
