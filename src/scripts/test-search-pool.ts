/**
 * @file test-search-pool.ts
 * @description Standalone test script to measure execution time of searchViaPool locally using specific CDP URLs.
 *
 * Usage:
 *   npx ts-node src/scripts/test-search-pool.ts "your search query"
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import { browserPool } from '../libs/browser-pool';
import {
    acquirePage,
    releasePage,
    invalidateWorkerConnection,
    workerCdpFailures,
    MAX_WORKER_CDP_FAILURES,
} from '../libs/page-pool';
import type { WorkerConnection } from '../libs/page-pool';
/*
 https://aircraft-reflected-exceed-points.trycloudflare.com  (pool size: 8)
✅ Browser worker registered: browser-worker-4-runner-ef6a90c9 → https://adrian-absolutely-knowing-increasingly.trycloudflare.com  (pool size: 9)
✅ Browser worker registered: browser-worker-3-runner-e5853599 → https://novel-yang-sullivan-calculations.trycloudflare.com  (pool size: 10)
*/
// Register the worker URLs you provided
const WORKERS = [
    { id: 'browser-worker-4-runner-2a319255', url: 'https://charge-material-reasonably-acts.trycloudflare.com' },

];

// Add them directly into the pool
for (const w of WORKERS) {
    browserPool.register(w.id, w.url);
}

/**
 * Exact copy of the searchViaPool logic from browser-pool.ts, 
 * augmented with `performance.now()` checkpoints.
 */
async function timedSearchViaPool(
    text: string,
    pageNumber: number = 1,
    includeAI: boolean = false,
) {
    const maxAttempts = Math.max(1, browserPool.getActive().length);
    console.log(`\n======================================================`);
    console.log(`🚀 Starting timed search for: "${text}"`);
    console.log(`   Browsers in pool: ${maxAttempts}`);
    console.log(`======================================================\n`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const browser = browserPool.getNext();
        if (!browser) {
            console.error('🚨 No active browsers available in pool.');
            break;
        }

        let conn: WorkerConnection | null = null;
        let page: any = null;
        let pageErrored = false;

        console.log(`\n--- Attempt ${attempt + 1}/${maxAttempts} using worker: ${browser.workerId} ---`);
        const attemptStart = performance.now();

        try {
            const tAcquire = performance.now();
            const acquired = await acquirePage(browser);
            console.log(`⏱️  acquirePage (CDP Connect + newPage) took: ${Math.round(performance.now() - tAcquire)} ms`);

            conn = acquired.conn;
            page = acquired.page;

            const tInterception = performance.now();
            page.removeAllListeners('request');
            await page.setRequestInterception(true);
            page.on('request', (req: any) => {
                if (req.isInterceptResolutionHandled()) return;
                const type = req.resourceType();
                const url = req.url();

                if (type === 'document') return req.continue();

                if (['image', 'media', 'font', 'stylesheet', 'websocket', 'manifest', 'other'].includes(type)) {
                    return req.abort();
                }
                if (
                    url.includes('gen_204') || url.includes('/log?') || url.includes('sodar') ||
                    url.includes('batchexecute') || url.includes('xjs=s') || url.includes('m=') ||
                    url.includes('async=') || url.includes('google-analytics') || url.includes('play.google.com/log') ||
                    url.includes('/gen_204') || url.includes('gws-wiz') || url.includes('clients1.google.com')
                ) {
                    return req.abort();
                }
                // Try ALLOWING scripts temporarily to see if Google needs them to render results
                if (['xhr', 'fetch'].includes(type)) {
                    return req.abort();
                }
                req.continue();
            });
            console.log(`⏱️  setup request interception took:          ${Math.round(performance.now() - tInterception)} ms`);

            const startParam = (pageNumber - 1) * 30;
            const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&gbv=2&pws=0`;

            const tGoto = performance.now();
            //   await page.goto(targetUrl, { timeout: 30_000 });
            const client = await page.target().createCDPSession();
            await client.send('Page.navigate', { url: targetUrl, timeout: 30_000 });

            console.log(`⏱️  page.goto (Network request) took:         ${Math.round(performance.now() - tGoto)} ms`);

            const title = await page.title();
            console.log(`📄  Page Title:                               "${title}"`);

            const tWait = performance.now();
            await page.waitForSelector('#search .g, #rso .g, .MjjYud .g, form[action="/sorry/index"]', { timeout: 100 }).catch(() => { });
            console.log(`⏱️  waitForSelector (DOM render wait) took:   ${Math.round(performance.now() - tWait)} ms`);

            const tEval = performance.now();
            const results = await page.evaluate(() => {
                if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
                    return { captcha: true, organic: [] as any[], aiResponse: null as string | null };
                }

                document
                    .querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
                    .forEach((b: any) => (b as HTMLElement).click());

                const organic: Array<{ title: string; link: string; snippet: string; displayedLink?: string; favicon?: string }> = [];
                let aiResponse: string | null = null;
                const seen = new Set<string>();

                const cleanText = (str: string | null) => str ? str.trim().replace(/\s+/g, ' ') : '';
                
                const decodeGoogleLink = (href: string | null) => {
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

                // 1. EXTRACT AI OVERVIEW / RESPONSE (SGE)
                for (const sel of [
                    '.M8OgIe', '.LLtROe', '.IZ6rdc',
                    '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk',
                ]) {
                    const el = document.querySelector(sel);
                    if (el && (el as HTMLElement).innerText?.trim().length > 20) {
                        aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
                        break;
                    }
                }

                // 2. EXTRACT FEATURED SNIPPET
                let featuredSnippet: any = null;
                const fsContainer = document.querySelector('[data-attrid="wa:/description"], .kp-blk, .hp-xpd, .c2d06b');
                if (fsContainer) {
                    const titleEl = fsContainer.querySelector('h3, .LC20lb');
                    const aEl = fsContainer.querySelector('a');
                    const snippetEl = fsContainer.querySelector('.YyVvo, .di3YZe, .ilUpNd.H66NU.aSRlid, .H66NU');
                    if (titleEl && aEl && snippetEl) {
                        featuredSnippet = {
                            title: cleanText(titleEl.textContent),
                            link: decodeGoogleLink(aEl.getAttribute('href') || ''),
                            snippet: cleanText(snippetEl.textContent)
                        };
                    }
                }

                // 3. EXTRACT KNOWLEDGE PANEL
                let knowledgePanel: any = null;
                const kpContainer = document.querySelector('.kp-sidebar, #rhs, .rhs, .kp-blk, .KPDxwd');
                if (kpContainer) {
                    const titleEl = kpContainer.querySelector('[role="heading"], .HPwZGe, .DU1Mzb, .kno-ecr-pt');
                    const subtitleEl = kpContainer.querySelector('.wDYxhc.mod, .kno-meta, .bV3FIe');
                    const descEl = kpContainer.querySelector('[data-attrid="kc:/common/topic:description"], .kno-rdesc span');
                    const sourceEl = kpContainer.querySelector('.kno-rdesc a');
                    
                    const attributes: any[] = [];
                    kpContainer.querySelectorAll('.rVusM, .zVnNfc, .Lrzca').forEach(el => {
                        const label = el.querySelector('.wDYxhc, .zVnNfc, .fl');
                        const val = el.querySelector('.Lrzca, .kno-fv');
                        if (label && val) {
                            attributes.push({
                                label: cleanText(label.textContent),
                                value: cleanText(val.textContent)
                            });
                        }
                    });

                    if (titleEl) {
                        knowledgePanel = {
                            title: cleanText(titleEl.textContent),
                            subtitle: subtitleEl ? cleanText(subtitleEl.textContent) : undefined,
                            description: descEl ? cleanText(descEl.textContent) : undefined,
                            sourceUrl: sourceEl ? decodeGoogleLink(sourceEl.getAttribute('href') || '') : undefined,
                            attributes: attributes.length > 0 ? attributes : undefined
                        };
                    }
                }

                // 4. EXTRACT PEOPLE ALSO ASK (PAA)
                const peopleAlsoAsk: any[] = [];
                document.querySelectorAll('[jsname="N760bc"], [data-init-query], .cb76Od, .E3VR9e').forEach((el) => {
                    const headerText = cleanText(el.textContent);
                    if (headerText.toLowerCase().includes('people also ask') || headerText.toLowerCase().includes('questions')) {
                        const parent = el.parentElement;
                        if (parent) {
                            parent.querySelectorAll('[jsname="j96n9e"], .ask-xpd, .mB12ae').forEach((qEl) => {
                                const qText = cleanText(qEl.textContent);
                                if (qText) {
                                    peopleAlsoAsk.push({ question: qText });
                                }
                            });
                        }
                    }
                });

                // 5. EXTRACT DIRECT ANSWERS (WEATHER, TRANSLATION, DICTIONARY, CALCULATOR)
                let directAnswer: any = null;
                
                // Calculator
                const calcResult = document.querySelector('#cwos');
                if (calcResult) {
                    const calcEq = document.querySelector('.rN17ge, .SwHCTb');
                    directAnswer = {
                        type: 'calculator',
                        answer: cleanText(calcResult.textContent),
                        details: calcEq ? cleanText(calcEq.textContent) : undefined
                    };
                }
                
                // Weather
                const weatherTemp = document.querySelector('#wob_tm, .vk_bk.wob-t');
                if (weatherTemp && !directAnswer) {
                    const tempVal = weatherTemp.textContent ? weatherTemp.textContent.trim() : '';
                    
                    let unit = '°F';
                    const tempUnitEl = document.querySelector('#wob_temp_unit, [aria-selected="true"] .wob_t, .wob_t[style*="inline"]');
                    if (tempUnitEl && tempUnitEl.textContent?.includes('C')) {
                        unit = '°C';
                    } else {
                        const weatherContainer = weatherTemp.closest('.Ww4FFb, .vk_c, .card');
                        if (weatherContainer && weatherContainer.textContent?.includes('°C') && !weatherContainer.textContent?.includes('°F')) {
                            unit = '°C';
                        }
                    }

                    const locEl = document.querySelector('.BBwThe, #wob_loc, .wob_loc');
                    let location = locEl ? cleanText(locEl.textContent) : 'Tokyo';
                    if (location === 'Weather') {
                        const cityEl = document.querySelector('.BBwThe, .wob_loc');
                        if (cityEl) location = cleanText(cityEl.textContent);
                    }

                    const condEl = document.querySelector('#wob_dc, .wob_dc, #wob_dts + span');
                    const condition = condEl ? cleanText(condEl.textContent) : '';

                    const precipEl = document.querySelector('#wob_pp');
                    const humidEl = document.querySelector('#wob_hm');
                    const windEl = document.querySelector('#wob_ws');

                    let details = `${location} - ${condition}`;
                    if (precipEl || humidEl || windEl) {
                        details += ` (Precipitation: ${precipEl ? precipEl.textContent : 'N/A'}, Humidity: ${humidEl ? humidEl.textContent : 'N/A'}, Wind: ${windEl ? windEl.textContent : 'N/A'})`;
                    }

                    directAnswer = {
                        type: 'weather',
                        answer: `${tempVal}${unit}`,
                        details: details
                    };
                }

                // Time / Timezone
                const timeVal = document.querySelector('.vk_bk, .gsrt.vk_bk');
                if (timeVal && timeVal.textContent && timeVal.textContent.includes(':') && !directAnswer) {
                    const timeZone = document.querySelector('.vk_gy, .vk_sh');
                    directAnswer = {
                        type: 'time',
                        answer: cleanText(timeVal.textContent),
                        details: timeZone ? cleanText(timeZone.textContent) : undefined
                    };
                }

                // Dictionary
                const dictWord = document.querySelector('.v9i61e, [data-attrid="kc:/common/dictionary:definition"]');
                if (dictWord && !directAnswer) {
                    const dictMean = document.querySelector('.LT1Tbd, .lr_dct_ent');
                    directAnswer = {
                        type: 'dictionary',
                        answer: cleanText(dictWord.textContent),
                        details: dictMean ? cleanText(dictMean.textContent) : undefined
                    };
                }

                // Translation
                const transTarget = document.querySelector('#tw-target-text');
                if (transTarget && !directAnswer) {
                    const transSource = document.querySelector('#tw-source-text-ta');
                    directAnswer = {
                        type: 'translation',
                        answer: cleanText(transTarget.textContent),
                        details: transSource ? cleanText((transSource as any).value || transSource.textContent) : undefined
                    };
                }

                // 6. EXTRACT NEWS / STORIES
                const news: any[] = [];
                document.querySelectorAll('g-card, .YLwUee, .WlydOe, .MjjYud').forEach((el) => {
                    const a = el.querySelector('a');
                    const isNews = el.querySelector('.OSrXXb, .LfNcr') || el.querySelector('.NUnG9b');
                    if (a && isNews) {
                        const h3 = el.querySelector('[role="heading"], h3, .mCBkyc, .nD1swb');
                        const srcEl = el.querySelector('.NUnG9b, .h1UuCc, .ap3aec');
                        const timeEl = el.querySelector('.OSrXXb, .LfNcr');
                        if (h3 && a.getAttribute('href')) {
                            const link = decodeGoogleLink(a.getAttribute('href') || '');
                            if (link && !seen.has(link)) {
                                news.push({
                                    title: cleanText(h3.textContent),
                                    source: srcEl ? cleanText(srcEl.textContent) : '',
                                    time: timeEl ? cleanText(timeEl.textContent) : '',
                                    link
                                });
                            }
                        }
                    }
                });

                // 7. EXTRACT VIDEOS
                const videos: any[] = [];
                document.querySelectorAll('g-card, .V2Ew3b, .z3HNeb, .MjjYud').forEach((el) => {
                    const a = el.querySelector('a');
                    if (!a) return;
                    const href = a.getAttribute('href') || '';
                    const link = decodeGoogleLink(href);
                    const isVideo = link.includes('youtube.com') || link.includes('vimeo.com') || el.querySelector('.vP1iyc') || el.querySelector('.J1y2db');
                    if (isVideo && !seen.has(link)) {
                        const h3 = el.querySelector('h3, .mCBkyc, .z3HNeb');
                        const durEl = el.querySelector('.vP1iyc, .J1y2db');
                        const uploadedEl = el.querySelector('.ap3aec, .PCvXJ');
                        if (h3) {
                            videos.push({
                                title: cleanText(h3.textContent),
                                source: link.includes('youtube.com') ? 'YouTube' : 'Video',
                                duration: durEl ? cleanText(durEl.textContent) : undefined,
                                uploadedAt: uploadedEl ? cleanText(uploadedEl.textContent) : undefined,
                                link
                            });
                        }
                    }
                });

                // 8. EXTRACT IMAGES (both JS-enabled and JS-disabled, inline & traditional)
                const images: any[] = [];
                const seenImages = new Set<string>();

                // Method A: CSS class-independent heading-based images block parsing
                document.querySelectorAll('span, div, h2, h3').forEach((el) => {
                    const text = el.textContent ? el.textContent.trim() : '';
                    if (text === 'Images') {
                        let parent = el.parentElement;
                        while (parent && parent.querySelectorAll('img').length < 3 && parent.tagName !== 'BODY') {
                            parent = parent.parentElement;
                        }
                        if (parent) {
                            parent.querySelectorAll('img').forEach((img: any) => {
                                const alt = img.getAttribute('alt') || '';
                                const imageUrl = img.getAttribute('src') || '';
                                if (!imageUrl) return;

                                let p = img.parentElement;
                                let sourceUrl = '';
                                while (p && p !== parent && p.tagName !== 'BODY') {
                                    const anchor = p.querySelector('a');
                                    if (anchor) {
                                        const href = anchor.getAttribute('href') || '';
                                        if (href) {
                                            sourceUrl = decodeGoogleLink(href);
                                            break;
                                        }
                                    }
                                    p = p.parentElement;
                                }

                                if (sourceUrl && !seenImages.has(imageUrl)) {
                                    seenImages.add(imageUrl);
                                    images.push({
                                        alt: cleanText(alt),
                                        sourceUrl,
                                        imageUrl
                                    });
                                }
                            });
                        }
                    }
                });

                // Method B: Traditional imgres fallback links (e.g. JS-disabled/fallback page)
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

                    sourceUrl = decodeGoogleLink(sourceUrl || href);
                    if (sourceUrl && imageUrl && !seenImages.has(imageUrl)) {
                        seenImages.add(imageUrl);
                        images.push({
                            alt: cleanText(alt),
                            sourceUrl,
                            imageUrl: imageUrl || undefined
                        });
                    }
                });


                // 9. EXTRACT SHOPPING RESULTS
                const shopping: any[] = [];
                document.querySelectorAll('.sh-dgr__grid-cell, .sh-dlr__list-result, .sh-np__click-target').forEach((el) => {
                    const a = el.querySelector('a');
                    const titleEl = el.querySelector('.Xj73ed, .tAxDx');
                    const priceEl = el.querySelector('.a8c5bc, .h1N1A');
                    const merchantEl = el.querySelector('.I5cFL, .mB12ae');
                    if (a && titleEl && priceEl) {
                        const link = decodeGoogleLink(a.getAttribute('href') || '');
                        shopping.push({
                            title: cleanText(titleEl.textContent),
                            price: cleanText(priceEl.textContent),
                            merchant: merchantEl ? cleanText(merchantEl.textContent) : '',
                            link
                        });
                    }
                });

                // 10. EXTRACT LOCAL RESULTS
                const localResults: any[] = [];
                document.querySelectorAll('.rllt__card, .Vk2fBe').forEach((el) => {
                    const titleEl = el.querySelector('[role="heading"], .dbg0pd');
                    const ratingEl = el.querySelector('.rGhul, .Yw7Nj');
                    const reviewsEl = el.querySelector('.R3Y11e');
                    const addressEl = el.querySelector('.Lrzca');
                    const a = el.querySelector('a');
                    if (titleEl) {
                        localResults.push({
                            title: cleanText(titleEl.textContent),
                            rating: ratingEl ? cleanText(ratingEl.textContent) : undefined,
                            reviewsCount: reviewsEl ? cleanText(reviewsEl.textContent) : undefined,
                            address: addressEl ? cleanText(addressEl.textContent) : undefined,
                            link: a ? decodeGoogleLink(a.getAttribute('href') || '') : undefined
                        });
                    }
                });

                // 11. EXTRACT RELATED SEARCHES
                const relatedSearches: string[] = [];
                document.querySelectorAll('a.title, .s75cqc, .card-section a, .E3VR9e').forEach((el) => {
                    const headerText = cleanText(el.textContent);
                    if (headerText.toLowerCase().includes('people also search') || headerText.toLowerCase().includes('related search')) {
                        let parent = el.parentElement;
                        while (parent && !parent.className.includes('Gx5Zad') && parent.tagName !== 'BODY') {
                            parent = parent.parentElement;
                        }
                        if (parent) {
                            parent.querySelectorAll('a').forEach((aEl) => {
                                const text = cleanText(aEl.textContent);
                                if (text && text !== headerText && !relatedSearches.includes(text)) {
                                    relatedSearches.push(text);
                                }
                            });
                        }
                    }
                });

                // 12. EXTRACT ORGANIC SEARCH RESULTS
                document.querySelectorAll('h3').forEach((h3) => {
                    const headingText = cleanText(h3.textContent);
                    if (
                        headingText === 'Search Results' || 
                        headingText === 'Weather Result' || 
                        headingText === 'Web results' || 
                        headingText === 'Featured snippet' ||
                        headingText.includes('People also ask')
                    ) {
                        return;
                    }

                    const container = h3.closest('.g, .MjjYud, .xpd, .Gx5Zad') || h3.parentElement;
                    if (!container) return;

                    const a = container.tagName === 'A' ? container : container.querySelector('a');
                    if (!a) return;

                    const rawLink = a.getAttribute('href') || '';
                    const link = decodeGoogleLink(rawLink);
                    
                    if (!link || link.includes('google.com') || link.includes('sorry/index') || seen.has(link)) return;
                    seen.add(link);

                    let snippet = '';
                    for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.ilUpNd.H66NU.aSRlid', '.H66NU', '.lQigmf']) {
                        const sn = container.querySelector(s);
                        if (sn && sn.textContent && sn.textContent.trim()) {
                            const txt = cleanText(sn.textContent);
                            if (txt !== cleanText(h3.textContent) && !txt.includes('www.') && txt.length > 10) {
                                snippet = txt;
                                break;
                            }
                        }
                    }

                    if (!snippet) {
                        container.querySelectorAll('div, span, p').forEach((sub) => {
                            if (!snippet && sub.className && sub.textContent && sub.children.length === 0) {
                                const txt = cleanText(sub.textContent);
                                if (txt.length > 30 && !txt.includes('www.') && txt !== cleanText(h3.textContent)) {
                                    snippet = txt;
                                }
                            }
                        });
                    }

                    const dispEl = container.querySelector('.TbwUpd, .byrV5b, .ylgVCe, .BamJPe');
                    const displayedLink = dispEl ? cleanText(dispEl.textContent) : undefined;

                    const favEl = container.querySelector('img.H1u2de, img.XNo5Ab, .wb41ae img');
                    const favicon = favEl ? favEl.getAttribute('src') || undefined : undefined;

                    organic.push({
                        title: cleanText(h3.textContent),
                        link,
                        snippet,
                        displayedLink,
                        favicon
                    });
                });

                return {
                    captcha: false,
                    organic,
                    aiResponse,
                    featuredSnippet,
                    knowledgePanel,
                    peopleAlsoAsk: peopleAlsoAsk.length > 0 ? peopleAlsoAsk : undefined,
                    directAnswer,
                    news: news.length > 0 ? news : undefined,
                    videos: videos.length > 0 ? videos : undefined,
                    images: images.length > 0 ? images : undefined,
                    shopping: shopping.length > 0 ? shopping : undefined,
                    relatedSearches: relatedSearches.length > 0 ? relatedSearches : undefined,
                    localResults: localResults.length > 0 ? localResults : undefined
                };
            });
            console.log(`⏱️  page.evaluate (Data extraction) took:     ${Math.round(performance.now() - tEval)} ms`);

            if (results.captcha) {
                const html = await page.content();
                fs.writeFileSync('debug-google.html', html);
                console.log(`💾  Dumped HTML to debug-google.html (Captcha detected).`);
                console.warn(`⚠️  Captcha detected on pool browser ${browser.workerId}`);
                pageErrored = true;
                throw new Error('CAPTCHA_DETECTED');
            }

            workerCdpFailures.delete(browser.workerId);

            console.log(`\n✅  Attempt succeeded!`);
            console.log(`    Found ${results.organic.length} organic results.`);
            if (results.featuredSnippet) console.log(`    Found Featured Snippet: "${results.featuredSnippet.title}"`);
            if (results.knowledgePanel) console.log(`    Found Knowledge Panel: "${results.knowledgePanel.title}"`);
            if (results.peopleAlsoAsk) console.log(`    Found ${results.peopleAlsoAsk.length} PAA questions.`);
            if (results.directAnswer) console.log(`    Found Direct Answer (type: ${results.directAnswer.type})`);
            if (results.news) console.log(`    Found ${results.news.length} news items.`);
            if (results.videos) console.log(`    Found ${results.videos.length} videos.`);
            if (results.images) console.log(`    Found ${results.images.length} images.`);
            if (results.shopping) console.log(`    Found ${results.shopping.length} shopping products.`);
            if (results.relatedSearches) console.log(`    Found ${results.relatedSearches.length} related searches.`);
            if (results.localResults) console.log(`    Found ${results.localResults.length} local results.`);

            const html = await page.content();
            fs.writeFileSync('debug-google.html', html);
            console.log(`💾  Dumped HTML to debug-google.html.`);

            return {
                organic: results.organic,
                aiResponse: results.aiResponse,
                featuredSnippet: results.featuredSnippet,
                knowledgePanel: results.knowledgePanel,
                peopleAlsoAsk: results.peopleAlsoAsk,
                directAnswer: results.directAnswer,
                news: results.news,
                videos: results.videos,
                images: results.images,
                shopping: results.shopping,
                relatedSearches: results.relatedSearches,
                localResults: results.localResults
            };

        } catch (e) {
            const msg = (e as Error).message;
            console.error(`❌  Pool search failed via ${browser.workerId}:`, msg);
            browserPool.deregister(browser.workerId);
            pageErrored = true;
        } finally {
            const tRelease = performance.now();
            if (conn && page) {
                await releasePage(conn, page, true);
            }
            console.log(`⏱️  releasePage / cleanup took:               ${Math.round(performance.now() - tRelease)} ms`);
            console.log(`    Total time for this attempt:              ${Math.round(performance.now() - attemptStart)} ms`);
        }
    }

    return null;
}

async function main() {
    const query = process.argv[2] || 'weather in tokyo';
    const response = await timedSearchViaPool(query, 1, false);
    console.log(response)
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});