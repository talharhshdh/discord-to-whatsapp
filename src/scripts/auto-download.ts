import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import P from 'pino';
import { searchMovies } from '../libs/movie-search';
import { downloadMovie } from '../libs/movie-downloader';
import * as fs from 'fs';
import * as path from 'path';

const result = dotenv.config();
if (result.error) {
  console.log('⚠️ Warning: Could not load .env file. Using system environment variables.');
} else {
  console.log('✅ .env file loaded successfully.');
}

function normalizeJid(jid: string): string {
  return jidNormalizedUser(jid);
}

async function runAutoDownload() {
  console.log('🎬 Starting auto-download script...');

  const query = 'spiderman';
  const recipients = "923185853847"

  const targetJid = `${recipients}@s.whatsapp.net`;
  console.log(`🎯 Target recipient: ${targetJid}`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['Auto Downloader', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise<void>((resolve, reject) => {
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('✅ WhatsApp connected!');

        try {
          console.log(`🔍 Searching for "${query}"...`);
          const results = await searchMovies(query, 1);

          if (results.length === 0) {
            console.log('❌ No results found for spiderman.');
            await sock.sendMessage(targetJid, { text: '❌ *Auto-Download Failed*: No results found for "spiderman".' });
            resolve();
            return;
          }

          const movie = results[0];
          const year = movie.releaseDate ? ` (${movie.releaseDate.slice(0, 4)})` : '';
          console.log(`🎬 Found: ${movie.title}${year}`);

          const statusMsg = await sock.sendMessage(targetJid, { text: `🎬 *Auto-Downloading:* ${movie.title}${year}...` });
          const statusKey = statusMsg?.key;

          const updateStatus = async (msg: string) => {
            console.log(`[Status] ${msg}`);
            if (statusKey) {
              await sock.sendMessage(targetJid, { text: msg, edit: statusKey });
            }
          };

          const { getCloudflareTunnelUrl } = require('../libs/cloudflared');
          let vncUrl = await getCloudflareTunnelUrl();

          if (vncUrl) {
            await sock.sendMessage(targetJid, { text: `🤖 *Download starting for ${movie.title}!*\n\nIf the automated bypass gets stuck on Cloudflare, please open this remote browser link and click the verify checkbox:\n🔗 ${vncUrl}/vnc.html` });
          }

          let dlResult: any = null;
          try {
            dlResult = await downloadMovie(
              movie.tmdbId,
              movie.mediaType,
              movie.title + year,
              updateStatus
            );
          } catch (err) {
            console.error('❌ Error during auto-download:', err);

            // Generate direct embed URL for the user to open
            const embedUrl = `https://screenfetch2.xyz/embed/${movie.mediaType}?tmdb=${movie.tmdbId}`;

            await sock.sendMessage(targetJid, {
              text: `⚠️ *Cloudflare Blocked the Downloader*\n\nI couldn't automatically bypass Cloudflare to get the video link for *${movie.title}*.\n\nCould you please open this link in your browser, grab the \`.m3u8\` link from the network tab, and reply to this message with it?\n\n🔗 ${embedUrl}\n\n_Waiting 10 minutes for your reply..._`
            });

            console.log('⏳ Waiting up to 10 minutes for the user to reply with the .m3u8 link...');

            const m3u8Link = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Timeout waiting for m3u8 link')), 10 * 60 * 1000);

              const listener = (m: any) => {
                const msg = m.messages[0];
                if (!msg.message || msg.key.remoteJid !== targetJid || msg.key.fromMe) return;

                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                // Look for an m3u8 URL anywhere in the message
                const match = text.match(/https?:\/\/[^\s]+\.m3u8/);
                if (match) {
                  clearTimeout(timeout);
                  sock.ev.off('messages.upsert', listener);
                  resolve(match[0]);
                }
              };

              sock.ev.on('messages.upsert', listener);
            });

            console.log(`✅ Received m3u8 link from user: ${m3u8Link}`);
            await updateStatus('📥 *Received manual link, downloading...*');

            // Import the helper function we just exported
            const { downloadM3u8 } = require('../libs/movie-downloader');
            const filePath = await downloadM3u8(m3u8Link, movie.title + year, updateStatus);

            dlResult = {
              filePath,
              filename: `${movie.title.replace(/[^\w\s\-().]/g, '')}.mp4`,
              mimetype: 'video/mp4',
              caption: `🎬 *${movie.title}${year}*\n📥 Downloaded manually via user provided link`
            };
          }

          console.log('📤 Uploading to WhatsApp...');
          await updateStatus('📤 *Uploading to WhatsApp...*');

          const videoBuffer = fs.readFileSync(dlResult.filePath);
          await sock.sendMessage(targetJid, {
            video: videoBuffer,
            mimetype: dlResult.mimetype,
            caption: `🎁 *Auto-Download: ${movie.title}*\n\n${dlResult.caption}`,
            fileName: dlResult.filename,
          });

          if (statusKey) await sock.sendMessage(targetJid, { delete: statusKey });
          fs.unlinkSync(dlResult.filePath);

          console.log('✅ Done!');
          resolve();
        } catch (err) {
          console.error('❌ Global error during download process:', err);
          await sock.sendMessage(targetJid, { text: `❌ *Auto-Download Error:*\n${err instanceof Error ? err.message : String(err)}` });

          if (fs.existsSync('cf_screenshot.png')) {
            console.log('📸 Sending Cloudflare screenshot to recipient...');
            const screenshot = fs.readFileSync('cf_screenshot.png');
            await sock.sendMessage(targetJid, {
              image: screenshot,
              caption: '⚠️ Cloudflare challenge/failure screenshot'
            });
            fs.unlinkSync('cf_screenshot.png');
          }

          reject(err);
        } finally {
          setTimeout(() => {
            sock.logout();
            process.exit(0);
          }, 5000);
        }
      } else if (connection === 'close') {
        console.log('⚠️ Connection closed.');
        // If it's a logout or something else, we might need to handle it,
        // but for a one-off script, we just wait for 'open'.
      }
    });
  });
}

runAutoDownload().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
