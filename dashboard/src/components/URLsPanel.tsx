import React, { useState } from 'react';
import { ToolUrl } from '../api';

export default function URLsPanel({ tools }: { tools: Record<string, ToolUrl> }) {
  const keys = Object.keys(tools);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const ICON: Record<string, string> = {
    dashboard: '🖥️',
    terminal: '💻',
    vscode: '🔵',
    browser: '🌐',
    novnc: '🖥️',
    bypasser: '⚡',
  };

  if (keys.length === 0) {
    return (
      <div className="glass rounded-3xl p-12 text-center text-white/30 text-sm border border-white/[0.08] max-w-2xl mx-auto shadow-2xl space-y-2">
        <div className="text-3xl">🔗</div>
        <p className="font-semibold text-white/50">No Live Tunnels Connected</p>
        <p className="text-xs text-white/20">Active URLs will automatically appear here as isolated sessions are launched.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
      {keys.map(key => {
        const t = tools[key];
        const displayLabel = t.label || key;
        return (
          <div
            key={key}
            className="glass glass-hover rounded-3xl p-6 space-y-4 border border-white/[0.08] shadow-lg flex flex-col relative overflow-hidden group"
          >
            {/* Ambient subtle card glow */}
            <div className="absolute -top-12 -right-12 w-24 h-24 rounded-full bg-teal-500/5 blur-2xl pointer-events-none group-hover:bg-[#6c63ff]/10 transition-all duration-500" />

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-lg shadow-inner">
                  {ICON[key] ?? '🔗'}
                </div>
                <div>
                  <p className="font-bold text-white text-sm">{displayLabel}</p>
                  <p className="text-[10px] text-white/30 font-mono">
                    Registered at: {new Date(t.registeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
              
              <span className="px-2 py-0.5 rounded bg-teal-500/10 border border-teal-500/20 text-[9px] font-bold text-teal-400 uppercase tracking-wider">
                Live
              </span>
            </div>

            {/* Connection link */}
            <div className="flex gap-2 items-center bg-[#161b26]/50 border border-white/[0.08] rounded-2xl px-4 py-3 shadow-inner">
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-teal-400 hover:text-teal-300 hover:underline text-xs font-mono truncate"
              >
                {t.url}
              </a>
              <button
                onClick={() => copyText(t.url, `${key}-url`)}
                className="text-xs text-white/40 hover:text-white transition-colors px-1.5 py-0.5 hover:bg-white/[0.04] rounded-lg"
                title="Copy URL"
              >
                {copiedKey === `${key}-url` ? '✓' : '📋'}
              </button>
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white/40 hover:text-white transition-colors px-1.5 py-0.5 hover:bg-white/[0.04] rounded-lg"
                title="Open URL"
              >
                ↗
              </a>
            </div>

            {/* Credentials block */}
            {(t.username || t.password) && (
              <div className="grid grid-cols-2 gap-3 mt-auto pt-2">
                {t.username && (
                  <div
                    onClick={() => copyText(t.username!, `${key}-user`)}
                    className="bg-black/20 border border-white/[0.06] rounded-2xl px-4 py-3 cursor-pointer hover:bg-white/[0.02] hover:border-white/10 transition-all select-none relative group/item"
                  >
                    <p className="text-[9px] text-white/30 uppercase font-black tracking-wider mb-1">Username</p>
                    <p className="text-xs font-mono text-white/80 group-hover/item:text-teal-400 transition-colors truncate">
                      {t.username}
                    </p>
                    <span className="absolute top-2 right-2 text-[8px] opacity-0 group-hover/item:opacity-100 transition-opacity text-white/30">
                      {copiedKey === `${key}-user` ? 'Copied' : 'Copy'}
                    </span>
                  </div>
                )}
                {t.password && (
                  <div
                    onClick={() => copyText(t.password!, `${key}-pass`)}
                    className="bg-black/20 border border-white/[0.06] rounded-2xl px-4 py-3 cursor-pointer hover:bg-white/[0.02] hover:border-white/10 transition-all select-none relative group/item"
                  >
                    <p className="text-[9px] text-white/30 uppercase font-black tracking-wider mb-1">Password</p>
                    <p className="text-xs font-mono text-white/80 group-hover/item:text-teal-400 transition-colors truncate">
                      {t.password}
                    </p>
                    <span className="absolute top-2 right-2 text-[8px] opacity-0 group-hover/item:opacity-100 transition-opacity text-white/30">
                      {copiedKey === `${key}-pass` ? 'Copied' : 'Copy'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
