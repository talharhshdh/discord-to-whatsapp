import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  WASocket,
  proto,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Client as DiscordClient, GatewayIntentBits, Message } from 'discord.js';
import qrcode from 'qrcode-terminal';
import * as dotenv from 'dotenv';
import { Boom } from '@hapi/boom';
import P from 'pino';
import sharp from 'sharp';

dotenv.config();

class DiscordWhatsAppBridge {
  private whatsappSocket: WASocket | null = null;
  private discordClient: DiscordClient;
  private whatsappReady = false;
  private discordReady = false;
  private isConnecting = false;
  private testMessageSent = false;

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

      // Handle incoming WhatsApp messages for image-to-sticker conversion
      sock.ev.on('messages.upsert', async ({ messages }) => {
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
      const recipient = process.env.WHATSAPP_RECIPIENT;
      if (!recipient || !this.whatsappSocket) {
        console.log('⚠️ Cannot send test message: recipient or socket not available');
        return;
      }

      const testMessage = '✅ *Bridge Connection Test*\n\n' +
        'WhatsApp ✓\n' +
        'Discord ✓\n\n' +
        'The bridge is now active and monitoring for messages.';

      const jid = `${recipient}@s.whatsapp.net`;
      await this.whatsappSocket.sendMessage(jid, { text: testMessage });
      
      console.log('📤 Test message sent to WhatsApp successfully!');
    } catch (error) {
      console.error('❌ Error sending test message:', error);
    }
  }

  private async handleWhatsAppMessage(messages: proto.IWebMessageInfo[]): Promise<void> {
    for (const msg of messages) {
      try {
        // Ignore if no message or if it's from status broadcast
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        // Get the message text
        const messageText = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || 
                           '';

        // Check if this is a reply to an image with ".sticker" command
        const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (quotedMessage && quotedMessage.imageMessage && messageText.trim().toLowerCase() === '.sticker') {
          console.log('🖼️ Detected .sticker command on image reply, converting to sticker...');
          
          // Download the quoted image
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

          // Convert image to sticker format (WebP, max 512x512)
          const stickerBuffer = await sharp(buffer as Buffer)
            .resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .webp()
            .toBuffer();

          // Send as sticker
          await this.whatsappSocket!.sendMessage(msg.key.remoteJid!, {
            sticker: stickerBuffer
          });

          console.log('✅ Image converted to sticker and sent!');
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
      const recipient = process.env.WHATSAPP_RECIPIENT;
      if (!recipient) {
        console.error('❌ WHATSAPP_RECIPIENT not configured');
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

      // Send to WhatsApp (format: number@s.whatsapp.net)
      const jid = `${recipient}@s.whatsapp.net`;
      await this.whatsappSocket.sendMessage(jid, { text: formattedMessage });
      
      console.log(`   ✉️ Forwarded message from ${message.author.username} (#${channelName}) to WhatsApp`);
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
