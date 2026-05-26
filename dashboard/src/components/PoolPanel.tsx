import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload, BrowserPoolItem } from '../api';

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export default function PoolPanel() {
  const [data, setData] = useState<BrowserPoolPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState('');

  const fetchPool = async () => {
    try {
      const res = await api.getBrowserPool();
      setData(res);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch browser pool status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRestart = async () => {
    if (window.confirm('Are you sure you want to trigger a fleet restart? This will dispatch a GHA run to spawn fresh workers.')) {
      setRestarting(true);
      setRestartMsg('');
      try {
        const res = await api.restartBrowsers();
        setRestartMsg(res.message || 'Restart command sent successfully!');
        setTimeout(() => setRestartMsg(''), 4000);
        await fetchPool();
      } catch (err: any) {
        setRestartMsg(`Error: ${err.message}`);
      } finally {
        setRestarting(false);
      }
    }
  };

  const getStatusColor = (status: BrowserPoolItem['status']) => {
    switch (status) {
      case 'active':
        return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
      case 'stale':
        return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
      case 'dead':
        return 'bg-rose-500/10 border-rose-500/20 text-rose-400';
      default:
        return 'bg-white/5 border-white/10 text-white/40';
    }
  };

  const formatAge = (registeredAt: string) => {
    const elapsedMs = Date.now() - new Date(registeredAt).getTime();
    const mins = Math.floor(elapsedMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4">
        <div className="w-10 h-10 border-4 border-[#6c63ff]/20 border-t-[#00d4aa] rounded-full animate-spin" />
        <p className="text-white/40 text-sm">Loading browser worker pool status...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="glass rounded-3xl p-10 text-center space-y-4 max-w-md mx-auto">
        <div className="w-12 h-12 mx-auto rounded-full bg-rose-500/10 border border-rose-500/25 flex items-center justify-center text-xl">
          ⚠️
        </div>
        <div>
          <h3 className="text-white font-bold">Failed to load pool status</h3>
          <p className="text-white/40 text-xs mt-1">{error}</p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchPool(); }}
          className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-semibold rounded-xl transition-all"
        >
          Try Again
        </button>
      </div>
    );
  }

  const browsers = data?.browsers ?? [];
  const cachedCount = browsers.filter(b => b.isCached).length;

  return (
    <div className="space-y-6">
      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass rounded-2xl p-4 flex flex-col justify-between">
          <p className="text-[10px] text-white/30 uppercase font-bold tracking-wider">Total Fleet Size</p>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-3xl font-black text-white">{data?.total ?? 0}</span>
            <span className="text-xs text-white/30">workers</span>
          </div>
        </div>

        <div className="glass rounded-2xl p-4 flex flex-col justify-between">
          <p className="text-[10px] text-white/30 uppercase font-bold tracking-wider">Active Workers</p>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-3xl font-black text-emerald-400">{data?.active ?? 0}</span>
            <span className="text-xs text-white/30">online</span>
          </div>
        </div>

        <div className="glass rounded-2xl p-4 flex flex-col justify-between">
          <p className="text-[10px] text-white/30 uppercase font-bold tracking-wider">Pre-warmed CDP Connections</p>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-3xl font-black text-teal-400">{cachedCount}</span>
            <span className="text-xs text-white/30">cached</span>
          </div>
        </div>

        <div className="glass rounded-2xl p-4 flex flex-col justify-between">
          <p className="text-[10px] text-white/30 uppercase font-bold tracking-wider">Pool Efficiency</p>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-3xl font-black text-[#6c63ff]">
              {data?.active ? Math.round((cachedCount / data.active) * 100) : 0}%
            </span>
            <span className="text-xs text-white/30">pre-warmed</span>
          </div>
        </div>
      </div>

      {/* Control Actions */}
      <div className="flex items-center justify-between bg-white/[0.02] border border-white/[0.06] rounded-2xl p-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Browser Fleet Manager</h3>
          <p className="text-xs text-white/30 mt-0.5">Control, restart, and monitor live distributed worker instances.</p>
        </div>
        <div className="flex gap-2">
          {restartMsg && (
            <div className={`px-4 py-2 text-xs rounded-xl border flex items-center ${
              restartMsg.startsWith('Error') 
                ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' 
                : 'bg-teal-500/10 border-teal-500/20 text-teal-400'
            }`}>
              {restartMsg}
            </div>
          )}
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="px-4 py-2 bg-gradient-to-r from-red-500/20 to-rose-500/25 border border-red-500/30 hover:opacity-90 disabled:opacity-40 text-red-400 text-xs font-semibold rounded-xl transition-all shadow-lg shadow-red-500/5 flex items-center gap-1.5"
          >
            ⚡ {restarting ? 'Triggering...' : 'Restart Fleet'}
          </button>
        </div>
      </div>

      {/* Worker List */}
      <div className="glass rounded-3xl overflow-hidden border border-white/[0.08]">
        {browsers.length === 0 ? (
          <div className="p-12 text-center text-white/30 text-sm">
            No remote browser workers registered. Ensure GHA worker runs are active and heartbeating.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">Worker ID</th>
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">CDP WebSocket / Tunnel URL</th>
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">Status</th>
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">Puppeteer CDP Connection</th>
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">Heartbeat</th>
                  <th className="text-[10px] uppercase font-black tracking-wider text-white/40 px-6 py-4">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {browsers.map(b => (
                  <tr key={b.workerId} className="hover:bg-white/[0.01] transition-colors">
                    {/* Worker ID */}
                    <td className="px-6 py-4 font-mono text-xs text-white select-all cursor-pointer hover:text-teal-400 transition-colors"
                        onClick={() => { copyText(b.workerId); }}
                        title="Click to copy Worker ID">
                      {b.workerId}
                    </td>

                    {/* CDP Tunnel URL */}
                    <td className="px-6 py-4 max-w-xs">
                      <div className="flex items-center gap-2 bg-black/20 border border-white/10 rounded-lg px-2.5 py-1.5">
                        <a href={`${b.cdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                           className="flex-1 text-teal-400 hover:underline text-xs font-mono truncate select-all">
                          {b.cdpUrl}
                        </a>
                        <button onClick={() => copyText(b.cdpUrl)}
                                className="text-[10px] text-white/30 hover:text-white transition-colors"
                                title="Copy CDP URL">📋</button>
                        <a href={`${b.cdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                           className="text-[10px] text-white/30 hover:text-white transition-colors"
                           title="Check CDP Status page">↗</a>
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border capitalize ${getStatusColor(b.status)}`}>
                        {b.status}
                      </span>
                    </td>

                    {/* Connection/Cache Status */}
                    <td className="px-6 py-4">
                      {b.isCached ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Cached & Pre-warmed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/10 text-white/40 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
                          Lazy / Disconnected
                        </span>
                      )}
                    </td>

                    {/* Heartbeat time */}
                    <td className="px-6 py-4 text-xs text-white/60">
                      {b.secondsSinceHeartbeat <= 5 ? (
                        <span className="text-emerald-400 font-medium">Just now</span>
                      ) : (
                        <span>{b.secondsSinceHeartbeat}s ago</span>
                      )}
                    </td>

                    {/* Age */}
                    <td className="px-6 py-4 text-xs text-white/40">
                      {formatAge(b.registeredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
