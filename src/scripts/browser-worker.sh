#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# browser-worker.sh — Remote browser worker for the distributed browser pool.
#
# Launched inside each GitHub Actions matrix job.  It:
#   1. Starts Chrome headless with CDP on :9222
#   2. Creates a cloudflared quick-tunnel exposing :9222
#   3. Registers the tunnel URL with the main dashboard
#   4. Sends heartbeats every 60 s
#   5. On shutdown sends a deregister event
#
# Required env vars:
#   DASHBOARD_DOMAIN  — domain of the main dashboard (e.g. )
#   WORKER_ID         — unique identifier for this worker (set by the workflow)
#
# Optional:
#   MAX_RUNTIME       — seconds to run (default: 18000 = 5 h)
#   HEARTBEAT_INTERVAL — seconds between heartbeats (default: 60)
# ---------------------------------------------------------------------------

set -euo pipefail

DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:?DASHBOARD_DOMAIN is required}"
WORKER_ID="${WORKER_ID:?WORKER_ID is required}"
MAX_RUNTIME="${MAX_RUNTIME:-18000}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-60}"

WEBHOOK_URL="https://${DASHBOARD_DOMAIN}/api/browsers/webhook"
CDP_PORT=9222
TUNNEL_URL=""
CHROME_PID=""
TUNNEL_PID=""

# ---------------------------------------------------------------------------
# Cleanup handler
# ---------------------------------------------------------------------------
cleanup() {
  # Best-effort deregister
  if [ -n "$TUNNEL_URL" ]; then
    for attempt in 1 2 3; do
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"event\":\"deregister\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
        2>/dev/null || echo "000")
      if [ "$HTTP_CODE" = "200" ]; then
        break
      fi
      sleep 3
    done
  fi

  # Kill child processes
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true

  exit 0
}
trap cleanup EXIT SIGTERM SIGINT

# ---------------------------------------------------------------------------
# 1. Start Chrome with CDP
# ---------------------------------------------------------------------------
echo "🚀 Starting Chrome headless with CDP on :${CDP_PORT}..."

# Chrome is already installed via setup-chrome action in the workflow.
# We need a user data dir so Chrome doesn't complain.
mkdir -p /tmp/chrome-user-data

google-chrome-stable \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=${CDP_PORT} \
  --remote-debugging-address=0.0.0.0 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/chrome-user-data \
  --disable-background-networking \
  --disable-extensions \
  --disable-sync \
  --no-first-run \
  --disable-default-apps \
  &

CHROME_PID=$!
echo "Chrome started (PID: $CHROME_PID)"

# Wait for CDP to become available
echo "⏳ Waiting for CDP to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "✅ CDP is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ CDP failed to start within 30 seconds"
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 2. Start cloudflared tunnel (with Host header rewrite for Chrome CDP)
# ---------------------------------------------------------------------------
echo "🌐 Starting cloudflared tunnel for CDP port ${CDP_PORT}..."

TUNNEL_LOG="/tmp/cloudflared-tunnel.log"
# The --http-host-header flag is CRITICAL. It rewrites the Host header from xxx.trycloudflare.com 
# to localhost. Without this, Chrome rejects the CDP request with a 500 error for security reasons.
cloudflared tunnel --url "http://127.0.0.1:${CDP_PORT}" --http-host-header "localhost" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL to appear in logs
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  if [ $i -eq 30 ]; then
    exit 1
  fi
  sleep 1
done

# Pre-warm: open google.com so DNS + TCP are warm for the first real request
echo "🔥 Pre-warming browser on google.com..."
curl -s "http://127.0.0.1:${CDP_PORT}/json/new?https://www.google.com" > /dev/null || true

# ---------------------------------------------------------------------------
# 3. Register with main dashboard
# ---------------------------------------------------------------------------
echo "📡 Registering with dashboard at ..."

REGISTERED=false
for attempt in $(seq 1 20); do
  HTTP_CODE=$(curl -s -o /tmp/register-resp.txt -w "%{http_code}" --max-time 15 \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"register\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    REGISTERED=true
    break
  fi

  # Exponential backoff: 5, 10, 20, 40, 60, 60, ...
  BACKOFF=$(( 5 * (2 ** (attempt - 1)) ))
  [ $BACKOFF -gt 60 ] && BACKOFF=60
  sleep "$BACKOFF"
done

if [ "$REGISTERED" != "true" ]; then
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Heartbeat loop
# ---------------------------------------------------------------------------
echo "💓 Starting heartbeat loop (every ${HEARTBEAT_INTERVAL}s, max runtime ${MAX_RUNTIME}s)..."

START_TIME=$(date +%s)
CONSECUTIVE_FAILURES=0
MAX_CONSECUTIVE_FAILURES=10

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -ge $MAX_RUNTIME ]; then
    break
  fi

  # Check Chrome is still alive
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    break
  fi

  # Check tunnel is still alive
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    break
  fi

  sleep "$HEARTBEAT_INTERVAL"

  # Send heartbeat
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"heartbeat\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    CONSECUTIVE_FAILURES=0
  elif [ "$HTTP_CODE" = "404" ]; then
    # Dashboard doesn't know us — re-register
    curl -s -o /dev/null --max-time 15 \
      -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"register\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      2>/dev/null || true
    CONSECUTIVE_FAILURES=0
  else
    CONSECUTIVE_FAILURES=$(( CONSECUTIVE_FAILURES + 1 ))
    if [ $CONSECUTIVE_FAILURES -ge $MAX_CONSECUTIVE_FAILURES ]; then
      break
    fi
  fi
done

# Cleanup is handled by the trap
