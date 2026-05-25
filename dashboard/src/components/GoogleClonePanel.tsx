import React, { useState, useRef, useEffect } from 'react';
import { api, BrowserSearchResult } from '../api';
import {
  Search, Mic, Camera, Globe, MapPin, Video, Newspaper, ShoppingBag,
  Clock, CloudSun, Sparkles, BookOpen, Languages, ChevronDown, ChevronUp,
  ExternalLink, Image, Play, Star, Info, Moon, Sun, ArrowLeft, RefreshCw, X
} from 'lucide-react';

type SearchTab = 'all' | 'images' | 'videos' | 'news' | 'shopping' | 'maps';

interface GoogleClonePanelProps {
  isStandalone?: boolean;
}

export default function GoogleClonePanel({ isStandalone = false }: GoogleClonePanelProps) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BrowserSearchResult | null>(null);
  const [isSearched, setIsSearched] = useState(false);
  const [activeTab, setActiveTab] = useState<SearchTab>('all');
  const [includeAI, setIncludeAI] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [openPaaIndex, setOpenPaaIndex] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ alt: string; sourceUrl: string; imageUrl?: string } | null>(null);

  // Sync initial query if there's a URL hash or query param (for direct link feature)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) {
      setQuery(q);
      executeSearch(q, 1);
    }
  }, []);

  const executeSearch = async (searchQuery: string, targetPage: number) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError('');
    setIsSearched(true);
    setActiveQuery(searchQuery);

    try {
      const res = await api.browserSearch(searchQuery, targetPage, 'auto', includeAI);
      setResult(res);
      setPage(targetPage);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch search results from CDP Browser Pool');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(query, 1);
  };

  const handleClear = () => {
    setQuery('');
  };

  const handleReset = () => {
    setIsSearched(false);
    setResult(null);
    setQuery('');
    setActiveQuery('');
    setPage(1);
    setError('');
  };

  const togglePaa = (index: number) => {
    setOpenPaaIndex(openPaaIndex === index ? null : index);
  };

  return (
    <div className={`${isStandalone ? 'min-h-screen w-full' : 'min-h-[85vh] rounded-3xl border'} transition-all duration-300 ${
      darkMode 
        ? `bg-[#0f0f13] text-white ${isStandalone ? '' : 'border-white/[0.08]'}` 
        : `bg-[#f8f9fa] text-gray-900 ${isStandalone ? '' : 'border-gray-200'}`
    }`}>
      {/* Top Header Actions */}
      <div className={`flex justify-between items-center px-6 py-4 border-b ${
        darkMode ? 'border-white/[0.05]' : 'border-gray-200'
      }`}>
        <div className="flex items-center gap-2">
          {isSearched && (
            <button 
              onClick={handleReset}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                darkMode
                  ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-white/70'
                  : 'bg-gray-100 border-gray-300 hover:bg-gray-200 text-gray-700'
              }`}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back Home
            </button>
          )}
          <span className={`text-[10px] tracking-wider uppercase font-mono px-2 py-0.5 rounded ${
            darkMode ? 'bg-[#6c63ff]/10 text-[#6c63ff]' : 'bg-blue-100 text-blue-700'
          }`}>
            Google SGE Clone
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIncludeAI(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
              includeAI
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : darkMode ? 'bg-white/[0.03] border-white/10 text-white/40' : 'bg-gray-100 border-gray-300 text-gray-400'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Overview: {includeAI ? 'ON' : 'OFF'}</span>
          </button>

          <button
            onClick={() => setDarkMode(!darkMode)}
            className={`p-2 rounded-full border transition-all ${
              darkMode 
                ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] text-yellow-400' 
                : 'bg-white border-gray-300 hover:bg-gray-100 text-slate-700 shadow-sm'
            }`}
            title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main Home Screen */}
      {!isSearched ? (
        <div className="flex flex-col items-center justify-center py-20 px-4 md:py-32">
          {/* Multicolor Logo */}
          <div className="text-6xl md:text-8xl font-bold select-none mb-8 tracking-tight font-sans flex items-center justify-center">
            <span className="text-blue-500">G</span>
            <span className="text-red-500">o</span>
            <span className="text-yellow-500">o</span>
            <span className="text-blue-500">g</span>
            <span className="text-green-500">l</span>
            <span className="text-red-500">e</span>
            <span className="text-xs ml-1 px-1.5 py-0.5 rounded font-mono font-bold bg-[#6c63ff]/20 text-[#6c63ff] self-end mb-2 shadow">
              Clone
            </span>
          </div>

          {/* Search Box */}
          <form onSubmit={handleSearchSubmit} className="w-full max-w-2xl px-2">
            <div className={`flex items-center rounded-full border px-4 py-3.5 md:px-5 md:py-4 transition-all duration-300 ${
              darkMode 
                ? 'bg-[#1b1b22] border-white/10 focus-within:bg-[#202029] focus-within:border-white/20 focus-within:shadow-lg focus-within:shadow-black/40' 
                : 'bg-white border-gray-200 focus-within:bg-white focus-within:border-blue-400 focus-within:shadow-lg focus-within:shadow-gray-200'
            }`}>
              <Search className={`w-5 h-5 mr-3 flex-shrink-0 ${darkMode ? 'text-white/30' : 'text-gray-400'}`} />
              <input
                type="text"
                className="flex-1 bg-transparent border-none outline-none font-sans text-base focus:ring-0 p-0"
                placeholder="Search Google Clone or type URL..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button 
                  type="button" 
                  onClick={handleClear}
                  className={`p-1 rounded-full mr-2 hover:bg-white/10 ${darkMode ? 'text-white/40' : 'text-gray-400'}`}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="flex items-center gap-2 border-l pl-3 ml-1 border-white/10">
                <span title="Search by Voice">
                  <Mic className="w-5 h-5 text-blue-500 cursor-pointer hover:opacity-85" />
                </span>
                <span title="Search by Image (Lens)">
                  <Camera className="w-5 h-5 text-green-500 cursor-pointer hover:opacity-85" />
                </span>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex justify-center gap-3 mt-8">
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all shadow ${
                  darkMode
                    ? 'bg-[#1b1b22] hover:bg-[#23232c] hover:text-white text-white/80 border border-white/5'
                    : 'bg-gray-100 hover:bg-gray-200 hover:text-gray-900 text-gray-800 border border-gray-300/40'
                }`}
              >
                Google Search
              </button>
              <button
                type="button"
                onClick={() => {
                  const items = ['Pakistan historical spots', 'Weather in Tokyo', 'Who is the Prime Minister of Pakistan', 'Local food near Islamabad', 'Gemini AI vs GPT-4'];
                  const random = items[Math.floor(Math.random() * items.length)];
                  setQuery(random);
                  executeSearch(random, 1);
                }}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all shadow ${
                  darkMode
                    ? 'bg-[#1b1b22] hover:bg-[#23232c] hover:text-white text-white/80 border border-white/5'
                    : 'bg-gray-100 hover:bg-gray-200 hover:text-gray-900 text-gray-800 border border-gray-300/40'
                }`}
              >
                I'm Feeling Lucky
              </button>
            </div>
          </form>

          {/* Languages offered */}
          <div className="text-xs text-white/40 mt-10">
            Google offered in: <span className="text-[#6c63ff] hover:underline cursor-pointer">English</span> · <span className="text-[#6c63ff] hover:underline cursor-pointer">Urdu</span> · <span className="text-[#6c63ff] hover:underline cursor-pointer">Pushto</span> · <span className="text-[#6c63ff] hover:underline cursor-pointer">Punjabi</span>
          </div>
        </div>
      ) : (
        /* Results Mode Screen */
        <div className="flex flex-col">
          {/* Top Search Bar & Tabs Wrapper */}
          <div className={`px-4 md:px-8 pt-4 pb-0 border-b shadow-sm sticky top-0 z-20 ${
            darkMode ? 'bg-[#0f0f13]/95 border-white/[0.05] backdrop-blur-md' : 'bg-white/95 border-gray-200 backdrop-blur-md'
          }`}>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4 mb-4">
              {/* Logo */}
              <div 
                onClick={handleReset} 
                className="text-2xl font-bold select-none cursor-pointer tracking-tight flex items-center flex-shrink-0"
              >
                <span className="text-blue-500">G</span>
                <span className="text-red-500">o</span>
                <span className="text-yellow-500">o</span>
                <span className="text-blue-500">g</span>
                <span className="text-green-500">l</span>
                <span className="text-red-500">e</span>
              </div>

              {/* Input Box */}
              <form onSubmit={handleSearchSubmit} className="flex-1 max-w-2xl">
                <div className={`flex items-center rounded-full border px-4 py-2 transition-all ${
                  darkMode 
                    ? 'bg-[#1b1b22] border-white/10 focus-within:bg-[#202029] focus-within:border-white/20' 
                    : 'bg-white border-gray-200 focus-within:border-blue-400 focus-within:shadow-sm'
                }`}>
                  <input
                    type="text"
                    className="flex-1 bg-transparent border-none outline-none font-sans text-sm focus:ring-0 p-0"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button 
                      type="button" 
                      onClick={handleClear}
                      className={`p-1 rounded-full mr-2 hover:bg-white/10 ${darkMode ? 'text-white/40' : 'text-gray-400'}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <div className="flex items-center gap-2 border-l pl-3 ml-1 border-white/10">
                    <Search 
                      className="w-4 h-4 text-blue-500 cursor-pointer hover:opacity-85" 
                      onClick={() => executeSearch(query, 1)} 
                    />
                  </div>
                </div>
              </form>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-4 overflow-x-auto scrollbar-none font-sans text-sm">
              {(['all', 'images', 'videos', 'news', 'shopping', 'maps'] as SearchTab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 pb-3 pt-1 border-b-2 font-medium capitalize transition-all ${
                    activeTab === tab
                      ? (darkMode ? 'border-[#6c63ff] text-white' : 'border-blue-500 text-blue-500')
                      : 'border-transparent text-white/40 hover:text-white/60'
                  }`}
                >
                  {tab === 'all' && <Globe className="w-4 h-4" />}
                  {tab === 'images' && <Image className="w-4 h-4" />}
                  {tab === 'videos' && <Video className="w-4 h-4" />}
                  {tab === 'news' && <Newspaper className="w-4 h-4" />}
                  {tab === 'shopping' && <ShoppingBag className="w-4 h-4" />}
                  {tab === 'maps' && <MapPin className="w-4 h-4" />}
                  <span>{tab === 'maps' ? 'Maps' : tab}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Loading Indicator */}
          {loading && (
            <div className="flex flex-col items-center justify-center p-24 gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
              <p className="text-xs text-white/40 tracking-wider uppercase font-mono animate-pulse">Running live automated browser crawl...</p>
            </div>
          )}

          {/* Error State */}
          {!loading && error && (
            <div className="p-8 max-w-3xl mx-auto">
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-5 rounded-2xl flex flex-col gap-2">
                <span className="font-bold text-sm">Search Failed</span>
                <span className="text-xs leading-relaxed">{error}</span>
                <button 
                  onClick={() => executeSearch(activeQuery, page)}
                  className="mt-3 px-4 py-2 bg-red-500 text-white rounded-lg text-xs font-semibold self-start hover:bg-red-600 transition-colors"
                >
                  Retry Search
                </button>
              </div>
            </div>
          )}

          {/* Results Display */}
          {!loading && result && (
            <div className="px-4 md:px-8 py-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* LEFT COLUMN: Results, Weather, AI, News (Span 8) */}
              <div className="lg:col-span-8 space-y-6">
                
                {/* 1. SGE AI Overview */}
                {activeTab === 'all' && result.aiResponse && (
                  <div className={`p-6 rounded-3xl border shadow-xl relative overflow-hidden transition-all duration-300 ${
                    darkMode 
                      ? 'bg-gradient-to-br from-[#0c0f1d] via-[#101426] to-[#0f0e21] border-indigo-500/25' 
                      : 'bg-gradient-to-br from-indigo-50/50 via-slate-50 to-indigo-50/20 border-indigo-200'
                  }`}>
                    {/* Decorative glows */}
                    <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-indigo-500/10 blur-[60px] pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-32 h-32 rounded-full bg-[#00d4aa]/5 blur-[60px] pointer-events-none" />

                    <div className="flex items-center gap-2 mb-4 relative z-10">
                      <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse" />
                      <h4 className="font-bold text-base bg-gradient-to-r from-indigo-400 to-[#00d4aa] bg-clip-text text-transparent">AI Overview</h4>
                    </div>

                    <div 
                      className={`ai-overview-text leading-relaxed text-sm prose max-w-none relative z-10 ${
                        darkMode ? 'text-white/80' : 'text-slate-700'
                      }`}
                      dangerouslySetInnerHTML={{ __html: result.aiResponse }}
                    />
                  </div>
                )}

                {/* 2. Direct Answer widget */}
                {activeTab === 'all' && result.directAnswer && (
                  <div className={`p-6 rounded-2xl border shadow-md transition-all ${
                    darkMode 
                      ? 'bg-[#1b1b22] border-white/[0.06]' 
                      : 'bg-white border-gray-200'
                  }`}>
                    <div className="flex items-center gap-2 text-xs text-white/40 mb-3 uppercase tracking-wider font-mono">
                      {result.directAnswer.type === 'weather' ? <CloudSun className="w-4 h-4 text-yellow-400" /> : <Clock className="w-4 h-4 text-blue-400" />}
                      <span>Direct Answer: {result.directAnswer.type}</span>
                    </div>

                    {result.directAnswer.type === 'weather' ? (
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                        <div>
                          <div className="text-4xl font-bold font-sans tracking-tight">{result.directAnswer.answer}</div>
                          <div className="text-sm font-semibold mt-1">{result.directAnswer.details?.split(' - ')[1] || 'Current Weather'}</div>
                        </div>
                        <div className="text-right sm:text-left text-xs text-white/50 leading-relaxed border-t sm:border-t-0 sm:border-l pt-3 sm:pt-0 sm:pl-4 border-white/10">
                          {result.directAnswer.details || ''}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-4xl font-bold font-mono tracking-tight text-blue-400">{result.directAnswer.answer}</div>
                        {result.directAnswer.details && (
                          <div className="text-sm text-white/60 mt-1">{result.directAnswer.details}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Featured Snippet card */}
                {activeTab === 'all' && result.featuredSnippet && (
                  <div className={`p-6 rounded-2xl border shadow-sm transition-all ${
                    darkMode 
                      ? 'bg-[#1b1b22] border-white/[0.06]' 
                      : 'bg-white border-gray-200'
                  }`}>
                    <div className="flex items-center gap-1.5 text-xs text-white/40 mb-3 uppercase tracking-wider font-mono">
                      <BookOpen className="w-4 h-4 text-indigo-400" />
                      <span>Featured Snippet</span>
                    </div>
                    <p className={`text-base md:text-lg leading-relaxed mb-4 font-serif ${
                      darkMode ? 'text-white/90' : 'text-slate-800'
                    }`}>
                      "{result.featuredSnippet.snippet}"
                    </p>
                    <a 
                      href={result.featuredSnippet.link} 
                      target="_blank" 
                      rel="noreferrer"
                      className="group block border-t pt-3 border-white/5"
                    >
                      <div className="text-xs text-blue-400 font-semibold group-hover:underline truncate">{result.featuredSnippet.title}</div>
                      <div className="text-[10px] text-white/30 truncate mt-0.5">{result.featuredSnippet.link}</div>
                    </a>
                  </div>
                )}

                {/* Tab Filtering & Organic Results rendering */}
                
                {/* 4A. TAB = ALL: Render organic results + PAA + carousels */}
                {activeTab === 'all' && (
                  <div className="space-y-6">
                    {/* Organic List */}
                    <div className="space-y-4">
                      {result.organic.length === 0 ? (
                        <div className="text-center py-12 text-white/30 text-sm">No organic web links found for this query.</div>
                      ) : (
                        result.organic.map((item, idx) => (
                          <div key={idx} className="group">
                            {/* Header / Breadcrumbs */}
                            <div className="flex items-center gap-2 mb-1 text-xs text-white/40 truncate">
                              {item.favicon && (
                                <img 
                                  src={item.favicon} 
                                  alt="Favicon" 
                                  className="w-4 h-4 rounded-full flex-shrink-0"
                                  onError={(e) => (e.currentTarget.style.display = 'none')}
                                />
                              )}
                              <span className="text-white/60 truncate font-sans">{item.displayedLink || item.link}</span>
                            </div>
                            
                            {/* Link Title */}
                            <a 
                              href={item.link} 
                              target="_blank" 
                              rel="noreferrer" 
                              className="text-lg md:text-xl font-sans text-blue-400 group-hover:underline block leading-tight mb-1"
                            >
                              {item.title}
                            </a>

                            {/* Snippet */}
                            <p className={`text-sm leading-relaxed ${darkMode ? 'text-white/65' : 'text-slate-700'}`}>
                              {item.snippet}
                            </p>
                          </div>
                        ))
                      )}
                    </div>

                    {/* People Also Ask (PAA) section */}
                    {result.peopleAlsoAsk && result.peopleAlsoAsk.length > 0 && (
                      <div className={`border rounded-2xl overflow-hidden transition-all ${
                        darkMode ? 'border-white/10 bg-white/[0.01]' : 'border-gray-200 bg-gray-50/50'
                      }`}>
                        <div className={`px-5 py-4 border-b font-bold text-sm ${darkMode ? 'border-white/10' : 'border-gray-200'}`}>
                          People also ask
                        </div>
                        <div className="divide-y divide-white/5">
                          {result.peopleAlsoAsk.map((paa, idx) => (
                            <div key={idx} className="transition-all">
                              <button
                                onClick={() => togglePaa(idx)}
                                className="w-full flex justify-between items-center px-5 py-3.5 text-left text-sm font-semibold hover:bg-white/[0.02]"
                              >
                                <span>{paa.question}</span>
                                <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${openPaaIndex === idx ? 'rotate-180 text-blue-400' : ''}`} />
                              </button>
                              {openPaaIndex === idx && (
                                <div className={`px-5 pb-5 pt-1 text-xs leading-relaxed ${darkMode ? 'text-white/60' : 'text-slate-600'}`}>
                                  {paa.answer ? (
                                    <div className="space-y-3">
                                      <p className="font-serif">"{paa.answer}"</p>
                                      {paa.sourceUrl && (
                                        <a 
                                          href={paa.sourceUrl} 
                                          target="_blank" 
                                          rel="noreferrer"
                                          className="inline-flex items-center gap-1 text-blue-400 font-semibold hover:underline"
                                        >
                                          <span>{paa.sourceTitle || 'Learn more'}</span>
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="italic">No inline answer extracted, check links below.</span>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 4B. TAB = IMAGES: Render gorgeous image card gallery */}
                {activeTab === 'images' && (
                  <div className="space-y-6">
                    <h4 className="font-bold text-sm uppercase tracking-wider text-white/40 mb-3">Google Images Results</h4>
                    {!result.images || result.images.length === 0 ? (
                      <div className="text-center py-16 text-white/30 text-sm">No images crawled for this query.</div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {result.images.map((img, idx) => (
                          <div 
                            key={idx} 
                            onClick={() => setSelectedImage(img)}
                            className={`group rounded-2xl overflow-hidden border cursor-pointer transition-all hover:scale-[1.02] shadow-sm hover:shadow-md ${
                              darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                            }`}
                          >
                            <div className="relative aspect-video bg-black/40 overflow-hidden flex items-center justify-center">
                              {img.imageUrl ? (
                                <img 
                                  src={img.imageUrl} 
                                  alt={img.alt || 'Crawled result'} 
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                  onError={(e) => (e.currentTarget.src = 'https://placehold.co/600x400/png?text=Preview+Unavailable')}
                                />
                              ) : (
                                <span className="text-white/20 text-xs">No image data</span>
                              )}
                            </div>
                            <div className="p-3">
                              <p className="text-xs font-semibold truncate leading-tight group-hover:text-blue-400 transition-colors">
                                {img.alt || 'Untitled Image'}
                              </p>
                              <p className="text-[10px] text-white/30 truncate mt-1">{img.sourceUrl}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 4C. TAB = VIDEOS: Render structured video list */}
                {activeTab === 'videos' && (
                  <div className="space-y-4">
                    <h4 className="font-bold text-sm uppercase tracking-wider text-white/40 mb-3">Google Video Results</h4>
                    {!result.videos || result.videos.length === 0 ? (
                      <div className="text-center py-16 text-white/30 text-sm">No videos found for this query.</div>
                    ) : (
                      result.videos.map((vid, idx) => (
                        <div 
                          key={idx} 
                          className={`p-4 rounded-2xl border flex flex-col sm:flex-row gap-4 transition-all shadow-sm ${
                            darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                          }`}
                        >
                          {/* Left: Thumbnail Simulation */}
                          <a 
                            href={vid.link} 
                            target="_blank" 
                            rel="noreferrer"
                            className="w-full sm:w-48 aspect-video bg-black/40 rounded-xl flex items-center justify-center relative overflow-hidden group flex-shrink-0"
                          >
                            <div className="absolute inset-0 bg-[#6c63ff]/10 group-hover:bg-[#6c63ff]/20 transition-colors" />
                            <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
                              <Play className="w-5 h-5 fill-current ml-0.5" />
                            </div>
                            {vid.duration && (
                              <span className="absolute bottom-2 right-2 text-[10px] font-mono font-bold bg-black/75 px-1.5 py-0.5 rounded text-white">
                                {vid.duration}
                              </span>
                            )}
                          </a>

                          {/* Right: Info */}
                          <div className="flex-1 flex flex-col justify-between">
                            <div>
                              <div className="flex items-center gap-2 text-[10px] text-white/40 mb-1">
                                <span className="font-semibold uppercase tracking-wider text-blue-400">{vid.source}</span>
                                {vid.uploadedAt && <span>· {vid.uploadedAt}</span>}
                              </div>
                              <a 
                                href={vid.link} 
                                target="_blank" 
                                rel="noreferrer"
                                className="text-base font-bold text-white hover:text-blue-400 transition-colors group-hover:underline block leading-tight mb-2"
                              >
                                {vid.title}
                              </a>
                            </div>

                            <a 
                              href={vid.link} 
                              target="_blank" 
                              rel="noreferrer"
                              className="text-xs text-white/30 truncate block hover:underline"
                            >
                              {vid.link}
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* 4D. TAB = NEWS: Top news articles */}
                {activeTab === 'news' && (
                  <div className="space-y-4">
                    <h4 className="font-bold text-sm uppercase tracking-wider text-white/40 mb-3">Top News Stories</h4>
                    {!result.news || result.news.length === 0 ? (
                      <div className="text-center py-16 text-white/30 text-sm">No recent news reports found for this query.</div>
                    ) : (
                      result.news.map((item, idx) => (
                        <div 
                          key={idx}
                          className={`p-5 rounded-2xl border transition-all hover:border-white/10 ${
                            darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2 text-[10px] text-white/40 font-mono">
                            <span className="font-bold text-[#6c63ff] uppercase">{item.source}</span>
                            <span>·</span>
                            <span>{item.time}</span>
                          </div>
                          <a 
                            href={item.link} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-base font-bold text-white hover:text-blue-400 hover:underline block leading-snug mb-2"
                          >
                            {item.title}
                          </a>
                          <a 
                            href={item.link} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-[10px] text-white/20 truncate block"
                          >
                            {item.link}
                          </a>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* 4E. TAB = SHOPPING: Products catalog */}
                {activeTab === 'shopping' && (
                  <div className="space-y-4">
                    <h4 className="font-bold text-sm uppercase tracking-wider text-white/40 mb-3">Google Shopping Results</h4>
                    {!result.shopping || result.shopping.length === 0 ? (
                      <div className="text-center py-16 text-white/30 text-sm">No matching shopping products found.</div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {result.shopping.map((prod, idx) => (
                          <div 
                            key={idx}
                            className={`p-5 rounded-2xl border transition-all flex flex-col justify-between gap-4 ${
                              darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                            }`}
                          >
                            <div>
                              <div className="text-2xl font-black text-emerald-400 font-mono mb-2">{prod.price}</div>
                              <h5 className="text-sm font-bold text-white leading-snug mb-1">{prod.title}</h5>
                              <div className="text-xs text-white/40 font-semibold">{prod.merchant}</div>
                            </div>
                            <a 
                              href={prod.link} 
                              target="_blank" 
                              rel="noreferrer"
                              className="w-full text-center py-2.5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white font-semibold text-xs transition-colors block"
                            >
                              View Product
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 4F. TAB = MAPS: Place listings */}
                {activeTab === 'maps' && (
                  <div className="space-y-4">
                    <h4 className="font-bold text-sm uppercase tracking-wider text-white/40 mb-3">Maps & Local Results</h4>
                    {!result.localResults || result.localResults.length === 0 ? (
                      <div className="text-center py-16 text-white/30 text-sm">No map places extracted. Try using "Maps Places" tab instead for structured batches.</div>
                    ) : (
                      result.localResults.map((place, idx) => (
                        <div 
                          key={idx}
                          className={`p-5 rounded-2xl border flex gap-4 transition-all ${
                            darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                          }`}
                        >
                          <div className="w-10 h-10 rounded-full bg-[#00d4aa]/10 text-[#00d4aa] border border-[#00d4aa]/20 flex items-center justify-center text-base flex-shrink-0">
                            📍
                          </div>
                          <div className="flex-1">
                            <h5 className="text-base font-bold text-white mb-1">{place.title}</h5>
                            <div className="flex items-center gap-1.5 text-xs text-white/50 mb-2">
                              {place.rating && (
                                <div className="flex items-center gap-0.5 text-yellow-400 font-bold">
                                  <Star className="w-3.5 h-3.5 fill-current" />
                                  <span>{place.rating}</span>
                                </div>
                              )}
                              {place.reviewsCount && <span>({place.reviewsCount} reviews)</span>}
                            </div>
                            {place.address && <p className="text-xs text-white/60 mb-1">🏠 {place.address}</p>}
                            {place.phone && <p className="text-xs text-white/60 mb-3">📞 {place.phone}</p>}
                            {place.link && (
                              <a 
                                href={place.link} 
                                target="_blank" 
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-400 font-bold hover:underline"
                              >
                                <span>Get Directions</span>
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* 5. Related Queries (Clickable to perform new search) */}
                {result.relatedSearches && result.relatedSearches.length > 0 && (
                  <div className="pt-6 border-t border-white/[0.06] space-y-3">
                    <h5 className="font-bold text-xs uppercase tracking-wider text-white/30">Related Searches</h5>
                    <div className="flex flex-wrap gap-2">
                      {result.relatedSearches.map((term, idx) => (
                        <button
                          key={idx}
                          onClick={() => {
                            setQuery(term);
                            executeSearch(term, 1);
                          }}
                          className={`px-4 py-2 rounded-full text-xs font-semibold border transition-all ${
                            darkMode
                              ? 'bg-white/[0.03] border-white/10 text-white/60 hover:bg-white/[0.08] hover:text-white'
                              : 'bg-gray-100 border-gray-300 text-slate-700 hover:bg-gray-200 hover:text-black shadow-sm'
                          }`}
                        >
                          🔍 {term}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Page Pagination buttons */}
                <div className="flex justify-center gap-3 pt-8">
                  <button
                    disabled={page <= 1}
                    onClick={() => executeSearch(activeQuery, page - 1)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                      darkMode
                        ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08] disabled:opacity-30'
                        : 'bg-white border-gray-300 hover:bg-gray-100 disabled:opacity-30 shadow-sm text-slate-800'
                    }`}
                  >
                    Prev Page
                  </button>
                  <div className="px-4 py-2 flex items-center justify-center text-xs font-mono font-bold text-white/40">
                    Page {page}
                  </div>
                  <button
                    onClick={() => executeSearch(activeQuery, page + 1)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                      darkMode
                        ? 'bg-white/[0.04] border-white/10 hover:bg-white/[0.08]'
                        : 'bg-white border-gray-300 hover:bg-gray-100 shadow-sm text-slate-800'
                    }`}
                  >
                    Next Page
                  </button>
                </div>

              </div>

              {/* RIGHT COLUMN: Sidebar (Span 4) */}
              <div className="lg:col-span-4 space-y-6">
                
                {/* A. Knowledge Panel Card */}
                {result.knowledgePanel ? (
                  <div className={`rounded-2xl border shadow-md overflow-hidden transition-all ${
                    darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200'
                  }`}>
                    {/* Header Banner simulation */}
                    <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/10 p-5 border-b border-white/5">
                      <div className="text-[10px] uppercase font-bold text-indigo-400 mb-1 tracking-wider">Knowledge Graph Info</div>
                      <h3 className="text-xl font-extrabold text-white tracking-tight">{result.knowledgePanel.title}</h3>
                      {result.knowledgePanel.subtitle && (
                        <p className="text-xs text-white/50 mt-0.5 leading-snug">{result.knowledgePanel.subtitle}</p>
                      )}
                    </div>

                    <div className="p-5 space-y-4">
                      {result.knowledgePanel.description && (
                        <div className="space-y-3">
                          <p className={`text-xs leading-relaxed ${darkMode ? 'text-white/70' : 'text-slate-600'}`}>
                            {result.knowledgePanel.description}
                          </p>
                          {result.knowledgePanel.sourceUrl && (
                            <a 
                              href={result.knowledgePanel.sourceUrl} 
                              target="_blank" 
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-blue-400 font-bold hover:underline"
                            >
                              <span>Read full topic source</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      )}

                      {/* Fact attributes list */}
                      {result.knowledgePanel.attributes && result.knowledgePanel.attributes.length > 0 && (
                        <div className="border-t border-white/5 pt-4 space-y-3">
                          {result.knowledgePanel.attributes.map((attr, idx) => (
                            <div key={idx} className="flex flex-col gap-0.5 text-xs">
                              <span className="font-bold text-white/40 uppercase tracking-wide text-[9px]">{attr.label}</span>
                              <span className="font-semibold text-white/80 leading-relaxed">{attr.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={`p-5 rounded-2xl border text-center text-xs text-white/30 transition-all ${
                    darkMode ? 'bg-[#1b1b22]/50 border-white/[0.04]' : 'bg-gray-50 border-gray-200'
                  }`}>
                    No direct sidebar knowledge graph exists for this exact search. Try querying a topic like a country, celebrity, or weather location.
                  </div>
                )}

                {/* B. Shopping Products Preview in sidebar */}
                {result.shopping && result.shopping.length > 0 && activeTab !== 'shopping' && (
                  <div className={`p-5 rounded-2xl border space-y-4 transition-all ${
                    darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'
                  }`}>
                    <h5 className="font-extrabold text-xs uppercase text-white/40 tracking-wider">Related Products</h5>
                    <div className="divide-y divide-white/5 space-y-3">
                      {result.shopping.slice(0, 3).map((prod, idx) => (
                        <div key={idx} className="pt-3 first:pt-0 flex flex-col gap-1">
                          <span className="text-sm font-black text-emerald-400">{prod.price}</span>
                          <a href={prod.link} target="_blank" rel="noreferrer" className="text-xs font-semibold text-white hover:text-blue-400 leading-snug hover:underline block">
                            {prod.title}
                          </a>
                          <span className="text-[10px] text-white/30 font-semibold">{prod.merchant}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* C. Local places / Map listings preview in sidebar */}
                {result.localResults && result.localResults.length > 0 && activeTab !== 'maps' && (
                  <div className={`p-5 rounded-2xl border space-y-4 transition-all ${
                    darkMode ? 'bg-[#1b1b22] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'
                  }`}>
                    <h5 className="font-extrabold text-xs uppercase text-white/40 tracking-wider">Local Results Preview</h5>
                    <div className="divide-y divide-white/5 space-y-3">
                      {result.localResults.slice(0, 3).map((place, idx) => (
                        <div key={idx} className="pt-3 first:pt-0">
                          <h6 className="text-xs font-bold text-white leading-snug mb-0.5">{place.title}</h6>
                          <div className="flex items-center gap-1 text-[10px] text-white/40">
                            {place.rating && <span className="text-yellow-400 font-bold">★ {place.rating}</span>}
                            {place.address && <span className="truncate">· {place.address}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>

            </div>
          )}
        </div>
      )}

      {/* Lightbox Modal for Image Preview */}
      {selectedImage && (
        <div 
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-in fade-in duration-300"
          onClick={() => setSelectedImage(null)}
        >
          <button 
            onClick={() => setSelectedImage(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all"
          >
            <X className="w-6 h-6" />
          </button>
          
          <div 
            className="bg-[#1b1b22] border border-white/10 max-w-4xl w-full rounded-3xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative bg-black flex items-center justify-center p-4 max-h-[70vh]">
              <img 
                src={selectedImage.imageUrl} 
                alt={selectedImage.alt} 
                className="max-w-full max-h-[60vh] object-contain rounded-lg" 
              />
            </div>
            <div className="p-6 border-t border-white/5">
              <h3 className="text-lg font-bold text-white leading-tight mb-2">{selectedImage.alt || 'Crawled Google Image Result'}</h3>
              <p className="text-xs text-white/40 truncate mb-4">Source URL: {selectedImage.sourceUrl}</p>
              
              <a 
                href={selectedImage.sourceUrl} 
                target="_blank" 
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 rounded-xl text-xs font-bold text-white shadow transition-colors"
              >
                <span>Visit Source Site</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Scoped CSS styles for custom SGE rich elements */}
      <style>{`
        .ai-overview-text h1, .ai-overview-text h2, .ai-overview-text h3,
        .ai-overview-text h4, .ai-overview-text h5 {
          color: rgba(255,255,255,0.95);
          font-weight: 700;
          margin-top: 1.25em;
          margin-bottom: 0.5em;
        }
        .ai-overview-text h2 { font-size: 1.2em; border-left: 3px solid #6c63ff; padding-left: 8px; }
        .ai-overview-text h3 { font-size: 1.05em; }
        .ai-overview-text p { margin-bottom: 0.85em; font-size: 0.92rem; }
        .ai-overview-text ul, .ai-overview-text ol {
          padding-left: 1.5em;
          margin-bottom: 0.85em;
        }
        .ai-overview-text li { margin-bottom: 0.4em; list-style-type: square; }
        .ai-overview-text a {
          color: #6c63ff;
          text-decoration: underline;
          text-underline-offset: 2.5px;
          font-weight: 600;
        }
        .ai-overview-text a:hover { color: #00d4aa; }
        .ai-overview-text img { max-width: 100%; border-radius: 12px; margin: 0.75em 0; }
        .ai-overview-text strong, .ai-overview-text b { color: rgba(255,255,255,0.98); font-weight: bold; }
        .ai-overview-text br + br { display: none; }
      `}</style>
    </div>
  );
}
