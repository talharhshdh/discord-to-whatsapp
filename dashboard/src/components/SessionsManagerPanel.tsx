import { useState, useEffect } from 'react';
import { BASE } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [browsers, setBrowsers] = useState<any[]>([]);
  const [android, setAndroid] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');

  const [activeTab, setActiveTab] = useState<TabType>('all');

  const [customUrl, setCustomUrl] = useState('');

  const [dockerImage, setDockerImage] = useState('');
  const [dockerPort, setDockerPort] = useState('80');
  const [dockerName, setDockerName] = useState('');
  const [dockerEnv, setDockerEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('15000');
  const [tunnelToken, setTunnelToken] = useState('');

  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('15000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
  const [editTunnelToken, setEditTunnelToken] = useState('');
  const [editEnv, setEditEnv] = useState('');

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
    if (!editImage) return setResult('[ERROR] Please enter a Docker Image URI');

    const portNum = parseInt(editPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('[ERROR] Invalid container port');

    const hostPortNum = parseInt(editHostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('[ERROR] Invalid host port');

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

      setResult(`[SUCCESS] Redeployed container!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setEditingSession(null);
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
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
      setResult(data.success ? `[SUCCESS] ${data.message}` : `[ERROR] ${data.message}`);
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const startCustomBrowser = async () => {
    if (!customUrl) return setResult('[ERROR] Please enter a URL');
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

      setResult(`[SUCCESS] Browser started!\nURL: ${data.url}\nUser: ${data.username} | Pass: ${data.password}`);
      setCustomUrl('');
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const deployCustomContainer = async () => {
    if (!dockerImage) return setResult('[ERROR] Please enter a Docker Image URI');
    const portNum = parseInt(dockerPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('[ERROR] Invalid container port');
    const hostPortNum = parseInt(hostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('[ERROR] Invalid host port');

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

      setResult(`[SUCCESS] Container started!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setDockerImage(''); setDockerName(''); setDockerEnv(''); setCustomDomain(''); setTunnelToken('');
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult('COPIED TO CLIPBOARD');
    setTimeout(() => setResult(''), 2000);
  };

  const totalSessions = sessions.length + browsers.length + (android ? 1 : 0);
  const dockerSessions = sessions.filter(s => s.type === 'docker-container');
  const customBrowserSessions = sessions.filter(s => s.type === 'custom-browser');
  const terminalSessions = sessions.filter(s => s.type === 'terminal');
  const vscodeSessions = sessions.filter(s => s.type === 'vscode');

  return (
    <div className="space-y-4 mx-auto text-sm font-mono">
      {/* Top Notification Banner */}
      <div className="space-y-2">
        {sessions.length > 0 && (
          <div className="border border-border bg-secondary p-3 flex items-center gap-3">
            <span className="text-xl">💾</span>
            <div>
              <h4 className="text-foreground font-bold text-xs uppercase tracking-wider">Active Workloads Preserved</h4>
              <p className="text-muted-foreground text-xs mt-0.5">
                {sessions.length} workload(s) running with Cloudflare secure tunnels.
              </p>
            </div>
          </div>
        )}

        {result && (
          <div className="border border-border bg-secondary p-3">
            <pre className="text-xs text-foreground whitespace-pre-wrap font-mono m-0">{result}</pre>
          </div>
        )}
      </div>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* LEFT COLUMN: Controls */}
        <div className="lg:col-span-4 space-y-4">
          {/* Stats Widget */}
          <Card className="border border-border bg-card p-4 grid grid-cols-2 gap-3">
            <div className="col-span-2 flex justify-between items-end border-b border-border pb-2">
              <span className="text-muted-foreground text-xs uppercase font-bold">Total Workloads</span>
              <span className="text-2xl font-bold text-foreground font-mono">{totalSessions}</span>
            </div>
            <div>
              <div className="text-foreground font-bold text-base font-mono">{dockerSessions.length}</div>
              <div className="text-muted-foreground text-[10px] uppercase">Docker</div>
            </div>
            <div>
              <div className="text-foreground font-bold text-base font-mono">{customBrowserSessions.length + browsers.length}</div>
              <div className="text-muted-foreground text-[10px] uppercase">Browsers</div>
            </div>
            <div>
              <div className="text-foreground font-bold text-base font-mono">{terminalSessions.length}</div>
              <div className="text-muted-foreground text-[10px] uppercase">Terminals</div>
            </div>
            <div>
              <div className="text-foreground font-bold text-base font-mono">{vscodeSessions.length}</div>
              <div className="text-muted-foreground text-[10px] uppercase">VSCode</div>
            </div>
          </Card>

          {/* Quick Launch: Browser */}
          <Card className="border border-border bg-card p-4 space-y-2">
            <CardTitle className="text-xs uppercase tracking-wider text-foreground">🌐 Quick Web Browser</CardTitle>
            <div className="flex gap-2">
              <Input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 text-xs"
              />
              <Button
                onClick={startCustomBrowser}
                disabled={loading}
                variant="outline"
                size="sm"
                className="font-mono text-xs uppercase"
              >
                LAUNCH
              </Button>
            </div>
          </Card>

          {/* Launchpad: Docker */}
          <Card className="border border-border bg-card p-4 space-y-3">
            <CardTitle className="text-xs uppercase tracking-wider text-foreground">🐋 Deploy Container Instance</CardTitle>

            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Image URI</label>
                <Input
                  type="text"
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="nginx:latest"
                  className="w-full text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Port</label>
                  <Input type="number" value={dockerPort} onChange={(e) => setDockerPort(e.target.value)} className="w-full text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Host Port</label>
                  <Input type="number" value={hostPort} onChange={(e) => setHostPort(e.target.value)} className="w-full text-xs" />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Network Mode</label>
                <select
                  value={domainMode}
                  onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                  className="w-full border border-border bg-secondary px-2.5 py-1.5 text-xs text-foreground outline-none"
                >
                  <option value="quick">Quick Tunnel (trycloudflare)</option>
                  <option value="custom">Custom Subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div>
                  <Input type="text" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="whoami.yourdomain.com" className="w-full text-xs" />
                </div>
              )}

              <div>
                <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Environment Variables</label>
                <textarea
                  value={dockerEnv}
                  onChange={(e) => setDockerEnv(e.target.value)}
                  rows={2}
                  placeholder={"KEY=VALUE\nOTHER_KEY=123"}
                  className="w-full border border-border bg-background p-2 font-mono text-xs text-foreground outline-none resize-y"
                />
              </div>

              <Button
                onClick={deployCustomContainer}
                disabled={loading}
                className="w-full font-mono text-xs uppercase font-bold mt-1"
              >
                {loading ? 'DEPLOYING...' : 'DEPLOY CONTAINER'}
              </Button>
            </div>
          </Card>
        </div>

        {/* RIGHT COLUMN: Workloads List */}
        <div className="lg:col-span-8 border border-border bg-card flex flex-col min-h-[500px]">
          {/* Tabs Header */}
          <div className="flex border-b border-border bg-secondary overflow-x-auto">
            {(['all', 'docker', 'browser', 'terminal', 'vscode', 'android'] as TabType[]).map((tab) => (
              <Button
                key={tab}
                onClick={() => setActiveTab(tab)}
                variant="ghost"
                size="sm"
                className={`font-mono text-xs uppercase ${activeTab === tab
                  ? 'bg-foreground text-background font-bold border-b-2 border-foreground'
                  : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'all' ? 'All Workloads' : tab}
              </Button>
            ))}
          </div>

          {/* Workload List Content */}
          <div className="p-4 flex-1 overflow-y-auto space-y-2.5">
            {(() => {
              const SessionCard = ({ session, icon }: { session: Session, icon: string }) => (
                <div className="bg-secondary p-3 border border-border flex items-start justify-between gap-3 group">
                  <div className="flex items-start gap-2.5 flex-1 min-w-0">
                    <div className="text-xl mt-0.5">{icon}</div>
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground font-bold text-xs truncate">
                          {session.metadata?.containerName || session.metadata?.targetUrl || `${session.type.toUpperCase()} SESSION`}
                        </span>
                        <Badge variant="outline" className="text-[9px]">
                          {session.type.replace('-container', '').toUpperCase()}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
                        <div className="flex items-center gap-1 text-muted-foreground truncate">
                          🔗 <button onClick={() => copyToClipboard(session.metadata?.cloudflaredUrl || session.url)} className="text-foreground underline truncate">{session.metadata?.cloudflaredUrl || session.url}</button>
                        </div>
                        <div className="text-muted-foreground truncate">
                          ⏱ {new Date(session.startedAt).toLocaleTimeString()}
                        </div>
                        {session.username && (
                          <div className="text-muted-foreground">USER: <span className="text-foreground">{session.username}</span></div>
                        )}
                        {session.password && (
                          <div className="text-muted-foreground">PASS: <span className="text-foreground">{session.password}</span></div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-1.5 shrink-0">
                    {session.type === 'docker-container' && (
                      <Button onClick={() => startEditing(session)} variant="outline" size="xs" className="font-mono text-[10px]">EDIT</Button>
                    )}
                    <Button onClick={() => stopSession(session.id, session.type)} variant="outline" size="xs" className="font-mono text-[10px]">STOP</Button>
                  </div>
                </div>
              );

              const elements = [];

              if ((activeTab === 'all' || activeTab === 'docker') && dockerSessions.length > 0) {
                dockerSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="🐋" />));
              }
              if ((activeTab === 'all' || activeTab === 'browser') && customBrowserSessions.length > 0) {
                customBrowserSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="🌐" />));
              }
              if ((activeTab === 'all' || activeTab === 'browser') && browsers.length > 0) {
                browsers.forEach((b, i) => elements.push(
                  <div key={`gb-${i}`} className="bg-secondary p-3 border border-border flex items-start gap-2.5">
                    <span className="text-xl">🌍</span>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <div className="text-foreground font-bold">General Browser Pool</div>
                      <div>🔗 {b.url}</div>
                      <div>USER: {b.username} · PASS: {b.password} · PORT: {b.port}</div>
                    </div>
                  </div>
                ));
              }
              if ((activeTab === 'all' || activeTab === 'terminal') && terminalSessions.length > 0) {
                terminalSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="💻" />));
              }
              if ((activeTab === 'all' || activeTab === 'vscode') && vscodeSessions.length > 0) {
                vscodeSessions.forEach(s => elements.push(<SessionCard key={s.id} session={s} icon="⚡" />));
              }
              if ((activeTab === 'all' || activeTab === 'android') && android) {
                elements.push(
                  <div key="android" className="bg-secondary p-3 border border-border flex items-start gap-2.5">
                    <span className="text-xl">📱</span>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <div className="text-foreground font-bold">{android.deviceInfo || 'Android Emulator'}</div>
                      <div>🔗 {android.webUrl || 'N/A'}</div>
                      <div>UPTIME: {android.uptime || 'Unknown'}</div>
                    </div>
                  </div>
                );
              }

              if (elements.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground space-y-1 py-16">
                    <span className="text-2xl">📭</span>
                    <p className="text-xs font-mono">No active workloads in this category.</p>
                  </div>
                );
              }

              return elements;
            })()}
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <Card className="w-full max-w-lg border border-border bg-card p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center pb-2 border-b border-border">
              <CardTitle className="text-xs uppercase font-mono tracking-wider text-foreground">⚙️ Edit Container Config</CardTitle>
              <Button variant="ghost" size="xs" onClick={() => setEditingSession(null)}>✕</Button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Image URI</label>
                <Input type="text" value={editImage} onChange={(e) => setEditImage(e.target.value)} className="w-full text-xs" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Container Port</label>
                  <Input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)} className="w-full text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Host Port</label>
                  <Input type="number" value={editHostPort} onChange={(e) => setEditHostPort(e.target.value)} className="w-full text-xs" />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Environment Variables</label>
                <textarea value={editEnv} onChange={(e) => setEditEnv(e.target.value)} rows={4} placeholder="KEY=VALUE" className="w-full border border-border bg-background p-2 font-mono text-xs text-foreground outline-none resize-y" />
              </div>
            </div>

            <div className="pt-3 border-t border-border flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingSession(null)} className="font-mono text-xs uppercase">Cancel</Button>
              <Button onClick={saveEditedContainer} disabled={loading} size="sm" className="font-mono text-xs uppercase">
                {loading ? 'REDEPLOYING...' : 'SAVE & REDEPLOY'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}