import React, { useState } from 'react';
import { api, MovieResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export default function MoviesPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MovieResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      const res = await api.movieSearch(query);
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto text-sm">
      <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl relative overflow-hidden">
        <CardHeader>
          <CardTitle>🎬 Discover Movies & TV Shows</CardTitle>
          <CardDescription>Search TMDB to fetch instant details and streaming links.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <span className="absolute inset-y-0 left-4 flex items-center text-[var(--text-subtle)] text-sm">🔍</span>
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && search()}
                placeholder="Search movies or TV shows..."
                className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl pl-10 pr-4 py-3 text-sm text-[var(--input-text)] placeholder-[var(--input-placeholder)]"
              />
            </div>
            <Button
              onClick={search}
              disabled={searching || !query.trim()}
              className="px-6 py-5 rounded-xl text-xs uppercase tracking-wider font-bold transition-all flex items-center justify-center gap-2 h-auto"
            >
              {searching ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  <span>Searching...</span>
                </>
              ) : (
                <span>Search</span>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-center gap-2.5 animate-in fade-in duration-300">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
          {results.map(m => (
            <Card
              key={m.tmdbId}
              className="rounded-2xl overflow-hidden flex flex-col border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md transition-all duration-300 group hover:shadow-lg"
            >
              {/* Media Poster Wrapper */}
              <div className="relative aspect-[16/10] overflow-hidden bg-black/40 flex items-center justify-center flex-shrink-0">
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-85 z-10" />
                {m.posterUrl ? (
                  <img
                    src={m.posterUrl}
                    alt={m.title}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <div className="text-5xl select-none">🎬</div>
                )}
                
                {/* Media Type Tag */}
                <Badge variant="outline" className="absolute top-3 left-3 px-2 py-0.5 rounded-lg bg-black/60 border border-white/10 text-[9px] font-bold uppercase tracking-wider text-[var(--accent-active-text)] z-20">
                  {m.mediaType === 'tv' ? '📺 TV Show' : '🎬 Movie'}
                </Badge>
                
                {/* Release Year Tag */}
                {m.releaseDate && (
                  <Badge variant="outline" className="absolute top-3 right-3 px-2 py-0.5 rounded-lg bg-black/60 border border-white/10 text-[9px] font-bold text-white/70 z-20">
                    {m.releaseDate.slice(0, 4)}
                  </Badge>
                )}
              </div>

              {/* Media Info Content */}
              <div className="p-5 flex-1 flex flex-col justify-between space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold text-[var(--text-main)] text-sm line-clamp-1 leading-snug group-hover:text-[var(--primary)] transition-colors">{m.title}</h3>
                    {m.voteAverage > 0 && (
                      <Badge variant="outline" className="text-[10px] font-bold text-yellow-500 flex items-center gap-0.5 bg-yellow-500/10 px-1.5 py-0.5 rounded border border-yellow-500/20">
                        ⭐ {m.voteAverage.toFixed(1)}
                      </Badge>
                    )}
                  </div>
                  {m.overview && (
                    <p className="text-[11px] text-[var(--text-muted)] line-clamp-3 leading-relaxed">
                      {m.overview}
                    </p>
                  )}
                </div>

                <a
                  href={m.watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--btn-secondary-bg)] hover:bg-[var(--btn-secondary-hover)] border border-[var(--btn-secondary-border)] text-[var(--text-main)] text-xs font-bold transition-all shadow-inner"
                >
                  <span>▶</span>
                  <span>Watch Content</span>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
