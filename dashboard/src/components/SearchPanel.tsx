import React, { useState, useRef } from 'react';
import { api, BrowserSearchResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type SearchEngine = 'auto' | 'cdp' | 'selenium' | 'cookie';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);
  const [engine, setEngine] = useState<SearchEngine>('auto');
  const [usedEngine, setUsedEngine] = useState<string>('');
  const [includeAI, setIncludeAI] = useState(false);
  const aiRef = useRef<HTMLDivElement>(null);

  const handleSearch = async (e?: React.FormEvent, customPage?: number) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    const targetPage = customPage ?? page;

    try {
      const res = engine === 'cookie'
        ? await api.cookieSearch(query, targetPage)
        : await api.browserSearch(query, targetPage, engine, includeAI);
      setResult(res);
      setPage(targetPage);
      setUsedEngine(engine);
    } catch (err: any) {
      setError(err.message || 'Failed to perform search');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 text-sm max-w-5xl mx-auto">
      <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl">
        <CardHeader className="flex flex-row justify-between items-start">
          <div>
            <CardTitle>Automated Browser Search</CardTitle>
            <CardDescription>
              Search Google via the running Chromium container (CDP) or Python SeleniumBase engine.
            </CardDescription>
          </div>
          <Button
            onClick={async () => {
              if (window.confirm('Restart all browser workers? Current searches will be interrupted.')) {
                try {
                  await api.restartBrowsers();
                  alert('Restart command sent to GitHub Actions!');
                } catch (e: any) {
                  alert('Error: ' + e.message);
                }
              }
            }}
            variant="outline"
            className="px-3 py-1.5 h-auto rounded-lg bg-[var(--btn-secondary-bg)] border border-[var(--card-border)] text-[var(--text-muted)] hover:text-[var(--text-main)] text-xs transition-colors"
          >
            🔄 Restart Workers
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Engine selector */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-subtle)]">Engine:</span>
            {(['auto', 'cdp', 'selenium', 'cookie'] as SearchEngine[]).map(eng => (
              <Button
                key={eng}
                onClick={() => setEngine(eng)}
                variant="outline"
                className={`flex-shrink-0 px-3 py-1 h-auto rounded-lg text-xs font-semibold transition-all border ${
                  engine === eng
                    ? 'bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)]'
                    : 'bg-[var(--btn-secondary-bg)] border-[var(--btn-secondary-border)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                }`}
              >
                {eng === 'auto' ? '⚡ Auto' : eng === 'cdp' ? '🔌 CDP' : eng === 'selenium' ? '🐍 Selenium' : '🍪 Cookie'}
              </Button>
            ))}
          </div>

          {/* AI response toggle */}
          <div className="flex items-center gap-3">
            <Button
              onClick={() => setIncludeAI(v => !v)}
              variant="outline"
              className={`flex items-center gap-2 px-3 py-1 h-auto rounded-lg text-xs font-semibold transition-all border ${
                includeAI
                  ? 'bg-[var(--accent-active-bg)] border-[var(--accent-active-border)] text-[var(--accent-active-text)]'
                  : 'bg-[var(--btn-secondary-bg)] border-[var(--btn-secondary-border)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              <span>{includeAI ? '✨' : '○'}</span>
              <span>AI Overview</span>
            </Button>
            <span className="text-[10px] text-[var(--text-subtle)]">
              {includeAI ? 'Slower — fetches AI summary' : 'Faster — organic results only'}
            </span>
          </div>

          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3 pt-2">
            <Input
              type="text"
              className="flex-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl px-4 py-3 text-sm text-[var(--input-text)] placeholder-[var(--input-placeholder)]"
              placeholder="Enter search query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-6 py-5 rounded-xl font-bold uppercase tracking-wider text-xs flex items-center justify-center gap-2 h-auto"
            >
              {loading ? 'Searching...' : 'Search'}
            </Button>
          </form>
          {error && <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
        </CardContent>
      </Card>

      {loading && (
        <div className="flex justify-center p-12">
          <div className="w-8 h-8 rounded-full border-2 border-[var(--primary)] border-t-transparent animate-spin" />
        </div>
      )}

      {!loading && result && (
        <div className="space-y-6">
          {/* Engine badge */}
          {usedEngine && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-[var(--text-subtle)] bg-[var(--btn-secondary-bg)] border border-[var(--btn-secondary-border)] px-2 py-0.5 rounded-full">
                via {usedEngine === 'auto' ? 'auto (CDP → Selenium)' : usedEngine}
              </Badge>
            </div>
          )}

          {result.aiResponse && (
            <Card className="rounded-2xl border border-[var(--accent-active-border)] bg-[var(--accent-active-bg)] shadow-xl overflow-hidden p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xl">✨</span>
                <h3 className="text-[var(--accent-active-text)] font-bold text-base">AI Overview</h3>
              </div>
              <div
                ref={aiRef}
                className="ai-response-content text-[var(--text-main)] leading-relaxed text-sm prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: result.aiResponse }}
              />
            </Card>
          )}

          <div className="space-y-4">
            <h4 className="font-bold text-[var(--text-main)] px-2">Organic Results</h4>
            {result.organic.length === 0 ? (
              <p className="text-[var(--text-muted)] text-sm px-2">No results found.</p>
            ) : (
              result.organic.map((item, idx) => (
                <Card key={idx} className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md p-5 group hover:shadow-lg transition-all">
                  <a href={item.link} target="_blank" rel="noreferrer" className="block space-y-2">
                    <h4 className="text-[var(--primary)] group-hover:underline font-bold text-lg">{item.title}</h4>
                    <div className="text-xs text-[var(--text-subtle)] truncate">{item.link}</div>
                    <p className="text-sm text-[var(--text-muted)] leading-relaxed">{item.snippet}</p>
                  </a>
                </Card>
              ))
            )}
          </div>

          <div className="flex justify-center gap-4 pt-4">
            <Button
              disabled={page <= 1}
              onClick={() => handleSearch(undefined, Math.max(1, page - 1))}
              variant="outline"
              className="px-4 py-2 h-auto rounded-lg text-sm bg-[var(--btn-secondary-bg)] border border-[var(--btn-secondary-border)] text-[var(--text-main)]"
            >
              Previous Page
            </Button>
            <div className="px-4 py-2 flex items-center justify-center text-[var(--text-muted)] text-sm font-medium">
              Page {page}
            </div>
            <Button
              onClick={() => handleSearch(undefined, page + 1)}
              variant="outline"
              className="px-4 py-2 h-auto rounded-lg text-sm bg-[var(--btn-secondary-bg)] border border-[var(--btn-secondary-border)] text-[var(--text-main)]"
            >
              Next Page
            </Button>
          </div>
        </div>
      )}

      {/* Scoped styles for AI response HTML content */}
      <style>{`
        .ai-response-content h1, .ai-response-content h2, .ai-response-content h3,
        .ai-response-content h4, .ai-response-content h5 {
          color: var(--text-main);
          font-weight: 600;
          margin-top: 1.25em;
          margin-bottom: 0.5em;
        }
        .ai-response-content h2 { font-size: 1.1em; }
        .ai-response-content h3 { font-size: 1em; }
        .ai-response-content p { margin-bottom: 0.75em; }
        .ai-response-content ul, .ai-response-content ol {
          padding-left: 1.5em;
          margin-bottom: 0.75em;
        }
        .ai-response-content li { margin-bottom: 0.3em; list-style-type: disc; }
        .ai-response-content a {
          color: var(--primary);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .ai-response-content a:hover { color: var(--accent); }
        .ai-response-content img { max-width: 100%; border-radius: 8px; margin: 0.5em 0; }
        .ai-response-content strong, .ai-response-content b { color: var(--text-main); }
        .ai-response-content br + br { display: none; }
      `}</style>
    </div>
  );
}
