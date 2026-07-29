import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload, WorkerExecResponse } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const PRESETS = {
  node: [
    {
      name: 'Fetch Worker Public IP',
      code: `const fetch = require('node-fetch') || globalThis.fetch;
(async () => {
  const res = await fetch('https://api.ipify.org?format=json');
  const data = await res.json();
  console.log('Worker Runner IP:', data.ip);
  console.log('Timestamp:', new Date().toISOString());
})();`
    },
    {
      name: 'Check Environment & Memory',
      code: `const os = require('os');
console.log('OS Platform:', os.platform(), os.release());
console.log('CPU Architecture:', os.arch());
console.log('CPU Cores:', os.cpus().length);
console.log('Total Memory:', Math.round(os.totalmem() / 1024 / 1024), 'MB');
console.log('Free Memory:', Math.round(os.freemem() / 1024 / 1024), 'MB');
console.log('Uptime:', Math.round(os.uptime()), 'seconds');`
    },
    {
      name: 'Scrape Web Page (Cheerio)',
      code: `const cheerio = require('cheerio');
(async () => {
  const res = await fetch('https://news.ycombinator.com/');
  const html = await res.text();
  const $ = cheerio.load(html);
  console.log('Hacker News Top Headlines:');
  $('.titleline > a').slice(0, 5).each((i, el) => {
    console.log(\`\${i + 1}. \${$(el).text()} (\${$(el).attr('href')})\`);
  });
})();`
    }
  ],
  python: [
    {
      name: 'Fetch Worker Public IP',
      code: `import urllib.request
import json
import datetime

req = urllib.request.urlopen('https://api.ipify.org?format=json')
data = json.loads(req.read().decode('utf-8'))
print(f"Worker Runner IP: {data['ip']}")
print(f"Timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")`
    },
    {
      name: 'Check Python Environment & Packages',
      code: `import sys
import os
import pkg_resources

print(f"Python Version: {sys.version}")
print(f"Executable: {sys.executable}")
print("\\nInstalled Packages:")
installed = sorted([f"{d.project_name}=={d.version}" for d in pkg_resources.working_set])
for pkg in installed[:15]:
    print(f"  - {pkg}")
print(f"  ... total {len(installed)} packages")`
    }
  ],
  shell: [
    {
      name: 'Check Installed Tool Binaries',
      code: `which node python3 google-chrome cloudflared git aws || true
echo "--- Chrome Version ---"
google-chrome --version || true
echo "--- Node Version ---"
node -v || true
echo "--- Python Version ---"
python3 --version || true`
    },
    {
      name: 'System Resources & Disk Space',
      code: `uname -a
echo "--- CPU Info ---"
lscpu | grep "Model name\|CPU(s):" || true
echo "--- Disk Space ---"
df -h /
echo "--- RAM Usage ---"
free -h`
    }
  ]
};

export default function CodeExecPanel() {
  const [pool, setPool] = useState<BrowserPoolPayload | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<string>('');
  const [lang, setLang] = useState<'node' | 'python' | 'shell'>('node');
  const [code, setCode] = useState<string>(PRESETS.node[0].code);
  const [timeout, setTimeoutSec] = useState<number>(30);
  const [executing, setExecuting] = useState<boolean>(false);
  const [result, setResult] = useState<WorkerExecResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'stdout' | 'stderr'>('stdout');

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

  const handleLangChange = (newLang: 'node' | 'python' | 'shell') => {
    setLang(newLang);
    setCode(PRESETS[newLang][0].code);
    setResult(null);
    setError(null);
  };

  const handleRun = async () => {
    if (!code.trim()) return;
    setExecuting(true);
    setResult(null);
    setError(null);

    try {
      const res = await api.execCodeOnWorker({
        workerId: selectedWorker || undefined,
        lang,
        code,
        timeout
      });
      setResult(res);
      if (res.stderr && !res.stdout) {
        setActiveTab('stderr');
      } else {
        setActiveTab('stdout');
      }
    } catch (err: any) {
      setError(err.message || 'Execution failed');
    } finally {
      setExecuting(false);
    }

  };

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt).catch(() => {});
  };

  const activeWorkers = (pool?.browsers ?? []).filter(b => b.status === 'active');

  return (
    <div className="space-y-6 text-sm">
      {/* Header Banner */}
      <Card className="glass rounded-3xl p-6 border border-white/[0.08] bg-gradient-to-r from-blue-900/20 via-indigo-900/10 to-transparent">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#0061FF] to-[#00E5FF] flex items-center justify-center text-2xl shadow-lg shadow-[#0061FF]/20">
              💻
            </div>
            <div>
              <CardTitle className="text-[#00E5FF] font-black text-lg">Worker Code Execution Engine</CardTitle>
              <CardDescription className="text-white/40 text-xs mt-0.5">
                Upload and run Node.js, Python, or Shell code snippets directly inside your distributed worker containers.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="self-start sm:self-center px-3 py-1 bg-emerald-500/10 border-emerald-500/30 text-emerald-400 text-xs font-bold rounded-full">
            ● {activeWorkers.length} Active Runner(s)
          </Badge>
        </div>
      </Card>

      {/* Control Panel Settings */}
      <Card className="glass rounded-3xl p-6 border border-white/[0.08] space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Target Worker Selector */}
          <div>
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
              Target Worker Instance
            </label>
            <select
              value={selectedWorker}
              onChange={(e) => setSelectedWorker(e.target.value)}
              className="w-full bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#0061FF]/50 transition-colors"
            >
              <option value="">⚡ Auto (Round Robin Active Worker)</option>
              {activeWorkers.map((w) => (
                <option key={w.workerId} value={w.workerId}>
                  {w.workerId} ({w.secondsSinceHeartbeat}s ago)
                </option>
              ))}
            </select>
          </div>

          {/* Language Selector */}
          <div>
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
              Runtime Language
            </label>
            <div className="grid grid-cols-3 gap-1 bg-[#1E2330] p-1 rounded-xl border border-white/[0.08]">
              {(['node', 'python', 'shell'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => handleLangChange(l)}
                  className={`py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                    lang === l
                      ? 'bg-[#0061FF] text-white shadow-md'
                      : 'text-white/40 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {l === 'node' ? '⚡ Node.js' : l === 'python' ? '🐍 Python' : '🐚 Shell'}
                </button>
              ))}
            </div>
          </div>

          {/* Execution Timeout */}
          <div>
            <label className="block text-[10px] uppercase font-bold tracking-wider text-white/40 mb-2">
              Timeout (Seconds)
            </label>
            <select
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
              className="w-full bg-[#1E2330] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-[#0061FF]/50 transition-colors"
            >
              <option value={10}>10 Seconds</option>
              <option value={30}>30 Seconds (Default)</option>
              <option value={60}>60 Seconds</option>
              <option value={120}>120 Seconds</option>
            </select>
          </div>
        </div>

        {/* Preset Snippets */}
        <div>
          <span className="text-[10px] uppercase font-bold tracking-wider text-white/30 mr-3">
            Quick Presets:
          </span>
          <div className="inline-flex flex-wrap gap-2 mt-1">
            {PRESETS[lang].map((p) => (
              <button
                key={p.name}
                onClick={() => setCode(p.code)}
                className="px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 text-xs text-white/70 hover:text-white transition-colors"
              >
                + {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Code Editor */}
        <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-[#0A0E17]">
          <div className="bg-[#121824] px-4 py-2 flex items-center justify-between border-b border-white/[0.06]">
            <span className="text-xs font-mono text-white/50">
              {lang === 'node' ? 'script.js' : lang === 'python' ? 'script.py' : 'script.sh'}
            </span>
            <button
              onClick={() => setCode('')}
              className="text-[10px] text-white/30 hover:text-white transition-colors"
            >
              Clear Editor
            </button>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={10}
            className="w-full bg-transparent p-4 font-mono text-xs text-teal-300 outline-none resize-y leading-relaxed placeholder-white/20"
            placeholder={`Enter your ${lang} code here...`}
            spellCheck={false}
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-white/40">
            {selectedWorker ? `Target: ${selectedWorker}` : 'Target: Next available active worker'}
          </span>
          <Button
            onClick={handleRun}
            disabled={executing || !code.trim()}
            className="px-6 py-2.5 bg-gradient-to-r from-[#0061FF] to-[#00E5FF] hover:opacity-90 disabled:opacity-40 text-white font-bold text-xs rounded-xl shadow-lg shadow-[#0061FF]/20 transition-all flex items-center gap-2"
          >
            {executing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Executing Code...
              </>
            ) : (
              <>🚀 Execute on Worker</>
            )}
          </Button>
        </div>
      </Card>

      {/* Execution Results Output Console */}
      {(result || error) && (
        <Card className="glass rounded-3xl overflow-hidden border border-white/[0.08] animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="bg-[#121824] border-b border-white/[0.06] px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wider text-white">Execution Console</span>
              {result && (
                <>
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${
                      result.exit_code === 0
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                    }`}
                  >
                    Exit Code: {result.exit_code}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-white/5 border-white/10 text-white/60 rounded-full">
                    ⚡ {result.execution_time_ms} ms
                  </Badge>

                  <Badge variant="outline" className="text-[10px] bg-teal-500/10 border-teal-500/20 text-teal-300 rounded-full font-mono">
                    Worker: {result.workerId}
                  </Badge>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {result && (
                <div className="flex bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs">
                  <button
                    onClick={() => setActiveTab('stdout')}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      activeTab === 'stdout' ? 'bg-[#0061FF] text-white' : 'text-white/40 hover:text-white'
                    }`}
                  >
                    stdout ({result.stdout.length} chars)
                  </button>
                  <button
                    onClick={() => setActiveTab('stderr')}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      activeTab === 'stderr' ? 'bg-[#0061FF] text-white' : 'text-white/40 hover:text-white'
                    }`}
                  >
                    stderr ({result.stderr.length} chars)
                  </button>
                </div>
              )}

              <Button
                variant="ghost"
                onClick={() => copyText(result ? (activeTab === 'stdout' ? result.stdout : result.stderr) : error || '')}
                className="text-xs text-white/40 hover:text-white p-1.5 h-auto"
                title="Copy Console Output"
              >
                📋 Copy
              </Button>
            </div>
          </div>

          <div className="p-6 bg-[#0A0E17] font-mono text-xs overflow-x-auto min-h-[160px] max-h-[400px]">
            {error ? (
              <div className="text-rose-400">Error: {error}</div>
            ) : result ? (
              <pre className={activeTab === 'stderr' ? 'text-rose-300' : 'text-emerald-400'}>
                {activeTab === 'stdout'
                  ? result.stdout || '(no output produced on stdout)'
                  : result.stderr || '(no errors reported on stderr)'}
              </pre>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}
