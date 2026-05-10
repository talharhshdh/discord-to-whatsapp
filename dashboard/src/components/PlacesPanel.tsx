import React, { useState, useRef, useCallback, useEffect } from 'react';
import { api, PlaceResult } from '../api';

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

function PlaceCard({ place, isNew }: { place: PlaceResult; isNew: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`glass rounded-2xl border transition-all duration-500 overflow-hidden group ${
        isNew
          ? 'border-[#6c63ff]/40 shadow-lg shadow-[#6c63ff]/10 animate-in fade-in slide-in-from-bottom-2 duration-400'
          : 'border-white/[0.06] hover:border-white/[0.12]'
      }`}
    >
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

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge openNow={place.openNow} />
          {place.todaysHours && (
            <span className="text-xs text-white/45">{place.todaysHours}</span>
          )}
        </div>

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

        {place.description && (
          <p className="mt-3 text-xs text-white/50 leading-relaxed line-clamp-2">
            {place.description}
          </p>
        )}
      </div>

      {(place.weeklyHours || (place.amenities?.length ?? 0) > 0 || place.lat !== null) && (
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

              {(place.amenities?.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-white/30 mb-2">Amenities</p>
                  <div className="flex flex-wrap gap-1.5">
                    {place.amenities.map((a, i) => (
                      <span key={i} className="text-[10px] bg-white/[0.04] border border-white/[0.07] text-white/50 px-2 py-0.5 rounded-full">
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {place.lat !== null && place.lng !== null && (
                <div className="flex items-center gap-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">Coordinates</p>
                  <p className="text-xs text-white/40 font-mono">
                    {place.lat.toFixed(6)}, {place.lng.toFixed(6)}
                  </p>
                </div>
              )}

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

// ── Streaming progress bar ────────────────────────────────────────────────────

function StreamProgress({ round, total, done }: { round: number; total: number; done: boolean }) {
  return (
    <div className="glass rounded-xl border border-[#6c63ff]/20 p-4 flex items-center gap-4">
      <div className="relative w-8 h-8 flex-shrink-0">
        {!done ? (
          <>
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff] border-t-transparent animate-spin" />
          </>
        ) : (
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-sm">
            ✓
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white/70 text-sm font-medium">
          {done ? `Done — ${total} places scraped` : `Scrolling feed… ${total} places found`}
        </p>
        <p className="text-white/30 text-xs mt-0.5">
          {done ? 'All results loaded' : `Scroll round ${round} of up to 20`}
        </p>
      </div>
      <span className="text-2xl font-bold text-[#6c63ff] tabular-nums">{total}</span>
    </div>
  );
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

type Mode = 'stream' | 'paginated';

// ── Paginated panel ───────────────────────────────────────────────────────────

function PaginatedPanel() {
  const [query, setQuery]         = useState('');
  const [deepScrape, setDeepScrape] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [page, setPage]           = useState(1);
  const [result, setResult]       = useState<import('../api').PlacesSearchResult | null>(null);

  const runSearch = async (pageNum: number) => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.placesSearch(query.trim(), pageNum, deepScrape);
      setResult(res);
      setPage(pageNum);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => { e?.preventDefault(); runSearch(1); };

  return (
    <div className="space-y-6">
      <div className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-lg font-bold text-white">Paginated Places Search</h3>
          <span className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full">pool · page {page}</span>
        </div>
        <p className="text-sm text-white/45 mb-5">Fetches one page (20 results) at a time via the browser pool.</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="places-pool-query"
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#6c63ff]/50 transition-colors"
              placeholder='e.g. "coffee shops in Chicago"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!query.trim() || loading}
              className="px-6 py-2.5 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#6c63ff]/20 whitespace-nowrap"
            >
              {loading ? '⏳ Searching…' : '🔍 Search'}
            </button>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <div
              onClick={() => setDeepScrape(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${deepScrape ? 'bg-[#6c63ff]' : 'bg-white/10'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${deepScrape ? 'translate-x-4' : ''}`} />
            </div>
            <span className="text-xs text-white/50">Deep scrape (phone, website, hours)</span>
          </label>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
        )}
      </div>

      {result && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-white/60 text-sm">{result.totalResultsText ?? `${result.results.length} results`}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => runSearch(page - 1)}
                disabled={page <= 1 || loading}
                className="px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
              >← Prev</button>
              <span className="text-white/40 text-xs px-2">Page {page}</span>
              <button
                onClick={() => runSearch(page + 1)}
                disabled={!result.hasNextPage || loading}
                className="px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm hover:bg-white/[0.09] disabled:opacity-30 transition-all"
              >Next →</button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {result.results.map((place, idx) => (
              <PlaceCard key={`${place.name}-${idx}`} place={place} isNew={false} />
            ))}
          </div>

          {result.results.length === 0 && (
            <p className="text-center text-white/30 py-12 text-sm">No results found for this page.</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface PlaceEntry {
  place: PlaceResult;
  isNew: boolean;
}

export default function PlacesPanel() {
  const [mode, setMode]         = useState<Mode>('stream');
  const [query, setQuery]       = useState('');
  const [streaming, setStreaming] = useState(false);
  const [done, setDone]         = useState(false);
  const [error, setError]       = useState('');
  const [entries, setEntries]   = useState<PlaceEntry[]>([]);
  const [round, setRound]       = useState(0);
  const [total, setTotal]       = useState(0);

  const esRef = useRef<EventSource | null>(null);
  // Track which card names are newly arrived (highlighted for 3s)
  const newNamesRef = useRef<Set<string>>(new Set());

  const stopStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  // Clean up on unmount
  useEffect(() => () => stopStream(), [stopStream]);

  // After 3s, remove the "isNew" glow from newly added cards
  const scheduleNewFade = useCallback((names: string[]) => {
    setTimeout(() => {
      setEntries(prev =>
        prev.map(e => names.includes(e.place.name) ? { ...e, isNew: false } : e)
      );
      names.forEach(n => newNamesRef.current.delete(n));
    }, 3000);
  }, []);

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || streaming) return;

    stopStream();
    setEntries([]);
    setRound(0);
    setTotal(0);
    setDone(false);
    setError('');
    setStreaming(true);
    newNamesRef.current.clear();

    const es = api.placesStream(
      query.trim(),
      // onBatch
      (cards, newTotal, newRound) => {
        const newNames = cards.map(c => c.name);
        newNames.forEach(n => newNamesRef.current.add(n));
        setRound(newRound);
        setTotal(newTotal);
        setEntries(prev => [
          ...prev,
          ...cards.map(c => ({ place: c, isNew: true })),
        ]);
        scheduleNewFade(newNames);
      },
      // onDone
      (finalTotal) => {
        setTotal(finalTotal);
        setStreaming(false);
        setDone(true);
      },
      // onError
      (msg) => {
        setError(msg);
        setStreaming(false);
        setDone(true);
      },
    );

    esRef.current = es;
  };

  const handleStop = () => {
    stopStream();
    setStreaming(false);
    setDone(true);
  };

  return (
    <div className="space-y-6">
      {/* Mode toggle */}
      <div className="flex gap-1 p-1 bg-white/[0.04] border border-white/[0.07] rounded-xl w-fit">
        {(['stream', 'paginated'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              mode === m
                ? 'bg-[#6c63ff] text-white shadow shadow-[#6c63ff]/30'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {m === 'stream' ? '📡 Live Stream' : '📄 Paginated'}
          </button>
        ))}
      </div>

      {mode === 'paginated' && <PaginatedPanel />}

      {mode === 'stream' && (
      <>
      {/* Search card */}
      <div className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-lg font-bold text-white">Google Maps Places Search</h3>
          <span className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 rounded-full">
            live stream
          </span>
        </div>
        <p className="text-sm text-white/45 mb-5">
          Results appear in real-time as the browser scrolls through Google Maps.
        </p>


        <form onSubmit={handleSearch} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="places-query"
              type="text"
              className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#6c63ff]/50 transition-colors"
              placeholder='e.g. "pizza near Times Square" or "dentists in London"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={streaming}
            />
            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="px-6 py-2.5 bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 font-medium hover:bg-red-500/30 transition-all whitespace-nowrap"
              >
                ⏹ Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!query.trim()}
                className="px-6 py-2.5 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#6c63ff]/20 whitespace-nowrap"
              >
                🗺 Search Places
              </button>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Live progress bar */}
      {(streaming || done) && entries.length >= 0 && (
        <StreamProgress round={round} total={total} done={done && !streaming} />
      )}

      {/* Results grid — grows in real-time */}
      {entries.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-white/60 text-sm font-medium">
              {entries.length} place{entries.length !== 1 ? 's' : ''}
              {streaming && <span className="ml-2 text-[#6c63ff] animate-pulse">● live</span>}
            </span>
            {done && !streaming && (
              <span className="text-xs text-emerald-400/70 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                ✓ Complete
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {entries.map((entry, idx) => (
              <PlaceCard
                key={`${entry.place.name}-${idx}`}
                place={entry.place}
                isNew={entry.isNew}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state while searching with no results yet */}
      {streaming && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-4 p-16">
          <div className="relative w-12 h-12">
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[#6c63ff] border-t-transparent animate-spin" />
          </div>
          <p className="text-white/40 text-sm">Navigating to Google Maps…</p>
        </div>
      )}
      </>
      )}
    </div>
  );
}
