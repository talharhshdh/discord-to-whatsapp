/**
 * @file youtube-dl.ts
 * @description YouTube downloader using `youtube-dl-exec` (primary) with quality selection,
 *              audio-only mode, real download progress tracking, and YouTube search via `yt-search`.
 *
 *  Download fallback chain:
 *   1. youtube-dl-exec (yt-dlp) — full quality selection + progress tracking
 *   2. btch-downloader          — simple mp4 URL extraction
 *   3. ab-downloader            — last-resort mp4 URL extraction
 *
 *  Flow:
 *   1. searchYouTube(query)      → top N results (title, url, duration, views, author, thumbnail)
 *   2. getYouTubeInfo(url)       → video metadata + available quality options
 *   3. downloadYouTube(url, fmt) → DownloadResult with progress callbacks
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec') as (
  url: string,
  opts: Record<string, unknown>
) => Promise<YtDlpInfo>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yts = require('yt-search') as (query: string) => Promise<YtsResult>;

// Fallback downloaders
// eslint-disable-next-line @typescript-eslint/no-var-requires
const btch = require('btch-downloader') as Record<string, (url: string) => Promise<unknown>>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { youtube: abYoutube } = require('ab-downloader') as {
  youtube: (url: string) => Promise<unknown>;
};

import * as https from 'https';
import * as http from 'http';
import { IncomingMessage } from 'http';
import { getYouTubeCookiesPath } from './browser';

// ---------------------------------------------------------------------------
// yt-search types
// ---------------------------------------------------------------------------

interface YtsVideo {
  videoId: string;
  url: string;
  title: string;
  description: string;
  thumbnail: string;
  seconds: number;
  timestamp: string;
  views: number;
  ago: string;
  author: { name: string; url: string };
}

interface YtsResult {
  videos: YtsVideo[];
}

// ---------------------------------------------------------------------------
// youtube-dl-exec types (subset we care about)
// ---------------------------------------------------------------------------

export interface YtDlpFormat {
  format_id: string;
  format_note?: string;
  ext: string;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  tbr?: number | null;
  abr?: number | null;
  vbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  resolution?: string;
  /** Direct download URL (DASH streams and direct formats) */
  url?: string;
  protocol?: string;
  audio_ext?: string;
  video_ext?: string;
  dynamic_range?: string;
}

export interface YtDlpInfo {
  id: string;
  title: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  view_count?: number;
  like_count?: number;
  webpage_url?: string;
  formats: YtDlpFormat[];
  /** Best pre-merged format chosen by yt-dlp */
  url?: string;
  ext?: string;
  format_id?: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A simplified search result */
export interface YouTubeSearchResult {
  videoId: string;
  url: string;
  title: string;
  thumbnail: string;
  duration: string; // "4:14"
  durationSeconds: number;
  views: number;
  ago: string;
  author: string;
}

/** A selectable quality option shown to the user */
export interface YouTubeQualityOption {
  /** Stable key used to re-identify this format later, e.g. "1080p", "720p", "audio" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Estimated file size in bytes (may be approximate) */
  sizeBytes: number | null;
  /** Whether this is audio-only */
  audioOnly: boolean;
  /** Internal format_id from yt-dlp */
  formatId: string;
  /** Best audio format_id to merge with (for video-only DASH streams) */
  audioFormatId?: string;
}

/** Video metadata + selectable quality options */
export interface YouTubeVideoInfo {
  videoId: string;
  url: string;
  title: string;
  thumbnail: string;
  durationSeconds: number;
  uploader: string;
  viewCount: number;
  qualities: YouTubeQualityOption[];
}

/** What the bot sends to WhatsApp after a download */
export interface YouTubeDownloadResult {
  buffer: Buffer;
  mediaType: 'video' | 'document';
  mimetype: string;
  caption: string;
  filename: string;
}

/** Progress callback: called with human-readable status strings */
export type YtProgressCallback = (status: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format bytes → human readable string */
function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return '?';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format seconds → mm:ss or hh:mm:ss */
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format large numbers with commas */
function fmtViews(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// 1. YouTube Search
// ---------------------------------------------------------------------------

/**
 * Search YouTube and return the top N results.
 *
 * @param query   Search query string
 * @param limit   Max results to return (default: 5)
 */
export async function searchYouTube(
  query: string,
  limit = 5,
): Promise<YouTubeSearchResult[]> {
  const result = await yts(query);
  return result.videos.slice(0, limit).map((v) => ({
    videoId:         v.videoId,
    url:             v.url,
    title:           v.title,
    thumbnail:       v.thumbnail,
    duration:        v.timestamp,
    durationSeconds: v.seconds,
    views:           v.views,
    ago:             v.ago,
    author:          v.author.name,
  }));
}

// ---------------------------------------------------------------------------
// 2. Get video info + quality options
// ---------------------------------------------------------------------------

/** Common yt-dlp flags used for all requests */
function buildYtdlpBaseFlags(): Record<string, unknown> {
  const flags: Record<string, unknown> = {
    noCheckCertificates: true,
    noWarnings: true,
    addHeader: ['referer:youtube.com', 'user-agent:googlebot'],
  };
  const cookiesPath = getYouTubeCookiesPath();
  if (cookiesPath) {
    flags['cookies'] = cookiesPath;
    console.log(`[youtube-dl] Using cookies from: ${cookiesPath}`);
  }
  return flags;
}

/**
 * Fetches video metadata and builds a list of quality options from yt-dlp.
 *
 * Quality selection rules:
 *  - Video options:  mp4 DASH video-only formats (height 144p–1080p+), deduped by height,
 *                   each paired with the best available m4a audio for merging.
 *  - Audio option:  best m4a audio-only stream (fallback: webm/opus).
 *
 * @param url  YouTube watch URL or youtu.be shortlink
 */
export async function getYouTubeInfo(url: string): Promise<YouTubeVideoInfo> {
  const info = await youtubedl(url, {
    ...buildYtdlpBaseFlags(),
    dumpSingleJson: true,
    preferFreeFormats: false,
  });

  const formats = info.formats ?? [];

  // ── Pick best audio format ──────────────────────────────────────────────
  // Prefer m4a (aac) for widest WhatsApp compatibility; fall back to webm/opus
  const audioFormats = formats.filter(
    (f) => f.vcodec === 'none' && f.acodec !== 'none' && f.url && !f.url.includes('manifest'),
  );
  const bestAudio =
    audioFormats
      .filter((f) => f.audio_ext === 'm4a' || f.ext === 'm4a')
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0] ??
    audioFormats.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];

  // ── Build video quality options ─────────────────────────────────────────
  // Only include mp4 video-only DASH streams with a direct URL (not m3u8)
  const videoFormats = formats.filter(
    (f) =>
      f.vcodec !== 'none' &&
      (f.acodec === 'none' || !f.acodec) &&
      f.height &&
      f.url &&
      !f.url.includes('manifest') &&
      (f.video_ext === 'mp4' || f.ext === 'mp4'),
  );

  // Deduplicate by height, keeping highest vbr per height
  const byHeight = new Map<number, YtDlpFormat>();
  for (const f of videoFormats) {
    const h = f.height!;
    const existing = byHeight.get(h);
    if (!existing || (f.vbr ?? f.tbr ?? 0) > (existing.vbr ?? existing.tbr ?? 0)) {
      byHeight.set(h, f);
    }
  }

  // Sort descending by height (1080 → 144)
  const sortedVideo = Array.from(byHeight.entries())
    .sort(([a], [b]) => b - a)
    .map(([, f]) => f);

  const qualities: YouTubeQualityOption[] = [];

  // Video qualities (video + audio merged during download)
  for (const f of sortedVideo) {
    const label_p = `${f.height}p`;
    const videoBytes = f.filesize ?? f.filesize_approx ?? null;
    const audioBytes = bestAudio ? (bestAudio.filesize ?? bestAudio.filesize_approx ?? null) : null;
    const totalBytes = videoBytes && audioBytes ? videoBytes + audioBytes : videoBytes ?? audioBytes;

    qualities.push({
      key:           `${f.height}p`,
      label:         `🎬 ${label_p} · ${fmtBytes(totalBytes)} · mp4`,
      sizeBytes:     totalBytes,
      audioOnly:     false,
      formatId:      f.format_id,
      audioFormatId: bestAudio?.format_id,
    });
  }

  // Audio-only option
  if (bestAudio) {
    const audioBytes = bestAudio.filesize ?? bestAudio.filesize_approx ?? null;
    qualities.push({
      key:       'audio',
      label:     `🎵 Audio only · ${fmtBytes(audioBytes)} · m4a`,
      sizeBytes: audioBytes,
      audioOnly: true,
      formatId:  bestAudio.format_id,
    });
  }

  return {
    videoId:         info.id,
    url:             info.webpage_url ?? url,
    title:           info.title,
    thumbnail:       info.thumbnail ?? '',
    durationSeconds: info.duration ?? 0,
    uploader:        info.uploader ?? 'Unknown',
    viewCount:       info.view_count ?? 0,
    qualities,
  };
}

// ---------------------------------------------------------------------------
// 3. Download with progress tracking
// ---------------------------------------------------------------------------

/**
 * Downloads media from a YouTube URL using yt-dlp, streaming the bytes
 * through Node's https to track real progress.
 *
 * For video: downloads the video stream and audio stream separately, then
 * passes format IDs to yt-dlp to let it merge them (requires ffmpeg).
 * Falls back to single-stream download if no audio format provided.
 *
 * If yt-dlp fails entirely, falls back to btch-downloader then ab-downloader.
 *
 * @param url           YouTube URL
 * @param quality       Selected quality option from getYouTubeInfo
 * @param onProgress    Progress callback (called periodically during download)
 */
export async function downloadYouTubeVideo(
  url: string,
  quality: YouTubeQualityOption,
  onProgress?: YtProgressCallback,
): Promise<YouTubeDownloadResult> {
  await onProgress?.(`⚙️ *Starting download: ${quality.label}*`);

  // ── Primary: yt-dlp ────────────────────────────────────────────────────
  try {
    // Build format string: "videoId+audioId" or just "audioId" for audio-only
    const formatStr = quality.audioOnly
      ? quality.formatId
      : quality.audioFormatId
        ? `${quality.formatId}+${quality.audioFormatId}`
        : quality.formatId;

    // Get fresh direct URL(s) for the selected format
    const info = await youtubedl(url, {
      ...buildYtdlpBaseFlags(),
      dumpSingleJson: true,
      format: formatStr,
    });

    // yt-dlp returns the chosen format's URL in info.url
    const downloadUrl = info.url;
    if (!downloadUrl) {
      throw new Error(`yt-dlp returned no download URL for format "${formatStr}"`);
    }

    const totalBytes = quality.sizeBytes;
    await onProgress?.(`📥 *Downloading ${quality.label}*\n_0% — ${fmtBytes(totalBytes)} total_`);

    const buffer = await streamWithProgress(downloadUrl, totalBytes, async (pct, downloaded) => {
      const bar = buildProgressBar(pct, 10);
      await onProgress?.(
        `📥 *Downloading ${quality.key}*\n${bar} ${pct}%\n_${fmtBytes(downloaded)} / ${fmtBytes(totalBytes)}_`,
      );
    });

    const ext = quality.audioOnly ? 'm4a' : 'mp4';
    const mimetype = quality.audioOnly ? 'audio/mp4' : 'video/mp4';
    const mediaType: 'video' | 'document' = quality.audioOnly ? 'document' : 'video';

    return {
      buffer,
      mediaType,
      mimetype,
      caption:  `🎬 *${info.title}*\n_${quality.key} · ${fmtDuration(info.duration ?? 0)}_`,
      filename: `${info.title.replace(/[^\w\s-]/g, '').trim()}.${ext}`,
    };
  } catch (primaryErr) {
    console.warn('[youtube-dl] yt-dlp failed, trying fallback downloaders:', primaryErr);
    await onProgress?.(
      `⚠️ *yt-dlp failed — trying fallback downloader...*\n_${(primaryErr as Error).message}_`,
    );
  }

  // ── Fallback: btch-downloader → ab-downloader ──────────────────────────
  return downloadYouTubeVideoFallback(url, onProgress);
}

/**
 * Fallback YouTube downloader.
 * Tries btch-downloader first (returns {mp4, mp3, title}), then ab-downloader.
 * Downloads the best available mp4 URL and returns a YouTubeDownloadResult.
 *
 * @param url        YouTube URL
 * @param onProgress Progress callback
 */
export async function downloadYouTubeVideoFallback(
  url: string,
  onProgress?: YtProgressCallback,
): Promise<YouTubeDownloadResult> {
  let mediaUrl: string | null = null;
  let title = 'YouTube';

  // ── Try btch-downloader ────────────────────────────────────────────────
  try {
    await onProgress?.('🔄 *Trying btch-downloader...*');
    const data = await btch['youtube'](url) as Record<string, unknown>;
    title = (data['title'] as string) ?? title;
    if (typeof data['mp4'] === 'string' && data['mp4']) {
      mediaUrl = data['mp4'] as string;
      console.log('[youtube-dl] btch-downloader succeeded, url:', mediaUrl);
    }
  } catch (btchErr) {
    console.warn('[youtube-dl] btch-downloader also failed:', btchErr);
  }

  // ── Try ab-downloader ──────────────────────────────────────────────────
  if (!mediaUrl) {
    try {
      await onProgress?.('🔄 *Trying ao-downloader...*');
      const data = await abYoutube(url) as Record<string, unknown>;
      title = (data['title'] as string) ?? title;
      if (typeof data['mp4'] === 'string' && data['mp4']) {
        mediaUrl = data['mp4'] as string;
        console.log('[youtube-dl] ab-downloader succeeded, url:', mediaUrl);
      }
    } catch (abErr) {
      console.warn('[youtube-dl] ab-downloader also failed:', abErr);
    }
  }

  if (!mediaUrl) {
    throw new Error(
      'All YouTube download methods failed.\n' +
      'yt-dlp, btch-downloader, and ab-downloader all returned no URL.',
    );
  }

  await onProgress?.(`📥 *Downloading via fallback...*`);

  const buffer = await streamWithProgress(mediaUrl, null, async (pct, downloaded) => {
    const bar = buildProgressBar(pct, 10);
    await onProgress?.(
      `📥 *Downloading (fallback)*\n${bar} ${pct}%\n_${fmtBytes(downloaded)} downloaded_`,
    );
  });

  return {
    buffer,
    mediaType:  'video',
    mimetype:   'video/mp4',
    caption:    `🎬 *${title}*\n_(fallback quality)_`,
    filename:   `${title.replace(/[^\w\s-]/g, '').trim() || 'youtube'}.mp4`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a block-style progress bar */
function buildProgressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Stream a URL to a Buffer, calling progressCb every ~2% or 1 MB of data */
async function streamWithProgress(
  url: string,
  totalBytes: number | null,
  progressCb: (pct: number, downloaded: number) => Promise<void>,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let downloaded = 0;
    let lastReportedPct = -1;
    let lastReportedBytes = 0;
    const REPORT_INTERVAL_BYTES = 1024 * 1024; // 1 MB

    const handleResponse = (res: IncomingMessage) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const fn = loc.startsWith('https') ? https.get : http.get;
        fn(loc, handleResponse).on('error', reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} downloading media`));
        return;
      }

      const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
      const total = contentLength || totalBytes || 0;

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        downloaded += chunk.length;

        if (total > 0) {
          const pct = Math.min(Math.round((downloaded / total) * 100), 99);
          const bytesDelta = downloaded - lastReportedBytes;
          if (pct - lastReportedPct >= 2 || bytesDelta >= REPORT_INTERVAL_BYTES) {
            lastReportedPct = pct;
            lastReportedBytes = downloaded;
            // Fire and forget — don't await to avoid blocking the data stream
            progressCb(pct, downloaded).catch(() => {});
          }
        }
      });

      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    };

    const fn = url.startsWith('https') ? https.get : http.get;
    fn(
      url,
      {
        headers: {
          'User-Agent': 'googlebot',
          'Referer':    'youtube.com',
        },
      },
      handleResponse,
    ).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers (exported for use in index.ts)
// ---------------------------------------------------------------------------

/**
 * Builds the WhatsApp search-result message for a single video.
 *
 * Example:
 *   🎬 *Hans Zimmer - Flight (Man of Steel)*
 *   👤 JexMavik  ·  ⏱ 4:14  ·  👀 33M views  ·  📅 12 years ago
 *   🔗 https://youtube.com/watch?v=w4OdIOGBW2Q
 */
export function formatSearchResultMessage(v: YouTubeSearchResult, index: number): string {
  const views = v.views >= 1_000_000
    ? `${(v.views / 1_000_000).toFixed(1)}M`
    : v.views >= 1_000
      ? `${(v.views / 1_000).toFixed(0)}K`
      : String(v.views);

  return (
    `*${index + 1}. ${v.title}*\n` +
    `👤 ${v.author}  ·  ⏱ ${v.duration}  ·  👀 ${views}  ·  📅 ${v.ago}\n` +
    `🔗 ${v.url}`
  );
}

/**
 * Builds the quality-picker message shown after the user selects a video.
 */
export function formatQualityPickerMessage(info: YouTubeVideoInfo): string {
  const lines: string[] = [
    `🎬 *${info.title}*`,
    `👤 ${info.uploader}  ·  ⏱ ${fmtDuration(info.durationSeconds)}  ·  👀 ${fmtViews(info.viewCount)}`,
    '',
    '*Choose a quality:*',
  ];

  info.qualities.forEach((q, i) => {
    lines.push(`  ${i + 1}. ${q.label}`);
  });

  lines.push('\n_Reply with the number to download_');
  lines.push('_e.g. reply *1* for the first option_');

  return lines.join('\n');
}
