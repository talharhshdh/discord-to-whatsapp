/**
 * @file browser-pool.ts
 * @description In-memory pool manager for remote browser instances.
 *
 * Remote browser workers (GitHub Actions jobs) register themselves via webhook,
 * send heartbeats every 60 s, and deregister on shutdown.  This module tracks
 * their lifecycle, prunes stale/dead entries, and provides round-robin selection
 * for distributed search.
 */

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

// ---------------------------------------------------------------------------
// Per-worker puppeteer connection + page pool cache
// ---------------------------------------------------------------------------

interface WorkerConnection {
  browserConn: any;
  wsUrl: string;
  /** Pages available for re-use (idle). */
  freePages: any[];
  /** Pages currently in use. */
  busyPages: Set<any>;
}

/** Keyed by workerId. Populated lazily on first use, invalidated on error. */
const workerConnections = new Map<string, WorkerConnection>();

/** Max idle pages kept alive per worker. Extra pages are closed. */
const MAX_IDLE_PAGES = 3;

/** Per-worker consecutive CDP_UNREACHABLE counter. Reset on success or reconnect. */
const workerCdpFailures = new Map<string, number>();

/** After this many consecutive CDP failures a worker is evicted from the pool immediately. */
const MAX_WORKER_CDP_FAILURES = 3;

/**
 * Return a ready page from the worker's pool.
 * Creates a new puppeteer connection + page if none cached yet.
 * Throws on failure so the caller can retry with the next worker.
 */
async function acquirePage(browser: RemoteBrowser): Promise<{ conn: WorkerConnection; page: any }> {
  const puppeteer = require('puppeteer-core');

  let conn = workerConnections.get(browser.workerId);

  // Validate existing connection is still alive
  if (conn) {
    try {
      // Lightweight liveness check
      await conn.browserConn.version();
    } catch {
      // Connection is dead — clean up and reconnect
      console.warn(`⚠️ Stale puppeteer connection for ${browser.workerId}, reconnecting...`);
      try { conn.browserConn.disconnect(); } catch { /* ignore */ }
      workerConnections.delete(browser.workerId);
      conn = undefined;
    }
  }

  // Establish connection if not cached
  if (!conn) {
    const versionResp = await fetch(`${browser.cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!versionResp.ok) throw new Error('CDP_UNREACHABLE');
    const versionInfo = await versionResp.json() as { webSocketDebuggerUrl?: string };
    const rawWsUrl = versionInfo.webSocketDebuggerUrl;
    if (!rawWsUrl) throw new Error('NO_WS_URL');

    const tunnelHost = new URL(browser.cdpUrl).host;
    const wsUrl = rawWsUrl.replace(/^ws:\/\/[^/]+/, `wss://${tunnelHost}`);

    const browserConn = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    conn = { browserConn, wsUrl, freePages: [], busyPages: new Set() };
    workerConnections.set(browser.workerId, conn);
    console.log(`🔗 New puppeteer connection cached for ${browser.workerId}`);
  }

  // Re-use idle page or open a new one
  let page = conn.freePages.pop();
  if (!page) {
    page = await conn.browserConn.newPage();

    // One-time page setup — only runs when a NEW page is created
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const rt = req.resourceType();
      const url = req.url().toLowerCase();
      if (
        ['image', 'font', 'media', 'stylesheet'].includes(rt) ||
        url.includes('google-analytics.com') ||
        url.includes('doubleclick.net')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 800 });
  }

  conn.busyPages.add(page);
  return { conn, page };
}

/**
 * Return a page back to the idle pool (or close it if pool is full).
 * Always call this in a finally block.
 */
async function releasePage(conn: WorkerConnection, page: any, discard = false): Promise<void> {
  conn.busyPages.delete(page);
  if (discard || conn.freePages.length >= MAX_IDLE_PAGES) {
    try { await page.close(); } catch { /* ignore */ }
  } else {
    conn.freePages.push(page);
  }
}

/** Invalidate and disconnect a cached worker connection (called on fatal errors). */
function invalidateWorkerConnection(workerId: string): void {
  const conn = workerConnections.get(workerId);
  if (!conn) return;
  workerConnections.delete(workerId);
  // Close all pages gracefully
  for (const p of [...conn.freePages, ...conn.busyPages]) {
    try { p.close(); } catch { /* ignore */ }
  }
  try { conn.browserConn.disconnect(); } catch { /* ignore */ }
  console.log(`🗑️ Invalidated puppeteer connection for ${workerId}`);
}

class BrowserPool {
  private browsers = new Map<string, RemoteBrowser>();
  private roundRobinIndex = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Register a new remote browser (or update existing — idempotent upsert). */
  register(workerId: string, cdpUrl: string): void {
    const now = Date.now();
    const existing = this.browsers.get(workerId);
    if (existing) {
      // Upsert: update URL and reset heartbeat
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
    return Array.from(this.browsers.values()).filter(b => b.status === 'active');
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
  private failureTimestamps: number[] = [];
  private lastRestartTime = 0;
  private readonly RESTART_COOLDOWN_MS = 2 * 60 * 1000; // 2 min cooldown (reduced from 5)

  /** Start the periodic cleanup loop (call once at server startup). */
  startCleanupLoop(): void {
    if (this.cleanupTimer) return; // already running
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is still running
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

  /** Record a failure and check if restart is needed. */
  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    
    // Cleanup old timestamps (> 1 min)
    this.failureTimestamps = this.failureTimestamps.filter(t => now - t < 60000);

    if (this.failureTimestamps.length >= 20) {
      console.error(`🚨 ERROR LIMIT REACHED: ${this.failureTimestamps.length} failures in last minute.`);
      this.failureTimestamps = []; // Reset after trigger
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
      // Trigger spawn-browsers event
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'spawn-browsers',
        }),
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

  /** Single cleanup pass. */
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
// Distributed search helper
// ---------------------------------------------------------------------------

/**
 * Execute a Google search via a remote browser from the pool.
 *
 * The flow mirrors the existing CDP search in dashboard-server.ts (lines 714-791)
 * but connects to a remote Chrome instance exposed through a cloudflared tunnel
 * instead of a local Docker container.
 *
 * The cloudflared tunnel proxies HTTP/WS traffic to Chrome's CDP port (9222).
 * We fetch `/json/version` from the tunnel URL to discover the WebSocket
 * debugger URL, rewrite the host to point at the tunnel, then connect
 * puppeteer-core over `wss://`.
 */
export async function searchViaPool(
  text: string,
  pageNumber: number = 1,
): Promise<{ organic: Array<{ title: string; link: string; snippet: string }>; aiResponse: string | null } | null> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      // Acquire a cached (or newly created) puppeteer connection + reused page
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      const startParam = (pageNumber - 1) * 10;
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10`,
        { waitUntil: 'domcontentloaded', timeout: 20_000 },
      );

      // Wait for actual results OR captcha — whichever appears first (max 4s)
      await Promise.race([
        page.waitForSelector('#search .g, #rso .g, .MjjYud .g, form[action="/sorry/index"]', { timeout: 4_000 }),
        new Promise(r => setTimeout(r, 4_000)),
      ]).catch(() => { /* ignore timeout */ });

      // Captcha Check
      const isCaptcha = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );

      if (isCaptcha) {
        console.warn(`⚠️ Captcha detected on pool browser ${browser.workerId}`);
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      // Click "Show more" buttons to expand AI overview (fire-and-forget, no sleep)
      page.evaluate(() => {
        const btns = document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe');
        btns.forEach((b: Element) => (b as HTMLElement).click());
      }).catch(() => { /* ignore */ });

      // Extract results
      const results = await page.evaluate(() => {
        const organic: Array<{ title: string; link: string; snippet: string }> = [];
        let aiResponse: string | null = null;
        const seen = new Set<string>();

        // AI overview
        const aiSelectors = ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk'];
        for (const sel of aiSelectors) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).innerText?.trim().length > 20) {
            aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
            break;
          }
        }

        // Organic results
        document.querySelectorAll('#search .g, #rso .g, .MjjYud .g').forEach(el => {
          const h3 = el.querySelector('h3');
          const a = el.querySelector('a[href^="http"]');
          if (!h3 || !a) return;
          const link = a.getAttribute('href') || '';
          if (seen.has(link)) return;
          seen.add(link);
          let snippet = '';
          for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec']) {
            const sn = el.querySelector(s);
            if (sn && (sn as HTMLElement).innerText) { snippet = (sn as HTMLElement).innerText.trim(); break; }
          }
          organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet });
        });

        // Fallback
        if (organic.length === 0) {
          document.querySelectorAll('a[href^="http"]').forEach(a => {
            const h3 = a.querySelector('h3');
            if (!h3) return;
            const link = a.getAttribute('href') || '';
            if (link.includes('google.com') || seen.has(link)) return;
            seen.add(link);
            organic.push({ title: (h3 as HTMLElement).innerText.trim(), link, snippet: '' });
          });
        }

        return { organic, aiResponse };
      });

      // ✅ Success — reset this worker's CDP failure counter
      workerCdpFailures.delete(browser.workerId);
      return results;

    } catch (e) {
      const msg = (e as Error).message;
      console.error(`❌ Pool search failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`, msg);
      browserPool.recordFailure();

      // Fatal CDP errors → track per-worker failures and evict fast
      if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some(k => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          // Worker is clearly dead — remove it from the pool immediately
          // instead of waiting 2 min for the heartbeat cleanup loop.
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

  // All attempts failed — if the pool is now empty, dispatch new workers immediately.
  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}
