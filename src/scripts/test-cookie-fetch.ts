import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as cheerio from 'cheerio';
import { browserPool } from '../libs/browser-pool';
import {
    acquirePage,
    releasePage,
    invalidateWorkerConnection,
} from '../libs/page-pool';
import type { WorkerConnection } from '../libs/page-pool';

const WORKER_URL = 'https://auto-podcasts-collective-summit.trycloudflare.com';
const WORKER_ID = 'browser-worker-auto-podcasts';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Register the worker
browserPool.register(WORKER_ID, WORKER_URL);

function isCaptcha(html: string): boolean {
    return (
        html.includes('action="/sorry/index"') ||
        html.includes('id="captcha"') ||
        html.includes('g-recaptcha') ||
        html.includes('consent.google.com')
    );
}

function parseGoogleResults(html: string): Array<{ title: string; link: string; snippet: string }> {
    const $ = cheerio.load(html);
    const organic: Array<{ title: string; link: string; snippet: string }> = [];
    const seen = new Set<string>();

    $('div.g, div[data-sokoban-container], div[data-hveid]').each((_, el) => {
        if (organic.length >= 10) return false;

        const h3 = $(el).find('h3').first();
        if (!h3.length) return;

        const title = h3.text().trim();
        if (!title) return;

        const anchor = $(el).find('a[href^="http"]').first().length
            ? $(el).find('a[href^="http"]').first()
            : $(el).find('a').first();

        let link = anchor.attr('href') ?? '';
        if (link.startsWith('/url?')) {
            const qs = new URLSearchParams(link.slice(5));
            link = qs.get('q') ?? link;
        }

        if (!link || link.includes('google.com') || seen.has(link)) return;
        seen.add(link);

        let snippet = '';
        const snippetEl = $(el).find('.VwiC3b, .lEBKkf, .lyLwlc, .IsZvec, [data-sncf]').first();
        if (snippetEl.length) {
            snippet = snippetEl.text().trim();
        } else {
            snippet = $(el).text().replace(title, '').trim().slice(0, 200);
        }

        organic.push({ title, link, snippet });
    });

    // Fallback if strategy 1 yielded no results
    if (organic.length === 0) {
        $('h3').each((_, el) => {
            if (organic.length >= 10) return false;

            const title = $(el).text().trim();
            if (!title) return;

            const anchor = $(el).closest('a[href^="http"]').length
                ? $(el).closest('a[href^="http"]')
                : $(el).parents().filter('a[href^="http"]').first();

            let link = anchor.attr('href') ?? '';
            if (link.startsWith('/url?')) {
                const qs = new URLSearchParams(link.slice(5));
                link = qs.get('q') ?? link;
            }
            if (!link || link.includes('google.com') || seen.has(link)) return;
            seen.add(link);

            const parent = $(el).parent();
            const snippet = parent.next().text().trim().slice(0, 200) ||
                            parent.parent().text().replace(title, '').trim().slice(0, 200);

            organic.push({ title, link, snippet });
        });
    }

    return organic;
}

async function fetchCookiesFromBrowser(): Promise<string> {
    const browser = browserPool.getNext();
    if (!browser) {
        throw new Error('No active browser available in pool');
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    console.log(`[Browser] Acquiring page from worker: ${browser.workerId}`);
    try {
        const acquired = await acquirePage(browser);
        conn = acquired.conn;
        page = acquired.page;

        console.log('[Browser] Navigating to https://www.google.com to fetch fresh cookies...');
        await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });

        const cookies = await page.cookies();
        console.log(`[Browser] Successfully retrieved ${cookies.length} cookies.`);
        const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
        return cookieStr;
    } catch (err) {
        pageErrored = true;
        console.error('[Browser] Error fetching cookies from page pool:', err);
        throw err;
    } finally {
        if (conn && page) {
            await releasePage(conn, page, pageErrored);
        }
    }
}

async function clearBrowserCookies(): Promise<void> {
    const browser = browserPool.getNext();
    if (!browser) return;

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
        const acquired = await acquirePage(browser);
        conn = acquired.conn;
        page = acquired.page;

        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach();
        console.log('[Browser] Cleared browser cookies successfully.');
    } catch (err) {
        pageErrored = true;
        console.error('[Browser] Error clearing browser cookies:', err);
    } finally {
        if (conn && page) {
            await releasePage(conn, page, pageErrored);
        }
    }
}

async function fetchDirect(query: string, cookieStr: string): Promise<string> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gbv=2&pws=0`;
    const resp = await fetch(url, {
        headers: {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "sec-ch-ua": '"Chromium";v="148"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "upgrade-insecure-requests": "1",
            "User-Agent": USER_AGENT,
            "cookie": cookieStr,
            "Referer": "https://www.google.com/"
        },
        signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
        throw new Error(`HTTP error ${resp.status}`);
    }

    return await resp.text();
}

async function main() {
    const queries = [
        'song pakistan',
        'weather in tokyo',
        'typescript tutorial',
        'google chrome latest version',
        'artificial intelligence news'
    ];

    let cookieStr = '';
    try {
        cookieStr = await fetchCookiesFromBrowser();
    } catch (e) {
        console.error('Failed to get initial cookies. Exiting.', e);
        process.exit(1);
    }

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        console.log(`\n======================================================`);
        console.log(`🚀 Starting search ${i + 1}/${queries.length}: "${query}"`);
        console.log(`======================================================`);

        const tStart = performance.now();
        let html = '';
        try {
            html = await fetchDirect(query, cookieStr);
        } catch (err) {
            console.error(`[Error] Fetch failed for query "${query}":`, (err as Error).message);
            continue;
        }
        const tFetch = performance.now() - tStart;

        if (isCaptcha(html)) {
            console.warn(`[CAPTCHA] Captcha detected on query: "${query}". Deleting cookies & re-fetching...`);
            
            cookieStr = '';
            await clearBrowserCookies();

            try {
                cookieStr = await fetchCookiesFromBrowser();
            } catch (e) {
                console.error('[CAPTCHA] Failed to re-fetch cookies after captcha. Stopping process.');
                process.exit(1);
            }

            console.log(`[Retry] Retrying query: "${query}" with new cookies...`);
            const tRetryStart = performance.now();
            try {
                html = await fetchDirect(query, cookieStr);
            } catch (err) {
                console.error(`[Error] Retry fetch failed for query "${query}":`, (err as Error).message);
                continue;
            }
            if (isCaptcha(html)) {
                console.error(`[CAPTCHA] Still captcha after fetching new cookies. Stopping process.`);
                process.exit(1);
            }
            console.log(`[Retry] Retry successful. Fetch took ${Math.round(performance.now() - tRetryStart)} ms.`);
        }

        const tParseStart = performance.now();
        const results = parseGoogleResults(html);
        const tParse = performance.now() - tParseStart;

        const filename = `search-${i + 1}.html`;
        fs.writeFileSync(filename, html);

        console.log(`⏱️  Performance: Fetch took ${Math.round(tFetch)} ms | Parse took ${Math.round(tParse)} ms.`);
        console.log(`📄 Saved raw response to ${filename}`);
        console.log(`📋 Parse results (${results.length} found):`);
        
        results.forEach((res, idx) => {
            console.log(`   ${idx + 1}. Title: ${res.title}`);
            console.log(`      Link:  ${res.link}`);
            console.log(`      Snippet: ${res.snippet.substring(0, 100)}${res.snippet.length > 100 ? '...' : ''}`);
        });
    }

    console.log('\nAll search jobs completed successfully.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
