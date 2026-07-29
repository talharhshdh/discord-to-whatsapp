import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload, WorkerProxyResponse } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface HeaderPair {
  key: string;
  value: string;
}

export default function ProxyPanel() {
  const [pool, setPool] = useState<BrowserPoolPayload | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<string>('');
  const [url, setUrl] = useState<string>('https://api.ipify.org?format=json');
  const [method, setMethod] = useState<string>('GET');
  const [headers, setHeaders] = useState<HeaderPair[]>([
    { key: 'Accept', value: 'application/json' }
  ]);
  const [body, setBody] = useState<string>('');
  const [timeout, setTimeoutSec] = useState<number>(15);
  const [sending, setSending] = useState<boolean>(false);
  const [response, setResponse] = useState<WorkerProxyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState<boolean>(false);

  const fetchPool = async () => {
    try {
      const data = await api.getBrowserPool();
      setPool(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleAddHeader = () => {
    setHeaders([...headers, { key: '', value: '' }]);
  };

  const handleHeaderChange = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...headers];
    next[index][field] = val;
    setHeaders(next);
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if (!url.trim()) return;
    setSending(true);
    setResponse(null);
    setError(null);

    // Convert header pairs to Record
    const headerDict: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headerDict[h.key.trim()] = h.value.trim();
      }
    }

    try {
      const res = await api.proxyRequestViaWorker({
        workerId: selectedWorker || undefined,
        url: url.trim(),
        method,
        headers: headerDict,
        body: body.trim() || undefined,
        timeout
      });
      setResponse(res);
    } catch (err: any) {
      setError(err.message || 'Proxy request failed');
    } finally {
      setSending(false);
    }
  };

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt).catch(() => {});
  };

  const generateCurl = () => {
    let curl = `curl -X ${method} "${url}"`;
    for (const h of headers) {
      if (h.key.trim()) {
        curl += ` \\\n  -H "${h.key.trim()}: ${h.value.trim()}"`;
      }
    }
    if (['POST', 'PUT', 'PATCH'].includes(method) && body.trim()) {
      curl += ` \\\n  -d '${body.trim()}'`;
    }
    return curl;
  };

  const activeWorkers = (pool?.browsers ?? []).filter(b => b.status === 'active');

  const getStatusColor = (code?: number) => {
    if (!code) return 'bg-white/10 text-white/50 border-white/10';
    if (code >= 200 && code < 300) return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
    if (code >= 300 && code < 400) return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
    return 'bg-rose-500/10 border-rose-500/30 text-rose-400';
  };

  let prettyResponseBody = response?.body ?? '';
  try {
    if (response?.body) {
      const parsed = JSON.parse(response.body);
      prettyResponseBody = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // raw text/html fallback
  }

  return (
    <div className="space-y-6 text-sm">
      {/* Header Banner */}
      <Card className="glass rounded-3xl p-6 border border-white/[0.08] bg-gradient-to-r from-teal-900/20 via-blue-900/10 to-transparent">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#00E5FF] to-[#0061FF] flex items-center justify-center text-2xl shadow-lg shadow-[#00E5FF]/20 text-slate-950">
              📡
            </div>
            <div>
              <CardTitle className="text-[#00E5FF] font-black text-lg">HTTP Proxy & Network Relay</CardTitle>
              <CardDescription className="text-white/40 text-xs mt-0.5">
                Route HTTP/HTTPS API requests through your distributed runner VM IP addresses.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="self-start sm:self-center px-3 py-1 bg-emerald-500/10 border-emerald-500/30 text-emerald-400 text-xs font-bold rounded-full">
            ● {activeWorkers.length} Active Relay Node(s)
          </Badge>
        </div>
      </Card>

      {/* Main Request Form */}
      <Card className="glass rounded-3xl p-6 border border-white/[0.08] space-y-5">
        {/* Worker Selector & Timeout */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
              Relay Worker Node
            </label>
            <select
              value={selectedWorker}
              onChange={(e) => setSelectedWorker(e.target.value)}
              className="w-full bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#00E5FF]/50 transition-colors"
            >
              <option value="">⚡ Auto (Round-Robin Active Worker)</option>
              {activeWorkers.map((w) => (
                <option key={w.workerId} value={w.workerId}>
                  {w.workerId} ({w.secondsSinceHeartbeat}s ago)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
              Request Timeout (Seconds)
            </label>
            <select
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
              className="w-full bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#00E5FF]/50 transition-colors"
            >
              <option value={5}>5 Seconds</option>
              <option value={15}>15 Seconds (Default)</option>
              <option value={30}>30 Seconds</option>
              <option value={60}>60 Seconds</option>
            </select>
          </div>
        </div>

        {/* Method & URL Row */}
        <div>
          <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
            Target Request URL & Method
          </label>
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-[#00E5FF] font-bold outline-none focus:border-[#00E5FF]/50 transition-colors"
            >
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/api/v1/endpoint"
              className="flex-1 bg-[#1E2330] border border-white/[0.08] rounded-xl px-4 py-2.5 text-xs text-white outline-none focus:border-[#00E5FF]/50 transition-colors font-mono"
            />
            <Button
              onClick={handleSend}
              disabled={sending || !url.trim()}
              className="px-6 py-2.5 bg-gradient-to-r from-[#00E5FF] to-[#0061FF] text-slate-950 font-bold text-xs rounded-xl shadow-lg shadow-[#00E5FF]/20 hover:opacity-90 disabled:opacity-40 transition-all flex items-center gap-2"
            >
              {sending ? (
                <>
                  <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                  Relaying...
                </>
              ) : (
                <>📡 Send Request</>
              )}
            </Button>
          </div>
        </div>

        {/* Headers Editor */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-white/40">
              HTTP Headers ({headers.length})
            </span>
            <button
              onClick={handleAddHeader}
              className="text-xs text-[#00E5FF] hover:underline font-semibold"
            >
              + Add Header
            </button>
          </div>

          <div className="space-y-2">
            {headers.map((h, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Header Name (e.g. Authorization)"
                  value={h.key}
                  onChange={(e) => handleHeaderChange(idx, 'key', e.target.value)}
                  className="w-1/3 bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-1.5 text-xs text-white outline-none font-mono"
                />
                <input
                  type="text"
                  placeholder="Header Value (e.g. Bearer token)"
                  value={h.value}
                  onChange={(e) => handleHeaderChange(idx, 'value', e.target.value)}
                  className="flex-1 bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-1.5 text-xs text-white outline-none font-mono"
                />
                <button
                  onClick={() => handleRemoveHeader(idx)}
                  className="text-rose-400 hover:text-rose-300 text-xs px-2 py-1"
                  title="Remove Header"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Request Body (for POST/PUT/PATCH) */}
        {['POST', 'PUT', 'PATCH'].includes(method) && (
          <div className="space-y-2">
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40">
              Request Payload Body (JSON / Raw)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder='{"key": "value"}'
              className="w-full bg-[#0A0E17] border border-white/[0.08] rounded-2xl p-3 font-mono text-xs text-teal-300 outline-none resize-y"
            />
          </div>
        )}
      </Card>

      {/* Response Display Section */}
      {(response || error) && (
        <Card className="glass rounded-3xl overflow-hidden border border-white/[0.08] animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="bg-[#121824] border-b border-white/[0.06] px-6 py-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wider text-white">Proxy Response</span>
              {response && (
                <>
                  <Badge variant="outline" className={`text-[10px] font-bold border px-2.5 py-0.5 rounded-full ${getStatusColor(response.status_code)}`}>
                    HTTP {response.status_code}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-white/5 border-white/10 text-white/60 rounded-full">
                    ⚡ {response.execution_time_ms} ms
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-teal-500/10 border-teal-500/20 text-teal-300 rounded-full font-mono">
                    Worker: {response.workerId}
                  </Badge>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {response && (
                <button
                  onClick={() => setShowHeaders(!showHeaders)}
                  className="px-3 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/70 hover:text-white transition-colors"
                >
                  {showHeaders ? 'Hide Response Headers' : 'Show Response Headers'}
                </button>
              )}
              <Button
                variant="ghost"
                onClick={() => copyText(response ? response.body : error || '')}
                className="text-xs text-white/40 hover:text-white p-1.5 h-auto"
                title="Copy Response Body"
              >
                📋 Copy Body
              </Button>
            </div>
          </div>

          {/* Response Headers Table */}
          {response && showHeaders && (
            <div className="bg-[#0D121F] border-b border-white/[0.06] p-4 text-xs font-mono text-white/70 max-h-[160px] overflow-y-auto space-y-1">
              {Object.entries(response.headers).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-teal-400 font-semibold">{k}:</span>
                  <span className="text-white/60 truncate">{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* Response Body Console */}
          <div className="p-6 bg-[#0A0E17] font-mono text-xs overflow-x-auto min-h-[160px] max-h-[420px]">
            {error ? (
              <div className="text-rose-400">Proxy Error: {error}</div>
            ) : response ? (
              <pre className="text-emerald-400 leading-relaxed">{prettyResponseBody || '(empty response body)'}</pre>
            ) : null}
          </div>

          {/* Equivalent cURL Exporter */}
          <div className="bg-[#0F1420] border-t border-white/[0.06] p-4 flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider text-white/30">Equivalent cURL Request:</span>
            <Button
              variant="outline"
              onClick={() => copyText(generateCurl())}
              className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 text-teal-300 font-mono py-1 px-3 h-auto rounded-lg"
            >
              📋 Copy cURL Command
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
