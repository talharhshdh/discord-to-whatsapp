import React, { useState } from 'react';
import { api, BASE, SessionResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

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
    <Card className="rounded-2xl flex flex-col justify-between border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md transition-all group hover:shadow-lg p-5">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl border ${color}`}>
            {icon}
          </div>
          <div>
            <h3 className="font-bold text-[var(--text-main)] text-sm">{title}</h3>
            <p className="text-xs text-[var(--text-muted)]">{description}</p>
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
            ❌ {error}
          </div>
        )}

        {result && !result.error && (
          <div className="bg-[var(--code-bg)] border border-[var(--input-border)] rounded-xl p-4 space-y-2 text-sm">
            <a href={result.url} target="_blank" rel="noopener noreferrer"
              className="text-teal-500 hover:underline font-mono text-xs break-all block">
              🔗 {result.url}
            </a>
            {result.username && <p className="text-[var(--text-muted)]">👤 <span className="text-[var(--text-main)] font-mono">{result.username}</span></p>}
            {result.password && <p className="text-[var(--text-muted)]">🔑 <span className="text-[var(--text-main)] font-mono">{result.password}</span></p>}
          </div>
        )}
      </div>

      <Button
        onClick={launch}
        disabled={loading}
        variant="outline"
        className="w-full mt-4 py-2.5 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--text-main)] text-xs font-semibold uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '⏳ Launching…' : `Launch ${title}`}
      </Button>
    </Card>
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
      const res = await fetch(`${BASE}/api/sessions/ssh`, { method: 'POST' });
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
      <p className="text-[var(--text-muted)] text-sm">Launch new isolated sessions. Each call creates a fresh Cloudflare tunnel.</p>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        <SessionCard
          icon="💻" title="Web Terminal" color="bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
          description="ttyd web terminal with sudo access"
          action={api.startTerminal}
        />
        <SessionCard
          icon="🔵" title="VSCode" color="bg-indigo-500/10 border-indigo-500/20 text-indigo-500"
          description="code-server with password auth"
          action={api.startVSCode}
        />
        <SessionCard
          icon="🌐" title="Browser" color="bg-amber-500/10 border-amber-500/20 text-amber-500"
          description="Chromium in a Docker container"
          action={api.startBrowser}
        />

        {/* SSH Terminal Card */}
        <Card className="rounded-2xl flex flex-col justify-between border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md transition-all group hover:shadow-lg p-5">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-purple-500/10 border border-purple-500/20 text-purple-500">
                🔐
              </div>
              <div>
                <h3 className="font-bold text-[var(--text-main)] text-sm">SSH Terminal</h3>
                <p className="text-xs text-[var(--text-muted)]">Isolated container with SSH access</p>
              </div>
            </div>

            {sshError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                ❌ {sshError}
              </div>
            )}

            {sshResult && !sshResult.error && (
              <div className="bg-[var(--code-bg)] border border-[var(--input-border)] rounded-xl p-4 space-y-2 text-sm">
                <p className="text-[var(--text-muted)]">🔌 <span className="text-[var(--text-main)] font-mono">Port: {sshResult.port}</span></p>
                <p className="text-[var(--text-muted)]">👤 <span className="text-[var(--text-main)] font-mono">{sshResult.username}</span></p>
                <p className="text-[var(--text-muted)]">🔑 <span className="text-[var(--text-main)] font-mono">{sshResult.password}</span></p>
                <div className="pt-2 border-t border-[var(--input-border)]">
                  <p className="text-[var(--text-subtle)] text-xs mb-1">SSH Command:</p>
                  <code className="text-teal-500 text-xs bg-[var(--input-bg)] border border-[var(--input-border)] px-2 py-1 rounded block break-all">
                    {sshResult.sshCommand}
                  </code>
                </div>
                <p className="text-[var(--text-subtle)] text-xs pt-2">
                  💡 Use this command from your local terminal or any SSH client
                </p>
              </div>
            )}
          </div>

          <Button
            onClick={launchSSH}
            disabled={sshLoading}
            variant="outline"
            className="w-full mt-4 py-2.5 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] text-[var(--text-main)] text-xs font-semibold uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sshLoading ? '⏳ Launching…' : 'Launch SSH Terminal'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
