/**
 * test-google-places-search.ts
 *
 * Tests google-places-search.ts (searchPlacesStream) directly against a
 * live browser via the Cloudflare tunnel URL.
 *
 * Usage:
 *   BROWSER_BASE_URL=https://xxx.trycloudflare.com TEST_QUERY="banks in rawalpindi" \
 *     node src/libs/test-google-places-search.ts
 *
 * Or just run as-is — defaults are set below.
 */

import { browserPool } from './browser-pool';
import { searchPlacesStream } from './google-places-search';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BROWSER_URL = (process.env.BROWSER_BASE_URL ?? 'https://edwards-supervisors-admitted-browse.trycloudflare.com').trim();
const TEST_QUERY = process.env.TEST_QUERY ?? 'pizza places in NY';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log(' test-google-places-search.ts');
  console.log('='.repeat(60));
  console.log(`Browser URL : ${BROWSER_URL}`);
  console.log(`Query       : ${TEST_QUERY}`);
  console.log('='.repeat(60));

  // Register the browser into the pool exactly as a real worker would
  const WORKER_ID = 'test-worker-manual';
  browserPool.register(WORKER_ID, BROWSER_URL);
  console.log(`✅ Registered "${WORKER_ID}" → pool`);
  console.log();

  const allCards: any[] = [];
  let batchCount = 0;

  const start = Date.now();

  await searchPlacesStream(TEST_QUERY, (event) => {
    if (event.type === 'batch') {
      batchCount++;
      const cards = event.cards ?? [];
      allCards.push(...cards);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      console.log(
        `📦 Batch #${batchCount} | round=${event.round} | +${cards.length} new | total=${event.total} | ${elapsed}s`,
      );

      // Print each card name on one line
      for (const c of cards) {
        const rating = c.rating != null ? `⭐${c.rating}` : '–';
        const reviews = c.reviewCount != null ? `(${c.reviewCount})` : '';
        const addr = c.address ? ` | ${c.address.slice(0, 50)}` : '';
        console.log(`   • ${c.name}  ${rating}${reviews}${addr}`);
      }
      console.log();

    } else if (event.type === 'done') {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log('='.repeat(60));
      console.log(`✅ DONE — ${event.total} total cards in ${elapsed}s (reachedEnd=${event.reachedEnd})`);
      console.log(`   ${batchCount} batches emitted`);

      // Field coverage
      const r = allCards.filter(c => c.rating != null).length;
      const a = allCards.filter(c => c.address != null).length;
      const l = allCards.filter(c => c.lat != null).length;
      const o = allCards.filter(c => c.openNow != null).length;
      const p = allCards.filter(c => c.placeId != null).length;
      const d = allCards.filter(c => c.description != null).length;
      const n = allCards.length;
      console.log();
      console.log('  Field coverage:');
      console.log(`   Rating      : ${r}/${n}`);
      console.log(`   Address     : ${a}/${n}`);
      console.log(`   Lat/Lng     : ${l}/${n}`);
      console.log(`   OpenNow     : ${o}/${n}`);
      console.log(`   PlaceId     : ${p}/${n}`);
      console.log(`   Description : ${d}/${n}`);
      console.log('='.repeat(60));

    } else if (event.type === 'error') {
      console.error(`❌ Error: ${event.message}`);
    }
  });

  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
