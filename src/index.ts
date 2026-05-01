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

dotenv.config();

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
      // We MUST check `type === 'notify'` — Baileys fires this event with
      // type === 'append' for historical/synced messages every time the bot
      // reconnects, which would cause stickers/downloads to re-trigger.
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') {
          console.log(`⏭️ Skipping messages.upsert event (type="${type}", not real-time) [${messages.length} msg(s)]`);
          return;
        }
        console.log(`📬 Incoming notify event: ${messages.length} message(s)`);
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
        // Ignore if no message or if it's from status broadcast
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // Allow the owner (fromMe) OR any authorized admin in WHATSAPP_RECIPIENT
        if (!this.isAuthorizedSender(msg)) continue;

        // Deduplication guard — belt-and-suspenders protection against the bot
        // processing the same message twice (e.g., rapid reconnects emitting a
        // duplicate 'notify' event). Key = remoteJid + messageId.
        const msgUniqueId = `${msg.key.remoteJid}:${msg.key.id}`;
        if (this.processedMessageIds.has(msgUniqueId)) {
          console.log(`⏭️ Skipping already-processed message (${msgUniqueId})`);
          continue;
        }
        // Cap set size to avoid unbounded memory growth
        if (this.processedMessageIds.size >= 500) {
          const firstEntry = this.processedMessageIds.values().next().value;
          if (firstEntry !== undefined) {
            this.processedMessageIds.delete(firstEntry);
          }
        }
        this.processedMessageIds.add(msgUniqueId);

        // Get the message text
        const messageText = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        // ── .sticker command ─────────────────────────────────────────────
        // Reply to any image with ".sticker" to convert it to a WhatsApp sticker.
        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        if (quotedMessage && quotedMessage.imageMessage && messageText.trim().toLowerCase() === '.sticker') {
          console.log('🖼️ Detected .sticker command on image reply, converting to sticker...');

          const quotedMsg: proto.IWebMessageInfo = {
            key: msg.key,
            message: { imageMessage: quotedMessage.imageMessage }
          };

          const buffer = await downloadMediaMessage(
            quotedMsg,
            'buffer',
            {},
            {
              logger: P({ level: 'silent' }),
              reuploadRequest: this.whatsappSocket!.updateMediaMessage
            }
          );

          const stickerBuffer = await sharp(buffer as Buffer)
            .resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .webp()
            .toBuffer();

          await this.whatsappSocket!.sendMessage(msg.key.remoteJid!, {
            sticker: stickerBuffer
          });

          console.log('✅ Image converted to sticker and sent!');
          continue; // done with this message
        }

        // ── Platform media downloader ─────────────────────────────────────
        // When you send yourself a link (fromMe) from a supported platform
        // (Instagram, TikTok, Facebook, Twitter/X, YouTube, MediaFire,
        //  CapCut, Google Drive, Pinterest) the bot will automatically
        //  download the media and send it back to the same chat.
        if (messageText.trim()) {
          const downloadResult = await detectAndDownload(messageText);

          if (downloadResult) {
            const { buffer: mediaBuffer, mediaType, mimetype, caption, filename } = downloadResult;
            const jid = msg.key.remoteJid!;

            console.log(`📤 Sending ${mediaType} (${(mediaBuffer.length / 1024).toFixed(1)} KB) to ${jid}`);

            if (mediaType === 'video') {
              await this.whatsappSocket!.sendMessage(jid, {
                video: mediaBuffer,
                caption,
                mimetype,
              });
            } else if (mediaType === 'image') {
              await this.whatsappSocket!.sendMessage(jid, {
                image: mediaBuffer,
                caption,
                mimetype,
              });
            } else {
              // Send as a document (e.g. APK from MediaFire, Drive files)
              await this.whatsappSocket!.sendMessage(jid, {
                document: mediaBuffer,
                mimetype,
                fileName: filename,
                caption,
              });
            }

            console.log(`✅ ${caption.split('\n')[0]} media sent!`);
          }
        }
      } catch (error) {
        console.error('❌ Error processing WhatsApp message:', error);
      }
    }
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
