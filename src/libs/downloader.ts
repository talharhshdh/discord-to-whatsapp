/**
 * @file downloader.ts
 * @description Typed wrapper around the `ab-downloader` package.
 *
 * Supported platforms:
 *  - Instagram  (igdl)
 *  - TikTok     (ttdl)
 *  - Facebook   (fbdown)
 *  - Twitter/X  (twitter)
 *  - YouTube    (youtube)
 *  - MediaFire  (mediafire)
 *  - CapCut     (capcut)
 *  - Google Drive (gdrive)
 *  - Pinterest  (pinterest)
 *
 * Usage:
 *  const result = await detectAndDownload('https://www.instagram.com/p/...');
 *  if (result) { sendBuffer(result.buffer, result.type, result.caption) }
 */

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
  | 'pinterest';

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
  { platform: 'instagram', pattern: /instagram\.com\/(p|reel|tv|stories)\//i },
  { platform: 'tiktok',    pattern: /tiktok\.com\/@[^/]+\/video\/|vm\.tiktok\.com\//i },
  { platform: 'facebook',  pattern: /facebook\.com\/(watch|video|share|reel)|fb\.watch/i },
  { platform: 'twitter',   pattern: /twitter\.com\/\S+\/status\/|x\.com\/\S+\/status\//i },
  { platform: 'youtube',   pattern: /youtube\.com\/watch\?v=|youtu\.be\//i },
  { platform: 'mediafire', pattern: /mediafire\.com\/file\//i },
  { platform: 'capcut',    pattern: /capcut\.com\/template-detail\//i },
  { platform: 'gdrive',    pattern: /drive\.google\.com\/file\/d\//i },
  { platform: 'pinterest', pattern: /pinterest\.(com|co\.uk|ca|com\.au)\/pin\/|pin\.it\//i },
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
  await onProgress?.('🔍 Fetching Instagram link...');
  const data = await igdl(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Instagram: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: '📸 *Instagram*',
    filename: `instagram_${Date.now()}.${ext}`,
  };
}

async function downloadTikTok(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching TikTok link...');
  const data = await ttdl(url);
  const title = (data as unknown as Record<string, unknown>)?.['title'] as string | undefined ?? 'TikTok';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('TikTok: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: `🎵 *TikTok*\n${title}`,
    filename: `tiktok_${Date.now()}.${ext}`,
  };
}

async function downloadFacebook(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Facebook link...');
  const data = await fbdown(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Facebook: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: '📘 *Facebook*',
    filename: `facebook_${Date.now()}.${ext}`,
  };
}

async function downloadTwitter(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching Twitter link...');
  const data = await twitter(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Twitter: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: '🐦 *Twitter / X*',
    filename: `twitter_${Date.now()}.${ext}`,
  };
}

async function downloadYouTube(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching YouTube link...');
  const data = await youtube(url);
  const title = (data as unknown as Record<string, unknown>)?.['title'] as string | undefined ?? 'YouTube';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('YouTube: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: `🎬 *YouTube*\n${title}`,
    filename: `youtube_${Date.now()}.${ext}`,
  };
}

async function downloadMediaFire(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching MediaFire link...');
  const data = await mediafire(url);
  const result = (data as unknown as Record<string, unknown>)?.['result'] as Record<string, unknown> | undefined;
  const fileName = (result?.['filename'] ?? result?.['name'] ?? `mediafire_${Date.now()}`) as string;
  const size = result?.['filesize'] ? `\nSize: ${result['filesize']}` : '';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('MediaFire: no download URL found in response');

  await onProgress?.('📥 Downloading file...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl);
  return {
    buffer, mediaType, mimetype,
    caption: `📁 *MediaFire*\n${fileName}${size}`,
    filename: fileName,
  };
}

async function downloadCapCut(url: string, onProgress?: ProgressCallback): Promise<DownloadResult> {
  await onProgress?.('🔍 Fetching CapCut link...');
  const data = await capcut(url);
  const obj = data as unknown as Record<string, unknown>;
  const title = (obj['title'] ?? 'CapCut Template') as string;
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('CapCut: no download URL found in response');

  await onProgress?.('📥 Downloading media...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: `🎬 *CapCut*\n${title}`,
    filename: `capcut_${Date.now()}.${ext}`,
  };
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
  const data = await pinterest(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Pinterest: no download URL found in response');

  await onProgress?.('📥 Downloading image...');
  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'image/jpeg');
  const ext = mimeToExt(mimetype);
  return {
    buffer, mediaType, mimetype,
    caption: '📌 *Pinterest*',
    filename: `pinterest_${Date.now()}.${ext}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map of platform → downloader function */
const DOWNLOADERS: Record<Platform, (url: string, onProgress?: ProgressCallback) => Promise<DownloadResult>> = {
  instagram: downloadInstagram,
  tiktok:    downloadTikTok,
  facebook:  downloadFacebook,
  twitter:   downloadTwitter,
  youtube:   downloadYouTube,
  mediafire: downloadMediaFire,
  capcut:    downloadCapCut,
  gdrive:    downloadGDrive,
  pinterest: downloadPinterest,
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
 */
export async function detectAndDownload(
  text: string,
  onProgress?: ProgressCallback,
): Promise<DownloadResult | null> {
  const detection = detectPlatform(text);
  if (!detection) return null;

  const { platform, url } = detection;
  console.log(`📥 Detected ${platform} link: ${url}`);

  const downloader = DOWNLOADERS[platform];
  return downloader(url, onProgress);
}
