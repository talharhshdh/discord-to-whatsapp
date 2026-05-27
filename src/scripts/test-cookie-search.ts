import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { browserPool } from '../libs/browser-pool';
import { cookieSearchPool } from '../libs/cookie-search-pool';
import { isWorkerCached, warmupWorker } from '../libs/page-pool';

// Load environment variables
dotenv.config();

interface PoolBrowser {
    workerId: string;
    cdpUrl: string;
    status: string;
}

const getPoolUrls = async (): Promise<PoolBrowser[]> => {
    try {
        const domain = process.env.DASHBOARD_DOMAIN;
        if (!domain) {
            console.warn("⚠️ DASHBOARD_DOMAIN is not defined in environment/dotenv.");
            return [];
        }

        const username = process.env.DASHBOARD_USERNAME || 'dtgklfdglkdfgljfd';
        const password = process.env.DASHBOARD_PASSWORD || 'sdlkfsdlglkdkl4mt';
        const token = Buffer.from(`${username}:${password}`).toString('base64');

        const response = await fetch("https://" + domain + "/api/browsers/pool", {
            "headers": {
                "accept": "application/json",
                "Authorization": `Basic ${token}`,
                "cookie": `dashboard_token=${token}`
            },
            "method": "GET"
        });

        if (!response.ok) {
            console.error(`❌ Failed to fetch pool: HTTP ${response.status}`);
            return [];
        }

        const data = await response.json() as { browsers?: PoolBrowser[] };
        return data.browsers || [];
    } catch (error) {
        console.error("❌ Error fetching pool URLs:", error);
        return [];
    }
}

async function main() {
    const manualUrl = process.argv[2];
    const query = process.argv[3] || 'weather in tokyo';
    const category = process.argv[4] || 'all';
    const pageNumber = Number(process.argv[5]) || 1;

    console.log(`======================================================`);
    console.log(`🚀 Cookie Search Test Script`);
    console.log(`   Query:       "${query}"`);
    console.log(`   Category:    "${category}"`);
    console.log(`   Page Number: ${pageNumber}`);
    console.log(`======================================================\n`);

    if (manualUrl) {
        console.log(`ℹ️ Registering manually specified worker URL: ${manualUrl}`);
        browserPool.register('test-cookie-search-worker', manualUrl, undefined, true);
        warmupWorker({ workerId: 'test-cookie-search-worker', cdpUrl: manualUrl } as any);
    } else {
        console.log(`🔍 Fetching active workers from dashboard...`);
        const browsers = await getPoolUrls();
        const activeBrowsers = browsers.filter(b => b.status === 'active');
        if (activeBrowsers.length > 0) {
            console.log(`   Found ${activeBrowsers.length} active workers. Registering them...`);
            activeBrowsers.forEach((browser, index) => {
                browserPool.register(browser.workerId, browser.cdpUrl, undefined, true);
                console.log(`   Registered worker: ${browser.workerId} -> ${browser.cdpUrl}`);
                
                // Warm up in background with a staggered delay to avoid network contention
                const delay = index * 1500;
                const timer = setTimeout(() => {
                    if (!isWorkerCached(browser.workerId)) {
                        warmupWorker(browser as any);
                    }
                }, delay);
                if (timer && typeof timer === 'object' && 'unref' in timer) {
                    timer.unref();
                }
            });
        } else {
            const fallbackUrl = process.env.WORKER_URL || 'https://hostels-belts-brooks-breath.trycloudflare.com';
            console.warn(`⚠️ No active workers found in dashboard. Registering fallback worker URL: ${fallbackUrl}`);
            browserPool.register('test-cookie-search-worker', fallbackUrl, undefined, true);
            warmupWorker({ workerId: 'test-cookie-search-worker', cdpUrl: fallbackUrl } as any);
        }
    }

    // Wait a brief moment to let background warmups start establishing
    await new Promise(resolve => setTimeout(resolve, 8000));

    // ── 200 SEARCHES LOAD TEST ──────────────────────────────────────────────
    const totalSearches = 200;
    const concurrency = 5;

    console.log(`\n🚀 Starting Load Test: Running ${totalSearches} searches with concurrency of ${concurrency}...`);

    let successCount = 0;
    let errorCount = 0;
    let captchaCount = 0;
    const latencies: number[] = [];
    const loopStart = performance.now();

    let currentIndex = 0;

    const runNext = async (): Promise<void> => {
        if (currentIndex >= totalSearches) return;
        const idx = currentIndex++;
        const currentQuery = `${query} ${idx + 1}`;
        const tStart = performance.now();

        try {
            const result = await cookieSearchPool.search(currentQuery, pageNumber, category);
            const elapsed = performance.now() - tStart;
            latencies.push(elapsed);

            const isError = !!result.captcha || !!result.error;
            const isZeroResults = !result.organic || result.organic.length === 0;

            if (result.captcha) {
                captchaCount++;
                console.error(`❌ [#${idx + 1}] Captcha detected: ${result.error} (${Math.round(elapsed)} ms)`);
                if (result.html) {
                    const filename = `search-debug-captcha-${idx + 1}-${Date.now()}.html`;
                    const filepath = path.join(process.cwd(), filename);
                    fs.writeFileSync(filepath, result.html, 'utf-8');
                }
            } else if (result.error) {
                errorCount++;
                console.error(`❌ [#${idx + 1}] Error: ${result.error} (${Math.round(elapsed)} ms)`);
            } else if (isZeroResults) {
                errorCount++;
                console.error(`⚠️ [#${idx + 1}] 0 Results (${Math.round(elapsed)} ms)`);
                if (result.html) {
                    const filename = `search-debug-zero-${idx + 1}-${Date.now()}.html`;
                    const filepath = path.join(process.cwd(), filename);
                    fs.writeFileSync(filepath, result.html, 'utf-8');
                }
            } else {
                successCount++;
                console.log(`✅ [#${idx + 1}] Found ${result.organic.length} results (${Math.round(elapsed)} ms)`);
            }
        } catch (err: any) {
            errorCount++;
            console.error(`❌ [#${idx + 1}] Exception occurred: ${err.message}`);
        }

        // Run the next available task
        await runNext();
    };

    // Spawn concurrent workers
    const workers = Array.from({ length: concurrency }, () => runNext());
    await Promise.all(workers);

    const totalElapsed = performance.now() - loopStart;
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    console.log(`\n======================================================`);
    console.log(`📊 Cookie Search Load Test Summary`);
    console.log(`   Total Searches Executed: ${totalSearches}`);
    console.log(`   Successes:              ${successCount}`);
    console.log(`   Errors:                 ${errorCount}`);
    console.log(`   Captchas:               ${captchaCount}`);
    console.log(`   Average Latency:        ${Math.round(avgLatency)} ms`);
    console.log(`   Total Loop Time:        ${Math.round(totalElapsed)} ms`);
    console.log(`======================================================\n`);

    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
