import React, { useState, useRef } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

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
    <Card className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3 border border-white/10">
      <div className="text-2xl">{icon}</div>
      <CardTitle className="font-semibold text-white text-sm">{title}</CardTitle>
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />
      <Button
        onClick={() => inputRef.current?.click()} disabled={loading}
        variant="outline"
        className="w-full py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all"
      >
        {loading ? '⏳ Processing…' : 'Upload & Process'}
      </Button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {result && resultType === 'image' && (
        <div className="space-y-2">
          <img src={result} alt="result" className="rounded-lg max-h-48 w-full object-contain bg-black/30" />
          <a href={result} download={`result_${Date.now()}.png`}
            className="block text-center text-xs text-teal-400 hover:underline">⬇ Download</a>
        </div>
      )}
      {result && resultType === 'text' && (
        <Textarea readOnly value={result} rows={5}
          className="w-full text-xs font-mono bg-black/30 border border-white/10 rounded-lg p-3 text-white/80 resize-none" />
      )}
    </Card>
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
    <Card className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3 border border-white/10">
      <div className="text-2xl">📸</div>
      <CardTitle className="font-semibold text-white text-sm">Screenshot URL</CardTitle>
      <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
        className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30" />
      <Label className="flex items-center gap-2 text-xs text-white/50 cursor-pointer">
        <input type="checkbox" checked={fullPage} onChange={e => setFullPage(e.target.checked)} className="accent-teal-400" />
        Full page screenshot
      </Label>
      <Button onClick={shoot} disabled={loading || !url}
        variant="outline"
        className="w-full py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all">
        {loading ? '⏳ Capturing…' : 'Take Screenshot'}
      </Button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {imgUrl && (
        <div className="space-y-2">
          <img src={imgUrl} alt="screenshot" className="rounded-lg max-h-64 w-full object-contain bg-black/30" />
          <a href={imgUrl} download={`screenshot_${Date.now()}.png`}
            className="block text-center text-xs text-teal-400 hover:underline">⬇ Download</a>
        </div>
      )}
    </Card>
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
    <Card className="glass glass-hover rounded-2xl p-5 flex flex-col gap-3 border border-white/10">
      <div className="text-2xl">🧹</div>
      <CardTitle className="font-semibold text-white text-sm">MinerU HTML Cleaner</CardTitle>
      <Textarea value={html} onChange={e => setHtml(e.target.value)} placeholder="Paste raw HTML here..." rows={4}
        className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 outline-none focus:border-white/30 resize-none" />
      <Button onClick={clean} disabled={loading || !html.trim()}
        variant="outline"
        className="w-full py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium transition-all">
        {loading ? '⏳ Cleaning…' : 'Clean HTML'}
      </Button>
      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">❌ {error}</p>}
      {result && (
        <Textarea readOnly value={result} rows={5}
          className="w-full text-xs font-mono bg-black/30 border border-white/10 rounded-lg p-3 text-white/80 resize-none mt-2" />
      )}
    </Card>
  );
}

export default function AIToolsPanel() {
  return (
    <div className="space-y-4 text-sm">
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
