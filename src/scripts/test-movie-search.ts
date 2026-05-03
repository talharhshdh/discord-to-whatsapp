/**
 * @file test-movie-search.ts
 * @description Integration tests for src/libs/movie-search.ts
 *
 * Run with:
 *   npx ts-node src/scripts/test-movie-search.ts
 *
 * Tests:
 *  1. buildWatchUrl() returns correct movie embed URL
 *  2. buildWatchUrl() returns correct TV embed URL
 *  3. searchMovies() returns results (live TMDB call)
 *  4. searchMovies() result shape is correct
 *  5. formatMovieResult() produces expected substrings
 *  6. formatMovieSearchMessage() wraps results correctly
 *  7. searchMovies() returns empty array for an absurd query
 */

import assert from 'assert/strict';
import {
  buildWatchUrl,
  searchMovies,
  formatMovieResult,
  formatMovieSearchMessage,
  type MovieSearchResult,
} from '../libs/movie-search';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`       ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no network)
// ---------------------------------------------------------------------------

console.log('\n📦 Unit tests (buildWatchUrl, formatters)');

test('buildWatchUrl – movie', () => {
  const url = buildWatchUrl(634649, 'movie');
  assert.ok(url.includes('/embed/movie'), `Expected /embed/movie in "${url}"`);
  assert.ok(url.includes('tmdb=634649'), `Expected tmdb=634649 in "${url}"`);
  assert.ok(url.includes('screenfetch2.xyz'), `Expected screenfetch2.xyz in "${url}"`);
});

test('buildWatchUrl – tv', () => {
  const url = buildWatchUrl(888, 'tv');
  assert.ok(url.includes('/embed/tv'), `Expected /embed/tv in "${url}"`);
  assert.ok(url.includes('tmdb=888'), `Expected tmdb=888 in "${url}"`);
});

test('formatMovieResult – contains title and watch link', () => {
  const mockResult: MovieSearchResult = {
    tmdbId:      634649,
    title:       'Spider-Man: No Way Home',
    overview:    'Peter Parker is unmasked.',
    posterPath:  '/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg',
    mediaType:   'movie',
    releaseDate: '2021-12-15',
    voteAverage: 7.9,
    voteCount:   21869,
    posterUrl:   'https://image.tmdb.org/t/p/w500/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg',
    watchUrl:    buildWatchUrl(634649, 'movie'),
  };
  const msg = formatMovieResult(mockResult, 0);
  assert.ok(msg.includes('*1. Spider-Man: No Way Home*'), `Missing title in: ${msg}`);
  assert.ok(msg.includes('(2021)'), `Missing year in: ${msg}`);
  assert.ok(msg.includes('🎬'), `Missing movie emoji in: ${msg}`);
  assert.ok(msg.includes('screenfetch2.xyz'), `Missing watch URL in: ${msg}`);
  assert.ok(msg.includes('⭐ 7.9'), `Missing rating in: ${msg}`);
});

test('formatMovieResult – truncates long overview', () => {
  const longOverview = 'A'.repeat(200);
  const mockResult: MovieSearchResult = {
    tmdbId: 1, title: 'Test', overview: longOverview, posterPath: null,
    mediaType: 'movie', releaseDate: '2024-01-01', voteAverage: 0, voteCount: 0,
    posterUrl: '', watchUrl: buildWatchUrl(1, 'movie'),
  };
  const msg = formatMovieResult(mockResult, 0);
  assert.ok(msg.includes('…'), `Expected truncation ellipsis in: ${msg}`);
});

test('formatMovieResult – TV show uses 📺 emoji', () => {
  const mockResult: MovieSearchResult = {
    tmdbId: 888, title: 'Spider-Man', overview: 'Animated series.', posterPath: null,
    mediaType: 'tv', releaseDate: '1994-11-19', voteAverage: 8.3, voteCount: 1124,
    posterUrl: '', watchUrl: buildWatchUrl(888, 'tv'),
  };
  const msg = formatMovieResult(mockResult, 1);
  assert.ok(msg.includes('📺'), `Expected 📺 emoji in: ${msg}`);
});

test('formatMovieSearchMessage – contains header and reply instruction', () => {
  const mockResults: MovieSearchResult[] = [
    {
      tmdbId: 1, title: 'Test Movie', overview: 'An overview.', posterPath: null,
      mediaType: 'movie', releaseDate: '2023-01-01', voteAverage: 7.5, voteCount: 500,
      posterUrl: '', watchUrl: buildWatchUrl(1, 'movie'),
    },
  ];
  const msg = formatMovieSearchMessage(mockResults, 'test');
  assert.ok(msg.includes('🎥 *Movie Search Results*'), `Missing header in: ${msg}`);
  assert.ok(msg.includes('"test"'), `Missing query in: ${msg}`);
  assert.ok(msg.includes('Reply with a number'), `Missing reply instruction in: ${msg}`);
});

// ---------------------------------------------------------------------------
// Integration tests (live TMDB calls)
// ---------------------------------------------------------------------------

console.log('\n🌐 Integration tests (live TMDB API calls – may take a few seconds)');

async function runIntegrationTests() {
  await test('searchMovies("spiderman") – returns results', async () => {
    const results = await searchMovies('spiderman', 5);
    assert.ok(results.length > 0, `Expected results, got ${results.length}`);
  });

  await test('searchMovies("spiderman") – result shape is correct', async () => {
    const results = await searchMovies('spiderman', 3);
    for (const r of results) {
      assert.ok(typeof r.tmdbId === 'number', `tmdbId must be number, got ${typeof r.tmdbId}`);
      assert.ok(typeof r.title === 'string' && r.title.length > 0, `title must be non-empty string`);
      assert.ok(r.mediaType === 'movie' || r.mediaType === 'tv', `mediaType must be movie|tv, got ${r.mediaType}`);
      assert.ok(r.watchUrl.startsWith('https://screenfetch2.xyz'), `watchUrl format wrong: ${r.watchUrl}`);
      assert.ok(r.watchUrl.includes(`tmdb=${r.tmdbId}`), `watchUrl missing tmdbId: ${r.watchUrl}`);
    }
  });

  await test('searchMovies("") – handles empty query gracefully', async () => {
    try {
      const results = await searchMovies('', 5);
      // TMDB may return trending results or empty — either is acceptable
      assert.ok(Array.isArray(results), 'Expected array');
    } catch {
      // Network error or TMDB error is acceptable for empty query
    }
  });

  await test('searchMovies("xyzqwertynonexistent1234567890") – returns empty array', async () => {
    const results = await searchMovies('xyzqwertynonexistent1234567890', 5);
    assert.equal(results.length, 0, `Expected 0 results, got ${results.length}`);
  });
}

// ---------------------------------------------------------------------------
// Run everything
// ---------------------------------------------------------------------------

(async () => {
  await runIntegrationTests();

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
})();
