import React, { useState, useRef } from 'react';
import { api } from '../api';

function blobUrl(blob: Blob) { return URL.createObjectURL(blob); }

function FileUploadCard({
  icon, title, accept, onProcess, resultType,
}: {
  icon: string; title: string; accept: string;
  onProcess: (file: File) => Promise<Blob | { text: string }>;
  resultType: 'image' | 'text';
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File) => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await onProcess(file);
      if (res instanceof Blob) {
        setResult(blobUrl(res));
      } else {
        setResult(res.text);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3">
      <div className="text-2xl">{icon}</div>
      <h3 className="font-semibold text-white text-sm">{title}</h3>
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />
      <button
        onClick={() => inputRef.current?.click()} disabled={loading}
        className="py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all disabled:opacity-50"
      >
        {loading ? '⏳ Processing…' : 'Upload & Process'}
      </button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {result && resultType === 'image' && (
        <div className="space-y-2">
          <img src={result} alt="result" className="rounded-lg max-h-48 w-full object-contain bg-black/30" />
          <a href={result} download={`result_${Date.now()}.png`}
            className="block text-center text-xs text-teal-400 hover:underline">⬇ Download</a>
        </div>
      )}
      {result && resultType === 'text' && (
        <textarea readOnly value={result} rows={5}
          className="w-full text-xs font-mono bg-black/30 border border-white/10 rounded-lg p-3 text-white/80 resize-none" />
      )}
    </div>
  );
}

function ScreenshotCard() {
  const [url, setUrl] = useState('');
  const [fullPage, setFullPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shoot = async () => {
    if (!url) return;
    setLoading(true); setError(null); setImgUrl(null);
    try { setImgUrl(blobUrl(await api.screenshot(url, fullPage))); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3">
      <div className="text-2xl">📸</div>
      <h3 className="font-semibold text-white text-sm">Screenshot URL</h3>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
        className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30" />
      <label className="flex items-center gap-2 text-xs text-white/50 cursor-pointer">
        <input type="checkbox" checked={fullPage} onChange={e => setFullPage(e.target.checked)} className="accent-teal-400" />
        Full page screenshot
      </label>
      <button onClick={shoot} disabled={loading || !url}
        className="py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all disabled:opacity-50">
        {loading ? '⏳ Capturing…' : 'Take Screenshot'}
      </button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {imgUrl && (
        <div className="space-y-2">
          <img src={imgUrl} alt="screenshot" className="rounded-lg max-h-64 w-full object-contain bg-black/30" />
          <a href={imgUrl} download={`screenshot_${Date.now()}.png`}
            className="block text-center text-xs text-teal-400 hover:underline">⬇ Download</a>
        </div>
      )}
    </div>
  );
}

function HtmlCleanerCard() {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clean = async () => {
    if (!html.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await api.extractHtml(html);
      setResult(res.content);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3">
      <div className="text-2xl">🧹</div>
      <h3 className="font-semibold text-white text-sm">MinerU HTML Cleaner</h3>
      <textarea value={html} onChange={e => setHtml(e.target.value)} placeholder="Paste raw HTML here..." rows={4}
        className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 outline-none focus:border-white/30 resize-none" />
      <button onClick={clean} disabled={loading || !html.trim()}
        className="py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all disabled:opacity-50">
        {loading ? '⏳ Cleaning…' : 'Clean HTML'}
      </button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {result && (
        <textarea readOnly value={result} rows={5}
          className="w-full text-xs font-mono bg-black/30 border border-white/10 rounded-lg p-3 text-white/80 resize-none mt-2" />
      )}
    </div>
  );
}

export default function AIToolsPanel() {
  return (
    <div className="space-y-4">
      <p className="text-white/40 text-sm">AI-powered tools — all processed by the Python API running in the same Actions session.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <FileUploadCard icon="🎨" title="Remove Background" accept="image/*" resultType="image"
          onProcess={api.removeBg} />
        <FileUploadCard icon="🔍" title="OCR — Extract Text" accept="image/*" resultType="text"
          onProcess={api.ocr} />
        <FileUploadCard icon="🎙️" title="Whisper Transcribe" accept="audio/*" resultType="text"
          onProcess={api.transcribe} />
        <ScreenshotCard />
        <HtmlCleanerCard />
      </div>
    </div>
  );
}
