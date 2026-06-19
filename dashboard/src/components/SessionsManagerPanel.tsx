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

type TabType = 'all' | 'docker' | 'browser' | 'terminal' | 'vscode' | 'android';

export default function SessionsManagerPanel() {
  // --- Data States ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [browsers, setBrowsers] = useState<any[]>([]);
  const [android, setAndroid] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  
  // --- UI States ---
  const [activeTab, setActiveTab] = useState<TabType>('all');

  // --- Custom Browser States ---
  const [customUrl, setCustomUrl] = useState('');

  // --- Custom Docker Deploy States ---
  const [dockerImage, setDockerImage] = useState('');
  const [dockerPort, setDockerPort] = useState('80');
  const [dockerName, setDockerName] = useState('');
  const [dockerEnv, setDockerEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('15000');
  const [tunnelToken, setTunnelToken] = useState('');

  // --- Edit Docker Container States ---
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('15000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
  const [editTunnelToken, setEditTunnelToken] = useState('');
  const [editEnv, setEditEnv] = useState('');

  // --- Logic & API calls (Unchanged) ---
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
    if (!editImage) return setResult('❌ Please enter a Docker Image URI');
    
    const portNum = parseInt(editPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('❌ Invalid container port');
    
    const hostPortNum = parseInt(editHostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('❌ Invalid host port');

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      editEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
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
      if (data.error) throw new Error(data.error);
      
      setResult(`✅ Redeployed successfully!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setEditingSession(null);
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

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
    if (!customUrl) return setResult('❌ Please enter a URL');
    setLoading(true);
    setResult('');
    try {
      const res = await fetch(`${BASE}/api/browser/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: customUrl }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setResult(`✅ Browser started!\nURL: ${data.url}\nUser: ${data.username} | Pass: ${data.password}`);
      setCustomUrl('');
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const deployCustomContainer = async () => {
    if (!dockerImage) return setResult('❌ Please enter a Docker Image URI');
    const portNum = parseInt(dockerPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('❌ Invalid container port');
    const hostPortNum = parseInt(hostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('❌ Invalid host port');

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      dockerEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
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
      if (data.error) throw new Error(data.error);
      
      setResult(`✅ Container started!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setDockerImage(''); setDockerName(''); setDockerEnv(''); setCustomDomain(''); setTunnelToken('');
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult('✅ Copied to clipboard!');
    setTimeout(() => setResult(''), 2000);
  };

  // --- Computed Data ---
  const totalSessions = sessions.length + browsers.length + (android ? 1 : 0);
  const dockerSessions = sessions.filter(s => s.type === 'docker-container');
  const customBrowserSessions = sessions.filter(s => s.type === 'custom-browser');
  const terminalSessions = sessions.filter(s => s.type === 'terminal');
  const vscodeSessions = sessions.filter(s => s.type === 'vscode');

  return (
    <div className="space-y-6 mx-auto text-sm">
      
      {/* Top Banner Area (Restores & Notifications) */}
      <div className="space-y-3">
        {sessions.length > 0 && (
          <div className="glass rounded-xl p-4 border border-teal-500/30 bg-teal-500/10 flex items-center gap-4 animate-in fade-in">
            <span className="text-2xl">💾</span>
            <div>
              <h4 className="text-white font-semibold">Sessions Restored</h4>
              <p className="text-teal-100/70 text-xs mt-0.5">
                {sessions.length} session(s) active from previous runs. Credentials and tunnels preserved.
              </p>
            </div>
          </div>
        )}

        {result && (
          <div className="glass rounded-xl p-3 border border-white/20 bg-white/5 animate-in slide-in-from-top-2">
            <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono m-0">{result}</pre>
          </div>
        )}
      </div>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN: Controls & Launchpad */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Stats Widget */}
          <div className="glass rounded-2xl p-5 border border-white/10 grid grid-cols-2 gap-4">
            <div className="col-span-2 flex justify-between items-end border-b border-white/5 pb-3">
              <span className="text-white/50 font-medium">Total Workloads</span>
              <span className="text-3xl font-bold text-white">{totalSessions}</span>
            </div>
            <div>
              <div className="text-indigo-400 font-bold text-lg">{dockerSessions.length}</div>
              <div className="text-white/40 text-[10px] uppercase tracking-wider">Docker</div>
            </div>
            <div>
              <div className="text-teal-400 font-bold text-lg">{customBrowserSessions.length + browsers.length}</div>
              <div className="text-white/40 text-[10px] uppercase tracking-wider">Browsers</div>
            </div>
            <div>
              <div className="text-purple-400 font-bold text-lg">{terminalSessions.length}</div>
              <div className="text-white/40 text-[10px] uppercase tracking-wider">Terminals</div>
            </div>
            <div>
              <div className="text-blue-400 font-bold text-lg">{vscodeSessions.length}</div>
              <div className="text-white/40 text-[10px] uppercase tracking-wider">VSCode</div>
            </div>
          </div>

          {/* Quick Launch: Browser */}
          <div className="glass rounded-2xl p-5 border border-white/10 flex flex-col gap-3 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10 text-4xl pointer-events-none">🌐</div>
            <h3 className="font-semibold text-white">Quick Browser</h3>
            <div className="flex gap-2 relative z-10">
              <input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white focus:border-teal-500 focus:outline-none transition-colors"
              />
              <button
                onClick={startCustomBrowser}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-teal-500/20 text-teal-400 border border-teal-500/30 hover:bg-teal-500/30 disabled:opacity-50 transition-all font-medium"
              >
                {loading ? '...' : 'Launch'}
              </button>
            </div>
          </div>

          {/* Launchpad: Docker */}
          <div className="glass rounded-2xl p-5 border border-white/10 space-y-4">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <span>🐋</span> Deploy Container
            </h3>
            
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Image URI</label>
                <input
                  type="text"
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="nginx:latest"
                  className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white focus:border-indigo-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Container Port</label>
                  <input type="number" value={dockerPort} onChange={(e) => setDockerPort(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white focus:border-indigo-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Local Port</label>
                  <input type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white focus:border-indigo-500 outline-none" />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Network Mode</label>
                <select value={domainMode} onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')} className="w-full px-3 py-2 rounded-lg bg-[#1E2330] border border-white/10 text-[var(--input-text)] focus:border-indigo-500 outline-none">
                  <option value="quick">Quick Tunnel (trycloudflare)</option>
                  <option value="custom">Custom Subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div className="space-y-3 animate-in fade-in duration-200">
                  <input type="text" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="whoami.yourdomain.com" className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white focus:border-indigo-500 outline-none" />
                </div>
              )}

              <button
                onClick={deployCustomContainer}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/30 disabled:opacity-50 transition-all font-medium mt-2"
              >
                {loading ? 'Deploying...' : 'Deploy Instance'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Active Workloads & Tabs */}
        <div className="lg:col-span-8 glass rounded-2xl border border-white/10 overflow-hidden flex flex-col h-full min-h-[600px]">
          
          {/* Tabs Header */}
          <div className="flex overflow-x-auto border-b border-white/10 bg-white/5 scrollbar-hide">
            {(['all', 'docker', 'browser', 'terminal', 'vscode', 'android'] as TabType[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-5 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap transition-colors border-b-2 ${
                  activeTab === tab 
                    ? 'border-indigo-400 text-white bg-white/5' 
                    : 'border-transparent text-white/40 hover:text-white hover:bg-white/5'
                }`}
              >
                {tab === 'all' ? 'All Workloads' : tab}
              </button>
            ))}
          </div>

          {/* Tab Content Area */}
          <div className="p-5 flex-1 overflow-y-auto space-y-3">
            
            {/* Helper to render Session Cards cleanly */}
            {(() => {
              const SessionCard = ({ session, icon, accent }: { session: Session, icon: string, accent: string }) => (
                <div className="bg-black/20 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-colors group">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="text-2xl mt-1 opacity-80">{icon}</div>
                      <div className="space-y-1.5 flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium truncate">
                            {session.metadata?.containerName || session.metadata?.targetUrl || `${session.type} Session`}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-${accent}-500/10 text-${accent}-400 border border-${accent}-500/20`}>
                            {session.type.replace('-container', '')}
                          </span>
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <div className="flex items-center gap-2 text-white/50 truncate">
                            🔗 <button onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)} className="hover:text-white truncate">{session.metadata?.cloudflaredUrl || session.url}</button>
                          </div>
                          <div className="text-white/50 truncate">
                            ⏱️ {new Date(session.startedAt).toLocaleTimeString()}
                          </div>
                          {session.username && (
                            <div className="text-white/50">👤 User: <button onClick={() => copyToClipboard(session.username!)} className="hover:text-white">{session.username}</button></div>
                          )}
                          {session.password && (
                            <div className="text-white/50">🔑 Pass: <button onClick={() => copyToClipboard(session.password!)} className="hover:text-white">********</button></div>
                          )}
                          {session.metadata?.port && (
                            <div className="text-white/50">🔌 Port: {session.metadata.port}</div>
                          )}
                          {session.type === 'docker-container' && session.metadata?.webhookSecret && (
                            <div className="col-span-1 sm:col-span-2 flex items-center gap-1.5 text-white/50 truncate mt-1">
                              ⚓ Webhook: <button onClick={() => copyToClipboard(`${BASE.startsWith('http') ? BASE : window.location.origin}/api/webhook/docker/${session.id}?secret=${session.metadata?.webhookSecret}`)} className="hover:text-white truncate text-[11px] font-mono text-indigo-400">
                                {`${BASE.startsWith('http') ? BASE : window.location.origin}/api/webhook/docker/${session.id}?secret=${session.metadata?.webhookSecret}`}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {session.type === 'docker-container' && (
                        <button onClick={() => startEditing(session)} className="px-3 py-1.5 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 text-xs transition-colors">Edit</button>
                      )}
                      <button onClick={() => stopSession(session.id, session.type)} className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 text-xs transition-colors">Stop</button>
                    </div>
                  </div>
                </div>
              );

              const elements = [];

              if ((activeTab === 'all' || activeTab === 'docker') && dockerSessions.length > 0) {
                dockerSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="🐋" accent="indigo" />));
              }
              if ((activeTab === 'all' || activeTab === 'browser') && customBrowserSessions.length > 0) {
                customBrowserSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="🌐" accent="teal" />));
              }
              if ((activeTab === 'all' || activeTab === 'browser') && browsers.length > 0) {
                browsers.forEach((b, i) => elements.push(
                  <div key={`gb-${i}`} className="bg-black/20 rounded-xl p-4 border border-white/5">
                    <div className="flex items-center gap-3"><span className="text-xl">🌍</span><div className="text-white font-medium">General Browser</div></div>
                    <div className="mt-2 text-xs text-white/50 pl-8 space-y-1">
                      <div>🔗 {b.url}</div>
                      <div>👤 {b.username} · 🔑 {b.password} · 🔌 Port {b.port}</div>
                    </div>
                  </div>
                ));
              }
              if ((activeTab === 'all' || activeTab === 'terminal') && terminalSessions.length > 0) {
                terminalSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="💻" accent="purple" />));
              }
              if ((activeTab === 'all' || activeTab === 'vscode') && vscodeSessions.length > 0) {
                vscodeSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="⚡" accent="blue" />));
              }
              if ((activeTab === 'all' || activeTab === 'android') && android) {
                elements.push(
                  <div key="android" className="bg-black/20 rounded-xl p-4 border border-white/5">
                    <div className="flex items-center gap-3"><span className="text-xl">📱</span><div className="text-white font-medium">{android.deviceInfo || 'Android Emulator'}</div></div>
                    <div className="mt-2 text-xs text-white/50 pl-8 space-y-1">
                      <div>🔗 {android.webUrl || 'N/A'}</div>
                      <div>⏱️ Uptime: {android.uptime || 'Unknown'}</div>
                    </div>
                  </div>
                );
              }

              if (elements.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                    <span className="text-4xl">📭</span>
                    <p>No active workloads in this category.</p>
                  </div>
                );
              }

              return elements;
            })()}
          </div>
        </div>
      </div>

      {/* MODAL: Edit Docker Container (Simplified & Centered) */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg glass rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl flex flex-col max-h-[90vh]">
            
            <div className="p-5 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h3 className="font-semibold text-white flex items-center gap-2">⚙️ Edit Container Config</h3>
              <button onClick={() => setEditingSession(null)} className="text-white/40 hover:text-white p-1">✕</button>
            </div>
            
            <div className="p-5 overflow-y-auto space-y-4">
              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase">Image URI</label>
                <input type="text" value={editImage} onChange={(e) => setEditImage(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-indigo-500" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Container Port</label>
                  <input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Local Port</label>
                  <input type="number" value={editHostPort} onChange={(e) => setEditHostPort(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-indigo-500" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Instance Name</label>
                  <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Domain Mode</label>
                  <select value={editDomainMode} onChange={(e) => setEditDomainMode(e.target.value as 'quick' | 'custom')} className="w-full mt-1 px-3 py-2 rounded-lg bg-[#1E2330] border border-white/10 text-[var(--input-text)] outline-none focus:border-indigo-500">
                    <option value="quick">Quick Tunnel</option>
                    <option value="custom">Custom Domain</option>
                  </select>
                </div>
              </div>

              {editDomainMode === 'custom' && (
                <div className="space-y-4 animate-in fade-in">
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase">Custom Subdomain</label>
                    <input type="text" value={editCustomDomain} onChange={(e) => setEditCustomDomain(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-indigo-500" />
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase">Environment Variables</label>
                <textarea value={editEnv} onChange={(e) => setEditEnv(e.target.value)} rows={4} placeholder="KEY=VALUE" className="w-full mt-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white font-mono text-xs outline-none focus:border-indigo-500" />
              </div>
            </div>

            <div className="p-5 border-t border-white/10 flex justify-end gap-3 bg-white/5">
              <button onClick={() => setEditingSession(null)} disabled={loading} className="px-4 py-2 rounded-lg text-white/60 hover:bg-white/10 transition-colors">Cancel</button>
              <button onClick={saveEditedContainer} disabled={loading} className="px-4 py-2 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-colors font-medium">
                {loading ? 'Redeploying...' : 'Save & Redeploy'}
              </button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}