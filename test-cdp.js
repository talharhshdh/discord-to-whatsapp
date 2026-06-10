import puppeteer from 'puppeteer-core';

let browserPromise = null;
let cachedPage = null;
const browserWSEndpoint = 'wss://figured-fat-mathematical-measurement.trycloudflare.com/';

async function getBrowser() {
  if (browserPromise) {
    console.log(`[${new Date().toISOString()}] Using cached browser connection`);
    return browserPromise;
  }
  
  const connectStart = Date.now();
  console.log(`[${new Date().toISOString()}] Connecting to CDP URL: ${browserWSEndpoint}`);
  
  browserPromise = puppeteer.connect({
    browserWSEndpoint: browserWSEndpoint,
    defaultViewport: { width: 160, height: 120 }
  }).then(browser => {
    console.log(`[${new Date().toISOString()}] Connected successfully in ${Date.now() - connectStart}ms`);
    return browser;
  }).catch(err => {
    browserPromise = null;
    throw err;
  });
  
  return browserPromise;
}

async function getPage(browser) {
  if (cachedPage) {
    return cachedPage;
  }
  
  const pageStart = Date.now();
  cachedPage = await browser.newPage();
  
  cachedPage.on('close', () => {
    cachedPage = null;
  });

  // Enable native browser cache
  await cachedPage.setCacheEnabled(true);

  // Enable JavaScript natively
  await cachedPage.setJavaScriptEnabled(true);

  // Set standard User-Agent
  await cachedPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Block useless assets natively
  const client = await cachedPage.target().createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.setBlockedURLs', {
    urls: [
      '*.css',
      '*.png',
      '*.jpg',
      '*.jpeg',
      '*.gif',
      '*.svg',
      '*.woff2',
      '*.woff',
      '*.ttf',
      '*analytics*',
      '*telemetry*',
      '*gen_204*',
      '*doubleclick*',
      '*adservice*'
    ]
  });
  await client.detach();
  
  // Warm up and set page origin to www.google.com (bypasses CORS block on evaluate fetch)
  console.log(`[${new Date().toISOString()}] Setting page origin to www.google.com...`);
  await cachedPage.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});

  console.log(`[${new Date().toISOString()}] Page created in ${Date.now() - pageStart}ms`);
  return cachedPage;
}

async function handleRequest(requestNum, query) {
  const reqStart = Date.now();
  console.log(`\n[${new Date().toISOString()}] --- Starting Request ${requestNum} ---`);
  
  const browser = await getBrowser();
  const page = await getPage(browser);

  try {
    console.log(`[${new Date().toISOString()}] Navigating to Google Search for "${query}"...`);
    const navStart = Date.now();
    
    // Perform same-origin fetch to Google Search (avoids CORS block and navigates in ~380ms)
    const title = await page.evaluate(async (q) => {
      try {
        const resp = await fetch(`/search?q=${encodeURIComponent(q)}&gbv=1`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          }
        });
        const html = await resp.text();
        const match = html.match(/<title>(.*?)<\/title>/i);
        return match ? match[1] : 'No Title Found';
      } catch (err) {
        return 'Fetch Error: ' + err.message;
      }
    }, query);
    
    console.log(`[${new Date().toISOString()}] Navigated in ${Date.now() - navStart}ms`);
    console.log(`[${new Date().toISOString()}] Page title: "${title}"`);
  } finally {
    console.log(`[${new Date().toISOString()}] Request ${requestNum} finished in ${Date.now() - reqStart}ms`);
  }
}

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting script...`);

  try {
    // Request 1: Performs a search query for kitten
    await handleRequest(1, 'kitten');

    // Request 2: Performs a search query for puppy
    await handleRequest(2, 'puppy');

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error occurred:`, error);
  } finally {
    if (cachedPage) {
      console.log('\nClosing cached page...');
      await cachedPage.close().catch(() => {});
    }
    if (browserPromise) {
      console.log('Disconnecting cached browser...');
      const closeStart = Date.now();
      try {
        const browser = await browserPromise;
        await browser.disconnect();
      } catch {}
      console.log(`Disconnected in ${Date.now() - closeStart}ms`);
    }
    console.log(`Total execution time: ${Date.now() - startTime}ms`);
  }
}

main();
