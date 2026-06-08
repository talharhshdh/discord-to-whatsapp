import React, { useState, useEffect } from 'react';
import { api, BASE, SessionResult } from '../api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface GoSession {
  id: string;
  type: string;
  url: string;
  startedAt: string;
  metadata?: {
    port?: number;
    hostPort?: number;
    containerName?: string;
    image?: string;
    env?: Record<string, string>;
    domainMode?: 'quick' | 'custom';
    customDomain?: string;
    cloudflaredUrl?: string;
    webhookSecret?: string;
    tunnelToken?: string;
    tunnelId?: string;
  };
}

export default function BetaGoContainerPanel() {
  const [sessions, setSessions] = useState<GoSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');

  // Deploy States
  const [image, setImage] = useState('');
  const [port, setPort] = useState('80');
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('16000');
  const [tunnelToken, setTunnelToken] = useState('');

  // Edit States
  const [editingSession, setEditingSession] = useState<GoSession | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('16000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
  const [editTunnelToken, setEditTunnelToken] = useState('');
  const [editEnv, setEditEnv] = useState('');

  const loadSessions = async () => {
    try {
      const data = await api.getGoSessions();
      setSessions(data || []);
    } catch (err) {
      console.error('Failed to load Go sessions:', err);
    }
  };

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image) return setResult('❌ Please enter a Docker Image URI');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('❌ Invalid container port');
    const hostPortNum = parseInt(hostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('❌ Invalid host port');

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      env.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      });

      const res = await api.startGoDocker(
        image,
        portNum,
        envObj,
        name || undefined,
        domainMode,
        domainMode === 'custom' ? customDomain : undefined,
        hostPortNum,
        domainMode === 'custom' ? (tunnelToken || undefined) : undefined
      );

      if (res.error) throw new Error(res.error);

      setResult(`✅ Go Container started!\nURL: ${res.url}\nContainer: ${res.containerName}`);
      setImage(''); setName(''); setEnv(''); setCustomDomain(''); setTunnelToken('');
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async (sessionId: string) => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.stopGoDocker(sessionId);
      if (res.success) {
        setResult(`✅ ${res.message}`);
      } else {
        setResult(`❌ ${res.message}`);
      }
      await loadSessions();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const startEditing = (session: GoSession) => {
    setEditingSession(session);
    setEditImage(session.metadata?.image || '');
    setEditPort(session.metadata?.port?.toString() || '80');
    setEditHostPort(session.metadata?.hostPort?.toString() || '16000');
    
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

  const handleSaveEdit = async () => {
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

      const res = await api.startGoDocker(
        editImage,
        portNum,
        envObj,
        editName || undefined,
        editDomainMode,
        editDomainMode === 'custom' ? editCustomDomain : undefined,
        hostPortNum,
        editDomainMode === 'custom' ? (editTunnelToken || undefined) : undefined,
        editingSession.id
      );

      if (res.error) throw new Error(res.error);
      
      setResult(`✅ Go Container redeployed successfully!\nURL: ${res.url}`);
      setEditingSession(null);
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

  return (
    <div className="space-y-6 text-sm text-white">
      <div className="flex flex-col gap-2">
        <p className="text-white/40">
          Beta Container Panel managed by the Go service daemon on port 18080. Built for fast concurrent workloads and zero-overhead process spawning.
        </p>

        {result && (
          <div className="glass rounded-xl p-3 border border-[#00d4aa]/30 bg-[#00d4aa]/5 animate-in slide-in-from-top-2">
            <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono m-0">{result}</pre>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Form */}
        <div className="lg:col-span-4 space-y-6">
          <Card className="glass border border-white/10 rounded-2xl p-5 space-y-4">
            <CardHeader className="p-0">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <span className="text-indigo-400">⚡</span> Go Workload Deployer
              </CardTitle>
              <CardDescription className="text-xs text-white/40">
                Deploy container instances locally via Go.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 space-y-3">
              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Image URI</label>
                <Input
                  type="text"
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder="nginx:alpine"
                  className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Container Port</label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Local Port</label>
                  <Input
                    type="number"
                    value={hostPort}
                    onChange={(e) => setHostPort(e.target.value)}
                    className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Instance Name</label>
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                  className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Tunnel Mode</label>
                <select
                  value={domainMode}
                  onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                  className="w-full h-9 px-3 rounded-lg bg-[#161a26] border border-white/10 text-white text-xs outline-none focus:border-indigo-500"
                >
                  <option value="quick">Quick Tunnel (trycloudflare)</option>
                  <option value="custom">Custom Subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div className="space-y-3 animate-in fade-in duration-200">
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Domain</label>
                    <Input
                      type="text"
                      value={customDomain}
                      onChange={(e) => setCustomDomain(e.target.value)}
                      placeholder="app.yourdomain.com"
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Custom Tunnel Token (Optional)</label>
                    <Input
                      type="text"
                      value={tunnelToken}
                      onChange={(e) => setTunnelToken(e.target.value)}
                      placeholder="base64 tunnel token"
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Env Variables (KEY=VALUE)</label>
                <textarea
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder="PORT=80&#10;NODE_ENV=production"
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white text-xs font-mono focus:border-indigo-500 focus:outline-none transition-colors"
                />
              </div>

              <Button
                onClick={handleDeploy}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-semibold text-xs transition-all shadow-md"
              >
                {loading ? '⚡ Provisioning...' : 'Start Go Instance'}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Workloads */}
        <div className="lg:col-span-8 glass rounded-2xl border border-white/10 overflow-hidden flex flex-col h-full min-h-[500px]">
          <div className="px-5 py-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
            <h3 className="font-bold text-white text-sm">Active Go Workloads ({sessions.length})</h3>
            <Button onClick={loadSessions} variant="outline" className="h-7 px-2.5 rounded-lg text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.04]">
              🔄 Reload
            </Button>
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-4">
            {sessions.map((sess) => (
              <div key={sess.id} className="bg-black/20 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-colors group">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">🐋</span>
                      <span className="text-white font-semibold truncate">
                        {sess.metadata?.containerName || `${sess.id}`}
                      </span>
                      <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[10px]">
                        GO-DAEMON
                      </Badge>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div className="text-white/50 truncate">
                        🖼️ Image: <span className="text-white/80 font-mono text-[11px]">{sess.metadata?.image}</span>
                      </div>
                      <div className="text-white/50 truncate">
                        ⏱️ Created: <span className="text-white/80">{new Date(sess.startedAt).toLocaleString()}</span>
                      </div>
                      <div className="text-white/50 truncate col-span-1 sm:col-span-2">
                        🔗 Public URL: <a href={sess.metadata?.cloudflaredUrl || sess.url} target="_blank" rel="noopener noreferrer" className="text-[#00d4aa] hover:underline font-mono text-[11px]">
                          {sess.metadata?.cloudflaredUrl || sess.url}
                        </a>
                      </div>
                      <div className="text-white/50">
                        🔌 Ports: <span className="text-white/80 font-mono">{sess.metadata?.hostPort} → {sess.metadata?.port}</span>
                      </div>
                      <div className="text-white/50">
                        🛡️ Mode: <span className="text-white/80 capitalize">{sess.metadata?.domainMode} tunnel</span>
                      </div>

                      {sess.metadata?.webhookSecret && (
                        <div className="col-span-1 sm:col-span-2 flex items-center gap-1 text-white/50 truncate mt-1">
                          ⚓ Webhook: <button onClick={() => copyToClipboard(`${BASE.startsWith('http') ? BASE : window.location.origin}/api/webhook/docker/${sess.id}?secret=${sess.metadata?.webhookSecret}`)} className="hover:text-white truncate text-[11px] font-mono text-indigo-400">
                            {`${BASE.startsWith('http') ? BASE : window.location.origin}/api/webhook/docker/${sess.id}?secret=${sess.metadata?.webhookSecret}`}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      onClick={() => startEditing(sess)}
                      className="h-7 px-3 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/20 text-xs transition-colors"
                    >
                      Edit
                    </Button>
                    <Button
                      onClick={() => handleStop(sess.id)}
                      className="h-7 px-3 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/20 text-xs transition-colors"
                    >
                      Stop
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            {sessions.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                <span className="text-4xl">📭</span>
                <p>No active Go-managed workloads found.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL: Edit Container */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg glass rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h3 className="font-semibold text-white flex items-center gap-2">⚙️ Edit Go Container</h3>
              <button onClick={() => setEditingSession(null)} className="text-white/40 hover:text-white p-1">✕</button>
            </div>
            
            <div className="p-5 overflow-y-auto space-y-4">
              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase">Image URI</label>
                <Input type="text" value={editImage} onChange={(e) => setEditImage(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Container Port</label>
                  <Input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Local Port</label>
                  <Input type="number" value={editHostPort} onChange={(e) => setEditHostPort(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Instance Name</label>
                  <Input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase">Domain Mode</label>
                  <select value={editDomainMode} onChange={(e) => setEditDomainMode(e.target.value as 'quick' | 'custom')} className="w-full h-9 px-3 rounded-lg bg-[#161a26] border border-white/10 text-white text-xs outline-none focus:border-indigo-500">
                    <option value="quick">Quick Tunnel</option>
                    <option value="custom">Custom Domain</option>
                  </select>
                </div>
              </div>

              {editDomainMode === 'custom' && (
                <div className="space-y-4 animate-in fade-in">
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase">Custom Subdomain</label>
                    <Input type="text" value={editCustomDomain} onChange={(e) => setEditCustomDomain(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
                  </div>
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase">Tunnel Token</label>
                    <Input type="text" value={editTunnelToken} onChange={(e) => setEditTunnelToken(e.target.value)} className="bg-black/40 border-white/10 focus:border-indigo-500 rounded-lg text-xs" />
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] text-white/50 font-bold uppercase">Environment Variables (KEY=VALUE)</label>
                <textarea value={editEnv} onChange={(e) => setEditEnv(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white font-mono text-xs focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>

            <div className="p-5 border-t border-white/10 flex justify-end gap-3 bg-white/5">
              <Button onClick={() => setEditingSession(null)} disabled={loading} className="h-9 rounded-lg text-white/60 bg-transparent hover:bg-white/10 border-0 text-xs">Cancel</Button>
              <Button onClick={handleSaveEdit} disabled={loading} className="h-9 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 text-xs transition-colors font-medium">
                {loading ? 'Redeploying...' : 'Save & Redeploy'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
