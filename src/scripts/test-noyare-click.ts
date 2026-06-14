import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
import puppeteer from 'puppeteer-core';

// Load local .env variables
dotenv.config();

const PROD_DOMAIN = process.env.DASHBOARD_DOMAIN || 'services.ufone-claim.site';
const USERNAME = process.env.DASHBOARD_USERNAME;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!PROD_DOMAIN || !USERNAME || !PASSWORD) {
  console.error("❌ Error: Missing DASHBOARD_DOMAIN, DASHBOARD_USERNAME, or DASHBOARD_PASSWORD in .env file.");
  process.exit(1);
}

const PROD_URL = PROD_DOMAIN.startsWith('http') ? PROD_DOMAIN : `https://${PROD_DOMAIN}`;
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

async function runTest() {
  console.log(`📡 Fetching browser pool from: ${PROD_URL}...`);
  try {
    const poolResp = await fetch(`${PROD_URL}/api/browsers/pool`, {
      headers: { 'Authorization': AUTH_HEADER }
    });

    if (!poolResp.ok) {
      throw new Error(`Failed to fetch browser pool. HTTP status ${poolResp.status}`);
    }

    const poolData = await poolResp.json() as any;
    console.log(`📊 Total workers: ${poolData.total}, Active: ${poolData.active}`);

    const activeWorkers = poolData.browsers.filter((b: any) => b.status === 'active');
    if (activeWorkers.length === 0) {
      console.error("❌ No active workers found in the pool. Make sure the worker fleet is running.");
      process.exit(1);
    }

    const worker = activeWorkers[0];
    console.log(`\nSelected Worker:`);
    console.log(`- ID: ${worker.workerId}`);
    console.log(`- CDP URL: ${worker.cdpUrl}`);

    // Get CDP WebSocket URL
    console.log(`📡 Fetching WebSocket URL from ${worker.cdpUrl}/json/version...`);
    const versionResp = await fetch(`${worker.cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!versionResp.ok) {
      throw new Error(`Failed to fetch version info: HTTP ${versionResp.status}`);
    }
    const versionInfo = await versionResp.json() as any;
    const rawWsUrl = versionInfo.webSocketDebuggerUrl;
    if (!rawWsUrl) {
      throw new Error('No webSocketDebuggerUrl found in version info');
    }

    const tunnelHost = new URL(worker.cdpUrl).host;
    const wsUrl = rawWsUrl.replace(/^ws:\/\/[^/]+/, `wss://${tunnelHost}`);
    console.log(`🔌 Connecting Puppeteer to: ${wsUrl}`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Enable request interception
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();

      if (type === 'document') {
        req.continue().catch(() => {});
        return;
      }

      // Block heavy assets/telemetry/scripts to speed up Google load
      if (
        ['image', 'media', 'font', 'stylesheet', 'websocket', 'manifest', 'other'].includes(type) ||
        ['script', 'xhr', 'fetch'].includes(type) ||
        url.includes('gen_204') || url.includes('/log?') || url.includes('google-analytics')
      ) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    const query = '"noyare" pc tool site:talhary.github.io/noyare-home/';
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=0&num=10&hl=en&gbv=2&pws=0`;
    console.log(`🌐 Navigating to Google Search: ${googleUrl}`);
    await page.goto(googleUrl, { waitUntil: 'domcontentloaded' });

    console.log("⏳ Waiting for page load...");
    await page.waitForSelector('h3, a[href*="/url?q="], footer', { timeout: 10000 }).catch(() => {});

    // Save screenshot of search results
    const screenshotDir = join(process.cwd(), 'artifacts');
    mkdirSync(screenshotDir, { recursive: true });
    
    const searchScreenshotPath = join(screenshotDir, 'noyare_search_results.png');
    const searchScreenshot = await page.screenshot({ fullPage: true });
    writeFileSync(searchScreenshotPath, searchScreenshot);
    console.log(`📸 Search results screenshot saved to: ${searchScreenshotPath}`);

    const html = await page.content();
    writeFileSync(join(screenshotDir, 'noyare_search_results.html'), html);
    console.log(`📄 Search results HTML saved.`);

    // Find links matching selector and filter out Google internal links
    const targetLinkSelector = await page.evaluate(() => {
      const decodeGoogleLink = (href: string | null): string => {
        if (!href) return '';
        try {
          if (href.startsWith('/url?q=')) {
            const urlPart = href.split('/url?q=')[1]?.split('&')[0];
            if (urlPart) return decodeURIComponent(urlPart);
          } else if (href.startsWith('/url?url=')) {
            const urlPart = href.split('/url?url=')[1]?.split('&')[0];
            if (urlPart) return decodeURIComponent(urlPart);
          }
        } catch (e) {}
        return href;
      };

      const els = Array.from(document.querySelectorAll('a[href*="talhary.github.io"], a[href*="noyare-home"]'));
      for (const el of els) {
        const href = el.getAttribute('href') || '';
        const decoded = decodeGoogleLink(href);
        if (
          (decoded.includes('talhary.github.io') || decoded.includes('noyare-home')) &&
          !decoded.includes('google.com') &&
          !decoded.includes('/search?') &&
          !href.startsWith('/search?')
        ) {
          el.setAttribute('data-target-noyare-link', 'true');
          return 'a[data-target-noyare-link="true"]';
        }
      }
      return null;
    });

    console.log(`\n🎯 Selected target link selector: ${targetLinkSelector}`);

    if (!targetLinkSelector) {
      console.error("❌ No target link found for Noyare PC Tool (after filtering out Google links)!");
      await page.close();
      await browser.disconnect();
      return;
    }

    const rawHref = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute('href') : null;
    }, targetLinkSelector);

    const decodeGoogleLink = (href: string | null): string => {
      if (!href) return '';
      try {
        if (href.startsWith('/url?q=')) {
          const urlPart = href.split('/url?q=')[1]?.split('&')[0];
          if (urlPart) return decodeURIComponent(urlPart);
        } else if (href.startsWith('/url?url=')) {
          const urlPart = href.split('/url?url=')[1]?.split('&')[0];
          if (urlPart) return decodeURIComponent(urlPart);
        }
      } catch (e) {}
      return href;
    };

    const targetUrl = decodeGoogleLink(rawHref);
    console.log(`🎯 Decoded Target URL: ${targetUrl}`);

    // Update interception to ALLOW scripts and pages
    console.log("🔄 Updating request interception to allow target site loading...");
    page.removeAllListeners('request');
    page.on('request', (req) => {
      // Allow all on target site
      req.continue().catch(() => {});
    });

    let navigated = false;

    // 1. Try Puppeteer's click first
    try {
      console.log(`\n👉 Attempting click on ${targetLinkSelector} via Puppeteer click...`);
      await Promise.all([
        page.click(targetLinkSelector),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
      ]);
      navigated = true;
      console.log(`✅ Navigated successfully via page.click!`);
    } catch (clickErr: any) {
      console.warn(`⚠️ Puppeteer click failed: ${clickErr.message}`);
    }

    // 2. Try DOM click fallback
    if (!navigated) {
      try {
        console.log(`👉 Attempting click via DOM-level click...`);
        await Promise.all([
          page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) el.click();
          }, targetLinkSelector),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
        ]);
        navigated = true;
        console.log(`✅ Navigated successfully via DOM click!`);
      } catch (domClickErr: any) {
        console.warn(`⚠️ DOM click fallback failed: ${domClickErr.message}`);
      }
    }

    // 3. Try direct navigation fallback
    if (!navigated && targetUrl) {
      try {
        console.log(`👉 Attempting direct navigation fallback to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        navigated = true;
        console.log(`✅ Navigated successfully via page.goto!`);
      } catch (gotoErr: any) {
        console.error(`❌ Direct navigation fallback failed: ${gotoErr.message}`);
      }
    }

    if (navigated) {
      console.log(`\n🌍 Final URL: ${page.url()}`);
      const siteScreenshotPath = join(screenshotDir, 'noyare_target_site.png');
      const siteScreenshot = await page.screenshot({ fullPage: true });
      writeFileSync(siteScreenshotPath, siteScreenshot);
      console.log(`📸 Target site screenshot saved to: ${siteScreenshotPath}`);
    } else {
      console.error("\n❌ All navigation attempts failed!");
    }

    await page.close();
    await browser.disconnect();
    console.log("🏁 Test completed.");
  } catch (err: any) {
    console.error("❌ Test error:", err);
  }
}

runTest();
