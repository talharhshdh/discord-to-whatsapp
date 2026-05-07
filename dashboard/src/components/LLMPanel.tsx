import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, LLMModelInfo, LLMChatMessage, LLMStatus } from '../api';

// ── Helpers ────────────────────────────────────────────────────────────────────

function Badge({ text, color = 'default' }: { text: string; color?: 'green' | 'blue' | 'purple' | 'orange' | 'default' }) {
  const cls: Record<string, string> = {
    green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
    purple: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
    orange: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
    default: 'bg-white/[0.06] text-white/50 border-white/10',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${cls[color]}`}>
      {text}
    </span>
  );
}

function StatusBar({ status }: { status: LLMStatus | null }) {
  if (!status) return null;
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs border ${
      !status.server_running
        ? 'bg-red-500/10 border-red-500/20 text-red-400'
        : status.loaded
          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
          : 'bg-white/[0.04] border-white/10 text-white/50'
    }`}>
      <span className={`w-2 h-2 rounded-full ${
        !status.server_running ? 'bg-red-400' : status.loaded ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'
      }`} />
      {!status.server_running
        ? 'LLM server not running'
        : status.loaded
          ? `${status.label} loaded — ctx ${status.ctx?.toLocaleString()} tokens`
          : 'No model loaded'}
    </div>
  );
}

// ── Model Card ─────────────────────────────────────────────────────────────────

function ModelCard({
  model,
  onDownload,
  onLoad,
  onDelete,
  onUnload,
  downloading,
}: {
  model: LLMModelInfo;
  onDownload: (id: string) => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onUnload: () => void;
  downloading: Set<string>;
}) {
  const isDownloading = !model.downloaded && (downloading.has(model.id) || model.download_status === 'downloading');

  const tagColor = (tag: string): 'green' | 'blue' | 'purple' | 'orange' | 'default' => {
    if (['reasoning', 'code'].includes(tag)) return 'purple';
    if (['multilingual'].includes(tag)) return 'blue';
    if (['fast', 'tiny', 'edge'].includes(tag)) return 'green';
    if (['multimodal'].includes(tag)) return 'orange';
    return 'default';
  };

  return (
    <div className={`relative glass rounded-2xl p-4 flex flex-col gap-3 transition-all border ${
      model.loaded
        ? 'border-emerald-500/30 shadow-emerald-500/10 shadow-lg'
        : 'border-white/[0.07] hover:border-white/[0.15]'
    }`}>
      {model.loaded && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[10px] font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          ACTIVE
        </div>
      )}

      <div>
        <div className="flex items-start gap-2 pr-16">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#6c63ff]/30 to-[#00d4aa]/20 flex items-center justify-center text-sm flex-shrink-0">
            🧠
          </div>
          <div>
            <h3 className="font-semibold text-white text-sm leading-tight">{model.label}</h3>
            <p className="text-[11px] text-white/40 mt-0.5 leading-relaxed">{model.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          {model.tags.map(t => <Badge key={t} text={t} color={tagColor(t)} />)}
          <Badge text={`${model.size_gb}GB`} color="default" />
          <Badge text={`${(model.ctx / 1024).toFixed(model.ctx >= 4096 ? 0 : 1)}K ctx`} color="default" />
        </div>
      </div>

      {/* Download error */}
      {model.download_status === 'error' && model.download_error && (
        <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">
          ❌ {model.download_error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto">
        {!model.downloaded && !isDownloading && (
          <button
            onClick={() => onDownload(model.id)}
            className="flex-1 py-1.5 rounded-lg bg-[#6c63ff]/20 hover:bg-[#6c63ff]/35 border border-[#6c63ff]/30 text-[#a8a3ff] text-xs font-medium transition-all"
          >
            ⬇ Download
          </button>
        )}
        {isDownloading && (
          <div className="flex-1 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/40 text-xs font-medium text-center">
            <span className="animate-pulse">⏳ Downloading…</span>
          </div>
        )}
        {model.downloaded && !model.loaded && !isDownloading && (
          <>
            <button
              onClick={() => onLoad(model.id)}
              className="flex-1 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/25 text-emerald-400 text-xs font-medium transition-all"
            >
              ▶ Load
            </button>
            <button
              onClick={() => onDelete(model.id)}
              className="py-1.5 px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-xs transition-all"
              title="Delete model file"
            >
              🗑
            </button>
          </>
        )}
        {model.loaded && (
          <button
            onClick={onUnload}
            className="flex-1 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-white/50 text-xs font-medium transition-all"
          >
            ⏹ Unload
          </button>
        )}
      </div>
    </div>
  );
}

// ── Chat UI ────────────────────────────────────────────────────────────────────

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  tokens?: number;
}

function ChatPanel({ modelLabel }: { modelLabel: string }) {
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxTokens, setMaxTokens] = useState(512);
  const [temperature, setTemperature] = useState(0.7);
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful AI assistant.');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setError(null);

    const userMsg: ChatEntry = { role: 'user', content: text };
    const newHistory = [...history, userMsg];
    setHistory(newHistory);
    setLoading(true);

    const messages: LLMChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...newHistory.map(h => ({ role: h.role, content: h.content })),
    ];

    try {
      const resp = await api.llmChat(messages, maxTokens, temperature);
      setHistory(prev => [
        ...prev,
        { role: 'assistant', content: resp.content, tokens: resp.usage?.completion_tokens },
      ]);
    } catch (e) {
      setError((e as Error).message);
      setHistory(prev => prev.slice(0, -1)); // remove the user message on failure
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Settings row */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2 text-xs text-white/50">
          <label>Max tokens</label>
          <select
            value={maxTokens}
            onChange={e => setMaxTokens(Number(e.target.value))}
            className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-xs outline-none"
          >
            {[128, 256, 512, 1024, 2048].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/50">
          <label>Temperature</label>
          <select
            value={temperature}
            onChange={e => setTemperature(Number(e.target.value))}
            className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-xs outline-none"
          >
            {[0.1, 0.3, 0.5, 0.7, 0.9, 1.0].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <button
          onClick={() => setHistory([])}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-white/40 transition-all"
        >
          🗑 Clear
        </button>
      </div>

      {/* System prompt */}
      <div>
        <label className="text-[11px] text-white/30 block mb-1">System prompt</label>
        <textarea
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          rows={2}
          className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-xs text-white/70 placeholder-white/20 outline-none focus:border-white/25 resize-none"
        />
      </div>

      {/* Chat history */}
      <div className="bg-black/20 border border-white/[0.06] rounded-2xl p-4 min-h-[280px] max-h-[420px] overflow-y-auto space-y-4 scrollbar-thin">
        {history.length === 0 && (
          <p className="text-white/20 text-sm text-center mt-8">
            💬 Chat with <span className="text-white/40">{modelLabel}</span>
          </p>
        )}
        {history.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
                🤖
              </div>
            )}
            <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-[#6c63ff]/25 border border-[#6c63ff]/30 text-white rounded-br-sm'
                : 'bg-white/[0.05] border border-white/[0.08] text-white/85 rounded-bl-sm'
            }`}>
              <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              {msg.tokens != null && (
                <p className="text-[10px] text-white/25 mt-1.5">{msg.tokens} tokens</p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-6 h-6 rounded-full bg-[#6c63ff]/30 border border-[#6c63ff]/25 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
                👤
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-xs flex-shrink-0">
              🤖
            </div>
            <div className="bg-white/[0.05] border border-white/[0.08] rounded-2xl rounded-bl-sm px-4 py-2.5">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        )}
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">❌ {error}</p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          rows={2}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 outline-none focus:border-white/25 resize-none transition-colors"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-4 rounded-xl bg-gradient-to-br from-[#6c63ff] to-[#5a54e0] hover:opacity-90 disabled:opacity-40 text-white text-sm font-medium transition-all shadow-lg shadow-[#6c63ff]/20"
        >
          ▶
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export default function LLMPanel() {
  const [models, setModels] = useState<LLMModelInfo[]>([]);
  const [status, setStatus] = useState<LLMStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [tab, setTab] = useState<'models' | 'chat'>('models');

  const flash = (msg: string) => { setActionMsg(msg); setTimeout(() => setActionMsg(null), 4000); };

  const refresh = useCallback(async () => {
    try {
      const [st, ml] = await Promise.all([api.llmStatus(), api.llmModels().catch(() => ({ models: [], current_model: null, models_dir: '' }))]);
      setStatus(st);
      setModels(ml.models);
      // Clear local downloading flags for any model the server now reports as ready
      setDownloading(prev => {
        if (prev.size === 0) return prev;
        const stillPending = new Set(prev);
        ml.models.forEach(m => { if (m.downloaded) stillPending.delete(m.id); });
        return stillPending.size === prev.size ? prev : stillPending;
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleDownload = async (id: string) => {
    setDownloading(prev => new Set(prev).add(id));
    try {
      const r = await api.llmDownload(id);
      flash(r.message);
    } catch (e) {
      flash(`❌ ${(e as Error).message}`);
      setDownloading(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  const handleLoad = async (id: string) => {
    setLoadingModel(id);
    try {
      const r = await api.llmLoad(id);
      flash(`✅ ${r.label} loaded!`);
      setTab('chat');
      await refresh();
    } catch (e) {
      flash(`❌ ${(e as Error).message}`);
    } finally {
      setLoadingModel(null);
    }
  };

  const handleUnload = async () => {
    try {
      await api.llmUnload();
      flash('Model unloaded.');
      await refresh();
    } catch (e) {
      flash(`❌ ${(e as Error).message}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this model file?')) return;
    try {
      await api.llmDelete(id);
      flash('Model file deleted.');
      await refresh();
    } catch (e) {
      flash(`❌ ${(e as Error).message}`);
    }
  };

  const currentModel = models.find(m => m.id === status?.model_id);
  const downloadedCount = models.filter(m => m.downloaded).length;

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-white/40 text-sm">
            Run local LLM models entirely on the GitHub Actions runner — no external API keys required.
          </p>
        </div>
        <StatusBar status={status} />
        <button onClick={refresh} className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-xs transition-colors">
          🔄 Refresh
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Available Models', value: models.length.toString(), icon: '📦' },
          { label: 'Downloaded', value: downloadedCount.toString(), icon: '💾' },
          { label: 'Active Model', value: status?.label ?? 'None', icon: '⚡' },
        ].map(stat => (
          <div key={stat.label} className="glass rounded-xl px-4 py-3 border border-white/[0.07]">
            <div className="text-xl mb-1">{stat.icon}</div>
            <div className="text-white font-bold text-lg">{stat.value}</div>
            <div className="text-white/30 text-xs">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-black/20 rounded-xl border border-white/[0.06] w-fit">
        {(['models', 'chat'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tab === t
                ? 'bg-[#6c63ff]/25 text-white border border-[#6c63ff]/30'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {t === 'models' ? '📦 Models' : '💬 Chat'}
            {t === 'chat' && status?.loaded && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse" />
            )}
          </button>
        ))}
      </div>

      {/* Flash message */}
      {actionMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white/70">
          {actionMsg}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
          ⚠️ {error}
        </div>
      )}

      {/* Models grid */}
      {tab === 'models' && (
        <>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="glass rounded-2xl p-4 h-44 animate-pulse border border-white/[0.07]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {models.map(m => (
                <ModelCard
                  key={m.id}
                  model={loadingModel === m.id ? { ...m, download_status: 'downloading' } : m}
                  onDownload={handleDownload}
                  onLoad={handleLoad}
                  onDelete={handleDelete}
                  onUnload={handleUnload}
                  downloading={downloading}
                />
              ))}
            </div>
          )}
          <p className="text-xs text-white/20 mt-2">
            All models use Q4_K_M GGUF quantisation — optimised for 4 CPU / 16 GB RAM. Models are stored in <code className="font-mono">~/.llm_models</code>.
          </p>
        </>
      )}

      {/* Chat panel */}
      {tab === 'chat' && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          {!status?.loaded ? (
            <div className="text-center py-12 space-y-3">
              <div className="text-4xl">🧠</div>
              <p className="text-white/40 text-sm">Load a model from the Models tab to start chatting.</p>
              <button
                onClick={() => setTab('models')}
                className="px-4 py-2 rounded-xl bg-[#6c63ff]/20 border border-[#6c63ff]/30 text-[#a8a3ff] text-sm hover:bg-[#6c63ff]/30 transition-all"
              >
                → Go to Models
              </button>
            </div>
          ) : (
            <ChatPanel modelLabel={currentModel?.label ?? status.label ?? 'Model'} />
          )}
        </div>
      )}
    </div>
  );
}
