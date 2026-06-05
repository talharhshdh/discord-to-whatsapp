import React, { useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export default function AndroidPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>('');
  const [status, setStatus] = useState<{
    running: boolean;
    uptime?: string;
    deviceInfo?: string;
    webUrl?: string;
  } | null>(null);

  const startEmulator = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStart();
      if (res.success) {
        setResult(`✅ ${res.message}\n\n🌐 Web URL: ${res.webUrl || 'Starting...'}`);
        setTimeout(checkStatus, 2000);
      } else {
        setResult(`❌ ${res.message}\n${res.error || ''}`);
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStatus();
      setStatus(res);
      if (res.running) {
        setResult(
          `✅ Android Emulator Running\n\n` +
          `⏱️ Uptime: ${res.uptime || 'Unknown'}\n` +
          `📱 Device: ${res.deviceInfo || 'Android 13'}\n` +
          `🌐 Web URL: ${res.webUrl || 'N/A'}`
        );
      } else {
        setResult('❌ No emulator is currently running');
        setStatus(null);
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const stopEmulator = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStop();
      if (res.success) {
        setResult(`✅ ${res.message}`);
        setStatus(null);
      } else {
        setResult(`⚠️ ${res.message}`);
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Info card */}
      <Card className="glass rounded-2xl p-5 border border-white/[0.07]">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center text-xl flex-shrink-0">
            📱
          </div>
          <div className="flex-1">
            <CardTitle className="text-base font-semibold text-white mb-1">Android Emulator</CardTitle>
            <CardDescription className="text-xs text-white/40 leading-relaxed">
              Run a full Android 13 device in the cloud with noVNC access. Perfect for testing apps, automation, or remote Android access.
            </CardDescription>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
            <div className="text-white/40 mb-1">Android Version</div>
            <div className="text-white font-medium">Android 13</div>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
            <div className="text-white/40 mb-1">Device Profile</div>
            <div className="text-white font-medium">Samsung Galaxy S10</div>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05]">
            <div className="text-white/40 mb-1">Access Method</div>
            <div className="text-white font-medium">Web UI (Docker)</div>
          </div>
        </div>
      </Card>

      {/* Control buttons */}
      <Card className="glass rounded-2xl p-5 border border-white/[0.07]">
        <CardTitle className="text-sm font-semibold text-white mb-3">Emulator Controls</CardTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Button
            onClick={startEmulator}
            disabled={loading}
            variant="outline"
            className="px-4 py-3 h-auto rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-all text-sm font-medium"
          >
            {loading ? '⏳ Loading...' : '▶️ Start Emulator'}
          </Button>

          <Button
            onClick={checkStatus}
            disabled={loading}
            variant="outline"
            className="px-4 py-3 h-auto rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-all text-sm font-medium"
          >
            {loading ? '⏳ Loading...' : '📊 Check Status'}
          </Button>

          <Button
            onClick={stopEmulator}
            disabled={loading}
            variant="outline"
            className="px-4 py-3 h-auto rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-all text-sm font-medium"
          >
            {loading ? '⏳ Loading...' : '⏹️ Stop Emulator'}
          </Button>
        </div>
      </Card>

      {/* WhatsApp Commands */}
      <Card className="glass rounded-2xl p-5 border border-white/[0.07]">
        <CardTitle className="text-sm font-semibold text-white mb-3">📱 WhatsApp Commands</CardTitle>
        <div className="space-y-2 text-xs">
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05] font-mono">
            <div className="text-white/40 mb-1">Start emulator:</div>
            <div className="text-teal-400">.android start</div>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05] font-mono">
            <div className="text-white/40 mb-1">Check status:</div>
            <div className="text-teal-400">.android status</div>
          </div>
          <div className="bg-white/[0.03] rounded-lg p-3 border border-white/[0.05] font-mono">
            <div className="text-white/40 mb-1">Stop emulator:</div>
            <div className="text-teal-400">.android stop</div>
          </div>
        </div>
      </Card>

      {/* Features */}
      <Card className="glass rounded-2xl p-5 border border-white/[0.07]">
        <CardTitle className="text-sm font-semibold text-white mb-3">✨ Features</CardTitle>
        <ul className="space-y-2 text-xs text-white/60">
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Full Android 13 system in Docker container</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Web-based interface (no VNC client needed)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Samsung Galaxy S10 device profile</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Full touch and keyboard support in browser</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Lightweight and fast (Docker-based)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5">✓</span>
            <span>Exposed via Cloudflare tunnel (HTTPS)</span>
          </li>
        </ul>
      </Card>

      {/* Result display */}
      {result && (
        <Card className="glass rounded-2xl p-5 border border-white/[0.07]">
          <CardTitle className="text-sm font-semibold text-white mb-3">Result</CardTitle>
          <pre className="text-xs text-white/70 whitespace-pre-wrap font-mono bg-black/20 rounded-lg p-3 border border-white/[0.05]">
            {result}
          </pre>
        </Card>
      )}

      {/* Usage tips */}
      <Card className="glass rounded-2xl p-5 border border-yellow-500/10">
        <div className="flex items-start gap-3">
          <span className="text-xl">💡</span>
          <div className="flex-1 text-xs text-white/60 leading-relaxed">
            <strong className="text-white/80">Startup time:</strong> The Docker container takes 30-60 seconds to start.
            Once started, you'll get a direct web link to access the Android interface in your browser.
            The emulator will remain active for the duration of your GitHub Actions session.
          </div>
        </div>
      </Card>
    </div>
  );
}
