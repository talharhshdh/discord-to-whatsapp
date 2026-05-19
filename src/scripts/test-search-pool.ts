/**
 * @file test-search-pool.ts
 * @description Standalone test script to measure execution time of searchViaPool locally using specific CDP URLs.
 *
 * Usage:
 *   npx ts-node src/scripts/test-search-pool.ts "your search query"
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import { browserPool } from '../libs/browser-pool';
import {
  acquirePage,
  releasePage,
  invalidateWorkerConnection,
  workerCdpFailures,
  MAX_WORKER_CDP_FAILURES,
} from '../libs/page-pool';
import type { WorkerConnection } from '../libs/page-pool';

// Register the worker URLs you provided
const WORKERS = [
  { id: 'browser-worker-4-runner-2a319255', url: 'https://mainly-catalyst-gibraltar-systematic.trycloudflare.com' },
  { id: 'browser-worker-2-runner-80356627', url: 'https://revision-impose-deserve-remix.trycloudflare.com' },
  { id: 'browser-worker-1-runner-b96ef0fa', url: 'https://orange-bend-pcs-converter.trycloudflare.com' },
  { id: 'browser-worker-3-runner-ecb33571', url: 'https://corn-ivory-plaintiff-week.trycloudflare.com' },
  { id: 'browser-worker-5-runner-7bb2294b', url: 'https://acquisition-tribal-nicole-keywords.trycloudflare.com' },
];

// Add them directly into the pool
for (const w of WORKERS) {
  browserPool.register(w.id, w.url);
}

/**
 * Exact copy of the searchViaPool logic from browser-pool.ts, 
 * augmented with `performance.now()` checkpoints.
 */
async function timedSearchViaPool(
  text: string,
  pageNumber: number = 1,
  includeAI: boolean = false,
) {
  const maxAttempts = Math.max(1, browserPool.getActive().length);
  console.log(`\n======================================================`);
  console.log(`🚀 Starting timed search for: "${text}"`);
  console.log(`   Browsers in pool: ${maxAttempts}`);
  console.log(`======================================================\n`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) {
      console.error('🚨 No active browsers available in pool.');
      break;
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    console.log(`\n--- Attempt ${attempt + 1}/${maxAttempts} using worker: ${browser.workerId} ---`);
    const attemptStart = performance.now();

    try {
      const tAcquire = performance.now();
      const acquired = await acquirePage(browser);
      console.log(`⏱️  acquirePage (CDP Connect + newPage) took: ${Math.round(performance.now() - tAcquire)} ms`);
      
      conn = acquired.conn;
      page = acquired.page;

      const tInterception = performance.now();
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const url = req.url();

        if (type === 'document') return req.continue();

        if (['image', 'media', 'font', 'stylesheet', 'websocket', 'manifest', 'other'].includes(type)) {
          return req.abort();
        }
        if (
          url.includes('gen_204') || url.includes('/log?') || url.includes('sodar') ||
          url.includes('batchexecute') || url.includes('xjs=s') || url.includes('m=') ||
          url.includes('async=') || url.includes('google-analytics') || url.includes('play.google.com/log') ||
          url.includes('/gen_204') || url.includes('gws-wiz') || url.includes('clients1.google.com')
        ) {
          return req.abort();
        }
        // Try ALLOWING scripts temporarily to see if Google needs them to render results
        if (['xhr', 'fetch'].includes(type)) {
          return req.abort();
        }
        req.continue();
      });
      console.log(`⏱️  setup request interception took:          ${Math.round(performance.now() - tInterception)} ms`);

      const startParam = (pageNumber - 1) * 10;
      const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&udm=web&gbv=2&pws=0`;
      
      const tGoto = performance.now();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`⏱️  page.goto (Network request) took:         ${Math.round(performance.now() - tGoto)} ms`);

      const title = await page.title();
      console.log(`📄  Page Title:                               "${title}"`);

      const tWait = performance.now();
      await page.waitForSelector('#search .g, #rso .g, .MjjYud .g, form[action="/sorry/index"]', { timeout: 100 }).catch(() => {});
      console.log(`⏱️  waitForSelector (DOM render wait) took:   ${Math.round(performance.now() - tWait)} ms`);

      const tEval = performance.now();
      const results = await page.evaluate(() => {
        if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
          return { captcha: true, organic: [], aiResponse: null };
        }

        document
          .querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
          .forEach((b: any) => (b as HTMLElement).click());

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

        // Fallback strategy if .g selectors fail (present in browser-pool.ts)
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
      });
      console.log(`⏱️  page.evaluate (Data extraction) took:     ${Math.round(performance.now() - tEval)} ms`);

      if (results.captcha) {
        const html = await page.content();
        fs.writeFileSync('debug-google.html', html);
        console.log(`💾  Dumped HTML to debug-google.html (Captcha detected).`);
        console.warn(`⚠️  Captcha detected on pool browser ${browser.workerId}`);
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);
      
      console.log(`\n✅  Attempt succeeded!`);
      console.log(`    Found ${results.organic.length} organic results.`);
      
      if (results.organic.length === 0) {
        const html = await page.content();
        fs.writeFileSync('debug-google.html', html);
        console.log(`💾  Dumped HTML to debug-google.html because 0 results were found. Inspect this file!`);
      }

      return { organic: results.organic, aiResponse: results.aiResponse };

    } catch (e) {
      const msg = (e as Error).message;
      console.error(`❌  Pool search failed via ${browser.workerId}:`, msg);
      browserPool.deregister(browser.workerId);
      pageErrored = true;
    } finally {
      const tRelease = performance.now();
      if (conn && page) {
        await releasePage(conn, page, true);
      }
      console.log(`⏱️  releasePage / cleanup took:               ${Math.round(performance.now() - tRelease)} ms`);
      console.log(`    Total time for this attempt:              ${Math.round(performance.now() - attemptStart)} ms`);
    }
  }

  return null;
}

async function main() {
  const query = process.argv[2] || 'weather in tokyo';
  await timedSearchViaPool(query, 1, false);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});