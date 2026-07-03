import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import { Boom } from '@hapi/boom';
import P from 'pino';
import sharp from 'sharp';
import { AsyncLocalStorage } from 'async_hooks';
import express from 'express';
import cors from 'cors';
import { generateMessageID } from '@whiskeysockets/baileys';
import { detectAndDownload } from './libs/downloader';
import {
  searchYouTube,
  getYouTubeInfo,
  downloadYouTubeVideo,
  formatSearchResultMessage,
  formatQualityPickerMessage,
  type YouTubeSearchResult,
  type YouTubeVideoInfo,
  type YouTubeQualityOption,
} from './libs/youtube-dl';
import {
  searchMovies,
  formatMovieSearchMessage,
  type MovieSearchResult,
} from './libs/movie-search';
import { downloadMovie, getMovieStreamUrls } from './libs/movie-downloader';
import { startDashboard, registerUrl, getAllUrls, setWhatsAppSendCallback } from './libs/dashboard-server';
import { browserPool } from './libs/browser-pool';

dotenv.config();

// ---------------------------------------------------------------------------
// Suppress known libsignal / Baileys decryption noise
// ---------------------------------------------------------------------------
// "Over 2000 messages into the future" is a session-drift error thrown by
// libsignal when a device reconnects after being offline for a long time.
// "Failed to decrypt message with any known session" is the follow-up log.
// Neither indicates a real application error — they are harmless and very
// noisy in CI logs, so we filter them out here.
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = args.map(String).join(' ');
  if (
    msg.includes('Over 2000 messages into the future') ||
    msg.includes('Failed to decrypt message with any known session') ||
    msg.includes('SessionError')
  ) {
    return; // swallow silently
  }
  _origConsoleError(...args);
};

// ---------------------------------------------------------------------------
// YouTube interactive session state
// ---------------------------------------------------------------------------
const lol = (...db: any) => { console.log(...db); }
/** Stages of the YouTube interactive flow */
type YtSessionStage =
  | 'search_results'   // user was shown search results; waiting for them to pick one
  | 'quality_picker';  // user was shown quality options; waiting for a number selection

interface YtSession {
  stage: YtSessionStage;
  /** Search results shown to the user (stage: search_results) */
  searchResults?: YouTubeSearchResult[];
  /** Video info + quality list (stage: quality_picker) */
  videoInfo?: YouTubeVideoInfo;
  /** WhatsApp key of the status message to edit in-place */
  statusKey?: proto.IMessageKey;
  /** Original search query (for display) */
  query?: string;
}

// ---------------------------------------------------------------------------
// Movie interactive session state
// ---------------------------------------------------------------------------

/**
 * Stages of the movie interactive flow:
 *   search_results  → user sees list, picks a number
 *   action_picker   → user sees the chosen movie, picks Download vs Link
 */
type MovieSessionStage = 'search_results' | 'action_picker';

/**
 * Session state for the movie search interactive flow.
 * Key = remoteJid (the chat)
 */
interface MovieSession {
  stage: MovieSessionStage;
  /** Movie results shown to the user (stage: search_results) */
  results: MovieSearchResult[];
  /** The movie the user has chosen (stage: action_picker) */
  chosen?: MovieSearchResult;
  /** Original search query */
  query: string;
  /** WhatsApp key of the status message to edit in-place */
  statusKey?: proto.IMessageKey;
}

// ---------------------------------------------------------------------------
// Screenshot interactive session state
// ---------------------------------------------------------------------------

interface SsSession {
  stage: 'options_picker';
  url: string;
  statusKey?: proto.IMessageKey;
}

/**
 * Normalizes a WhatsApp JID to its bare user form.
 * Multi-device JIDs look like "923185853847:5@s.whatsapp.net".
 * This strips the ":N" device suffix → "923185853847@s.whatsapp.net".
 * Safely uses Baileys' jidNormalizedUser when available, otherwise regex.
 */
function normalizeJid(jid: string): string {
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid.replace(/:\d+(@)/, '$1');
  }
}

const accountContext = new AsyncLocalStorage<string>();

class ContextBoundMap<T> {
  private rawMap = new Map<string, T>();
  
  private getContextKey(key: string): string {
    const accountId = accountContext.getStore() || 'default';
    return `${accountId}:${key}`;
  }
  
  get(key: string): T | undefined {
    return this.rawMap.get(this.getContextKey(key));
  }
  
  set(key: string, value: T): this {
    this.rawMap.set(this.getContextKey(key), value);
    return this;
  }
  
  delete(key: string): boolean {
    return this.rawMap.delete(this.getContextKey(key));
  }
  
  has(key: string): boolean {
    return this.rawMap.has(this.getContextKey(key));
  }
}

export interface WhatsAppAccount {
  id: string;
  name: string;
  phone?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr';
  qrCode?: string;
}

function deserializePayload(obj: any): any {
  if (!obj) return obj;
  if (typeof obj === 'object') {
    if (obj.__buffer) {
      return Buffer.from(obj.__buffer, 'base64');
    }
    if (Array.isArray(obj)) {
      return obj.map(deserializePayload);
    }
    const res: any = {};
    for (const k of Object.keys(obj)) {
      res[k] = deserializePayload(obj[k]);
    }
    return res;
  }
  return obj;
}

class WhatsAppServer {
  private accounts: WhatsAppAccount[] = [];
  private sockets = new Map<string, WASocket>();
  private stateFilePath = 'auth_info/accounts.json';

  private botSentMessageIds = new Set<string>();
  private processedMessageIds = new Set<string>();

  private ytSessions = new ContextBoundMap<YtSession>();
  private movieSessions = new ContextBoundMap<MovieSession>();
  private ssSessions = new ContextBoundMap<SsSession>();

  private authorizedJids = new Set<string>();
  private lidToJid = new Map<string, string>();

  constructor() {
    lol(`🚀 WhatsApp Bot Server starting...`);

    const rawRecipients = (process.env.WHATSAPP_RECIPIENT ?? '').split(',');
    this.authorizedJids.clear();
    for (const num of rawRecipients) {
      const trimmed = num.trim();
      if (trimmed) {
        const jid = normalizeJid(trimmed.includes('@') ? trimmed : `${trimmed}@s.whatsapp.net`);
        this.authorizedJids.add(jid);
      }
    }

    this.loadProcessedMessageIds();
    this.loadAccounts();

    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/accounts', (req: any, res: any) => {
      res.json(this.accounts);
    });

    app.post('/accounts/add', async (req: any, res: any) => {
      const { id, name } = req.body;
      if (!id || !name) {
        return res.status(400).json({ error: 'Missing id or name' });
      }
      if (this.accounts.some(a => a.id === id)) {
        return res.status(400).json({ error: 'Account ID already exists' });
      }

      const newAcc: WhatsAppAccount = { id, name, status: 'disconnected' };
      this.accounts.push(newAcc);
      this.saveAccounts();

      this.setupWhatsApp(id);
      res.json(newAcc);
    });

    app.post('/accounts/delete', async (req: any, res: any) => {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const sock = this.sockets.get(id);
      if (sock) {
        try { sock.end(undefined); } catch {}
        this.sockets.delete(id);
      }

      this.accounts = this.accounts.filter(a => a.id !== id);
      this.saveAccounts();

      const fs = require('fs');
      const path = require('path');
      const dir = path.join('auth_info', id);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      res.json({ success: true });
    });

    app.post('/accounts/connect', async (req: any, res: any) => {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      this.setupWhatsApp(id);
      res.json({ success: true });
    });

    app.post('/accounts/disconnect', async (req: any, res: any) => {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const sock = this.sockets.get(id);
      if (sock) {
        try { sock.end(undefined); } catch {}
        this.sockets.delete(id);
      }

      const acc = this.accounts.find(a => a.id === id);
      if (acc) {
        acc.status = 'disconnected';
        acc.qrCode = undefined;
        this.saveAccounts();
      }

      res.json({ success: true });
    });

    app.post('/accounts/reconnect', async (req: any, res: any) => {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const sock = this.sockets.get(id);
      if (sock) {
        try { sock.end(undefined); } catch {}
        this.sockets.delete(id);
      }

      const fs = require('fs');
      const path = require('path');
      const dir = path.join('auth_info', id);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      this.setupWhatsApp(id);
      res.json({ success: true });
    });

    app.post('/send', async (req: any, res: any) => {
      const { accountId, toJid, content, options, text } = req.body;

      try {
        if (text) {
          if (this.sockets.size === 0) {
            return res.status(400).json({ error: 'No active WhatsApp accounts connected' });
          }

          let sentCount = 0;
          for (const [id, sock] of this.sockets.entries()) {
            for (const jid of this.authorizedJids) {
              await sock.sendMessage(jid, { text });
              sentCount++;
            }
          }
          return res.json({ success: true, sentCount });
        }

        if (!accountId || !toJid || !content) {
          return res.status(400).json({ error: 'Missing accountId, toJid, or content' });
        }

        const sock = this.sockets.get(accountId);
        if (!sock) {
          return res.status(400).json({ error: `Account ${accountId} is not connected` });
        }

        const deserializedContent = deserializePayload(content);
        const deserializedOptions = deserializePayload(options || {});
        const result = await sock.sendMessage(toJid, deserializedContent, deserializedOptions);
        res.json({ success: true, result });
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Failed to send message' });
      }
    });

    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      lol(`📡 Express API server listening on port ${port}`);
    });

    for (const acc of this.accounts) {
      this.setupWhatsApp(acc.id);
    }
  }

  private loadAccounts(): void {
    const fs = require('fs');
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf8');
        this.accounts = JSON.parse(data);
        for (const a of this.accounts) {
          a.status = 'disconnected';
          a.qrCode = undefined;
        }
      }
    } catch (err) {
      console.warn('⚠️ Failed to load accounts list:', err);
    }
  }

  private saveAccounts(): void {
    const fs = require('fs');
    const path = require('path');
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.accounts, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ Failed to save accounts list:', err);
    }
  }

  private loadProcessedMessageIds(): void {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join('auth_info', 'processed_message_ids.json');
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        const ids = JSON.parse(data);
        if (Array.isArray(ids)) {
          this.processedMessageIds = new Set(ids);
          lol(`📂 Loaded ${this.processedMessageIds.size} processed message ID(s) from state.`);
        }
      }
    } catch (err) {
      console.warn('⚠️ Failed to load processed message IDs:', err);
    }
  }

  private saveProcessedMessageIds(): void {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join('auth_info', 'processed_message_ids.json');
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(Array.from(this.processedMessageIds)), 'utf8');
    } catch (err) {
      console.error('❌ Failed to save processed message IDs:', err);
    }
  }

  private async setupWhatsApp(id: string): Promise<void> {
    try {
      const acc = this.accounts.find(a => a.id === id);
      if (!acc) return;

      const oldSock = this.sockets.get(id);
      if (oldSock) {
        try { oldSock.end(undefined); } catch {}
        this.sockets.delete(id);
      }

      acc.status = 'connecting';
      acc.qrCode = undefined;
      this.saveAccounts();

      const { state, saveCreds } = await useMultiFileAuthState(require('path').join('auth_info', id));
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
      });

      this.sockets.set(id, sock);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          acc.status = 'qr';
          const QRCode = require('qrcode');
          acc.qrCode = await QRCode.toDataURL(qr);
          this.saveAccounts();
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode ?? 500;
          lol(`❌ WhatsApp account ${id} disconnected. Reason code: ${reason}`);

          this.sockets.delete(id);

          if (reason === DisconnectReason.loggedOut) {
            acc.status = 'disconnected';
            acc.phone = undefined;
            acc.qrCode = undefined;
            this.saveAccounts();
            
            const fs = require('fs');
            const path = require('path');
            const dir = path.join('auth_info', id);
            if (fs.existsSync(dir)) {
              fs.rmSync(dir, { recursive: true, force: true });
            }
          } else {
            acc.status = 'connecting';
            this.saveAccounts();
            setTimeout(() => this.setupWhatsApp(id), 5000);
          }
        } else if (connection === 'open') {
          lol(`✅ WhatsApp account ${id} connected!`);
          acc.status = 'connected';
          acc.phone = sock.user?.id ? normalizeJid(sock.user.id) : undefined;
          acc.qrCode = undefined;
          this.saveAccounts();
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
          const phoneJid = c.id ? normalizeJid(c.id) : null;
          const lid = c.lid ? normalizeJid(c.lid) : null;
          if (phoneJid && lid) {
            this.lidToJid.set(lid, phoneJid);
          }
        }
      });

      sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' || m.type === 'append') {
          await accountContext.run(id, async () => {
            await this.handleWhatsAppMessage(sock, m.messages, m.type);
          });
        }
      });
    } catch (err) {
      console.error(`❌ Failed to set up WhatsApp for ${id}:`, err);
      const acc = this.accounts.find(a => a.id === id);
      if (acc) {
        acc.status = 'disconnected';
        this.saveAccounts();
      }
    }
  }


  /**
   * Returns true if the message sender is authorized to trigger bot commands.
   *
   * Authorized senders:
   *  1. The bot owner — messages sent from the linked device itself (fromMe === true).
   *  2. Any admin — phone numbers listed (comma-separated) in WHATSAPP_RECIPIENT.
   *
   * Admin messages arrive as normal incoming messages so fromMe will be false,
   * but their remoteJid will match one of the authorized JIDs.
   */
  private isAuthorizedSender(msg: any): boolean {
    // NOTE: fromMe messages are NEVER authorized here.
    // The bot's own sent messages echo back as fromMe=true and must be
    // skipped before reaching this check (see handleWhatsAppMessage guard).
    // Normalize and resolve JIDs.
    // WhatsApp multi-device routes messages via LIDs ("192861614141583@lid").
    // We resolve them to phone JIDs via the contact map before comparing.
    const rawJid = normalizeJid(msg.key.remoteJid ?? '');
    const rawParticipant = normalizeJid(msg.key.participant ?? '');

    const senderJid = msg.key.senderPn;
    const participantJid = this.lidToJid.get(rawParticipant) ?? rawParticipant;

    const allowed = (
      this.authorizedJids.has(senderJid) ||
      this.authorizedJids.has(participantJid)
    ) || msg.key.fromMe

    if (!allowed) {
      lol(`🚫 Unauthorized sender — raw: ${rawJid} | resolved: ${senderJid} | lidMap size: ${this.lidToJid.size}`);
      lol(`   Authorized list: ${[...this.authorizedJids].join(', ')}`);
    }

    return allowed;
  }

  /**
   * Calls the local Python API to remove the background of an image.
   * Falls back to the original buffer if the API fails.
   */
  private async removeBackground(inputBuffer: Buffer): Promise<Buffer> {
    try {
      lol('🤖 Sending image to Python API for background removal...');
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(inputBuffer)], { type: 'image/png' });
      formData.append('file', blob, 'image.png');

      const response = await fetch('http://127.0.0.1:8000/remove_bg', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Python API responded with ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      lol('✅ Background removed successfully!');
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error('❌ Failed to remove background:', err);
      return inputBuffer; // Fallback to original
    }
  }

  /**
   * Calls the local Python API to perform OCR on an image.
   */
  private async ocrImage(inputBuffer: Buffer): Promise<string> {
    try {
      lol('🤖 Sending image to Python API for OCR...');
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(inputBuffer)], { type: 'image/png' });
      formData.append('file', blob, 'image.png');

      const response = await fetch('http://127.0.0.1:8000/ocr', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Python API responded with ${response.status}`);
      }

      const data = (await response.json()) as { text: string };
      return data.text || 'No text found in image.';
    } catch (err) {
      console.error('❌ OCR failed:', err);
      return 'Error: Could not perform OCR.';
    }
  }

  /**
   * Calls the local Python API to transcribe audio using Whisper.
   */
  private async transcribeAudio(inputBuffer: Buffer): Promise<string> {
    try {
      lol('🤖 Sending audio to Python API for transcription...');
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(inputBuffer)], { type: 'audio/ogg' });
      formData.append('file', blob, 'audio.ogg');

      const response = await fetch('http://127.0.0.1:8000/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Python API responded with ${response.status}`);
      }

      const data = (await response.json()) as { text: string };
      return data.text || 'No transcription available.';
    } catch (err) {
      console.error('❌ Transcription failed:', err);
      return 'Error: Could not perform transcription.';
    }
  }

  /**
   * Calls the local Python API to take a screenshot of a URL.
   */
  private async takeScreenshot(url: string, fullPage: boolean = false, format: string = 'png'): Promise<Buffer> {
    try {
      lol(`🤖 Sending URL to Python API for screenshot: ${url}`);
      const response = await fetch('http://127.0.0.1:8000/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, full_page: fullPage, format }),
      });

      if (!response.ok) {
        throw new Error(`Python API responded with ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      lol('✅ Screenshot captured successfully!');
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error('❌ Screenshot failed:', err);
      throw err;
    }
  }

  /**
   * Processes incoming WhatsApp messages.
   *
   * @param type - Baileys upsert type:
   *   'notify'  = real-time delivery (always process, ignore age)
   *   'append'  = history sync on connect (filter old messages to avoid
   *               replaying the entire chat history every restart)
   */
  private async handleWhatsAppMessage(
    sock: WASocket,
    messages: proto.IWebMessageInfo[],
    type: string = 'notify',
  ): Promise<void> {
    for (const msg of messages) {
      try {
        lol("msg", msg)
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // ── Skip bot's own echoed messages (loop prevention) ─────────────────
        if (msg.key.fromMe && msg.key.id && this.botSentMessageIds.has(msg.key.id)) {
          lol(`⏭️ Skipping bot's own echoed message`);
          continue;
        }

        // ── Age filter ───────────────────────────────────────────────────────
        const tsRaw = msg.messageTimestamp;
        const tsSeconds: number =
          typeof tsRaw === 'number'
            ? tsRaw
            : (tsRaw != null && typeof (tsRaw as { low?: number }).low === 'number')
              ? (tsRaw as { low: number }).low
              : 0;
        const ageSeconds = Math.floor(Date.now() / 1000) - tsSeconds;
        if (tsSeconds > 0 && ageSeconds > 60) {
          lol(`⏭️ Skipping old message (${ageSeconds}s ago) from ${msg.key.remoteJid}`);
          continue;
        }

        if (!this.isAuthorizedSender(msg)) continue;

        const msgUniqueId = `${msg.key.remoteJid}:${msg.key.id}`;
        if (this.processedMessageIds.has(msgUniqueId)) {
          lol(`⏭️ Skipping already-processed message (${msgUniqueId})`);
          continue;
        }
        if (this.processedMessageIds.size >= 500) {
          const firstEntry = this.processedMessageIds.values().next().value;
          if (firstEntry !== undefined) this.processedMessageIds.delete(firstEntry);
        }
        this.processedMessageIds.add(msgUniqueId);
        this.saveProcessedMessageIds();

        let messageText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        // Support button responses
        const buttonId = msg.message?.buttonsResponseMessage?.selectedButtonId ||
          msg.message?.templateButtonReplyMessage?.selectedId ||
          msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
        if (buttonId) {
          messageText = buttonId;
        }

        const jid = msg.key.remoteJid!;
        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        // ── .url command ─────────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.url') {
          lol('📊 Detected .url command...');
          const urls = getAllUrls();
          const keys = Object.keys(urls);

          const uptimeSeconds = process.uptime();
          const remainingSeconds = Math.max(0, (5 * 60 * 60) - uptimeSeconds);
          const hoursLeft = Math.floor(remainingSeconds / 3600);
          const minutesLeft = Math.floor((remainingSeconds % 3600) / 60);

          let urlsMsg = '🔗 *Live Session URLs*\n';
          urlsMsg += `⏱️ *Time Left:* ${hoursLeft}h ${minutesLeft}m\n\n`;

          if (keys.length === 0) {
            urlsMsg += '_No URLs registered yet. The dashboard may still be starting up._';
          } else {
            for (const key of keys) {
              const entry = urls[key];
              urlsMsg += `*${entry.label || key}*\n`;
              urlsMsg += `🔗 ${entry.url}\n`;
              if (entry.username) urlsMsg += `👤 ${entry.username}\n`;
              if (entry.password) urlsMsg += `🔑 ${entry.password}\n`;
              urlsMsg += '\n';
            }
          }

          await sock.sendMessage(jid, { text: urlsMsg.trim() }, { quoted: msg });
          continue;
        }

        // ── .menu / .help command ────────────────────────────────────────────
        if (['.menu', '.help'].includes(messageText.toLowerCase())) {
          const menuText =
            '🤖 *Discord-WhatsApp Bridge Menu*\n\n' +
            '🎥 *Movies & Shows*\n' +
            '• `.movie <title>` - Search and download movies\n\n' +
            '🎵 *YouTube*\n' +
            '• Send any YouTube link for download options\n\n' +
            '🖼️ *Stickers*\n' +
            '• `.sticker` - Image to sticker (reply to image)\n' +
            '• `.sbg` - Remove background + sticker (reply to image)\n' +
            '• `.rbg` - Just remove background (reply to image)\n' +
            '• `.pp` - Get profile picture (reply to msg or chat)\n\n' +
            '🧠 *AI Tools*\n' +
            '• `.ocr` - Extract text from image (reply to image)\n' +
            '• `.whisper` - Transcribe voice note (reply to audio)\n' +
            '• `.reveal` - See view-once media (reply to view-once)\n' +
            '• `.terminal` - Start a public web terminal\n' +
            '• `.vscode` - Start a public VSCode server\n' +
            '• `.browser` - Start a virtual cloud browser\n\n' +
            '� *Android Emulator*\n' +
            '• `.android start [hours]` - Start Android emulator (1-6h)\n' +
            '• `.android status` - Check emulator status\n' +
            '• `.android stop` - Stop emulator session\n\n' +
            '�🔗 *Session*\n' +
            '• `.url` - Get all live public URLs (dashboard, terminal, VSCode, etc.)\n\n' +
            'ℹ️ _Reply to an image or audio message with the command to use AI tools._';

          await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
          continue;
        }

        // ── .pp command ──────────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.pp') {
          lol('👤 Detected .pp command...');

          let targetJid = jid;
          const participant = msg.message.extendedTextMessage?.contextInfo?.participant;
          if (participant) {
            targetJid = participant;
          }

          try {
            const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Fetching profile picture...*' }, { quoted: msg });
            const ppUrl = await sock.profilePictureUrl(targetJid, 'image').catch(() => null);

            if (!ppUrl) {
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: '❌ Profile picture is private or not set.' });
              } else {
                await sock.sendMessage(jid, { text: '❌ Profile picture is private or not set.' }, { quoted: msg });
              }
            } else {
              await sock.sendMessage(jid, { image: { url: ppUrl }, caption: '👤 *Profile Picture*' }, { quoted: msg });
              if (statusMsg?.key) await sock.sendMessage(jid, { delete: statusMsg.key });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await sock.sendMessage(jid, { text: `❌ *Failed to fetch profile picture*\n${errMsg}` }, { quoted: msg });
          }
          continue;
        }

        // ── .reveal command ──────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.reveal') {
          const voMsg = quotedMessage?.viewOnceMessageV2?.message || quotedMessage?.viewOnceMessage?.message || quotedMessage;

          if (voMsg?.imageMessage || voMsg?.videoMessage) {
            lol('👀 Detected .reveal command on view-once media...');
            const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Revealing view-once media...*' }, { quoted: msg });

            try {
              const buffer = await downloadMediaMessage({ key: msg.key, message: voMsg }, 'buffer', {}, {
                logger: P({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage,
              });

              if (voMsg.imageMessage) {
                await sock.sendMessage(jid, { image: buffer as Buffer, caption: '👀 *Revealed View-Once Image*' }, { quoted: msg });
              } else {
                await sock.sendMessage(jid, { video: buffer as Buffer, caption: '👀 *Revealed View-Once Video*' }, { quoted: msg });
              }
              if (statusMsg?.key) await sock.sendMessage(jid, { delete: statusMsg.key });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Reveal failed*\n${errMsg}` });
              }
            }
          } else {
            await sock.sendMessage(jid, { text: '❌ Reply to a *view-once* image or video with `.reveal`' }, { quoted: msg });
          }
          continue;
        }

        // ── .terminal command ────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.terminal') {
          lol('💻 Detected .terminal command...');
          const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Starting Web Terminal...*' }, { quoted: msg });

          try {
            const { startTerminal } = require('./libs/terminal');
            const result = await startTerminal();

            if (result.error) {
              if (statusMsg?.key) await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Terminal failed*\n${result.error}` });
            } else {
              // Register in shared dashboard registry
              if (result.url) {
                registerUrl('terminal', '💻 Terminal', result.url, {
                  username: result.username,
                  password: result.password,
                });
              }

              const uptimeSeconds = process.uptime();
              const remainingSeconds = Math.max(0, (5 * 60 * 60) - uptimeSeconds);
              const hoursLeft = Math.floor(remainingSeconds / 3600);
              const minutesLeft = Math.floor((remainingSeconds % 3600) / 60);

              const terminalMsg = `💻 *Developer: Web Terminal*\n\n🔗 ${result.url}\n\n👤 *Username:* ${result.username}\n🔑 *Password:* ${result.password}\n\n⏱️ *Session Time Left:* ${hoursLeft}h ${minutesLeft}m`;
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: terminalMsg });
              } else {
                await sock.sendMessage(jid, { text: terminalMsg }, { quoted: msg });
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (statusMsg?.key) {
              await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Terminal failed*\n${errMsg}` });
            }
          }
          continue;
        }

        // ── .vscode command ──────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.vscode') {
          lol('💻 Detected .vscode command...');
          const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Starting VSCode Server...*' }, { quoted: msg });

          try {
            const { startVSCode } = require('./libs/vscode');
            const result = await startVSCode();

            if (result.error) {
              if (statusMsg?.key) await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *VSCode failed*\n${result.error}` });
            } else {
              // Register in shared dashboard registry
              if (result.url) {
                registerUrl('vscode', '🔵 VSCode Server', result.url, {
                  password: result.password,
                });
              }

              const uptimeSeconds = process.uptime();
              const remainingSeconds = Math.max(0, (5 * 60 * 60) - uptimeSeconds);
              const hoursLeft = Math.floor(remainingSeconds / 3600);
              const minutesLeft = Math.floor((remainingSeconds % 3600) / 60);

              const vscodeMsg = `💻 *Developer: VSCode Server*\n\n🔗 ${result.url}\n\n🔑 *Password:* ${result.password}\n\n⏱️ *Session Time Left:* ${hoursLeft}h ${minutesLeft}m`;
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: vscodeMsg });
              } else {
                await sock.sendMessage(jid, { text: vscodeMsg }, { quoted: msg });
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (statusMsg?.key) {
              await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *VSCode failed*\n${errMsg}` });
            }
          }
          continue;
        }

        // ── .browser command ──────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.browser') {
          lol('🌐 Detected .browser command...');
          const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Starting Cloud Browser... (This may take a minute)*' }, { quoted: msg });

          try {
            const { startBrowser } = require('./libs/browser');
            const result = await startBrowser();

            if (result.error) {
              if (statusMsg?.key) await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Browser failed*\n${result.error}` });
            } else {
              // Register in shared dashboard registry
              if (result.url) {
                registerUrl('browser', '🌐 Cloud Browser', result.url, {
                  username: result.username,
                  password: result.password,
                });
              }

              const uptimeSeconds = process.uptime();
              const remainingSeconds = Math.max(0, (5 * 60 * 60) - uptimeSeconds);
              const hoursLeft = Math.floor(remainingSeconds / 3600);
              const minutesLeft = Math.floor((remainingSeconds % 3600) / 60);

              const browserMsg = `🌐 *Developer: Cloud Browser*\n\n🔗 ${result.url}\n\n👤 *Username:* ${result.username}\n🔑 *Password:* ${result.password}\n\n⏱️ *Session Time Left:* ${hoursLeft}h ${minutesLeft}m`;
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: browserMsg });
              } else {
                await sock.sendMessage(jid, { text: browserMsg }, { quoted: msg });
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (statusMsg?.key) {
              await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Browser failed*\n${errMsg}` });
            }
          }
          continue;
        }

        // ── .android command ─────────────────────────────────────────────────
        if (messageText.toLowerCase().startsWith('.android')) {
          const args = messageText.slice('.android'.length).trim().split(' ');
          const subcommand = args[0]?.toLowerCase();

          // .android start [hours]
          if (subcommand === 'start') {
            lol('📱 Detected .android start command...');
            const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Starting Android Emulator...*\n_This may take 2-3 minutes_' }, { quoted: msg });

            try {
              const { startAndroidEmulator } = require('./libs/android-emulator');
              const result = await startAndroidEmulator();

              if (!result.success) {
                if (statusMsg?.key) {
                  await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Android Emulator failed*\n${result.error || result.message}` });
                }
              } else {
                const androidMsg =
                  `📱 *Android Emulator Started!*\n\n` +
                  `🌐 *Web Interface:*\n${result.webUrl}\n\n` +
                  `📱 *Device:* Samsung Galaxy S10\n` +
                  `🤖 *Android:* 13\n\n` +
                  `💡 *Tips:*\n` +
                  `• Open the link in your browser\n` +
                  `• Full touch and keyboard support\n` +
                  `• Use .android status to check status\n` +
                  `• Use .android stop to stop the emulator`;

                if (statusMsg?.key) {
                  await sock.sendMessage(jid, { edit: statusMsg.key, text: androidMsg });
                } else {
                  await sock.sendMessage(jid, { text: androidMsg }, { quoted: msg });
                }
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (statusMsg?.key) {
                await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Android Emulator failed*\n${errMsg}` });
              }
            }
            continue;
          }

          // .android status
          if (subcommand === 'status') {
            lol('📱 Detected .android status command...');
            try {
              const { getAndroidEmulatorStatus } = require('./libs/android-emulator');
              const status = await getAndroidEmulatorStatus();

              if (!status.running) {
                await sock.sendMessage(jid, { text: '📱 *Android Emulator Status*\n\n❌ No emulator is currently running.\n\nUse `.android start` to start one.' }, { quoted: msg });
              } else {
                const statusMsg =
                  `📱 *Android Emulator Status*\n\n` +
                  `✅ *Running*\n` +
                  `⏱️ *Uptime:* ${status.uptime || 'Unknown'}\n` +
                  `📱 *Device:* ${status.deviceInfo || 'Samsung Galaxy S10'}\n` +
                  `🌐 *Web UI:* ${status.webUrl || 'Use .url command'}\n\n` +
                  `Use .android stop to stop the emulator.`;

                await sock.sendMessage(jid, { text: statusMsg }, { quoted: msg });
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await sock.sendMessage(jid, { text: `❌ *Status check failed*\n${errMsg}` }, { quoted: msg });
            }
            continue;
          }

          // .android stop
          if (subcommand === 'stop') {
            lol('📱 Detected .android stop command...');
            try {
              const { stopAndroidEmulator } = require('./libs/android-emulator');
              const result = await stopAndroidEmulator();

              if (result.success) {
                await sock.sendMessage(jid, { text: `✅ *Android Emulator Stopped*\n\n${result.message}` }, { quoted: msg });
              } else {
                await sock.sendMessage(jid, { text: `⚠️ ${result.message}` }, { quoted: msg });
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await sock.sendMessage(jid, { text: `❌ *Stop failed*\n${errMsg}` }, { quoted: msg });
            }
            continue;
          }

          // Unknown subcommand or no subcommand
          await sock.sendMessage(jid, {
            text:
              '📱 *Android Emulator*\n\n' +
              '*Available commands:*\n' +
              '• `.android start` - Start Android emulator\n' +
              '• `.android status` - Check emulator status\n' +
              '• `.android stop` - Stop emulator\n\n' +
              '*Features:*\n' +
              '• Android 13\n' +
              '• Samsung Galaxy S10 profile\n' +
              '• Web-based interface (no VNC needed)\n' +
              '• Full touch and keyboard support\n' +
              '• Lightweight Docker container'
          }, { quoted: msg });
          continue;
        }

        // ── .rbg command ─────────────────────────────────────────────────────
        if (quotedMessage?.imageMessage && messageText.toLowerCase() === '.rbg') {
          lol('🖼️ Detected .rbg command on image reply...');
          const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Removing background...*' }, { quoted: msg });

          try {
            const buffer = await downloadMediaMessage({ key: msg.key, message: { imageMessage: quotedMessage.imageMessage } }, 'buffer', {}, {
              logger: P({ level: 'silent' }),
              reuploadRequest: sock.updateMediaMessage,
            });

            const rbBuffer = await this.removeBackground(buffer as Buffer);
            await sock.sendMessage(jid, { image: rbBuffer, caption: '✨ *Background Removed*' }, { quoted: msg });
            if (statusMsg?.key) await sock.sendMessage(jid, { delete: statusMsg.key });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (statusMsg?.key) {
              await sock.sendMessage(jid, { edit: statusMsg.key, text: `❌ *Background removal failed*\n${errMsg}` });
            }
          }
          continue;
        }

        // ── .ss command ──────────────────────────────────────────────────────
        if (messageText.toLowerCase().startsWith('.ss')) {
          const url = messageText.slice('.ss'.length).trim();
          if (!url) {
            await sock.sendMessage(jid, { text: '🌐 *Screenshot*\n\nUsage: `.ss <url>`\nExample: `.ss https://google.com`' });
            continue;
          }

          const statusMsg = await sock.sendMessage(jid, {
            text: `🌐 *Screenshot Options*\n_URL:_ ${url}\n\n` +
              `Please choose an option using the buttons below, or reply with a number:\n` +
              `*1* ➔ 🖼️ Full Page (PNG)\n` +
              `*2* ➔ 🖼️ Start Only (PNG)\n` +
              `*3* ➔ 📄 Full Page (PDF)\n` +
              `*4* ➔ 📄 Start Only (PDF)`,
            footer: 'Discord-WhatsApp Bridge',
            buttons: [
              { buttonId: '1', buttonText: { displayText: 'Full Page PNG' }, type: 1 },
              { buttonId: '2', buttonText: { displayText: 'Start Only PNG' }, type: 1 },
              { buttonId: '3', buttonText: { displayText: 'Full Page PDF' }, type: 1 },
              { buttonId: '4', buttonText: { displayText: 'Start Only PDF' }, type: 1 }
            ],
            headerType: 1
          } as any);

          this.ssSessions.set(jid, {
            stage: 'options_picker',
            url,
            statusKey: statusMsg?.key
          });
          continue;
        }

        // ── .movie command ───────────────────────────────────────────────────
        // Usage: .movie <query>
        if (messageText.toLowerCase().startsWith('.movie')) {
          const query = messageText.slice('.movie'.length).trim();

          if (!query) {
            await sock.sendMessage(jid, {
              text: '🎬 *Movie Search*\n\nUsage: `.movie <title>`\nExample: `.movie Spider-Man`',
            });
            continue;
          }

          const statusMsg = await sock.sendMessage(jid, {
            text: `🔍 *Searching movies for:* "${query}"...`,
          });
          const statusKey = statusMsg?.key;
          const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

          try {
            const results = await searchMovies(query, 5);

            if (results.length === 0) {
              await updateStatus('❌ *No movies found* for that query. Try a different title.');
              continue;
            }

            // Store session so the next numeric reply resolves to the action picker
            this.movieSessions.set(jid, { stage: 'search_results', results, query, statusKey });

            await updateStatus(formatMovieSearchMessage(results, query));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await updateStatus(`❌ *Movie search failed*\n${errMsg}`);
          }
          continue;
        }

        // ── .sticker command ────────────────────────────────────────────────
        const isStickerCmd = messageText.toLowerCase().startsWith('.sticker');
        const isSbgCmd = messageText.toLowerCase().startsWith('.sbg');

        if (quotedMessage?.imageMessage && (isStickerCmd || isSbgCmd)) {
          const wantBgRemoval = isSbgCmd || messageText.toLowerCase().includes('bg');
          lol(`🖼️ Detected sticker command (bg removal: ${wantBgRemoval}) on image reply...`);

          const quotedMsg: proto.IWebMessageInfo = {
            key: msg.key,
            message: { imageMessage: quotedMessage.imageMessage },
          };

          const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
          });

          let processedBuffer = buffer as Buffer;
          if (wantBgRemoval) {
            processedBuffer = await this.removeBackground(processedBuffer);
          }

          const stickerBuffer = await sharp(processedBuffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();

          await sock.sendMessage(jid, { sticker: stickerBuffer });
          lol('✅ Image converted to sticker and sent!');
          continue;
        }

        // ── .ocr command ───────────────────────────────────────────────────
        if (quotedMessage?.imageMessage && messageText.toLowerCase() === '.ocr') {
          lol('🖼️ Detected .ocr command on image reply...');
          const quotedMsg: proto.IWebMessageInfo = {
            key: msg.key,
            message: { imageMessage: quotedMessage.imageMessage },
          };
          const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
          });
          const text = await this.ocrImage(buffer as Buffer);
          await sock.sendMessage(jid, { text: `📝 *OCR Result:*\n\n${text}` }, { quoted: msg });
          continue;
        }

        // ── .whisper command ────────────────────────────────────────────────
        const audioMsg = quotedMessage?.audioMessage || msg.message.audioMessage;
        if (audioMsg && messageText.toLowerCase() === '.whisper') {
          lol('🎙️ Detected .whisper command, transcribing...');
          const statusMsg = await sock.sendMessage(jid, { text: '⏳ *Transcribing audio...*' }, { quoted: msg });

          const quotedMsg: proto.IWebMessageInfo = {
            key: msg.key,
            message: { audioMessage: audioMsg },
          };
          const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
          });
          const text = await this.transcribeAudio(buffer as Buffer);

          if (statusMsg?.key) {
            await sock.sendMessage(jid, { edit: statusMsg.key, text: `🎙️ *Transcription:*\n\n${text}` });
          } else {
            await sock.sendMessage(jid, { text: `🎙️ *Transcription:*\n\n${text}` }, { quoted: msg });
          }
          continue;
        }

        if (!messageText) continue;

        // ────────────────────────────────────────────────────────────────────
        // Screenshot session handler
        // ────────────────────────────────────────────────────────────────────
        const ssSession = this.ssSessions.get(jid);
        if (ssSession?.stage === 'options_picker') {
          const pick = parseInt(messageText, 10);
          if (pick >= 1 && pick <= 4) {
            const { url, statusKey } = ssSession;
            this.ssSessions.delete(jid);

            const isFullPage = (pick === 1 || pick === 3);
            const isPdf = (pick === 3 || pick === 4);
            const format = isPdf ? 'pdf' : 'png';

            const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);
            await updateStatus(`📸 *Capturing ${isFullPage ? 'Full Page' : 'Start Only'} ${format.toUpperCase()} of:*\n_${url}_...`);

            try {
              const buffer = await this.takeScreenshot(url, isFullPage, format);

              if (isPdf) {
                await sock.sendMessage(jid, {
                  document: buffer,
                  mimetype: 'application/pdf',
                  fileName: 'screenshot.pdf',
                  caption: `📸 *Screenshot:* ${url}`
                }, { quoted: msg });
              } else {
                await sock.sendMessage(jid, {
                  image: buffer,
                  caption: `📸 *Screenshot:* ${url}`
                }, { quoted: msg });
              }
              if (statusKey) await sock.sendMessage(jid, { delete: statusKey });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await updateStatus(`❌ *Screenshot failed*\n${errMsg}`);
            }
            continue;
          } else if (/^\d+$/.test(messageText)) {
            await sock.sendMessage(jid, { text: `⚠️ Please reply with a number between 1 and 4.` });
            continue;
          }
          this.ssSessions.delete(jid);
        }

        // ────────────────────────────────────────────────────────────────────
        // Movie session handler (two-stage flow)
        // ────────────────────────────────────────────────────────────────────
        const movieSession = this.movieSessions.get(jid);
        if (movieSession) {
          // ── Stage 1: user picks a result number ───────────────────────────
          if (movieSession.stage === 'search_results') {
            const pick = parseInt(messageText, 10);
            const { results: movieResults, query: movieQuery, statusKey: movieStatusKey } = movieSession;

            if (pick >= 1 && pick <= movieResults.length) {
              const chosen = movieResults[pick - 1]!;
              const year = chosen.releaseDate ? ` (${chosen.releaseDate.slice(0, 4)})` : '';
              const typeEmoji = chosen.mediaType === 'tv' ? '📺' : '🎬';
              const updateStatus = this.makeStatusUpdater(sock, jid, movieStatusKey);

              // Immediately resolve stream URLs so we can show both links upfront
              await updateStatus(`🔍 *Fetching stream info for:*\n_${chosen.title}${year}_`);

              let streamLine = '';
              try {
                const urls = await getMovieStreamUrls(chosen.tmdbId, chosen.mediaType);
                const bestUrl = urls[0];
                if (bestUrl) {
                  streamLine =
                    `\n🎞️ *Direct stream (m3u8):*\n${bestUrl}\n` +
                    `_→ Paste in VLC \u203a Media \u203a Open Network Stream_\n`;
                }
              } catch {
                // Non-fatal: stream link resolution failed, just omit
              }

              // Show both watch links + download offer in one message
              await updateStatus(
                `${typeEmoji} *${chosen.title}*${year}\n\n` +
                `🔗 *Watch in browser:*\n${chosen.watchUrl}\n` +
                streamLine +
                `\n─────────────────────\n` +
                `📥 *Want to download the video file?*\n` +
                `Reply *1* to download · Anything else to cancel`,
              );

              // Advance to download-confirm stage
              this.movieSessions.set(jid, {
                stage: 'action_picker',
                results: movieResults,
                chosen,
                query: movieQuery,
                statusKey: movieStatusKey,
              });

              lol(`[Movie] Links shown for "${chosen.title}", awaiting download confirm`);
              continue;
            }

            // Invalid pick — remind user but keep session alive
            if (/^\d+$/.test(messageText)) {
              await sock.sendMessage(jid, {
                text: `⚠️ Please reply with a number between 1 and ${movieResults.length}.`,
              });
              continue;
            }

            // Non-numeric → cancel movie session, fall through
            this.movieSessions.delete(jid);
          }

          // ── Stage 2: user confirms download (reply "1") ────────────────────
          else if (movieSession.stage === 'action_picker') {
            const { chosen, statusKey: movieStatusKey } = movieSession;

            if (!chosen) {
              this.movieSessions.delete(jid);
              continue;
            }

            if (messageText.trim() === '1') {
              // ── Download the video ───────────────────────────────────────
              this.movieSessions.delete(jid);
              const updateStatus = this.makeStatusUpdater(sock, jid, movieStatusKey);
              const year = chosen.releaseDate ? ` (${chosen.releaseDate.slice(0, 4)})` : '';

              try {
                await updateStatus(`📥 *Starting download…*\n_${chosen.title}${year}_`);

                const { getCloudflareTunnelUrl } = require('./libs/cloudflared');
                let vncUrl = await getCloudflareTunnelUrl();

                if (vncUrl) {
                  await sock.sendMessage(jid, { text: `🤖 *Download starting!*\n\nIf the automated bypass gets stuck on Cloudflare, please open this remote browser link and click the verify checkbox:\n🔗 ${vncUrl}/vnc.html` });
                }

                const dlResult = await downloadMovie(
                  chosen.tmdbId,
                  chosen.mediaType,
                  chosen.title + year,
                  updateStatus,
                );

                await updateStatus('📤 *Uploading to WhatsApp...*');
                const videoBuffer = require('fs').readFileSync(dlResult.filePath);
                await sock.sendMessage(jid, {
                  video: videoBuffer,
                  mimetype: dlResult.mimetype,
                  caption: dlResult.caption,
                  fileName: dlResult.filename,
                });

                // Clean up status message and temp file
                if (movieStatusKey) await sock.sendMessage(jid, { delete: movieStatusKey });
                try { require('fs').unlinkSync(dlResult.filePath); } catch { /* ignore */ }

                lol(`✅ Movie downloaded and sent: "${chosen.title}"`);
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const updateStatus2 = this.makeStatusUpdater(sock, jid, movieStatusKey);
                await updateStatus2(`❌ *Download failed*\n${errMsg}`);
              }
              continue;

            } else {
              // Anything else → cancel session silently
              this.movieSessions.delete(jid);
            }
          }
        }

        // ────────────────────────────────────────────────────────────────────
        // YouTube interactive session handler
        // ────────────────────────────────────────────────────────────────────
        const session = this.ytSessions.get(jid);

        // ── Stage: user is choosing a search result ──────────────────────────
        if (session?.stage === 'search_results') {
          const pick = parseInt(messageText, 10);
          const results = session.searchResults ?? [];

          if (pick >= 1 && pick <= results.length) {
            const chosen = results[pick - 1]!;
            this.ytSessions.delete(jid);

            const statusMsg = await sock.sendMessage(jid, {
              text: `⏳ *Fetching info for:*\n_${chosen.title}_`,
            });
            const statusKey = statusMsg?.key;

            const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

            try {
              await updateStatus('🔍 *Getting video formats...*');
              const info = await getYouTubeInfo(chosen.url);
              this.ytSessions.set(jid, {
                stage: 'quality_picker',
                videoInfo: info,
                statusKey,
                query: session.query,
              });
              await updateStatus(formatQualityPickerMessage(info));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await updateStatus(`❌ *Failed to fetch info*\n${errMsg}`);
              this.ytSessions.delete(jid);
            }
            continue;
          }

          // Invalid pick — remind the user
          if (/^\d+$/.test(messageText)) {
            await sock.sendMessage(jid, {
              text: `⚠️ Please reply with a number between 1 and ${results.length}.`,
            });
            continue;
          }
          // Not a number — fall through to treat as new input
          this.ytSessions.delete(jid);
        }

        // ── Stage: user is choosing a quality ────────────────────────────────
        if (session?.stage === 'quality_picker') {
          const pick = parseInt(messageText, 10);
          const info = session.videoInfo!;

          if (pick >= 1 && pick <= info.qualities.length) {
            const quality = info.qualities[pick - 1]!;
            this.ytSessions.delete(jid);

            const statusMsg = await sock.sendMessage(jid, {
              text: `⏳ *Starting download...*\n_${info.title}_\n_Quality: ${quality.key}_`,
            });
            const statusKey = statusMsg?.key;
            const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

            try {
              const result = await downloadYouTubeVideo(info.url, quality, updateStatus);

              await updateStatus('📤 *Uploading to WhatsApp...*');
              lol(`📤 Sending YouTube ${quality.key} (${(result.buffer.length / 1024 / 1024).toFixed(1)} MB) to ${jid}`);

              if (result.mediaType === 'video') {
                await sock.sendMessage(jid, {
                  video: result.buffer, caption: result.caption, mimetype: result.mimetype,
                });
              } else {
                await sock.sendMessage(jid, {
                  document: result.buffer, mimetype: result.mimetype,
                  fileName: result.filename, caption: result.caption,
                });
              }

              if (statusKey) await sock.sendMessage(jid, { delete: statusKey });
              lol(`✅ YouTube ${quality.key} sent!`);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await updateStatus(`❌ *Download failed*\n${errMsg}`);
              this.ytSessions.delete(jid);
            }
            continue;
          }

          if (/^\d+$/.test(messageText)) {
            await sock.sendMessage(jid, {
              text: `⚠️ Please reply with a number between 1 and ${info.qualities.length}.`,
            });
            continue;
          }
          this.ytSessions.delete(jid);
        }

        // ────────────────────────────────────────────────────────────────────
        // Detect supported platform URLs (non-YouTube)
        // ────────────────────────────────────────────────────────────────────
        const { detectPlatform } = await import('./libs/downloader');
        const detection = detectPlatform(messageText);

        if (detection) {
          // ── YouTube URL: use youtube-dl-exec flow ──────────────────────────
          if (detection.platform === 'youtube') {
            const statusMsg = await sock.sendMessage(jid, {
              text: '⏳ *Fetching YouTube video info...*',
            });
            const statusKey = statusMsg?.key;
            const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

            try {
              await updateStatus('🔍 *Getting available formats...*');
              const info = await getYouTubeInfo(detection.url);
              this.ytSessions.set(jid, {
                stage: 'quality_picker',
                videoInfo: info,
                statusKey,
              });
              await updateStatus(formatQualityPickerMessage(info));
            } catch (infoErr) {
              const infoErrMsg = infoErr instanceof Error ? infoErr.message : String(infoErr);
              await updateStatus(`❌ *Could not fetch formats (yt-dlp error)*\n${infoErrMsg}`);
            }
            continue;
          }

          // ── Other platforms: existing downloader ───────────────────────────
          const statusMsg = await sock.sendMessage(jid, {
            text: '⏳ *Processing your link...*',
          });
          const statusKey = statusMsg?.key;
          const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

          try {
            const downloadResult = await detectAndDownload(messageText, updateStatus);
            if (downloadResult) {
              const { buffer: mediaBuffer, mediaType, mimetype, caption, filename } = downloadResult;
              await updateStatus('📤 *Uploading to WhatsApp...*');
              if (mediaType === 'video') {
                await sock.sendMessage(jid, { video: mediaBuffer, caption, mimetype });
              } else if (mediaType === 'image') {
                await sock.sendMessage(jid, { image: mediaBuffer, caption, mimetype });
              } else {
                await sock.sendMessage(jid, { document: mediaBuffer, mimetype, fileName: filename, caption });
              }
              if (statusKey) await sock.sendMessage(jid, { delete: statusKey });
              lol(`✅ ${caption.split('\n')[0]} media sent!`);
            } else {
              if (statusKey) await sock.sendMessage(jid, { delete: statusKey });
            }
          } catch (dlErr) {
            const errMsg = dlErr instanceof Error ? dlErr.message : String(dlErr);
            await updateStatus(`❌ *Download failed*\n${errMsg}`);
          }
          continue;
        }

        // ────────────────────────────────────────────────────────────────────
        // .yt <query>  — explicit YouTube search command
        // ────────────────────────────────────────────────────────────────────
        // NOTE: The old "plain text → offer search" feature was removed because
        // the bot's own reply echoes back as a new message, causing an infinite
        // loop.  Use `.yt <query>` to search YouTube explicitly.
        if (messageText.toLowerCase().startsWith('.yt ')) {
          const ytQuery = messageText.slice('.yt '.length).trim();

          if (!ytQuery) {
            await sock.sendMessage(jid, {
              text: '🔍 *YouTube Search*\n\nUsage: `.yt <query>`\nExample: `.yt Pakistan national anthem`',
            });
            continue;
          }

          const statusMsg = await sock.sendMessage(jid, {
            text: `🔍 *Searching YouTube for:* "${ytQuery}"...`,
          });
          const statusKey = statusMsg?.key;
          const updateStatus = this.makeStatusUpdater(sock, jid, statusKey);

          try {
            const results = await searchYouTube(ytQuery, 5);

            if (results.length === 0) {
              await updateStatus('❌ No results found.');
              continue;
            }

            // Store session for result selection
            this.ytSessions.set(jid, {
              stage: 'search_results',
              searchResults: results,
              query: ytQuery,
              statusKey,
            });

            // Build result messages
            const lines = results.map((v, i) => formatSearchResultMessage(v, i)).join('\n\n---\n\n');
            await updateStatus(
              `🎬 *YouTube Search Results*\n_Query: "${ytQuery}"_\n\n` +
              lines +
              `\n\n_Reply with a number (1–${results.length}) to download._`,
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await updateStatus(`❌ *Search failed*\n${errMsg}`);
            this.ytSessions.delete(jid);
          }
          continue;
        }

      } catch (error) {
        console.error('❌ Error processing WhatsApp message:', error);
      }
    }
  }

  /**
   * Returns a function that edits a status message in-place.
   * Non-fatal: failures are swallowed so they don't abort downloads.
   */
  private makeStatusUpdater(
    sock: WASocket,
    jid: string,
    statusKey?: proto.IMessageKey,
  ): (text: string) => Promise<void> {
    return async (text: string) => {
      try {
        if (statusKey && sock) {
          await sock.sendMessage(jid, {
            text,
            edit: statusKey,
          } as Parameters<typeof sock.sendMessage>[1]);
        }
      } catch { /* non-fatal */ }
    };
  }
  public async stop(): Promise<void> {
    lol('🛑 Shutting down server...');
    for (const [id, sock] of this.sockets.entries()) {
      try { sock.end(undefined); } catch {}
    }
    this.sockets.clear();
  }
}

const server = new WhatsAppServer();

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

