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

dotenv.config();

function normalizeJid(jid: string): string {
  return jidNormalizedUser(jid);
}

async function runAutoDownload() {
  console.log('🎬 Starting auto-download script...');

  const query = 'spiderman';
  const recipients = (process.env.WHATSAPP_RECIPIENT ?? '').split(',').map(r => r.trim()).filter(Boolean);

  if (recipients.length === 0) {
    console.error('❌ No WHATSAPP_RECIPIENT found in .env');
    process.exit(1);
  }

  const targetJid = `${recipients[0]}@s.whatsapp.net`;
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

          const dlResult = await downloadMovie(
            movie.tmdbId,
            movie.mediaType,
            movie.title + year,
            updateStatus
          );

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
          console.error('❌ Error during download:', err);
          await sock.sendMessage(targetJid, { text: `❌ *Auto-Download Error:*\n${err instanceof Error ? err.message : String(err)}` });
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
