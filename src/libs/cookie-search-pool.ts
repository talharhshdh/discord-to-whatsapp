import { browserPool } from './browser-pool';
import { acquirePage, releasePage } from './page-pool';
import type { WorkerConnection } from './page-pool';
import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class CookieSearchPool {
  private cookiesMap = new Map<string, string>(); // workerId -> cookie string

  private isCaptcha(html: string): boolean {
    return (
      html.includes('action="/sorry/index"') ||
      html.includes('id="captcha"') ||
      html.includes('g-recaptcha') ||
      html.includes('consent.google.com')
    );
  }

  private async fetchCookiesForWorker(browser: any): Promise<string> {
    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;
    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;
      await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
      const cookies = await page.cookies();
      const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
      this.cookiesMap.set(browser.workerId, cookieStr);
      return cookieStr;
    } catch (e) {
      pageErrored = true;
      throw e;
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  private async clearCookiesForWorker(browser: any): Promise<void> {
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
      this.cookiesMap.delete(browser.workerId);
    } catch (e) {
      pageErrored = true;
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  private async performFetch(url: string, cookie: string): Promise<string> {
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
        "cookie": cookie,
        "Referer": "https://www.google.com/"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }

  public async search(
    text: string,
    pageNumber: number = 1,
    category: string = 'all'
  ): Promise<{ organic: Array<{ title: string; link: string; snippet: string }>, aiResponse: string | null, captcha?: boolean, error?: string }> {
    const activeBrowsers = browserPool.getActive();
    if (activeBrowsers.length === 0) {
      throw new Error('No active browsers available in pool');
    }

    const startParam = (pageNumber - 1) * 10;
    let targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&gbv=2&pws=0`;
    if (category === 'images') {
      targetUrl += '&udm=2';
    } else if (category === 'videos') {
      targetUrl += '&udm=7';
    } else if (category === 'news') {
      targetUrl += '&udm=14';
    } else if (category === 'shopping') {
      targetUrl += '&udm=3';
    }

    for (const browser of activeBrowsers) {
      try {
        let cookie = this.cookiesMap.get(browser.workerId);
        if (!cookie) {
          cookie = await this.fetchCookiesForWorker(browser);
        }

        let html = '';
        try {
          html = await this.performFetch(targetUrl, cookie);
        } catch (err) {
          cookie = await this.fetchCookiesForWorker(browser);
          html = await this.performFetch(targetUrl, cookie);
        }

        if (this.isCaptcha(html)) {
          await this.clearCookiesForWorker(browser);
          cookie = await this.fetchCookiesForWorker(browser);
          html = await this.performFetch(targetUrl, cookie);

          if (this.isCaptcha(html)) {
            console.warn(`[CookieSearchPool] CAPTCHA persists on browser ${browser.workerId}. Trying next browser...`);
            continue;
          }
        }

        const $ = cheerio.load(html);
        const organic: any[] = [];
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

        return { organic, aiResponse: null };
      } catch (e) {
        console.error(`[CookieSearchPool] Search failed on browser ${browser.workerId}:`, e);
      }
    }

    console.error('[CookieSearchPool] All browsers in pool returned CAPTCHA or failed.');
    return {
      organic: [],
      aiResponse: null,
      captcha: true,
      error: 'Google Search CAPTCHA detected on all active browsers and could not be bypassed.'
    };
  }
}

export const cookieSearchPool = new CookieSearchPool();
