import React, { useState, useEffect } from 'react';
import { api } from '../api';

const STANDARD_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_SERVER_ID',
  'WHATSAPP_RECIPIENT',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'DASHBOARD_DOMAIN',
  'BROWSER_TUNNEL_TOKEN',
  'BROWSER_DOMAIN'
];

const HIDDEN_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME'
];

export default function ConfigPanel() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Visibility toggles for sensitive fields
  const [showDiscordToken, setShowDiscordToken] = useState(false);
  const [showDashboardToken, setShowDashboardToken] = useState(false);
  const [showBrowserToken, setShowBrowserToken] = useState(false);

  // State for adding custom variables
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const fetchConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getConfig();
      setConfig(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleValueChange = (key: string, val: string) => {
    setConfig(prev => ({
      ...prev,
      [key]: val
    }));
  };

  const handleAddCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim()) return;

    const formattedKey = newKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    
    if (STANDARD_KEYS.includes(formattedKey) || HIDDEN_KEYS.includes(formattedKey)) {
      setError(`Cannot add '${formattedKey}' as a custom variable; it is a reserved system key.`);
      return;
    }

    setConfig(prev => ({
      ...prev,
      [formattedKey]: newValue
    }));

    setNewKey('');
    setNewValue('');
    setSuccess(`Added custom variable '${formattedKey}' locally. Click 'Save Configurations' to persist.`);
    setTimeout(() => setSuccess(null), 5000);
  };

  const handleRemoveKey = (keyToRemove: string) => {
    setConfig(prev => {
      const next = { ...prev };
      delete next[keyToRemove];
      return next;
    });
    setSuccess(`Removed '${keyToRemove}' locally. Click 'Save Configurations' to persist.`);
    setTimeout(() => setSuccess(null), 5000);
  };

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.saveConfig(config);
      setSuccess(result.message || 'Configuration saved and R2 sync triggered!');
      // Re-fetch to get any newly masked values or updated status
      await fetchConfig();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const syncConfig = async () => {
    setSyncing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.syncConfig();
      setSuccess(result.message || 'State successfully synced to Cloudflare R2!');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  // Filter custom keys (keys that are not standard and not system hidden R2 credentials)
  const customKeys = Object.keys(config).filter(
    key => !STANDARD_KEYS.includes(key) && !HIDDEN_KEYS.includes(key)
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-white/50 space-x-2">
        <div className="w-5 h-5 rounded-full border-2 border-white/30 border-t-[#6c63ff] animate-spin" />
        <span>Loading environment configurations...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-white/50 text-sm leading-relaxed">
            Manage your bridge environment variables directly from this interface. Saving configurations will automatically persist them to Cloudflare R2 and update variables in-memory.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncConfig}
            disabled={syncing || saving}
            className="px-4 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] active:scale-[0.98] font-semibold text-xs transition-all text-white flex items-center gap-1.5"
            title="Force a complete upload of your .env and auth credentials to Cloudflare R2"
          >
            {syncing ? (
              <>
                <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <span>Syncing R2...</span>
              </>
            ) : (
              <>
                <span>☁️</span>
                <span>Force R2 Sync</span>
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4 flex items-start gap-3 animate-in fade-in duration-300">
          <span className="text-base">⚠️</span>
          <div className="space-y-0.5">
            <p className="font-bold">Error Encountered</p>
            <p className="opacity-80 leading-relaxed">{error}</p>
          </div>
        </div>
      )}

      {success && (
        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl px-5 py-4 flex items-start gap-3 animate-in fade-in duration-300">
          <span className="text-base">✓</span>
          <div className="space-y-0.5">
            <p className="font-bold">Success</p>
            <p className="opacity-80 leading-relaxed">{success}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main form */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Discord & WhatsApp Configurations */}
          <div className="glass rounded-3xl p-6 border border-white/[0.08] shadow-2xl space-y-5">
            <h3 className="text-xs font-black uppercase tracking-wider text-[#00d4aa] border-b border-white/[0.06] pb-2 flex items-center gap-1.5">
              <span>🤖</span> Bot Credentials
            </h3>
            
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">Discord Bot Token</label>
                  <button 
                    type="button" 
                    onClick={() => setShowDiscordToken(!showDiscordToken)}
                    className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                  >
                    {showDiscordToken ? '👁️ Hide' : '👁️ Show'}
                  </button>
                </div>
                <input
                  type={showDiscordToken ? 'text' : 'password'}
                  value={config['DISCORD_BOT_TOKEN'] || ''}
                  onChange={e => handleValueChange('DISCORD_BOT_TOKEN', e.target.value)}
                  placeholder="Paste your Discord bot token"
                  className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">Discord Server ID</label>
                <input
                  type="text"
                  value={config['DISCORD_SERVER_ID'] || ''}
                  onChange={e => handleValueChange('DISCORD_SERVER_ID', e.target.value)}
                  placeholder="Paste Server/Guild ID (e.g. 120255512345)"
                  className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-white/40">WhatsApp Recipient (Admins)</label>
                <input
                  type="text"
                  value={config['WHATSAPP_RECIPIENT'] || ''}
                  onChange={e => handleValueChange('WHATSAPP_RECIPIENT', e.target.value)}
                  placeholder="Comma-separated numbers with country code, no + (e.g., 923001234567,12025551234)"
                  className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                />
              </div>
            </div>
          </div>

          {/* Cloudflare Tunnels Configuration */}
          <div className="glass rounded-3xl p-6 border border-white/[0.08] shadow-2xl space-y-5">
            <h3 className="text-xs font-black uppercase tracking-wider text-[#6c63ff] border-b border-white/[0.06] pb-2 flex items-center gap-1.5">
              <span>☁️</span> Cloudflare Tunnels (Static Access Domains)
            </h3>

            <div className="space-y-5">
              
              {/* Dashboard Tunnel */}
              <div className="space-y-4 bg-white/[0.01] border border-white/[0.04] p-4 rounded-2xl">
                <h4 className="text-[10px] font-black uppercase tracking-wider text-white/30">Dashboard Tunnel Setup</h4>
                
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] uppercase font-semibold text-white/45">Dashboard Tunnel Token</label>
                      <button 
                        type="button" 
                        onClick={() => setShowDashboardToken(!showDashboardToken)}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                      >
                        {showDashboardToken ? '👁️ Hide' : '👁️ Show'}
                      </button>
                    </div>
                    <input
                      type={showDashboardToken ? 'text' : 'password'}
                      value={config['CLOUDFLARE_TUNNEL_TOKEN'] || ''}
                      onChange={e => handleValueChange('CLOUDFLARE_TUNNEL_TOKEN', e.target.value)}
                      placeholder="Paste your dashboard Cloudflare tunnel token (base64)"
                      className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-semibold text-white/45">Dashboard Domain</label>
                    <input
                      type="text"
                      value={config['DASHBOARD_DOMAIN'] || ''}
                      onChange={e => handleValueChange('DASHBOARD_DOMAIN', e.target.value)}
                      placeholder="e.g. services.ufone-claim.site"
                      className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Browser Tunnel */}
              <div className="space-y-4 bg-white/[0.01] border border-white/[0.04] p-4 rounded-2xl">
                <div className="flex justify-between items-center">
                  <h4 className="text-[10px] font-black uppercase tracking-wider text-white/30">Browser Tunnel Setup</h4>
                  <span className="text-[9px] bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-bold px-1.5 py-0.5 rounded-full">
                    Optional
                  </span>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] uppercase font-semibold text-white/45">Browser Tunnel Token</label>
                      <button 
                        type="button" 
                        onClick={() => setShowBrowserToken(!showBrowserToken)}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                      >
                        {showBrowserToken ? '👁️ Hide' : '👁️ Show'}
                      </button>
                    </div>
                    <input
                      type={showBrowserToken ? 'text' : 'password'}
                      value={config['BROWSER_TUNNEL_TOKEN'] || ''}
                      onChange={e => handleValueChange('BROWSER_TUNNEL_TOKEN', e.target.value)}
                      placeholder="Leave blank to use the same token as the dashboard"
                      className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase font-semibold text-white/45">Browser Domain</label>
                    <input
                      type="text"
                      value={config['BROWSER_DOMAIN'] || ''}
                      onChange={e => handleValueChange('BROWSER_DOMAIN', e.target.value)}
                      placeholder="e.g. browser.ufone-claim.site"
                      className="w-full bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* Custom Configurations / Add new */}
          <div className="glass rounded-3xl p-6 border border-white/[0.08] shadow-2xl space-y-5">
            <h3 className="text-xs font-black uppercase tracking-wider text-white/40 border-b border-white/[0.06] pb-2 flex items-center gap-1.5">
              <span>🔧</span> Custom Environment Variables
            </h3>

            {/* Custom List */}
            {customKeys.length > 0 ? (
              <div className="space-y-3.5 max-h-60 overflow-y-auto pr-1">
                {customKeys.map(key => (
                  <div key={key} className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.05] p-3.5 rounded-2xl relative group">
                    <div className="flex-1 space-y-1">
                      <p className="text-[9px] uppercase tracking-wider font-bold text-white/35 font-mono">{key}</p>
                      <input
                        type="text"
                        value={config[key]}
                        onChange={e => handleValueChange(key, e.target.value)}
                        className="bg-transparent text-xs text-white outline-none w-full border-b border-transparent focus:border-white/10 font-mono"
                      />
                    </div>
                    <button
                      onClick={() => handleRemoveKey(key)}
                      className="p-2 text-white/30 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
                      title="Delete variable"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-white/20 italic">No custom variables added yet.</p>
            )}

            {/* Add Custom Form */}
            <form onSubmit={handleAddCustom} className="pt-2 border-t border-white/[0.04] flex flex-col sm:flex-row gap-3">
              <input
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                placeholder="VARIABLE_NAME"
                className="flex-1 bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
              />
              <input
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder="value"
                className="flex-1 bg-[#161b26]/50 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/20 outline-none focus:border-[#6c63ff]/40 transition-all font-mono"
              />
              <button
                type="submit"
                disabled={!newKey.trim()}
                className="px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/10 text-white/60 hover:text-white/90 hover:bg-white/[0.08] active:scale-[0.98] font-bold text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + Add
              </button>
            </form>
          </div>

          {/* Action button */}
          <button
            onClick={saveConfig}
            disabled={saving || syncing}
            className="w-full py-4 rounded-2xl bg-gradient-to-r from-[#6c63ff] to-[#00d4aa] hover:opacity-95 font-bold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed text-white shadow-lg shadow-[#6c63ff]/15 flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span>Saving configurations and archiving to R2...</span>
              </>
            ) : (
              <>
                <span>💾</span>
                <span>Save Configurations</span>
              </>
            )}
          </button>

        </div>

        {/* Info panel / Guide */}
        <div className="space-y-6">
          <div className="glass rounded-3xl p-6 border border-white/[0.08] shadow-2xl space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-white/80 flex items-center gap-1.5">
              <span>💡</span> Setup Guide
            </h3>
            
            <div className="space-y-4 text-xs text-white/50 leading-relaxed">
              <div className="space-y-1.5">
                <p className="font-bold text-white/80">1. Named Cloudflare Tunnels</p>
                <p>Creating a Named Tunnel assigns a persistent Tunnel ID. This prevents your subdomains from breaking during GitHub Action runner cycle restarts.</p>
              </div>

              <div className="space-y-1.5">
                <p className="font-bold text-white/80">2. Shared or Separate Tunnels</p>
                <p>You can route the virtual cloud browser through the <strong>same dashboard tunnel</strong>. If you do this:</p>
                <ul className="list-disc list-inside pl-1 space-y-1 text-[11px]">
                  <li>Add both subdomains under your Cloudflare Zero Trust public hostname routing panel.</li>
                  <li>Leave BROWSER_TUNNEL_TOKEN empty.</li>
                  <li>Set BROWSER_DOMAIN to your browser subdomain.</li>
                </ul>
              </div>

              <div className="space-y-1.5">
                <p className="font-bold text-white/80">3. R2 Credentials</p>
                <p>System credentials like bucket names and keys are loaded directly from the action secrets and do not need to be updated here.</p>
              </div>

              <div className="p-3 bg-[#6c63ff]/5 border border-[#6c63ff]/20 text-[#6c63ff] rounded-xl font-medium text-[11px] flex items-start gap-2">
                <span>🔄</span>
                <span>After saving configs, a background task uploads your fresh `.env` and `auth_info` to R2 immediately. The new runner parses this update on handoff automatically!</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
