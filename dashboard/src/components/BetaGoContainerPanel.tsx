import React, { useState, useEffect } from 'react';
import { api, BASE } from '../api';
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

interface ServiceConfig {
  image: string;
  ports: string[];
  environment: Record<string, string>;
  volumes: string[];
  labels: Record<string, string>;
}

interface NormalizedCompose {
  version: string;
  services: Record<string, ServiceConfig>;
  volumes: string[];
}

export default function BetaGoContainerPanel() {
  const [sessions, setSessions] = useState<GoSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [activeTab, setActiveTab] = useState<'single' | 'compose'>('single');

  // Single Workload Deploy States
  const [image, setImage] = useState('');
  const [port, setPort] = useState('80');
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('16000');

  // Compose Deploy States
  const [yamlInput, setYamlInput] = useState<string>(`version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    environment:
      - PORT=80
      - APP_ENV=production
    volumes:
      - web_data:/usr/share/nginx/html
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: main_db
      POSTGRES_USER: postgres
    volumes:
      - db_data:/var/lib/postgresql/data
volumes:
  web_data:
  db_data:`);
  const [parsedCompose, setParsedCompose] = useState<NormalizedCompose | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [serviceSettings, setServiceSettings] = useState<Record<string, {
    domainMode: 'none' | 'quick' | 'custom';
    customDomain: string;
    env: Record<string, string>;
  }>>({});
  const [backupVolumes, setBackupVolumes] = useState<Record<string, boolean>>({});

  // Edit States for Single Workloads
  const [editingSession, setEditingSession] = useState<GoSession | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('16000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
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
        hostPortNum
      );

      if (res.error) throw new Error(res.error);

      setResult(`✅ Go Container started!\nURL: ${res.url}\nContainer: ${res.containerName}`);
      setImage(''); setName(''); setEnv(''); setCustomDomain('');
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

  const handleParseYAML = async () => {
    setIsParsing(true);
    setParseError(null);
    try {
      const res = await fetch('http://localhost:18080/api/go/containers/compose/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: yamlInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Parsing failed');
      }
      setParsedCompose(data);
      setResult('✅ Successfully parsed Compose configuration!');

      const initialSettings: typeof serviceSettings = {};
      Object.entries(data.services).forEach(([sName, svc]: [string, any]) => {
        initialSettings[sName] = {
          domainMode: 'none',
          customDomain: '',
          env: { ...svc.environment }
        };
      });
      setServiceSettings(initialSettings);

      const initialBackups: Record<string, boolean> = {};
      data.volumes.forEach((vol: string) => {
        initialBackups[vol] = false;
      });
      setBackupVolumes(initialBackups);
    } catch (e: any) {
      setParseError(e.message);
      setParsedCompose(null);
      setResult(`❌ Parse error: ${e.message}`);
    } finally {
      setIsParsing(false);
    }
  };

  const handleServiceSettingChange = (serviceName: string, field: string, value: any) => {
    setServiceSettings(prev => ({
      ...prev,
      [serviceName]: {
        ...prev[serviceName],
        [field]: value
      }
    }));
  };

  const handleServiceEnvChange = (serviceName: string, envKey: string, value: string) => {
    setServiceSettings(prev => ({
      ...prev,
      [serviceName]: {
        ...prev[serviceName],
        env: {
          ...prev[serviceName].env,
          [envKey]: value
        }
      }
    }));
  };

  const handleDeployCompose = () => {
    setResult('✅ Deployment simulation successful! Compose payload ready.');
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
        undefined,
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
          Beta Container Panel managed by the Go service daemon on port 18080. Deploy container nodes or manage complex multi-service Docker Compose systems.
        </p>

        {/* Tab switcher */}
        <div className="flex gap-2 border-b border-white/5 pb-3">
          <Button
            onClick={() => setActiveTab('single')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'single' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            🐋 Single Container Deployer
          </Button>
          <Button
            onClick={() => setActiveTab('compose')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'compose' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            ⚡ Multi-Service Compose (Visual)
          </Button>
        </div>

        {result && (
          <div className="glass rounded-xl p-3 border border-[#00E5FF]/30 bg-[#00E5FF]/5 animate-in slide-in-from-top-2">
            <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono m-0">{result}</pre>
          </div>
        )}
      </div>

      {activeTab === 'single' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Form */}
          <div className="lg:col-span-4 space-y-6">
            <Card className="glass border border-white/10 rounded-2xl p-5 space-y-4">
              <CardHeader className="p-0">
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <span>🐋</span> Go Workload Deployer
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
                    className="w-full h-9 px-3 rounded-lg bg-[#1E2330] border border-white/10 text-white text-xs outline-none focus:border-indigo-500"
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
                          🔗 Public URL: <a href={sess.metadata?.cloudflaredUrl || sess.url} target="_blank" rel="noopener noreferrer" className="text-[#00E5FF] hover:underline font-mono text-[11px]">
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
      ) : (
        /* Compose Editor Tab */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* YAML Editor */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <Card className="glass border border-white/10 rounded-2xl p-5 flex flex-col flex-1 min-h-[450px]">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">📝</span>
                  <h3 className="font-bold text-white text-sm m-0">Docker Compose Configuration</h3>
                </div>
                <Button 
                  onClick={handleParseYAML}
                  disabled={isParsing}
                  className="h-8 px-4 rounded-lg bg-[#0061FF] hover:bg-[#004ecb] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  {isParsing ? 'Parsing...' : 'Parse YAML'}
                </Button>
              </div>

              <div className="flex-1 relative rounded-xl border border-white/10 overflow-hidden bg-[#11151F] min-h-[350px]">
                <textarea
                  value={yamlInput}
                  onChange={(e) => setYamlInput(e.target.value)}
                  className="w-full h-full p-4 font-mono text-xs bg-transparent border-0 outline-none resize-none text-emerald-400 focus:ring-0"
                />
              </div>

              {parseError && (
                <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  ⚠️ {parseError}
                </div>
              )}
            </Card>
          </div>

          {/* Visual Setup Panel */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            {parsedCompose ? (
              <Card className="glass border border-white/10 rounded-2xl p-5 flex flex-col gap-5">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-white text-sm m-0">Compose Services</h3>
                  <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-300">
                    Version: {parsedCompose.version}
                  </Badge>
                </div>

                <div className="flex flex-col gap-4 overflow-y-auto max-h-[350px] pr-1 scrollbar-thin">
                  {Object.entries(parsedCompose.services).map(([sName, svc]) => (
                    <div key={sName} className="p-3.5 rounded-xl border border-white/5 bg-black/20 flex flex-col gap-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="text-xs font-bold text-white m-0">{sName}</h4>
                          <span className="text-[10px] text-white/40 block mt-0.5">{svc.image}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] text-white/50 font-bold uppercase">Domain Routing</label>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(['none', 'quick', 'custom'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => handleServiceSettingChange(sName, 'domainMode', mode)}
                              className={`py-1 rounded-lg border text-[10px] font-bold capitalize transition-all ${
                                serviceSettings[sName]?.domainMode === mode
                                  ? 'bg-[#0061FF]/20 border-[#0061FF] text-white'
                                  : 'border-white/5 bg-transparent hover:bg-white/5 text-white/40'
                              }`}
                            >
                              {mode === 'none' ? 'None' : mode === 'quick' ? 'Quick' : 'Custom'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {serviceSettings[sName]?.domainMode === 'custom' && (
                        <div className="animate-in fade-in duration-200">
                          <label className="text-[10px] text-white/50 font-bold uppercase">Subdomain URL</label>
                          <Input
                            type="text"
                            placeholder="app.mydomain.com"
                            value={serviceSettings[sName]?.customDomain || ''}
                            onChange={(e) => handleServiceSettingChange(sName, 'customDomain', e.target.value)}
                            className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs mt-1"
                          />
                        </div>
                      )}

                      {Object.keys(svc.environment).length > 0 && (
                        <div className="flex flex-col gap-1.5 mt-1">
                          <label className="text-[10px] text-white/50 font-bold uppercase">Env Variables</label>
                          <div className="space-y-1.5">
                            {Object.entries(svc.environment).map(([k]) => (
                              <div key={k} className="flex gap-2 items-center">
                                <span className="text-[10px] font-mono text-white/40 shrink-0 w-24 truncate">{k}</span>
                                <input
                                  type="text"
                                  value={serviceSettings[sName]?.env[k] || ''}
                                  onChange={(e) => handleServiceEnvChange(sName, k, e.target.value)}
                                  className="flex-1 bg-black/20 border border-white/10 rounded-lg py-1 px-2 text-xs focus:outline-none focus:border-indigo-500 text-white"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {parsedCompose.volumes.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-[10px] text-white/50 font-bold uppercase">Volume Backup to R2</label>
                    <div className="space-y-1.5">
                      {parsedCompose.volumes.map((vol) => (
                        <label key={vol} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-white/5 bg-black/10 cursor-pointer hover:bg-white/5 transition-all">
                          <input
                            type="checkbox"
                            checked={backupVolumes[vol] || false}
                            onChange={(e) => setBackupVolumes(prev => ({ ...prev, [vol]: e.target.checked }))}
                            className="rounded border-white/15 text-indigo-500 bg-black/20 focus:ring-0"
                          />
                          <span className="text-xs text-white/80 font-medium">{vol}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleDeployCompose}
                  className="w-full py-2.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-bold text-xs tracking-wide"
                >
                  🚀 Deploy System Stack
                </Button>
              </Card>
            ) : (
              <Card className="glass border border-white/10 rounded-2xl p-8 flex flex-col items-center justify-center text-center flex-1 border-dashed min-h-[400px]">
                <span className="text-4xl mb-3">📦</span>
                <h4 className="text-sm font-bold text-white">Visual Setup panel</h4>
                <p className="text-xs text-white/40 mt-1 max-w-[240px]">
                  Parse your Docker Compose configuration on the left to configure domains, overrides, and backup endpoints.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}

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
                  <select value={editDomainMode} onChange={(e) => setEditDomainMode(e.target.value as 'quick' | 'custom')} className="w-full h-9 px-3 rounded-lg bg-[#1E2330] border border-white/10 text-white text-xs outline-none focus:border-indigo-500">
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
