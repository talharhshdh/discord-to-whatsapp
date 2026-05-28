/**
 * test-places-search.ts
 *
 * Standalone test script for the Google Maps Places scraper.
 * Connects directly to a remote Puppeteer CDP endpoint (no pool machinery),
 * runs the fixed extractResultCards / scroll logic, and prints results.
 *
 * Run:
 *   npx ts-node src/libs/test-places-search.ts
 *
 * Env vars (optional – falls back to defaults below):
 *   BROWSER_WS_URL  – CDP websocket URL (auto-fetched from /json/version)
 *   TEST_QUERY      – search query to use
 */

import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLOUDFLARE_BASE = process.env.BROWSER_BASE_URL ?? 'https://demographic-means-basket-professional.trycloudflare.com';
const TEST_QUERY = process.env.TEST_QUERY ?? 'Software houses in Rawalpindi';
const MAX_SCROLL_ROUNDS = 20;
const SCROLL_WAIT_MS = 2_500;

// ---------------------------------------------------------------------------
// Types (mirrored from google-places-search.ts)
// ---------------------------------------------------------------------------

interface CardData {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  openNow: boolean | null;
  openStatus: string | null;  // full hours string e.g. "Open · Closes 5 AM"
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
  firstReview: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCdpWsUrl(base: string): Promise<string> {
  const versionUrl = `${base}/json/version`;
  console.log(`🔌 Fetching CDP info from ${versionUrl}`);
  const res = await fetch(versionUrl);
  if (!res.ok) throw new Error(`Failed to fetch /json/version: ${res.status}`);
  const json = await res.json() as { webSocketDebuggerUrl?: string };
  const ws = json.webSocketDebuggerUrl;
  if (!ws) throw new Error('No webSocketDebuggerUrl in /json/version response');
  // Replace the host with the cloudflare tunnel host (CDP WS may expose localhost)
  const fixedWs = ws.replace(/ws:\/\/[^/]+/, `wss://${new URL(base).host}`);
  console.log(`✅ CDP WS URL: ${fixedWs}`);
  return fixedWs;
}

/** In-browser function: extract all data from cards currently in the feed */
function extractAllCards(): CardData[] {
  const cards: CardData[] = [];
  const seen = new Set<string>();

  document.querySelectorAll<HTMLElement>('[role="article"]').forEach((card) => {
    // ── Name ──────────────────────────────────────────────────────────────
    const name = card.querySelector<HTMLElement>('.qBF1Pd')?.innerText?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);

    // ── Link + coordinates + place ID ─────────────────────────────────────
    const linkEl = card.querySelector<HTMLAnchorElement>('a.hfpxzc, a[href*="maps/place"]');
    const mapsUrl = linkEl?.href || null;

    // lat/lng are encoded in the data parameter as !3d<lat>!4d<lng>
    const latMatch = mapsUrl?.match(/!3d(-?\d+\.\d+)/);
    const lngMatch = mapsUrl?.match(/!4d(-?\d+\.\d+)/);
    const lat = latMatch ? parseFloat(latMatch[1]) : null;
    const lng = lngMatch ? parseFloat(lngMatch[1]) : null;

    // placeId: the hex address pair in the data= section
    const placeIdMatch = mapsUrl?.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
    const placeId = placeIdMatch ? placeIdMatch[0] : null;

    // ── Rating + Reviews ──────────────────────────────────────────────────
    const ratingRowText = card.querySelector<HTMLElement>('.AJB7ye')?.textContent?.trim() ?? '';
    const ratingEl = card.querySelector('.MW4etd');
    const rating = ratingEl ? parseFloat(ratingEl.textContent?.trim() || '') : null;

    const reviewEl = card.querySelector('.UY7F9');
    const reviewText = reviewEl ? reviewEl.textContent?.replace(/[()]/g, '').trim() : '';
    const reviewCount = reviewText ? parseInt(reviewText.replace(/,/g, ''), 10) : null;

    // Price level: dollar sign(s) or range like "$20–70" → pick $ symbols
    const priceM = ratingRowText.match(/·\s*(\$+|\$[\d,–]+)/);
    const priceLevel = priceM ? priceM[1] : null;

    // ── Info lines via .W4Efsd hierarchy ─────────────────────────────────
    const outerW4 = card.querySelector<HTMLElement>('.W4Efsd .W4Efsd');
    const infoRows = outerW4
      ? Array.from(outerW4.parentElement?.querySelectorAll<HTMLElement>(':scope > .W4Efsd') ?? [])
      : [];

    // Category: first token in row 0 before the · separator
    const row0Text = infoRows[0]?.innerText?.trim() ?? '';
    // Remove accessibility icons / dots, get first segment
    const categoryM = row0Text.split(/·/)[0]?.trim().replace(/\s+/g, ' ');
    const category = categoryM || null;

    // Address: last segment of row 0 after last ·
    const row0Parts = row0Text.split('·');
    const address = row0Parts.length > 1 ? row0Parts[row0Parts.length - 1].trim() || null : null;

    // ── Phone ───────────────────────────────────────────────────────────
    const phone = card.querySelector('.UsdlK')?.textContent?.trim() || null;

    // ── Website ─────────────────────────────────────────────────────────
    const websiteEl = card.querySelector<HTMLAnchorElement>('a[data-value="Website"], a[aria-label*="website"], a[aria-label*="Website"]');
    const website = websiteEl?.href || null;

    // ── First Review ────────────────────────────────────────────────────
    const reviewRaw = card.querySelector('.ah5Ghc, .Ahnjwc')?.textContent?.trim() || null;
    const firstReview = reviewRaw ? reviewRaw.replace(/^["'“”]|["'“”]$/g, '').trim() : null;

    // Find description and open-status from remaining rows
    let description: string | null = null;
    let openStatus: string | null = null;
    let openNow: boolean | null = null;

    for (let i = 1; i < infoRows.length; i++) {
      const rowText = infoRows[i]?.innerText?.trim() ?? '';
      const coloredSpan = infoRows[i]?.querySelector<HTMLElement>('span[style*="color"]');
      const colorStyle = coloredSpan?.getAttribute('style') ?? '';

      if (coloredSpan && (colorStyle.includes('25,134,57') || colorStyle.includes('220,54,46'))) {
        // Open/closed row detected via inline color style
        openStatus = rowText;
        openNow = colorStyle.includes('25,134,57'); // green = open
      } else if (rowText && !description) {
        description = rowText;
      }
    }

    cards.push({
      name,
      rating,
      reviewCount,
      priceLevel,
      category,
      address,
      phone,
      website,
      description,
      openNow,
      openStatus,
      mapsUrl,
      lat,
      lng,
      placeId,
      firstReview,
    });
  });

  return cards;
}

/** Scroll the [role="main"] panel to load more results, returns true while new cards appear */
async function scrollFeedForMore(page: Page): Promise<{ loaded: number; total: number; reachedEnd: boolean }> {
  let prevHeight = 0;
  let stableRounds = 0;
  let scrollRound = 0;
  const maxRounds = 120;
  const waitMs = 400;

  while (scrollRound < maxRounds) {
    const { count, scrollHeight } = await page.evaluate(() => {
      const el = document.querySelector('[role="main"]')?.firstElementChild?.firstElementChild as HTMLElement;
      if (!el) return { count: 0, scrollHeight: 0 };
      
      // Scroll to the bottom
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      
      return {
        count: document.querySelectorAll('[role="article"]').length,
        scrollHeight: el.scrollHeight
      };
    });

    console.log(`   Scroll ${scrollRound + 1}: ${count} cards visible | scrollHeight=${scrollHeight}`);

    if (scrollHeight === prevHeight) {
      stableRounds++;
      if (stableRounds >= 5) {
        console.log(`   ↳ scrollHeight remained stable at ${scrollHeight} for 5 rounds. Reached end.`);
        return { loaded: count, total: count, reachedEnd: true };
      }
    } else {
      stableRounds = 0;
    }

    prevHeight = scrollHeight;
    scrollRound++;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const finalCount = await page.evaluate(() => document.querySelectorAll('[role="article"]').length);
  return { loaded: finalCount, total: finalCount, reachedEnd: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Google Maps Places Scraper — Direct CDP Test');
  console.log('═══════════════════════════════════════════════════════\n');

  const wsUrl = await resolveCdpWsUrl(CLOUDFLARE_BASE);

  const browser: Browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    defaultViewport: null,
  });

  console.log('🌐 Connected to browser');

  // Re-use the first existing page or open a new one
  const pages = await browser.pages();
  const page: Page = pages[0] ?? await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

  const encodedQuery = encodeURIComponent(TEST_QUERY);
  const mapsUrl = `https://www.google.com/maps/search/${encodedQuery}`;

  console.log(`\n🔍 Navigating to: ${mapsUrl}`);
  await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // ── Detect captcha ───────────────────────────────────────────────────────
  const hasCaptcha = await page.evaluate(() =>
    !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
  );
  if (hasCaptcha) {
    console.error('🚫 CAPTCHA detected — aborting test.');
    await browser.disconnect();
    process.exit(1);
  }

  // ── Initial card count ───────────────────────────────────────────────────
  const initialCount = await page.evaluate(
    () => document.querySelectorAll('[role="article"]').length,
  );
  console.log(`\n📋 Initial cards in view: ${initialCount}`);

  // ── Scroll to load all results ───────────────────────────────────────────
  console.log('\n📜 Scrolling feed to load all results...');
  const scrollResult = await scrollFeedForMore(page);
  console.log(
    `\n✅ Scroll complete — total cards: ${scrollResult.total} | reached end: ${scrollResult.reachedEnd}`,
  );

  // ── Extract all cards ────────────────────────────────────────────────────
  console.log('\n🔎 Extracting card data...');
  const cards: CardData[] = await page.evaluate(extractAllCards);

  // ── Print results ─────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  Results: ${cards.length} places for "${TEST_QUERY}"`);
  console.log(`══════════════════════════════════════════════════════\n`);

  let withRating = 0;
  let withReviews = 0;
  let withCoords = 0;
  let withPlaceId = 0;
  let withOpenStatus = 0;
  let withPrice = 0;
  let withDesc = 0;
  let withPhone = 0;
  let withWebsite = 0;
  let withFirstReview = 0;

  cards.forEach((c, i) => {
    if (c.rating !== null) withRating++;
    if (c.reviewCount !== null) withReviews++;
    if (c.lat !== null) withCoords++;
    if (c.placeId !== null) withPlaceId++;
    if (c.openNow !== null) withOpenStatus++;
    if (c.priceLevel !== null) withPrice++;
    if (c.description !== null) withDesc++;
    if (c.phone !== null) withPhone++;
    if (c.website !== null) withWebsite++;
    if (c.firstReview !== null) withFirstReview++;

    console.log(`[${String(i + 1).padStart(2, '0')}] ${c.name}`);
    console.log(`     Rating: ${c.rating ?? 'N/A'} | Reviews: ${c.reviewCount ?? 'N/A'} | Price: ${c.priceLevel ?? 'N/A'}`);
    console.log(`     Category: ${c.category ?? 'N/A'} | Address: ${c.address ?? 'N/A'}`);
    if (c.description) console.log(`     Desc: ${c.description}`);
    console.log(`     Open: ${c.openNow === null ? 'N/A' : c.openNow ? '✅ Open' : '❌ Closed'} | Status: ${c.openStatus ?? 'N/A'}`);
    console.log(`     Phone: ${c.phone ?? 'N/A'} | Website: ${c.website ?? 'N/A'}`);
    if (c.firstReview) console.log(`     First Review: "${c.firstReview}"`);
    console.log(`     Coords: ${c.lat ?? 'N/A'}, ${c.lng ?? 'N/A'} | PlaceID: ${c.placeId ?? 'N/A'}`);
    console.log(`     URL: ${c.mapsUrl?.substring(0, 80) ?? 'N/A'}...`);
    console.log('');
  });

  console.log('══════════════════════════════════════════════════════');
  console.log('  Field coverage across all cards:');
  console.log(`  Rating:      ${withRating}/${cards.length}`);
  console.log(`  ReviewCount: ${withReviews}/${cards.length}`);
  console.log(`  PriceLevel:  ${withPrice}/${cards.length}`);
  console.log(`  Coordinates: ${withCoords}/${cards.length}`);
  console.log(`  PlaceID:     ${withPlaceId}/${cards.length}`);
  console.log(`  OpenStatus:  ${withOpenStatus}/${cards.length}`);
  console.log(`  Description: ${withDesc}/${cards.length}`);
  console.log(`  Phone:       ${withPhone}/${cards.length}`);
  console.log(`  Website:     ${withWebsite}/${cards.length}`);
  console.log(`  FirstReview: ${withFirstReview}/${cards.length}`);
  console.log('══════════════════════════════════════════════════════\n');

  await browser.disconnect();
  console.log('🏁 Done.\n');
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
