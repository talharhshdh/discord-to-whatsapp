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
    <Card className="rounded-2xl flex flex-col justify-between border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md p-5 group hover:shadow-lg">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <h3 className="font-bold text-[var(--text-main)] text-sm">{title}</h3>
        </div>
        <input ref={inputRef} type="file" accept={accept} className="hidden"
          onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />

        {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">❌ {error}</p>}
        {result && resultType === 'image' && (
          <div className="space-y-2">
            <img src={result} alt="result" className="rounded-xl max-h-48 w-full object-contain bg-[var(--code-bg)] border border-[var(--input-border)]" />
            <a href={result} download={`result_${Date.now()}.png`}
              className="block text-center text-xs text-teal-500 hover:underline">⬇ Download</a>
          </div>
        )}
        {result && resultType === 'text' && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl p-3 text-[var(--input-text)] resize-none" />
        )}
      </div>

      <Button
        onClick={() => inputRef.current?.click()} disabled={loading}
        variant="outline"
        className="w-full mt-4 py-2.5 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--input-text)] text-xs font-semibold uppercase tracking-wider transition-all"
      >
        {loading ? '⏳ Processing…' : 'Upload & Process'}
      </Button>
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
    <Card className="rounded-2xl flex flex-col justify-between border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md p-5 group hover:shadow-lg">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📸</span>
          <h3 className="font-bold text-[var(--text-main)] text-sm">Screenshot URL</h3>
        </div>
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
          className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl px-4 py-3 text-sm text-[var(--input-text)] placeholder-[var(--input-placeholder)]" />
        <Label className="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer">
          <input type="checkbox" checked={fullPage} onChange={e => setFullPage(e.target.checked)} className="accent-[var(--primary)]" />
          Full page screenshot
        </Label>
        {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">❌ {error}</p>}
        {imgUrl && (
          <div className="space-y-2">
            <img src={imgUrl} alt="screenshot" className="rounded-xl max-h-64 w-full object-contain bg-[var(--code-bg)] border border-[var(--input-border)]" />
            <a href={imgUrl} download={`screenshot_${Date.now()}.png`}
              className="block text-center text-xs text-teal-500 hover:underline">⬇ Download</a>
          </div>
        )}
      </div>

      <Button onClick={shoot} disabled={loading || !url}
        variant="outline"
        className="w-full mt-4 py-2.5 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--input-text)] text-xs font-semibold uppercase tracking-wider transition-all">
        {loading ? '⏳ Capturing…' : 'Take Screenshot'}
      </Button>
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
    <Card className="rounded-2xl flex flex-col justify-between border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md p-5 group hover:shadow-lg">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🧹</span>
          <h3 className="font-bold text-[var(--text-main)] text-sm">HTML Cleaner</h3>
        </div>
        <Textarea value={html} onChange={e => setHtml(e.target.value)} placeholder="Paste raw HTML here..." rows={4}
          className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl px-4 py-3 text-xs text-[var(--input-text)] placeholder-[var(--input-placeholder)] resize-none" />
        {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">❌ {error}</p>}
        {result && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl p-3 text-[var(--input-text)] resize-none mt-2" />
        )}
      </div>

      <Button onClick={clean} disabled={loading || !html.trim()}
        variant="outline"
        className="w-full mt-4 py-2.5 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--input-text)] text-xs font-semibold uppercase tracking-wider transition-all">
        {loading ? '⏳ Cleaning…' : 'Clean HTML'}
      </Button>
    </Card>
  );
}

export default function AIToolsPanel() {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-[var(--text-muted)] text-sm">AI-powered tools — all processed by the Python API running in the same Actions session.</p>
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
