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
function pickBestUrl(items: AbDownloaderResult[]): string | null {
  if (!items || items.length === 0) return null;

  const flatten = (item: AbDownloaderResult): string[] => {
    const candidates: string[] = [];
    if (item.url)      candidates.push(item.url);
    if (item.download) candidates.push(item.download);
    if (item.urls)     candidates.push(...item.urls);
    return candidates.filter(Boolean);
  };

  // Prefer HD quality
  const hd = items.find(i =>
    /hd|high|1080|720/i.test(i.quality ?? i.type ?? '')
  );
  if (hd) {
    const urls = flatten(hd);
    if (urls.length) return urls[0];
  }

  // Fallback: first item with any URL
  for (const item of items) {
    const urls = flatten(item);
    if (urls.length) return urls[0];
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

async function downloadInstagram(url: string): Promise<DownloadResult> {
  const data = await igdl(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Instagram: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  // Instagram always delivers video — force mp4 when server returns octet-stream
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: '📸 *Instagram*',
    filename: `instagram_${Date.now()}.${ext}`,
  };
}

async function downloadTikTok(url: string): Promise<DownloadResult> {
  const data = await ttdl(url);
  const title = (data[0]?.title as string | undefined) ?? 'TikTok';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('TikTok: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: `🎵 *TikTok*\n${title}`,
    filename: `tiktok_${Date.now()}.${ext}`,
  };
}

async function downloadFacebook(url: string): Promise<DownloadResult> {
  const data = await fbdown(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Facebook: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: '📘 *Facebook*',
    filename: `facebook_${Date.now()}.${ext}`,
  };
}

async function downloadTwitter(url: string): Promise<DownloadResult> {
  const data = await twitter(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Twitter: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: '🐦 *Twitter / X*',
    filename: `twitter_${Date.now()}.${ext}`,
  };
}

async function downloadYouTube(url: string): Promise<DownloadResult> {
  const data = await youtube(url);
  const title = (data[0]?.title as string | undefined) ?? 'YouTube';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('YouTube: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: `🎬 *YouTube*\n${title}`,
    filename: `youtube_${Date.now()}.${ext}`,
  };
}

async function downloadMediaFire(url: string): Promise<DownloadResult> {
  const data = await mediafire(url);
  const item = data[0];
  const fileName = (item?.filename ?? item?.name ?? `mediafire_${Date.now()}`) as string;
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('MediaFire: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl);
  const size = item?.size ? `\nSize: ${item.size}` : '';
  return {
    buffer,
    mediaType,
    mimetype,
    caption: `📁 *MediaFire*\n${fileName}${size}`,
    filename: fileName,
  };
}

async function downloadCapCut(url: string): Promise<DownloadResult> {
  const data = await capcut(url);
  const title = (data[0]?.title as string | undefined) ?? 'CapCut Template';
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('CapCut: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'video/mp4');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: `🎬 *CapCut*\n${title}`,
    filename: `capcut_${Date.now()}.${ext}`,
  };
}

async function downloadGDrive(url: string): Promise<DownloadResult> {
  const data = await gdrive(url);
  const item = data[0];
  const fileName = (item?.name ?? `gdrive_${Date.now()}`) as string;
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Google Drive: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: `💾 *Google Drive*\n${fileName}`,
    filename: fileName,
  };
}

async function downloadPinterest(url: string): Promise<DownloadResult> {
  const data = await pinterest(url);
  const mediaUrl = pickBestUrl(data);
  if (!mediaUrl) throw new Error('Pinterest: no download URL found in response');

  const { buffer, contentType } = await fetchBuffer(mediaUrl);
  // Pinterest serves images primarily; use image/jpeg as fallback
  const { mediaType, mimetype } = resolveMediaType(contentType, mediaUrl, 'image/jpeg');
  const ext = mimeToExt(mimetype);
  return {
    buffer,
    mediaType,
    mimetype,
    caption: '📌 *Pinterest*',
    filename: `pinterest_${Date.now()}.${ext}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map of platform → downloader function */
const DOWNLOADERS: Record<Platform, (url: string) => Promise<DownloadResult>> = {
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
 * @example
 * const result = await detectAndDownload('https://www.tiktok.com/@user/video/123');
 * if (result) sock.sendMessage(jid, { video: result.buffer, caption: result.caption });
 */
export async function detectAndDownload(text: string): Promise<DownloadResult | null> {
  const detection = detectPlatform(text);
  if (!detection) return null;

  const { platform, url } = detection;
  console.log(`📥 Detected ${platform} link: ${url}`);

  const downloader = DOWNLOADERS[platform];
  return downloader(url);
}
