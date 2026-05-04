import React, { useState } from 'react';
import { api } from '../api';

const PLATFORMS = ['Instagram', 'TikTok', 'Facebook', 'Twitter/X', 'YouTube', 'Pinterest', 'MediaFire', 'CapCut', 'Spotify', 'SoundCloud', 'Threads', 'Google Drive'];

export default function MediaPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!url) return;
    setLoading(true); setError(null); setBlobUrl(null);
    try {
      const blob = await api.downloadMedia(url);
      setBlobUrl(URL.createObjectURL(blob));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-white/40 text-sm">Paste any media URL — the bot will auto-detect the platform and download.</p>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map(p => (
            <span key={p} className="px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-xs text-white/50">{p}</span>
          ))}
        </div>
      </div>

      <div className="glass rounded-2xl p-6 space-y-4">
        <input
          value={url} onChange={e => setUrl(e.target.value)}
          placeholder="https://www.instagram.com/p/... or any supported URL"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-white/30 font-mono"
        />
        <button
          onClick={download} disabled={loading || !url}
          className="w-full py-3 rounded-xl bg-[#6c63ff] hover:bg-[#5a52e0] font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? '⏳ Downloading…' : '⬇ Download Media'}
        </button>

        {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">❌ {error}</p>}

        {blobUrl && (
          <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
            <p className="text-sm text-green-400 font-medium">✅ Downloaded!</p>
            <a
              href={blobUrl}
              download={`media_${Date.now()}`}
              className="block text-center py-2.5 rounded-lg bg-teal-500/20 border border-teal-500/30 text-teal-400 text-sm hover:bg-teal-500/30 transition-all"
            >
              ⬇ Save to Device
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
