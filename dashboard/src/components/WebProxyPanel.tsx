import React, { useState, useRef, useEffect } from 'react';
import { 
  Globe, Search, ArrowLeft, RefreshCw, X, ArrowRight, ExternalLink, 
  BookOpen, Github, MessageSquare, Compass, ShieldCheck 
} from 'lucide-react';

interface BookMark {
  name: string;
  url: string;
  icon: React.ReactNode;
  color: string;
}

export default function WebProxyPanel() {
  const [urlInput, setUrlInput] = useState('');
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const bookmarks: BookMark[] = [
    { 
      name: 'Google', 
      url: 'https://www.google.com', 
      icon: <Globe className="w-5 h-5" />, 
      color: 'from-blue-500 to-indigo-500' 
    },
    { 
      name: 'Wikipedia', 
      url: 'https://www.wikipedia.org', 
      icon: <BookOpen className="w-5 h-5" />, 
      color: 'from-gray-500 to-slate-700' 
    },
    { 
      name: 'GitHub', 
      url: 'https://github.com', 
      icon: <Github className="w-5 h-5" />, 
      color: 'from-purple-600 to-indigo-800' 
    },
    { 
      name: 'Reddit', 
      url: 'https://www.reddit.com', 
      icon: <MessageSquare className="w-5 h-5" />, 
      color: 'from-orange-500 to-red-600' 
    },
    { 
      name: 'DuckDuckGo', 
      url: 'https://duckduckgo.com', 
      icon: <Compass className="w-5 h-5" />, 
      color: 'from-yellow-500 to-amber-600' 
    }
  ];

  const handleGo = (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    let formattedUrl = targetUrl.trim();
    if (!/^https?:\/\//i.test(formattedUrl)) {
      if (formattedUrl.includes('.') && !formattedUrl.includes(' ')) {
        formattedUrl = 'https://' + formattedUrl;
      } else {
        formattedUrl = 'https://www.google.com/search?q=' + encodeURIComponent(formattedUrl);
      }
    }
    setLoading(true);
    setActiveUrl(formattedUrl);
    setUrlInput(formattedUrl);
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleGo(urlInput);
  };

  const handleIframeLoad = () => {
    setLoading(false);
    if (iframeRef.current && iframeRef.current.contentWindow) {
      try {
        const currentLoc = iframeRef.current.contentWindow.location;
        const searchParams = new URLSearchParams(currentLoc.search);
        const decodedUrl = searchParams.get('url');
        if (decodedUrl) {
          setUrlInput(decodedUrl);
        }
      } catch (e) {
        console.warn('CORS or sandbox prevents reading iframe location:', e);
      }
    }
  };

  const handleRefresh = () => {
    if (iframeRef.current) {
      setLoading(true);
      // Reload the iframe
      const currentSrc = iframeRef.current.src;
      iframeRef.current.src = '';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentSrc;
        }
      }, 50);
    }
  };

  const handleHome = () => {
    setActiveUrl(null);
    setUrlInput('');
    setLoading(false);
  };

  const getProxyUrl = (target: string) => {
    return `/api/web-proxy?url=${encodeURIComponent(target)}`;
  };

  return (
    <div className="glass rounded-3xl overflow-hidden border border-white/[0.08] flex flex-col h-[78vh] transition-all duration-300">
      {/* Browser Address Bar / Header */}
      <div className="bg-[#0b0e17] border-b border-white/[0.06] px-4 py-3 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {activeUrl && (
            <button 
              onClick={handleHome}
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] text-white/70 hover:text-white transition-colors"
              title="Home"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <button 
            onClick={handleRefresh}
            disabled={!activeUrl}
            className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] text-white/70 hover:text-white disabled:opacity-30 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="flex-1">
          <div className="flex items-center bg-[#161a26] border border-white/[0.08] rounded-xl px-3 py-1.5 focus-within:border-[#6c63ff]/40 focus-within:ring-1 focus-within:ring-[#6c63ff]/20 transition-all">
            <Search className="w-4 h-4 text-white/30 mr-2 flex-shrink-0" />
            <input 
              type="text" 
              className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder-white/20 p-0 focus:ring-0"
              placeholder="Enter URL (e.g. google.com) or search term..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            {urlInput && (
              <button 
                type="button" 
                onClick={() => setUrlInput('')}
                className="p-0.5 rounded-full hover:bg-white/10 text-white/40 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </form>

        {activeUrl && (
          <a 
            href={getProxyUrl(activeUrl)} 
            target="_blank" 
            rel="noopener noreferrer"
            className="p-2 rounded-xl bg-[#6c63ff]/10 hover:bg-[#6c63ff]/20 border border-[#6c63ff]/20 text-[#00d4aa] transition-colors text-xs flex items-center gap-1.5 font-semibold"
            title="Open Raw Proxy Tab"
          >
            <span className="hidden sm:inline">Raw View</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 bg-[#07090f] relative overflow-hidden flex flex-col justify-center items-center">
        {!activeUrl ? (
          /* Landing page */
          <div className="max-w-xl w-full px-6 py-12 flex flex-col items-center text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-[#6c63ff] to-[#00d4aa] flex items-center justify-center text-4xl shadow-xl shadow-[#6c63ff]/15 relative">
              🌐
              <div className="absolute -bottom-1.5 -right-1.5 bg-[#00d4aa] text-[#07090f] rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider flex items-center gap-0.5 border border-[#07090f]">
                <ShieldCheck className="w-2.5 h-2.5" /> SECURE
              </div>
            </div>

            <div>
              <h3 className="text-2xl font-black bg-gradient-to-r from-white via-white to-white/70 bg-clip-text text-transparent tracking-tight">Virtual Browser Proxy</h3>
              <p className="text-xs text-white/40 mt-2 leading-relaxed">
                Anonymous and secure web proxy running directly through your system's runner.
                Browse websites privately without leaving the dashboard panel.
              </p>
            </div>

            {/* Quick Bookmarks */}
            <div className="w-full space-y-3">
              <p className="text-[10px] uppercase font-bold tracking-wider text-white/30 text-left px-1">Suggested Sites</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {bookmarks.map((bm) => (
                  <button
                    key={bm.name}
                    onClick={() => handleGo(bm.url)}
                    className="flex flex-col items-center justify-center p-3 rounded-2xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.06] hover:border-white/10 text-white/60 hover:text-white transition-all group"
                  >
                    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${bm.color} flex items-center justify-center text-white mb-2 shadow group-hover:scale-105 transition-transform`}>
                      {bm.icon}
                    </div>
                    <span className="text-[10px] font-medium">{bm.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Search Instructions */}
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.04] text-[10px] text-white/30 text-left space-y-1 w-full leading-normal">
              <p className="font-semibold text-white/50 text-[11px] mb-1.5">💡 Pro Tips:</p>
              <p>• Type any standard domain like <code className="text-[#00d4aa] font-mono">wikipedia.org</code> and press Enter to visit.</p>
              <p>• Enter regular keywords to perform a secure search automatically via Google.</p>
              <p>• Click the <code className="text-[#00d4aa] font-mono">Raw View</code> button inside active browser sessions to open the proxy in its own standalone tab.</p>
            </div>
          </div>
        ) : (
          /* Active Browser Iframe */
          <div className="w-full h-full flex flex-col relative">
            {loading && (
              <div className="absolute inset-0 bg-[#07090f]/75 backdrop-blur-sm z-10 flex flex-col items-center justify-center gap-3">
                <div className="w-10 h-10 rounded-full border-2 border-[#6c63ff] border-t-transparent animate-spin" />
                <p className="text-xs text-white/40 tracking-wider font-mono animate-pulse">LOADING VIRTUAL FRAME...</p>
              </div>
            )}
            <iframe 
              ref={iframeRef}
              src={getProxyUrl(activeUrl)} 
              className="w-full h-full border-none bg-white"
              onLoad={handleIframeLoad}
              title="Virtual Proxy Browser Frame"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        )}
      </div>
    </div>
  );
}
