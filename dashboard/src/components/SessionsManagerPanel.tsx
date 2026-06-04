import React, { useState, useEffect } from 'react';
import { BASE } from '../api';

interface Session {
  id: string;
  type: string;
  url: string;
  username?: string;
  password?: string;
  startedAt: string;
  metadata?: {
    targetUrl?: string;
    port?: number;
    hostPort?: number;
    containerName?: string;
    cloudflaredUrl?: string;
    webhookSecret?: string;
    image?: string;
    env?: Record<string, string>;
    domainMode?: 'quick' | 'custom';
    customDomain?: string;
    tunnelToken?: string;
  };
}

export default function SessionsManagerPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [browsers, setBrowsers] = useState<any[]>([]);
  const [android, setAndroid] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [result, setResult] = useState('');

  // Custom Docker deploy states
  const [dockerImage, setDockerImage] = useState('');
  const [dockerPort, setDockerPort] = useState('80');
  const [dockerName, setDockerName] = useState('');
  const [dockerEnv, setDockerEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('15000');
  const [tunnelToken, setTunnelToken] = useState('');

  // Edit Docker Container States
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('15000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
  const [editTunnelToken, setEditTunnelToken] = useState('');
  const [editEnv, setEditEnv] = useState('');

  const startEditing = (session: Session) => {
    setEditingSession(session);
    setEditImage(session.metadata?.image || '');
    setEditPort(session.metadata?.port?.toString() || '80');
    setEditHostPort(session.metadata?.hostPort?.toString() || '15000');
    
    let nameVal = '';
    if (session.metadata?.containerName) {
      const parts = session.metadata.containerName.split('-');
      if (parts.length >= 4) {
        nameVal = parts.slice(2, parts.length - 1).join('-');
      }
    }
    setEditName(nameVal);
    
    setEditDomainMode(session.metadata?.domainMode || 'quick');
    setEditCustomDomain(session.metadata?.customDomain || '');
    setEditTunnelToken(session.metadata?.tunnelToken || '');
    
    const envObj = session.metadata?.env || {};
    const envStr = Object.entries(envObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    setEditEnv(envStr);
  };

  const saveEditedContainer = async () => {
    if (!editingSession) return;
    if (!editImage) {
      setResult('❌ Please enter a Docker Image URI');
      return;
    }
    const portNum = parseInt(editPort, 10);
    if (isNaN(portNum) || portNum <= 0) {
      setResult('❌ Please enter a valid container port number');
      return;
    }
    const hostPortNum = parseInt(editHostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) {
      setResult('❌ Please enter a valid local host port number');
      return;
    }

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      editEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.substring(0, eqIdx).trim();
          const v = trimmed.substring(eqIdx + 1).trim();
          envObj[k] = v;
        }
      });

      const res = await fetch(`${BASE}/api/sessions/docker/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: editingSession.id,
          image: editImage,
          port: portNum,
          env: envObj,
          name: editName || undefined,
          domainMode: editDomainMode,
          customDomain: editDomainMode === 'custom' ? editCustomDomain : undefined,
          hostPort: hostPortNum,
          tunnelToken: editDomainMode === 'custom' ? (editTunnelToken || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setResult(`❌ ${data.error}`);
      } else {
        setResult(`✅ Docker container updated and re-deployed successfully!\n\n🌐 Live URL: ${data.url}\n🐋 Container: ${data.containerName}`);
        setEditingSession(null);
        await loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadSessions = async () => {
    try {
      const res = await fetch(`${BASE}/api/sessions/all`);
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
      const res = await fetch(`${BASE}/api/sessions/stop`, {
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
      const res = await fetch(`${BASE}/api/browser/custom`, {
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

  const deployCustomContainer = async () => {
    if (!dockerImage) {
      setResult('❌ Please enter a Docker Image URI');
      return;
    }
    const portNum = parseInt(dockerPort, 10);
    if (isNaN(portNum) || portNum <= 0) {
      setResult('❌ Please enter a valid container port number');
      return;
    }
    const hostPortNum = parseInt(hostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) {
      setResult('❌ Please enter a valid local host port number');
      return;
    }

    setLoading(true);
    setResult('');
    try {
      // Parse env variables
      const envObj: Record<string, string> = {};
      dockerEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.substring(0, eqIdx).trim();
          const v = trimmed.substring(eqIdx + 1).trim();
          envObj[k] = v;
        }
      });

      const res = await fetch(`${BASE}/api/sessions/docker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dockerImage,
          port: portNum,
          env: envObj,
          name: dockerName || undefined,
          domainMode,
          customDomain: domainMode === 'custom' ? customDomain : undefined,
          hostPort: hostPortNum,
          tunnelToken: domainMode === 'custom' ? (tunnelToken || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setResult(`❌ ${data.error}`);
      } else {
        setResult(`✅ Docker container started!\n\n🌐 Live URL: ${data.url}\n🐋 Container: ${data.containerName}`);
        setDockerImage('');
        setDockerName('');
        setDockerEnv('');
        setCustomDomain('');
        setTunnelToken('');
        await loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const totalSessions = sessions.length + browsers.length + (android ? 1 : 0);
  
  // Group sessions by type
  const customBrowserSessions = sessions.filter(s => s.type === 'custom-browser');
  const terminalSessions = sessions.filter(s => s.type === 'terminal');
  const vscodeSessions = sessions.filter(s => s.type === 'vscode');
  const browserSessions = sessions.filter(s => s.type === 'browser');
  const dockerSessions = sessions.filter(s => s.type === 'docker-container');

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult('✅ Copied to clipboard!');
    setTimeout(() => setResult(''), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Restored Sessions Alert */}
      {sessions.length > 0 && (
        <div className="glass rounded-2xl p-4 border border-teal-500/30 bg-teal-500/5">
          <div className="flex items-start gap-3">
            <div className="text-2xl">💾</div>
            <div className="flex-1">
              <div className="text-white font-medium text-sm mb-1">
                Sessions Restored from Cloudflare R2
              </div>
              <div className="text-white/60 text-xs">
                {sessions.length} session{sessions.length !== 1 ? 's' : ''} restored from previous workflow run. 
                All credentials and Cloudflare tunnel URLs are preserved.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07]">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">Total</div>
          <div className="text-xl sm:text-2xl font-bold text-white">{totalSessions}</div>
        </div>
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07]">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">Terminals</div>
          <div className="text-xl sm:text-2xl font-bold text-purple-400">{terminalSessions.length}</div>
        </div>
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07]">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">VSCode</div>
          <div className="text-xl sm:text-2xl font-bold text-blue-400">{vscodeSessions.length}</div>
        </div>
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07]">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">Browsers</div>
          <div className="text-xl sm:text-2xl font-bold text-teal-400">{customBrowserSessions.length + browsers.length}</div>
        </div>
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07]">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">Docker Apps</div>
          <div className="text-xl sm:text-2xl font-bold text-indigo-400">{dockerSessions.length}</div>
        </div>
        <div className="glass rounded-xl p-3 sm:p-4 border border-white/[0.07] col-span-2 sm:col-span-1">
          <div className="text-white/40 text-[10px] sm:text-xs mb-1">Android</div>
          <div className="text-xl sm:text-2xl font-bold text-green-400">{android ? '1' : '0'}</div>
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

      {/* Deploy Custom Docker Container */}
      <div className="glass rounded-2xl p-5 border border-white/[0.07] space-y-3">
        <h3 className="text-sm font-semibold text-white">🐋 Deploy Custom Docker Container</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="flex flex-col space-y-1 sm:col-span-2">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Image URI</span>
            <input
              type="text"
              value={dockerImage}
              onChange={(e) => setDockerImage(e.target.value)}
              placeholder="e.g. ghost:alpine or nginx:latest"
              className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div className="flex flex-col space-y-1">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Container Port</span>
            <input
              type="number"
              value={dockerPort}
              onChange={(e) => setDockerPort(e.target.value)}
              placeholder="e.g. 80"
              className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div className="flex flex-col space-y-1">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Local Host Port</span>
            <input
              type="number"
              value={hostPort}
              onChange={(e) => setHostPort(e.target.value)}
              placeholder="e.g. 15000"
              className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="flex flex-col space-y-1">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Instance Name (Optional)</span>
            <input
              type="text"
              value={dockerName}
              onChange={(e) => setDockerName(e.target.value)}
              placeholder="e.g. my-app"
              className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div className="flex flex-col space-y-1">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Domain Mode</span>
            <select
              value={domainMode}
              onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
              className="px-3 py-2 rounded-lg bg-[#161a26] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
            >
              <option value="quick" className="bg-[#161a26]">Quick Tunnel (trycloudflare)</option>
              <option value="custom" className="bg-[#161a26]">Custom Subdomain</option>
            </select>
          </div>
          {domainMode === 'custom' && (
            <div className="flex flex-col space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
              <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Custom Subdomain</span>
              <input
                type="text"
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="e.g. whoami.ufone-claim.site"
                className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
              />
            </div>
          )}
        </div>
        {domainMode === 'custom' && (
          <div className="flex flex-col space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
            <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Cloudflare Tunnel Token (Optional)</span>
            <input
              type="password"
              value={tunnelToken}
              onChange={(e) => setTunnelToken(e.target.value)}
              placeholder="Paste your Cloudflare Tunnel Token to keep domain persistent across sessions"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500 font-mono"
            />
          </div>
        )}
        <div className="flex flex-col space-y-1">
          <span className="text-[10px] text-white/40 font-bold uppercase text-xs">Environment Variables</span>
          <textarea
            value={dockerEnv}
            onChange={(e) => setDockerEnv(e.target.value)}
            placeholder="KEY=VALUE (one per line, e.g. NODE_ENV=production)"
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500 font-mono"
          />
        </div>
        <div className="flex justify-end">
          <button
            onClick={deployCustomContainer}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30 disabled:opacity-50 transition-all text-sm font-medium"
          >
            {loading ? '⏳ Deploying Container...' : '🚀 Run Instance'}
          </button>
        </div>
        <p className="text-xs text-white/40">
          Pulls the image from Docker Hub, spins up a secure container, and routes traffic via Cloudflare.
        </p>
      </div>

      {/* Custom Docker Sessions */}
      {dockerSessions.length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">🐋 Running Custom Docker Instances</h3>
          <div className="space-y-2">
            {dockerSessions.map((session) => (
              <div key={session.id} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-white text-sm font-medium truncate">
                      {session.metadata?.targetUrl || 'Custom Container'}
                    </div>
                    <div className="text-xs text-white/60 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white/40">🔗 Live URL:</span>
                        <button
                          onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)}
                          className="text-teal-400 hover:text-teal-300 truncate flex-1 text-left font-mono text-xs"
                        >
                          {session.metadata?.cloudflaredUrl || session.url}
                        </button>
                      </div>
                      {session.metadata?.containerName && (
                        <div className="text-white/40">📦 Container Name: <span className="font-mono text-white/80 select-all">{session.metadata.containerName}</span></div>
                      )}
                      {session.metadata?.hostPort && (
                        <div className="text-white/40">🔌 Local Host Port: {session.metadata.hostPort}</div>
                      )}
                      <div className="text-white/40">⏱️ Started: {new Date(session.startedAt).toLocaleString()}</div>
                      {session.metadata?.webhookSecret && (
                        <div className="flex flex-col space-y-1 mt-2 pt-2 border-t border-white/[0.05]">
                          <span className="text-[10px] text-white/40 font-bold uppercase">⚓ Re-deploy Webhook (POST/GET to rebuild image & restart):</span>
                          <button
                            onClick={() => copyToClipboard(`${window.location.origin}/api/webhook/docker/${session.id}?secret=${session.metadata?.webhookSecret}`)}
                            className="text-indigo-400 hover:text-indigo-300 font-mono text-[10px] break-all text-left flex-1"
                          >
                            {`${window.location.origin}/api/webhook/docker/${session.id}?secret=${session.metadata?.webhookSecret}`}
                          </button>
                          <div className="text-white/30 text-[9px]">Secret ID: <span className="font-mono text-white/50 select-all">{session.metadata.webhookSecret}</span></div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      onClick={() => startEditing(session)}
                      disabled={loading}
                      className="px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-50 transition-all text-xs font-semibold"
                    >
                      Edit Config
                    </button>
                    <button
                      onClick={() => stopSession(session.id, session.type)}
                      disabled={loading}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-all text-xs font-semibold"
                    >
                      Stop / Terminate
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Terminal Sessions */}
      {terminalSessions.length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">💻 Terminal Sessions</h3>
          <div className="space-y-2">
            {terminalSessions.map((session) => (
              <div key={session.id} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-white text-sm font-medium">Terminal Session</div>
                    <div className="text-xs text-white/60 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white/40">🔗 URL:</span>
                        <button
                          onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)}
                          className="text-teal-400 hover:text-teal-300 truncate flex-1 text-left"
                        >
                          {session.metadata?.cloudflaredUrl || session.url}
                        </button>
                      </div>
                      {session.username && (
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">👤 Username:</span>
                          <button
                            onClick={() => copyToClipboard(session.username!)}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            {session.username}
                          </button>
                        </div>
                      )}
                      {session.password && (
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">🔑 Password:</span>
                          <button
                            onClick={() => copyToClipboard(session.password!)}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            {session.password}
                          </button>
                        </div>
                      )}
                      {session.metadata?.port && (
                        <div className="text-white/40">🔌 Port: {session.metadata.port}</div>
                      )}
                      <div className="text-white/40">⏱️ Started: {new Date(session.startedAt).toLocaleString()}</div>
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

      {/* VSCode Sessions */}
      {vscodeSessions.length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">💻 VSCode Sessions</h3>
          <div className="space-y-2">
            {vscodeSessions.map((session) => (
              <div key={session.id} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-white text-sm font-medium">VSCode Server</div>
                    <div className="text-xs text-white/60 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white/40">🔗 URL:</span>
                        <button
                          onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)}
                          className="text-blue-400 hover:text-blue-300 truncate flex-1 text-left"
                        >
                          {session.metadata?.cloudflaredUrl || session.url}
                        </button>
                      </div>
                      {session.password && (
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">🔑 Password:</span>
                          <button
                            onClick={() => copyToClipboard(session.password!)}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            {session.password}
                          </button>
                        </div>
                      )}
                      {session.metadata?.port && (
                        <div className="text-white/40">🔌 Port: {session.metadata.port}</div>
                      )}
                      <div className="text-white/40">⏱️ Started: {new Date(session.startedAt).toLocaleString()}</div>
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

      {/* Custom Browser Sessions */}
      {customBrowserSessions.length > 0 && (
        <div className="glass rounded-2xl p-5 border border-white/[0.07]">
          <h3 className="text-sm font-semibold text-white mb-3">🌐 Custom Browser Sessions</h3>
          <div className="space-y-2">
            {customBrowserSessions.map((session) => (
              <div key={session.id} className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-white text-sm font-medium truncate">
                      {session.metadata?.targetUrl || 'Custom Browser'}
                    </div>
                    <div className="text-xs text-white/60 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white/40">🔗 URL:</span>
                        <button
                          onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)}
                          className="text-teal-400 hover:text-teal-300 truncate flex-1 text-left"
                        >
                          {session.metadata?.cloudflaredUrl || session.url}
                        </button>
                      </div>
                      {session.username && (
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">👤 Username:</span>
                          <button
                            onClick={() => copyToClipboard(session.username!)}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            {session.username}
                          </button>
                        </div>
                      )}
                      {session.password && (
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">🔑 Password:</span>
                          <button
                            onClick={() => copyToClipboard(session.password!)}
                            className="text-teal-400 hover:text-teal-300"
                          >
                            {session.password}
                          </button>
                        </div>
                      )}
                      <div className="text-white/40">⏱️ Started: {new Date(session.startedAt).toLocaleString()}</div>
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

      {/* Edit Container Modal */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-2xl glass rounded-2xl border border-white/10 bg-[#121620]/95 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                🐋 Edit & Re-deploy Docker Instance
              </h3>
              <button 
                onClick={() => setEditingSession(null)}
                className="text-white/60 hover:text-white text-sm"
              >
                ✕ Close
              </button>
            </div>
            
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <div className="flex flex-col space-y-1 sm:col-span-2">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Image URI</span>
                  <input
                    type="text"
                    value={editImage}
                    onChange={(e) => setEditImage(e.target.value)}
                    placeholder="e.g. ghost:alpine or nginx:latest"
                    className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                  />
                </div>
                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Container Port</span>
                  <input
                    type="number"
                    value={editPort}
                    onChange={(e) => setEditPort(e.target.value)}
                    placeholder="e.g. 80"
                    className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                  />
                </div>
                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Local Host Port</span>
                  <input
                    type="number"
                    value={editHostPort}
                    onChange={(e) => setEditHostPort(e.target.value)}
                    placeholder="e.g. 15000"
                    className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Instance Name</span>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="e.g. my-app"
                    className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                  />
                </div>
                <div className="flex flex-col space-y-1">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Domain Mode</span>
                  <select
                    value={editDomainMode}
                    onChange={(e) => setEditDomainMode(e.target.value as 'quick' | 'custom')}
                    className="px-3 py-2 rounded-lg bg-[#161a26] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                  >
                    <option value="quick" className="bg-[#161a26]">Quick Tunnel (trycloudflare)</option>
                    <option value="custom" className="bg-[#161a26]">Custom Subdomain</option>
                  </select>
                </div>
                {editDomainMode === 'custom' && (
                  <div className="flex flex-col space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
                    <span className="text-[10px] text-white/40 font-bold uppercase">Custom Subdomain</span>
                    <input
                      type="text"
                      value={editCustomDomain}
                      onChange={(e) => setEditCustomDomain(e.target.value)}
                      placeholder="e.g. whoami.ufone-claim.site"
                      className="px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500"
                    />
                  </div>
                )}
              </div>

              {editDomainMode === 'custom' && (
                <div className="flex flex-col space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
                  <span className="text-[10px] text-white/40 font-bold uppercase">Cloudflare Tunnel Token (Optional)</span>
                  <input
                    type="password"
                    value={editTunnelToken}
                    onChange={(e) => setEditTunnelToken(e.target.value)}
                    placeholder="Paste your Cloudflare Tunnel Token to keep domain persistent"
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500 font-mono"
                  />
                </div>
              )}

              <div className="flex flex-col space-y-1">
                <span className="text-[10px] text-white/40 font-bold uppercase">Environment Variables</span>
                <textarea
                  value={editEnv}
                  onChange={(e) => setEditEnv(e.target.value)}
                  placeholder="KEY=VALUE (one per line, e.g. NODE_ENV=production)"
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm focus:outline-none focus:border-teal-500 font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-white/10 pt-3">
              <button
                onClick={() => setEditingSession(null)}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 disabled:opacity-50 transition-all text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={saveEditedContainer}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-[#4f46e5] border border-[#6366f1]/30 text-white hover:bg-[#4338ca] disabled:opacity-50 transition-all text-sm font-medium"
              >
                {loading ? '⏳ Redeploying...' : '💾 Save & Re-deploy'}
              </button>
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
