import React, { useState } from 'react';
import { api, YtSearchResult, YtVideoInfo, YtQuality } from '../api';

function fmtViews(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export default function YoutubePanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YtSearchResult[]>([]);
  const [info, setInfo] = useState<YtVideoInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [directUrl, setDirectUrl] = useState('');

  // Cookie export state
  const [cookieExporting, setCookieExporting] = useState(false);
  const [cookieResult, setCookieResult] = useState<{ success: boolean; message: string } | null>(null);

  const exportCookies = async () => {
    setCookieExporting(true);
    setCookieResult(null);
    try {
      const result = await api.exportYtCookies();
      setCookieResult(result);
    } catch (e) {
      setCookieResult({ success: false, message: (e as Error).message });
    } finally {
      setCookieExporting(false);
    }
  };

  const search = async () => {
    if (!query) return;
    setSearching(true); setError(null); setResults([]); setInfo(null);
    try { setResults((await api.ytSearch(query)).results); }
    catch (e) { setError((e as Error).message); }
    finally { setSearching(false); }
  };

  const loadInfo = async (url: string) => {
    setLoadingInfo(true); setError(null); setInfo(null);
    try { setInfo(await api.ytInfo(url)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoadingInfo(false); }
  };

  const download = async (q?: YtQuality) => {
    const url = info?.url || directUrl;
    if (!url) return;
    setDownloading(q?.key ?? 'fallback');
    try {
      const blob = await api.ytDownload(url, q);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `youtube_${Date.now()}.${q?.audioOnly ? 'm4a' : 'mp4'}`;
      a.click();
    } catch (e) { setError((e as Error).message); }
    finally { setDownloading(null); }
  };

  return (
    <div className="space-y-5">
      {/* Cookie Export */}
      <div className="glass rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-semibold text-white text-sm">🍪 YouTube Cookie Export</h3>
            <p className="text-xs text-white/40 mt-0.5">
              Export cookies from the cloud browser so yt-dlp can download age-restricted or members-only videos.
            </p>
          </div>
          <button
            onClick={exportCookies}
            disabled={cookieExporting}
            className="px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 text-sm font-semibold transition-all disabled:opacity-50 whitespace-nowrap"
          >
            {cookieExporting ? '⏳ Exporting…' : '🍪 Export Cookies'}
          </button>
        </div>
        {cookieResult && (
          <div className={`text-xs px-3 py-2 rounded-lg border ${
            cookieResult.success
              ? 'bg-green-500/10 border-green-500/20 text-green-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}>
            {cookieResult.success ? '✅' : '❌'} {cookieResult.message}
          </div>
        )}
        <p className="text-[11px] text-white/25 leading-relaxed">
          💡 Open YouTube in the cloud browser and sign in first for best results. Auto-exports 15 s after startup.
        </p>
      </div>

      {/* Search */}
      <div className="glass rounded-2xl p-5 space-y-3">
        <h3 className="font-semibold text-white text-sm">🔍 YouTube Search</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search YouTube…"
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/30" />
          <button onClick={search} disabled={searching || !query}
            className="sm:px-5 py-2.5 rounded-xl bg-[#6c63ff] hover:bg-[#5a52e0] text-sm font-semibold transition-all disabled:opacity-50">
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Direct URL */}
      <div className="glass rounded-2xl p-5 space-y-3">
        <h3 className="font-semibold text-white text-sm">🔗 Direct URL Download</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={directUrl} onChange={e => setDirectUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-white/30 outline-none focus:border-white/30" />
          <div className="flex gap-2">
            <button onClick={() => loadInfo(directUrl)} disabled={loadingInfo || !directUrl}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/10 text-sm font-medium transition-all disabled:opacity-50">
              {loadingInfo ? '…' : 'Get Info'}
            </button>
            <button onClick={() => download()} disabled={!!downloading || !directUrl}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl bg-teal-600/30 hover:bg-teal-600/50 border border-teal-500/30 text-teal-300 text-sm font-medium transition-all disabled:opacity-50">
              Quick DL
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">❌ {error}</p>}

      {/* Search results */}
      {results.length > 0 && !info && (
        <div className="space-y-2">
          {results.map(v => (
            <div key={v.videoId} className="glass glass-hover rounded-xl p-4 flex gap-3 cursor-pointer" onClick={() => loadInfo(v.url)}>
              <img src={v.thumbnail} alt="" className="w-20 h-14 rounded-lg object-cover flex-shrink-0 bg-black/30" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{v.title}</p>
                <p className="text-xs text-white/40 mt-0.5">{v.author} · {v.duration} · {fmtViews(v.views)} views · {v.ago}</p>
              </div>
              <button className="text-xs text-teal-400 hover:underline flex-shrink-0">Select →</button>
            </div>
          ))}
        </div>
      )}

      {/* Quality picker */}
      {info && (
        <div className="glass rounded-2xl p-5 space-y-4">
          <div className="flex gap-3 items-start">
            <img src={info.thumbnail} alt="" className="w-24 h-16 rounded-lg object-cover bg-black/30 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white text-sm">{info.title}</p>
              <p className="text-xs text-white/40">{info.uploader} · {fmtViews(info.viewCount)} views</p>
            </div>
          </div>
          <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-2">
            {info.qualities.map(q => (
              <button key={q.key} onClick={() => download(q)} disabled={!!downloading}
                className="py-2.5 px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 hover:border-white/20 text-xs font-medium transition-all disabled:opacity-50 text-left">
                {downloading === q.key ? '⏳ Downloading…' : q.label}
              </button>
            ))}
          </div>
          <button onClick={() => setInfo(null)} className="text-xs text-white/30 hover:text-white/60">← Back to results</button>
        </div>
      )}
    </div>
  );
}
