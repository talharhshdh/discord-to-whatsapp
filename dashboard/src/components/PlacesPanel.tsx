import React, { useState } from 'react';
import { api, PlaceResult, PlacesSearchResult } from '../api';

// ── Sub-components ────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`text-xs ${
            i < full
              ? 'text-amber-400'
              : i === full && half
              ? 'text-amber-400/60'
              : 'text-white/15'
          }`}
        >
          ★
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ openNow }: { openNow: boolean | null }) {
  if (openNow === null) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
        openNow
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          : 'bg-red-500/10 border-red-500/30 text-red-400'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${openNow ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {openNow ? 'Open now' : 'Closed'}
    </span>
  );
}

function PlaceCard({ place }: { place: PlaceResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="glass rounded-2xl border border-white/[0.06] hover:border-white/[0.12] transition-all duration-300 overflow-hidden group">
      {/* Header */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <h4 className="text-white font-semibold text-base leading-tight truncate group-hover:text-[#6c63ff] transition-colors">
              {place.name}
            </h4>
            {place.category && (
              <p className="text-xs text-white/40 mt-0.5">{place.category}</p>
            )}
          </div>
          {place.priceLevel && (
            <span className="flex-shrink-0 text-xs font-bold text-[#00d4aa] bg-[#00d4aa]/10 border border-[#00d4aa]/20 px-2 py-0.5 rounded-lg">
              {place.priceLevel}
            </span>
          )}
        </div>

        {/* Rating row */}
        {place.rating !== null && (
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-400 font-bold text-sm">{place.rating.toFixed(1)}</span>
            <StarRating rating={place.rating} />
            {place.reviewCount !== null && (
              <span className="text-xs text-white/35">
                ({place.reviewCount.toLocaleString()} reviews)
              </span>
            )}
          </div>
        )}

        {/* Status + hours */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge openNow={place.openNow} />
          {place.todaysHours && (
            <span className="text-xs text-white/45">{place.todaysHours}</span>
          )}
          {place.isClaimed && (
            <span className="text-[10px] text-[#6c63ff] bg-[#6c63ff]/10 border border-[#6c63ff]/20 px-2 py-0.5 rounded-full">
              ✓ Claimed
            </span>
          )}
        </div>

        {/* Address + phone */}
        <div className="space-y-1.5">
          {place.address && (
            <div className="flex items-start gap-2 text-xs text-white/55">
              <span className="mt-0.5 flex-shrink-0">📍</span>
              <span>{place.address}</span>
            </div>
          )}
          {place.phone && (
            <div className="flex items-center gap-2 text-xs text-white/55">
              <span>📞</span>
              <a href={`tel:${place.phone}`} className="hover:text-[#00d4aa] transition-colors">
                {place.phone}
              </a>
            </div>
          )}
          {place.website && (
            <div className="flex items-center gap-2 text-xs">
              <span>🌐</span>
              <a
                href={place.website}
                target="_blank"
                rel="noreferrer"
                className="text-[#6c63ff] hover:underline truncate max-w-[240px]"
              >
                {place.website.replace(/^https?:\/\//, '')}
              </a>
            </div>
          )}
        </div>

        {/* Description */}
        {place.description && (
          <p className="mt-3 text-xs text-white/50 leading-relaxed line-clamp-2">
            {place.description}
          </p>
        )}
      </div>

      {/* Expandable details */}
      {(place.weeklyHours || place.amenities.length > 0 || place.lat !== null) && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full px-5 py-2 flex items-center justify-between text-xs text-white/35 hover:text-white/60 border-t border-white/[0.05] hover:bg-white/[0.02] transition-all"
          >
            <span>{expanded ? 'Show less' : 'More details'}</span>
            <span className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▾</span>
          </button>

          {expanded && (
            <div className="px-5 pb-5 space-y-4 border-t border-white/[0.04] pt-4">
              {/* Weekly hours */}
              {place.weeklyHours && Object.keys(place.weeklyHours).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-white/30 mb-2">Hours</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(place.weeklyHours).map(([day, hrs]) => (
                      <div key={day} className="flex justify-between gap-2 text-xs">
                        <span className="text-white/50 font-medium">{day}</span>
                        <span className="text-white/35 text-right">{hrs}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Amenities */}
              {place.amenities.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-white/30 mb-2">Amenities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {place.amenities.map((a, i) => (
                      <span
                        key={i}
                        className="text-[10px] bg-white/[0.04] border border-white/[0.07] text-white/50 px-2 py-0.5 rounded-full"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Coordinates */}
              {place.lat !== null && place.lng !== null && (
                <div className="flex items-center gap-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">Coordinates</p>
                  <p className="text-xs text-white/40 font-mono">
                    {place.lat.toFixed(6)}, {place.lng.toFixed(6)}
                  </p>
                </div>
              )}

              {/* Flags */}
              <div className="flex flex-wrap gap-2">
                {place.hasPopularTimes && (
                  <span className="text-[10px] text-purple-400 bg-purple-400/10 border border-purple-400/20 px-2 py-0.5 rounded-full">
                    📊 Popular times
                  </span>
                )}
                {place.photosCount !== null && (
                  <span className="text-[10px] text-white/35 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full">
                    🖼 {place.photosCount.toLocaleString()} photos
                  </span>
                )}
                {place.placeId && (
                  <span className="text-[10px] text-white/25 bg-white/[0.03] border border-white/[0.05] px-2 py-0.5 rounded-full font-mono">
                    ID: {place.placeId.slice(0, 24)}…
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Footer: Maps link */}
      {place.mapsUrl && (
        <div className="px-5 py-3 border-t border-white/[0.04] flex justify-end">
          <a
            href={place.mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[#6c63ff] hover:text-[#00d4aa] transition-colors font-medium"
          >
            Open in Maps ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function PlacesPanel() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [deepScrape, setDeepScrape] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PlacesSearchResult | null>(null);

  const handleSearch = async (e?: React.FormEvent, customPage?: number) => {
    e?.preventDefault();
    if (!query.trim()) return;

    const targetPage = customPage ?? page;
    setLoading(true);
    setError('');

    try {
      const res = await api.placesSearch(query, targetPage, deepScrape);
      setResult(res);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search card */}
      <div className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-lg font-bold text-white">Google Maps Places Search</h3>
          <span className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full">
            via browser pool
          </span>
        </div>
        <p className="text-sm text-white/45 mb-5">
          Scrape Google Maps place cards — name, rating, address, hours, phone, website, coordinates &amp; more.
        </p>

        <form onSubmit={handleSearch} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#6c63ff]/50 transition-colors"
              placeholder='e.g. "pizza near Times Square" or "dentists in London"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-6 py-2.5 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#6c63ff]/20 whitespace-nowrap"
            >
              {loading ? 'Searching…' : '🗺 Search Places'}
            </button>
          </div>

          {/* Options row */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                onClick={() => setDeepScrape((v) => !v)}
                className={`relative w-9 h-5 rounded-full border transition-all duration-200 ${
                  deepScrape
                    ? 'bg-[#6c63ff]/30 border-[#6c63ff]/50'
                    : 'bg-white/[0.05] border-white/10'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200 shadow ${
                    deepScrape
                      ? 'left-4 bg-[#6c63ff]'
                      : 'left-0.5 bg-white/30'
                  }`}
                />
              </div>
              <span className="text-xs text-white/50">
                Deep scrape{' '}
                <span className="text-white/25">(clicks into each place — slower, more data)</span>
              </span>
            </label>
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center gap-4 p-16">
          <div className="relative w-12 h-12">
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff] border-t-transparent animate-spin" />
          </div>
          <p className="text-white/40 text-sm">
            {deepScrape ? 'Deep scraping places (may take a while)…' : 'Scraping Google Maps…'}
          </p>
        </div>
      )}

      {/* Results */}
      {!loading && result && (
        <div className="space-y-5">
          {/* Meta bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-white/60 text-sm font-medium">
                {result.results.length} place{result.results.length !== 1 ? 's' : ''}
              </span>
              {result.totalResultsText && (
                <span className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-full">
                  {result.totalResultsText}
                </span>
              )}
              {deepScrape && (
                <span className="text-[10px] text-[#6c63ff] bg-[#6c63ff]/10 border border-[#6c63ff]/20 px-2 py-0.5 rounded-full">
                  deep scrape
                </span>
              )}
            </div>
            <span className="text-xs text-white/30">Page {result.page}</span>
          </div>

          {result.results.length === 0 ? (
            <div className="glass rounded-2xl border border-white/[0.06] p-12 flex flex-col items-center gap-3 text-center">
              <span className="text-4xl">🗺</span>
              <p className="text-white/50 text-sm">No places found for this query.</p>
              <p className="text-white/25 text-xs">Try a different search or add a city name.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {result.results.map((place, idx) => (
                <PlaceCard key={`${place.name}-${idx}`} place={place} />
              ))}
            </div>
          )}

          {/* Pagination */}
          <div className="flex justify-center items-center gap-3 pt-2">
            <button
              disabled={page <= 1}
              onClick={() => handleSearch(undefined, Math.max(1, page - 1))}
              className="px-4 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white hover:bg-white/10 disabled:opacity-30 text-sm transition-all"
            >
              ← Previous
            </button>
            <span className="text-white/40 text-sm font-medium px-2">Page {page}</span>
            <button
              disabled={!result.hasNextPage}
              onClick={() => handleSearch(undefined, page + 1)}
              className="px-4 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white hover:bg-white/10 disabled:opacity-30 text-sm transition-all"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
