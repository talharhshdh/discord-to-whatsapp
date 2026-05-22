/**
 * test-youtube-dl-info.ts
 *
 * Tests the getYouTubeInfo function in youtube-dl.ts directly.
 *
 * Usage:
 *   TEST_URL="https://www.youtube.com/watch?v=aqz-KE-etYs" npx ts-node src/libs/test-youtube-dl-info.ts
 *
 * Or just run as-is — a default YouTube URL is set below.
 */

import { getYouTubeInfo } from './youtube-dl';
import { getYouTubeCookiesPath } from './browser';
import * as fs from 'fs';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up (very stable)
const TEST_URL = (process.env.TEST_URL ?? DEFAULT_URL).trim();

async function main() {
  console.log('='.repeat(60));
  console.log('🧪 Testing youtube-dl Info API');
  console.log('='.repeat(60));
  console.log(`URL to test: ${TEST_URL}`);

  // Check if cookies are available
  const cookiesPath = getYouTubeCookiesPath();
  if (cookiesPath) {
    console.log(`🍪 Cookies file detected at: ${cookiesPath}`);
    if (fs.existsSync(cookiesPath)) {
      const stats = fs.statSync(cookiesPath);
      console.log(`   Size: ${stats.size} bytes | Last Modified: ${stats.mtime.toLocaleString()}`);
    }
  } else {
    console.log('ℹ️ No YouTube cookies file found (will download without cookies).');
  }
  console.log('='.repeat(60));
  console.log('⏳ Fetching video information via getYouTubeInfo...');
  console.log('='.repeat(60));

  const startTime = Date.now();
  try {
    const info = await getYouTubeInfo(TEST_URL);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Success in ${elapsed}s!`);
    console.log();
    console.log(`🎥 Video Metadata:`);
    console.log(`   - ID       : ${info.videoId}`);
    console.log(`   - Title    : ${info.title}`);
    console.log(`   - Uploader : ${info.uploader}`);
    console.log(`   - Duration : ${info.durationSeconds}s (${Math.floor(info.durationSeconds / 60)}m ${info.durationSeconds % 60}s)`);
    console.log(`   - Views    : ${info.viewCount.toLocaleString()}`);
    console.log(`   - Thumbnail: ${info.thumbnail}`);
    console.log(`   - Watch URL: ${info.url}`);
    console.log();
    console.log(`📊 Available Qualities (${info.qualities.length} options):`);
    console.log('-'.repeat(60));

    // Print standard qualities first
    const standards = info.qualities.filter(q => ['audio-video', 'video-only', 'audio-only'].includes(q.key));
    const formats = info.qualities.filter(q => !['audio-video', 'video-only', 'audio-only'].includes(q.key));

    console.log('🌟 Standard Pre-merged & Fallback Options:');
    standards.forEach(q => {
      const sizeStr = q.sizeBytes ? `${(q.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : 'Unknown';
      console.log(`  • [${q.key}]`);
      console.log(`    Label     : ${q.label}`);
      console.log(`    Format ID : ${q.formatId}`);
      console.log(`    Est. Size : ${sizeStr}`);
      console.log(`    Audio Only: ${q.audioOnly}`);
    });

    console.log('\n🎬 Specific Format Streams:');
    formats.forEach((q, idx) => {
      const sizeStr = q.sizeBytes ? `${(q.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : 'Unknown';
      console.log(`  ${idx + 1}. [${q.key}]`);
      console.log(`     Label     : ${q.label}`);
      console.log(`     Format ID : ${q.formatId}`);
      console.log(`     Est. Size : ${sizeStr}`);
      console.log(`     Audio Only: ${q.audioOnly}`);
      if (q.audioFormatId) {
        console.log(`     Audio Pair: ${q.audioFormatId} (for merging)`);
      }
    });

    console.log('='.repeat(60));
    console.log('✅ Test Completed Successfully!');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('='.repeat(60));
    console.error('❌ Test Failed!');
    console.error('='.repeat(60));
    console.error(error);
    console.error('='.repeat(60));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
