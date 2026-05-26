import { performance } from 'perf_hooks';
import { browserPool } from '../libs/browser-pool';
import { cookieSearchPool } from '../libs/cookie-search-pool';

async function main() {
    const workerUrl = process.argv[2] || process.env.WORKER_URL || 'https://execute-teams-ideal-conceptual.trycloudflare.com';
    const query = process.argv[3] || 'weather in tokyo';
    const category = process.argv[4] || 'all';

    console.log(`======================================================`);
    console.log(`🚀 Cookie Search Test Script`);
    console.log(`   Worker URL: ${workerUrl}`);
    console.log(`   Query:      "${query}"`);
    console.log(`   Category:   "${category}"`);
    console.log(`======================================================\n`);

    const workerId = 'test-cookie-search-worker';
    browserPool.register(workerId, workerUrl);

    const tStart = performance.now();
    try {
        const result = await cookieSearchPool.search(query, 1, category);
        const elapsed = performance.now() - tStart;

        console.log(`⏱️  Search took: ${Math.round(elapsed)} ms`);
        if (result.captcha) {
            console.error(`❌ Captcha detected: ${result.error}`);
        } else if (result.error) {
            console.error(`❌ Error: ${result.error}`);
        } else {
            console.log(`✅ Success! Found ${result.organic.length} organic results.`);
            result.organic.forEach((res, idx) => {
                console.log(`   ${idx + 1}. Title: ${res.title}`);
                console.log(`      Link:  ${res.link}`);
                console.log(`      Snippet: ${res.snippet.substring(0, 100)}${res.snippet.length > 100 ? '...' : ''}`);
            });
        }
    } catch (error) {
        console.error(`❌ Search threw exception:`, error);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
