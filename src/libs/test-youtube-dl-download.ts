/**
 * test-youtube-dl-download.ts
 *
 * Tests the entire youtube-dl pipeline (info fetch + download + file writing) on VPS.
 *
 * Usage:
 *   npx ts-node src/libs/test-youtube-dl-download.ts [videoUrlOrId]
 */

import { getYouTubeInfo, downloadYouTubeVideo } from './youtube-dl';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
const targetUrl = process.argv[2] || DEFAULT_URL;

async function main() {
  console.log('='.repeat(70));
  console.log('🧪 RUNNING END-TO-END DOWNLOAD PIPELINE TEST');
  console.log('='.repeat(70));
  console.log(`URL to test: ${targetUrl}`);
  console.log('='.repeat(70));

  console.log('⏳ Step 1: Fetching video metadata and formats...');
  const startTime = Date.now();
  
  let info;
  try {
    info = await getYouTubeInfo(targetUrl);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Success in ${elapsed}s!`);
    console.log(`   - Title   : ${info.title}`);
    console.log(`   - Uploader: ${info.uploader}`);
    console.log(`   - Duration: ${info.durationSeconds}s`);
    console.log(`   - Available Quality Options: ${info.qualities.length}`);
  } catch (error: any) {
    console.error('❌ Failed to fetch video info!');
    console.error(error);
    process.exit(1);
  }

  console.log('\n📊 Available Qualities:');
  info.qualities.slice(0, 8).forEach((q, idx) => {
    console.log(`   ${idx + 1}. [${q.key}] - ${q.label}`);
  });
  if (info.qualities.length > 8) {
    console.log(`   ... and ${info.qualities.length - 8} more quality options.`);
  }

  // Find a lightweight quality to test download.
  // Preferably 'audio-only' or a low-res video stream to make it fast.
  const selectedQuality = info.qualities.find(q => q.key === 'audio-only') || info.qualities[0];

  console.log('\n📥 Step 2: Downloading selected quality...');
  console.log(`   - Selected Key  : ${selectedQuality.key}`);
  console.log(`   - Selected Label: ${selectedQuality.label}`);
  console.log('='.repeat(70));

  const downloadStart = Date.now();
  try {
    const result = await downloadYouTubeVideo(targetUrl, selectedQuality, async (status) => {
      // Clean up markdown bold/italic tags for plain terminal logging
      const cleanStatus = status.replace(/\*/g, '').replace(/_/g, '');
      console.log(`   [Progress] ${cleanStatus}`);
    });

    const elapsedDownload = ((Date.now() - downloadStart) / 1000).toFixed(2);
    console.log('='.repeat(70));
    console.log(`✅ Download Completed in ${elapsedDownload}s!`);
    console.log(`   - Media Type : ${result.mediaType}`);
    console.log(`   - Mimetype   : ${result.mimetype}`);
    console.log(`   - Caption    : ${result.caption.replace(/\*/g, '').replace(/_/g, '')}`);
    console.log(`   - Buffer Size: ${(result.buffer.length / (1024 * 1024)).toFixed(2)} MB`);

    console.log('\n💾 Step 3: Writing downloaded buffer to disk...');
    const outputPath = path.join(process.cwd(), result.filename);
    fs.writeFileSync(outputPath, result.buffer);
    
    console.log(`✅ Success! File saved to:`);
    console.log(`   👉 ${outputPath}`);
    
    const diskStats = fs.statSync(outputPath);
    console.log(`   - File size on disk: ${(diskStats.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log('='.repeat(70));
    console.log('🎉 ALL PIPELINE CHECKS PASSED SUCCESSFULLY!');
    console.log('='.repeat(70));
  } catch (error: any) {
    console.error('\n❌ Pipeline Download Failed!');
    console.error(error);
    console.log('='.repeat(70));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal main error:', err);
  process.exit(1);
});
