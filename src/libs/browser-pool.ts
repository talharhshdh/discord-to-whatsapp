/**
 * @file browser-pool.ts
 * @description In-memory pool manager for remote browser instances.
 *
 * Remote browser workers (GitHub Actions jobs) register themselves via webhook,
 * send heartbeats every 60 s, and deregister on shutdown.  This module tracks
 * their lifecycle, prunes stale/dead entries, and provides round-robin selection
 * for distributed search.
 *
 * Page-pool / puppeteer connection management lives in page-pool.ts.
 */

import {
  acquirePage,
  releasePage,
  invalidateWorkerConnection,
  workerCdpFailures,
  MAX_WORKER_CDP_FAILURES,
} from './page-pool';
import type { WorkerConnection } from './page-pool';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteBrowser {
  workerId: string;
  cdpUrl: string;          // https://xxx.trycloudflare.com  (proxies CDP :9222)
  registeredAt: number;    // Date.now() ms
  lastHeartbeat: number;   // Date.now() ms — updated on every heartbeat
  status: 'active' | 'stale' | 'dead';
}

export type WebhookEvent = 'register' | 'heartbeat' | 'deregister';

export interface WebhookPayload {
  event: WebhookEvent;
  workerId: string;
  cdpUrl: string;
  timestamp: string;       // ISO-8601
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If no heartbeat for 2 min → mark stale (skip for new search requests). */
const STALE_TIMEOUT_MS = 2 * 60 * 1000;

/** If no heartbeat for 5 min → remove entirely. */
const DEAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Background cleanup interval. */
const CLEANUP_INTERVAL_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// BrowserPool
// ---------------------------------------------------------------------------

class BrowserPool {
  private browsers = new Map<string, RemoteBrowser>();
  private roundRobinIndex = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private failureTimestamps: number[] = [];
  private lastRestartTime = 0;
  private readonly RESTART_COOLDOWN_MS = 2 * 60 * 1000;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Register a new remote browser (or update existing — idempotent upsert). */
  register(workerId: string, cdpUrl: string): void {
    const now = Date.now();
    const existing = this.browsers.get(workerId);
    if (existing) {
      existing.cdpUrl = cdpUrl;
      existing.lastHeartbeat = now;
      existing.status = 'active';
      console.log(`🔄 Browser worker re-registered: ${workerId} → ${cdpUrl}`);
    } else {
      this.browsers.set(workerId, {
        workerId,
        cdpUrl,
        registeredAt: now,
        lastHeartbeat: now,
        status: 'active',
      });
      console.log(`✅ Browser worker registered: ${workerId} → ${cdpUrl}  (pool size: ${this.browsers.size})`);
    }
  }

  /** Update heartbeat timestamp for a known worker. Returns false if unknown. */
  heartbeat(workerId: string): boolean {
    const entry = this.browsers.get(workerId);
    if (!entry) return false;
    entry.lastHeartbeat = Date.now();
    if (entry.status !== 'active') {
      console.log(`💚 Browser worker recovered from stale: ${workerId}`);
    }
    entry.status = 'active';
    return true;
  }

  /** Explicitly remove a worker. */
  deregister(workerId: string): void {
    const existed = this.browsers.delete(workerId);
    if (existed) {
      invalidateWorkerConnection(workerId);
      console.log(`🗑️ Browser worker deregistered: ${workerId}  (pool size: ${this.browsers.size})`);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Return all browsers (any status). */
  getAll(): RemoteBrowser[] {
    return Array.from(this.browsers.values());
  }

  /** Return only active browsers. */
  getActive(): RemoteBrowser[] {
    return Array.from(this.browsers.values()).filter((b) => b.status === 'active');
  }

  /** Round-robin pick from active browsers. Returns null if none available. */
  getNext(): RemoteBrowser | null {
    const active = this.getActive();
    if (active.length === 0) return null;
    this.roundRobinIndex = this.roundRobinIndex % active.length;
    const picked = active[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % active.length;
    return picked;
  }

  /** Pool size (all statuses). */
  get size(): number {
    return this.browsers.size;
  }

  // ── Background cleanup ─────────────────────────────────────────────────

  /** Start the periodic cleanup loop (call once at server startup). */
  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the cleanup loop. */
  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Record a CAPTCHA / hard failure and trigger restart if threshold reached. */
  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t < 60_000);

    if (this.failureTimestamps.length >= 20) {
      console.error(`🚨 ERROR LIMIT REACHED: ${this.failureTimestamps.length} failures in last minute.`);
      this.failureTimestamps = [];
      this.restartWorkers();
    }
  }

  /** Trigger a restart of all browser workers via GitHub Actions. */
  async restartWorkers(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRestartTime < this.RESTART_COOLDOWN_MS) {
      console.log('⏭️ Restart skipped: Cooldown active.');
      return;
    }
    this.lastRestartTime = now;

    const pat = process.env.GITHUB_PAT || process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

    if (!pat) {
      console.error('❌ Cannot restart workers: GITHUB_PAT or PAT_TOKEN not found in env.');
      return;
    }

    console.log(`🔄 Restarting browser workers for ${repo}...`);

    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'spawn-browsers' }),
      });

      if (resp.ok) {
        console.log('✅ GitHub dispatch sent successfully!');
      } else {
        const error = await resp.text();
        console.error(`❌ Failed to send GitHub dispatch (HTTP ${resp.status}):`, error);
      }
    } catch (e) {
      console.error('❌ Error triggering GitHub dispatch:', e);
    }
  }

  // ── Internal cleanup pass ──────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.browsers) {
      const elapsed = now - entry.lastHeartbeat;

      if (elapsed > DEAD_TIMEOUT_MS) {
        this.browsers.delete(id);
        invalidateWorkerConnection(id);
        console.log(`💀 Browser worker removed (dead — no heartbeat for ${Math.round(elapsed / 1000)}s): ${id}`);
      } else if (elapsed > STALE_TIMEOUT_MS && entry.status === 'active') {
        entry.status = 'stale';
        console.log(`⚠️ Browser worker marked stale (${Math.round(elapsed / 1000)}s since heartbeat): ${id}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const browserPool = new BrowserPool();

// ---------------------------------------------------------------------------
// Distributed Google search helper
// ---------------------------------------------------------------------------

/**
 * Execute a Google web search via a remote browser from the pool.
 *
 * The cloudflared tunnel proxies HTTP/WS traffic to Chrome's CDP port (9222).
 * We fetch `/json/version` to discover the WebSocket debugger URL, rewrite the
 * host to point at the tunnel, then connect puppeteer-core over `wss://`.
 */
export async function searchViaPool(
  text: string,
  pageNumber: number = 1,
  includeAI: boolean = false,
): Promise<{ organic: Array<{ title: string; link: string; snippet: string }>; aiResponse: string | null } | null> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;
   
      const startParam = (pageNumber - 1) * 10;

      await page.setUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
      );
      await page.setRequestInterception(true);
      page.removeAllListeners('request');
      const requestHandler = (req: any) => {
        if (req.isInterceptResolutionHandled()) return;
        const resourceType = req.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      };
      page.on('request', requestHandler);
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&gbv=1`,
        { waitUntil: 'domcontentloaded', timeout: 3_000 },
      );

      // await page.waitForTimeout(300);
     
      const results = await page.evaluate((fetchAI: boolean) => {
        if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
          return { captcha: true, organic: [], aiResponse: null };
        }

        if (fetchAI) {
          document
            .querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
            .forEach((b) => (b as HTMLElement).click());
        }

        const organic: Array<{ title: string; link: string; snippet: string }> = [];
        let aiResponse: string | null = null;
        const seen = new Set<string>();

        if (fetchAI) {
          for (const sel of [
            '.M8OgIe', '.LLtROe', '.IZ6rdc',
            '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk',
          ]) {
            const el = document.querySelector(sel);
            if (el && (el as HTMLElement).innerText?.trim().length > 20) {
              aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
              break;
            }
          }
        }

        document.querySelectorAll('#search .g, #rso .g, .MjjYud .g').forEach((el) => {
          const h3 = el.querySelector('h3');
          const a = el.querySelector('a[href^="http"]');
          if (!h3 || !a) return;
          const link = a.getAttribute('href') || '';
          if (seen.has(link)) return;
          seen.add(link);
          let snippet = '';
          for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec']) {
            const sn = el.querySelector(s);
            if (sn && (sn as HTMLElement).innerText) {
              snippet = (sn as HTMLElement).innerText.trim();
              break;
            }
          }
          organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet });
        });

        if (organic.length === 0) {
          document.querySelectorAll('a[href^="http"]').forEach((a) => {
            const h3 = a.querySelector('h3');
            if (!h3) return;
            const link = a.getAttribute('href') || '';
            if (link.includes('google.com') || seen.has(link)) return;
            seen.add(link);
            organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet: '' });
          });
        }

        return { captcha: false, organic, aiResponse };
      }, includeAI);

      if (results.captcha) {
        console.warn(`⚠️ Captcha detected on pool browser ${browser.workerId}`);
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);
      return { organic: results.organic, aiResponse: results.aiResponse };

    } catch (e) {
      const msg = (e as Error).message;
      console.error(`❌ Pool search failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`, msg);
      browserPool.recordFailure();

      if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some((k) => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          console.warn(`🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive CDP failures — evicting from pool.`);
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}
