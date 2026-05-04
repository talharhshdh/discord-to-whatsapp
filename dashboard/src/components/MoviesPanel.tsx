import React, { useState } from 'react';
import { api, MovieResult } from '../api';

export default function MoviesPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MovieResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query) return;
    setSearching(true); setError(null); setResults([]);
    try { setResults((await api.movieSearch(query)).results); }
    catch (e) { setError((e as Error).message); }
    finally { setSearching(false); }
  };

  return (
    <div className="space-y-5">
      <div className="glass rounded-2xl p-5 space-y-3">
        <h3 className="font-semibold text-white text-sm">🎬 Movie & TV Search (TMDB)</h3>
        <div className="flex gap-2">
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search movies or TV shows…"
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/30" />
          <button onClick={search} disabled={searching || !query}
            className="px-5 py-2.5 rounded-xl bg-[#6c63ff] hover:bg-[#5a52e0] text-sm font-semibold transition-all disabled:opacity-50">
            {searching ? '…' : 'Search'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">❌ {error}</p>}

      {results.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-4">
          {results.map(m => (
            <div key={m.tmdbId} className="glass glass-hover rounded-xl overflow-hidden">
              {m.posterUrl ? (
                <img src={m.posterUrl} alt={m.title} className="w-full h-48 object-cover" />
              ) : (
                <div className="w-full h-48 bg-white/[0.04] flex items-center justify-center text-4xl">🎬</div>
              )}
              <div className="p-3 space-y-2">
                <p className="font-semibold text-white text-sm line-clamp-2 leading-snug">{m.title}</p>
                <div className="flex items-center gap-2 text-xs text-white/40">
                  <span>{m.mediaType === 'tv' ? '📺 TV' : '🎬 Movie'}</span>
                  <span>{m.releaseDate?.slice(0, 4)}</span>
                  {m.voteAverage > 0 && <span>⭐ {m.voteAverage.toFixed(1)}</span>}
                </div>
                {m.overview && (
                  <p className="text-xs text-white/40 line-clamp-2">{m.overview}</p>
                )}
                <a href={m.watchUrl} target="_blank" rel="noopener noreferrer"
                  className="block text-center py-2 rounded-lg bg-[#6c63ff]/20 border border-[#6c63ff]/30 text-[#9d97ff] text-xs font-medium hover:bg-[#6c63ff]/30 transition-all">
                  ▶ Watch Now
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
