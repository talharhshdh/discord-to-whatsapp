import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, TTSVoice, TTSStatus } from '../api';

// ── Helpers ──────────────────────────────────────────────────────────────────

function blobToUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = blobToUrl(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Status bar ───────────────────────────────────────────────────────────────

function StatusBar({ status }: { status: TTSStatus | null }) {
  if (!status) return null;
  const colorCls = !status.running
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : status.model_loaded
      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
      : status.loading
        ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
        : 'bg-white/[0.04] border-white/10 text-white/50';

  const dotCls = !status.running
    ? 'bg-red-400'
    : status.model_loaded
      ? 'bg-emerald-400 animate-pulse'
      : 'bg-amber-400 animate-pulse';

  const label = !status.running
    ? 'TTS server not running'
    : status.model_loaded
      ? 'Qwen3-TTS ready'
      : status.loading
        ? 'Loading Qwen3-TTS model…'
        : 'Model not loaded';

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs border ${colorCls}`}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotCls}`} />
      {label}
      {status.error && !status.running && (
        <span className="ml-1 opacity-70 truncate max-w-[220px]" title={status.error}>— {status.error}</span>
      )}
    </div>
  );
}

// ── Audio player ─────────────────────────────────────────────────────────────

function AudioResult({ blob, filename }: { blob: Blob; filename: string }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    const url = blobToUrl(blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  return (
    <div className="flex flex-col gap-2 p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/20">
      <div className="flex items-center gap-2 text-xs text-emerald-400">
        <span>🎵</span>
        <span className="font-medium">{filename}</span>
      </div>
      <audio controls src={src} className="w-full h-9 rounded-lg" />
      <button
        onClick={() => downloadBlob(blob, filename)}
        className="self-start px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/25 text-emerald-400 text-xs font-medium transition-all"
      >
        ⬇ Download
      </button>
    </div>
  );
}

// ── Voice card ───────────────────────────────────────────────────────────────

function VoiceCard({ voice, selected, onClick }: { voice: TTSVoice; selected: boolean; onClick(): void }) {
  const genderIcon = voice.gender === 'female' ? '👩' : voice.gender === 'male' ? '👨' : '🧑';
  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-1 p-3 rounded-xl border text-left transition-all ${
        selected
          ? 'bg-[#6c63ff]/20 border-[#6c63ff]/40 text-white'
          : 'bg-white/[0.03] border-white/[0.07] text-white/60 hover:border-white/20 hover:text-white'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span>{genderIcon}</span>
        <span className="font-semibold text-sm">{voice.label}</span>
      </div>
      <p className="text-[10px] leading-relaxed opacity-70">{voice.tone}</p>
    </button>
  );
}

// ── TTS Generate tab ─────────────────────────────────────────────────────────

function GenerateTab({ voices, serverReady }: { voices: TTSVoice[]; serverReady: boolean }) {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const blob = await api.ttsGenerate(text, voice, format);
      setResult({ blob, name: `tts_${Date.now()}.${format}` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const charCount = text.length;
  const charLimit = 2000;

  return (
    <div className="space-y-4">
      <p className="text-white/40 text-sm">
        Convert any text to natural speech using Qwen3-TTS with a built-in voice preset.
      </p>

      {/* Text input */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-white/40">Text to synthesise</label>
          <span className={`text-[10px] ${charCount > charLimit ? 'text-red-400' : 'text-white/20'}`}>
            {charCount}/{charLimit}
          </span>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={5}
          placeholder="Enter the text you want to convert to speech…"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-white/25 resize-none transition-colors"
        />
      </div>

      {/* Voice grid */}
      {voices.length > 0 && (
        <div>
          <label className="text-[11px] text-white/40 block mb-2">Voice preset</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {voices.map(v => (
              <VoiceCard key={v.id} voice={v} selected={voice === v.id} onClick={() => setVoice(v.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Options row */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs text-white/50">
          <label>Format</label>
          <select
            value={format}
            onChange={e => setFormat(e.target.value as 'wav' | 'mp3')}
            className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-xs outline-none"
          >
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
          </select>
        </div>
      </div>

      {/* Generate button */}
      <button
        onClick={generate}
        disabled={!text.trim() || busy || !serverReady || charCount > charLimit}
        className="w-full py-3 rounded-xl bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] hover:opacity-90 disabled:opacity-40 text-white font-semibold text-sm transition-all shadow-lg shadow-[#6c63ff]/20"
      >
        {busy ? '🎙️ Synthesising…' : '🎙️ Generate Speech'}
      </button>

      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          ❌ {error}
        </div>
      )}
      {result && <AudioResult blob={result.blob} filename={result.name} />}
    </div>
  );
}

// ── Voice Clone tab ───────────────────────────────────────────────────────────

function CloneTab({ serverReady }: { serverReady: boolean }) {
  const [text, setText] = useState('');
  const [refFile, setRefFile] = useState<File | null>(null);
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const clone = async () => {
    if (!text.trim() || !refFile || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const blob = await api.ttsClone(text, refFile, format);
      setResult({ blob, name: `clone_${Date.now()}.${format}` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-white/40 text-sm">
        Clone any voice by uploading a reference audio clip (5–30 seconds recommended). The model will match the voice style, tone, and cadence.
      </p>

      {/* Reference audio */}
      <div>
        <label className="text-[11px] text-white/40 block mb-1.5">Reference audio clip</label>
        <div
          onClick={() => fileRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-2 py-8 rounded-2xl border-2 border-dashed cursor-pointer transition-all ${
            refFile
              ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
              : 'border-white/10 hover:border-white/20 bg-white/[0.02]'
          }`}
        >
          <span className="text-3xl">{refFile ? '✅' : '🎤'}</span>
          {refFile ? (
            <div className="text-center">
              <p className="text-sm text-emerald-400 font-medium">{refFile.name}</p>
              <p className="text-xs text-white/30">{(refFile.size / 1024).toFixed(1)} KB · Click to replace</p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-white/50">Click to upload reference audio</p>
              <p className="text-xs text-white/20">WAV, MP3, OGG, FLAC — 5 to 30 seconds</p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="sr-only"
            onChange={e => { if (e.target.files?.[0]) setRefFile(e.target.files[0]); }}
          />
        </div>
      </div>

      {/* Text input */}
      <div>
        <label className="text-[11px] text-white/40 block mb-1.5">Text to synthesise</label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          placeholder="Enter the text to speak in the cloned voice…"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-white/25 resize-none transition-colors"
        />
      </div>

      {/* Format */}
      <div className="flex items-center gap-2 text-xs text-white/50">
        <label>Format</label>
        <select
          value={format}
          onChange={e => setFormat(e.target.value as 'wav' | 'mp3')}
          className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-xs outline-none"
        >
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
        </select>
      </div>

      <button
        onClick={clone}
        disabled={!text.trim() || !refFile || busy || !serverReady}
        className="w-full py-3 rounded-xl bg-gradient-to-r from-[#ff6384] to-[#6c63ff] hover:opacity-90 disabled:opacity-40 text-white font-semibold text-sm transition-all shadow-lg shadow-[#ff6384]/20"
      >
        {busy ? '🧬 Cloning voice…' : '🧬 Clone Voice'}
      </button>

      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          ❌ {error}
        </div>
      )}
      {result && <AudioResult blob={result.blob} filename={result.name} />}
    </div>
  );
}

// ── Voice Design tab ─────────────────────────────────────────────────────────

const STYLE_EXAMPLES = [
  'A cheerful young woman with a bright, energetic tone',
  'Deep male narrator, calm and authoritative, podcast style',
  'Whispery, mysterious female voice with a slight British accent',
  'Elderly professor, gentle and thoughtful, slightly slow pace',
  'Upbeat radio announcer, fast-paced and enthusiastic',
];

function DesignTab({ serverReady }: { serverReady: boolean }) {
  const [text, setText] = useState('');
  const [style, setStyle] = useState('');
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const design = async () => {
    if (!text.trim() || !style.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const blob = await api.ttsDesign(text, style, format);
      setResult({ blob, name: `design_${Date.now()}.${format}` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-white/40 text-sm">
        Describe the voice you want in plain English. The model will generate a custom voice matching your description.
      </p>

      {/* Style input */}
      <div>
        <label className="text-[11px] text-white/40 block mb-1.5">Voice style description</label>
        <textarea
          value={style}
          onChange={e => setStyle(e.target.value)}
          rows={3}
          placeholder="e.g. Deep, warm male voice with a slight raspy quality, calm and trustworthy"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-white/25 resize-none transition-colors"
        />

        {/* Quick examples */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLE_EXAMPLES.map(ex => (
            <button
              key={ex}
              onClick={() => setStyle(ex)}
              className="text-[10px] px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white/70 hover:border-white/20 transition-all"
            >
              {ex.length > 42 ? ex.slice(0, 42) + '…' : ex}
            </button>
          ))}
        </div>
      </div>

      {/* Text input */}
      <div>
        <label className="text-[11px] text-white/40 block mb-1.5">Text to synthesise</label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          placeholder="Enter the text to speak with the designed voice…"
          className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-white/25 resize-none transition-colors"
        />
      </div>

      {/* Format */}
      <div className="flex items-center gap-2 text-xs text-white/50">
        <label>Format</label>
        <select
          value={format}
          onChange={e => setFormat(e.target.value as 'wav' | 'mp3')}
          className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-xs outline-none"
        >
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
        </select>
      </div>

      <button
        onClick={design}
        disabled={!text.trim() || !style.trim() || busy || !serverReady}
        className="w-full py-3 rounded-xl bg-gradient-to-r from-[#f093fb] to-[#f5576c] hover:opacity-90 disabled:opacity-40 text-white font-semibold text-sm transition-all shadow-lg shadow-[#f093fb]/20"
      >
        {busy ? '🎨 Designing voice…' : '🎨 Design Voice'}
      </button>

      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          ❌ {error}
        </div>
      )}
      {result && <AudioResult blob={result.blob} filename={result.name} />}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

type TTSTab = 'generate' | 'clone' | 'design';

const TABS: { id: TTSTab; label: string; icon: string }[] = [
  { id: 'generate', label: 'TTS',          icon: '🎙️' },
  { id: 'clone',    label: 'Voice Clone',  icon: '🧬' },
  { id: 'design',   label: 'Voice Design', icon: '🎨' },
];

export default function TTSPanel() {
  const [tab, setTab] = useState<TTSTab>('generate');
  const [status, setStatus] = useState<TTSStatus | null>(null);
  const [voices, setVoices] = useState<TTSVoice[]>([]);

  const refresh = useCallback(async () => {
    try {
      const s = await api.ttsStatus();
      setStatus(s);
      if (s.running && voices.length === 0) {
        const v = await api.ttsVoices().catch(() => ({ voices: [] }));
        setVoices(v.voices);
      }
    } catch {
      setStatus({ running: false, model_loaded: false, loading: false, error: 'Unreachable' });
    }
  }, [voices.length]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const serverReady = Boolean(status?.running && status?.model_loaded);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-white/40 text-sm">
            Qwen3-TTS — open-source voice synthesis with TTS, voice cloning &amp; custom voice design.
          </p>
        </div>
        <StatusBar status={status} />
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-xs transition-colors"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Model',   value: 'Qwen3-TTS', icon: '🤖' },
          { label: 'Server',  value: status?.running ? 'Online' : 'Offline', icon: status?.running ? '🟢' : '🔴' },
          { label: 'Status',  value: status?.model_loaded ? 'Ready' : status?.loading ? 'Loading…' : 'Idle', icon: '⚡' },
        ].map(s => (
          <div key={s.label} className="glass rounded-xl px-4 py-3 border border-white/[0.07]">
            <div className="text-xl mb-1">{s.icon}</div>
            <div className="text-white font-bold text-sm truncate">{s.value}</div>
            <div className="text-white/30 text-xs">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Not running banner */}
      {status && !status.running && (
        <div className="px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-400 space-y-1">
          <p className="font-medium">⚠️ TTS server is not running</p>
          <p className="text-xs text-amber-400/70">
            The <code className="font-mono">tts_server.py</code> process must be started in the GitHub Actions workflow.
            Check that the workflow installs <code className="font-mono">transformers soundfile torchaudio</code> and starts the server on port 8002.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-black/20 rounded-xl border border-white/[0.06] w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tab === t.id
                ? 'bg-[#6c63ff]/25 text-white border border-[#6c63ff]/30'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="glass rounded-2xl p-5 border border-white/[0.07]">
        {tab === 'generate' && <GenerateTab voices={voices} serverReady={serverReady} />}
        {tab === 'clone'    && <CloneTab serverReady={serverReady} />}
        {tab === 'design'   && <DesignTab serverReady={serverReady} />}
      </div>
    </div>
  );
}
