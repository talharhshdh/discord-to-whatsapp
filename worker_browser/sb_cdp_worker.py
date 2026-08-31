#!/usr/bin/env python3
"""
sb_cdp_worker.py — Persistent SeleniumBase UC Browser Worker.

Runs a dedicated, stealth Undetected Chrome (SeleniumBase UC Mode) browser with
Chrome DevTools Protocol (CDP) enabled on port 9223 (default SB_CDP_PORT).

Exposes:
  - CDP HTTP endpoints: http://127.0.0.1:9223/json/version, /json/list, etc.
  - CDP WebSocket endpoint for remote Puppeteer / Playwright / SeleniumBase connections.
"""

import os
import sys
import time
import signal
import urllib.request
import json
from seleniumbase import undetected

SB_CDP_PORT = int(os.environ.get("SB_CDP_PORT", "9223"))
SB_CDP_HOST = os.environ.get("SB_CDP_HOST", "0.0.0.0")
USER_DATA_DIR = os.environ.get("SB_USER_DATA_DIR", f"/tmp/sb-chrome-data-{SB_CDP_PORT}")

running = True

def handle_signal(signum, frame):
    global running
    print(f"[SB-CDP] Received signal {signum}, shutting down...")
    running = False

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

def is_cdp_ready(port=SB_CDP_PORT):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json/version", headers={"User-Agent": "HealthCheck"})
        with urllib.request.urlopen(req, timeout=2) as response:
            if response.status == 200:
                data = json.loads(response.read().decode())
                return "webSocketDebuggerUrl" in data or "Browser" in data
    except Exception:
        return False
    return False

def start_driver():
    print(f"[SB-CDP] Starting SeleniumBase UC browser on port {SB_CDP_PORT}...")
    os.makedirs(USER_DATA_DIR, exist_ok=True)

    options = undetected.ChromeOptions()
    options._remote_debugging_port = SB_CDP_PORT
    options.add_argument(f"--remote-debugging-port={SB_CDP_PORT}")
    options.add_argument(f"--remote-debugging-address={SB_CDP_HOST}")
    options.add_argument("--remote-allow-origins=*")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-sync")
    options.add_argument(f"--user-data-dir={USER_DATA_DIR}")

    # Determine display / headless mode
    # On Linux with Xvfb or DISPLAY set, headed UC mode provides maximum anti-bot stealth
    is_linux = sys.platform.startswith("linux")
    has_display = bool(os.environ.get("DISPLAY"))

    driver = undetected.Chrome(
        options=options,
        user_data_dir=USER_DATA_DIR,
        headless=False if (is_linux and has_display) else False,
        use_subprocess=True,
    )
    return driver

def main():
    global running
    print(f"🚀 [SB-CDP] SeleniumBase CDP Worker initializing on port {SB_CDP_PORT}...")

    driver = None
    try:
        driver = start_driver()
        print(f"✅ [SB-CDP] Driver process launched. Waiting for CDP readiness...")

        for attempt in range(30):
            if is_cdp_ready(SB_CDP_PORT):
                print(f"✅ [SB-CDP] Chrome DevTools Protocol is ACTIVE on port {SB_CDP_PORT}!")
                break
            time.sleep(1)
        else:
            print(f"⚠️ [SB-CDP] Warning: CDP did not report ready within 30s, but driver process is running.")

        # Keep alive loop with watchdog
        while running:
            time.sleep(5)
            # Watchdog check
            if not is_cdp_ready(SB_CDP_PORT):
                print(f"⚠️ [SB-CDP] CDP unresponsive on port {SB_CDP_PORT}! Restarting driver...")
                try:
                    if driver:
                        driver.quit()
                except Exception:
                    pass
                time.sleep(2)
                driver = start_driver()
                time.sleep(3)

    except Exception as e:
        print(f"❌ [SB-CDP] Error in worker: {e}", file=sys.stderr)
        raise
    finally:
        print(f"🧹 [SB-CDP] Cleaning up SeleniumBase driver...")
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        print(f"👋 [SB-CDP] Worker exited.")

if __name__ == "__main__":
    main()
