import { browserPool } from '../libs/browser-pool';
import { acquirePage, releasePage } from '../libs/page-pool';

async function syncRemotePool() {
  const poolUrl = 'https://services.ufone-claim.site/api/browsers/pool';
  const headers = {
    'accept': '*/*',
    'accept-language': 'en-GB,en;q=0.9,en-US;q=0.8',
    'authorization': 'Basic ZGtna2xmZGdsa2RmZ2xqZmQ6c2Rsa2ZzZGxnbGtka2w0bXQ=',
    'cookie': 'ph_phc_yJW1VjHGGwmCbbrtczfqqNxgBDbhlhOWcdzcIJEOTFE_posthog=%7B%22%24device_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22distinct_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22%24sesid%22%3A%5B1776323359174%2C%22019d9512-7294-71a8-bb9d-be99b19ca3e0%22%2C1776322507393%5D%2C%22%24initial_person_info%22%3A%7B%22r%22%3A%22%24direct%22%2C%22u%22%3A%22https%3A%2F%2Flinkwell.ufone-claim.site%2F%22%7D%2C%22%24user_state%22%3A%22anonymous%22%7D; dashboard_token=ZGtna2xmZGdsa2RmZ2xqZmQ6c2Rsa2ZzZGxnbGtka2w0bXQ=',
    'Referer': 'https://services.ufone-claim.site/'
  };

  const res = await fetch(poolUrl, { headers });
  const data = await res.json();
  if (data.browsers && Array.isArray(data.browsers)) {
    for (const b of data.browsers) {
      if (b.cdpUrl && b.status === 'active') {
        browserPool.register(b.workerId, b.cdpUrl, b.runId, true, b.apiUrl);
      }
    }
  }
}

async function testNoGbvWithInterception() {
  const browser = browserPool.getNext();
  if (!browser) return;
  console.log(`\n--- Testing ${browser.workerId} without &gbv=2 with asset blocking ---`);
  const { conn, page } = await acquirePage(browser, true);

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    page.removeAllListeners('request');
    await page.setRequestInterception(true);
    page.on('request', async (req: any) => {
      try {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const url = req.url();
        if (type === 'document') {
          await req.continue();
          return;
        }
        if (['font', 'stylesheet', 'media', 'websocket', 'manifest'].includes(type)) {
          await req.abort();
          return;
        }
        if (url.includes('google-analytics') || url.includes('gen_204') || url.includes('/log?')) {
          await req.abort();
          return;
        }
        await req.continue();
      } catch {}
    });

    const url = 'https://www.google.com/search?q=dentist+in+london&hl=en&num=10';
    console.log(`Navigating to ${url}...`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`Response status: ${resp?.status()}`);
    console.log(`Page URL: ${page.url()}`);
    const html = await page.content();
    const hasCaptcha = html.includes('/sorry/') || html.includes('captcha') || html.includes('g-recaptcha');
    console.log(`Contains CAPTCHA: ${hasCaptcha}`);
    const h3Count = await page.evaluate(() => document.querySelectorAll('h3').length);
    console.log(`h3 count: ${h3Count}`);

    const organic = await page.evaluate(() => {
      const results: any[] = [];
      document.querySelectorAll('h3').forEach((h3) => {
        const a = h3.closest('a');
        if (a) {
          results.push({
            title: h3.innerText?.trim(),
            link: a.getAttribute('href'),
          });
        }
      });
      return results;
    });

    console.log('Organic results extracted:', organic.length);
    if (organic.length > 0) {
      console.log('First 2 items:', organic.slice(0, 2));
    }

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await releasePage(conn, page, true);
  }
}

async function main() {
  await syncRemotePool();
  await testNoGbvWithInterception();
}

main();
