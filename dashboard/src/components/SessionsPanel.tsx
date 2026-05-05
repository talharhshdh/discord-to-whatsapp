import React, { useState } from 'react';
import { api, SessionResult } from '../api';

interface SessionCardProps {
  icon: string;
  title: string;
  description: string;
  color: string;
  action: () => Promise<SessionResult>;
}

function SessionCard({ icon, title, description, color, action }: SessionCardProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    setLoading(true); setError(null); setResult(null);
    try { setResult(await action()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="glass glass-hover rounded-2xl p-6 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${color}`}>
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-white">{title}</h3>
          <p className="text-xs text-white/40">{description}</p>
        </div>
      </div>

      <button
        onClick={launch}
        disabled={loading}
        className="w-full py-2.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 hover:border-white/20 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '⏳ Launching…' : `Launch ${title}`}
      </button>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          ❌ {error}
        </div>
      )}

      {result && !result.error && (
        <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-2 text-sm">
          <a href={result.url} target="_blank" rel="noopener noreferrer"
            className="text-teal-400 hover:underline font-mono text-xs break-all block">
            🔗 {result.url}
          </a>
          {result.username && <p className="text-white/60">👤 <span className="text-white font-mono">{result.username}</span></p>}
          {result.password && <p className="text-white/60">🔑 <span className="text-white font-mono">{result.password}</span></p>}
        </div>
      )}
    </div>
  );
}

export default function SessionsPanel() {
  const [sshResult, setSshResult] = useState<any>(null);
  const [sshLoading, setSshLoading] = useState(false);
  const [sshError, setSshError] = useState<string | null>(null);

  const launchSSH = async () => {
    setSshLoading(true);
    setSshError(null);
    setSshResult(null);
    try {
      const res = await fetch('/api/sessions/ssh', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setSshError(data.error);
      } else {
        setSshResult(data);
      }
    } catch (e) {
      setSshError((e as Error).message);
    } finally {
      setSshLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-white/40 text-sm">Launch new isolated sessions. Each call creates a fresh Cloudflare tunnel.</p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SessionCard
          icon="💻" title="Web Terminal" color="bg-green-500/15 border border-green-500/20"
          description="ttyd web terminal with sudo access"
          action={api.startTerminal}
        />
        <SessionCard
          icon="🔵" title="VSCode" color="bg-blue-500/15 border border-blue-500/20"
          description="code-server with password auth"
          action={api.startVSCode}
        />
        <SessionCard
          icon="🌐" title="Browser" color="bg-amber-500/15 border border-amber-500/20"
          description="Chromium in a Docker container"
          action={api.startBrowser}
        />

        {/* SSH Terminal Card */}
        <div className="glass glass-hover rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-purple-500/15 border border-purple-500/20">
              🔐
            </div>
            <div>
              <h3 className="font-semibold text-white">SSH Terminal</h3>
              <p className="text-xs text-white/40">Isolated container with SSH access</p>
            </div>
          </div>

          <button
            onClick={launchSSH}
            disabled={sshLoading}
            className="w-full py-2.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 hover:border-white/20 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sshLoading ? '⏳ Launching…' : 'Launch SSH Terminal'}
          </button>

          {sshError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              ❌ {sshError}
            </div>
          )}

          {sshResult && !sshResult.error && (
            <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-2 text-sm">
              <p className="text-white/60">🔌 <span className="text-white font-mono">Port: {sshResult.port}</span></p>
              <p className="text-white/60">👤 <span className="text-white font-mono">{sshResult.username}</span></p>
              <p className="text-white/60">🔑 <span className="text-white font-mono">{sshResult.password}</span></p>
              <div className="pt-2 border-t border-white/10">
                <p className="text-white/40 text-xs mb-1">SSH Command:</p>
                <code className="text-teal-400 text-xs bg-black/40 px-2 py-1 rounded block break-all">
                  {sshResult.sshCommand}
                </code>
              </div>
              <p className="text-white/30 text-xs pt-2">
                💡 Use this command from your local terminal or any SSH client
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
