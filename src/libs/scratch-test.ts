import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BROWSER_URL = 'https://critics-historical-stability-invited.trycloudflare.com';

async function main() {
  // Fetch the WebSocket URL from the remote browser
  const res = await fetch(`${BROWSER_URL}/json/version`);
  const info = await res.json();
  const wsPath = new URL(info.webSocketDebuggerUrl).pathname;
  const wsUrl = BROWSER_URL.replace('https://', 'wss://') + wsPath;

  console.log('WS:', wsUrl);

  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0]; // reuse the existing open tab

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

  // ⚡ OPTIMIZATION 1: Intercept network requests to speed up load time
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    // Block heavy resources, but strictly ALLOW 'stylesheet' so Maps layout height is 
    // calculated correctly for the infinite scroller to trigger.
    if (['image', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log('Navigating to Google Maps...');
  await page.goto('https://www.google.com/maps/search/pizza+places+in+NY', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });

  await page.waitForSelector('[role="feed"]');
  console.log('✅ Navigated — page:', page.url());

  // ⚡ OPTIMIZATION 2 & THE FIX: Scroll the container directly using fast polling
  const childrenHTML = await page.evaluate(async () => {
    const feed = document.querySelector('[role="feed"]');

    if (!feed) {
      throw new Error("Feed not found");
    }

    let previousCount = 0;
    let retries = 0;
    const MAX_RETRIES = 30; // 3 seconds max wait time (30 * 100ms) for new items to load

    while (true) {
      const cards = feed.querySelectorAll('[role="article"]');
      const currentCount = cards.length;

      if (currentCount === previousCount) {
        // No new cards yet, increment our retry counter
        retries++;
        if (retries >= MAX_RETRIES) {
          break; // We hit the absolute bottom of the map results
        }
      } else {
        // We found new cards! Reset the retry counter.
        retries = 0;
        previousCount = currentCount;
      }

      // ⚡ Force the container to scroll to its absolute bottom, pushing the invisible 
      // loading spinner into the browser's view to trigger the next data fetch.
      feed.scrollTop = feed.scrollHeight;

      // Brief 100ms pause to poll the DOM again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log("Scrolled through all cards");

    // Extract and return the HTML directly
    return Array.from(feed.children).map((el) => el.outerHTML);
  });

  // Save as a single HTML file
  const htmlContent = childrenHTML.join("\n\n");
  fs.writeFileSync("./data.html", htmlContent, "utf8");

  console.log(`✅ Saved ${childrenHTML.length} elements to data.html`);

  await browser.disconnect();
}

main().catch(console.error);