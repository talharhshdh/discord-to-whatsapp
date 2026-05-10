/**
 * @file google-places-search.ts
 * @description Google Maps Places scraper via puppeteer through the remote browser pool.
 *
 * Scrapes the maximum amount of data available from Google Maps place cards:
 *  - name, address, coordinates (from URL), phone, website
 *  - rating, review count, price level, category/type
 *  - hours (open/closed status + full weekly schedule)
 *  - description / editorial summary
 *  - photos count
 *  - popular times presence
 *  - place_id (from URL)
 *  - Google Maps URL
 *
 * Pagination: iterates result tiles on the left-panel list, scrolling and
 * clicking "More results" / next-page arrow as needed.
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
  /** Star rating (1-5) */
  rating: number | null;
  /** Total number of reviews */
  reviewCount: number | null;
  /** Price level: '$', '$$', '$$$', '$$$$' or null */
  priceLevel: string | null;
  /** Primary category / type */
  category: string | null;
  /** Open now status */
  openNow: boolean | null;
  /** Today's hours string, e.g. "9:00 AM – 10:00 PM" */
  todaysHours: string | null;
  /** Full weekly schedule keyed by day name */
  weeklyHours: Record<string, string> | null;
  /** Editorial summary / description */
  description: string | null;
  /** Number of photos listed (may be null if not shown) */
  photosCount: number | null;
  /** Google Maps URL for the place */
  mapsUrl: string | null;
  /** place_id extracted from URL */
  placeId: string | null;
  /** Latitude extracted from URL */
  lat: number | null;
  /** Longitude extracted from URL */
  lng: number | null;
  /** Whether popular times section exists */
  hasPopularTimes: boolean;
  /** Claimed/verified status */
  isClaimed: boolean | null;
  /** Amenities / attributes listed (e.g. "Wheelchair accessible", "Outdoor seating") */
  amenities: string[];
  /** "People also search for" related place names */
  relatedPlaces: string[];
}

export interface PlacesSearchResult {
  query: string;
  page: number;
  results: PlaceResult[];
  hasNextPage: boolean;
  totalResultsText: string | null;
}

// ---------------------------------------------------------------------------
// Internal scraping helpers (run inside page.evaluate)
// ---------------------------------------------------------------------------

/**
 * Extract all available data from an open Google Maps place side-panel.
 * Runs INSIDE the browser via page.evaluate — no Node.js APIs allowed.
 */
function extractPlaceFromPanel(): PlaceResult {
  function text(sel: string, root: Document | Element = document): string | null {
    const el = root.querySelector(sel);
    return el ? (el as HTMLElement).innerText?.trim() || null : null;
  }

  // Name
  const name =
    text('h1.DUwDvf') ||
    text('[data-attrid="title"] span') ||
    text('h1') ||
    'Unknown';

  // Address
  const address =
    text('[data-item-id="address"] .Io6YTe') ||
    text('button[data-item-id="address"] .fontBodyMedium') ||
    text('.rogA2c .Io6YTe') ||
    null;

  // Phone
  const phone =
    text('[data-item-id^="phone:tel:"] .Io6YTe') ||
    text('button[data-tooltip="Copy phone number"] .Io6YTe') ||
    null;

  // Website
  const websiteEl =
    document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]') ||
    document.querySelector<HTMLAnchorElement>('[data-item-id="website"] a');
  const website = websiteEl?.href || null;

  // Rating
  const ratingText =
    text('.F7nice span[aria-hidden="true"]') ||
    text('.ceNzKf span[aria-hidden="true"]');
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

  // Review count
  const reviewText =
    text('.F7nice span[aria-label*="review"]') ||
    text('[aria-label*="reviews"]') ||
    text('.HHrUdb') ||
    null;
  const reviewMatch = reviewText?.replace(/,/g, '').match(/[\d.]+/);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[0], 10) : null;

  // Price level
  const priceEl = document.querySelector('[aria-label*="Price: "], [aria-label*="price"]');
  const priceLabel = priceEl?.getAttribute('aria-label') || '';
  const priceMatch = priceLabel.match(/\$+/);
  const priceLevel = priceMatch ? priceMatch[0] : null;

  // Category
  const category =
    text('.DkEaL') ||
    text('button.DkEaL') ||
    text('[jsaction*="category"] span') ||
    null;

  // Open/closed status
  const openSpan = document.querySelector<HTMLElement>('.eXlsfd span, .o0Svhf span, .dHvSe span');
  const openText = openSpan?.innerText?.toLowerCase() || '';
  let openNow: boolean | null = null;
  if (openText.includes('open')) openNow = true;
  else if (openText.includes('closed')) openNow = false;

  // Today's hours
  const todaysHours =
    text('.t39EBf .G8aQO') ||
    text('[data-item-id="oh"] .fontBodyMedium') ||
    null;

  // Weekly hours — try to expand the hours dropdown first
  const weeklyHours: Record<string, string> = {};
  const hourRows = document.querySelectorAll('.t39EBf table tr, [jsaction*="hours"] tr');
  hourRows.forEach((row) => {
    const day = (row.querySelector('td:first-child') as HTMLElement)?.innerText?.trim();
    const hrs = (row.querySelector('td:last-child') as HTMLElement)?.innerText?.trim();
    if (day && hrs) weeklyHours[day] = hrs;
  });

  // Description / editorial summary
  const description =
    text('.PYvSYb') ||
    text('[data-attrid="description"] .iKbnQ') ||
    text('.xt2b0d .WeS02d') ||
    null;

  // Photos count
  const photoCountEl = document.querySelector('[aria-label*="photo"], [aria-label*="Photo"]');
  const photoMatch = photoCountEl?.getAttribute('aria-label')?.match(/[\d,]+/);
  const photosCount = photoMatch ? parseInt(photoMatch[0].replace(/,/g, ''), 10) : null;

  // Google Maps URL + place_id + lat/lng
  const mapsUrl = window.location.href;
  const placeIdMatch = mapsUrl.match(/place\/[^/]+\/([^/]+)/);
  const placeId = placeIdMatch ? placeIdMatch[1] : null;
  const coordMatch = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
  const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

  // Popular times
  const hasPopularTimes = !!document.querySelector('.g2BVhd, [jsdata*="popular"], [aria-label*="Popular times"]');

  // Claimed/verified
  const isClaimed = !!document.querySelector('[aria-label*="Claimed"], [aria-label*="verified owner"]');

  // Amenities / attributes
  const amenities: string[] = [];
  document.querySelectorAll('.E0DTEd .CK16pd, .LTs0Rc .CK16pd, [jsaction*="amenity"] .CK16pd').forEach((el) => {
    const t = (el as HTMLElement).innerText?.trim();
    if (t) amenities.push(t);
  });

  // Related places
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
// List-panel scraper helpers
// ---------------------------------------------------------------------------

/**
 * Extract lightweight card data from the search results list panel
 * (before clicking into each individual place).
 */
function extractResultCards(): Array<{
  name: string;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  address: string | null;
  priceLevel: string | null;
  openNow: boolean | null;
  mapsUrl: string | null;
}> {
  const cards: ReturnType<typeof extractResultCards> = [];
  const seen = new Set<string>();

  // Each result tile in the left-side list
  document.querySelectorAll('[role="article"], .Nv2PK, .hfpxzc').forEach((card) => {
    const nameEl = card.querySelector<HTMLElement>('.qBF1Pd, .fontHeadlineSmall');
    const name = nameEl?.innerText?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);

    const ratingText = (card.querySelector<HTMLElement>('.MW4etd')?.innerText || '').trim();
    const rating = ratingText ? parseFloat(ratingText) : null;

    const reviewEl = card.querySelector<HTMLElement>('.UY7F9');
    const reviewMatch = reviewEl?.innerText?.match(/[\d,]+/);
    const reviewCount = reviewMatch ? parseInt(reviewMatch[0].replace(/,/g, ''), 10) : null;

    const category = card.querySelector<HTMLElement>('.W4Efsd:first-of-type')?.innerText?.trim() || null;
    const address = card.querySelector<HTMLElement>('.W4Efsd:last-of-type')?.innerText?.trim() || null;

    const priceEl = card.querySelector<HTMLElement>('[aria-label*="Price"]');
    const priceLabel = priceEl?.getAttribute('aria-label') || '';
    const priceMatch = priceLabel.match(/\$+/);
    const priceLevel = priceMatch ? priceMatch[0] : null;

    const openEl = card.querySelector<HTMLElement>('.eXlsfd, .o0Svhf');
    const openText = openEl?.innerText?.toLowerCase() || '';
    let openNow: boolean | null = null;
    if (openText.includes('open')) openNow = true;
    else if (openText.includes('closed')) openNow = false;

    const linkEl = card.querySelector<HTMLAnchorElement>('a[href*="maps/place"]');
    const mapsUrl = linkEl?.href || null;

    cards.push({ name, rating, reviewCount, category, address, priceLevel, openNow, mapsUrl });
  });

  return cards;
}

// ---------------------------------------------------------------------------
// Main exported search function
// ---------------------------------------------------------------------------

/**
 * Search Google Maps Places via the remote browser pool.
 *
 * @param query      - Search query, e.g. "pizza restaurants in Manhattan"
 * @param pageNumber - 1-based page index (each page ~20 results from the list panel)
 * @param deepScrape - If true, click into each place card to extract full details.
 *                     If false (default), only card-level data is returned (faster).
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
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      // ── Navigate to Google Maps search ─────────────────────────────────
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/maps/search/${encodedQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 25_000 },
      );

      // Wait for result list panel
      await page
        .waitForSelector('[role="article"], .Nv2PK, div[jstcache*="results"]', {
          timeout: 10_000,
        })
        .catch(() => { /* proceed even if selector times out */ });

      // ── Pagination: scroll/navigate to the requested page ─────────────
      // Google Maps uses infinite scroll on the left panel — each "page" is
      // achieved by scrolling the results div and clicking the next-page arrow.
      if (pageNumber > 1) {
        for (let p = 1; p < pageNumber; p++) {
          // Scroll the results list to the bottom to trigger lazy loading
          await page.evaluate(() => {
            const panel = document.querySelector('[role="main"] [role="feed"], .m6QErb[role="region"]');
            if (panel) panel.scrollTop = panel.scrollHeight;
          });
          await page.waitForTimeout?.(2000).catch(() => new Promise((r) => setTimeout(r, 2000)));

          // Try clicking the "Next page" arrow button
          const nextClicked = await page.evaluate(() => {
            const btns = Array.from(
              document.querySelectorAll<HTMLButtonElement>('button[aria-label="Next page"]'),
            );
            const btn = btns.find((b) => !b.disabled);
            if (btn) { btn.click(); return true; }
            return false;
          });

          if (!nextClicked) {
            // No next-page button — just keep scrolling
            await page.evaluate(() => {
              const panel = document.querySelector('[role="main"] [role="feed"], .m6QErb[role="region"]');
              if (panel) panel.scrollTop = panel.scrollHeight;
            });
            await new Promise((r) => setTimeout(r, 2500));
          } else {
            await page
              .waitForSelector('[role="article"], .Nv2PK', { timeout: 8_000 })
              .catch(() => { /* ignore */ });
          }
        }
      }

      // ── Check captcha ─────────────────────────────────────────────────
      const hasCaptcha = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) {
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      // ── Total results text (e.g. "About 120 results") ─────────────────
      const totalResultsText = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.UbUub');
        return el?.innerText?.trim() || null;
      });

      // ── Has next page ─────────────────────────────────────────────────
      const hasNextPage = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
        return btn ? !btn.disabled : false;
      });

      // ── Extract card list ─────────────────────────────────────────────
      if (!deepScrape) {
        // Fast path: just parse the list panel cards
        const cardData = await page.evaluate(extractResultCards);

        // Enrich cards with lat/lng/placeId from their mapsUrl
        const results: PlaceResult[] = cardData.map((c: ReturnType<typeof extractResultCards>[number]) => {
          const coordMatch = c.mapsUrl?.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
          const placeIdMatch = c.mapsUrl?.match(/place\/[^/]+\/([^/]+)/);
          return {
            ...c,
            phone: null,
            website: null,
            todaysHours: null,
            weeklyHours: null,
            description: null,
            photosCount: null,
            placeId: placeIdMatch ? placeIdMatch[1] : null,
            lat: coordMatch ? parseFloat(coordMatch[1]) : null,
            lng: coordMatch ? parseFloat(coordMatch[2]) : null,
            hasPopularTimes: false,
            isClaimed: null,
            amenities: [],
            relatedPlaces: [],
          };
        });

        workerCdpFailures.delete(browser.workerId);
        return { query, page: pageNumber, results, hasNextPage, totalResultsText };
      }

      // ── Deep scrape: click into each place card ───────────────────────
      const articleHandles: any[] = await page.$$('[role="article"], .Nv2PK');
      const results: PlaceResult[] = [];

      for (const handle of articleHandles) {
        try {
          // Click the card to open the side panel
          await handle.click();
          await page
            .waitForSelector('h1.DUwDvf, h1, .DUwDvf', { timeout: 8_000 })
            .catch(() => { /* ignore */ });

          // Try to expand hours
          await page.evaluate(() => {
            const hoursBtn = document.querySelector<HTMLElement>(
              'button[data-item-id="oh"], [aria-label*="hours"], .t39EBf button',
            );
            if (hoursBtn) hoursBtn.click();
          });
          await new Promise((r) => setTimeout(r, 600));

          const placeData = await page.evaluate(extractPlaceFromPanel);
          results.push(placeData);
        } catch (e) {
          console.warn('⚠️ Failed to extract place detail:', (e as Error).message);
        }

        // Go back to the list panel
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => { /* ignore */ });
        await page
          .waitForSelector('[role="article"], .Nv2PK', { timeout: 8_000 })
          .catch(() => { /* ignore */ });
      }

      workerCdpFailures.delete(browser.workerId);
      return { query, page: pageNumber, results, hasNextPage, totalResultsText };

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
            `🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive CDP failures — evicting from pool.`,
          );
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
