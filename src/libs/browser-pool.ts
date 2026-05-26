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
  warmupWorker,
  isWorkerCached,
} from './page-pool';
import type { WorkerConnection } from './page-pool';

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
    let browserEntry: RemoteBrowser;
    if (existing) {
      existing.cdpUrl = cdpUrl;
      existing.lastHeartbeat = now;
      existing.status = 'active';
      browserEntry = existing;
    } else {
      browserEntry = {
        workerId,
        cdpUrl,
        registeredAt: now,
        lastHeartbeat: now,
        status: 'active',
      };
      this.browsers.set(workerId, browserEntry);
    }

    // Eagerly connect to the browser and open an idle page for caching
    warmupWorker(browserEntry);
  }

  /** Update heartbeat timestamp for a known worker. Returns false if unknown. */
  heartbeat(workerId: string): boolean {
    const entry = this.browsers.get(workerId);
    if (!entry) return false;
    entry.lastHeartbeat = Date.now();
    entry.status = 'active';
    return true;
  }

  /** Explicitly remove a worker. */
  deregister(workerId: string): void {
    const existed = this.browsers.delete(workerId);
    if (existed) {
      invalidateWorkerConnection(workerId);
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
      return;
    }
    this.lastRestartTime = now;

    const pat = process.env.GITHUB_PAT || process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

    if (!pat) {
      return;
    }

    try {
      await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'spawn-browsers' }),
      });
    } catch (e) {
      // Error suppressed
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
      } else if (elapsed > STALE_TIMEOUT_MS && entry.status === 'active') {
        entry.status = 'stale';
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
  category: string = 'all',
): Promise<{
  organic: Array<{ title: string; link: string; snippet: string }>;
  aiResponse: string | null;
  featuredSnippet?: { title: string; link: string; snippet: string } | null;
  knowledgePanel?: {
    title: string;
    subtitle?: string;
    description?: string;
    sourceUrl?: string;
    attributes?: Array<{ label: string; value: string }>;
  } | null;
  peopleAlsoAsk?: Array<{ question: string; answer?: string; sourceTitle?: string; sourceUrl?: string }>;
  directAnswer?: { type: string; answer: string; details?: string } | null;
  news?: Array<{ title: string; source: string; time: string; link: string }>;
  videos?: Array<{ title: string; source: string; duration?: string; uploadedAt?: string; link: string }>;
  images?: Array<{ alt: string; sourceUrl: string; imageUrl?: string }>;
  shopping?: Array<{ title: string; price: string; merchant: string; rating?: string; link: string }>;
  relatedSearches?: string[];
  localResults?: Array<{ title: string; rating?: string; reviewsCount?: string; address?: string; phone?: string; link?: string }>;
} | null> {
  const normCategory = category.toLowerCase().trim();
  let categoryKey = 'all';
  if (normCategory === 'videos' || normCategory === 'video') {
    categoryKey = 'videos';
  } else if (normCategory === 'images' || normCategory === 'image') {
    categoryKey = 'images';
  } else if (normCategory === 'news') {
    categoryKey = 'news';
  } else if (normCategory === 'shopping' || normCategory === 'shop') {
    categoryKey = 'shopping';
  }

  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);
  const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    // If this browser isn't cached, but there are other cached browsers available, skip this one
    // and run a background warmup so it's ready for future requests.
    if (hasAnyCached && !isWorkerCached(browser.workerId)) {
      warmupWorker(browser);
      continue;
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      // ── Request interception: block heavy assets ───────────────────────
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        if (req.isInterceptResolutionHandled()) return;

        const type = req.resourceType();
        const url = req.url();

        // Never block the main document navigation
        if (type === 'document') {
          return req.continue();
        }

        // Block unnecessary resource types
        if (
          [
            'image',
            'media',
            'font',
            'stylesheet',
            'websocket',
            'manifest',
            'other',
          ].includes(type)
        ) {
          return req.abort();
        }

        // Block telemetry / tracking / analytics
        if (
          url.includes('gen_204') ||
          url.includes('/log?') ||
          url.includes('sodar') ||
          url.includes('batchexecute') ||
          url.includes('xjs=s') ||
          url.includes('m=') ||
          url.includes('async=') ||
          url.includes('google-analytics') ||
          url.includes('play.google.com/log') ||
          url.includes('/gen_204') ||
          url.includes('gws-wiz') ||
          url.includes('clients1.google.com')
        ) {
          return req.abort();
        }

        // Block JS entirely for maximum speed
        if (['script', 'xhr', 'fetch'].includes(type)) {
          return req.abort();
        }

        req.continue();
      });

      const startParam = (pageNumber - 1) * 10;
      let targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&gbv=2&pws=0`;
      if (categoryKey === 'images') {
        targetUrl += '&udm=2';
      } else if (categoryKey === 'videos') {
        targetUrl += '&udm=7';
      } else if (categoryKey === 'news') {
        targetUrl += '&udm=14';
      } else if (categoryKey === 'shopping') {
        targetUrl += '&udm=3';
      }

      const client = await page.target().createCDPSession();
      await client.send('Page.navigate', { url: targetUrl });
      await client.detach();

      await page
        .waitForSelector('#search, .Gx5Zad.xpd, .xpd, h3, a', {
          timeout: 100,
        })
        .catch(() => { /* timeout is fine */ });

      const extractResults = async (categoryParam: string) => page.evaluate((categoryParamInner: string) => {
        if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
          return { captcha: true, organic: [] as any[], aiResponse: null as string | null };
        }

        document
          .querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
          .forEach((b) => (b as HTMLElement).click());

        const organic: Array<{ title: string; link: string; snippet: string; displayedLink?: string; favicon?: string }> = [];
        let aiResponse: string | null = null;
        const seen = new Set<string>();

        const cleanText = (str: string | null) => str ? str.trim().replace(/\s+/g, ' ') : '';

        const decodeGoogleLink = (href: string | null) => {
          if (!href) return '';
          try {
            if (href.startsWith('/url?q=')) {
              const urlPart = href.split('/url?q=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            } else if (href.startsWith('/url?url=')) {
              const urlPart = href.split('/url?url=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            }
          } catch (e) { }
          return href;
        };

        // 1. EXTRACT AI OVERVIEW / RESPONSE (SGE)
        for (const sel of [
          '.M8OgIe', '.LLtROe', '.IZ6rdc',
          '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk',
        ]) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).innerText?.trim().length > 20) {
            // Filter out maps/places listing blocks incorrectly matched by generic card wrapper selectors
            if (
              el.querySelector('[href*="/maps/"]') ||
              el.querySelector('.YzSd') ||
              (el.textContent?.includes('Places') && el.textContent?.includes('Reviews'))
            ) {
              continue;
            }
            aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
            break;
          }
        }

        // 2. EXTRACT FEATURED SNIPPET
        let featuredSnippet: any = null;
        const fsContainer = document.querySelector('[data-attrid="wa:/description"], .kp-blk, .hp-xpd, .c2d06b');
        if (fsContainer) {
          const titleEl = fsContainer.querySelector('h3, .LC20lb');
          const aEl = fsContainer.querySelector('a');
          const snippetEl = fsContainer.querySelector('.YyVvo, .di3YZe, .ilUpNd.H66NU.aSRlid, .H66NU');
          if (titleEl && aEl && snippetEl) {
            featuredSnippet = {
              title: cleanText(titleEl.textContent),
              link: decodeGoogleLink(aEl.getAttribute('href') || ''),
              snippet: cleanText(snippetEl.textContent)
            };
          }
        }

        // 3. EXTRACT KNOWLEDGE PANEL
        let knowledgePanel: any = null;
        const kpContainer = document.querySelector('.kp-sidebar, #rhs, .rhs, .kp-blk, .KPDxwd');
        if (kpContainer) {
          const titleEl = kpContainer.querySelector('[role="heading"], .HPwZGe, .DU1Mzb, .kno-ecr-pt');
          const subtitleEl = kpContainer.querySelector('.wDYxhc.mod, .kno-meta, .bV3FIe');
          const descEl = kpContainer.querySelector('[data-attrid="kc:/common/topic:description"], .kno-rdesc span');
          const sourceEl = kpContainer.querySelector('.kno-rdesc a');

          const attributes: any[] = [];
          kpContainer.querySelectorAll('.rVusM, .zVnNfc, .Lrzca').forEach(el => {
            const label = el.querySelector('.wDYxhc, .zVnNfc, .fl');
            const val = el.querySelector('.Lrzca, .kno-fv');
            if (label && val) {
              attributes.push({
                label: cleanText(label.textContent),
                value: cleanText(val.textContent)
              });
            }
          });

          if (titleEl) {
            knowledgePanel = {
              title: cleanText(titleEl.textContent),
              subtitle: subtitleEl ? cleanText(subtitleEl.textContent) : undefined,
              description: descEl ? cleanText(descEl.textContent) : undefined,
              sourceUrl: sourceEl ? decodeGoogleLink(sourceEl.getAttribute('href') || '') : undefined,
              attributes: attributes.length > 0 ? attributes : undefined
            };
          }
        }

        // 4. EXTRACT PEOPLE ALSO ASK (PAA)
        const peopleAlsoAsk: any[] = [];
        document.querySelectorAll('[jsname="N760bc"], [data-init-query], .cb76Od, .E3VR9e').forEach((el) => {
          const headerText = cleanText(el.textContent);
          if (headerText.toLowerCase().includes('people also ask') || headerText.toLowerCase().includes('questions')) {
            const parent = el.parentElement;
            if (parent) {
              parent.querySelectorAll('[jsname="j96n9e"], .ask-xpd, .mB12ae').forEach((qEl) => {
                const qText = cleanText(qEl.textContent);
                if (qText) {
                  peopleAlsoAsk.push({ question: qText });
                }
              });
            }
          }
        });

        // 5. EXTRACT DIRECT ANSWERS (WEATHER, TRANSLATION, DICTIONARY, CALCULATOR)
        let directAnswer: any = null;

        // Calculator
        const calcResult = document.querySelector('#cwos');
        if (calcResult) {
          const calcEq = document.querySelector('.rN17ge, .SwHCTb');
          directAnswer = {
            type: 'calculator',
            answer: cleanText(calcResult.textContent),
            details: calcEq ? cleanText(calcEq.textContent) : undefined
          };
        }

        // Weather
        const weatherTemp = document.querySelector('#wob_tm, .vk_bk.wob-t');
        if (weatherTemp && !directAnswer) {
          const tempVal = weatherTemp.textContent ? weatherTemp.textContent.trim() : '';

          let unit = '°F';
          const tempUnitEl = document.querySelector('#wob_temp_unit, [aria-selected="true"] .wob_t, .wob_t[style*="inline"]');
          if (tempUnitEl && tempUnitEl.textContent?.includes('C')) {
            unit = '°C';
          } else {
            const weatherContainer = weatherTemp.closest('.Ww4FFb, .vk_c, .card');
            if (weatherContainer && weatherContainer.textContent?.includes('°C') && !weatherContainer.textContent?.includes('°F')) {
              unit = '°C';
            }
          }

          const locEl = document.querySelector('.BBwThe, #wob_loc, .wob_loc');
          let location = locEl ? cleanText(locEl.textContent) : 'Tokyo';
          if (location === 'Weather') {
            const cityEl = document.querySelector('.BBwThe, .wob_loc');
            if (cityEl) location = cleanText(cityEl.textContent);
          }

          const condEl = document.querySelector('#wob_dc, .wob_dc, #wob_dts + span');
          const condition = condEl ? cleanText(condEl.textContent) : '';

          const precipEl = document.querySelector('#wob_pp');
          const humidEl = document.querySelector('#wob_hm');
          const windEl = document.querySelector('#wob_ws');

          let details = `${location} - ${condition}`;
          if (precipEl || humidEl || windEl) {
            details += ` (Precipitation: ${precipEl ? precipEl.textContent : 'N/A'}, Humidity: ${humidEl ? humidEl.textContent : 'N/A'}, Wind: ${windEl ? windEl.textContent : 'N/A'})`;
          }

          directAnswer = {
            type: 'weather',
            answer: `${tempVal}${unit}`,
            details: details
          };
        }

        // Time / Timezone
        const timeVal = document.querySelector('.vk_bk, .gsrt.vk_bk');
        if (timeVal && timeVal.textContent && timeVal.textContent.includes(':') && !directAnswer) {
          const timeZone = document.querySelector('.vk_gy, .vk_sh');
          directAnswer = {
            type: 'time',
            answer: cleanText(timeVal.textContent),
            details: timeZone ? cleanText(timeZone.textContent) : undefined
          };
        }

        // Dictionary
        const dictWord = document.querySelector('.v9i61e, [data-attrid="kc:/common/dictionary:definition"]');
        if (dictWord && !directAnswer) {
          const dictMean = document.querySelector('.LT1Tbd, .lr_dct_ent');
          directAnswer = {
            type: 'dictionary',
            answer: cleanText(dictWord.textContent),
            details: dictMean ? cleanText(dictMean.textContent) : undefined
          };
        }

        // Translation
        const transTarget = document.querySelector('#tw-target-text');
        if (transTarget && !directAnswer) {
          const transSource = document.querySelector('#tw-source-text-ta');
          directAnswer = {
            type: 'translation',
            answer: cleanText(transTarget.textContent),
            details: transSource ? cleanText((transSource as any).value || transSource.textContent) : undefined
          };
        }

        // 6. EXTRACT NEWS / STORIES
        const news: any[] = [];
        document.querySelectorAll('g-card, .YLwUee, .WlydOe, .MjjYud').forEach((el) => {
          const a = el.querySelector('a');
          const isNews = el.querySelector('.OSrXXb, .LfNcr') || el.querySelector('.NUnG9b');
          if (a && isNews) {
            const h3 = el.querySelector('[role="heading"], h3, .mCBkyc, .nD1swb');
            const srcEl = el.querySelector('.NUnG9b, .h1UuCc, .ap3aec');
            const timeEl = el.querySelector('.OSrXXb, .LfNcr');
            if (h3 && a.getAttribute('href')) {
              const link = decodeGoogleLink(a.getAttribute('href'));
              if (link && !seen.has(link)) {
                news.push({
                  title: cleanText(h3.textContent),
                  source: srcEl ? cleanText(srcEl.textContent) : '',
                  time: timeEl ? cleanText(timeEl.textContent) : '',
                  link
                });
              }
            }
          }
        });

        // 7. EXTRACT VIDEOS
        const videos: any[] = [];
        document.querySelectorAll('g-card, .V2Ew3b, .z3HNeb, .MjjYud, [data-curl], .EyBRub, .hIwNKe').forEach((el) => {
          let a = el.querySelector('a');
          if (!a && el.tagName === 'A') {
            a = el as HTMLAnchorElement;
          }
          const href = a ? (a.getAttribute('href') || '') : '';
          const dataCurl = el.getAttribute('data-curl') || '';
          const targetLink = decodeGoogleLink(dataCurl || href);
          if (!targetLink) return;

          const isVideo = targetLink.includes('youtube.com') || targetLink.includes('vimeo.com') || targetLink.includes('tiktok.com') || el.querySelector('.vP1iyc') || el.querySelector('.J1y2db') || el.getAttribute('data-pubr') || el.querySelector('.O1KYjb');
          if (isVideo && !seen.has(targetLink)) {
            seen.add(targetLink);
            const h3 = el.querySelector('h3, h1, .mCBkyc, .z3HNeb, .WQWxe');
            const durEl = el.querySelector('.vP1iyc, .J1y2db, .ZwRhJd');
            const uploadedEl = el.querySelector('.ap3aec, .PCvXJ, .PLq9Je, .DKsccc');

            let duration = durEl ? cleanText(durEl.textContent) : undefined;
            let uploadedAt = uploadedEl ? cleanText(uploadedEl.textContent) : undefined;

            const ariaEl = el.querySelector('[aria-label]');
            if (ariaEl) {
              const label = ariaEl.getAttribute('aria-label') || '';
              if (label && !duration) {
                const durationMatch = label.match(/(\d+:\d+)/);
                if (durationMatch) duration = durationMatch[1];
              }
            }

            const pubr = el.getAttribute('data-pubr');
            const srcEl = el.querySelector('.NUnG9b, .h1UuCc, .ap3aec, .sjVJQd, .KrMNbf');
            const source = pubr ? cleanText(pubr) : (srcEl ? cleanText(srcEl.textContent) : (targetLink.includes('youtube.com') ? 'YouTube' : 'Video'));

            if (h3) {
              videos.push({
                title: cleanText(h3.textContent),
                source,
                duration,
                uploadedAt,
                link: targetLink
              });
            }
          }
        });

        // 8. EXTRACT IMAGES (both JS-enabled and JS-disabled, inline & traditional)
        const images: any[] = [];
        const seenImages = new Set<string>();

        // Method A: Script-based high-res image extraction for images category
        if (categoryParamInner === 'images') {
          const pageHtml = document.documentElement.innerHTML;
          const imgRegex = /\[0\s*,\s*"([^"]+)"\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
          let imgMatch;
          while ((imgMatch = imgRegex.exec(pageHtml)) !== null) {
            const imgUrl = imgMatch[5].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            if (seenImages.has(imgUrl)) continue;
            seenImages.add(imgUrl);

            const nextChunk = pageHtml.substring(imgMatch.index, imgMatch.index + 2000);
            const metaRegex = /"2003"\s*:\s*\[\s*null\s*,\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/;
            const metaMatch = metaRegex.exec(nextChunk);

            let sourceUrl = '';
            let title = '';
            if (metaMatch) {
              sourceUrl = metaMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
              title = metaMatch[2];
            }

            images.push({
              alt: cleanText(title || 'Image'),
              sourceUrl: sourceUrl || imgUrl,
              imageUrl: imgUrl
            });
          }
        }

        // Method B: DOM-based fallback if no script-based images are found or for non-images category
        if (images.length === 0) {
          // Method B.1: CSS class-independent heading-based images block parsing
          document.querySelectorAll('span, div, h2, h3').forEach((el) => {
            const text = el.textContent ? el.textContent.trim() : '';
            if (text === 'Images') {
              let parent = el.parentElement;
              while (parent && parent.querySelectorAll('img').length < 3 && parent.tagName !== 'BODY') {
                parent = parent.parentElement;
              }
              if (parent) {
                parent.querySelectorAll('img').forEach((img) => {
                  const alt = img.getAttribute('alt') || '';
                  const imageUrl = img.getAttribute('src') || '';
                  if (!imageUrl) return;

                  let p = img.parentElement;
                  let sourceUrl = '';
                  while (p && p !== parent && p.tagName !== 'BODY') {
                    const anchor = p.querySelector('a');
                    if (anchor) {
                      const href = anchor.getAttribute('href') || '';
                      if (href) {
                        sourceUrl = decodeGoogleLink(href);
                        break;
                      }
                    }
                    p = p.parentElement;
                  }

                  if (sourceUrl && !seenImages.has(imageUrl)) {
                    seenImages.add(imageUrl);
                    images.push({
                      alt: cleanText(alt),
                      sourceUrl,
                      imageUrl
                    });
                  }
                });
              }
            }
          });

          // Method B.2: Traditional imgres fallback links (e.g. JS-disabled/fallback page)
          document.querySelectorAll('a[href*="imgres"]').forEach((el) => {
            const img = el.querySelector('img');
            const alt = img ? img.getAttribute('alt') || '' : '';
            const href = el.getAttribute('href') || '';

            let sourceUrl = '';
            let imageUrl = '';
            try {
              const urlObj = new URL(href, window.location.href);
              imageUrl = urlObj.searchParams.get('imgurl') || '';
              sourceUrl = urlObj.searchParams.get('imgrefurl') || '';
            } catch (e) {
              const imgMatch = href.match(/[?&]imgurl=([^&]+)/);
              const refMatch = href.match(/[?&]imgrefurl=([^&]+)/);
              if (imgMatch) imageUrl = decodeURIComponent(imgMatch[1]);
              if (refMatch) sourceUrl = decodeURIComponent(refMatch[1]);
            }

            sourceUrl = decodeGoogleLink(sourceUrl || href);
            if (sourceUrl && imageUrl && !seenImages.has(imageUrl)) {
              seenImages.add(imageUrl);
              images.push({
                alt: cleanText(alt),
                sourceUrl,
                imageUrl: imageUrl || undefined
              });
            }
          });
        }


        // 9. EXTRACT SHOPPING RESULTS
        const shopping: any[] = [];
        document.querySelectorAll('.sh-dgr__grid-cell, .sh-dlr__list-result, .sh-np__click-target').forEach((el) => {
          const a = el.querySelector('a');
          const titleEl = el.querySelector('.Xj73ed, .tAxDx');
          const priceEl = el.querySelector('.a8c5bc, .h1N1A');
          const merchantEl = el.querySelector('.I5cFL, .mB12ae');
          if (a && titleEl && priceEl) {
            const link = decodeGoogleLink(a.getAttribute('href') || '');
            shopping.push({
              title: cleanText(titleEl.textContent),
              price: cleanText(priceEl.textContent),
              merchant: merchantEl ? cleanText(merchantEl.textContent) : '',
              link
            });
          }
        });

        // 10. EXTRACT LOCAL RESULTS
        const localResults: any[] = [];
        document.querySelectorAll('.rllt__card, .Vk2fBe').forEach((el) => {
          const titleEl = el.querySelector('[role="heading"], .dbg0pd');
          const ratingEl = el.querySelector('.rGhul, .Yw7Nj');
          const reviewsEl = el.querySelector('.R3Y11e');
          const addressEl = el.querySelector('.Lrzca');
          const a = el.querySelector('a');
          if (titleEl) {
            localResults.push({
              title: cleanText(titleEl.textContent),
              rating: ratingEl ? cleanText(ratingEl.textContent) : undefined,
              reviewsCount: reviewsEl ? cleanText(reviewsEl.textContent) : undefined,
              address: addressEl ? cleanText(addressEl.textContent) : undefined,
              link: a ? decodeGoogleLink(a.getAttribute('href') || '') : undefined
            });
          }
        });

        // 11. EXTRACT RELATED SEARCHES
        const relatedSearches: string[] = [];
        document.querySelectorAll('a.title, .s75cqc, .card-section a, .E3VR9e').forEach((el) => {
          const headerText = cleanText(el.textContent);
          if (headerText.toLowerCase().includes('people also search') || headerText.toLowerCase().includes('related search')) {
            let parent = el.parentElement;
            while (parent && !parent.className.includes('Gx5Zad') && parent.tagName !== 'BODY') {
              parent = parent.parentElement;
            }
            if (parent) {
              parent.querySelectorAll('a').forEach((aEl) => {
                const text = cleanText(aEl.textContent);
                if (text && text !== headerText && !relatedSearches.includes(text)) {
                  relatedSearches.push(text);
                }
              });
            }
          }
        });

        // 12. EXTRACT ORGANIC SEARCH RESULTS
        if (categoryParamInner === 'all') {
          document.querySelectorAll('h3').forEach((h3) => {
            const headingText = cleanText(h3.textContent);
            if (
              headingText === 'Search Results' ||
              headingText === 'Weather Result' ||
              headingText === 'Web results' ||
              headingText === 'Featured snippet' ||
              headingText.includes('People also ask')
            ) {
              return;
            }

            const container = h3.closest('.g, .MjjYud, .xpd, .Gx5Zad') || h3.parentElement;
            if (!container) return;

            const a = container.tagName === 'A' ? container : container.querySelector('a');
            if (!a) return;

            const rawLink = a.getAttribute('href') || '';
            const link = decodeGoogleLink(rawLink);

            if (!link || link.includes('google.com') || link.includes('sorry/index') || seen.has(link)) return;
            seen.add(link);

            let snippet = '';
            for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.ilUpNd.H66NU.aSRlid', '.H66NU', '.lQigmf']) {
              const sn = container.querySelector(s);
              if (sn && sn.textContent && sn.textContent.trim()) {
                const txt = cleanText(sn.textContent);
                if (txt !== cleanText(h3.textContent) && !txt.includes('www.') && txt.length > 10) {
                  snippet = txt;
                  break;
                }
              }
            }

            if (!snippet) {
              container.querySelectorAll('div, span, p').forEach((sub) => {
                if (!snippet && sub.className && sub.textContent && sub.children.length === 0) {
                  const txt = cleanText(sub.textContent);
                  if (txt.length > 30 && !txt.includes('www.') && txt !== cleanText(h3.textContent)) {
                    snippet = txt;
                  }
                }
              });
            }

            const dispEl = container.querySelector('.TbwUpd, .byrV5b, .ylgVCe, .BamJPe');
            const displayedLink = dispEl ? cleanText(dispEl.textContent) : undefined;

            const favEl = container.querySelector('img.H1u2de, img.XNo5Ab, .wb41ae img');
            const favicon = favEl ? favEl.getAttribute('src') || undefined : undefined;

            organic.push({
              title: cleanText(h3.textContent),
              link,
              snippet,
              displayedLink,
              favicon
            });
          });
        }

        // Strict Category Tab Filtering / Isolation
        const cleanOrganic = categoryParamInner === 'all' ? organic : [];
        const cleanNews = categoryParamInner === 'news' ? news : [];
        const cleanVideos = categoryParamInner === 'videos' ? videos : [];
        const cleanImages = categoryParamInner === 'images' ? images : [];
        const cleanShopping = categoryParamInner === 'shopping' ? shopping : [];

        return {
          captcha: false,
          organic: cleanOrganic,
          aiResponse: categoryParamInner === 'all' ? aiResponse : null,
          featuredSnippet: categoryParamInner === 'all' ? featuredSnippet : null,
          knowledgePanel: categoryParamInner === 'all' ? knowledgePanel : null,
          peopleAlsoAsk: categoryParamInner === 'all' ? peopleAlsoAsk : undefined,
          directAnswer: categoryParamInner === 'all' ? directAnswer : null,
          news: cleanNews.length > 0 ? cleanNews : undefined,
          videos: cleanVideos.length > 0 ? cleanVideos : undefined,
          images: cleanImages.length > 0 ? cleanImages : undefined,
          shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
          relatedSearches: categoryParamInner === 'all' ? relatedSearches : undefined,
          localResults: categoryParamInner === 'all' && localResults.length > 0 ? localResults : undefined
        };
      }, categoryParam);

      const hasCategoryResults = (res: any) => {
        if (categoryKey === 'all') return res.organic && res.organic.length > 0;
        if (categoryKey === 'images') return res.images && res.images.length > 0;
        if (categoryKey === 'videos') return res.videos && res.videos.length > 0;
        if (categoryKey === 'news') return res.news && res.news.length > 0;
        if (categoryKey === 'shopping') return res.shopping && res.shopping.length > 0;
        return false;
      };

      let results = await extractResults(categoryKey);

      if (!results.captcha && !hasCategoryResults(results)) {
        await page
          .waitForSelector('#search .g, #rso .g, .MjjYud .g, .Gx5Zad.xpd, .xpd, h3, a[href^="http"], a[href*="/url?q="]', {
            timeout: 15_000,
          })
          .catch(() => { /* timeout is fine */ });

        results = await extractResults(categoryKey);

        if (!results.captcha && !hasCategoryResults(results)) {
          await page
            .waitForSelector('form[action="/sorry/index"], #captcha, .g-recaptcha', {
              timeout: 5_000,
            })
            .catch(() => { /* timeout is fine */ });

          results = await extractResults(categoryKey);
        }
      }

      if (results.captcha) {
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);

      return {
        organic: results.organic,
        aiResponse: results.aiResponse,
        featuredSnippet: results.featuredSnippet,
        knowledgePanel: results.knowledgePanel,
        peopleAlsoAsk: results.peopleAlsoAsk,
        directAnswer: results.directAnswer,
        news: results.news,
        videos: results.videos,
        images: results.images,
        shopping: results.shopping,
        relatedSearches: results.relatedSearches,
        localResults: results.localResults
      };

    } catch (e) {
      const msg = (e as Error).message;
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        pageErrored = true;
      } else if ([
        'CDP_UNREACHABLE', 'NO_WS_URL', 'WebSocket', 'Connection closed'
      ].some((k) => msg.includes(k)) || (conn && !conn.browserConn.isConnected())) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        // Reuse pages used for Search, discard if page errored
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    browserPool.restartWorkers();
  }

  return null;
}
