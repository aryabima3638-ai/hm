// MTProto (gramjs) - untuk download/kirim file besar (sampai 2GB) yang melebihi batas Bot API (20MB/50MB)
const fs = require('fs');
const path = require('path');
const S = require('../setting');
const { sleep } = require('./util');

const SESSION = path.join(__dirname, '..', 'data', 'mtproto.session');
let client = null;
let ready = false;
const cache = new Map(); // "uid:msgId" -> { m, at }

function onMsg(e) {
  try {
    const m = e.message;
    if (!m || !m.document || !m.isPrivate) return;
    cache.set(`${String(m.senderId)}:${m.id}`, { m, at: Date.now() });
    if (cache.size > 200) {
      const old = Date.now() - 30 * 60e3;
      for (const [k, v] of cache) if (v.at < old) cache.delete(k);
    }
  } catch {}
}

let lastError = '';
const TOKFILE = SESSION + '.bot';
const botId = () => String(S.botToken || '').split(':')[0];

function cfg() {
  const id = parseInt(String(S.apiId || '').replace(/[^0-9]/g, ''), 10);
  const hash = String(S.apiHash || '').replace(/[\s"']/g, '');
  return { id, hash };
}

function explain(e) {
  const m = String((e && e.message) || e || '');
  if (/Cannot find module 'telegram|Cannot find module "telegram/.test(m)) return 'Paket "telegram" belum terpasang. Jalankan: npm install (di panel: Startup -> install/update packages) lalu restart.';
  if (/API_ID_INVALID/.test(m)) return 'API ID / API HASH salah (pasangannya tidak cocok). Ambil ulang di https://my.telegram.org -> API development tools, salin tanpa spasi.';
  if (/ACCESS_TOKEN_INVALID|BOT_TOKEN_INVALID|token/i.test(m) && /invalid|expired/i.test(m)) return 'Token bot salah/kedaluwarsa. Cek BOT_TOKEN.';
  if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(m)) return 'Session lama tidak valid (otomatis dihapus, restart bot).';
  if (/FLOOD/.test(m)) return 'Telegram membatasi login sementara (' + m + '). Tunggu lalu restart bot, jangan restart berulang kali.';
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|Connection/i.test(m)) return 'Server/panel tidak bisa tersambung ke Telegram (MTProto) - kemungkinan port/IP Telegram diblokir host. Coba host lain atau pakai link direct untuk ZIP besar. Detail: ' + m;
  return m;
}

function dropSession() { try { fs.unlinkSync(SESSION); } catch {} try { fs.unlinkSync(TOKFILE); } catch {} }

async function connectOnce(id, hash) {
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const { NewMessage } = require('telegram/events');
  // session milik bot lain (token diganti) -> buang
  try { if (fs.existsSync(SESSION) && fs.existsSync(TOKFILE) && fs.readFileSync(TOKFILE, 'utf8').trim() !== botId()) dropSession(); } catch {}
  const str = fs.existsSync(SESSION) ? fs.readFileSync(SESSION, 'utf8').trim() : '';
  client = new TelegramClient(new StringSession(str), id, hash, { connectionRetries: 5, autoReconnect: true });
  try { client.setLogLevel('error'); } catch {}
  await Promise.race([
    client.start({ botAuthToken: S.botToken }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: tidak ada respon dari Telegram dalam 60 detik')), 60000)),
  ]);
  fs.mkdirSync(path.dirname(SESSION), { recursive: true });
  fs.writeFileSync(SESSION, client.session.save());
  fs.writeFileSync(TOKFILE, botId());
  client.addEventHandler(onMsg, new NewMessage({ incoming: true }));
}

async function init() {
  ready = false; lastError = '';
  const { id, hash } = cfg();
  if (!id || !hash) {
    lastError = 'API_ID / API_HASH kosong (env API_ID dan API_HASH belum terbaca).';
    console.log('[mtproto] NONAKTIF: ' + lastError + ' -> ZIP maksimal 20MB lewat Telegram, atau pakai link direct.');
    return false;
  }
  if (!(id > 0) || !/^[0-9a-f]{32}$/i.test(hash)) {
    lastError = 'Format salah: API ID harus angka, API HASH harus 32 karakter huruf/angka (hex). Terbaca ID=' + id + ', HASH panjang=' + hash.length + '.';
    console.log('[mtproto] NONAKTIF: ' + lastError);
    return false;
  }
  for (let t = 1; t <= 2 && !ready; t++) {
    try {
      await connectOnce(id, hash);
      ready = true;
      console.log('[mtproto] AKTIF -> ZIP sampai 2GB didukung.');
    } catch (e) {
      lastError = explain(e);
      console.error('[mtproto] gagal start (' + t + '/2): ' + lastError);
      try { if (client) await client.disconnect(); } catch {}
      client = null;
      if (t === 1) { dropSession(); await sleep(1500); }
    }
  }
  return ready;
}

async function download(uid, msgId, dest, onProgress, shouldAbort) {
  if (!ready) throw new Error('MTProto nonaktif');
  let item;
  for (let i = 0; i < 24 && !item; i++) {
    item = cache.get(`${uid}:${msgId}`);
    if (!item) await sleep(500);
  }
  if (!item) throw new Error('Pesan ZIP tidak terbaca oleh MTProto. Kirim ulang ZIP-nya.');
  await client.downloadMedia(item.m, {
    outputFile: dest,
    progressCallback: (rec, tot) => {
      if (shouldAbort && shouldAbort()) throw new Error('ABORT');
      onProgress(Number(rec.toString()), Number(tot.toString()));
    },
  });
  cache.delete(`${uid}:${msgId}`);
}

async function sendFile(chatId, file, filename, caption, onProgress) {
  if (!ready) throw new Error('MTProto nonaktif');
  const { CustomFile } = require('telegram/client/uploads');
  const size = fs.statSync(file).size;
  await client.sendFile(chatId, {
    file: new CustomFile(filename, size, file),
    caption, forceDocument: true, workers: 6,
    progressCallback: (p) => onProgress && onProgress(Math.round(Number(p) * 100)),
  });
}

module.exports = { init, download, sendFile, isReady: () => ready, lastError: () => lastError, info: () => { const c = cfg(); return { ready, lastError, hasId: !!c.id, idLen: String(c.id || '').length, hashLen: c.hash.length }; } };
