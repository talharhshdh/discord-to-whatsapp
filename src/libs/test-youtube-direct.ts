/**
 * test-youtube-direct.ts
 *
 * Standalone direct test script that reads browser_data/youtube-cookies.txt
 * and fetches YouTube video metadata directly via youtube-dl-exec.
 *
 * Usage:
 *   npx ts-node src/libs/test-youtube-direct.ts [videoUrl]
 */

import youtubedl from 'youtube-dl-exec';
import * as fs from 'fs';
import * as path from 'path';

// Parse CLI argument or use requested video
const DEFAULT_URL = 'https://www.youtube.com/watch?v=JZU09WSrJA8';
const videoUrl = process.argv[2] || DEFAULT_URL;

function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return 'Unknown';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function main() {
  console.log('='.repeat(70));
  console.log('🚀 STANDALONE DIRECT YOUTUBE COOKIE DIAGNOSTIC');
  console.log('='.repeat(70));
  console.log(`Video URL: ${videoUrl}`);

  // Resolve absolute path to the cookies file
  const cookiesPath = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');
  console.log(`Cookies Path: ${cookiesPath}`);

  if (!fs.existsSync(cookiesPath)) {
    console.error(`❌ ERROR: Cookies file not found at ${cookiesPath}!`);
    console.error('Please make sure the file exists and has correct read permissions.');
    process.exit(1);
  }

  const cookieStats = fs.statSync(cookiesPath);
  console.log(`✅ Cookies File Found! (${cookieStats.size} bytes, modified: ${cookieStats.mtime.toLocaleString()})`);
  console.log('='.repeat(70));
  console.log('⏳ Sending authenticated request to YouTube (no custom User-Agent)...');
  console.log('='.repeat(70));

  const startTime = Date.now();

  try {
    const rawInfo = await youtubedl(videoUrl, {
      noCheckCertificates: true,
      noWarnings: true,
      cookies: cookiesPath,
      dumpSingleJson: true,
      preferFreeFormats: false,
      format: 'all',
    }) as any;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`🎉 SUCCESS! Metadata fetched in ${elapsed}s!`);
    console.log('='.repeat(70));

    console.log(`🎥 Video Metadata:`);
    console.log(`   - ID         : ${rawInfo.id}`);
    console.log(`   - Title      : ${rawInfo.title}`);
    console.log(`   - Uploader   : ${rawInfo.uploader}`);
    console.log(`   - Duration   : ${fmtDuration(rawInfo.duration || 0)} (${rawInfo.duration || 0}s)`);
    console.log(`   - View Count : ${(rawInfo.view_count || 0).toLocaleString()}`);
    console.log(`   - Like Count : ${(rawInfo.like_count || 0).toLocaleString()}`);
    console.log();

    console.log(`📊 Available Streams / Formats (${rawInfo.formats?.length || 0} options):`);
    console.log('-'.repeat(70));

    const formats = rawInfo.formats || [];
    let videoCount = 0;
    let audioCount = 0;

    formats.forEach((f: any, idx: number) => {
      const vcodec = f.vcodec || 'none';
      const acodec = f.acodec || 'none';
      const ext = f.ext || 'unknown';
      const height = f.height || null;
      const size = f.filesize || f.filesize_approx || null;

      const isAudio = vcodec === 'none' && acodec !== 'none';
      const isVideoOnly = vcodec !== 'none' && acodec === 'none';
      const isPreMerged = vcodec !== 'none' && acodec !== 'none';

      if (isAudio) audioCount++;
      if (isVideoOnly || isPreMerged) videoCount++;

      let typeStr = '';
      if (isAudio) typeStr = '🎵 Audio-Only';
      else if (isVideoOnly) typeStr = '📹 Video-Only';
      else if (isPreMerged) typeStr = '🎬 Audio+Video';
      else typeStr = '❓ Unknown';

      const resStr = height ? `${height}p` : f.resolution || 'N/A';
      const fpsStr = f.fps ? `@${f.fps}fps` : '';
      const sizeStr = fmtBytes(size);
      const brStr = f.tbr ? `(${f.tbr.toFixed(0)} kbps)` : '';

      console.log(
        `   [${String(idx + 1).padStart(3, ' ')}] ID: ${String(f.format_id).padEnd(12)} | ` +
        `${typeStr.padEnd(12)} | ${ext.padEnd(5)} | ${resStr.padStart(6)}${fpsStr.padEnd(7)} | ` +
        `Size: ${sizeStr.padStart(10)} ${brStr}`
      );
    });

    console.log('-'.repeat(70));
    console.log(`📊 Summary: Found ${videoCount} Video streams and ${audioCount} Audio streams.`);
    console.log('='.repeat(70));
    console.log('✅ COOKIES ARE VALID AND AUTHENTICATED SUCCESSFULLY!');
    console.log('='.repeat(70));
    process.exit(0);

  } catch (error: any) {
    console.error('❌ DIRECT PIPELINE CALL FAILED!');
    console.error('='.repeat(70));
    console.error(error);
    console.log('='.repeat(70));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
