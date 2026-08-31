"""
DriveStream Hub — Cloud & Browser Pool Python Worker Client
Reads configuration directly from the process environment (os.environ)
and enables any Python FastAPI service, SeleniumBase worker, or crawler
to stream files directly into encrypted Google Drive.
"""

import os
import sys
import json
import time
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
        # Read strictly from process environment (os.environ) or explicit parameter
        self.hub_url = (
            hub_url
            or os.getenv("DRIVE_WORKER_API_URL")
            or os.getenv("DRIVE_HUB_URL")
            or os.getenv("BASE_URL")
            or "http://localhost:3000"
        ).rstrip("/")

        self.pool_api_url = (
            pool_api_url
            or os.getenv("BROWSER_POOL_API_URL")
            or "https://services.ufone-claim.site/api/browsers/pool"
        )
        self.pool_auth = pool_auth or os.getenv("BROWSER_POOL_AUTH", "")
        self.pool_cookie = pool_cookie or os.getenv("BROWSER_POOL_COOKIE", "")
        self.ws_url = self.hub_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"

    def is_hub_online(self) -> bool:
        """Check if DriveStream Hub server is running and reachable."""
        try:
            res = requests.get(f"{self.hub_url}/api/stats", timeout=4)
            return res.status_code == 200 and res.json().get("success", False)
        except Exception:
            return False

    def get_browser_workers(self) -> List[Dict[str, Any]]:
        """
        Fetch active Cloudflared browser worker nodes from the pool using process environment credentials.
        """
        headers = {
            "accept": "*/*",
            "Referer": "https://services.ufone-claim.site/",
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
