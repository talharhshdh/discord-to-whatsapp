import React, { useState } from 'react';
import { api } from './api';
import { useUrls, useCountdown, NavSection } from './hooks';
import SessionsPanel from './components/SessionsPanel';
import SessionsManagerPanel from './components/SessionsManagerPanel';
import AIToolsPanel from './components/AIToolsPanel';
import MediaPanel from './components/MediaPanel';
import YoutubePanel from './components/YoutubePanel';
import MoviesPanel from './components/MoviesPanel';
import URLsPanel from './components/URLsPanel';
import AndroidPanel from './components/AndroidPanel';
import LLMPanel from './components/LLMPanel';
import SearchPanel from './components/SearchPanel';
import TTSPanel from './components/TTSPanel';
import PlacesPanel from './components/PlacesPanel';
import GoogleClonePanel from './components/GoogleClonePanel';
import WebProxyPanel from './components/WebProxyPanel';
import PoolPanel from './components/PoolPanel';


const NAV: { id: NavSection; label: string; icon: string }[] = [
  { id: 'google',    label: 'Google Clone',   icon: '🌐' },
  { id: 'web-proxy', label: 'Web Proxy',      icon: '🌍' },
  { id: 'search',    label: 'Browser Search', icon: '🔍' },
  { id: 'places',    label: 'Maps Places',    icon: '🗺️' },
  { id: 'pool',      label: 'Browser Pool',   icon: '🕸️' },
  { id: 'sessions',  label: 'Dev Sessions',  icon: '🖥️' },
  { id: 'manager',   label: 'Session Manager', icon: '📊' },
  { id: 'android',   label: 'Android',       icon: '📱' },
  { id: 'ai-tools',  label: 'AI Tools',      icon: '🧠' },
  { id: 'media',     label: 'Media DL',      icon: '📥' },
  { id: 'youtube',   label: 'YouTube',        icon: '▶️' },
  { id: 'movies',    label: 'Movies',         icon: '🎬' },
  { id: 'urls',      label: 'Live URLs',      icon: '🔗' },
  { id: 'llm',       label: 'Local LLM',      icon: '🧠' },
  { id: 'tts',       label: 'Voice / TTS',    icon: '🎙️' },
];

export default function App() {
  const getInitialSection = (): NavSection => {
    const path = window.location.pathname;
    const hash = window.location.hash;
    if (path === '/google' || hash === '#/google') {
      return 'google';
    }
    return 'sessions';
  };

  const [section, setSection] = React.useState<NavSection>(getInitialSection());
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  });

  React.useEffect(() => {
    localStorage.setItem('theme', theme);
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);
  
  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!localStorage.getItem('dashboard_token'));
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const { data, refresh } = useUrls();
  const cd = useCountdown(data?.sessionRemainingSeconds ?? 5 * 3600);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await api.login(loginUsername, loginPassword);
      if (res.success && res.token) {
        localStorage.setItem('dashboard_token', res.token);
        setIsAuthenticated(true);
        refresh();
      } else {
        setLoginError('Invalid credentials');
      }
    } catch (err: any) {
      setLoginError(err.message || 'Authentication failed');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('dashboard_token');
    setIsAuthenticated(false);
    if (section !== 'google') {
      setSection('sessions');
    }
  };

  React.useEffect(() => {
    const handleLocationChange = () => {
      const path = window.location.pathname;
      const hash = window.location.hash;
      if (path === '/google' || hash === '#/google') {
        setSection('google');
      }
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  const handleNavClick = (id: NavSection) => {
    setSection(id);
    setIsMenuOpen(false);
    
    // Update hash for SPA linkability
    if (id === 'google') {
      window.history.pushState(null, '', '/google');
    } else {
      window.history.pushState(null, '', '/');
    }
  };

  if (!isAuthenticated && section !== 'google') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#070b14] relative p-4 font-sans text-white">
        {/* Theme toggle on login screen */}
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2.5 rounded-xl glass border border-white/10 text-white/60 hover:text-white/90 hover:scale-[1.02] active:scale-[0.98] text-xs transition-all flex items-center gap-1.5 font-medium shadow-lg shadow-black/10"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>

        {/* Ambient orbs */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-[#6c63ff]/10 blur-[120px]" />
          <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#00d4aa]/10 blur-[120px]" />
        </div>

        <div className="relative z-10 w-full max-w-md glass border border-white/[0.08] p-8 rounded-3xl shadow-2xl space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-3xl shadow-lg shadow-[#6c63ff]/20 mb-4 animate-pulse">
              🔒
            </div>
            <h2 className="text-2xl font-black tracking-tight bg-gradient-to-r from-white via-white to-white/70 bg-clip-text text-transparent">Bridge Panel Login</h2>
            <p className="text-xs text-white/40 mt-1">Please authenticate to manage Discord/WhatsApp sessions</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">Username</label>
              <input
                type="text"
                required
                className="w-full bg-[#1b1b22] border border-white/10 rounded-xl px-4 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#6c63ff]/40 text-white"
                placeholder="Enter username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">Password</label>
              <input
                type="password"
                required
                className="w-full bg-[#1b1b22] border border-white/10 rounded-xl px-4 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#6c63ff]/40 text-white"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
              />
            </div>

            {loginError && (
              <div className="p-3 text-xs bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg">
                ⚠️ {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-3 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] hover:opacity-90 disabled:opacity-50 text-sm font-semibold rounded-xl text-white transition-all shadow-lg shadow-[#6c63ff]/15"
            >
              {loginLoading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>

          <div className="text-center pt-2">
            <button
              onClick={() => {
                setSection('google');
                window.history.pushState(null, '', '/google');
              }}
              className="text-xs text-[#00d4aa] hover:underline"
            >
              🌍 View public Google Clone instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (section === 'google') {
    return <GoogleClonePanel isStandalone={true} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#070b14]">
      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-[#6c63ff]/10 blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#00d4aa]/10 blur-[120px]" />
      </div>

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="glass border-b border-white/[0.07] px-4 md:px-6 py-3 md:py-4 sticky top-0 z-30">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 md:gap-3">
              <div className="w-7 h-7 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-base md:text-xl shadow-lg shadow-[#6c63ff]/30">
                🤖
              </div>
              <div>
                <h1 className="font-bold text-white text-xs md:text-base leading-tight">Bridge Panel</h1>
                <p className="hidden sm:block text-[10px] md:text-xs text-white/30">Discord ↔ WhatsApp</p>
              </div>
            </div>

            <div className="flex items-center gap-2 md:gap-3">
              {/* Countdown - simplified on mobile */}
              <div className={`flex items-center gap-1.5 px-2 md:px-3 py-1 md:py-1.5 rounded-full border text-[10px] md:text-xs font-mono ${
                cd.urgent ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-white/[0.04] border-white/10 text-white/60'
              }`}>
                <span className="hidden sm:inline">⏱</span> {cd.display}
              </div>

              {/* Theme toggle button */}
              <button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} 
                className="p-1.5 md:px-3 md:py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 text-[10px] md:text-xs transition-colors flex items-center gap-1.5 font-medium"
                title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              >
                <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
                <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
              </button>

              <button onClick={refresh} className="p-1.5 md:px-3 md:py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-[10px] md:text-xs transition-colors">
                <span className="hidden md:inline">🔄 Refresh</span>
                <span className="md:hidden">🔄</span>
              </button>

              {isAuthenticated && (
                <button onClick={handleLogout} className="p-1.5 md:px-3 md:py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:text-red-300 text-[10px] md:text-xs transition-colors">
                  <span className="hidden md:inline">🚪 Sign Out</span>
                  <span className="md:hidden">🚪</span>
                </button>
              )}

              <button 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="md:hidden p-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60"
              >
                {isMenuOpen ? '✕' : '☰'}
              </button>
            </div>
          </div>
        </header>

        {/* Session progress bar */}
        <div className="h-0.5 bg-white/[0.04] sticky top-[57px] md:top-[73px] z-30">
          <div
            className={`h-full transition-all duration-1000 ${cd.urgent ? 'bg-red-500' : 'bg-gradient-to-r from-[#6c63ff] to-[#00d4aa]'}`}
            style={{ width: `${cd.pct}%` }}
          />
        </div>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Desktop Sidebar */}
          <nav className="w-56 flex-shrink-0 glass border-r border-white/[0.07] p-3 space-y-1 hidden md:block overflow-y-auto scrollbar-thin">
            {NAV.map(n => (
              <button
                key={n.id}
                onClick={() => handleNavClick(n.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  section === n.id
                    ? 'bg-[#6c63ff]/20 text-white border border-[#6c63ff]/30'
                    : 'text-white/40 hover:text-white hover:bg-white/[0.05]'
                }`}
              >
                <span>{n.icon}</span>
                {n.label}
                {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                  <span className="ml-auto text-xs bg-teal-500/20 text-teal-400 rounded-full px-1.5 py-0.5">
                    {Object.keys(data.tools).length}
                  </span>
                )}
              </button>
            ))}

            <div className="pt-4 border-t border-white/[0.06] mt-2">
              {data?.sessionStartedAt && (
                <p className="text-[10px] text-white/20 px-3 leading-relaxed">
                  Started<br />
                  {new Date(data.sessionStartedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          </nav>

          {/* Mobile Side Menu Overlay */}
          {isMenuOpen && (
            <div className="fixed inset-0 z-40 md:hidden bg-black/60 backdrop-blur-sm" onClick={() => setIsMenuOpen(false)}>
              <nav 
                className="absolute right-0 top-0 bottom-0 w-64 bg-[#0d1424] border-l border-white/[0.07] p-4 flex flex-col shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-bold text-white text-sm">Navigation</h3>
                  <button onClick={() => setIsMenuOpen(false)} className="text-white/40 text-xl">✕</button>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                  {NAV.map(n => (
                    <button
                      key={n.id}
                      onClick={() => handleNavClick(n.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                        section === n.id
                          ? 'bg-[#6c63ff]/20 text-white border border-[#6c63ff]/30'
                          : 'text-white/40 hover:text-white hover:bg-white/[0.05]'
                      }`}
                    >
                      <span className="text-lg">{n.icon}</span>
                      {n.label}
                      {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                        <span className="ml-auto text-xs bg-teal-500/20 text-teal-400 rounded-full px-2 py-0.5">
                          {Object.keys(data.tools).length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-green-500/5 border border-green-500/10 text-green-400 text-[10px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    Session Active
                  </div>
                </div>
              </nav>
            </div>
          )}


          {/* Main content */}
          <main className="flex-1 overflow-y-auto scrollbar-thin p-4 md:p-6 lg:p-8">
            <div className="max-w-5xl mx-auto">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center text-xl shadow-inner">
                    {NAV.find(n => n.id === section)?.icon}
                  </span>
                  {NAV.find(n => n.id === section)?.label}
                </h2>
              </div>

              <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                {section === 'sessions' && <SessionsPanel />}
                {section === 'manager' && <SessionsManagerPanel />}
                {section === 'android' && <AndroidPanel />}
                {section === 'ai-tools' && <AIToolsPanel />}
                {section === 'media' && <MediaPanel />}
                {section === 'youtube' && <YoutubePanel />}
                {section === 'movies' && <MoviesPanel />}
                {section === 'urls' && <URLsPanel tools={data?.tools ?? {}} />}
                {section === 'llm' && <LLMPanel />}
                {section === 'search' && <SearchPanel />}
                {section === 'places' && <PlacesPanel />}
                {section === 'pool' && <PoolPanel />}
                {section === 'tts' && <TTSPanel />}
                {section === 'web-proxy' && <WebProxyPanel />}

              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
