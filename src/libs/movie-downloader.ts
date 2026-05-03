/**
 * @file movie-downloader.ts
 * @description Downloads movies from the screenfetch2.xyz / cloudnestra.com chain.
 *
 * Request chain:
 *  1. GET screenfetch2.xyz/embed/movie?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 *     → Parse iframe src → cloudnestra.com/rcp/{hash}
 *  2. GET cloudnestra.com/rcp/{hash}
 *     → Parse /prorcp/{hash2} from JS (loadIframe call)
 *  3. GET cloudnestra.com/prorcp/{hash2}
 *     → Parse Playerjs({file: "…{v1}…/master.m3u8 or …{v2}…"})
 *     → Parse test_doms[] to get candidate domain list
 *     → Replace {v1},{v2},… with corresponding domains
 *     → Try each m3u8 URL until one responds 200
 *  4. Download the working m3u8 via youtube-dl-exec (yt-dlp), save to tmp file.
 *
 * Domain-injection strategy (from the site's own test_doms array):
 *   {v1} → test_doms[0] host, {v2} → test_doms[1] host, …
 * Additional fallback {v5} uses the app2.{host} pattern from the last URL.
 *
 * Cloudflare bypass strategy:
 *   Raw HTTP fetch is tried first (fast, zero overhead on clean IPs).
 *   If the response is 403 / Cloudflare-blocked, we automatically fall back
 *   to a headless Chromium browser (Puppeteer) which passes bot challenges.
 *   Puppeteer is imported lazily — no startup cost unless the fallback fires.
 */

import * as https from 'https';
import * as http from 'http';
import { IncomingMessage } from 'http';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import youtubeDlExec from 'youtube-dl-exec';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBED_HOST = 'screenfetch2.xyz';
const CLOUDNESTRA_HOST = 'cloudnestra.com';
const FILMPIRE_ORIGIN = 'https://filmpire.sc';

/** Browser-like headers to avoid bot detection */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MovieMediaType = 'movie' | 'tv';

export interface MovieDownloadResult {
  /** Path to the downloaded file */
  filePath: string;
  /** Human-readable filename (title + quality) */
  filename: string;
  /** Mime type */
  mimetype: string;
  /** Caption for the WhatsApp message */
  caption: string;
}

export interface M3u8Info {
  /** Resolved m3u8 URLs (index 0 = best quality) */
  urls: string[];
  /** Raw filename hint from the page (if present) */
  filenamehint: string;
}

// ---------------------------------------------------------------------------
// HTTP helper: fetch raw HTML, following up to 3 redirects
// ---------------------------------------------------------------------------

/**
 * Module-level cookie jar: maps hostname → raw Cookie header value.
 * Populated from Set-Cookie response headers and re-sent on subsequent
 * requests to the same host, mimicking real browser session behaviour.
 */
const cookieJar = new Map<string, string>();

/**
 * Parse Set-Cookie header(s) into name=value pairs and merge into the jar
 * for the given hostname.
 */
function absorbCookies(hostname: string, raw: string | string[] | undefined): void {
  if (!raw) return;
  const entries = Array.isArray(raw) ? raw : [raw];
  const existing: Record<string, string> = {};

  // Parse already-stored cookies for this host
  const stored = cookieJar.get(hostname);
  if (stored) {
    for (const pair of stored.split(';')) {
      const [k, ...rest] = pair.trim().split('=');
      if (k) existing[k.trim()] = rest.join('=');
    }
  }

  // Merge new cookies (only name=value, ignore attributes like Path/Expires)
  for (const entry of entries) {
    const nameValue = entry.split(';')[0]?.trim();
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx < 1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    existing[name] = value;
  }

  cookieJar.set(
    hostname,
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
  );
}

/**
 * Fetch URL as a browser would: follows redirects, decompresses gzip/br/deflate,
 * and maintains a per-hostname cookie jar across calls.
 */
function fetchHtml(
  url: string,
  extraHeaders: Record<string, string> = {},
  maxRedirects = 5,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const attempt = (targetUrl: string, redirectsLeft: number) => {
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === 'https:' ? https : http;

      // Attach any previously collected cookies for this host
      const jar = cookieJar.get(parsed.hostname);
      const cookieHeader = jar ? { Cookie: jar } : {};

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          ...BROWSER_HEADERS,
          Host: parsed.hostname,
          ...cookieHeader,
          ...extraHeaders,
        },
      };

      const req = lib.request(options, (res: IncomingMessage) => {
        // Collect Set-Cookie from every response (including redirects)
        absorbCookies(parsed.hostname, res.headers['set-cookie']);

        // Follow redirect
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects from ${targetUrl}`));
            return;
          }
          let nextUrl = res.headers.location;
          if (nextUrl.startsWith('/')) {
            nextUrl = `${parsed.protocol}//${parsed.host}${nextUrl}`;
          }
          res.resume();
          attempt(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
          return;
        }

        // Decompress response based on Content-Encoding header
        const encoding = res.headers['content-encoding'];
        let stream: NodeJS.ReadableStream = res;
        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }

        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(15_000, () => {
        req.destroy(new Error(`Timeout fetching ${targetUrl}`));
      });
      req.end();
    };

    attempt(url, maxRedirects);
  });
}

// ---------------------------------------------------------------------------
// Cloudflare-aware HTML fetch: raw HTTP with Puppeteer fallback
// ---------------------------------------------------------------------------

/**
 * Detects whether an HTTP error (or HTML string) indicates Cloudflare blocked us.
 * Cloudflare returns 403 or a 200 with a challenge page when blocking bots.
 */
function isCloudflareBlock(err: unknown | null, html?: string): boolean {
  if (err instanceof Error && err.message.includes('HTTP 403')) return true;
  if (html) {
    // Cloudflare challenge pages contain these markers
    return (
      html.includes('cf-browser-verification') ||
      html.includes('cf_chl_') ||
      html.includes('Cloudflare Ray ID') ||
      (html.includes('Just a moment') && html.includes('cloudflare'))
    );
  }
  return false;
}

/**
 * Fetch the fully-rendered HTML of a page using Puppeteer (headless Chromium).
 * Used as a fallback when Cloudflare blocks raw Node.js HTTP requests.
 * Puppeteer bundles its own Chromium — no separate install step needed.
 */
async function fetchHtmlViaBrowser(
  url: string,
  referer?: string,
): Promise<string> {
  const puppeteer = await import('puppeteer');
  console.log(`[MovieDL] 🌐 Cloudflare detected — using headless browser for: ${url}`);

  const launchParams = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  const browser = await (puppeteer.default?.launch(launchParams) || puppeteer.launch(launchParams));

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({
      'Accept-Language': BROWSER_HEADERS['Accept-Language'],
      DNT: '1',
      ...(referer ? { Referer: referer } : {}),
    });
    // networkidle2 = no more than 2 in-flight requests for 500ms (passes CF challenges)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}

/**
 * Extract the /prorcp/ URL from the cloudnestra /rcp/ page using a real browser.
 *
 * The /prorcp/ path is set dynamically on an iframe.src via JS.
 * We wait for the iframe element to appear in the DOM and read its src directly —
 * no request interception or HTML parsing needed.
 */
async function browserGetProRcpUrl(rcpUrl: string): Promise<string> {
  const puppeteer = await import('puppeteer');
  console.log(`[MovieDL] 🌐 Using browser to get /prorcp/ from: ${rcpUrl}`);

  const launchParams = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  const browser = await (puppeteer.default?.launch(launchParams) || puppeteer.launch(launchParams));

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({
      'Accept-Language': BROWSER_HEADERS['Accept-Language'],
      DNT: '1',
      Referer: `https://${EMBED_HOST}/`,
    });

    await page.goto(rcpUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`[MovieDL] Page loaded. Title: "${title}", URL: ${finalUrl}`);

    // Check for Cloudflare challenge
    const content = await page.content();
    if (content.includes('cf-browser-verification') || content.includes('cf_chl_') || (content.includes('Just a moment') && content.includes('cloudflare'))) {
      console.log('[MovieDL] ⚠️ Still stuck on Cloudflare challenge page in browser.');
    }

    // Wait up to 15s for the iframe with /prorcp/ to be set by JS
    console.log('[MovieDL] Waiting for /prorcp/ iframe...');
    let iframeSrc = await page
      .waitForSelector('iframe[src*="/prorcp/"]', { timeout: 15_000 })
      .then((el: any) => el?.evaluate((node: any) => (node as any).src))
      .catch(async () => {
        console.log('[MovieDL] Iframe selector timeout. Checking ALL iframes...');
        // Exhaustive check: get all iframe sources currently in the DOM
        const allIframes = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('iframe')).map(i => ({
            src: i.src,
            id: i.id,
            class: i.className
          }));
        });
        console.log(`[MovieDL] Total iframes found: ${allIframes.length}`);
        allIframes.forEach((f, idx) => console.log(`  [${idx}] src: "${f.src}", id: "${f.id}", class: "${f.class}"`));

        // Try to find it in the list manually
        const found = allIframes.find(f => f.src.includes('/prorcp/'));
        return found ? found.src : null;
      });

    if (iframeSrc) {
      const full = iframeSrc.startsWith('/')
        ? `https://${CLOUDNESTRA_HOST}${iframeSrc}`
        : iframeSrc;
      console.log(`[MovieDL] Found /prorcp/ from iframe src: ${full}`);
      return full;
    }

    // Fallback: regex over full page HTML
    const m = content.match(/['"](\/?prorcp\/[^'"]+)['"]/);
    if (m && m[1]) {
      const full = m[1].startsWith('/')
        ? `https://${CLOUDNESTRA_HOST}${m[1]}`
        : m[1];
      console.log(`[MovieDL] Found /prorcp/ via page content regex: ${full}`);
      return full;
    }

    console.log(`[MovieDL] ❌ Failed to find /prorcp/. Page content snippet: ${content.slice(0, 1000)}`);
    throw new Error(`Could not find /prorcp/ URL in page content. (Title: ${title})`);
  } finally {
    await browser.close();
  }
}

/**
 * Fetch HTML for a URL — fast raw HTTP first, Playwright fallback on Cloudflare block.
 *
 * @param url          Target URL
 * @param extraHeaders Additional HTTP headers(e.g.Referer, Sec - Fetch -*)
 * @param referer      Referer to pass to the browser fallback(optional)
 */
async function fetchHtmlWithFallback(
  url: string,
  extraHeaders: Record<string, string> = {},
  referer?: string,
): Promise<string> {
  try {
    const html = await fetchHtml(url, extraHeaders);

    // Cloudflare can return 200 with a challenge page instead of 403
    if (isCloudflareBlock(null, html)) {
      console.log(`[MovieDL] Cloudflare challenge page detected (200 body), switching to browser.`);
      return fetchHtmlViaBrowser(url, referer ?? extraHeaders['Referer']);
    }

    return html;
  } catch (err) {
    if (isCloudflareBlock(err)) {
      return fetchHtmlViaBrowser(url, referer ?? extraHeaders['Referer']);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP HEAD check: verify an m3u8 URL is reachable
// ---------------------------------------------------------------------------

function headCheck(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method: 'HEAD',
          headers: {
            'User-Agent': BROWSER_HEADERS['User-Agent'],
          },
        },
        (res: IncomingMessage) => {
          res.resume();
          resolve(!!(res.statusCode && res.statusCode < 400));
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Step 1: Get /rcp/{hash} URL from screenfetch2 embed page
// ---------------------------------------------------------------------------

/**
 * Fetches the screenfetch2.xyz embed page and extracts the cloudnestra /rcp/ URL
 * from the iframe src attribute.
 */
async function getRcpUrl(tmdbId: number, mediaType: MovieMediaType): Promise<string> {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const embedUrl = `https://${EMBED_HOST}/embed/${type}?tmdb=${tmdbId}&o=${encodeURIComponent(FILMPIRE_ORIGIN)}`;

  console.log(`[MovieDL] Step1: Fetching embed page: ${embedUrl}`);
  const html = await fetchHtmlWithFallback(
    embedUrl,
    {
      Referer: `${FILMPIRE_ORIGIN}/`,
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    },
    `${FILMPIRE_ORIGIN}/`,
  );

  // Match: src="//cloudnestra.com/rcp/..."
  const rcpMatch = html.match(/src=["'](?:https?:)?\/\/cloudnestra\.com(\/rcp\/[^"']+)["']/i);
  if (!rcpMatch || !rcpMatch[1]) {
    throw new Error('Could not find /rcp/ iframe src in screenfetch2 embed page');
  }

  return `https://${CLOUDNESTRA_HOST}${rcpMatch[1]}`;
}

// ---------------------------------------------------------------------------
// Step 2: Get /prorcp/{hash} URL from the cloudnestra /rcp/ page
// ---------------------------------------------------------------------------

/**
 * Fetches the cloudnestra /rcp/ page and extracts the /prorcp/ URL
 * from the loadIframe() JS call.
 */
async function getProRcpUrl(rcpUrl: string): Promise<string> {
  console.log(`[MovieDL] Step2: Fetching rcp page: ${rcpUrl}`);

  // Try raw HTTP + regex first (works on clean IPs)
  try {
    const html = await fetchHtml(rcpUrl, {
      Referer: `https://${EMBED_HOST}/`,
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    });

    if (!isCloudflareBlock(null, html)) {
      const proRcpMatch = html.match(/['"]\/prorcp\/([^'"]+)['"]/i);
      if (proRcpMatch && proRcpMatch[1]) {
        return `https://${CLOUDNESTRA_HOST}/prorcp/${proRcpMatch[1]}`;
      }
    }
  } catch (err) {
    if (!isCloudflareBlock(err)) throw err;
    // Fall through to browser strategy
  }

  // Cloudflare blocked — use browser with request interception
  return browserGetProRcpUrl(rcpUrl);
}

// ---------------------------------------------------------------------------
// Step 3: Extract m3u8 URLs from the /prorcp/ player page
// ---------------------------------------------------------------------------

/**
 * Fetches the cloudnestra /prorcp/ page and extracts:
 *  - The `file:` string from `new Playerjs({…})`
 *  - The `test_doms` array
 *  - Any filename hint from `atob(…)` in `var flnm`
 *
 * Then resolves {v1},{v2},… placeholders using test_doms domain suffixes.
 */
async function extractM3u8Urls(proRcpUrl: string): Promise<M3u8Info> {
  console.log(`[MovieDL] Step3: Fetching prorcp page: ${proRcpUrl}`);
  const html = await fetchHtmlWithFallback(
    proRcpUrl,
    {
      Referer: `https://${CLOUDNESTRA_HOST}/rcp/`,
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
    `https://${CLOUDNESTRA_HOST}/rcp/`,
  );

  // ── Extract test_doms[] ─────────────────────────────────────────────────
  // Pattern: var test_doms = ["https://tmstr1.neonhorizonworkshops.com", …];
  const testDomsMatch = html.match(/var\s+test_doms\s*=\s*\[([^\]]+)\]/);
  let testDoms: string[] = [];

  if (testDomsMatch && testDomsMatch[1]) {
    const rawDoms = testDomsMatch[1];
    // Extract all quoted strings
    const domMatches = rawDoms.match(/["']([^"']+)["']/g);
    if (domMatches) {
      testDoms = domMatches.map((d) => d.replace(/['"]/g, '').trim());
    }
  }

  // Fallback domains from the known list (in case the array isn't in HTML)
  if (testDoms.length === 0) {
    testDoms = [
      'https://tmstr1.neonhorizonworkshops.com',
      'https://fasdf1.wanderlynest.com',
      'https://tmstr1.orchidpixelgardens.com',
      'https://tmstr1.cloudnestra.com',
    ];
    console.log('[MovieDL] test_doms not found in page, using fallback list');
  }

  console.log(`[MovieDL] test_doms: ${testDoms.join(', ')}`);

  // ── Extract the Playerjs file: string ─────────────────────────────────
  // Pattern: new Playerjs({…, file: "https://tmstr1.{v1}/pl/H4sI…", …})
  // The file value can span multiple lines and is separated by " or "
  const fileMatch = html.match(/new\s+Playerjs\s*\(\s*\{[^}]*?file\s*:\s*["']([^"']+)["']/s);
  if (!fileMatch || !fileMatch[1]) {
    throw new Error('Could not find Playerjs file: parameter in prorcp page');
  }

  const rawFileStr = fileMatch[1];
  console.log(`[MovieDL] Raw file string (first 200): ${rawFileStr.slice(0, 200)}`);

  // Split by " or " to get individual stream URLs (best quality first)
  const rawUrls = rawFileStr
    .split(/\s+or\s+/)
    .map((u) => u.trim())
    .filter(Boolean);

  console.log(`[MovieDL] Found ${rawUrls.length} stream URL(s) in file string`);

  // ── Resolve {v1},{v2},… placeholders ──────────────────────────────────
  // Each URL looks like:
  //   https://tmstr1.{v1}/pl/H4sI.../master.m3u8
  //   https://app2.{v5}/cdnstr/H4sI.../list.m3u8
  // Replace {vN} with the Nth domain from test_doms (1-indexed → 0-indexed)

  const resolvedUrls: string[] = [];

  for (const rawUrl of rawUrls) {
    // Find all {vN} placeholders in this URL
    const placeholders = rawUrl.match(/\{v(\d+)\}/g);

    if (!placeholders || placeholders.length === 0) {
      // No placeholder → use as-is
      resolvedUrls.push(rawUrl);
      continue;
    }

    let resolved = rawUrl;
    for (const ph of placeholders) {
      const vNum = parseInt(ph.replace(/\{v(\d+)\}/, '$1'), 10); // e.g. 1
      const domainIdx = vNum - 1; // 0-indexed

      if (domainIdx >= 0 && domainIdx < testDoms.length) {
        const domEntry = testDoms[domainIdx]!;
        // domEntry is like "https://tmstr1.neonhorizonworkshops.com"
        // The URL has the scheme+subdomain already: "https://tmstr1.{v1}/pl/..."
        // We need just the hostname suffix (e.g. "neonhorizonworkshops.com")
        // because the URL already has "tmstr1." prefix
        const domHost = new URL(domEntry).hostname; // "tmstr1.neonhorizonworkshops.com"
        // Extract just the TLD part after first dot: "neonhorizonworkshops.com"
        const tldPart = domHost.includes('.') ? domHost.split('.').slice(1).join('.') : domHost;
        resolved = resolved.replace(ph, tldPart);
      } else {
        // Out of range — try last available domain suffix
        const lastDom = testDoms[testDoms.length - 1] ?? '';
        if (lastDom) {
          const domHost = new URL(lastDom).hostname;
          const tldPart = domHost.includes('.') ? domHost.split('.').slice(1).join('.') : domHost;
          resolved = resolved.replace(ph, tldPart);
        }
      }
    }

    resolvedUrls.push(resolved);
  }

  // ── Extract filename hint from atob(...) ──────────────────────────────
  // Pattern: var flnm = removeExtension(atob('...'));
  let filenamehint = '';
  const flnmMatch = html.match(/var\s+flnm\s*=\s*removeExtension\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (flnmMatch && flnmMatch[1]) {
    try {
      const decoded = Buffer.from(flnmMatch[1], 'base64').toString('utf-8');
      // decoded is like "Swapped (2026) [1080p] [WEBRip] [5.1] [YTS.BZ]/Swapped.2026.1080p..."
      // Take just the last segment (after last slash)
      const parts = decoded.split('/');
      filenamehint = parts[parts.length - 1] ?? decoded;
    } catch {
      // ignore
    }
  }

  console.log(`[MovieDL] Resolved ${resolvedUrls.length} m3u8 URL(s):`);
  resolvedUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));

  return { urls: resolvedUrls, filenamehint };
}

// ---------------------------------------------------------------------------
// Step 4: Find the first reachable m3u8 URL
// ---------------------------------------------------------------------------

/**
 * Checks each resolved m3u8 URL with a HEAD request and returns the first
 * one that responds successfully. Falls back to the first URL if none pass.
 */
async function pickWorkingUrl(urls: string[]): Promise<string> {
  console.log('[MovieDL] Step4: Probing m3u8 URLs...');

  for (const url of urls) {
    console.log(`[MovieDL]   Checking: ${url}`);
    const ok = await headCheck(url);
    if (ok) {
      console.log(`[MovieDL]   ✅ Reachable: ${url}`);
      return url;
    }
    console.log(`[MovieDL]   ❌ Not reachable`);
  }

  // Fallback: just use the first URL and hope for the best
  console.log('[MovieDL] No reachable URL found via HEAD; falling back to first URL');
  return urls[0]!;
}

// ---------------------------------------------------------------------------
// Step 5: Download via yt-dlp
// ---------------------------------------------------------------------------

/**
 * Downloads the HLS stream at `m3u8Url` to a temporary mp4 file using yt-dlp.
 * Calls `onProgress` periodically with status updates.
 *
 * @returns Path to the downloaded file
 */
async function downloadM3u8(
  m3u8Url: string,
  title: string,
  onProgress: (msg: string) => Promise<void>,
  outputDir?: string,
): Promise<string> {
  const safeTitle = title.replace(/[^\w\s\-().]/g, '').trim().slice(0, 60);
  const tmpDir = outputDir ?? os.tmpdir();
  const outputPath = path.join(tmpDir, `${safeTitle}.%(ext)s`);

  console.log(`[MovieDL] Step5: Downloading via yt-dlp: ${m3u8Url}`);
  await onProgress('📥 *Downloading movie stream...*');

  await youtubeDlExec(m3u8Url, {
    output: outputPath,
    // Best video+audio
    format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    mergeOutputFormat: 'mp4',
    // Spoof browser
    addHeader: [
      `Referer:https://${CLOUDNESTRA_HOST}/`,
      `User-Agent:${BROWSER_HEADERS['User-Agent']}`,
    ],
    // HLS-specific
    hlsPreferNative: true,
    noWarnings: true,
    noCheckCertificate: true,
    retries: 5,
    fragmentRetries: 10,
  } as Parameters<typeof youtubeDlExec>[1]);

  // yt-dlp replaces %(ext)s with the actual extension; find the file
  const titleBase = path.join(tmpDir, safeTitle);
  for (const ext of ['mp4', 'mkv', 'ts', 'webm']) {
    const candidate = `${titleBase}.${ext}`;
    if (fs.existsSync(candidate)) {
      console.log(`[MovieDL] Downloaded to: ${candidate}`);
      return candidate;
    }
  }

  throw new Error(`yt-dlp completed but output file not found in ${tmpDir}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full pipeline: TMDB ID → screenfetch2 embed → cloudnestra chain → download.
 *
 * @param tmdbId     TMDB movie/show ID
 * @param mediaType  'movie' or 'tv'
 * @param title      Human-readable title (for filename & caption)
 * @param onProgress Callback for WhatsApp status updates
 * @returns          Path + metadata of the downloaded file
 */
export async function downloadMovie(
  tmdbId: number,
  mediaType: MovieMediaType,
  title: string,
  onProgress: (msg: string) => Promise<void>,
): Promise<MovieDownloadResult> {
  await onProgress('🔗 *Fetching video sources...*');

  // Step 1
  const rcpUrl = await getRcpUrl(tmdbId, mediaType);

  // Step 2
  const proRcpUrl = await getProRcpUrl(rcpUrl);

  // Step 3
  const m3u8Info = await extractM3u8Urls(proRcpUrl);

  if (m3u8Info.urls.length === 0) {
    throw new Error('No m3u8 stream URLs found for this title');
  }

  // Step 4
  await onProgress('🌐 *Probing stream servers...*');
  const workingUrl = await pickWorkingUrl(m3u8Info.urls);

  // Step 5
  const filePath = await downloadM3u8(workingUrl, title, onProgress);

  const filename = m3u8Info.filenamehint
    ? m3u8Info.filenamehint.replace(/\.[^.]+$/, '') + '.mp4'
    : `${title}.mp4`;

  return {
    filePath,
    filename,
    mimetype: 'video/mp4',
    caption:
      `🎬 *${title}*\n` +
      `📥 Downloaded via CloudNestra\n` +
      `_${filename}_`,
  };
}

/**
 * Only resolves and returns the m3u8 URL(s) without downloading.
 * Useful for generating a watch/stream link.
 *
 * @returns Array of resolved m3u8 URLs (best quality first)
 */
export async function getMovieStreamUrls(
  tmdbId: number,
  mediaType: MovieMediaType,
): Promise<string[]> {
  const rcpUrl = await getRcpUrl(tmdbId, mediaType);
  const proRcpUrl = await getProRcpUrl(rcpUrl);
  const info = await extractM3u8Urls(proRcpUrl);
  return info.urls;
}