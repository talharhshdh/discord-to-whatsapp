import React, { useState } from 'react';
import { api } from './api';
import { useUrls, useCountdown, NavSection } from './hooks';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const SessionsPanel = React.lazy(() => import('./components/SessionsPanel'));
const SessionsManagerPanel = React.lazy(() => import('./components/SessionsManagerPanel'));
const AIToolsPanel = React.lazy(() => import('./components/AIToolsPanel'));
const MediaPanel = React.lazy(() => import('./components/MediaPanel'));
const YoutubePanel = React.lazy(() => import('./components/YoutubePanel'));
const MoviesPanel = React.lazy(() => import('./components/MoviesPanel'));
const URLsPanel = React.lazy(() => import('./components/URLsPanel'));
const AndroidPanel = React.lazy(() => import('./components/AndroidPanel'));
const LLMPanel = React.lazy(() => import('./components/LLMPanel'));
const SearchPanel = React.lazy(() => import('./components/SearchPanel'));
const TTSPanel = React.lazy(() => import('./components/TTSPanel'));
const PlacesPanel = React.lazy(() => import('./components/PlacesPanel'));
const GoogleClonePanel = React.lazy(() => import('./components/GoogleClonePanel'));
const WebProxyPanel = React.lazy(() => import('./components/WebProxyPanel'));
const PoolPanel = React.lazy(() => import('./components/PoolPanel'));
const BetaGoContainerPanel = React.lazy(() => import('./components/BetaGoContainerPanel'));

interface NavItem {
  id: NavSection;
  label: string;
  icon: string;
}

interface NavCategory {
  title: string;
  icon: string;
  items: NavItem[];
}

const NAV_CATEGORIES: NavCategory[] = [
  {
    title: 'Public Sandbox',
    icon: '🌍',
    items: [
      { id: 'google',    label: 'Google Clone',   icon: '🌐' },
      { id: 'web-proxy', label: 'Web Proxy',      icon: '🌍' },
    ]
  },
  {
    title: 'Browser & Search',
    icon: '🔍',
    items: [
      { id: 'search',    label: 'Browser Search', icon: '🔍' },
      { id: 'places',    label: 'Maps Places',    icon: '🗺️' },
      { id: 'pool',      label: 'Browser Pool',   icon: '🕸️' },
    ]
  },
  {
    title: 'Control Center',
    icon: '🖥️',
    items: [
      { id: 'sessions',  label: 'Dev Sessions',   icon: '🖥️' },
      { id: 'manager',   label: 'Session Manager', icon: '📊' },
      { id: 'android',   label: 'Android',        icon: '📱' },
      { id: 'urls',      label: 'Live URLs',      icon: '🔗' },
      { id: 'go-containers', label: 'Beta Containers (Go)', icon: '⚡' },
    ]
  },
  {
    title: 'AI & Media',
    icon: '✨',
    items: [
      { id: 'ai-tools',  label: 'AI Tools',       icon: '🧠' },
      { id: 'media',     label: 'Media DL',       icon: '📥' },
      { id: 'youtube',   label: 'YouTube',        icon: '▶️' },
      { id: 'movies',    label: 'Movies',         icon: '🎬' },
      { id: 'llm',       label: 'Local LLM',      icon: '🧠' },
      { id: 'tts',       label: 'Voice / TTS',    icon: '🎙️' },
    ]
  }
];

const NAV: NavItem[] = NAV_CATEGORIES.flatMap(cat => cat.items);

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
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCategories = NAV_CATEGORIES.map(category => {
    const filteredItems = category.items.filter(item =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return {
      ...category,
      items: filteredItems,
    };
  }).filter(category => category.items.length > 0);
  
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

  const { data, refresh } = useUrls(isAuthenticated);
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
          <Button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            variant="outline"
            className="p-2.5 h-auto rounded-xl glass border border-white/10 text-white/60 hover:text-white/90 hover:scale-[1.02] active:scale-[0.98] text-xs transition-all flex items-center gap-1.5 font-medium shadow-lg shadow-black/10"
            title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          >
            <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </Button>
        </div>

        {/* Ambient orbs */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-[#6c63ff]/10 blur-[120px]" />
          <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#00d4aa]/10 blur-[120px]" />
        </div>

        <Card className="relative z-10 w-full max-w-md glass border border-white/[0.08] p-8 rounded-3xl shadow-2xl space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-3xl shadow-lg shadow-[#6c63ff]/20 mb-4 animate-pulse">
              🔒
            </div>
            <CardTitle className="text-2xl font-black tracking-tight bg-gradient-to-r from-white via-white to-white/70 bg-clip-text text-transparent">Bridge Panel Login</CardTitle>
            <CardDescription className="text-xs text-white/40 mt-1">Please authenticate to manage Discord/WhatsApp sessions</CardDescription>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">Username</label>
              <Input
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
              <Input
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

            <Button
              type="submit"
              disabled={loginLoading}
              className="w-full py-6 bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] hover:opacity-90 disabled:opacity-50 text-sm font-semibold rounded-xl text-white transition-all shadow-lg shadow-[#6c63ff]/15"
            >
              {loginLoading ? 'Authenticating...' : 'Sign In'}
            </Button>
          </form>

          <div className="text-center pt-2">
            <Button
              onClick={() => {
                setSection('google');
                window.history.pushState(null, '', '/google');
              }}
              variant="link"
              className="text-xs text-[#00d4aa] hover:underline p-0 h-auto font-normal"
            >
              🌍 View public Google Clone instead
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (section === 'google') {
    return (
      <React.Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-[#070b14] text-white/50">Loading Google Clone...</div>}>
        <GoogleClonePanel isStandalone={true} />
      </React.Suspense>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#070b14] text-sm">
      {/* Ambient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-[#6c63ff]/10 blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-[#00d4aa]/10 blur-[120px]" />
      </div>

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Header */}
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
              <Badge variant="outline" className={`flex items-center gap-1.5 px-2 md:px-3 py-1 md:py-1.5 rounded-full border text-[10px] md:text-xs font-mono font-normal ${
                cd.urgent ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-white/[0.04] border-white/10 text-white/60'
              }`}>
                <span className="hidden sm:inline">⏱</span> {cd.display}
              </Badge>

              {/* Theme toggle button */}
              <Button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} 
                variant="outline"
                className="p-1.5 md:px-3 md:py-1.5 h-auto rounded-full bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 text-[10px] md:text-xs transition-colors flex items-center gap-1.5 font-medium"
                title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              >
                <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
                <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
              </Button>

              <Button onClick={refresh} variant="outline" className="p-1.5 md:px-3 md:py-1.5 h-auto rounded-full bg-white/[0.04] border border-white/10 text-white/40 hover:text-white/70 text-[10px] md:text-xs transition-colors font-normal">
                <span className="hidden md:inline">🔄 Refresh</span>
                <span className="md:hidden">🔄</span>
              </Button>

              {isAuthenticated && (
                <Button onClick={handleLogout} variant="outline" className="p-1.5 md:px-3 md:py-1.5 h-auto rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:text-red-300 text-[10px] md:text-xs transition-colors font-semibold">
                  <span className="hidden md:inline">🚪 Sign Out</span>
                  <span className="md:hidden">🚪</span>
                </Button>
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
          <nav className="w-60 flex-shrink-0 glass border-r border-white/[0.07] p-4 space-y-5 hidden md:block overflow-y-auto scrollbar-thin">
            {/* Sidebar Search */}
            <div className="relative px-1">
              <span className="absolute inset-y-0 left-4 flex items-center text-white/30 text-xs">🔍</span>
              <Input
                type="text"
                placeholder="Search tools..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#6c63ff]/40 rounded-xl pl-8 pr-7 py-2 text-xs text-white placeholder-white/35 focus:outline-none transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute inset-y-0 right-3 flex items-center text-white/40 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="space-y-4">
              {filteredCategories.map(category => (
                <div key={category.title} className="space-y-1.5">
                  <h3 className="text-[10px] font-black uppercase tracking-wider text-white/25 px-2 flex items-center gap-1.5">
                    <span>{category.icon}</span>
                    {category.title}
                  </h3>
                  <div className="space-y-0.5">
                    {category.items.map(n => (
                      <Button
                        key={n.id}
                        onClick={() => handleNavClick(n.id)}
                        variant="ghost"
                        className={`w-full flex items-center justify-start gap-2.5 px-3 py-2 h-auto rounded-xl text-xs font-semibold transition-all duration-200 ${
                          section === n.id
                            ? 'bg-gradient-to-r from-[#6c63ff]/20 to-[#00d4aa]/10 text-white border border-[#6c63ff]/30 shadow-lg shadow-[#6c63ff]/5 hover:bg-[#6c63ff]/25 hover:text-white'
                            : 'text-white/50 hover:text-white hover:bg-white/[0.04]'
                        }`}
                      >
                        <span className="text-sm">{n.icon}</span>
                        <span className="truncate">{n.label}</span>
                        {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                          <Badge variant="outline" className="ml-auto text-[10px] bg-teal-500/20 text-teal-400 font-bold rounded-full px-1.5 py-0.5 border-teal-500/25">
                            {Object.keys(data.tools).length}
                          </Badge>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredCategories.length === 0 && (
                <p className="text-[11px] text-white/30 text-center py-4">No tools found</p>
              )}
            </div>

            <div className="pt-4 border-t border-white/[0.06] mt-4">
              {data?.sessionStartedAt && (
                <div className="px-3 py-2 bg-white/[0.02] border border-white/[0.04] rounded-xl space-y-0.5">
                  <p className="text-[9px] uppercase font-bold tracking-wider text-white/30">Session Started</p>
                  <p className="text-xs font-mono text-white/60">
                    {new Date(data.sessionStartedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
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
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-white text-sm">Navigation</h3>
                  <button onClick={() => setIsMenuOpen(false)} className="text-white/40 text-xl">✕</button>
                </div>

                {/* Mobile Search */}
                <div className="relative mb-5">
                  <span className="absolute inset-y-0 left-3 flex items-center text-white/30 text-xs">🔍</span>
                  <Input
                    type="text"
                    placeholder="Search tools..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#6c63ff]/40 rounded-xl pl-8 pr-7 py-2 text-xs text-white placeholder-white/35 focus:outline-none transition-all"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute inset-y-0 right-3 flex items-center text-white/40 hover:text-white text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto space-y-5 pr-1 scrollbar-thin">
                  {filteredCategories.map(category => (
                    <div key={category.title} className="space-y-1.5">
                      <h4 className="text-[10px] font-black uppercase tracking-wider text-white/35 px-2 flex items-center gap-1.5">
                        <span>{category.icon}</span>
                        {category.title}
                      </h4>
                      <div className="space-y-0.5">
                        {category.items.map(n => (
                          <Button
                            key={n.id}
                            onClick={() => handleNavClick(n.id)}
                            variant="ghost"
                            className={`w-full flex items-center justify-start gap-3 px-3 py-2.5 h-auto rounded-xl text-sm font-medium transition-all ${
                              section === n.id
                                ? 'bg-gradient-to-r from-[#6c63ff]/20 to-[#00d4aa]/10 text-white border border-[#6c63ff]/30 hover:bg-[#6c63ff]/25 hover:text-white'
                                : 'text-white/45 hover:text-white hover:bg-white/[0.05]'
                            }`}
                          >
                            <span className="text-base">{n.icon}</span>
                            <span className="truncate">{n.label}</span>
                            {n.id === 'urls' && data?.tools && Object.keys(data.tools).length > 0 && (
                              <Badge variant="outline" className="ml-auto text-xs bg-teal-500/20 text-teal-400 rounded-full px-2 py-0.5 border-teal-500/25">
                                {Object.keys(data.tools).length}
                              </Badge>
                            )}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {filteredCategories.length === 0 && (
                    <p className="text-xs text-white/30 text-center py-4">No tools found</p>
                  )}
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
            <div className=" mx-auto">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center text-xl shadow-inner">
                    {NAV.find(n => n.id === section)?.icon}
                  </span>
                  {NAV.find(n => n.id === section)?.label}
                </h2>
              </div>

              <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                <React.Suspense fallback={<div className="flex items-center justify-center p-12 text-white/50">Loading panel...</div>}>
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
                  {section === 'go-containers' && <BetaGoContainerPanel />}
                </React.Suspense>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
