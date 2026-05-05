import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Client as DiscordClient, GatewayIntentBits, Message } from 'discord.js';
import qrcode from 'qrcode-terminal';
import * as dotenv from 'dotenv';
import { Boom } from '@hapi/boom';
import P from 'pino';
import sharp from 'sharp';
import { generateMessageID } from '@whiskeysockets/baileys';
import { detectAndDownload } from './libs/downloader';
import {
  searchYouTube,
  getYouTubeInfo,
  downloadYouTubeVideo,
  downloadYouTubeVideoFallback,
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
import { startDashboard, registerUrl, getAllUrls } from './libs/dashboard-server';

dotenv.config();

// ---------------------------------------------------------------------------
// YouTube interactive session state
// ---------------------------------------------------------------------------

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
    // Fallback: strip ":deviceId" before "@"
    return jid.replace(/:\d+(@)/, '$1');
  }
}

class DiscordWhatsAppBridge {
  private whatsappSocket: WASocket | null = null;
  private discordClient: DiscordClient;
  private whatsappReady = false;
  private discordReady = false;
  private isConnecting = false;
  private testMessageSent = false;
  private botSentMessageIds = new Set<string>();
  /**
   * Tracks message IDs that have already been processed to prevent duplicate
   * sticker sends when Baileys replays messages on reconnect. Capped at 500
   * entries to avoid unbounded memory growth.
   */
  private processedMessageIds = new Set<string>();

  /**
   * Per-JID YouTube interactive session state.
   * Key = remoteJid (the chat), Value = current session.
   */
  private ytSessions = new Map<string, YtSession>();

  /**
   * Per-JID movie interactive session state.
   * Stores the displayed search results while the user picks one.
   */
  private movieSessions = new Map<string, MovieSession>();

  /**
   * Per-JID screenshot interactive session state.
   */
  private ssSessions = new Map<string, SsSession>();

  /**
   * JIDs of all authorized senders (owner + admins).
   * Built from the comma-separated WHATSAPP_RECIPIENT env var.
   * Format per number: "<countryCode+number>@s.whatsapp.net"
   */
  private authorizedJids = new Set<string>();

  /**
   * Maps WhatsApp LIDs ("192861614141583@lid") to standard phone JIDs
   * ("923185853847@s.whatsapp.net").
   *
   * WhatsApp multi-device routes messages via LIDs internally. Baileys
   * populates this via the contacts.upsert / contacts.update events.
   */
  private lidToJid = new Map<string, string>();

  constructor() {
    // Initialize Discord client
    this.discordClient = new DiscordClient({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    this.setupDiscord();
    this.setupWhatsApp();
  }

  private async setupWhatsApp(): Promise<void> {
    if (this.isConnecting) {
      console.log('⚠️ Already connecting to WhatsApp, skipping duplicate connection attempt');
      return;
    }

    try {
      this.isConnecting = true;
      console.log('🔧 Initializing WhatsApp connection...');

      // Parse authorized admins from comma-separated env var.
      // We store the normalized JID (strips multi-device ":N" suffix) so that
      // messages from any device of an admin are accepted.
      const rawRecipients = (process.env.WHATSAPP_RECIPIENT ?? '').split(',');
      this.authorizedJids.clear();
      for (const num of rawRecipients) {
        const trimmed = num.trim();
        if (trimmed) {
          const jid = normalizeJid(`${trimmed}@s.whatsapp.net`);
          this.authorizedJids.add(jid);
        }
      }
      console.log(`👥 Authorized senders (${this.authorizedJids.size}): ${[...this.authorizedJids].join(', ')}`);

      const { state, saveCreds } = await useMultiFileAuthState('auth_info');
      const { version, isLatest } = await fetchLatestBaileysVersion();

      console.log(`Using WA version ${version.join('.')}, isLatest: ${isLatest}`);

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['iOS', 'Safari', '1.0.0'],
        defaultQueryTimeoutMs: 60000,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250
      });

      const originalSendMessage = sock.sendMessage.bind(sock);
      sock.sendMessage = async (jid, content, options = {}) => {
        const msgId = options?.messageId || generateMessageID();
        this.botSentMessageIds.add(msgId);
        if (this.botSentMessageIds.size > 1000) {
          const first = this.botSentMessageIds.values().next().value;
          if (first !== undefined) this.botSentMessageIds.delete(first);
        }
        return await originalSendMessage(jid, content, { ...options, messageId: msgId });
      };

      this.whatsappSocket = sock;

      // ── Pairing-code auth (phone-number flow) ──────────────────────────────
      // When WHATSAPP_PHONE is configured we request a numeric pairing code
      // instead of displaying a QR code.  The code must be entered in:
      //   WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number
      const pairingPhone = (process.env.WHATSAPP_PHONE ?? '').replace(/\D/g, '');
      if (pairingPhone && !sock.authState.creds.registered) {
        // Baileys requires a short delay for the socket handshake to complete
        // before requestPairingCode can be called.
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(pairingPhone);
            // Format as XXXX-XXXX for readability
            const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
            console.log('\n🔑 ========================================');
            console.log(`🔑  WhatsApp Pairing Code: ${formatted}`);
            console.log('🔑 ========================================');
            console.log('📱 Open WhatsApp → Settings → Linked Devices → Link a Device');
            console.log('📱 Tap "Link with Phone Number" and enter the code above.\n');
          } catch (err) {
            console.error('❌ Failed to request pairing code:', err);
            console.log('💡 Falling back to QR code — restart without WHATSAPP_PHONE set.');
          }
        }, 3000);
      }

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (pairingPhone) {
            // Pairing-code flow requested — skip QR rendering
            console.log('⏳ QR received but pairing-code mode is active — waiting for code request...');
          } else {
            console.log('\n📱 WhatsApp QR Code Generated:');
            qrcode.generate(qr, { small: true });
            console.log('\n✨ Scan the QR code above with your WhatsApp mobile app');
            console.log('📱 Open WhatsApp → Settings → Linked Devices → Link a Device\n');
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log('\n⚠️ WhatsApp connection closed.');
          console.log('Status code:', statusCode);
          console.log('Reason:', lastDisconnect?.error?.message || 'Unknown');

          if (statusCode === 405) {
            console.log('\n💡 Error 405 usually means:');
            console.log('   - Network/firewall blocking WhatsApp servers');
            console.log('   - VPN/proxy interference');
            console.log('   - Try disabling antivirus/firewall temporarily');
            console.log('   - Check your internet connection\n');
          }

          if (statusCode === 440) {
            console.log('\n💡 Error 440 (conflict) usually means:');
            console.log('   - Another instance of this bot is already running');
            console.log('   - WhatsApp Web is open in another browser/device');
            console.log('   - Close all other WhatsApp sessions and restart\n');
          }

          console.log('Reconnecting:', shouldReconnect);

          this.whatsappReady = false;
          this.isConnecting = false;

          if (shouldReconnect) {
            console.log('Waiting 5 seconds before reconnecting...');
            setTimeout(() => this.setupWhatsApp(), 5000);
          }
        } else if (connection === 'open') {
          console.log('✅ WhatsApp connected successfully!');
          this.whatsappReady = true;
          this.isConnecting = false;
          this.checkBothReady();
        } else if (connection === 'connecting') {
          console.log('🔄 Connecting to WhatsApp...');
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Build LID → phone JID mapping from contacts synced by WhatsApp.
      // WhatsApp multi-device routes messages via LIDs ("123@lid") instead of
      // phone numbers. We need this map to resolve the sender in isAuthorizedSender.
      const upsertContacts = (contacts: { id?: string | null; lid?: string | null }[]) => {
        for (const c of contacts) {
          const phoneJid = c.id ? normalizeJid(c.id) : null;
          const lid = c.lid ? normalizeJid(c.lid) : null;
          if (lid && phoneJid) {
            this.lidToJid.set(lid, phoneJid);
          }
        }
      };
      sock.ev.on('contacts.upsert', upsertContacts);
      sock.ev.on('contacts.update', upsertContacts);

      // Handle incoming WhatsApp messages.
      // We accept BOTH 'notify' (real-time) and 'append' (catch-up) events because
      // WhatsApp sometimes delivers fresh messages as 'append' after a reconnect.
      // Age-based filtering inside handleWhatsAppMessage drops genuine history syncs.
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📬 messages.upsert type="${type}" [${messages.length} msg(s)]`);
        for (const m of messages) {
          const norm = normalizeJid(m.key.remoteJid ?? '');
          const resolvedPhoneJid = this.lidToJid.get(norm) ?? norm;
          console.log(`   └─ from: ${norm}${resolvedPhoneJid !== norm ? ` (→ ${resolvedPhoneJid})` : ''} | fromMe: ${m.key.fromMe} | participant: ${m.key.participant ?? 'n/a'}`);
        }
        await this.handleWhatsAppMessage(messages, type);
      });
    } catch (error) {
      console.error('❌ Error setting up WhatsApp:', error);
      this.isConnecting = false;
      console.log('Retrying in 10 seconds...');
      setTimeout(() => this.setupWhatsApp(), 10000);
    }
  }

  private setupDiscord(): void {
    this.discordClient.on('ready', () => {
      console.log(`✅ Discord bot logged in as ${this.discordClient.user?.tag}`);
      console.log(`📊 Bot is in ${this.discordClient.guilds.cache.size} server(s)`);

      // List all servers the bot is in
      this.discordClient.guilds.cache.forEach(guild => {
        console.log(`   - ${guild.name} (ID: ${guild.id})`);
      });

      const serverId = process.env.DISCORD_SERVER_ID;
      if (serverId) {
        const targetGuild = this.discordClient.guilds.cache.get(serverId);
        if (targetGuild) {
          console.log(`✅ Monitoring server: ${targetGuild.name}`);
        } else {
          console.log(`⚠️ WARNING: Bot is not in the configured server (ID: ${serverId})`);
          console.log(`   Make sure the bot is invited to the correct server!`);
        }
      } else {
        console.log(`⚠️ WARNING: DISCORD_SERVER_ID not set in .env file`);
      }

      this.discordReady = true;
      this.checkBothReady();
    });

    this.discordClient.on('clientReady', () => {
      console.log(`✅ Discord client ready`);
    });

    this.discordClient.on('messageCreate', async (message: Message) => {
      console.log(`📨 Message received: "${message.content}" from ${message.author.username} in ${message.guild?.name || 'DM'} #${message.channel instanceof Object && 'name' in message.channel ? message.channel.name : 'unknown'}`);
      await this.handleDiscordMessage(message);
    });

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error('❌ DISCORD_BOT_TOKEN not found in .env file');
      process.exit(1);
    }

    this.discordClient.login(token);
  }

  private async checkBothReady(): Promise<void> {
    if (this.whatsappReady && this.discordReady && !this.testMessageSent) {
      console.log('🚀 Bridge is fully operational!');
      this.testMessageSent = true;
      await this.startDashboardAndNotify();
    }
  }

  /**
   * Starts the local dashboard HTTP server, exposes it via a Cloudflare tunnel,
   * registers the noVNC URL, and broadcasts the dashboard URL to all admins.
   * Called once when both WhatsApp and Discord are ready.
   */
  private async startDashboardAndNotify(): Promise<void> {
    try {
      console.log('📊 Starting dashboard server...');

      // Also register the noVNC VNC viewer that is started in the workflow
      // (websockify runs on port 6080 → Cloudflare tunnel on port 6080).
      // We expose it here so the dashboard shows it immediately.
      // The actual tunnel for noVNC is started by the workflow; we
      // call getCloudflareTunnelUrl to get / create the URL lazily.
      const { getCloudflareTunnelUrl } = require('./libs/cloudflared');
      const novncUrl: string = await getCloudflareTunnelUrl(6080);
      if (novncUrl) {
        registerUrl('novnc', '🖥️ noVNC Desktop', novncUrl);
      }

      // Register the Python bypasser API (runs on 127.0.0.1:8000; not publicly tunneled,
      // but we still list its local URL so developers know it exists).
      registerUrl('bypasser', '⚡ Python API (local)', 'http://127.0.0.1:8000');

      // Start the dashboard HTTP server on port 4000 + Cloudflare tunnel
      const dashboardPublicUrl = await startDashboard(4000);

      if (!dashboardPublicUrl) {
        console.warn('⚠️ Dashboard tunnel failed — skipping admin notification.');
        return;
      }

      // Calculate session time remaining
      const uptimeSeconds = process.uptime();
      const remainingSeconds = Math.max(0, (5 * 60 * 60) - uptimeSeconds);
      const hoursLeft = Math.floor(remainingSeconds / 3600);
      const minutesLeft = Math.floor((remainingSeconds % 3600) / 60);

      const notifyMsg =
        '🚀 *Bridge Session Started*\n\n' +
        '📊 *Dev Dashboard (Frontend):*\n' +
        `${dashboardPublicUrl}\n\n` +
        '🔧 *Available tools (via dashboard):*\n' +
        '• 🖥️ noVNC Desktop\n' +
        '• ⚡ Python Bypasser API\n' +
        '• 💻 Terminal (use .terminal)\n' +
        '• 🔵 VSCode (use .vscode)\n' +
        '• 🌐 Browser (use .browser)\n\n' +
        `⏱️ *Session time left:* ${hoursLeft}h ${minutesLeft}m\n\n` +
        '_Use `.url` to get all current links at any time._';

      if (this.whatsappSocket && this.authorizedJids.size > 0) {
        for (const jid of this.authorizedJids) {
          await this.whatsappSocket.sendMessage(jid, { text: notifyMsg });
        }
        console.log('📤 Dashboard URL sent to all admins.');
      }
    } catch (err) {
      console.error('❌ Failed to start dashboard or notify admins:', err);
    }
  }

  private async sendTestMessage(): Promise<void> {
    try {
      if (this.authorizedJids.size === 0 || !this.whatsappSocket) {
        console.log('⚠️ Cannot send test message: no recipients or socket not available');
        return;
      }

      const testMessage = '✅ *Bridge Connection Test*\n\n' +
        'WhatsApp ✓\n' +
        'Discord ✓\n\n' +
        'The bridge is now active and monitoring for messages.';

      for (const jid of this.authorizedJids) {
        await this.whatsappSocket.sendMessage(jid, { text: testMessage });
      }

      console.log('📤 Test message sent to WhatsApp successfully!');
    } catch (error) {
      console.error('❌ Error sending test message:', error);
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
      console.log(`🚫 Unauthorized sender — raw: ${rawJid} | resolved: ${senderJid} | lidMap size: ${this.lidToJid.size}`);
      console.log(`   Authorized list: ${[...this.authorizedJids].join(', ')}`);
    }

    return allowed;
  }

  /**
   * Calls the local Python API to remove the background of an image.
   * Falls back to the original buffer if the API fails.
   */
  private async removeBackground(inputBuffer: Buffer): Promise<Buffer> {
    try {
      console.log('🤖 Sending image to Python API for background removal...');
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
      console.log('✅ Background removed successfully!');
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
      console.log('🤖 Sending image to Python API for OCR...');
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
      console.log('🤖 Sending audio to Python API for transcription...');
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
      console.log(`🤖 Sending URL to Python API for screenshot: ${url}`);
      const response = await fetch('http://127.0.0.1:8000/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, full_page: fullPage, format }),
      });

      if (!response.ok) {
        throw new Error(`Python API responded with ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      console.log('✅ Screenshot captured successfully!');
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
    messages: proto.IWebMessageInfo[],
    type: string = 'notify',
  ): Promise<void> {
    for (const msg of messages) {
      try {
        console.log("msg", msg)
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // ── Skip bot's own echoed messages (loop prevention) ─────────────────
        // WhatsApp re-delivers every message the bot sends back via
        // messages.upsert with fromMe=true.  Processing these causes the bot
        // to reply to its own replies, creating an infinite message loop.
        // We track messages sent by the bot and ignore them.
        if (msg.key.fromMe && msg.key.id && this.botSentMessageIds.has(msg.key.id)) {
          console.log(`⏭️ Skipping bot's own echoed message`);
          continue;
        }

        // ── Age filter ───────────────────────────────────────────────────────
        // Filter out old messages (older than 60s) to avoid acting on history
        // syncs or queued messages from previous sessions, regardless of type.
        const tsRaw = msg.messageTimestamp;
        const tsSeconds: number =
          typeof tsRaw === 'number'
            ? tsRaw
            : (tsRaw != null && typeof (tsRaw as { low?: number }).low === 'number')
              ? (tsRaw as { low: number }).low
              : 0;
        const ageSeconds = Math.floor(Date.now() / 1000) - tsSeconds;
        if (tsSeconds > 0 && ageSeconds > 60) {
          console.log(`⏭️ Skipping old message (${ageSeconds}s ago) from ${msg.key.remoteJid}`);
          continue;
        }

        if (!this.isAuthorizedSender(msg)) continue;

        const msgUniqueId = `${msg.key.remoteJid}:${msg.key.id}`;
        if (this.processedMessageIds.has(msgUniqueId)) {
          console.log(`⏭️ Skipping already-processed message (${msgUniqueId})`);
          continue;
        }
        if (this.processedMessageIds.size >= 500) {
          const firstEntry = this.processedMessageIds.values().next().value;
          if (firstEntry !== undefined) this.processedMessageIds.delete(firstEntry);
        }
        this.processedMessageIds.add(msgUniqueId);

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
        const sock = this.whatsappSocket!;
        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        // ── .url command ─────────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.url') {
          console.log('📊 Detected .url command...');
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
            '• `.rbg` - Just remove background (reply to image)\n\n' +
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

        // ── .reveal command ──────────────────────────────────────────────────
        if (messageText.toLowerCase() === '.reveal') {
          const voMsg = quotedMessage?.viewOnceMessageV2?.message || quotedMessage?.viewOnceMessage?.message || quotedMessage;

          if (voMsg?.imageMessage || voMsg?.videoMessage) {
            console.log('👀 Detected .reveal command on view-once media...');
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
          console.log('💻 Detected .terminal command...');
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
          console.log('💻 Detected .vscode command...');
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
          console.log('🌐 Detected .browser command...');
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
            console.log('📱 Detected .android start command...');
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
                  `🖥️ *Access via noVNC:*\n${result.vncUrl || 'Use .url command'}\n\n` +
                  `📱 *Device:* Pixel 5\n` +
                  `🤖 *Android:* 13 (API 33)\n\n` +
                  `💡 *Tips:*\n` +
                  `• Open the noVNC link in your browser\n` +
                  `• The Android screen is mirrored via scrcpy\n` +
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
            console.log('📱 Detected .android status command...');
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
                  `📱 *Device:* ${status.deviceInfo || 'Pixel 5'}\n` +
                  `🖥️ *noVNC:* ${status.vncUrl || 'Use .url command'}\n\n` +
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
            console.log('📱 Detected .android stop command...');
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
              '• Android 13 (API 33)\n' +
              '• Pixel 5 device profile\n' +
              '• Access via noVNC in browser\n' +
              '• Full touch and keyboard support'
          }, { quoted: msg });
          continue;
        }

        // ── .rbg command ─────────────────────────────────────────────────────
        if (quotedMessage?.imageMessage && messageText.toLowerCase() === '.rbg') {
          console.log('🖼️ Detected .rbg command on image reply...');
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
          const updateStatus = this.makeStatusUpdater(jid, statusKey);

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
          console.log(`🖼️ Detected sticker command (bg removal: ${wantBgRemoval}) on image reply...`);

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
          console.log('✅ Image converted to sticker and sent!');
          continue;
        }

        // ── .ocr command ───────────────────────────────────────────────────
        if (quotedMessage?.imageMessage && messageText.toLowerCase() === '.ocr') {
          console.log('🖼️ Detected .ocr command on image reply...');
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
          console.log('🎙️ Detected .whisper command, transcribing...');
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
            
            const updateStatus = this.makeStatusUpdater(jid, statusKey);
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
              const updateStatus = this.makeStatusUpdater(jid, movieStatusKey);

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

              console.log(`[Movie] Links shown for "${chosen.title}", awaiting download confirm`);
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
              const updateStatus = this.makeStatusUpdater(jid, movieStatusKey);
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

                console.log(`✅ Movie downloaded and sent: "${chosen.title}"`);
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const updateStatus2 = this.makeStatusUpdater(jid, movieStatusKey);
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

            const updateStatus = this.makeStatusUpdater(jid, statusKey);

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
            const updateStatus = this.makeStatusUpdater(jid, statusKey);

            try {
              const result = await downloadYouTubeVideo(info.url, quality, updateStatus);

              await updateStatus('📤 *Uploading to WhatsApp...*');
              console.log(`📤 Sending YouTube ${quality.key} (${(result.buffer.length / 1024 / 1024).toFixed(1)} MB) to ${jid}`);

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
              console.log(`✅ YouTube ${quality.key} sent!`);
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
            const updateStatus = this.makeStatusUpdater(jid, statusKey);

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
              console.warn('[index] getYouTubeInfo failed, attempting direct fallback download:', infoErrMsg);
              await updateStatus(
                `⚠️ *Could not fetch formats (yt-dlp error)*\n_${infoErrMsg}_\n\n🔄 *Attempting fallback download...*`,
              );
              try {
                const fallbackResult = await downloadYouTubeVideoFallback(detection.url, updateStatus);
                await updateStatus('📤 *Uploading to WhatsApp...*');
                await sock.sendMessage(jid, {
                  video: fallbackResult.buffer,
                  caption: fallbackResult.caption,
                  mimetype: fallbackResult.mimetype,
                });
                if (statusKey) await sock.sendMessage(jid, { delete: statusKey });
                console.log('✅ YouTube fallback download sent!');
              } catch (fallbackErr) {
                const fallbackErrMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                await updateStatus(`❌ *All download methods failed*\n${fallbackErrMsg}`);
              }
            }
            continue;
          }

          // ── Other platforms: existing downloader ───────────────────────────
          const statusMsg = await sock.sendMessage(jid, {
            text: '⏳ *Processing your link...*',
          });
          const statusKey = statusMsg?.key;
          const updateStatus = this.makeStatusUpdater(jid, statusKey);

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
              console.log(`✅ ${caption.split('\n')[0]} media sent!`);
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
          const updateStatus = this.makeStatusUpdater(jid, statusKey);

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
    jid: string,
    statusKey?: proto.IMessageKey,
  ): (text: string) => Promise<void> {
    return async (text: string) => {
      try {
        if (statusKey && this.whatsappSocket) {
          await this.whatsappSocket.sendMessage(jid, {
            text,
            edit: statusKey,
          } as Parameters<typeof this.whatsappSocket.sendMessage>[1]);
        }
      } catch { /* non-fatal */ }
    };
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) {
      console.log(`   ⏭️ Skipping bot message`);
      return;
    }

    // Check if message is from the configured server
    const serverId = process.env.DISCORD_SERVER_ID;
    if (!serverId) {
      console.error('❌ DISCORD_SERVER_ID not configured');
      return;
    }

    // Only process messages from the specified server
    if (message.guildId !== serverId) {
      console.log(`   ⏭️ Skipping message from different server (${message.guildId} != ${serverId})`);
      return;
    }

    console.log(`   ✅ Message matches server ID, processing...`);

    if (!this.whatsappReady || !this.whatsappSocket) {
      console.log('   ⚠️ WhatsApp not ready, skipping message');
      return;
    }

    try {
      if (this.authorizedJids.size === 0) {
        console.error('❌ WHATSAPP_RECIPIENT not configured or empty');
        return;
      }

      // Get channel name
      const channelName = message.channel instanceof Object && 'name' in message.channel
        ? message.channel.name
        : 'unknown';

      // Format the message
      const formattedMessage = `*Discord Message*\n` +
        `Server: ${message.guild?.name || 'Unknown'}\n` +
        `Channel: #${channelName}\n` +
        `From: ${message.author.username}\n` +
        `---\n${message.content}`;

      // Broadcast to all authorized recipients
      for (const jid of this.authorizedJids) {
        await this.whatsappSocket.sendMessage(jid, { text: formattedMessage });
      }

      console.log(`   ✉️ Forwarded message from ${message.author.username} (#${channelName}) to ${this.authorizedJids.size} recipient(s)`);
    } catch (error) {
      console.error('❌ Error sending message to WhatsApp:', error);
    }
  }

  public async stop(): Promise<void> {
    console.log('🛑 Shutting down bridge...');
    // Don't logout from WhatsApp, just close the socket to preserve session
    if (this.whatsappSocket) {
      this.whatsappSocket.end(undefined);
    }
    await this.discordClient.destroy();
  }
}

// Start the bridge
const bridge = new DiscordWhatsAppBridge();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await bridge.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bridge.stop();
  process.exit(0);
});
