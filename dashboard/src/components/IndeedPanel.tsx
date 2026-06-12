import React, { useState, useEffect } from 'react';
import { api, BrowserPoolItem } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface JobResult {
  jk: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  url: string;
  description?: string;
}

export default function IndeedPanel() {
  const [query, setQuery] = useState('software engineer');
  const [location, setLocation] = useState('Rawalpindi');
  const [pages, setPages] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobResult[]>([]);
  const [expandedJks, setExpandedJks] = useState<Record<string, boolean>>({});
  const [workersCount, setWorkersCount] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');

  // Fetch worker pool to see how many workers support the API
  const checkWorkers = async () => {
    try {
      const res = await api.getBrowserPool();
      const count = res.browsers.filter(b => b.apiUrl && b.status === 'active').length;
      setWorkersCount(count);
    } catch {
      // Ignore pool fetch errors
    }
  };

  useEffect(() => {
    checkWorkers();
    const interval = setInterval(checkWorkers, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (workersCount === 0) {
      setError('Cannot start scrape: No active workers with API support are currently registered.');
      return;
    }

    setLoading(true);
    setError(null);
    setStatusMsg('Distributing page tasks across active workers...');
    try {
      const res = await api.indeedSearch(query, location, pages);
      if (res.success) {
        setJobs(res.jobs);
        setStatusMsg(`Successfully scraped ${res.jobsCount} jobs!`);
      } else {
        throw new Error('Scraping did not return success.');
      }
    } catch (err: any) {
      setError(err.message || 'Scrape failed. Workers might have been blocked or timed out.');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (jk: string) => {
    setExpandedJks(prev => ({
      ...prev,
      [jk]: !prev[jk]
    }));
  };

  const handleDownloadJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jobs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `indeed_jobs_${query.replace(/\s+/g, '_')}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="space-y-6 text-sm">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Scrape Control Card */}
        <Card className="glass rounded-3xl md:col-span-2 border border-white/[0.08] p-6">
          <CardHeader className="p-0 mb-5">
            <CardTitle className="text-white font-bold text-base">Distributed Indeed Job Scraper</CardTitle>
            <CardDescription className="text-white/40 text-xs mt-1">
              Distribute pages of Indeed search queries in parallel across active remote browser workers.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <form onSubmit={handleScrape} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Search Query</label>
                  <Input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    required
                    placeholder="e.g. software engineer"
                    className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase font-black tracking-wider text-white/40">Location</label>
                  <Input
                    type="text"
                    value={location}
                    onChange={e => setLocation(e.target.value)}
                    placeholder="e.g. Rawalpindi"
                    className="w-full bg-white/[0.04] border border-white/[0.08] hover:border-white/15 focus:border-[#0061FF]/40 rounded-xl px-4 py-2.5 text-xs text-white"
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-white/60">Pages to scrape:</span>
                  <div className="flex items-center gap-1 bg-white/[0.03] border border-white/[0.08] rounded-lg p-1">
                    {[1, 2, 3, 4, 5].map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPages(p)}
                        className={`w-7 h-7 flex items-center justify-center rounded-md text-xs font-semibold transition-all ${
                          pages === p
                            ? 'bg-[#0061FF] text-white shadow-md'
                            : 'text-white/50 hover:bg-white/[0.05] hover:text-white'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading || workersCount === 0}
                  className="w-full sm:w-auto px-6 py-2.5 h-auto bg-gradient-to-r from-[#0061FF] to-[#00D4FF] hover:opacity-90 disabled:opacity-40 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-[#0061FF]/10 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      Scraping...
                    </>
                  ) : (
                    '🚀 Scrape Indeed Jobs'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Worker Pool Status Card */}
        <Card className="glass rounded-3xl border border-white/[0.08] p-6 flex flex-col justify-between">
          <div>
            <CardHeader className="p-0 mb-4">
              <CardTitle className="text-white font-bold text-sm">Worker Fleet Status</CardTitle>
              <CardDescription className="text-white/40 text-[11px] mt-0.5">
                Availability of active scraping worker workers.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 space-y-4">
              <div className="flex items-center justify-between bg-white/[0.02] border border-white/[0.05] rounded-xl p-3.5">
                <span className="text-xs text-white/60">Scraper Workers Available</span>
                <Badge
                  variant="outline"
                  className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                    workersCount > 0
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                      : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                  }`}
                >
                  {workersCount} Online
                </Badge>
              </div>
              <p className="text-[11px] text-white/30 leading-relaxed font-mono">
                {workersCount > 0
                  ? `Task will be split: each worker fetches 1 page (10-15 jobs) concurrently.`
                  : 'Start a browser worker in the Browser Pool tab to initialize scraping nodes.'}
              </p>
            </CardContent>
          </div>
        </Card>
      </div>

      {/* Status Messages */}
      {statusMsg && !error && (
        <div className="px-4 py-3 bg-teal-500/10 border border-teal-500/25 rounded-xl text-teal-400 text-xs font-medium animate-pulse">
          💡 {statusMsg}
        </div>
      )}

      {error && (
        <div className="px-4 py-3 bg-rose-500/10 border border-rose-500/25 rounded-xl text-rose-400 text-xs font-medium">
          ⚠️ {error}
        </div>
      )}

      {/* Jobs Results List */}
      {jobs.length > 0 && (
        <Card className="glass rounded-3xl overflow-hidden border border-white/[0.08]">
          <CardHeader className="border-b border-white/[0.06] bg-white/[0.01] px-6 py-4 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-white font-bold text-sm">Scraped Job Openings</CardTitle>
              <CardDescription className="text-white/40 text-[11px] mt-0.5">
                Unified list containing {jobs.length} unique jobs.
              </CardDescription>
            </div>
            <Button
              onClick={handleDownloadJson}
              variant="outline"
              className="px-4 py-2 h-auto bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-semibold rounded-xl transition-all"
            >
              📥 Export JSON
            </Button>
          </CardHeader>
          <div className="divide-y divide-white/[0.06]">
            {jobs.map((job, idx) => (
              <div key={job.jk} className="p-6 hover:bg-white/[0.01] transition-colors space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-white text-sm hover:text-teal-400 transition-colors">
                      {idx + 1}. {job.title}
                    </h3>
                    <p className="text-white/50 text-xs font-medium mt-0.5">
                      {job.company} — <span className="text-white/35 font-normal">{job.location}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {job.salary && (
                      <Badge variant="outline" className="bg-teal-500/10 border-teal-500/20 text-teal-400 font-semibold text-[10px]">
                        💰 {job.salary}
                      </Badge>
                    )}
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white text-[11px] font-semibold transition-all"
                    >
                      View on Indeed ↗
                    </a>
                  </div>
                </div>

                <p className="text-xs text-white/60 leading-relaxed pl-4 border-l-2 border-white/10 bg-white/[0.01] py-1">
                  {job.snippet}
                </p>

                <div className="pt-1">
                  <button
                    onClick={() => toggleExpand(job.jk)}
                    className="text-[11px] font-bold text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-all"
                  >
                    {expandedJks[job.jk] ? '🔼 Hide Full Description' : '🔽 Show Full Description'}
                  </button>

                  {expandedJks[job.jk] && (
                    <div className="mt-3 bg-black/45 border border-white/[0.06] rounded-xl p-4 text-xs text-white/70 leading-relaxed font-mono whitespace-pre-wrap select-text max-h-[300px] overflow-y-auto scrollbar-thin">
                      {job.description || 'No description found.'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
