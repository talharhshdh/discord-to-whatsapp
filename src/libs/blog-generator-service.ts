import { GoogleGenAI, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import { searchViaPool } from './browser-pool';
import fs from 'fs';

// Ensure environment variables are loaded
import * as dotenv from 'dotenv';
dotenv.config();

interface BlogPayload {
  title: string;
  description: string;
  content: string;
  tags: string[];
  imageUrl?: string;
}

/**
 * Fallback to custom dashboard scraper proxy.
 */
async function fallbackDashboardSearch(query: string): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const domain = process.env.DASHBOARD_DOMAIN || `services.${process.env.MAIN_DOMAIN || 'ufone-claim.site'}`;
  const url = `https://${domain}/api/browser/search`;
  const auth = Buffer.from(`${process.env.DASHBOARD_USERNAME || 'dkgklfdglkdfgljfd'}:${process.env.DASHBOARD_PASSWORD || 'sdlkfsdlglkdkl4mt'}`).toString('base64');

  try {
    console.log(`[Blog Gen] Fetching search from dashboard scraper API: ${url}`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        "accept": "*/*",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "authorization": `Basic ${auth}`,
        "content-type": "application/json",
        "cookie": `dashboard_token=${auth}`
      },
      body: JSON.stringify({
        text: query,
        pageNumber: 1,
        engine: "auto",
        includeAI: true,
        category: "all"
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.warn(`[Blog Gen] Custom dashboard scraper HTTP error: ${resp.status}`);
      return [];
    }

    const data = await resp.json() as any;
    if (data && Array.isArray(data.organic)) {
      console.log(`[Blog Gen] Custom dashboard scraper returned ${data.organic.length} results.`);
      return data.organic.map((item: any) => ({
        title: item.title || '',
        link: item.link || '',
        snippet: item.snippet || ''
      }));
    }
  } catch (err: any) {
    console.error(`[Blog Gen] Custom dashboard scraper fetch failed:`, err.message);
  }
  return [];
}

/**
 * Robust fallback Google Search using direct fetch if remote browser pool is empty/offline.
 */
async function fallbackDirectSearch(query: string): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const organic: Array<{ title: string; link: string; snippet: string }> = [];
  try {
    const resp = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "priority": "u=0, i",
        "sec-ch-prefers-color-scheme": "dark",
        "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
        "sec-ch-ua-arch": "\"x86\"",
        "sec-ch-ua-bitness": "\"64\"",
        "sec-ch-ua-form-factors": "\"Desktop\"",
        "sec-ch-ua-full-version": "\"148.0.7778.168\"",
        "sec-ch-ua-full-version-list": "\"Chromium\";v=\"148.0.7778.168\", \"Google Chrome\";v=\"148.0.7778.168\", \"Not/A)Brand\";v=\"99.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua-platform-version": "\"19.0.0\"",
        "sec-ch-ua-wow64": "?0",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "x-browser-channel": "stable",
        "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
        "x-browser-validation": "puPtlXuojC+VILE1bgaJ40YGt+E=",
        "x-browser-year": "2026",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "Referer": "https://www.google.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.warn(`[Blog Gen] Direct fallback search HTTP error: ${resp.status}`);
      return [];
    }
    const html = await resp.text();

    if (
      html.includes('action="/sorry/index"') ||
      html.includes('id="captcha"') ||
      html.includes('g-recaptcha')
    ) {
      console.warn('[Blog Gen] Direct fallback search hit CAPTCHA.');
      fs.writeFileSync('google-dump-captcha.html', html);
      return [];
    }

    const $ = cheerio.load(html);
    const seen = new Set<string>();

    $('div.g, div[data-sokoban-container], div[data-hveid]').each((_, el) => {
      const h3 = $(el).find('h3').first();
      if (!h3.length) return;
      const title = h3.text().trim();
      if (!title) return;
      const anchor = h3.closest('a[href^="http"]').length
        ? h3.closest('a[href^="http"]')
        : h3.parent().closest('a[href^="http"]');
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

    if (organic.length === 0) {
      console.warn('[Blog Gen] Fallback search parsed 0 results. Dumping HTML for inspection.');
      fs.writeFileSync('google-dump-zero-results.html', html);
    }
  } catch (err: any) {
    console.error(`[Blog Gen] Fallback direct search threw:`, err.message);
  }
  return organic;
}

/**
 * Curated list of high-quality tech/dev images from Unsplash.
 */
const TECH_IMAGES = [
  {
    keywords: ['react', 'nextjs', 'next.js', 'frontend', 'javascript', 'typescript', 'tailwind'],
    url: 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?q=80&w=1200'
  },
  {
    keywords: ['python', 'ai', 'machine learning', 'data science', 'llm', 'gemini', 'gpt', 'deep learning', 'openai', 'agent'],
    url: 'https://images.unsplash.com/photo-1515879218367-8466d910aaa4?q=80&w=1200'
  },
  {
    keywords: ['git', 'github', 'github actions', 'ci/cd', 'ci-cd', 'deployment', 'vercel', 'devops', 'automation'],
    url: 'https://images.unsplash.com/photo-1618401471353-b98aedd07871?q=80&w=1200'
  },
  {
    keywords: ['server', 'cloud', 'aws', 'docker', 'kubernetes', 'backend', 'databases', 'sql', 'postgresql', 'mongodb'],
    url: 'https://images.unsplash.com/photo-1600132806370-bf17e65e942f?q=80&w=1200'
  },
  {
    keywords: ['cyber', 'security', 'hack', 'encryption', 'auth', 'privacy'],
    url: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?q=80&w=1200'
  },
  {
    keywords: ['rust', 'golang', 'go', 'c++', 'c#', 'backend language', 'performance', 'systems'],
    url: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=1200'
  },
  {
    keywords: ['workspace', 'desk', 'laptop', 'developer setup', 'keyboard', 'monitor'],
    url: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?q=80&w=1200'
  }
];

/**
 * Select a verified working Unsplash image matching the title/tags.
 */
function selectWorkingImage(title: string, tags: string[]): string {
  const text = `${title} ${tags.join(' ')}`.toLowerCase();
  for (const item of TECH_IMAGES) {
    if (item.keywords.some(k => text.includes(k))) {
      return item.url;
    }
  }
  // Fallback abstract programming code image
  return 'https://images.unsplash.com/photo-1542831371-29b0f74f9713?q=80&w=1200';
}

/**
 * Helper to query Google Search using all available scraper backends in order.
 */
async function searchGoogle(query: string): Promise<Array<{ title: string; link: string; snippet: string }>> {
  let searchResults: Array<{ title: string; link: string; snippet: string }> = [];

  // Try 1: Remote browser pool
  try {
    const poolRes = await searchViaPool(query, 1, false, 'all');
    if (poolRes && poolRes.organic && poolRes.organic.length > 0) {
      searchResults = poolRes.organic;
      console.log(`[Blog Gen] Fetched ${searchResults.length} results from remote browser pool.`);
    }
  } catch (err: any) {
    console.warn(`[Blog Gen] Browser pool search failed: ${err.message}. Trying custom dashboard scraper...`);
  }

  // Try 2: Custom dashboard scraper
  if (searchResults.length === 0) {
    console.log(`[Blog Gen] Browser pool empty or failed. Performing custom dashboard scraper request...`);
    searchResults = await fallbackDashboardSearch(query);
  }

  // Try 3: Direct fetch fallback
  if (searchResults.length === 0) {
    console.log(`[Blog Gen] Custom dashboard scraper empty. Performing direct fallback search...`);
    searchResults = await fallbackDirectSearch(query);
    console.log(`[Blog Gen] Fetched ${searchResults.length} results via fallback search.`);
  }

  return searchResults;
}

/**
 * Searches for tech trends, generates a mind-blowing blog post using Gemini,
 * and posts it to the website's Vercel endpoint.
 */
export async function generateAndPostBlog(): Promise<{ success: boolean; message: string; data?: any; error?: string }> {
  // Step 1: Discover Trending Topic
  console.log(`[Blog Gen] Discovering latest programming and tech trends...`);
  const trendSearchResults = await searchGoogle('latest programming and tech trends 2026');
  if (trendSearchResults.length === 0) {
    return { success: false, message: 'Initial trend discovery search returned 0 results. Aborting.' };
  }

  const trendContext = trendSearchResults
    .slice(0, 8)
    .map((res, i) => `[${i+1}] Title: ${res.title}\nSummary: ${res.snippet}\n`)
    .join('\n');

  // Initialize Gemini Client
  const apiKey = process.env.GEMINI_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, message: 'Missing GEMINI_AI_API_KEY or GEMINI_API_KEY in environment variables.' };
  }
  const ai = new GoogleGenAI({ apiKey });

  const discoverPrompt = `
Analyze these search results about recent programming and tech developments.
Identify the single most trending, hot, or breakthrough technology/framework/topic for developers right now.
Provide a clean JSON response specifying:
1. "trendingTopic": The exact technology/framework/topic (e.g. "React 19 Server Actions").
2. "searchQuery": A highly specific Google Search query to research this topic further (e.g. "React 19 Server Actions new features developer guide 2026").

Search results:
${trendContext}

You MUST respond with a JSON object matching this schema:
{
  "trendingTopic": "e.g., React 19 Server Actions",
  "searchQuery": "e.g., React 19 Server Actions new features developer guide 2026"
}
`;

  console.log(`[Blog Gen] Calling Gemini to identify the hot trending topic...`);
  let trendData: { trendingTopic: string; searchQuery: string };
  try {
    const discoverRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: discoverPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            trendingTopic: { type: Type.STRING },
            searchQuery: { type: Type.STRING }
          },
          required: ['trendingTopic', 'searchQuery']
        }
      }
    });

    if (!discoverRes.text) throw new Error('Empty trend discovery response.');
    trendData = JSON.parse(discoverRes.text);
    console.log(`[Blog Gen] Discovered Trending Topic: "${trendData.trendingTopic}"`);
    console.log(`[Blog Gen] Selected Research Search Query: "${trendData.searchQuery}"`);
  } catch (err: any) {
    return { success: false, message: `Failed to discover trending topic via AI: ${err.message}` };
  }

  // Step 2: Research Chosen Trend Specifically
  console.log(`[Blog Gen] Researching "${trendData.trendingTopic}" via Google Search...`);
  const researchResults = await searchGoogle(trendData.searchQuery);
  if (researchResults.length === 0) {
    return { success: false, message: `Google Search returned 0 results for research query: "${trendData.searchQuery}". Aborting.` };
  }

  const detailedContext = researchResults
    .slice(0, 8)
    .map((res, i) => `[${i+1}] Title: ${res.title}\nURL: ${res.link}\nSummary: ${res.snippet}\n`)
    .join('\n');

  // Step 3: Write Blog Post
  const blogPrompt = `
You are a senior staff software engineer writing a technical, insightful blog post for developers.
Write a blog post about the trending topic: "${trendData.trendingTopic}" based on the following research context:

${detailedContext}

Strict Style and Tone Guidelines:
1. **Persona**: Write from the perspective of an active, pragmatically minded programmer. Avoid cheerleading or corporate marketing speak. Be realistic, slightly skeptical where appropriate, and focus on developer utility.
2. **NO Clichés**: Do NOT use phrases like "Hello fellow coders/innovators", "maestros", "seismic shift", "game-changer", "let's dive in", "let's cut to the chase", "elephant in the room", "unequivocally clear", "delve", "testament", "beacon", "look no further".
3. **NO Citations**: Never output bracketed search citations like "[1]", "[4]", or "[7]". Strip them out completely.
4. **Format & Technical Depth**:
   - Write a compelling technical title (no cheesy colon suffixes if they sound like clickbait).
   - Write a clear 1-2 sentence description for card list views.
   - The body must be 800+ words.
   - Use clean, well-formatted Markdown.
   - You MUST include a realistic code block or architectural setup demonstrating the topic (e.g. showing a TypeScript/React/Python implementation pattern or configuration file matching the subject). Explain the code cleanly.
   - Avoid overusing generic tables or lists for everything; instead, use descriptive paragraphs, code comments, and standard markdown subheadings (\`##\`, \`###\`).
5. **Tags**: Provide a list of relevant tags (e.g. ["TypeScript", "Next.js", "AI"]).

You MUST respond with a JSON object matching this schema:
{
  "title": "A Clean, Technical Title",
  "description": "Exemplary 1-2 sentence excerpt",
  "content": "The full blog body in Markdown...",
  "tags": ["Tag1", "Tag2"]
}
`;

  console.log(`[Blog Gen] Generating blog content via Gemini...`);
  let blogData: { title: string; description: string; content: string; tags: string[]; imageUrl?: string };
  try {
    const blogRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: blogPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            content: { type: Type.STRING },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ['title', 'description', 'content', 'tags']
        }
      }
    });

    if (!blogRes.text) throw new Error('Empty blog content response.');
    const rawBlog = JSON.parse(blogRes.text);
    
    // Select working cover image
    const imageUrl = selectWorkingImage(rawBlog.title, rawBlog.tags);

    blogData = {
      title: rawBlog.title,
      description: rawBlog.description,
      content: rawBlog.content,
      tags: rawBlog.tags,
      imageUrl
    };
    console.log(`[Blog Gen] Successfully generated blog: "${blogData.title}"`);
  } catch (err: any) {
    return { success: false, message: `Failed to generate blog content via Gemini: ${err.message}` };
  }

  // Step 4: Post to Vercel Endpoint
  const blogApiKey = process.env.BLOG_API_KEY;
  if (!blogApiKey) {
    return { success: false, message: 'Missing BLOG_API_KEY in environment variables.' };
  }

  console.log(`[Blog Gen] Publishing blog to Vercel...`);
  try {
    const publishResponse = await fetch('https://talhatech.vercel.app/api/blog', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': blogApiKey
      },
      body: JSON.stringify(blogData)
    });

    const responseText = await publishResponse.text();
    let result: any;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr: any) {
      console.error(`[Blog Gen] Vercel response was not JSON. HTTP Status: ${publishResponse.status}. Raw Response:`, responseText.slice(0, 1000));
      return {
        success: false,
        message: `Vercel endpoint returned non-JSON response (HTTP ${publishResponse.status}).`,
        error: responseText.slice(0, 500)
      };
    }

    if (publishResponse.ok && result.success) {
      console.log(`[Blog Gen] Blog published successfully! URL: ${result.data?.url}`);
      return {
        success: true,
        message: 'Blog post generated and published successfully!',
        data: result.data
      };
    } else {
      console.error(`[Blog Gen] Publishing failed:`, result);
      return {
        success: false,
        message: `Failed to publish blog: ${result.error || JSON.stringify(result)}`
      };
    }
  } catch (err: any) {
    console.error(`[Blog Gen] Publishing error:`, err);
    return { success: false, message: `Publishing network error: ${err.message}` };
  }
}
