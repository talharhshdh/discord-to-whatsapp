import React, { useState } from 'react';
import { useUrls, useCountdown, NavSection } from './hooks';
import SessionsPanel from './components/SessionsPanel';
import AIToolsPanel from './components/AIToolsPanel';
import MediaPanel from './components/MediaPanel';
import YoutubePanel from './components/YoutubePanel';
import MoviesPanel from './components/MoviesPanel';
import URLsPanel from './components/URLsPanel';
import AndroidPanel from './components/AndroidPanel';

const NAV: { id: NavSection; label: string; icon: string }[] = [
  { id: 'sessions',  label: 'Dev Sessions',  icon: '🖥️' },
  { id: 'android',   label: 'Android',       icon: '📱' },
  { id: 'ai-tools',  label: 'AI Tools',      icon: '🧠' },
  { id: 'media',     label: 'Media DL',      icon: '📥' },
  { id: 'youtube',   label: 'YouTube',        icon: '▶️' },
  { id: 'movies',    label: 'Movies',         icon: '🎬' },
  { id: 'urls',      label: 'Live URLs',      icon: '🔗' },
];

export default function App() {
  const [section, setSection] = useState<NavSection>('sessions');
  const { data, refresh } = useUrls();
  const cd = useCountdown(data?.sessionRemainingSeconds ?? 5 * 3600);

  return (
    <div className="min-h-screen flex flex-col bg-[#070b14]">
      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-[#6c63ff]/10 blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#00d4aa]/10 blur-[120px]" />
      </div>

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="glass border-b border-white/[0.07] px-6 py-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-xl shadow-lg shadow-[#6c63ff]/30">
              🤖
            </div>
            <div>
              <h1 className="font-bold text-white text-base leading-tight">Bridge Control Panel</h1>
              <p className="text-xs text-white/30">Discord ↔ WhatsApp · GitHub Actions</p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Session Active
            </div>

            {/* Countdown */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-mono ${
              cd.urgent ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-white/[0.04] border-white/10 text-white/60'
            }`}>
              ⏱ {cd.display}
            </div>

            <button onClick={refresh} className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-xs transition-colors">
              🔄 Refresh
            </button>
          </div>
        </header>

        {/* Session progress bar */}
        <div className="h-0.5 bg-white/[0.04]">
          <div
            className={`h-full transition-all duration-1000 ${cd.urgent ? 'bg-red-500' : 'bg-gradient-to-r from-[#6c63ff] to-[#00d4aa]'}`}
            style={{ width: `${cd.pct}%` }}
          />
        </div>

        <div className="flex flex-1">
          {/* Sidebar */}
          <nav className="w-56 flex-shrink-0 glass border-r border-white/[0.07] p-3 space-y-1 hidden md:block">
            {NAV.map(n => (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  section === n.id
                    ? 'bg-[#6c63ff]/20 text-white border border-[#6c63ff]/30'
                    : 'text-white/40 hover:text-white hover:bg-white/[0.05]'
                }`}
              >
                <span>{n.icon}</span>
                {n.label}
                {n.id === 'urls' && data && Object.keys(data.tools).length > 0 && (
                  <span className="ml-auto text-xs bg-teal-500/20 text-teal-400 rounded-full px-1.5 py-0.5">
                    {Object.keys(data.tools).length}
                  </span>
                )}
              </button>
            ))}

            {/* Divider + session started */}
            <div className="pt-4 border-t border-white/[0.06] mt-2">
              {data?.sessionStartedAt && (
                <p className="text-[10px] text-white/20 px-3 leading-relaxed">
                  Started<br />
                  {new Date(data.sessionStartedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          </nav>

          {/* Mobile nav tabs */}
          <div className="md:hidden w-full overflow-x-auto border-b border-white/[0.07] flex gap-1 px-3 py-2 bg-[#0d1424]">
            {NAV.map(n => (
              <button key={n.id} onClick={() => setSection(n.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  section === n.id ? 'bg-[#6c63ff]/20 text-white' : 'text-white/40'
                }`}>
                {n.icon} {n.label}
              </button>
            ))}
          </div>

          {/* Main content */}
          <main className="flex-1 overflow-y-auto scrollbar-thin p-6">
            <div className="max-w-5xl mx-auto">
              <div className="mb-5">
                <h2 className="text-lg font-bold text-white">
                  {NAV.find(n => n.id === section)?.icon} {NAV.find(n => n.id === section)?.label}
                </h2>
              </div>

              {section === 'sessions' && <SessionsPanel />}
              {section === 'android' && <AndroidPanel />}
              {section === 'ai-tools' && <AIToolsPanel />}
              {section === 'media' && <MediaPanel />}
              {section === 'youtube' && <YoutubePanel />}
              {section === 'movies' && <MoviesPanel />}
              {section === 'urls' && <URLsPanel tools={data?.tools ?? {}} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
