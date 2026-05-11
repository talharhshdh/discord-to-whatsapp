/**
 * @file page-pool.ts
 * @description Per-worker puppeteer connection + page pool.
 *
 * Manages lazy-initialised, reused puppeteer connections and idle page pools
 * keyed by workerId.  Extracted from browser-pool.ts to keep concerns separate.
 */

import type { RemoteBrowser } from './browser-pool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerConnection {
  browserConn: any;
  wsUrl: string;
  /** Pages available for re-use (idle). */
  freePages: any[];
  /** Pages currently in use. */
  busyPages: Set<any>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Keyed by workerId. Populated lazily on first use, invalidated on error. */
const workerConnections = new Map<string, WorkerConnection>();

/** Per-worker consecutive CDP_UNREACHABLE counter. Reset on success or reconnect. */
export const workerCdpFailures = new Map<string, number>();

/** Max idle pages kept alive per worker. Extra pages are closed. */
const MAX_IDLE_PAGES = 3;

/** After this many consecutive CDP failures a worker is evicted. */
export const MAX_WORKER_CDP_FAILURES = 3;

// ---------------------------------------------------------------------------
// Page acquisition / release
// ---------------------------------------------------------------------------

/**
 * Return a ready page from the worker's pool.
 * Creates a new puppeteer connection + page if none cached yet.
 * Throws on failure so the caller can retry with the next worker.
 */
export async function acquirePage(
  browser: RemoteBrowser,
): Promise<{ conn: WorkerConnection; page: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core');

  let conn = workerConnections.get(browser.workerId);

  if (!conn) {
    const versionResp = await fetch(`${browser.cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!versionResp.ok) throw new Error('CDP_UNREACHABLE');
    const versionInfo = (await versionResp.json()) as {
      webSocketDebuggerUrl?: string;
    };
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

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const rt = req.resourceType();
      const u = req.url().toLowerCase();
      if (
        ['image', 'font', 'media', 'stylesheet'].includes(rt) ||
        u.includes('google-analytics.com') ||
        u.includes('doubleclick.net')
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
 * Return a page back to the idle pool (or close it if the pool is full).
 * Always call this in a finally block.
 */
export async function releasePage(
  conn: WorkerConnection,
  page: any,
  discard = false,
): Promise<void> {
  conn.busyPages.delete(page);
  if (discard || conn.freePages.length >= MAX_IDLE_PAGES) {
    try {
      await page.close();
    } catch {
      /* ignore */
    }
  } else {
    conn.freePages.push(page);
  }
}

/** Invalidate and disconnect a cached worker connection (called on fatal errors). */
export function invalidateWorkerConnection(workerId: string): void {
  const conn = workerConnections.get(workerId);
  if (!conn) return;
  workerConnections.delete(workerId);
  for (const p of [...conn.freePages, ...conn.busyPages]) {
    try {
      p.close().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  try {
    const res = conn.browserConn.disconnect();
    if (res && res.catch) res.catch(() => {});
  } catch {
    /* ignore */
  }
  console.log(`🗑️ Invalidated puppeteer connection for ${workerId}`);
}
