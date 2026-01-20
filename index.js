/*
  FINAL STABLE WhatsApp <-> Telegram Bridge for Render
  - Headless Chromium (no UI) using @sparticuz/chromium
  - Sends WhatsApp QR image to Telegram for remote login
  - Keeps all original tracing: messages, media, calls, status, errors
  - Queue + retry for Telegram (rate-limit safe)
  - Deduplication to avoid spam
  - Telegram reply -> WhatsApp

  Install:
    npm i whatsapp-web.js node-telegram-bot-api qrcode express @sparticuz/chromium puppeteer-core

  Env:
    TELEGRAM_TOKEN
    CHAT_ID
    PORT (Render auto)
    MAX_MEDIA_SIZE_MB (optional)
*/

const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');


const TELEGRAM_TOKEN = "7697793505:AAHIr4VAnYktrD28_xxx7GItVfZ-NuMY2zI";
const CHAT_ID = "7795828902";
const PORT = 3000;
const MAX_MEDIA_SIZE_MB = parseFloat('50');

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN or CHAT_ID missing');
  process.exit(1);
}

function escapeHTML(text = '') {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Telegram with queue & retry ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let lastSend = 0;
async function tgSend(fn, retry = 0) {
  try {
    const delay = Math.max(0, 800 - (Date.now() - lastSend));
    await new Promise(r => setTimeout(r, delay));
    lastSend = Date.now();
    await fn();
  } catch (e) {
    if (retry < 3) return tgSend(fn, retry + 1);
    console.error('Telegram error:', e.message);
  }
}

function notify(text) {
  return tgSend(() => bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }));
}

function sendDoc(buffer, caption, filename) {
  return tgSend(() => bot.sendDocument(CHAT_ID, buffer, { caption, filename, parse_mode: 'HTML' }));
}

// ---------- Dedup ----------
const seen = new Set();
function dedupe(key, ttl = 10000) {
  if (seen.has(key)) return true;
  seen.add(key);
  setTimeout(() => seen.delete(key), ttl);
  return false;
}

// ---------- WhatsApp Client (Render compatible) ----------
async function start() {
  const executablePath = await chromium.executablePath();

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath,
      headless: chromium.headless,
      args: chromium.args
    }
  });

  // ---- QR to Telegram ----
  client.on('qr', async (qr) => {
    try {
      const qrBuffer = await qrcode.toBuffer(qr);
      await bot.sendPhoto(CHAT_ID, qrBuffer, { caption: '🔑 Scan this QR in WhatsApp → Linked Devices' });
    } catch (e) {
      await notify('❌ QR send failed: ' + escapeHTML(e.message));
    }
  });

  client.on('authenticated', () => notify('✅ <b>WhatsApp Authenticated</b>'));
  client.on('ready', () => notify('🟢 <b>WhatsApp Connected & Ready</b>'));
  client.on('disconnected', r => notify('🔴 <b>WhatsApp Disconnected</b>\n' + escapeHTML(String(r))));

  // ---- Incoming messages ----
  client.on('message', async (msg) => {
    try {
      const contact = await msg.getContact();
      const name = escapeHTML(contact.pushname || contact.number || msg.from);
      const body = escapeHTML(msg.body || '[Media]');

      const caption = `<b>📩 New WhatsApp Message</b>\n👤 ${name}\n📱 ${contact.number || msg.from}\n💬 ${body}`;
      const key = 'in:' + msg.id.id;
      if (dedupe(key)) return;

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const sizeMB = (media.data.length * 0.75) / (1024 * 1024);
        if (sizeMB > MAX_MEDIA_SIZE_MB) {
          return notify(caption + `\n⚠️ Media too large (${sizeMB.toFixed(2)} MB)`);
        }
        const buffer = Buffer.from(media.data, 'base64');
        await sendDoc(buffer, caption, 'media');
      } else {
        await notify(caption);
      }
    } catch (e) {
      await notify('⚠️ Incoming error: ' + escapeHTML(e.message));
    }
  });

  // ---- Outgoing messages ----
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    try {
      const chat = await msg.getChat();
      const contact = await chat.getContact();
      const name = escapeHTML(contact.pushname || contact.number);
      const body = escapeHTML(msg.body || '[Media]');

      const caption = `<b>📤 Message Sent</b>\n👤 ${name}\n📱 ${contact.number}\n💬 ${body}`;
      const key = 'out:' + msg.id.id;
      if (dedupe(key)) return;

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const buffer = Buffer.from(media.data, 'base64');
        await sendDoc(buffer, caption, 'sent-media');
      } else {
        await notify(caption);
      }
    } catch (e) {
      await notify('⚠️ Outgoing error: ' + escapeHTML(e.message));
    }
  });

  // ---- Telegram reply -> WhatsApp ----
  bot.on('message', async (tgMsg) => {
    try {
      if (!tgMsg.reply_to_message) return;
      if (String(tgMsg.chat.id) !== String(CHAT_ID)) return;

      const original = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
      const match = original.match(/📱\s*([0-9+]+)/);
      if (!match) return;

      const number = match[1].replace(/\+/g, '');
      const chatId = number + '@c.us';

      await client.sendMessage(chatId, tgMsg.text);
      await notify('✅ Reply sent to WhatsApp user');
    } catch (e) {
      await notify('❌ Reply error: ' + escapeHTML(e.message));
    }
  });

  client.initialize();
}

start().catch(e => console.error('Startup failed:', e));

// ---- Health server for Render ----
const app = express();
app.get('/', (req, res) => res.send('WhatsApp ↔ Telegram bridge running'));
app.listen(PORT, () => console.log('Health server on port', PORT));

process.on('uncaughtException', err => notify('❌ Crash: ' + escapeHTML(err.stack)));
process.on('unhandledRejection', err => notify('⚠️ Promise error: ' + escapeHTML(String(err))));
