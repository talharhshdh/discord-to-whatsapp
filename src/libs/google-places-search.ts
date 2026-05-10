/**
 * @file google-places-search.ts
 * @description Google Maps Places scraper via puppeteer through the remote browser pool.
 *
 * Scrapes the maximum amount of data available from Google Maps place cards:
 *  - name, address, coordinates (from URL data params !3d/!4d), phone, website
 *  - rating, review count, price level, category/type
 *  - hours (open/closed status + today's hours string)
 *  - description / editorial summary
 *  - place_id (hex pair 0x…:0x… from URL)
 *
 * Pagination: Google Maps uses infinite scroll on [role="feed"].
 * We scroll the panel until stable (no new cards), then slice the requested
 * "page" window out of the full card list (20 cards per logical page).
 */

import { browserPool } from './browser-pool';
import {
  acquirePage,
  releasePage,
  invalidateWorkerConnection,
  workerCdpFailures,
  MAX_WORKER_CDP_FAILURES,
} from './page-pool';
import type { WorkerConnection } from './page-pool';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaceResult {
  /** Display name of the place */
  name: string;
  /** Formatted address */
  address: string | null;
  /** Phone number */
  phone: string | null;
  /** Official website */
  website: string | null;
  /** Star rating (1–5) */
  rating: number | null;
  /** Total number of reviews */
  reviewCount: number | null;
  /** Price level string, e.g. '$10–20', '$$', '$$$' or null */
  priceLevel: string | null;
  /** Primary category / type */
  category: string | null;
  /** Open now status */
  openNow: boolean | null;
  /** Today's hours / status string, e.g. "Open · Closes 5 AM" */
  todaysHours: string | null;
  /** Full open/closed status line including phone/extra info */
  openStatus: string | null;
  /** Full weekly schedule keyed by day name (deep-scrape only) */
  weeklyHours: Record<string, string> | null;
  /** Editorial summary / description */
  description: string | null;
  /** Number of photos listed (deep-scrape only) */
  photosCount: number | null;
  /** Google Maps URL for the place */
  mapsUrl: string | null;
  /** place_id hex pair extracted from URL data params (e.g. "0x89c25...") */
  placeId: string | null;
  /** Latitude extracted from URL data params */
  lat: number | null;
  /** Longitude extracted from URL data params */
  lng: number | null;
  /** Whether popular times section exists (deep-scrape only) */
  hasPopularTimes: boolean;
  /** Claimed/verified status (deep-scrape only) */
  isClaimed: boolean | null;
  /** Amenities / attributes listed (deep-scrape only) */
  amenities: string[];
  /** "People also search for" related place names (deep-scrape only) */
  relatedPlaces: string[];
}

export interface PlacesSearchResult {
  query: string;
  page: number;
  results: PlaceResult[];
  hasNextPage: boolean;
  totalResultsText: string | null;
}

/** Emitted progressively during a streaming search. */
export interface PlacesBatchEvent {
  type: 'batch' | 'progress' | 'done' | 'error';
  /** New cards in this batch (type=batch) */
  cards?: PlaceResult[];
  /** Running total of cards scraped so far */
  total?: number;
  /** Scroll round info */
  round?: number;
  /** Whether the feed has been fully loaded */
  reachedEnd?: boolean;
  /** Error message (type=error) */
  message?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Logical results per page (Google Maps shows ~20 per scroll batch). */
const PAGE_SIZE = 20;

/** Max scroll rounds before giving up on loading more. */
const MAX_SCROLL_ROUNDS = 20;

/** Wait between each scroll attempt (ms). */
const SCROLL_WAIT_MS = 2_500;

// ---------------------------------------------------------------------------
// In-browser scraping helpers
// NOTE: These functions run inside page.evaluate — no Node.js APIs allowed.
// ---------------------------------------------------------------------------

/**
 * Extract all visible card data from the [role="feed"] panel.
 *
 * DOM observations (verified 2026-05-10):
 *  - Scroll container: [role="feed"]  (aria-label="Results for …")
 *  - Card:            [role="article"].Nv2PK
 *  - Name:            .qBF1Pd
 *  - Place link:      a.hfpxzc  (href contains !3d<lat>!4d<lng> and hex placeId)
 *  - Rating row:      .AJB7ye → innerText "4.6(6,999) · $20–70"
 *  - Info rows:       .W4Efsd children of the outer .W4Efsd container
 *    - Row 0: "Category · ♿ · Address"
 *    - Row 1: "Editorial description"   (optional)
 *    - Row 2: "Open · Closes 5 AM"     (optional, coloured span inside)
 *  - Open status detected by inline color style:
 *    green rgba(25,134,57) = open | red rgba(220,54,46) = closed
 */
function extractAllCards(): Array<{
  name: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  category: string | null;
  address: string | null;
  description: string | null;
  openNow: boolean | null;
  todaysHours: string | null;
  openStatus: string | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
}> {
  const results: ReturnType<typeof extractAllCards> = [];
  const seen = new Set<string>();

  document.querySelectorAll<HTMLElement>('[role="article"]').forEach((card) => {
    // ── Name ────────────────────────────────────────────────────────────
    const name = card.querySelector<HTMLElement>('.qBF1Pd')?.innerText?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);

    // ── Link → lat/lng/placeId ──────────────────────────────────────────
    const linkEl  = card.querySelector<HTMLAnchorElement>('a.hfpxzc, a[href*="maps/place"]');
    const mapsUrl = linkEl?.href || null;

    // Coords encoded as !3d<lat>!4d<lng> in the data= query param
    const latM  = mapsUrl?.match(/!3d(-?\d+\.\d+)/);
    const lngM  = mapsUrl?.match(/!4d(-?\d+\.\d+)/);
    const lat   = latM  ? parseFloat(latM[1])  : null;
    const lng   = lngM  ? parseFloat(lngM[1])  : null;

    // place_id: hex address pair "0x…:0x…"
    const pidM    = mapsUrl?.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
    const placeId = pidM ? pidM[0] : null;

    // ── Rating row (.AJB7ye) text: "4.6(6,999) · $20–70" ──────────────
    const ratingRowText = card.querySelector<HTMLElement>('.AJB7ye')?.innerText?.trim() ?? '';

    const ratingM    = ratingRowText.match(/^(\d+\.\d+)/);
    const rating     = ratingM ? parseFloat(ratingM[1]) : null;

    const reviewM    = ratingRowText.match(/\(([\d,]+)\)/);
    const reviewCount = reviewM ? parseInt(reviewM[1].replace(/,/g, ''), 10) : null;

    // Price: anything after last · e.g. "$20–70" or "$$"
    const priceM     = ratingRowText.match(/·\s*(\$[^\s·]+)/);
    const priceLevel = priceM ? priceM[1] : null;

    // ── Info rows: children .W4Efsd of the outer .W4Efsd block ─────────
    // The outer W4Efsd wraps the info section (not the rating row).
    // We pick the W4Efsd that is a parent of another W4Efsd (i.e. the outer one).
    let outerW4: HTMLElement | null = null;
    card.querySelectorAll<HTMLElement>('.W4Efsd').forEach((el) => {
      if (!outerW4 && el.querySelector('.W4Efsd')) {
        outerW4 = el;
      }
    });

    const infoRows = outerW4
      ? Array.from((outerW4 as HTMLElement).querySelectorAll<HTMLElement>(':scope > .W4Efsd'))
      : [];

    // Row 0: "Category · ♿ · Address"
    const row0Text = infoRows[0]?.innerText?.trim() ?? '';
    const row0Parts = row0Text.split('·').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    const category = row0Parts[0] || null;
    const address  = row0Parts.length > 1 ? row0Parts[row0Parts.length - 1] || null : null;

    // Remaining rows: description and open-status
    let description: string | null = null;
    let openStatus: string | null  = null;
    let openNow: boolean | null    = null;

    for (let i = 1; i < infoRows.length; i++) {
      const rowText     = infoRows[i]?.innerText?.trim() ?? '';
      const coloredSpan = infoRows[i]?.querySelector<HTMLElement>('span[style*="color"]');
      const colorStyle  = coloredSpan?.getAttribute('style') ?? '';

      if (coloredSpan && (colorStyle.includes('25,134,57') || colorStyle.includes('220,54,46'))) {
        // Open/closed row detected via inline color style
        openStatus = rowText;
        openNow    = colorStyle.includes('25,134,57'); // green = open
      } else if (rowText && !description) {
        description = rowText;
      }
    }

    results.push({
      name,
      rating,
      reviewCount,
      priceLevel,
      category,
      address,
      description,
      openNow,
      todaysHours: openStatus,
      openStatus,
      mapsUrl,
      lat,
      lng,
      placeId,
    });
  });

  return results;
}

/**
 * Extract all available data from an open Google Maps place side-panel.
 * Runs INSIDE the browser via page.evaluate — no Node.js APIs allowed.
 */
function extractPlaceFromPanel(): PlaceResult {
  function text(sel: string, root: Document | Element = document): string | null {
    const el = root.querySelector(sel);
    return el ? (el as HTMLElement).innerText?.trim() || null : null;
  }

  const name =
    text('h1.DUwDvf') ||
    text('[data-attrid="title"] span') ||
    text('h1') ||
    'Unknown';

  const address =
    text('[data-item-id="address"] .Io6YTe') ||
    text('button[data-item-id="address"] .fontBodyMedium') ||
    text('.rogA2c .Io6YTe') ||
    null;

  const phone =
    text('[data-item-id^="phone:tel:"] .Io6YTe') ||
    text('button[data-tooltip="Copy phone number"] .Io6YTe') ||
    null;

  const websiteEl =
    document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]') ||
    document.querySelector<HTMLAnchorElement>('[data-item-id="website"] a');
  const website = websiteEl?.href || null;

  const ratingText =
    text('.F7nice span[aria-hidden="true"]') ||
    text('.ceNzKf span[aria-hidden="true"]');
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

  const reviewText =
    text('.F7nice span[aria-label*="review"]') ||
    text('[aria-label*="reviews"]') ||
    text('.HHrUdb') ||
    null;
  const reviewMatch = reviewText?.replace(/,/g, '').match(/[\d.]+/);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[0], 10) : null;

  const priceEl    = document.querySelector('[aria-label*="Price: "], [aria-label*="price"]');
  const priceLabel = priceEl?.getAttribute('aria-label') || '';
  const priceMatch = priceLabel.match(/\$+/);
  const priceLevel = priceMatch ? priceMatch[0] : null;

  const category =
    text('.DkEaL') ||
    text('button.DkEaL') ||
    text('[jsaction*="category"] span') ||
    null;

  const openSpan = document.querySelector<HTMLElement>('.eXlsfd span, .o0Svhf span, .dHvSe span');
  const openText = openSpan?.innerText?.toLowerCase() || '';
  let openNow: boolean | null = null;
  if (openText.includes('open')) openNow = true;
  else if (openText.includes('closed')) openNow = false;

  const todaysHours =
    text('.t39EBf .G8aQO') ||
    text('[data-item-id="oh"] .fontBodyMedium') ||
    null;

  const weeklyHours: Record<string, string> = {};
  document.querySelectorAll('.t39EBf table tr, [jsaction*="hours"] tr').forEach((row) => {
    const day = (row.querySelector('td:first-child') as HTMLElement)?.innerText?.trim();
    const hrs = (row.querySelector('td:last-child') as HTMLElement)?.innerText?.trim();
    if (day && hrs) weeklyHours[day] = hrs;
  });

  const description =
    text('.PYvSYb') ||
    text('[data-attrid="description"] .iKbnQ') ||
    text('.xt2b0d .WeS02d') ||
    null;

  const photoCountEl = document.querySelector('[aria-label*="photo"], [aria-label*="Photo"]');
  const photoMatch   = photoCountEl?.getAttribute('aria-label')?.match(/[\d,]+/);
  const photosCount  = photoMatch ? parseInt(photoMatch[0].replace(/,/g, ''), 10) : null;

  const mapsUrl      = window.location.href;
  // Try URL-encoded place path first, then data param hex pair
  const pidM         = mapsUrl.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
  const placeId      = pidM ? pidM[0] : null;
  const latM         = mapsUrl.match(/!3d(-?\d+\.\d+)/);
  const lngM         = mapsUrl.match(/!4d(-?\d+\.\d+)/);
  const lat          = latM ? parseFloat(latM[1]) : null;
  const lng          = lngM ? parseFloat(lngM[1]) : null;

  const hasPopularTimes =
    !!document.querySelector('.g2BVhd, [jsdata*="popular"], [aria-label*="Popular times"]');

  const isClaimed =
    !!document.querySelector('[aria-label*="Claimed"], [aria-label*="verified owner"]');

  const amenities: string[] = [];
  document
    .querySelectorAll('.E0DTEd .CK16pd, .LTs0Rc .CK16pd, [jsaction*="amenity"] .CK16pd')
    .forEach((el) => {
      const t = (el as HTMLElement).innerText?.trim();
      if (t) amenities.push(t);
    });

  const relatedPlaces: string[] = [];
  document.querySelectorAll('.Hk4XGb .qBF1Pd, .YhemCb .qBF1Pd').forEach((el) => {
    const t = (el as HTMLElement).innerText?.trim();
    if (t) relatedPlaces.push(t);
  });

  return {
    name,
    address,
    phone,
    website,
    rating: isNaN(rating as number) ? null : rating,
    reviewCount: isNaN(reviewCount as number) ? null : reviewCount,
    priceLevel,
    category,
    openNow,
    todaysHours,
    openStatus: todaysHours,
    weeklyHours: Object.keys(weeklyHours).length ? weeklyHours : null,
    description,
    photosCount,
    mapsUrl,
    placeId,
    lat,
    lng,
    hasPopularTimes,
    isClaimed,
    amenities,
    relatedPlaces,
  };
}

// ---------------------------------------------------------------------------
// Scroll helper (runs in Node context, operates on the puppeteer page)
// ---------------------------------------------------------------------------

/**
 * Scroll [role="feed"] until:
 *   (a) at least `targetCount` cards are loaded (early exit — fast path), OR
 *   (b) no new cards appear for 2 consecutive rounds (full load), OR
 *   (c) MAX_SCROLL_ROUNDS is exhausted.
 *
 * `onBatch` is called after each scroll round with newly scraped PlaceResult[]
 * so callers can stream results to the client in real-time.
 *
 * Pass targetCount = Infinity to always load everything.
 */
async function scrollFeedForMore(
  page: any,
  targetCount = Infinity,
  onBatch?: (newCards: PlaceResult[], total: number, round: number) => void,
): Promise<{ loaded: number; total: number; reachedEnd: boolean }> {
  let prevCount    = 0;
  let stableRounds = 0;
  let scrollRound  = 0;
  let seenNames    = new Set<string>();

  while (scrollRound < MAX_SCROLL_ROUNDS) {
    const { count, scrolledTo, scrollHeight } = await page.evaluate(() => {
      const feed = document.querySelector<HTMLElement>('[role="feed"]');
      if (!feed) return { count: 0, scrolledTo: 0, scrollHeight: 0 };
      feed.scrollTop = feed.scrollHeight;
      return {
        count: document.querySelectorAll('[role="article"]').length,
        scrolledTo: feed.scrollTop,
        scrollHeight: feed.scrollHeight,
      };
    });

    console.log(
      `   Scroll ${scrollRound + 1}: ${count} cards visible | scrollTop=${Math.round(scrolledTo)}/${scrollHeight}`,
    );

    await new Promise<void>((r) => setTimeout(r, SCROLL_WAIT_MS));

    const afterCount: number = await page.evaluate(
      () => document.querySelectorAll('[role="article"]').length,
    );

    // Fire onBatch with newly visible cards since last round
    if (onBatch && afterCount > prevCount) {
      const allCards: ReturnType<typeof extractAllCards> = await page.evaluate(extractAllCards);
      const newCards = allCards
        .filter(c => !seenNames.has(c.name))
        .map(c => ({
          ...c,
          phone: null,
          website: null,
          weeklyHours: null,
          photosCount: null,
          hasPopularTimes: false,
          isClaimed: null,
          amenities: [] as string[],
          relatedPlaces: [] as string[],
        }) as PlaceResult);
      newCards.forEach(c => seenNames.add(c.name));
      if (newCards.length > 0) onBatch(newCards, seenNames.size, scrollRound + 1);
    }

    // Early exit: we have enough cards for the requested page
    if (afterCount >= targetCount) {
      console.log(`   ↳ Target ${targetCount} cards reached (${afterCount} loaded) — stopping early.`);
      return { loaded: afterCount, total: afterCount, reachedEnd: false };
    }

    if (afterCount === prevCount) {
      stableRounds++;
      if (stableRounds >= 2) {
        console.log('   ↳ No new cards after 2 stable rounds — all loaded.');
        return { loaded: afterCount, total: afterCount, reachedEnd: true };
      }
    } else {
      stableRounds = 0;
    }

    prevCount    = afterCount;
    scrollRound++;
  }

  const total: number = await page.evaluate(
    () => document.querySelectorAll('[role="article"]').length,
  );
  return { loaded: total, total, reachedEnd: false };
}

// ---------------------------------------------------------------------------
// Main exported search function
// ---------------------------------------------------------------------------

/**
 * Search Google Maps Places via the remote browser pool.
 *
 * @param query      - Search query, e.g. "pizza restaurants in Manhattan"
 * @param pageNumber - 1-based logical page (20 results per page).
 *                     Page 1 = items 0–19, page 2 = items 20–39, etc.
 *                     We always load the full scroll-list then slice.
 * @param deepScrape - If true, click into each card for full detail.
 *                     If false (default), only card-level data returned.
 */
export async function searchPlacesViaPool(
  query: string,
  pageNumber = 1,
  deepScrape = false,
): Promise<PlacesSearchResult | null> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      // ── Navigate ──────────────────────────────────────────────────────
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/maps/search/${encodedQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );

      // Wait for the feed panel to appear
      await page
        .waitForSelector('[role="feed"]', { timeout: 15_000 })
        .catch(() => { /* proceed even if it times out */ });

      // Short settle
      await new Promise<void>((r) => setTimeout(r, 1_500));

      // ── Captcha check ─────────────────────────────────────────────────
      const hasCaptcha: boolean = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // ── Scroll the feed until we have enough cards for this page ─────
      // Early-exit once we've loaded (pageNumber × PAGE_SIZE) cards so the
      // browser worker isn't held for 50s just to serve page 1.
      // Pass Infinity when deep-scraping so all handles are available.
      const neededCards = deepScrape ? Infinity : pageNumber * PAGE_SIZE;
      const scrollResult = await scrollFeedForMore(page, neededCards);
      console.log(`📋 Places: loaded ${scrollResult.total} cards for "${query}" (needed ≥${neededCards})`);

      // ── Extract cards ─────────────────────────────────────────────────
      if (!deepScrape) {
        const allCardData = await page.evaluate(extractAllCards);

        // Slice logical page window
        const start       = (pageNumber - 1) * PAGE_SIZE;
        const end         = start + PAGE_SIZE;
        const pageSlice   = allCardData.slice(start, end);
        const hasNextPage = allCardData.length > end;

        const results: PlaceResult[] = pageSlice.map(
          (c: ReturnType<typeof extractAllCards>[number]) => ({
            ...c,
            phone: null,
            website: null,
            weeklyHours: null,
            photosCount: null,
            hasPopularTimes: false,
            isClaimed: null,
            amenities: [],
            relatedPlaces: [],
          }),
        );

        workerCdpFailures.delete(browser.workerId);
        return {
          query,
          page: pageNumber,
          results,
          hasNextPage,
          totalResultsText: `${scrollResult.total} places loaded`,
        };
      }

      // ── Deep scrape: click into each card ────────────────────────────
      const allHandles: any[] = await page.$$('[role="article"]');
      const start       = (pageNumber - 1) * PAGE_SIZE;
      const handles     = allHandles.slice(start, start + PAGE_SIZE);
      const hasNextPage = allHandles.length > start + PAGE_SIZE;
      const results: PlaceResult[] = [];

      for (const handle of handles) {
        try {
          await handle.click();
          await page
            .waitForSelector('h1.DUwDvf, h1, .DUwDvf', { timeout: 8_000 })
            .catch(() => { /* ignore */ });

          // Try to expand hours
          await page.evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              'button[data-item-id="oh"], [aria-label*="hours"], .t39EBf button',
            );
            if (btn) btn.click();
          });
          await new Promise<void>((r) => setTimeout(r, 600));

          const placeData = await page.evaluate(extractPlaceFromPanel);
          results.push(placeData);
        } catch (e) {
          console.warn('⚠️ Failed to extract place detail:', (e as Error).message);
        }

        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: 12_000 })
          .catch(() => { /* ignore */ });
        await page
          .waitForSelector('[role="article"]', { timeout: 8_000 })
          .catch(() => { /* ignore */ });
      }

      workerCdpFailures.delete(browser.workerId);
      return {
        query,
        page: pageNumber,
        results,
        hasNextPage,
        totalResultsText: `${scrollResult.total} places loaded`,
      };

    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `❌ Places search failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`,
        msg,
      );
      browserPool.recordFailure();

      if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some((k) => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          console.warn(
            `🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive CDP failures — evicting.`,
          );
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }
    } finally {
      if (conn && page) {
        // Always discard pages used for Maps — Google Maps navigation leaves
        // the page in a state (detached frames, stale request interception)
        // that causes "Detached Frame" errors on reuse.
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}

/**
 * Streaming variant of searchPlacesViaPool.
 * Calls `onEvent` with batches of PlaceResult as each scroll round completes,
 * then emits a final `done` event when all cards are loaded.
 *
 * Designed for SSE endpoints — the caller writes each event to the HTTP
 * response as it arrives, so the dashboard sees results in real-time.
 */
export async function searchPlacesStream(
  query: string,
  onEvent: (event: PlacesBatchEvent) => void,
): Promise<void> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      // ── Navigate ──────────────────────────────────────────────────────
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/maps/search/${encodedQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );

      await page
        .waitForSelector('[role="feed"]', { timeout: 15_000 })
        .catch(() => { /* proceed anyway */ });

      await new Promise<void>((r) => setTimeout(r, 1_500));

      const hasCaptcha: boolean = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // ── Scroll and stream batches ─────────────────────────────────────
      const scrollResult = await scrollFeedForMore(
        page,
        Infinity,
        (newCards, total, round) => {
          onEvent({ type: 'batch', cards: newCards, total, round });
        },
      );

      onEvent({ type: 'done', total: scrollResult.total, reachedEnd: scrollResult.reachedEnd });
      workerCdpFailures.delete(browser.workerId);
      return;

    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `❌ Places stream failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`,
        msg,
      );
      onEvent({ type: 'error', message: msg });
      browserPool.recordFailure();

      if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some((k) => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }

      // On error, try the next worker instead of aborting
      if (attempt < maxAttempts - 1) continue;

    } finally {
      if (conn && page) {
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }
}
