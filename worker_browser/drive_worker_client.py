"""
DriveStream Hub — Cloud & Browser Pool Python Worker Client
Reads configuration directly from the process environment (os.environ):
- DASHBOARD_DOMAIN
- DASHBOARD_USERNAME & DASHBOARD_PASSWORD
- DRIVE_WORKER_API_URL / DRIVE_HUB_URL / BASE_URL
"""

import os
import sys
import json
import time
import base64
import requests
from typing import List, Optional, Dict, Any

# Force UTF-8 encoding on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


class DriveStreamClient:
    def __init__(
        self,
        hub_url: Optional[str] = None,
        pool_api_url: Optional[str] = None,
        pool_auth: Optional[str] = None,
        pool_cookie: Optional[str] = None,
    ):
        # 1. Resolve Hub URL from environment
        dashboard_domain = os.getenv("DASHBOARD_DOMAIN", "").strip()
        
        self.hub_url = (
            hub_url
            or os.getenv("DRIVE_WORKER_API_URL")
            or os.getenv("DRIVE_HUB_URL")
            or (f"https://{dashboard_domain}" if dashboard_domain else "")
            or os.getenv("BASE_URL")
            or ""
        ).rstrip("/")

        # 2. Resolve Browser Pool URL from DASHBOARD_DOMAIN or BROWSER_POOL_API_URL
        if pool_api_url:
            self.pool_api_url = pool_api_url
        elif os.getenv("BROWSER_POOL_API_URL"):
            self.pool_api_url = os.getenv("BROWSER_POOL_API_URL")
        elif dashboard_domain:
            self.pool_api_url = f"https://{dashboard_domain}/api/browsers/pool"
        else:
            self.pool_api_url = ""

        # 3. Resolve Basic Auth from DASHBOARD_USERNAME:DASHBOARD_PASSWORD or BROWSER_POOL_AUTH
        if pool_auth:
            self.pool_auth = pool_auth
        elif os.getenv("BROWSER_POOL_AUTH"):
            self.pool_auth = os.getenv("BROWSER_POOL_AUTH")
        elif os.getenv("DASHBOARD_USERNAME") and os.getenv("DASHBOARD_PASSWORD"):
            creds = f"{os.getenv('DASHBOARD_USERNAME')}:{os.getenv('DASHBOARD_PASSWORD')}"
            self.pool_auth = "Basic " + base64.b64encode(creds.encode("utf-8")).decode("utf-8")
        else:
            self.pool_auth = ""

        # 4. Resolve Cookie Token from Auth Header or BROWSER_POOL_COOKIE
        if pool_cookie:
            self.pool_cookie = pool_cookie
        elif os.getenv("BROWSER_POOL_COOKIE"):
            self.pool_cookie = os.getenv("BROWSER_POOL_COOKIE")
        elif self.pool_auth and self.pool_auth.startswith("Basic "):
            raw_b64 = self.pool_auth.split(" ", 1)[1]
            self.pool_cookie = f"dashboard_token={raw_b64}"
        else:
            self.pool_cookie = ""

        self.ws_url = (
            self.hub_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
            if self.hub_url
            else ""
        )

    def is_hub_online(self) -> bool:
        """Check if DriveStream Hub server is running and reachable."""
        if not self.hub_url:
            return False
        try:
            res = requests.get(f"{self.hub_url}/api/stats", timeout=4)
            return res.status_code == 200 and res.json().get("success", False)
        except Exception:
            return False

    def get_browser_workers(self) -> List[Dict[str, Any]]:
        """
        Fetch active Cloudflared browser worker nodes from the pool using environment credentials.
        """
        if not self.pool_api_url:
            print("[!] BROWSER_POOL_API_URL or DASHBOARD_DOMAIN not set in environment.")
            return []

        headers = {
            "accept": "*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        if self.pool_auth:
            headers["authorization"] = self.pool_auth
        if self.pool_cookie:
            headers["cookie"] = self.pool_cookie

        try:
            res = requests.get(self.pool_api_url, headers=headers, timeout=8)
            if res.status_code == 200:
                data = res.json()
                return [b for b in data.get("browsers", []) if b.get("status") == "active"]
            else:
                print(f"[!] Pool API returned status {res.status_code}: {res.text[:120]}")
        except Exception as e:
            print(f"[!] Failed to fetch browser pool from {self.pool_api_url}: {e}")
        return []

    def get_accounts(self) -> List[Dict[str, Any]]:
        """List all connected Google 5TB accounts from the hub."""
        res = requests.get(f"{self.hub_url}/api/accounts", timeout=6)
        res.raise_for_status()
        return res.json().get("accounts", [])

    def enqueue_job(
        self,
        url: str,
        file_name: Optional[str] = None,
        folder_id: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Enqueue a single streaming upload job into the Hub's persistent queue.
        """
        payload = {
            "url": url,
            "fileName": file_name,
            "folderId": folder_id,
            "accountId": account_id,
        }
        res = requests.post(f"{self.hub_url}/api/jobs", json=payload, timeout=10)
        res.raise_for_status()
        data = res.json()
        if not data.get("success"):
            raise RuntimeError(f"Hub error: {data.get('error')}")
        jobs = data.get("jobs", [])
        return jobs[0] if jobs else {}

    def enqueue_batch(
        self,
        urls: List[str],
        folder_id: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Enqueue a batch of download URLs.
        Hub streams them in parallel across high-speed worker pipelines.
        """
        clean_urls = [u.strip() for u in urls if u.strip()]
        if not clean_urls:
            return []

        payload = {
            "urls": clean_urls,
            "folderId": folder_id,
            "accountId": account_id,
        }
        res = requests.post(f"{self.hub_url}/api/jobs", json=payload, timeout=15)
        res.raise_for_status()
        data = res.json()
        if not data.get("success"):
            raise RuntimeError(f"Hub error: {data.get('error')}")
        return data.get("jobs", [])

    def get_job_status(self, job_id: str) -> Dict[str, Any]:
        """Fetch current status and progress of an upload job."""
        res = requests.get(f"{self.hub_url}/api/jobs?limit=100", timeout=6)
        res.raise_for_status()
        jobs = res.json().get("jobs", [])
        for j in jobs:
            if j.get("id") == job_id:
                return j
        raise KeyError(f"Job {job_id} not found.")

    def create_folder(
        self,
        name: str,
        parent_folder_id: Optional[str] = None,
        account_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new folder in Google Drive."""
        accounts = self.get_accounts()
        if not accounts:
            raise RuntimeError("No Google accounts connected in DriveStream Hub.")
        target_acc_id = account_id or accounts[0]["id"]

        payload = {"name": name, "parentFolderId": parent_folder_id}
        res = requests.post(f"{self.hub_url}/api/drive/{target_acc_id}/folder", json=payload, timeout=10)
        res.raise_for_status()
        return res.json().get("folder", {})


# Export singleton instance for easy import in FastAPI
drive_client = DriveStreamClient()


if __name__ == "__main__":
    client = DriveStreamClient()
    print("=" * 65)
    print("   ⚡ DriveStream Hub — Dynamic Environment Worker Client")
    print("=" * 65)
    print(f"[*] Hub URL        : {client.hub_url}")
    print(f"[*] Pool API URL   : {client.pool_api_url}")
    print(f"[*] Pool Auth Set  : {'YES' if client.pool_auth else 'NO'}")

    print("\n🔍 Fetching active Cloudflared Browser Workers from pool...")
    workers = client.get_browser_workers()
    print(f"[+] Found {len(workers)} active worker(s) in pool:")
    for w in workers:
        print(f"    - {w.get('workerId')}")
        print(f"      API : {w.get('apiUrl')}")
        print(f"      CDP : {w.get('cdpUrl')}")

    if client.is_hub_online():
        accounts = client.get_accounts()
        print(f"\n[+] Connected to Hub! Found {len(accounts)} Google Account(s):")
        for acc in accounts:
            print(f"    - {acc.get('email')} ({acc.get('freeGB')} GB Free of {acc.get('totalTB')} TB)")
    else:
        print(f"\n[!] Hub is not reachable at {client.hub_url}.")
