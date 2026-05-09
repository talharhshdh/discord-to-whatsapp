import React, { useState } from 'react';
import { api, BrowserSearchResult } from '../api';

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);

  const handleSearch = async (e?: React.FormEvent, customPage?: number) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    const targetPage = customPage ?? page;

    try {
      const res = await api.browserSearch(query, targetPage);
      setResult(res);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || 'Failed to perform search');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="glass p-6 rounded-2xl border border-white/[0.07] shadow-xl">
        <h3 className="text-lg font-bold text-white mb-2">Automated Browser Search</h3>
        <p className="text-sm text-white/50 mb-6">
          Connects to the running Chromium container to search Google and extract organic results + AI responses.
        </p>

        <form onSubmit={handleSearch} className="flex gap-3">
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
          {result.aiResponse && (
            <div className="glass p-6 rounded-2xl border border-[#00d4aa]/30 bg-[#00d4aa]/5 shadow-xl">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xl">✨</span>
                <h4 className="text-[#00d4aa] font-bold">AI Response</h4>
              </div>
              <p className="text-white/80 leading-relaxed whitespace-pre-wrap text-sm">{result.aiResponse}</p>
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
    </div>
  );
}
