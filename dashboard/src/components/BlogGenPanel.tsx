import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const STEPS = [
  '🔍 Querying Google Search for latest news and trends...',
  '🧠 Having Gemini identify the hottest developer sub-trends...',
  '📖 Researching chosen sub-trend in-depth on the web...',
  '✍️ Drafting human-like, citation-free technical blog post...',
  '🎨 Selecting matched cover image & publishing to Vercel...'
];

export default function BlogGenPanel() {
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  // Animate steps while loading is true
  useEffect(() => {
    if (!loading) return;
    setStepIndex(0);
    const interval = setInterval(() => {
      setStepIndex(prev => (prev < STEPS.length - 1 ? prev + 1 : prev));
    }, 4500);
    return () => clearInterval(interval);
  }, [loading]);

  const handleGenerate = async (useAutodiscover = false) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const searchTopic = useAutodiscover ? undefined : topic;
      const res = await api.generateBlog(searchTopic);
      if (res.success) {
        setResult(res.data || res);
      } else {
        setError(res.message || 'Failed to generate blog post.');
      }
    } catch (e: any) {
      setError(e.message || 'An error occurred during blog generation.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto text-sm">
      <div className="space-y-3">
        <p className="text-[var(--text-muted)] text-sm leading-relaxed">
          Create premium, human-styled developer blog posts in real-time. Provide a starting topic, and the system will automatically search the web for current developments, select the hottest trend, generate a citation-free post with Gemini, and publish it directly to your Vercel site.
        </p>
      </div>

      <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl overflow-hidden">
        <CardHeader className="border-b border-white/[0.04] bg-white/[0.01] py-4">
          <CardTitle className="text-base font-bold text-white flex items-center gap-2">
            <span>✍️</span> Blog Generation Wizard
          </CardTitle>
          <CardDescription className="text-xs">
            Generate custom topics, or let the AI discover current developer trends automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-5">
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-bold tracking-wider text-[var(--text-subtle)] block">
              Core Topic / Technology (Optional)
            </label>
            <Input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Next.js 15, Bun 1.2, React Server Components, LangGraph..."
              disabled={loading}
              className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-xl px-4 py-3 text-sm text-[var(--input-text)] placeholder-[var(--input-placeholder)] focus:border-[#0061FF]/45 transition-all"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Button
              onClick={() => handleGenerate(false)}
              disabled={loading || !topic.trim()}
              className="py-5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-[#0061FF] hover:bg-[#0051D4] text-white"
            >
              <span>🪄</span> Generate Custom Topic
            </Button>
            <Button
              onClick={() => handleGenerate(true)}
              disabled={loading}
              variant="outline"
              className="py-5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 border-white/10 hover:bg-white/[0.02]"
            >
              <span>🌐</span> Autodiscover Latest Trends
            </Button>
          </div>

          {loading && (
            <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-5 space-y-4 animate-in fade-in duration-300">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full border-2 border-[#0061FF] border-t-transparent animate-spin" />
                <span className="text-sm font-semibold text-white/90 font-mono">AI Generator is running...</span>
              </div>
              <div className="space-y-2 font-mono text-xs">
                {STEPS.map((s, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 transition-opacity duration-300 ${
                      idx === stepIndex
                        ? 'text-[#00E5FF] font-bold'
                        : idx < stepIndex
                        ? 'text-white/40 line-through'
                        : 'text-white/20'
                    }`}
                  >
                    <span>{idx < stepIndex ? '✓' : idx === stepIndex ? '▶' : '○'}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
              <div className="w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-[#0061FF] to-[#00E5FF] h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2.5 animate-in fade-in duration-300">
              <span className="text-sm">⚠️</span>
              <div className="space-y-0.5">
                <p className="font-bold">Generation Failed</p>
                <p className="opacity-80 leading-relaxed">{error}</p>
              </div>
            </div>
          )}

          {result && (
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-5 space-y-4 animate-in fade-in duration-300">
              <div className="flex items-center gap-2">
                <span className="text-emerald-400 text-lg">✓</span>
                <div>
                  <p className="text-sm text-emerald-400 font-bold">Successfully Published!</p>
                  <p className="text-[10px] text-[var(--text-subtle)] font-mono">Vercel Post ID: {result.id || 'N/A'}</p>
                </div>
              </div>

              {result.imageUrl && (
                <div className="relative rounded-xl overflow-hidden border border-white/5 shadow-inner">
                  <img
                    src={result.imageUrl}
                    alt={result.title || 'Cover'}
                    className="w-full h-48 object-cover filter brightness-75 hover:scale-105 transition-all duration-500"
                  />
                  <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-md text-[10px] text-white/90 border border-white/5 font-mono">
                    Cover Resolved
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <h4 className="text-sm font-bold text-white">{result.title}</h4>
                <p className="text-xs text-[var(--text-muted)] leading-relaxed">{result.description}</p>
              </div>

              <a
                href={result.url || `https://talhatech.vercel.app/blog/${result.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 font-bold text-white text-xs transition-all shadow-md shadow-emerald-500/10"
              >
                <span>🌍</span>
                <span>View Published Post on Website</span>
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
