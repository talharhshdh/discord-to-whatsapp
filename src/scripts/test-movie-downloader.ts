/**
 * @file test-movie-downloader.ts
 * @description Quick CLI script to test the movie-downloader pipeline.
 *
 * Usage (from project root):
 *   npx ts-node src/scripts/test-movie-downloader.ts <tmdbId> [movie|tv]
 *
 * Example:
 *   npx ts-node src/scripts/test-movie-downloader.ts 1087736 movie
 *
 * Output: Prints the resolved m3u8 stream URLs to stdout.
 * No download occurs — only the URL resolution chain is tested.
 */

import { getMovieStreamUrls } from '../libs/movie-downloader';

async function main() {
  const tmdbId = 634649
  const mediaType = (process.argv[3] ?? 'movie');

  // if (isNaN(tmdbId)) {
  //   console.error('Usage: npx ts-node src/scripts/test-movie-downloader.ts <tmdbId> [movie|tv]');
  //   console.error('Example: npx ts-node src/scripts/test-movie-downloader.ts 1087736 movie');
  //   process.exit(1);
  // }


  const urls = await getMovieStreamUrls(tmdbId, "movie");

  if (urls.length === 0) {
    console.error('❌ No stream URLs resolved.');
    process.exit(1);
  }

  urls.forEach((url, i) => {
  });

}

main().catch((err) => {
  console.error('❌ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
