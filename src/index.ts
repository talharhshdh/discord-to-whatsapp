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
        browser: ['Discord Bridge', 'Chrome', '1.0.0'],
        defaultQueryTimeoutMs: 60000,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250
      });

      this.whatsappSocket = sock;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('\n📱 WhatsApp QR Code Generated:');
          qrcode.generate(qr, { small: true });
          console.log('\n✨ Scan the QR code above with your WhatsApp mobile app');
          console.log('📱 Open WhatsApp → Settings → Linked Devices → Link a Device\n');
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
        await this.handleWhatsAppMessage(messages);
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
      // await this.sendTestMessage();
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
    // Owner: message sent from the linked device itself
    if (msg.key.fromMe) return true;
    // console.log("Msg:", msg)
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
    );

    if (!allowed) {
      console.log(`🚫 Unauthorized sender — raw: ${rawJid} | resolved: ${senderJid} | lidMap size: ${this.lidToJid.size}`);
      console.log(`   Authorized list: ${[...this.authorizedJids].join(', ')}`);
    }

    return allowed;
  }

  private async handleWhatsAppMessage(messages: proto.IWebMessageInfo[]): Promise<void> {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

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

        const messageText = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        const jid = msg.key.remoteJid!;
        const sock = this.whatsappSocket!;

        // ── .sticker command ────────────────────────────────────────────────
        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMessage?.imageMessage && messageText.toLowerCase() === '.sticker') {
          console.log('🖼️ Detected .sticker command on image reply, converting to sticker...');
          const quotedMsg: proto.IWebMessageInfo = {
            key: msg.key,
            message: { imageMessage: quotedMessage.imageMessage },
          };
          const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
          });
          const stickerBuffer = await sharp(buffer as Buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();
          await sock.sendMessage(jid, { sticker: stickerBuffer });
          console.log('✅ Image converted to sticker and sent!');
          continue;
        }

        if (!messageText) continue;

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
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await updateStatus(`❌ *Failed to get video info*\n${errMsg}`);
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
        // Plain text → offer YouTube search
        // ────────────────────────────────────────────────────────────────────
        // Only trigger if text looks like a search query (not a command, not a URL)
        const isUrl = /^https?:\/\//i.test(messageText);
        const isCommand = messageText.startsWith('.');
        const isShortNum = /^\d{1,2}$/.test(messageText); // could be a session reply

        if (!isUrl && !isCommand && !isShortNum && messageText.length >= 3) {
          // Offer a "Search YouTube" prompt
          await sock.sendMessage(jid, {
            text:
              `🔍 *Search YouTube for:* "${messageText}"?\n\n` +
              `Reply *y* or *yes* to search, or just ignore this message.`,
          });
          // Store pending search query so the next reply can trigger it
          this.ytSessions.set(jid, {
            stage: 'search_results',
            query: messageText,
            // no searchResults yet — we populate after user confirms
          });
          continue;
        }

        // ── Handle "yes" confirmation for pending YouTube search ─────────────
        if (
          (messageText.toLowerCase() === 'y' || messageText.toLowerCase() === 'yes') &&
          session?.stage === 'search_results' &&
          session.query &&
          !session.searchResults
        ) {
          const query = session.query;
          this.ytSessions.delete(jid);

          const statusMsg = await sock.sendMessage(jid, {
            text: `🔍 *Searching YouTube for:* "${query}"...`,
          });
          const statusKey = statusMsg?.key;
          const updateStatus = this.makeStatusUpdater(jid, statusKey);

          try {
            const results = await searchYouTube(query, 5);

            if (results.length === 0) {
              await updateStatus('❌ No results found.');
              continue;
            }

            // Store session for result selection
            this.ytSessions.set(jid, {
              stage: 'search_results',
              searchResults: results,
              query,
              statusKey,
            });

            // Build result messages
            const lines = results.map((v, i) => formatSearchResultMessage(v, i)).join('\n\n---\n\n');
            await updateStatus(
              `🎬 *YouTube Search Results*\n_Query: "${query}"_\n\n` +
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
