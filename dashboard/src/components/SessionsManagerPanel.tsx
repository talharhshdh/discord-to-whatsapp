import React, { useState, useEffect } from 'react';

interface Session {
  id: string;
  type: string;
  url: string;
  username?: string;
  password?: string;
  startedAt: string;
  metadata?: {
    targetUrl?: string;
  };
}

export default function SessionsManagerPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [browsers, setBrowsers] = useState<any[]>([]);
  const [android, setAndroid] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [result, setResult] = useState('');

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/sessions/all');
      const data = await res.json();
      setSessions(data.sessions || []);
      setBrowsers(data.browsers || []);
      setAndroid(data.android);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  };

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  const stopSession = async (sessionId: string, type: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/sessions/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type }),
      });
      const data = await res.json();
      setResult(data.success ? `✅ ${data.message}` : `❌ ${data.message}`);
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const startCustomBrowser = async () => {
    if (!customUrl) {
      setResult('❌ Please enter a URL');
      return;
    }

    setLoading(true);
    setResult('');
    try {
      const res = await fetch('/api/browser/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: customUrl }),
      });
      const data = await res.json();
      if (data.error) {
        setResult(`❌ ${data.error}`);
      } else {
        setResult(`✅ Browser started!\n\n🌐 ${data.url}\n👤 ${data.username}\n🔑 ${data.password}`);
        setCustomUrl('');
        await loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const totalSessions = sessions.length + browsers.length + (android ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="glass rounded-xl p-4 border border-white/[0.07]">
          <div className="text-white/40 text-xs mb-1">Total Sessions</div>
          <div className="text-2xl font-bold text-white">{totalSessions}</div>
        </div>
        <div className="glass rounded-xl p-4 border border-white/[0.07]">
          <div className="text-white/40 text-xs mb-1">Custom Browsers</div>
          <div className="text-2xl font-bold text-teal-400">{sessions.filter(s => s.type === 'custom-browser').length}</div>
        </div>
        <div className="glass rounded-xl p-4 border border-white/[0.07]">
          <div className="text-white/40 text-xs mb-1">General Browsers</div>
          <div className="text-2xl font-bold text-blue-400">{browsers.length}</div>
        </div>
        <div className="glass rounded-xl p-4 border border-white/[0.07]">
          <div className="text-white/40 text-xs mb-1">Android</div>
          <div className="text-2xl font-bold text-green-400">{android ? '1' : '0'}</div>
        </div>
      </div>

      {/* Start Custom Browser */}
      <div className="glass rounded-2xl p-5 border border-white/[0.07]">
        <h3 className="text-sm font-semibold text-white mb-3">🌐 Start Custom Browser</h3>
        <div className="flex gap-2">
          <input
            type="url"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="https://example.com"
            className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
          />
          <button
            onClick={startCustomBrowser}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-teal-500/20 border border-teal-500/30 text-teal-400 hover:bg-teal-500/30 disabled:opacity-50 transition-all text-sm font-medium"
          >
            {loading ? '⏳' : '🚀 Start'}
          </button>
        </div>
        <p className="text-xs text-white/40 mt-2">
          Creates an isolated browser session that opens only this URL
        </p>
      </div>

      {/* Custom Browser Sessions */}
      {sessions.filter(s => s.type === 'custom-browser').length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">🌐 Custom Browser Sessions</h3>
          <div className="space-y-2">
            {sessions.filter(s => s.type === 'custom-browser').map((session) => (
              <div key={session.id} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium mb-1 truncate">
                      {session.metadata?.targetUrl || 'Custom Browser'}
                    </div>
                    <div className="text-xs text-white/40 space-y-1">
                      <div className="truncate">🔗 {session.url}</div>
                      <div>👤 {session.username} · 🔑 {session.password}</div>
                      <div>⏱️ Started: {new Date(session.startedAt).toLocaleTimeString()}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => stopSession(session.id, session.type)}
                    disabled={loading}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-all text-xs"
                  >
                    Stop
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* General Browsers */}
      {browsers.length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">🌐 General Browsers</h3>
          <div className="space-y-2">
            {browsers.map((browser, idx) => (
              <div key={idx} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="text-white text-sm font-medium mb-1">General Browser</div>
                <div className="text-xs text-white/40 space-y-1">
                  <div className="truncate">🔗 {browser.url}</div>
                  <div>👤 {browser.username} · 🔑 {browser.password}</div>
                  <div>🔌 Port: {browser.port}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Android Emulator */}
      {android && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">📱 Android Emulator</h3>
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
            <div className="text-white text-sm font-medium mb-1">{android.deviceInfo || 'Android 13'}</div>
            <div className="text-xs text-white/40 space-y-1">
              <div className="truncate">🔗 {android.webUrl || 'N/A'}</div>
              <div>⏱️ Uptime: {android.uptime || 'Unknown'}</div>
            </div>
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <pre className="text-xs text-white/70 whitespace-pre-wrap font-mono">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}
