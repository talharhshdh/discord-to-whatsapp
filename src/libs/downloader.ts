/**
 * @file downloader.ts
 * @description Typed wrapper around `ab-downloader` (primary) and `btch-downloader` (fallback + new platforms).
 *
 * Supported platforms:
 *  Primary (ab-downloader):
 *   - Instagram, TikTok, Facebook, Twitter/X, YouTube, MediaFire, CapCut, Google Drive, Pinterest
 *  New / Fallback (btch-downloader):
 *   - Douyin, Kuaishou, Spotify, SoundCloud, Threads, SnackVideo, AIO (all-in-one)
 *
 * Usage:
 *  const result = await detectAndDownload('https://www.instagram.com/p/...');
 *  if (result) { sendBuffer(result.buffer, result.type, result.caption) }
 */

import { queryInstagramGraphQLViaProxy } from './browser-pool';

// Primary downloader (ab-downloader)
const {
  igdl,
  ttdl,
  fbdown,
  twitter,
  youtube,
  mediafire,
  capcut,
  gdrive,
  pinterest,
} = require('ab-downloader') as Record<string, (url: string) => Promise<AbDownloaderResult[]>>;

// btch-downloader — fallback for existing platforms + new ones
const btch = require('btch-downloader') as Record<string, (url: string) => Promise<unknown>>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generic item returned by ab-downloader across all platforms */
export interface AbDownloaderResult {
  /** The public download URL */
  url?: string;
  /** Some platforms nest URLs inside here */
  urls?: string[];
  /** Human-readable quality label e.g. "HD", "SD", "audio" */
  quality?: string;
  /** Explicit mime type when provided */
  type?: string;
  /** Thumbnail URL */
  thumbnail?: string;
  /** Video/post title */
  title?: string;
  /** File name (MediaFire / Drive) */
  name?: string;
  /** File size in bytes (string or number depending on platform) */
  size?: string | number;
  /** Direct download link used by some platforms */
  download?: string;
  /** Filename field used by MediaFire */
  filename?: string;
  [key: string]: unknown;
}

/** What the bot hands off to the WhatsApp sender */
export interface DownloadResult {
  /** Raw file bytes */
  buffer: Buffer;
  /** "video" | "image" | "document" */
  mediaType: 'video' | 'image' | 'document';
  /** Mime type for document sends */
  mimetype: string;
  /** Caption / title shown under the media */
  caption: string;
  /** Filename (for document sends) */
  filename: string;
}

/** Resolved platform name */
export type Platform =
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'twitter'
  | 'youtube'
  | 'mediafire'
  | 'capcut'
  | 'gdrive'
  | 'pinterest'
  | 'douyin'
  | 'kuaishou'
  | 'spotify'
  | 'soundcloud'
  | 'threads'
  | 'snackvideo'
  | 'aio';

/**
 * Called at key stages of a download to report progress to the user.
 * Receives a short human-readable status string.
 */
export type ProgressCallback = (status: string) => Promise<void>;

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/** Ordered list of URL patterns → platform mapping */
const PLATFORM_PATTERNS: Array<{ platform: Platform; pattern: RegExp }> = [
  { platform: 'instagram',  pattern: /instagram\.com\/(p|reels?|tv|stories)\//i },
  { platform: 'tiktok',     pattern: /tiktok\.com\/@[^/]+\/video\/|vm\.tiktok\.com\/|vt\.tiktok\.com\//i },
  { platform: 'facebook',   pattern: /facebook\.com\/(watch|video|share|reels?)|fb\.watch/i },
  { platform: 'twitter',    pattern: /twitter\.com\/\S+\/status\/|x\.com\/\S+\/status\//i },
  { platform: 'youtube',    pattern: /youtube\.com\/watch\?v=|youtu\.be\//i },
  { platform: 'mediafire',  pattern: /mediafire\.com\/file\//i },
  { platform: 'capcut',     pattern: /capcut\.com\/template-detail\//i },
  { platform: 'gdrive',     pattern: /drive\.google\.com\/file\/d\//i },
  { platform: 'pinterest',  pattern: /pinterest\.(com|co\.uk|ca|com\.au)\/pin\/|pin\.it\//i },
  { platform: 'douyin',     pattern: /v\.douyin\.com\//i },
  { platform: 'kuaishou',   pattern: /v\.kuaishou\.com\//i },
  { platform: 'spotify',    pattern: /open\.spotify\.com\/(track|album|playlist)\//i },
  { platform: 'soundcloud', pattern: /soundcloud\.com\//i },
  { platform: 'threads',    pattern: /threads\.net\/@[^/]+\/post\//i },
  { platform: 'snackvideo', pattern: /snackvideo\.com\/|s\.snackvideo\.com\//i },
];

/**
 * Detects whether a text message contains a supported platform URL.
 * Returns the platform name and the extracted URL, or null if not supported.
 */
export function detectPlatform(text: string): { platform: Platform; url: string } | null {
  // Extract all URLs from the text
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return null;

  const url = urlMatch[0].replace(/[.,!?;:'")\]>]+$/, ''); // strip trailing punctuation

  for (const { platform, pattern } of PLATFORM_PATTERNS) {
    if (pattern.test(url)) {
      return { platform, url };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetches a remote URL and returns its raw bytes as a Buffer.
 * Uses the native fetch available in Node ≥ 18.
 */
async function fetchBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching media from ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

/**
 * Picks the best download URL from a list of ab-downloader result items.
 * Priority: HD/high quality first, then first available.
 */
/**
 * Extracts the best download URL from any ab-downloader response shape.
 *
 * Each platform returns a different structure:
 *  Instagram : Array<{url}>                       → item.url
 *  YouTube   : Object {mp4, mp3}                  → mp4
 *  TikTok    : Object {video:[], audio:[]}         → video[0]
 *  Facebook  : Object {HD, Normal_video}           → HD
 *  Twitter   : Object {url:[{hd},{sd}]}            → url[0].hd
 *  MediaFire : Object {result:{downloadUrl}}       → result.downloadUrl
 *  CapCut    : Object {videoUrl}                   → videoUrl
 *  GDrive    : Object {result:{downloadUrl}}       → result.downloadUrl
 *  Pinterest : Object {result:{image, images}}     → result.images.orig.url
 */
function pickBestUrl(raw: unknown): string | null {
  if (!raw) return null;

  // ── Array response (Instagram) ────────────────────────────────────────
  if (Array.isArray(raw)) {
    for (const item of raw as Record<string, unknown>[]) {
      const candidates = [
        item['url'], item['download'],
        ...(Array.isArray(item['urls']) ? item['urls'] : []),
      ].filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // ── YouTube: {mp4, mp3} ───────────────────────────────────────────────
  if (typeof obj['mp4'] === 'string') return obj['mp4'];

  // ── TikTok: {video:[], audio:[]} ──────────────────────────────────────
  if (Array.isArray(obj['video']) && obj['video'].length > 0)
    return (obj['video'] as string[])[0];

  // ── Facebook: {HD, Normal_video} ─────────────────────────────────────
  if (typeof obj['HD'] === 'string')           return obj['HD'];
  if (typeof obj['Normal_video'] === 'string') return obj['Normal_video'];

  // ── Twitter: {url:[{hd:...},{sd:...}]} ───────────────────────────────
  if (Array.isArray(obj['url'])) {
    for (const entry of obj['url'] as Record<string, unknown>[]) {
      const v = entry['hd'] ?? entry['sd'] ?? Object.values(entry)[0];
      if (typeof v === 'string') return v;
    }
  }

  // ── CapCut: {videoUrl} ───────────────────────────────────────────────
  if (typeof obj['videoUrl'] === 'string') return obj['videoUrl'];

  // ── MediaFire / GDrive: {result:{downloadUrl}} ───────────────────────
  const result = obj['result'] as Record<string, unknown> | undefined;
  if (result && typeof result['downloadUrl'] === 'string') return result['downloadUrl'];

  // ── Pinterest: {result:{image, images:{orig:{url}}}} ─────────────────
  if (result) {
    const images = result['images'] as Record<string, unknown> | undefined;
    if (images) {
      const orig = images['orig'] as Record<string, unknown> | undefined;
      if (orig && typeof orig['url'] === 'string') return orig['url'];
    }
    if (typeof result['image'] === 'string') return result['image'];
  }

  // ── Generic fallback: first string field starting with http ──────────
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.startsWith('http')) return v;
  }

  return null;
}

/**
 * Extracts a download URL from btch-downloader's response shapes.
 *
 * Shapes handled:
 *  TikTok   : {status,title,video:[url,...],audio:[url,...]}          → video[0]
 *  Facebook : {status,HD,Normal_video}                                → HD
 *  Twitter  : {status,title,url:[{hd},{sd}]}                         → url[0].hd
 *  YouTube  : {status,title,mp4,mp3}                                 → mp4
 *  MediaFire: {status,result:{filename,filesize,url}}                 → result.url
 *  CapCut   : {status,title,originalVideoUrl}                        → originalVideoUrl
 *  Pinterest: {status,result:{result:{image,images:{orig:{url}}}}}   → images.orig.url
 *  Douyin   : {status,result:{data:{links:[{url}]}}}                 → links[0].url
 *  Kuaishou : {status,result:{videoUrl}}                             → result.videoUrl
 *  Spotify  : {status,result:{formats:[{url}]}}                      → formats[0].url
 *  SoundCloud:{status,result:{audio,downloadMp3}}                    → downloadMp3
 *  Threads  : {status,result:{video}}                                → result.video
 *  SnackVideo:{status,result:{videoUrl}}                             → result.videoUrl
 *  AIO      : {status,data:{links:{video:[{url}]}}}                  → data.links.video[0].url
 */
/**
 * Recursively searches an object/array for the first string starting with 'http'.
 */
function findHttpUrl(obj: unknown): string | null {
  if (!obj) return null;
  if (typeof obj === 'string') {
    if (obj.startsWith('http')) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findHttpUrl(item);
      if (found) return found;
    }
  } else if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const priorityKeys = ['url', 'downloadUrl', 'videoUrl', 'originalVideoUrl', 'download', 'mp4', 'link', 'hd', 'sd'];
    for (const key of priorityKeys) {
      if (typeof record[key] === 'string' && (record[key] as string).startsWith('http')) {
        return record[key] as string;
      }
    }
    for (const val of Object.values(record)) {
      const found = findHttpUrl(val);
      if (found) return found;
    }
  }
  return null;
}

function pickBtchUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // ── TikTok: {video:[url,...]} ─────────────────────────────────────────
  if (Array.isArray(obj['video']) && obj['video'].length > 0) {
    const v = (obj['video'] as unknown[])[0];
    if (typeof v === 'string') return v;
  }

  // ── Facebook: {HD, Normal_video} ─────────────────────────────────────
  if (typeof obj['HD'] === 'string') return obj['HD'];
  if (typeof obj['Normal_video'] === 'string') return obj['Normal_video'];

  // ── Twitter: {url:[{hd},{sd}]} ────────────────────────────────────────
  if (Array.isArray(obj['url'])) {
    for (const e of obj['url'] as Record<string, unknown>[]) {
      const v = e['hd'] ?? e['sd'] ?? Object.values(e)[0];
      if (typeof v === 'string') return v;
    }
  }

  // ── YouTube: {mp4, mp3} ───────────────────────────────────────────────
  if (typeof obj['mp4'] === 'string' && obj['mp4']) return obj['mp4'];

  // ── CapCut: {originalVideoUrl} ───────────────────────────────────────
  if (typeof obj['originalVideoUrl'] === 'string') return obj['originalVideoUrl'];

  const result = obj['result'] as Record<string, unknown> | undefined;

  // ── MediaFire: {result:{url}} ─────────────────────────────────────────
  if (result && typeof result['url'] === 'string') return result['url'];

  // ── SoundCloud: {result:{downloadMp3, audio}} ────────────────────────
  if (result && typeof result['downloadMp3'] === 'string') return result['downloadMp3'];
  if (result && typeof result['audio'] === 'string') return result['audio'];

  // ── Kuaishou / SnackVideo: {result:{videoUrl}} ───────────────────────
  if (result && typeof result['videoUrl'] === 'string') return result['videoUrl'];

  // ── Threads: {result:{video}} ────────────────────────────────────────
  if (result && typeof result['video'] === 'string') return result['video'];

  // ── Spotify: {result:{formats:[{url}]}} ──────────────────────────────
  if (result && Array.isArray(result['formats'])) {
    const fmt = (result['formats'] as Record<string, unknown>[])[0];
    if (fmt && typeof fmt['url'] === 'string') return fmt['url'];
  }

  // ── Pinterest: {result:{result:{images:{orig:{url}}}}} ───────────────
  if (result) {
    const inner = result['result'] as Record<string, unknown> | undefined;
    if (inner) {
      const images = inner['images'] as Record<string, unknown> | undefined;
      if (images) {
        const orig = images['orig'] as Record<string, unknown> | undefined;
        if (orig && typeof orig['url'] === 'string') return orig['url'];
      }
      if (typeof inner['image'] === 'string') return inner['image'];
      if (typeof inner['videoUrl'] === 'string') return inner['videoUrl'];
    }
    // ── Douyin: {result:{data:{links:[{url}]}}} ──────────────────────
    const data = result['data'] as Record<string, unknown> | undefined;
    if (data && Array.isArray(data['links'])) {
      const link = (data['links'] as Record<string, unknown>[])[0];
      if (link && typeof link['url'] === 'string') return link['url'];
    }
  }

  // ── AIO: {data:{links:{video:[{url}]}}} ──────────────────────────────
  const aioData = obj['data'] as Record<string, unknown> | undefined;
  if (aioData) {
    const links = aioData['links'] as Record<string, unknown> | undefined;
    if (links && Array.isArray(links['video'])) {
      const v = (links['video'] as Record<string, unknown>[])[0];
      if (v && typeof v['url'] === 'string') return v['url'];
    }
  }

  return findHttpUrl(obj);
}

/**
 * Maps a mime type to a clean file extension.
 * Falls back to the mime subtype when no explicit mapping exists.
 */
function mimeToExt(mime: string): string {
  const MAP: Record<string, string> = {
    'video/mp4':        'mp4',
    'video/webm':       'webm',
    'video/quicktime':  'mov',
    'video/x-matroska': 'mkv',
    'image/jpeg':       'jpg',
    'image/png':        'png',
    'image/gif':        'gif',
    'image/webp':       'webp',
    'audio/mpeg':       'mp3',
    'audio/mp4':        'm4a',
  };
  return MAP[mime] ?? (mime.split('/')[1] ?? 'bin');
}

/**
 * Derives media type and mime from content-type header, URL extension hint,
 * and a platform-specific fallback for when servers return 'application/octet-stream'.
 *
 * @param contentType   Raw Content-Type header from the download response.
 * @param url           The download URL (used to sniff extension when ct is generic).
 * @param platformDefault  Mime type to use when the server gives no useful type
 *                        (e.g. 'video/mp4' for video platforms, 'image/jpeg' for images).
 */
function resolveMediaType(
  contentType: string,
  url: string,
  platformDefault = 'video/mp4',
): {
  mediaType: 'video' | 'image' | 'document';
  mimetype: string;
} {
  const ct = contentType.split(';')[0].trim().toLowerCase();

  if (ct.startsWith('video/') || /\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) {
    return { mediaType: 'video', mimetype: ct.startsWith('video/') ? ct : 'video/mp4' };
  }
  if (ct.startsWith('image/') || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
    return { mediaType: 'image', mimetype: ct.startsWith('image/') ? ct : 'image/jpeg' };
  }

  // Server returned a generic or unknown type — trust the platform hint.
  if (ct === 'application/octet-stream' || ct === '' || !ct.includes('/')) {
    return resolveMediaType(platformDefault, url, platformDefault);
  }

  // Known non-media type (e.g. text/html on an error page).
  return { mediaType: 'document', mimetype: ct };
}

// ---------------------------------------------------------------------------
// Platform downloaders
// ---------------------------------------------------------------------------

async function downloadInstagram(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  void onProgress?.('🔍 Fetching Instagram link...').catch(() => { /* non-fatal */ });

  try {
    const match = url.match(/\/reels?\/([A-Za-z0-9_\-]+)/) || url.match(/\/p\/([A-Za-z0-9_\-]+)/) || url.match(/^([A-Za-z0-9_\-]+)$/);
    const shortcode = match ? match[1] : null;

    const headers = {
      "accept": "*/*",
      "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      "priority": "u=1, i",
      "sec-ch-prefers-color-scheme": "dark",
      "sec-ch-ua": "\"Microsoft Edge\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
      "sec-ch-ua-full-version-list": "\"Microsoft Edge\";v=\"149.0.4022.69\", \"Chromium\";v=\"149.0.7827.115\", \"Not)A;Brand\";v=\"24.0.0.0\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-model": "\"\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua-platform-version": "\"19.0.0\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-asbd-id": "359341",
      "x-bloks-version-id": "6a1a99aad521621204ad31915fc0c45ea5ef62c4d409c123a63ab00c26644d3c",
      "x-csrftoken": "RuRfo4YVVLe36Fmubi4lCPGNAjPgpNnz",
      "x-fb-friendly-name": "PolarisClipsTabDesktopPaginationQuery",
      "x-fb-lsd": "7w-X0yZTFUrItDbwsrmuuT",
      "x-ig-app-id": "936619743392459",
      "x-ig-max-touch-points": "0",
      "x-root-field-name": "xdt_api__v1__clips__home__connection_v2",
      "cookie": "datr=tQ9AaN0k1nJ5-s7vKlZS9UYS; ps_l=1; ps_n=1; mid=aXjHJAALAAHZ4omyd0ebSy9JGEB2; ds_user_id=74746116933; csrftoken=RuRfo4YVVLe36Fmubi4lCPGNAjPgpNnz; ig_did=5906265C-E189-4CD5-9F76-2B5B4FF3D41A; dpr=1.25; sessionid=74746116933%3A68S1uRjPm1RDUb%3A6%3AAYgwhey3C_lUF0OsrB7GTp-3zIjNkCW3cYJltrw6zRE; wd=1213x948; rur=\"RVA\\05474746116933\\0541813401870:01ff261438d2b5600ba440b7482549c17940ec379859b0469563a9c6bb99ef8b32c7f43b\"",
      "Referer": `https://www.instagram.com/reels/${shortcode}/`
    };

    const variables = {
      after: "GhaG2fmbk9Kk7mwm8Lzb99tnFAI0AikIGAAaCBgNczoxOWVkZjdiNmYzOBQBGgYZDBaG2fmbk9Kk7mwA",
      before: null,
      data: {
        container_module: "clips_tab_desktop_page",
        seen_reels: JSON.stringify([]),
        chaining_media_id: shortcode,
        should_refetch_chaining_media: false
      },
      first: 10,
      last: null,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false
    };

    const postData = {
      av: "17841474788003264",
      __d: "www",
      __user: "0",
      __a: "1",
      __req: "b",
      __hs: "20623.HYP:instagram_web_pkg.2.1...0",
      dpr: "1",
      __ccg: "GOOD",
      __rev: "1041789422",
      __s: "v3jela:aclzj4:8kbcq7",
      __hsi: "7653055630017428357",
      __dyn: "7xeUjG1mxu1syUbFp41twpUnwgU7SbzEdF8aUco2qwJw5ux609vCwjE1EE2Cw8G11wBw5Zx62G3i1ywOwv89k2C0O86a0D82IzXwae4UaEW2G0AEco5G0zEnwhE2Lw62wLyES1Twoob82ZwrUdUbGwmk0KU6O1FwlA1HQp1yU426V8aUuwm8jw4kyVrx60luawOwi84q2i0jK3mew",
      __csr: "gP136MrYIYRvincxONlgFlKKWcTmLZCKArLVWVnJm-CZ4yCP8F5TJlFCDhKKAKaV5VpoF5z98OECmJd5p9UJ29qCAOk5p8yfuQ-Qui4d2XAKCcmbWCyUoypF8W2KUtwBxB1m6VEbVe4odovAGUhDBSmu8WU9Erx9126k4EK9xO8-3KdBix5oK48mGm4U8E8EtBz806Oq0bTw1Z-00OaUuw2pE3MCwe103LU2Iwfi0qKbBolw1BK3CiE0XMi0Ho6a0zO02eEjwFgaU3vw2cA0nS5VRg62rYw-05e85px201jow0ghU668g",
      __hsdp: "gMxps46yYGOqbEy7F8khXGilXp4EykwNWntpFmSUByUZdosKWwmp3pBAx62sAwvBo7l4x2i0geExo8827wbK1Xx60RUK7F8O0xEoK12wZxGQ9w810zxq2y0hqcwwy80DS6o0BC480VO2a0cSg0jywlU11U1A-0qO2u0i-04bo1hA0Wo3XwywAzF80ByE",
      __hblp: "0Hwb-9wgVbxWq5onxO0yVu5pHz8gzoa65awFwhofE4qfzE88bo5C1fGfwywRwuUSUe8d84W6EK7F8O2q22227ooK12wZxGQ9AK1Tg8UmwEwbSUaUa8O228xK0mG14xa0DEpw5oxy0UpogwtU1ME1oo8E0Pp033o1D8dU5ufwtU7-2i0ctwDw4Lxm0C80B20iS2S0hx0bW2G2a0S88E98Wi0ui1PG",
      __sjsp: "mxZEmn2ExWbOHGjuJ8uAxh7KunXp4EykwNWntpFmSUByU-hosyE6N6x61lo",
      __comet_req: "7",
      fb_dtsg: "NAfyJ0MR6wMhUV5EOMWYEfXYPIEPOVqgdP82tpXYLCjKMRO8JExhhlQ:17865379441060568:1778309334",
      jazoest: "26163",
      lsd: "7w-X0yZTFUrItDbwsrmuuT",
      __spin_r: "1041789422",
      __spin_b: "trunk",
      __spin_t: "1781865868",
      __crn: "comet.igweb.PolarisClipsTabDesktopProfiledContentRoute",
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "PolarisClipsTabDesktopPaginationQuery",
      server_timestamps: "true",
      variables: JSON.stringify(variables),
      doc_id: "36825039943776829"
    };

    const body = new URLSearchParams(postData).toString();

    const mediaUrlFromGraphQL = async (jsonPromise: Promise<any>): Promise<string> => {
      const json = await jsonPromise;
      const edges = json?.data?.xdt_api__v1__clips__home__connection_v2?.edges || [];
      const videoUrl = edges[0]?.node?.media?.video_versions?.[0]?.url;
      if (typeof videoUrl !== 'string') throw new Error('Instagram GraphQL returned no video');
      return videoUrl;
    };

    const mediaUrlFromProvider = async (provider: () => Promise<unknown>): Promise<string> => {
      const data = await provider();
      const mediaUrl = pickBestUrl(data) ?? pickBtchUrl(data);
      if (!mediaUrl) throw new Error('Instagram provider returned no media');
      return mediaUrl;
    };

    // These resolvers are independent. Racing them avoids waiting for a slow remote browser
    // before trying the much lighter provider APIs.
    const resolvers: Promise<string>[] = [
      mediaUrlFromProvider(() => igdl(url)),
      mediaUrlFromProvider(() => btch['igdl'](url)),
    ];

    if (shortcode) {
      const directGraphQL = fetch('https://www.instagram.com/graphql/query', {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      }).then(async res => {
        if (!res.ok) throw new Error(`Instagram GraphQL HTTP ${res.status}`);
        return res.json();
      });
      resolvers.push(
        mediaUrlFromGraphQL(directGraphQL),
        mediaUrlFromGraphQL(queryInstagramGraphQLViaProxy(postData, headers)),
      );
    }

    const mediaUrl = await Promise.any(resolvers);

    void onProgress?.('📥 Downloading media...').catch(() => { /* non-fatal */ });
    const { buffer, contentType } = await fetchBuffer(mediaUrl);
    const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
    const ext = mimeToExt(mimetype);
    return { buffer, mediaType, mimetype, caption: '📸 *Instagram*', filename: `instagram_${Date.now()}.${ext}` };
  } catch (err) {
    console.error('Instagram download failed:', err);
    throw new Error('Instagram: no download URL found');
  }
}

async function downloadTikTok(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching TikTok link...');
  let mediaUrl: string | null = null;
  let title = 'TikTok';
  try {
    const data = await ttdl(url);
    title = (data as unknown as Record<string, unknown>)?.['title'] as string ?? title;
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['ttdl'](url) as Record<string, unknown>;
    title = data['title'] as string ?? title;
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('TikTok: no download URL found');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `🎵 *TikTok*\n${title}`, filename: `tiktok_${Date.now()}.${ext}` };
}

async function downloadFacebook(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Facebook link...');
  let mediaUrl: string | null = null;
  try {
    const data = await fbdown(url);
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['fbdown'](url);
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('Facebook: no download URL found');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: '📘 *Facebook*', filename: `facebook_${Date.now()}.${ext}` };
}

async function downloadTwitter(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Twitter link...');
  let mediaUrl: string | null = null;
  try {
    const data = await twitter(url);
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['twitter'](url);
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('Twitter: no download URL found');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: '🐦 *Twitter / X*', filename: `twitter_${Date.now()}.${ext}` };
}

async function downloadYouTube(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching YouTube link...');
  let mediaUrl: string | null = null;
  let title = 'YouTube';
  try {
    const data = await youtube(url);
    title = (data as unknown as Record<string, unknown>)?.['title'] as string ?? title;
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['youtube'](url) as Record<string, unknown>;
    title = data['title'] as string ?? title;
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('YouTube: no download URL found');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `🎬 *YouTube*\n${title}`, filename: `youtube_${Date.now()}.${ext}` };
}

async function downloadMediaFire(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching MediaFire link...');
  let mediaUrl: string | null = null;
  let fileName = `mediafire_${Date.now()}`;
  let size = '';
  try {
    const data = await mediafire(url);
    const result = (data as unknown as Record<string, unknown>)?.['result'] as Record<string, unknown> | undefined;
    fileName = (result?.['filename'] ?? result?.['name'] ?? fileName) as string;
    size = result?.['filesize'] ? `\nSize: ${result['filesize']}` : '';
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['mediafire'](url) as Record<string, unknown>;
    const result = data['result'] as Record<string, unknown> | undefined;
    fileName = (result?.['filename'] ?? fileName) as string;
    size = result?.['filesize'] ? `\nSize: ${result['filesize']}` : '';
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('MediaFire: no download URL found');

  await onProgress?.('📥 Downloading file...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl);
  return { buffer, mediaType, mimetype, caption: `📁 *MediaFire*\n${fileName}${size}`, filename: fileName };
}

async function downloadCapCut(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching CapCut link...');
  let mediaUrl: string | null = null;
  let title = 'CapCut Template';
  try {
    const data = await capcut(url);
    const obj = data as unknown as Record<string, unknown>;
    title = obj['title'] as string ?? title;
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['capcut'](url) as Record<string, unknown>;
    title = data['title'] as string ?? title;
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('CapCut: no download URL found');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `🎬 *CapCut*\n${title}`, filename: `capcut_${Date.now()}.${ext}` };
}

async function downloadGDrive(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Google Drive link...');
  const data = await gdrive(url);
  const result = (data as unknown as Record<string, unknown>)?.['result'] as Record<string, unknown> | undefined;
  const fileName = (result?.['filename'] ?? `gdrive_${Date.now()}`) as string;
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Google Drive: no download URL found in response');

  await onProgress?.('📥 Downloading file...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl);
  return {
    buffer, mediaType, mimetype,
    caption: `💾 *Google Drive*\n${fileName}`,
    filename: fileName,
  };
}

async function downloadPinterest(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Pinterest link...');
  let mediaUrl: string | null = null;
  try {
    const data = await pinterest(url);
    mediaUrl = pickBestUrl(data);
  } catch (_) { /* fall through */ }

  if (!mediaUrl) {
    const data = await btch['pinterest'](url);
    mediaUrl = pickBtchUrl(data);
  }
  if (!mediaUrl) throw new Error('Pinterest: no download URL found');

  await onProgress?.('📥 Downloading image...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'image/jpeg');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: '📌 *Pinterest*', filename: `pinterest_${Date.now()}.${ext}` };
}

// ---------------------------------------------------------------------------
// New platform downloaders (btch-downloader only)
// ---------------------------------------------------------------------------

/**
 * Download from Douyin (抖音).
 * Response: {status, result:{status, data:{title, thumbnail, links:[{quality, url}]}}}
 */
async function downloadDouyin(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching Douyin link...');
  const data = await btch['douyin'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const inner = result?.['data'] as Record<string, unknown> | undefined;
  const title = (inner?.['title'] ?? 'Douyin') as string;
  const links = inner?.['links'] as Record<string, unknown>[] | undefined;
  const mediaUrl = (links && links[0]?.['url'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('Douyin: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\u62BD\u97F3 *Douyin*\n${title}`, filename: `douyin_${Date.now()}.${ext}` };
}

/**
 * Download from Kuaishou.
 * Response: {status, result:{success, videoUrl, title, author}}
 */
async function downloadKuaishou(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching Kuaishou link...');
  const data = await btch['kuaishou'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const title = (result?.['title'] ?? 'Kuaishou') as string;
  const mediaUrl = (result?.['videoUrl'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('Kuaishou: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\uD83C\uDF89 *Kuaishou*\n${title}`, filename: `kuaishou_${Date.now()}.${ext}` };
}

/**
 * Download from Spotify.
 * Response: {status, result:{title, thumbnail, duration, formats:[{url, quality, ext}]}}
 */
async function downloadSpotify(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching Spotify link...');
  const data = await btch['spotify'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const title = (result?.['title'] ?? 'Spotify') as string;
  const formats = result?.['formats'] as Record<string, unknown>[] | undefined;
  const mediaUrl = (formats?.[0]?.['url'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('Spotify: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading audio...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'audio/mpeg');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\uD83C\uDFB5 *Spotify*\n${title}`, filename: `spotify_${Date.now()}.${ext}` };
}

/**
 * Download from SoundCloud.
 * Response: {status, result:{status, title, thumbnail, audio, downloadMp3}}
 */
async function downloadSoundCloud(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching SoundCloud link...');
  const data = await btch['soundcloud'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const title = (result?.['title'] ?? 'SoundCloud') as string;
  const mediaUrl = (result?.['downloadMp3'] as string) ?? (result?.['audio'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('SoundCloud: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading audio...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'audio/mpeg');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\uD83C\uDFB6 *SoundCloud*\n${title}`, filename: `soundcloud_${Date.now()}.${ext}` };
}

/**
 * Download from Threads.
 * Response: {status, result:{status, type, video}}
 */
async function downloadThreads(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching Threads link...');
  const data = await btch['threads'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const mediaUrl = (result?.['video'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('Threads: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: '\uD83E\uDDF5 *Threads*', filename: `threads_${Date.now()}.${ext}` };
}

/**
 * Download from SnackVideo.
 * Response: {status, result:{status, videoUrl, title, thumbnail}}
 */
async function downloadSnackVideo(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching SnackVideo link...');
  const data = await btch['snackvideo'](url) as Record<string, unknown>;
  const result = data['result'] as Record<string, unknown> | undefined;
  const title = (result?.['title'] ?? 'SnackVideo') as string;
  const mediaUrl = (result?.['videoUrl'] as string) ?? pickBtchUrl(data);
  if (!mediaUrl) throw new Error('SnackVideo: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\uD83C\uDF7F *SnackVideo*\n${title}`, filename: `snackvideo_${Date.now()}.${ext}` };
}

/**
 * AIO (All-In-One) downloader — generic fallback for any URL.
 * Response: {status, data:{title, thumbnail, links:{video:[{url}], audio:[{url}]}}}
 */
async function downloadAio(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('\uD83D\uDD0D Fetching link (AIO)...');
  const data = await btch['aio'](url) as Record<string, unknown>;
  const aioData = data['data'] as Record<string, unknown> | undefined;
  const title = (aioData?.['title'] ?? 'Media') as string;
  const mediaUrl = pickBtchUrl(data);
  if (!mediaUrl) throw new Error('AIO: no download URL found');

  await onProgress?.('\uD83D\uDCE5 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return { buffer, mediaType, mimetype, caption: `\uD83C\uDF0D *Media*\n${title}`, filename: `media_${Date.now()}.${ext}` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map of platform → downloader function */
const DOWNLOADERS: Record<Platform, (url: string, onProgress?: ProgressCallback) => Promise<DownloadResult>> = {
  instagram:  downloadInstagram,
  tiktok:     downloadTikTok,
  facebook:   downloadFacebook,
  twitter:    downloadTwitter,
  youtube:    downloadYouTube,
  mediafire:  downloadMediaFire,
  capcut:     downloadCapCut,
  gdrive:     downloadGDrive,
  pinterest:  downloadPinterest,
  douyin:     downloadDouyin,
  kuaishou:   downloadKuaishou,
  spotify:    downloadSpotify,
  soundcloud: downloadSoundCloud,
  threads:    downloadThreads,
  snackvideo: downloadSnackVideo,
  aio:        downloadAio,
};

/**
 * Main entry point.
 * Detects the platform from the message text, downloads the media, and
 * returns a DownloadResult ready to be sent via WhatsApp.
 *
 * Returns `null` if no supported platform URL is found.
 * Throws if the download fails.
 *
 * @param text       Raw WhatsApp message text.
 * @param onProgress Optional callback called at each download stage.
 * @param allowFallbackToAio Fallback to AIO downloader if no specific platform matches.
 */
export async function detectAndDownload(
  text: string,
  onProgress?: ProgressCallback,
  allowFallbackToAio = false,
): Promise<DownloadResult | null> {
  let detection = detectPlatform(text);
  if (!detection && allowFallbackToAio) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,!?;:'")\]>]+$/, '');
      detection = { platform: 'aio', url };
    }
  }
  if (!detection) return null;

  const { platform, url } = detection;

  const downloader = DOWNLOADERS[platform];
  return downloader(url, onProgress);
}
