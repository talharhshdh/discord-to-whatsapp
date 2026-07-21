import { browserPool } from '../libs/browser-pool';

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

async function testWorkerApi() {
  await syncRemotePool();
  const active = browserPool.getActive();
  console.log(`Active workers: ${active.length}`);

  for (const b of active) {
    if (!b.apiUrl) {
      console.log(`Worker ${b.workerId} has no apiUrl, skipping...`);
      continue;
    }

    console.log(`\nTesting UC Mode on Worker: ${b.workerId} via apiUrl: ${b.apiUrl}...`);
    try {
      const targetUrl = 'https://www.google.com/search?q=dentist+in+london&hl=en';
      const t0 = Date.now();
      const res = await fetch(`${b.apiUrl}/get_html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      console.log(`Response Status: ${res.status} in ${Date.now() - t0} ms`);
      if (res.ok) {
        const json = await res.json();
        const html = json.html || '';
        const hasCaptcha = html.includes('/sorry/') || html.includes('captcha') || html.includes('g-recaptcha');
        console.log(`Contains CAPTCHA: ${hasCaptcha}`);
        
        // Count h3 tags in returned HTML
        const h3Match = html.match(/<h3/g);
        console.log(`h3 matches count: ${h3Match ? h3Match.length : 0}`);
        if (!hasCaptcha && h3Match && h3Match.length > 0) {
          console.log(`✅ SUCCESS on worker ${b.workerId}!`);
          break;
        }
      } else {
        const errText = await res.text();
        console.error(`API Error: ${errText}`);
      }
    } catch (err: any) {
      console.error(`Fetch error for ${b.workerId}:`, err.message);
    }
  }
}

testWorkerApi();
