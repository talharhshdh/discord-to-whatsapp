import React, { useState, useEffect } from 'react';
import { api, WhatsAppAccount } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export default function WhatsAppPanel() {
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add Account form state
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Broadcast state
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastSuccess, setBroadcastSuccess] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);

  const fetchAccounts = async () => {
    try {
      const data = await api.getWhatsAppAccounts();
      setAccounts(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch WhatsApp accounts');
    }
  };

  useEffect(() => {
    fetchAccounts();
    const interval = setInterval(fetchAccounts, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newId || !newName) return;
    setAddLoading(true);
    setAddError(null);
    try {
      await api.addWhatsAppAccount(newId.trim(), newName.trim());
      setNewId('');
      setNewName('');
      fetchAccounts();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add account');
    } finally {
      setAddLoading(false);
    }
  };

  const handleConnect = async (id: string) => {
    try {
      await api.connectWhatsAppAccount(id);
      fetchAccounts();
    } catch (err: any) {
      setError(err.message || `Failed to connect account ${id}`);
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await api.disconnectWhatsAppAccount(id);
      fetchAccounts();
    } catch (err: any) {
      setError(err.message || `Failed to disconnect account ${id}`);
    }
  };

  const handleReconnect = async (id: string) => {
    try {
      await api.reconnectWhatsAppAccount(id);
      fetchAccounts();
    } catch (err: any) {
      setError(err.message || `Failed to reconnect account ${id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Are you sure you want to delete account "${id}"? This will clean up all associated login credentials.`)) {
      return;
    }
    try {
      await api.deleteWhatsAppAccount(id);
      fetchAccounts();
    } catch (err: any) {
      setError(err.message || `Failed to delete account ${id}`);
    }
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastText.trim()) return;
    setBroadcastLoading(true);
    setBroadcastSuccess(false);
    setBroadcastError(null);
    try {
      await api.sendWhatsAppBroadcast(broadcastText);
      setBroadcastText('');
      setBroadcastSuccess(true);
      setTimeout(() => setBroadcastSuccess(false), 5000);
    } catch (err: any) {
      setBroadcastError(err.message || 'Failed to send broadcast');
    } finally {
      setBroadcastLoading(false);
    }
  };

  return (
    <div className="space-y-6 overflow-y-auto max-h-full pr-2">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">WhatsApp Account Control Center</h2>
        <p className="text-sm text-[var(--text-muted)]">Manage multiple WhatsApp connection profiles, pair devices via QR code, and broadcast test notifications.</p>
      </div>

      {error && (
        <div className="p-3.5 text-xs bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl">
          ⚠️ {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Accounts List */}
        <div className="lg:col-span-2 space-y-4">
          <h3 className="text-xs uppercase font-bold tracking-wider text-white/40">Active WhatsApp Profiles ({accounts.length})</h3>
          
          {accounts.length === 0 ? (
            <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] p-8 text-center">
              <p className="text-sm text-[var(--text-muted)]">No WhatsApp accounts configured yet. Use the form to link your first account.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {accounts.map((acc) => (
                <Card key={acc.id} className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md flex flex-col justify-between overflow-hidden">
                  <CardHeader className="p-5 pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate">
                        <CardTitle className="text-sm font-bold text-white truncate">{acc.name}</CardTitle>
                        <CardDescription className="text-xs text-[var(--text-muted)] font-mono">{acc.id}</CardDescription>
                      </div>
                      <Badge 
                        variant="outline" 
                        className={`rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider font-bold ${
                          acc.status === 'connected' ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400' :
                          acc.status === 'connecting' ? 'bg-amber-950/20 border-amber-500/30 text-amber-400 animate-pulse' :
                          acc.status === 'qr' ? 'bg-cyan-950/20 border-cyan-500/30 text-cyan-400' :
                          'bg-red-950/20 border-red-500/30 text-red-400'
                        }`}
                      >
                        {acc.status}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="p-5 pt-0 space-y-4 flex-1 flex flex-col justify-between">
                    <div>
                      {acc.phone && (
                        <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 font-mono mb-3">
                          <span>📱 Phone:</span>
                          <span className="text-white font-bold">{acc.phone}</span>
                        </div>
                      )}

                      {acc.status === 'qr' && acc.qrCode ? (
                        <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl border border-white/10 mb-3">
                          <img src={acc.qrCode} alt="WhatsApp QR Login Code" className="w-40 h-40" />
                          <p className="text-[10px] text-gray-500 font-bold uppercase mt-2 tracking-wide text-center">
                            Scan to Link Device
                          </p>
                        </div>
                      ) : acc.status === 'connecting' ? (
                        <div className="flex items-center justify-center py-6 text-xs text-[var(--text-muted)] gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                          Handshaking with WhatsApp servers...
                        </div>
                      ) : null}
                    </div>

                    <div className="pt-3 border-t border-white/[0.04] grid grid-cols-2 gap-2">
                      {acc.status === 'disconnected' ? (
                        <Button 
                          onClick={() => handleConnect(acc.id)} 
                          size="sm" 
                          variant="outline"
                          className="w-full text-xs font-semibold py-1.5 h-auto rounded-lg bg-emerald-950/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10"
                        >
                          ▶️ Connect
                        </Button>
                      ) : (
                        <Button 
                          onClick={() => handleDisconnect(acc.id)} 
                          size="sm" 
                          variant="outline"
                          className="w-full text-xs font-semibold py-1.5 h-auto rounded-lg bg-red-955/10 border-red-500/20 text-red-400 hover:bg-red-500/10"
                        >
                          ⏸️ Disconnect
                        </Button>
                      )}

                      <Button 
                        onClick={() => handleReconnect(acc.id)} 
                        size="sm" 
                        variant="outline"
                        className="w-full text-xs font-semibold py-1.5 h-auto rounded-lg bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
                      >
                        🔄 Refresh
                      </Button>

                      <Button 
                        onClick={() => handleDelete(acc.id)} 
                        size="sm" 
                        variant="outline"
                        className="col-span-2 w-full text-xs font-semibold py-1.5 h-auto rounded-lg bg-red-950/20 border-red-500/35 text-red-400 hover:bg-red-500/20"
                      >
                        🗑️ Delete Profile
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Action Panel: Add Account & Broadcast */}
        <div className="space-y-6">
          {/* Add Account Card */}
          <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md">
            <CardHeader className="p-5">
              <CardTitle className="text-sm font-bold text-white">➕ Add WhatsApp Account</CardTitle>
              <CardDescription className="text-xs text-[var(--text-muted)]">Configure a new device profile. Once added, a QR code will be generated to pair the device.</CardDescription>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <form onSubmit={handleAddAccount} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="acc-id" className="text-[10px] uppercase font-bold tracking-wider text-white/40">Profile ID (Unique, e.g. "personal")</Label>
                  <Input 
                    id="acc-id"
                    type="text" 
                    required 
                    placeholder="Enter unique profile ID" 
                    value={newId}
                    onChange={(e) => setNewId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                    className="bg-[#11151F] border border-white/5 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="acc-name" className="text-[10px] uppercase font-bold tracking-wider text-white/40">Display Name (e.g. "Primary Business")</Label>
                  <Input 
                    id="acc-name"
                    type="text" 
                    required 
                    placeholder="Enter display name" 
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="bg-[#11151F] border border-white/5 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </div>

                {addError && (
                  <div className="p-2.5 text-[11px] bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg">
                    ❌ {addError}
                  </div>
                )}

                <Button 
                  type="submit" 
                  disabled={addLoading || !newId || !newName}
                  className="w-full py-2 bg-[#0061FF] hover:bg-[#004ecb] text-white text-xs font-semibold rounded-lg"
                >
                  {addLoading ? 'Creating Profile...' : 'Link Account'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Test Broadcast Card */}
          <Card className="rounded-2xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-md">
            <CardHeader className="p-5">
              <CardTitle className="text-sm font-bold text-white">📣 Broadcast Notification</CardTitle>
              <CardDescription className="text-xs text-[var(--text-muted)]">Sends a text notification from all currently connected WhatsApp profiles to the default configured recipients.</CardDescription>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <form onSubmit={handleBroadcast} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="broadcast-msg" className="text-[10px] uppercase font-bold tracking-wider text-white/40">Message Text</Label>
                  <Textarea 
                    id="broadcast-msg"
                    required
                    placeholder="Type broadcast message here..." 
                    value={broadcastText}
                    onChange={(e) => setBroadcastText(e.target.value)}
                    rows={4}
                    className="bg-[#11151F] border border-white/5 rounded-lg p-3 text-xs text-white resize-none"
                  />
                </div>

                {broadcastSuccess && (
                  <div className="p-2.5 text-[11px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg">
                    ✅ Broadcast sent successfully!
                  </div>
                )}

                {broadcastError && (
                  <div className="p-2.5 text-[11px] bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg">
                    ❌ {broadcastError}
                  </div>
                )}

                <Button 
                  type="submit" 
                  disabled={broadcastLoading || !broadcastText.trim()}
                  className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg"
                >
                  {broadcastLoading ? 'Broadcasting...' : 'Send Broadcast'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
