/**
 * @file browser-pool.ts
 * @description In-memory pool manager for remote browser instances.
 * Optimized for maximum throughput and minimal latency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteBrowser {
  workerId: string;
  cdpUrl: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'active' | 'stale' | 'dead';
}

export type WebhookEvent = 'register' | 'heartbeat' | 'deregister';

export interface WebhookPayload {
  event: WebhookEvent;
  workerId: string;
  cdpUrl: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_TIMEOUT_MS = 2 * 60 * 1000;
const DEAD_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
const MAX_IDLE_PAGES = 3;
const MAX_WORKER_CDP_FAILURES = 3;

// ---------------------------------------------------------------------------
// Per-worker puppeteer connection + page pool cache
// ---------------------------------------------------------------------------

interface WorkerConnection {
  browserConn: any;
  wsUrl: string;
  freePages: any[];
  busyPages: Set<any>;
}

const workerConnections = new Map<string, WorkerConnection>();
const workerCdpFailures = new Map<string, number>();

/**
 * Return a ready page from the worker's pool.
 */
async function acquirePage(browser: RemoteBrowser): Promise<{ conn: WorkerConnection; page: any }> {
  const puppeteer = require('puppeteer-core');
  let conn = workerConnections.get(browser.workerId);

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

  let page = conn.freePages.pop();
  if (!page) {
    page = await conn.browserConn.newPage();

    // OPTIMIZATION 4: Uncomment this line to DISABLE JS if you don't need the AI overview.
    // Drops search times from ~3000ms to ~300ms by preventing Google's SPA from loading.
    // await page.setJavaScriptEnabled(false); 

    // OPTIMIZATION 3: Hyper-aggressive network interception
    const BLOCKED_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'ping', 'beacon', 'websocket']);
    const BLOCKED_DOMAINS = ['google-analytics.com', 'doubleclick.net', 'googlesyndication.com', 'adservice.google.com', 'play.google.com'];

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (req.isInterceptResolutionHandled()) return;
      const rt = req.resourceType();
      const url = req.url().toLowerCase();

      if (BLOCKED_TYPES.has(rt) || BLOCKED_DOMAINS.some(d => url.includes(d))) {
        return req.abort('aborted');
      }
      req.continue();
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 800 });
  }

  conn.busyPages.add(page);
  return { conn, page };
}

async function releasePage(conn: WorkerConnection, page: any, discard = false): Promise<void> {
  conn.busyPages.delete(page);
  if (discard || conn.freePages.length >= MAX_IDLE_PAGES) {
    try { await page.close(); } catch { /* ignore */ }
  } else {
    conn.freePages.push(page);
  }
}

function invalidateWorkerConnection(workerId: string): void {
  const conn = workerConnections.get(workerId);
  if (!conn) return;
  workerConnections.delete(workerId);
  for (const p of [...conn.freePages, ...conn.busyPages]) {
    try { p.close(); } catch { /* ignore */ }
  }
  try { conn.browserConn.disconnect(); } catch { /* ignore */ }
  console.log(`🗑️ Invalidated puppeteer connection for ${workerId}`);
}

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

  register(workerId: string, cdpUrl: string): void {
    const now = Date.now();
    const existing = this.browsers.get(workerId);
    if (existing) {
      existing.cdpUrl = cdpUrl;
      existing.lastHeartbeat = now;
      existing.status = 'active';
      console.log(`🔄 Browser worker re-registered: ${workerId}`);
    } else {
      this.browsers.set(workerId, {
        workerId,
        cdpUrl,
        registeredAt: now,
        lastHeartbeat: now,
        status: 'active',
      });
      console.log(`✅ Browser worker registered: ${workerId}`);
      
      // OPTIMIZATION 1: Fire and forget pre-warming
      this.warmupWorker(this.browsers.get(workerId)!).catch(e => 
        console.error(`⚠️ Failed to warm up ${workerId}:`, e.message)
      );
    }
  }

  private async warmupWorker(browser: RemoteBrowser) {
    try {
      const { conn, page } = await acquirePage(browser);
      // Prime the DNS/TLS connection to Google
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await releasePage(conn, page);
      console.log(`🔥 Worker ${browser.workerId} is pre-warmed and ready.`);
    } catch (error) {
       console.warn(`Warmup failed for ${browser.workerId}`);
    }
  }

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

  deregister(workerId: string): void {
    const existed = this.browsers.delete(workerId);
    if (existed) {
      invalidateWorkerConnection(workerId);
      console.log(`🗑️ Browser worker deregistered: ${workerId}`);
    }
  }

  getAll(): RemoteBrowser[] { return Array.from(this.browsers.values()); }
  getActive(): RemoteBrowser[] { return Array.from(this.browsers.values()).filter(b => b.status === 'active'); }

  getNext(): RemoteBrowser | null {
    const active = this.getActive();
    if (active.length === 0) return null;
    this.roundRobinIndex = this.roundRobinIndex % active.length;
    const picked = active[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % active.length;
    return picked;
  }

  get size(): number { return this.browsers.size; }

  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter(t => now - t < 60000);

    if (this.failureTimestamps.length >= 20) {
      console.error(`🚨 ERROR LIMIT REACHED: ${this.failureTimestamps.length} failures in last minute.`);
      this.failureTimestamps = [];
      this.restartWorkers();
    }
  }

  async restartWorkers(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRestartTime < this.RESTART_COOLDOWN_MS) return;
    this.lastRestartTime = now;

    const pat = process.env.GITHUB_PAT || process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

    if (!pat) {
      console.error('❌ Cannot restart workers: GITHUB_PAT or PAT_TOKEN not found in env.');
      return;
    }

    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'spawn-browsers' }),
      });

      if (!resp.ok) console.error(`❌ Failed to send GitHub dispatch (HTTP ${resp.status})`);
    } catch (e) {
      console.error('❌ Error triggering GitHub dispatch:', e);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.browsers) {
      const elapsed = now - entry.lastHeartbeat;
      if (elapsed > DEAD_TIMEOUT_MS) {
        this.browsers.delete(id);
        invalidateWorkerConnection(id);
      } else if (elapsed > STALE_TIMEOUT_MS && entry.status === 'active') {
        entry.status = 'stale';
      }
    }
  }
}

export const browserPool = new BrowserPool();

// ---------------------------------------------------------------------------
// Distributed search helper
// ---------------------------------------------------------------------------

type SearchResult = { organic: Array<{ title: string; link: string; snippet: string }>; aiResponse: string | null };

/**
 * OPTIMIZATION 2: Hedged Requests
 * Races multiple workers concurrently to eliminate tail latency.
 */
export async function searchViaPool(text: string, pageNumber: number = 1): Promise<SearchResult | null> {
  const activeWorkers = browserPool.getActive();

  if (activeWorkers.length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
    return null;
  }

  // Race up to 2 workers to bypass slow/stuck nodes
  const attempts = Math.min(2, activeWorkers.length);
  const promises: Promise<SearchResult>[] = [];

  for (let i = 0; i < attempts; i++) {
    const browser = browserPool.getNext();
    if (browser) promises.push(executeSearchOnWorker(browser, text, pageNumber));
  }

  try {
    // Return the absolute fastest successful result
    return await Promise.any(promises);
  } catch (aggregateError) {
    console.error(`❌ All hedged attempts failed for query: "${text}"`);
    return null;
  }
}

/**
 * Inner worker execution logic isolated for Promise.any consumption
 */
async function executeSearchOnWorker(browser: RemoteBrowser, text: string, pageNumber: number): Promise<SearchResult> {
  let conn: WorkerConnection | null = null;
  let page: any = null;
  let pageErrored = false;

  try {
    const acquired = await acquirePage(browser);
    conn = acquired.conn;
    page = acquired.page;

    const startParam = (pageNumber - 1) * 10;

    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10`,
      { waitUntil: 'domcontentloaded', timeout: 20_000 },
    );

    await page.waitForSelector(
      '#search .g, #rso .g, .MjjYud .g, form[action="/sorry/index"]',
      { timeout: 5_000 },
    ).catch(() => {});

    const results = await page.evaluate(() => {
      if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
        return { captcha: true, organic: [], aiResponse: null };
      }

      document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
        .forEach((b) => (b as HTMLElement).click());

      const organic: Array<{ title: string; link: string; snippet: string }> = [];
      let aiResponse: string | null = null;
      const seen = new Set<string>();

      for (const sel of ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk']) {
        const el = document.querySelector(sel);
        if (el && (el as HTMLElement).innerText?.trim().length > 20) {
          aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
          break;
        }
      }

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

      return { captcha: false, organic, aiResponse };
    });

    if (results.captcha) {
      console.warn(`⚠️ Captcha detected on pool browser ${browser.workerId}`);
      pageErrored = true;
      throw new Error('CAPTCHA_DETECTED');
    }

    workerCdpFailures.delete(browser.workerId);
    return { organic: results.organic, aiResponse: results.aiResponse };

  } catch (e) {
    const msg = (e as Error).message;
    browserPool.recordFailure();

    if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some(k => msg.includes(k))) {
      invalidateWorkerConnection(browser.workerId);
      page = null; // Prevent releasePage from trying to close it
      
      const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
      workerCdpFailures.set(browser.workerId, cdpFails);

      if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
        console.warn(`🔥 Worker ${browser.workerId} hit ${cdpFails} CDP failures — evicting.`);
        workerCdpFailures.delete(browser.workerId);
        browserPool.deregister(browser.workerId);
      }
    } else {
      pageErrored = true;
    }
    
    // Throwing ensures Promise.any knows this specific attempt failed
    throw e;
    
  } finally {
    if (conn && page) {
      await releasePage(conn, page, pageErrored);
    }
  }
}