import React, { useState, useRef } from 'react';
import { api, BrowserSearchResult } from '../api';

type SearchEngine = 'auto' | 'cdp' | 'selenium';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);
  const [engine, setEngine] = useState<SearchEngine>('auto');
  const [usedEngine, setUsedEngine] = useState<string>('');
  const aiRef = useRef<HTMLDivElement>(null);

  const handleSearch = async (e?: React.FormEvent, customPage?: number) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    const targetPage = customPage ?? page;

    try {
      const res = await api.browserSearch(query, targetPage, engine);
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
    <div className="space-y-6">
      <div className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <div className="flex justify-between items-start mb-2">
          <h3 className="text-lg font-bold text-white">Automated Browser Search</h3>
          <button
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
            className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-xs transition-colors"
          >
            🔄 Restart Workers
          </button>
        </div>
        <p className="text-sm text-white/50 mb-4">
          Search Google via the running Chromium container (CDP) or Python SeleniumBase engine.
        </p>

        {/* Engine selector */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-white/40">Engine:</span>
          {(['auto', 'cdp', 'selenium'] as SearchEngine[]).map(eng => (
            <button
              key={eng}
              onClick={() => setEngine(eng)}
              className={`flex-shrink-0 px-3 py-1 rounded-lg text-xs font-medium transition-all border ${
                engine === eng
                  ? 'bg-[#6c63ff]/20 border-[#6c63ff]/40 text-[#6c63ff]'
                  : 'bg-white/[0.03] border-white/10 text-white/40 hover:text-white/60 hover:bg-white/[0.06]'
              }`}
            >
              {eng === 'auto' ? '⚡ Auto' : eng === 'cdp' ? '🔌 CDP' : '🐍 Selenium'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[#6c63ff]/50 transition-colors"
            placeholder="Enter search query..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-6 py-2.5 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] rounded-xl text-white font-medium hover:opacity-90 disabled:opacity-50 transition-all shadow-lg shadow-[#6c63ff]/20"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
        {error && <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
      </div>

      {loading && (
        <div className="flex justify-center p-12">
          <div className="w-8 h-8 rounded-full border-2 border-[#6c63ff] border-t-transparent animate-spin" />
        </div>
      )}

      {!loading && result && (
        <div className="space-y-6">
          {/* Engine badge */}
          {usedEngine && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/30 bg-white/[0.04] px-2 py-0.5 rounded-full border border-white/[0.06]">
                via {usedEngine === 'auto' ? 'auto (CDP → Selenium)' : usedEngine}
              </span>
            </div>
          )}

          {result.aiResponse && (
            <div className="glass p-6 rounded-2xl border border-[#00d4aa]/30 bg-[#00d4aa]/5 shadow-xl overflow-hidden">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xl">✨</span>
                <h4 className="text-[#00d4aa] font-bold">AI Overview</h4>
              </div>
              <div
                ref={aiRef}
                className="ai-response-content text-white/80 leading-relaxed text-sm prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: result.aiResponse }}
              />
            </div>
          )}

          <div className="space-y-4">
            <h4 className="font-bold text-white/90 px-2">Organic Results</h4>
            {result.organic.length === 0 ? (
              <p className="text-white/50 text-sm px-2">No results found.</p>
            ) : (
              result.organic.map((item, idx) => (
                <div key={idx} className="glass p-5 rounded-xl border border-white/[0.05] hover:border-white/10 transition-colors">
                  <a href={item.link} target="_blank" rel="noreferrer" className="block group">
                    <h5 className="text-[#6c63ff] group-hover:underline font-medium text-lg mb-1">{item.title}</h5>
                    <div className="text-xs text-white/40 mb-2 truncate">{item.link}</div>
                    <p className="text-sm text-white/70 leading-relaxed">{item.snippet}</p>
                  </a>
                </div>
              ))
            )}
          </div>

          <div className="flex justify-center gap-4 pt-4">
            <button
              disabled={page <= 1}
              onClick={() => handleSearch(undefined, Math.max(1, page - 1))}
              className="px-4 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white hover:bg-white/10 disabled:opacity-30 text-sm"
            >
              Previous Page
            </button>
            <div className="px-4 py-2 flex items-center justify-center text-white/50 text-sm font-medium">
              Page {page}
            </div>
            <button
              onClick={() => handleSearch(undefined, page + 1)}
              className="px-4 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white hover:bg-white/10 text-sm"
            >
              Next Page
            </button>
          </div>
        </div>
      )}

      {/* Scoped styles for AI response HTML content */}
      <style>{`
        .ai-response-content h1, .ai-response-content h2, .ai-response-content h3,
        .ai-response-content h4, .ai-response-content h5 {
          color: rgba(255,255,255,0.9);
          font-weight: 600;
          margin-top: 1em;
          margin-bottom: 0.5em;
        }
        .ai-response-content h2 { font-size: 1.1em; }
        .ai-response-content h3 { font-size: 1em; }
        .ai-response-content p { margin-bottom: 0.75em; }
        .ai-response-content ul, .ai-response-content ol {
          padding-left: 1.5em;
          margin-bottom: 0.75em;
        }
        .ai-response-content li { margin-bottom: 0.3em; }
        .ai-response-content a {
          color: #6c63ff;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .ai-response-content a:hover { color: #00d4aa; }
        .ai-response-content img { max-width: 100%; border-radius: 8px; margin: 0.5em 0; }
        .ai-response-content strong, .ai-response-content b { color: rgba(255,255,255,0.95); }
        .ai-response-content br + br { display: none; }
      `}</style>
    </div>
  );
}
