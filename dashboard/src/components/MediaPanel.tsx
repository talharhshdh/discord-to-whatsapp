import React, { useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const PLATFORMS = [
  { name: 'Instagram', color: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
  { name: 'TikTok', color: 'bg-slate-500/10 text-slate-300 border-slate-500/20' },
  { name: 'Facebook', color: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  { name: 'Twitter/X', color: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20' },
  { name: 'YouTube', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  { name: 'Pinterest', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
  { name: 'MediaFire', color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  { name: 'CapCut', color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
  { name: 'Spotify', color: 'bg-green-500/10 text-green-400 border-green-500/20' },
  { name: 'SoundCloud', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  { name: 'Threads', color: 'bg-neutral-500/10 text-neutral-300 border-neutral-500/20' },
  { name: 'Google Drive', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' }
];

export default function MediaPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    try {
      const blob = await api.downloadMedia(url);
      setBlobUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 mx-auto text-sm">
      <div className="space-y-3">
        <p className="text-white/50 text-sm leading-relaxed">
          Paste any media URL from the supported platforms below. The system automatically detects the origin and processes the download chunk-by-chunk.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {PLATFORMS.map(p => (
            <Badge
              key={p.name}
              variant="outline"
              className={`px-3 py-1 rounded-xl text-[10px] font-bold tracking-wide transition-all border ${p.color}`}
            >
              {p.name}
            </Badge>
          ))}
        </div>
      </div>

      <Card className="glass rounded-3xl p-6 md:p-8 space-y-6 border border-white/[0.08] shadow-2xl relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-48 h-48 rounded-full bg-[#6c63ff]/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-48 h-48 rounded-full bg-[#00d4aa]/10 blur-[80px] pointer-events-none" />

        <div className="space-y-2">
          <label className="text-[10px] uppercase font-black tracking-wider text-white/40 block">Media URL</label>
          <Input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="Paste Instagram post, TikTok video, YouTube link..."
            className="w-full bg-[#161b26]/50 border border-white/10 rounded-2xl px-4 py-3.5 text-sm text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono shadow-inner focus:bg-[#161b26]/80"
          />
        </div>

        <Button
          onClick={download}
          disabled={loading || !url.trim()}
          className="w-full py-6 rounded-2xl bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] hover:opacity-95 font-bold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed text-white shadow-lg shadow-[#6c63ff]/15 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              <span>Downloading media...</span>
            </>
          ) : (
            <>
              <span>⬇</span>
              <span>Download Media</span>
            </>
          )}
        </Button>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-2xl px-4 py-3 flex items-start gap-2.5 animate-in fade-in duration-300">
            <span className="text-sm">⚠️</span>
            <div className="space-y-0.5">
              <p className="font-bold">Download Failed</p>
              <p className="opacity-80 leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        {blobUrl && (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5 space-y-3.5 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 text-lg">✓</span>
              <div>
                <p className="text-sm text-emerald-400 font-bold">Successfully Fetched!</p>
                <p className="text-[10px] text-white/40">File is ready to be saved locally.</p>
              </div>
            </div>
            <a
              href={blobUrl}
              download={`media_${Date.now()}`}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 font-bold text-white text-xs transition-all shadow-md shadow-emerald-500/10"
            >
              <span>💾</span>
              <span>Save file to device</span>
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}
