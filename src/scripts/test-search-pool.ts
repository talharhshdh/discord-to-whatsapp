import { browserPool, searchViaPool } from '../libs/browser-pool';

/**
 * Fetch and register remote active browsers from the API pool endpoint.
 */
async function syncRemotePool() {
  const poolUrl = 'https://services.ufone-claim.site/api/browsers/pool';
  const headers = {
    'accept': '*/*',
    'accept-language': 'en-GB,en;q=0.9,en-US;q=0.8',
    'authorization': 'Basic ZGtna2xmZGdsa2RmZ2xqZmQ6c2Rsa2ZzZGxnbGtka2w0bXQ=',
    'cookie': 'ph_phc_yJW1VjHGGwmCbbrtczfqqNxgBDbhlhOWcdzcIJEOTFE_posthog=%7B%22%24device_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22distinct_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22%24sesid%22%3A%5B1776323359174%2C%22019d9512-7294-71a8-bb9d-be99b19ca3e0%22%2C1776322507393%5D%2C%22%24initial_person_info%22%3A%7B%22r%22%3A%22%24direct%22%2C%22u%22%3A%22https%3A%2F%2Flinkwell.ufone-claim.site%2F%22%7D%2C%22%24user_state%22%3A%22anonymous%22%7D; dashboard_token=ZGtna2xmZGdsa2RmZ2xqZmQ6c2Rsa2ZzZGxnbGtka2w0bXQ=',
    'Referer': 'https://services.ufone-claim.site/'
  };

  try {
    console.log(`🌐 Syncing remote browsers from ${poolUrl}...`);
    const res = await fetch(poolUrl, { headers });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data.browsers && Array.isArray(data.browsers)) {
      let registered = 0;
      for (const b of data.browsers) {
        if (b.cdpUrl && b.status === 'active') {
          browserPool.register(b.workerId, b.cdpUrl, b.runId, true, b.apiUrl);
          registered++;
        }
      }
      console.log(`✅ Successfully synced ${registered} active remote browsers into local BrowserPool.`);
    }
  } catch (err: any) {
    console.error('❌ Remote pool sync error:', err.message);
  }
}

async function testSearchPool() {
  await syncRemotePool();

  const activeCount = browserPool.getActive().length;
  console.log(`\n🏊 Active Browsers Pool Count: ${activeCount}`);
  if (activeCount === 0) {
    console.error('❌ No active browsers available in pool. Exiting test.');
    return;
  }

  // 1. Test Regular Search
  console.log('\n--- 🔍 Test 1: Organic Search ("dentist in london") ---');
  const t0 = Date.now();
  const searchResult = await searchViaPool('dentist in london', 1, false, 'all');
  console.log(`⚡ Search completed in ${Date.now() - t0} ms`);

  if (!searchResult) {
    console.error('❌ searchViaPool returned null');
  } else {
    console.log(`📊 Organic Results Found: ${searchResult.organic.length}`);
    if (searchResult.organic.length > 0) {
      console.log('Top 3 Results:');
      searchResult.organic.slice(0, 3).forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.title}`);
        console.log(`     Link: ${item.link}`);
        console.log(`     Snippet: ${item.snippet}\n`);
      });
    }
  }

  // 2. Test News Search
  console.log('\n--- 📰 Test 2: News Search ("tech news") ---');
  const t1 = Date.now();
  const newsResult = await searchViaPool('tech news', 1, false, 'news');
  console.log(`⚡ News search completed in ${Date.now() - t1} ms`);
  if (newsResult && newsResult.news) {
    console.log(`📊 News Results Found: ${newsResult.news.length}`);
    if (newsResult.news.length > 0) {
      console.log('Top News Item:', newsResult.news[0]);
    }
  }
}

testSearchPool();
