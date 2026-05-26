import { browserPool } from '../libs/browser-pool';
import { acquirePage, releasePage } from '../libs/page-pool';

const WORKERS = [
    { id: 'browser-worker-5-runner-2a319255', url: 'https://hammer-auburn-downloaded-affordable.trycloudflare.com' },
];

for (const w of WORKERS) {
    browserPool.register(w.id, w.url);
}

async function testImagesSearch() {
    const browser = browserPool.getNext();
    if (!browser) {
        console.error("No active browser.");
        return;
    }

    const { conn, page } = await acquirePage(browser);
    
    try {
        console.log("Navigating to no-JS Google Images search...");
        const targetUrl = `https://www.google.com/search?q=xxxtentacion&tbm=isch&gbv=2&hl=en`;
        
        const client = await page.target().createCDPSession();
        await client.send('Page.navigate', { url: targetUrl });
        
        await page.waitForSelector('a[href*="imgres"]', { timeout: 10000 }).catch(() => {
            console.log("Timeout waiting for imgres links.");
        });

        const title = await page.title();
        console.log(`Page Title: ${title}`);

        const results = await page.evaluate(() => {
            const images: any[] = [];
            const seen = new Set();
            document.querySelectorAll('a[href*="imgres"]').forEach((el) => {
                const img = el.querySelector('img');
                const alt = img ? img.getAttribute('alt') || '' : '';
                const href = el.getAttribute('href') || '';

                let sourceUrl = '';
                let imageUrl = '';
                try {
                    const urlObj = new URL(href, window.location.href);
                    imageUrl = urlObj.searchParams.get('imgurl') || '';
                    sourceUrl = urlObj.searchParams.get('imgrefurl') || '';
                } catch (e) {
                    const imgMatch = href.match(/[?&]imgurl=([^&]+)/);
                    const refMatch = href.match(/[?&]imgrefurl=([^&]+)/);
                    if (imgMatch) imageUrl = decodeURIComponent(imgMatch[1]);
                    if (refMatch) sourceUrl = decodeURIComponent(refMatch[1]);
                }

                if (imageUrl && !seen.has(imageUrl)) {
                    seen.add(imageUrl);
                    images.push({
                        alt,
                        sourceUrl,
                        imageUrl
                    });
                }
            });
            return images;
        });

        console.log(`Extracted ${results.length} images:`);
        results.slice(0, 10).forEach((img: any, idx: number) => {
            console.log(`\nImage ${idx + 1}:`);
            console.log(`Alt:      ${img.alt}`);
            console.log(`Source:   ${img.sourceUrl}`);
            console.log(`ImageURL: ${img.imageUrl}`);
        });

    } catch (e) {
        console.error(e);
    } finally {
        await releasePage(conn, page, true);
    }
}

testImagesSearch().then(() => process.exit(0));
