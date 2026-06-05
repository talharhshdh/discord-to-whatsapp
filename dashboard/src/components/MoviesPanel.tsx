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
      <Card className="glass rounded-3xl p-6 md:p-8 space-y-4 border border-white/[0.08] shadow-2xl relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-48 h-48 rounded-full bg-[#6c63ff]/5 blur-[80px] pointer-events-none" />
        
        <div>
          <CardTitle className="font-bold text-white text-base">🎬 Discover Movies & TV Shows</CardTitle>
          <CardDescription className="text-white/40 text-xs mt-1">Search TMDB to fetch instant details and streaming links.</CardDescription>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <span className="absolute inset-y-0 left-4 flex items-center text-white/30 text-sm">🔍</span>
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Search movies or TV shows..."
              className="w-full bg-[#161b26]/50 border border-white/10 rounded-2xl pl-10 pr-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all focus:bg-[#161b26]/80"
            />
          </div>
          <Button
            onClick={search}
            disabled={searching || !query.trim()}
            className="px-6 py-6 rounded-2xl bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] text-white text-sm font-bold hover:opacity-95 transition-all disabled:opacity-30 flex items-center justify-center gap-2 shadow-lg shadow-[#6c63ff]/10 h-auto"
          >
            {searching ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span>Searching...</span>
              </>
            ) : (
              <span>Search</span>
            )}
          </Button>
        </div>
      </Card>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-2xl px-4 py-3 flex items-center gap-2.5 animate-in fade-in duration-300">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
          {results.map(m => (
            <Card
              key={m.tmdbId}
              className="glass glass-hover rounded-3xl overflow-hidden flex flex-col border border-white/[0.08] shadow-lg transition-all duration-300 group"
            >
              {/* Media Poster Wrapper */}
              <div className="relative aspect-[16/10] overflow-hidden bg-black/40 flex items-center justify-center flex-shrink-0">
                <div className="absolute inset-0 bg-gradient-to-t from-[#070b14] via-transparent to-transparent opacity-80 z-10" />
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
                <Badge variant="outline" className="absolute top-3 left-3 px-2 py-0.5 rounded-lg bg-black/60 border border-white/10 text-[9px] font-bold uppercase tracking-wider text-[#00d4aa] z-20">
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
              <div className="p-5 flex-1 flex flex-col space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="font-bold text-white text-sm line-clamp-1 leading-snug group-hover:text-[#6c63ff] transition-colors">{m.title}</CardTitle>
                    {m.voteAverage > 0 && (
                      <Badge variant="outline" className="text-[10px] font-bold text-yellow-400 flex items-center gap-0.5 bg-yellow-500/10 px-1.5 py-0.5 rounded border border-yellow-500/20">
                        ⭐ {m.voteAverage.toFixed(1)}
                      </Badge>
                    )}
                  </div>
                </div>

                {m.overview && (
                  <p className="text-[11px] text-white/40 line-clamp-3 leading-relaxed flex-1">
                    {m.overview}
                  </p>
                )}

                <a
                  href={m.watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#6c63ff]/10 hover:bg-[#6c63ff]/20 border border-[#6c63ff]/20 hover:border-[#6c63ff]/35 text-[#9d97ff] text-xs font-bold transition-all shadow-inner"
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
