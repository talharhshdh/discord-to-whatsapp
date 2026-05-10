/**
 * @file browser-pool.ts
 * @description Optimized in-memory pool manager for remote browser instances.
 *
 * All Optimizations Integrated:
 *  - Per-worker async mutex (prevents duplicate connections under concurrent load)
 *  - LRU search-result cache with TTL (eliminates redundant browser round-trips)
 *  - In-flight request deduplication (stampede protection)
 *  - Circular-buffer failure tracker (O(1) alloc instead of O(n) filter)
 *  - Non-blocking page teardown
 *  - 🚀 Hedged Requests (Promise.any races 2 workers to eliminate tail latency)
 *  - 🔥 Pre-warming (Workers connect and prime DNS/TLS immediately on registration)
 *  - 🛑 Hyper-aggressive O(1) network blocking (ping, beacon, websocket + ad networks)
 *  - 🛡️ STRICT PARSING: Using original, untouched DOM parsing logic from v1.
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
  timestamp: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_TIMEOUT_MS = 2 * 60 * 1_000;   // 2 min  → mark stale
const DEAD_TIMEOUT_MS = 5 * 60 * 1_000;   // 5 min  → evict
const CLEANUP_INTERVAL_MS = 30 * 1_000;       // 30 s   cleanup pass
const MAX_IDLE_PAGES = 3;                // idle pages kept per worker
const MAX_WORKER_CDP_FAILURES = 3;                // consecutive CDP errors before eviction
const SEARCH_CACHE_TTL_MS = 60 * 1_000;       // Search result cache TTL
const SEARCH_CACHE_MAX_SIZE = 500;              // Max entries in LRU cache
const ACQUIRE_PAGE_TIMEOUT_MS = 15_000;           // Timeout for acquirePage path

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'ping', 'beacon', 'websocket']);
const BLOCKED_URL_FRAGMENTS = ['google-analytics.com', 'doubleclick.net', 'googlesyndication.com', 'adservice.google.com', 'play.google.com'];

// ---------------------------------------------------------------------------
// Tiny async mutex
// ---------------------------------------------------------------------------

class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryLock = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => {
            this.locked = false;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryLock);
        }
      };
      tryLock();
    });
  }
}

// ---------------------------------------------------------------------------
// LRU cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

class LRUCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();

  constructor(private readonly maxSize: number, private readonly ttlMs: number) { }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  invalidate(key: K): void {
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Circular-buffer failure tracker  (O(1) push + O(1) count-in-window)
// ---------------------------------------------------------------------------

class CircularFailureBuffer {
  private buf: number[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity).fill(0);
  }

  push(ts: number): void {
    this.buf[this.head] = ts;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  countInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.buf[i] > cutoff ? 1 : 0;
    return n;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// Per-worker puppeteer connection + page pool
// ---------------------------------------------------------------------------

interface WorkerConnection {
  browserConn: any;
  wsUrl: string;
  freePages: any[];
  busyPages: Set<any>;
}

const workerConnections = new Map<string, WorkerConnection>();
const workerMutexes = new Map<string, Mutex>();
const workerCdpFailures = new Map<string, number>();

function getWorkerMutex(workerId: string): Mutex {
  let m = workerMutexes.get(workerId);
  if (!m) { m = new Mutex(); workerMutexes.set(workerId, m); }
  return m;
}

async function acquirePage(browser: RemoteBrowser): Promise<{ conn: WorkerConnection; page: any }> {
  const puppeteer = require('puppeteer-core');
  const mutex = getWorkerMutex(browser.workerId);

  return withTimeout(ACQUIRE_PAGE_TIMEOUT_MS, async () => {
    const release = await mutex.acquire();
    try {
      let conn = workerConnections.get(browser.workerId);

      if (!conn) {
        const versionResp = await fetch(`${browser.cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!versionResp.ok) throw new Error('CDP_UNREACHABLE');

        const versionInfo = await versionResp.json() as { webSocketDebuggerUrl?: string };
        const rawWsUrl = versionInfo.webSocketDebuggerUrl;
        if (!rawWsUrl) throw new Error('NO_WS_URL');

        const tunnelHost = new URL(browser.cdpUrl).host;
        const wsUrl = rawWsUrl.replace(/^ws:\/\/[^/]+/, `wss://${tunnelHost}`);

        const browserConn = await Promise.race([
          puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null }),
          sleep(10_000).then(() => { throw new Error('CONNECT_TIMEOUT'); }),
        ]);

        conn = { browserConn, wsUrl, freePages: [], busyPages: new Set() };
        workerConnections.set(browser.workerId, conn);
        console.log(`🔗 New puppeteer connection cached for ${browser.workerId}`);
      }

      let page = conn.freePages.pop() ?? null;
      if (!page) {
        page = await conn.browserConn.newPage();
        await setupPage(page);
      }

      conn.busyPages.add(page);
      return { conn, page };
    } finally {
      release();
    }
  });
}

async function setupPage(page: any): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
    if (req.isInterceptResolutionHandled()) return;

    const rt: string = req.resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(rt)) { return req.abort('aborted'); }

    const url = req.url().toLowerCase();
    for (const frag of BLOCKED_URL_FRAGMENTS) {
      if (url.includes(frag)) { return req.abort('aborted'); }
    }

    req.continue();
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );
  await page.setViewport({ width: 1280, height: 800 });
}

function releasePage(conn: WorkerConnection, page: any, discard = false): void {
  conn.busyPages.delete(page);
  if (discard || conn.freePages.length >= MAX_IDLE_PAGES) {
    page.close().catch(() => { /* ignore */ });
  } else {
    conn.freePages.push(page);
  }
}

function invalidateWorkerConnection(workerId: string): void {
  const conn = workerConnections.get(workerId);
  if (!conn) return;
  workerConnections.delete(workerId);
  for (const p of [...conn.freePages, ...conn.busyPages]) {
    p.close().catch(() => { /* ignore */ });
  }
  try { conn.browserConn.disconnect(); } catch { /* ignore */ }
  console.log(`🗑️ Invalidated puppeteer connection for ${workerId}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    sleep(ms).then(() => { throw new Error('ACQUIRE_TIMEOUT'); }),
  ]);
}

// ---------------------------------------------------------------------------
// BrowserPool
// ---------------------------------------------------------------------------

class BrowserPool {
  private browsers = new Map<string, RemoteBrowser>();
  private rrIndex = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _activeCache: RemoteBrowser[] | null = null;

  private failureBuf = new CircularFailureBuffer(40);
  private lastRestartTime = 0;
  private readonly RESTART_COOLDOWN_MS = 2 * 60 * 1_000;

  private invalidateActiveCache(): void { this._activeCache = null; }

  private getActiveCache(): RemoteBrowser[] {
    if (!this._activeCache) {
      this._activeCache = [];
      for (const b of this.browsers.values()) {
        if (b.status === 'active') this._activeCache.push(b);
      }
    }
    return this._activeCache;
  }

  register(workerId: string, cdpUrl: string): void {
    const now = Date.now();
    const existing = this.browsers.get(workerId);
    if (existing) {
      existing.cdpUrl = cdpUrl;
      existing.lastHeartbeat = now;
      if (existing.status !== 'active') {
        existing.status = 'active';
        this.invalidateActiveCache();
        console.log(`🔄 Browser worker re-registered: ${workerId} → ${cdpUrl}`);
      }
    } else {
      this.browsers.set(workerId, {
        workerId, cdpUrl,
        registeredAt: now,
        lastHeartbeat: now,
        status: 'active',
      });
      this.invalidateActiveCache();
      console.log(`✅ Browser worker registered: ${workerId} → ${cdpUrl}  (pool size: ${this.browsers.size})`);

      // 🔥 Fire and forget pre-warming
      this.warmupWorker(this.browsers.get(workerId)!).catch(e =>
        console.warn(`⚠️ Failed to warm up ${workerId}:`, e.message)
      );
    }
  }

  private async warmupWorker(browser: RemoteBrowser) {
    try {
      const { conn, page } = await acquirePage(browser);
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => { });
      releasePage(conn, page);
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
      entry.status = 'active';
      this.invalidateActiveCache();
      console.log(`💚 Browser worker recovered from stale: ${workerId}`);
    }
    return true;
  }

  deregister(workerId: string): void {
    if (this.browsers.delete(workerId)) {
      this.invalidateActiveCache();
      invalidateWorkerConnection(workerId);
      workerMutexes.delete(workerId);
      console.log(`🗑️ Browser worker deregistered: ${workerId}  (pool size: ${this.browsers.size})`);
    }
  }

  getAll(): RemoteBrowser[] { return Array.from(this.browsers.values()); }
  getActive(): RemoteBrowser[] { return this.getActiveCache(); }

  getNext(): RemoteBrowser | null {
    const active = this.getActiveCache();
    if (active.length === 0) return null;
    this.rrIndex = this.rrIndex % active.length;
    const picked = active[this.rrIndex];
    this.rrIndex = (this.rrIndex + 1) % active.length;
    return picked;
  }

  get size(): number { return this.browsers.size; }

  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    (this.cleanupTimer as NodeJS.Timeout).unref?.();
  }

  stopCleanupLoop(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  private cleanup(): void {
    if (this.browsers.size === 0) return;
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of this.browsers) {
      const elapsed = now - entry.lastHeartbeat;
      if (elapsed > DEAD_TIMEOUT_MS) {
        this.browsers.delete(id);
        invalidateWorkerConnection(id);
        workerMutexes.delete(id);
        changed = true;
        console.log(`💀 Worker removed (dead, ${Math.round(elapsed / 1000)}s silent): ${id}`);
      } else if (elapsed > STALE_TIMEOUT_MS && entry.status === 'active') {
        entry.status = 'stale';
        changed = true;
        console.log(`⚠️ Worker stale (${Math.round(elapsed / 1000)}s since heartbeat): ${id}`);
      }
    }
    if (changed) this.invalidateActiveCache();
  }

  recordFailure(): void {
    this.failureBuf.push(Date.now());
    if (this.failureBuf.countInWindow(60_000) >= 20) {
      console.error('🚨 ERROR LIMIT REACHED: 20+ failures in last 60 s.');
      this.failureBuf.reset();
      this.restartWorkers().catch(() => { /* ignore */ });
    }
  }

  async restartWorkers(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRestartTime < this.RESTART_COOLDOWN_MS) return;
    this.lastRestartTime = now;

    const pat = process.env.GITHUB_PAT ?? process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPO ?? 'talharhshdh/discord-to-whatsapp';

    if (!pat) return console.error('❌ Cannot restart workers: GITHUB_PAT / PAT_TOKEN not set.');

    console.log(`🔄 Dispatching spawn-browsers to ${repo}…`);
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'spawn-browsers' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) console.log('✅ GitHub dispatch sent.');
    } catch (e) {
      console.error('❌ Error triggering GitHub dispatch:', e);
    }
  }
}

export const browserPool = new BrowserPool();

// ---------------------------------------------------------------------------
// Search result types & Cache Layer
// ---------------------------------------------------------------------------

export interface SearchResult {
  organic: Array<{ title: string; link: string; snippet: string }>;
  aiResponse: string | null;
}

const searchCache = new LRUCache<string, SearchResult>(SEARCH_CACHE_MAX_SIZE, SEARCH_CACHE_TTL_MS);
const inflightSearches = new Map<string, Promise<SearchResult | null>>();

function searchCacheKey(text: string, pageNumber: number): string { return `${pageNumber}:${text}`; }

// ---------------------------------------------------------------------------
// Distributed search — public API
// ---------------------------------------------------------------------------

export async function searchViaPool(text: string, pageNumber = 1): Promise<SearchResult | null> {
  const cacheKey = searchCacheKey(text, pageNumber);

  // 1. Cache hit (~0 ms)
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  // 2. Deduplicate in-flight requests (stampede protection)
  const existing = inflightSearches.get(cacheKey);
  if (existing) return existing;

  const promise = _doSearch(text, pageNumber, cacheKey);
  inflightSearches.set(cacheKey, promise);
  promise.finally(() => inflightSearches.delete(cacheKey));
  return promise;
}

/**
 * Executes Hedged Requests. Races up to 2 workers to completely eliminate tail-latency.
 */
async function _doSearch(text: string, pageNumber: number, cacheKey: string): Promise<SearchResult | null> {
  const active = browserPool.getActive();

  if (active.length === 0) {
    console.error('🚨 No active pool workers.');
    browserPool.restartWorkers().catch(() => { /* ignore */ });
    return null;
  }

  // 🚀 Race up to 2 workers concurrently
  const attempts = Math.min(2, active.length);
  const promises: Promise<SearchResult>[] = [];

  for (let i = 0; i < attempts; i++) {
    const browser = browserPool.getNext();
    if (browser) promises.push(_executeSearchOnWorker(browser, text, pageNumber));
  }

  try {
    const result = await Promise.any(promises);
    searchCache.set(cacheKey, result);
    return result;
  } catch (aggregateError) {
    console.error(`❌ All hedged attempts failed for query: "${text}"`);
    if (browserPool.getActive().length === 0) {
      browserPool.restartWorkers().catch(() => { /* ignore */ });
    }
    return null;
  }
}

/**
 * Inner logic isolated to throw cleanly for Promise.any consumption
 */
async function _executeSearchOnWorker(browser: RemoteBrowser, text: string, pageNumber: number): Promise<SearchResult> {
  let conn: WorkerConnection | null = null;
  let page: any = null;
  let pageErrored = false;

  const startParam = (pageNumber - 1) * 10;
  const url = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10`;

  try {
    const acquired = await acquirePage(browser);
    conn = acquired.conn;
    page = acquired.page;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    await page.waitForSelector('#search .g, #rso .g, .MjjYud .g, form[action="/sorry/index"]', { timeout: 5_000 })
      .catch(() => { /* ok — evaluate handles it */ });

    // 🛡️ ORIGINAL, UNTOUCHED PARSING LOGIC 🛡️
    const results = await page.evaluate(() => {
      // Captcha guard
      if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
        return { captcha: true, organic: [], aiResponse: null };
      }

      // Expand AI overview (no sleep needed — we're already past DOMContentLoaded)
      document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
        .forEach((b) => (b as HTMLElement).click());

      const organic: Array<{ title: string; link: string; snippet: string }> = [];
      let aiResponse: string | null = null;
      const seen = new Set<string>();

      // AI overview
      for (const sel of ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk']) {
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

      return { captcha: false, organic, aiResponse };
    });

    if (results.captcha) {
      console.warn(`⚠️ Captcha on ${browser.workerId}.`);
      pageErrored = true;
      throw new Error('CAPTCHA_DETECTED'); // Throw to trigger Promise.any fallback
    }

    workerCdpFailures.delete(browser.workerId);
    return { organic: results.organic, aiResponse: results.aiResponse };

  } catch (e) {
    const msg = (e as Error).message ?? '';
    browserPool.recordFailure();

    const isCdpFatal = ['CDP_UNREACHABLE', 'NO_WS_URL', 'CONNECT_TIMEOUT', 'ACQUIRE_TIMEOUT', 'Protocol error', 'WebSocket'].some(k => msg.includes(k));

    if (isCdpFatal) {
      invalidateWorkerConnection(browser.workerId);
      page = null;
      const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
      workerCdpFailures.set(browser.workerId, cdpFails);
      if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
        console.warn(`🔥 Worker ${browser.workerId} evicted after ${cdpFails} failures.`);
        workerCdpFailures.delete(browser.workerId);
        browserPool.deregister(browser.workerId);
      }
    } else {
      pageErrored = true;
    }
    throw e; // Crucial for Promise.any to know this hedge failed
  } finally {
    if (conn && page) releasePage(conn, page, pageErrored);
  }
}