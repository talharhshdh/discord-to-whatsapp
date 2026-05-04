import React from 'react';
import { ToolUrl } from '../api';

function copyText(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }

export default function URLsPanel({ tools }: { tools: Record<string, ToolUrl> }) {
  const keys = Object.keys(tools);

  const ICON: Record<string, string> = {
    dashboard: '🖥️', terminal: '💻', vscode: '🔵', browser: '🌐',
    novnc: '🖥️', bypasser: '⚡',
  };

  if (keys.length === 0) {
    return (
      <div className="glass rounded-2xl p-10 text-center text-white/30 text-sm">
        No tunnels registered yet — they appear here as sessions are launched.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {keys.map(key => {
        const t = tools[key];
        return (
          <div key={key} className="glass glass-hover rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-xl">{ICON[key] ?? '🔗'}</span>
              <div>
                <p className="font-semibold text-white text-sm">{t.label || key}</p>
                <p className="text-xs text-white/30">
                  {new Date(t.registeredAt).toLocaleTimeString()}
                </p>
              </div>
            </div>
            <div className="flex gap-2 items-center bg-black/30 border border-white/10 rounded-xl px-3 py-2">
              <a href={t.url} target="_blank" rel="noopener noreferrer"
                className="flex-1 text-teal-400 hover:underline text-xs font-mono truncate">{t.url}</a>
              <button onClick={() => copyText(t.url)}
                className="text-xs text-white/40 hover:text-white transition-colors px-1">📋</button>
              <a href={t.url} target="_blank" rel="noopener noreferrer"
                className="text-xs text-white/40 hover:text-white transition-colors px-1">↗</a>
            </div>
            {(t.username || t.password) && (
              <div className="grid grid-cols-2 gap-2">
                {t.username && (
                  <div className="bg-black/20 border border-white/10 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Username</p>
                    <p className="text-xs font-mono text-white cursor-pointer hover:text-teal-400 transition-colors"
                      onClick={() => copyText(t.username!)}>{t.username}</p>
                  </div>
                )}
                {t.password && (
                  <div className="bg-black/20 border border-white/10 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Password</p>
                    <p className="text-xs font-mono text-white cursor-pointer hover:text-teal-400 transition-colors"
                      onClick={() => copyText(t.password!)}>{t.password}</p>
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
