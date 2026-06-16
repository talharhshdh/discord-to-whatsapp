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

function typeIsAd(url: string) {
  return url.includes('pagead') || url.includes('googlesyndication') || url.includes('adservice') || url.includes('doubleclick') || url.includes('n6wxm.com') || url.includes('quge5.com') || url.includes('vignette') || url.includes('tag.min.js');
}

async function evaluateWithTimeout(page: any, fn: () => any, timeoutMs = 5000): Promise<any> {
  let timeoutId: any;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Evaluation timeout')), timeoutMs);
  });
  try {
    return await Promise.race([
      page.evaluate(fn),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runTest() {
  console.log(`📡 Fetching browser pool from: ${PROD_URL}...`);
  let browser: any = null;
  let page: any = null;

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
      console.error("❌ No active workers found in the pool.");
      process.exit(1);
    }

    let connected = false;
    for (const worker of activeWorkers) {
      try {
        console.log(`\nTrying Worker ID: ${worker.workerId}`);
        console.log(`CDP URL: ${worker.cdpUrl}`);

        // Get CDP WebSocket URL
        console.log(`📡 Fetching WebSocket URL from ${worker.cdpUrl}/json/version...`);
        const versionResp = await fetch(`${worker.cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(5000),
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

        browser = await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: null,
        });
        
        connected = true;
        break;
      } catch (connErr: any) {
        console.warn(`⚠️ Connection to worker ${worker.workerId} failed: ${connErr.message || connErr}`);
      }
    }

    if (!connected || !browser) {
      throw new Error("❌ Failed to connect to any active worker in the pool.");
    }

    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // DISABLE request interception completely so standard browser behavior applies.
    // We just listen to events to observe the network requests read-only.
    await page.setRequestInterception(false);

    const requests: any[] = [];
    page.on('request', (req: any) => {
      const url = req.url();
      const type = req.resourceType();
      requests.push({ url, type, status: 'pending' });

      // Log requests of interest
      if (url.includes('google') || url.includes('doubleclick') || url.includes('ads') || url.includes('vercel') || type === 'script') {
        console.log(`[Request] Type: ${type} | URL: ${url.substring(0, 100)}...`);
      }
    });

    page.on('requestfinished', (req: any) => {
      const url = req.url();
      const match = requests.find(r => r.url === url);
      if (match) match.status = 'finished';
    });

    page.on('requestfailed', (req: any) => {
      const url = req.url();
      const err = req.failure()?.errorText || 'unknown';
      const match = requests.find(r => r.url === url);
      if (match) match.status = `failed: ${err}`;
      
      if (url.includes('google') || url.includes('doubleclick') || url.includes('ads') || typeIsAd(url)) {
        console.warn(`⚠️ [Request Failed] URL: ${url.substring(0, 100)}... | Error: ${err}`);
      }
    });

    page.on('console', (msg: any) => {
      const text = msg.text();
      if (text.includes('ad') || text.includes('Ad') || text.includes('blocked') || msg.type() === 'error') {
        console.log(`[Console ${msg.type()}] ${text}`);
      }
    });

    page.on('pageerror', (err: any) => {
      console.error(`[Page Error] ${err.message}`);
    });

    const targetUrl = 'https://talhatech.vercel.app/';
    console.log(`🌐 Navigating directly to target site: ${targetUrl}`);
    
    // Direct navigation, waiting for domcontentloaded.
    // Wrap in try-catch because ad networks (like vignette) can prevent the main page navigation
    // from finishing fires of DOM events, but the HTML/DOM is still accessible.
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (gotoErr: any) {
      console.warn(`⚠️ page.goto warning: ${gotoErr.message}. Continuing to inspect DOM/Network anyway.`);
    }

    console.log("⏳ Page loaded. Waiting 10 seconds for any ads/scripts to execute...");
    await new Promise(r => setTimeout(r, 10000));

    try {
      // Scroll down to trigger lazy loading of ads
      console.log("Scrolling page to trigger lazy loading...");
      await evaluateWithTimeout(page, () => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await new Promise(r => setTimeout(r, 3000));
      await evaluateWithTimeout(page, () => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise(r => setTimeout(r, 3000));

      // Inspect the DOM for Adsense components
      const adsenseReport = await evaluateWithTimeout(page, () => {
        const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src);
        const insElements = Array.from(document.querySelectorAll('ins.adsbygoogle')).map(ins => ({
          id: ins.id,
          className: ins.className,
          style: ins.getAttribute('style'),
          innerHTML: ins.innerHTML,
          hasAdContent: ins.innerHTML.includes('iframe') || ins.innerHTML.includes('svg')
        }));
        const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
          id: f.id,
          src: f.src,
          name: f.name
        }));
        
        const adsbygoogleVar = (window as any).adsbygoogle ? {
          length: (window as any).adsbygoogle.length,
          loaded: (window as any).adsbygoogle.loaded
        } : null;

        return {
          scripts,
          insElements,
          iframes,
          adsbygoogleVar
        };
      });

      console.log("\n--- DOM Inspection ---");
      console.log(`Total scripts found on page: ${adsenseReport.scripts.length}`);
      const adsenseScripts = adsenseReport.scripts.filter((s: string) => s.includes('pagead2') || s.includes('googlesyndication'));
      console.log(`AdSense scripts found:`, adsenseScripts);
      console.log(`window.adsbygoogle variable:`, JSON.stringify(adsenseReport.adsbygoogleVar));
      console.log(`Total <ins class="adsbygoogle"> tags found: ${adsenseReport.insElements.length}`);
      console.log(JSON.stringify(adsenseReport.insElements, null, 2));
      
      const adIframes = adsenseReport.iframes.filter((f: any) => f.src.includes('google') || f.name.includes('google') || f.id.includes('google'));
      console.log(`Google ad-related iframes found: ${adIframes.length}`);
      console.log(JSON.stringify(adIframes, null, 2));

      // Save screenshot
      const screenshotDir = join(process.cwd(), 'artifacts');
      mkdirSync(screenshotDir, { recursive: true });
      
      const screenshotPath = join(screenshotDir, 'talhatech_ads_test.png');
      const screenshot = await page.screenshot({ fullPage: true });
      writeFileSync(screenshotPath, screenshot);
      console.log(`📸 Screenshot saved to: ${screenshotPath}`);
    } catch (evalErr: any) {
      console.warn(`ℹ️ Note: DOM evaluation / screenshot failed: ${evalErr.message}`);
      console.warn(`This often happens when ad scripts (vignettes/popunders) navigate the page or detach the main frame.`);
    }

    // Filter and print failed requests
    const failed = requests.filter(r => r.status && r.status.startsWith('failed'));
    console.log(`\nFailed requests: ${failed.length}`);
    failed.forEach(f => console.log(`- [${f.type}] ${f.status}: ${f.url}`));

    // Check if any adsense/doubleclick/monetag requests failed/were blocked
    const adRequests = requests.filter(r => typeIsAd(r.url));
    console.log(`\nAd/Monetag/DoubleClick requests summary:`);
    adRequests.forEach(r => console.log(`- [${r.type}] ${r.status}: ${r.url.substring(0, 120)}`));

  } catch (err: any) {
    console.error("❌ Ads loading test error:", err);
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    if (browser) {
      try { await browser.disconnect(); } catch {}
    }
    console.log("\n🏁 Ads loading test completed. Exiting.");
    process.exit(0);
  }
}

runTest();
