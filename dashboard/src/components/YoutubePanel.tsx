import React, { useState, useEffect, useRef } from 'react';
import { api, YtSearchResult, YtVideoInfo, YtQuality, YtDownloadJob } from '../api';

function fmtViews(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

const standardQualities: YtQuality[] = [
  {
    key: 'audio-video',
    label: '🎬 Audio + Video (Best Pre-merged)',
    sizeBytes: null,
    audioOnly: false,
    formatId: 'best[ext=mp4]/best'
  },
  {
    key: 'video-only',
    label: '📹 Video Only (Highest Quality)',
    sizeBytes: null,
    audioOnly: false,
    formatId: 'bestvideo[ext=mp4]/bestvideo'
  },
  {
    key: 'audio-only',
    label: '🎵 Audio Only (m4a)',
    sizeBytes: null,
    audioOnly: true,
    formatId: 'bestaudio[ext=m4a]/bestaudio'
  }
];

export default function YoutubePanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YtSearchResult[]>([]);
  const [info, setInfo] = useState<YtVideoInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directUrl, setDirectUrl] = useState('');
  const [selectedQuality, setSelectedQuality] = useState<YtQuality>(standardQualities[0]);

  // Job states
  const [activeJob, setActiveJob] = useState<YtDownloadJob | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Cookie export state
  const [cookieExporting, setCookieExporting] = useState(false);
  const [cookieResult, setCookieResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

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

  const selectSearchResult = (v: YtSearchResult) => {
    setInfo({
      videoId: v.videoId,
      url: v.url,
      title: v.title,
      thumbnail: v.thumbnail,
      durationSeconds: 0,
      uploader: v.author,
      viewCount: v.views,
      qualities: standardQualities,
    });
    setDirectUrl(v.url);
  };

  const startDownloadJob = async (url: string, quality: YtQuality) => {
    setError(null);
    setActiveJob(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    try {
      const { jobId } = await api.ytDownloadJob(url, quality);
      setActiveJob({
        id: jobId,
        url,
        qualityKey: quality.key,
        status: 'pending',
        progress: 0,
        message: 'Initializing job...',
      });

      pollIntervalRef.current = setInterval(async () => {
        try {
          const status = await api.ytJobStatus(jobId);
          setActiveJob(status);

          if (status.status === 'completed' || status.status === 'failed') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            if (status.status === 'completed' && status.downloadUrl) {
              // Trigger auto download
              const a = document.createElement('a');
              a.href = status.downloadUrl;
              a.download = status.title || `youtube_${Date.now()}.${quality.audioOnly ? 'm4a' : 'mp4'}`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }
          }
        } catch (pollErr) {
          console.error('Error polling job status:', pollErr);
        }
      }, 1000);
    } catch (e) {
      setError((e as Error).message);
    }
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
          <div className={`text-xs px-3 py-2 rounded-lg border ${cookieResult.success
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
      <div className="glass rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">🔗 Direct URL Download</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={directUrl} onChange={e => {
            setDirectUrl(e.target.value);
            setInfo(null);
          }}
            placeholder="https://youtube.com/watch?v=…"
            className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white font-mono placeholder-white/30 outline-none focus:border-white/30" />
          <div className="flex gap-2">
            <button onClick={() => loadInfo(directUrl)} disabled={loadingInfo || !directUrl}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/10 text-sm font-medium transition-all disabled:opacity-50 whitespace-nowrap">
              {loadingInfo ? '…' : 'Get Info (Optional)'}
            </button>
          </div>
        </div>

        {directUrl && !info && (
          <div className="space-y-3 border-t border-white/5 pt-3">
            <p className="text-xs text-white/50">Select Quality:</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {standardQualities.map(q => (
                <button
                  key={q.key}
                  onClick={() => setSelectedQuality(q)}
                  className={`py-2 px-3 rounded-xl border text-xs font-medium transition-all text-left ${selectedQuality.key === q.key
                      ? 'bg-teal-500/20 border-teal-500/50 text-teal-300'
                      : 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-white/70'
                    }`}
                >
                  {q.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => startDownloadJob(directUrl, selectedQuality)}
              disabled={!directUrl || activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
              className="w-full py-2.5 rounded-xl bg-teal-600/30 hover:bg-teal-600/50 border border-teal-500/30 text-teal-300 text-sm font-semibold transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              🚀 Start Download Job
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">❌ {error}</p>}

      {/* Active Job Progress */}
      {activeJob && (
        <div className="glass rounded-2xl p-5 space-y-3 border border-white/10">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-white text-sm flex items-center gap-2">
              📥 Download Job: <span className="capitalize text-teal-300 font-bold">{activeJob.status}</span>
            </h4>
            {activeJob.status === 'downloading' && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500"></span>
              </span>
            )}
          </div>
          <p className="text-xs text-white/70 font-mono truncate">{activeJob.message || 'Waiting...'}</p>

          {/* Progress Bar */}
          <div className="w-full bg-black/30 rounded-full h-2.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${activeJob.status === 'failed' ? 'bg-red-500' : 'bg-teal-500'
                }`}
              style={{ width: `${activeJob.progress}%` }}
            ></div>
          </div>
          <div className="flex justify-between items-center text-xs text-white/40">
            <span>Progress: {activeJob.progress}%</span>
            {activeJob.status === 'completed' && activeJob.downloadUrl && (
              <a
                href={activeJob.downloadUrl}
                download={activeJob.title || 'video.mp4'}
                className="text-teal-400 hover:underline font-semibold flex items-center gap-1"
              >
                💾 Click to download manually
              </a>
            )}
          </div>
        </div>
      )}

      {/* Search results */}
      {results.length > 0 && !info && (
        <div className="space-y-2">
          {results.map(v => (
            <div key={v.videoId} className="glass glass-hover rounded-xl p-4 flex gap-3 cursor-pointer" onClick={() => selectSearchResult(v)}>
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
      {info && (() => {
        const standard = info.qualities.filter(q => ['audio-video', 'video-only', 'audio-only'].includes(q.key));
        const specificVideo = info.qualities.filter(q => q.key.startsWith('format-') && !q.audioOnly);
        const specificAudio = info.qualities.filter(q => q.key.startsWith('format-') && q.audioOnly);

        return (
          <div className="glass rounded-2xl p-5 space-y-4">
            <div className="flex gap-3 items-start border-b border-white/5 pb-4">
              <img src={info.thumbnail} alt="" className="w-24 h-16 rounded-lg object-cover bg-black/30 flex-shrink-0 border border-white/10" />
              <div className="min-w-0">
                <p className="font-semibold text-white text-sm truncate">{info.title}</p>
                <p className="text-xs text-white/40 mt-1">{info.uploader} {info.viewCount ? `· ${fmtViews(info.viewCount)} views` : ''}</p>
              </div>
            </div>

            <div className="space-y-5">
              {/* Standard Options */}
              {standard.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-teal-400">⚡ Standard Pre-merged Options</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {standard.map(q => (
                      <button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        className="py-2.5 px-3 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 text-xs font-semibold text-teal-300 transition-all disabled:opacity-50 text-left">
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Specific Video Formats */}
              {specificVideo.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-white/50">📹 Specific Video Formats</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                    {specificVideo.map(q => (
                      <button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        className="py-2.5 px-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs text-white/80 hover:text-white transition-all disabled:opacity-50 text-left truncate"
                        title={q.label}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Specific Audio Formats */}
              {specificAudio.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-white/50">🎵 Specific Audio Formats</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
                    {specificAudio.map(q => (
                      <button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        className="py-2.5 px-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs text-white/80 hover:text-white transition-all disabled:opacity-50 text-left truncate"
                        title={q.label}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-white/5 pt-3">
              <button onClick={() => setInfo(null)} className="text-xs text-white/30 hover:text-white/60 font-medium">← Back to results</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
