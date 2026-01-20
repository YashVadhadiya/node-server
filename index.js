/*
  Render.com Ready WhatsApp <-> Telegram bridge
  - Sends WhatsApp login QR directly to Telegram (PNG)
  - No local browser interaction needed
  - Designed for free Render web service (headless Chromium)

  npm i whatsapp-web.js qrcode node-telegram-bot-api express

  Env:
    TELEGRAM_TOKEN
    CHAT_ID
    PORT (Render provides automatically)
*/

const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');

const TELEGRAM_TOKEN = "7697793505:AAHIr4VAnYktrD28_xxx7GItVfZ-NuMY2zI";
const CHAT_ID = "7795828902";
const PORT = 3000;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_TOKEN or CHAT_ID');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function escapeHTML(text = '') {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notify(text) {
  console.log(text);
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Telegram send error', e.message);
  }
}

// WhatsApp client (headless for Render)
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  try {
    const qrImage = await qrcode.toBuffer(qr);
    await bot.sendPhoto(CHAT_ID, qrImage, { caption: '🔑 Scan this QR in WhatsApp to login (valid for ~20s)' });
  } catch (e) {
    await notify('❌ Failed to generate/send QR: ' + escapeHTML(e.message));
  }
});

client.on('authenticated', () => notify('✅ WhatsApp Authenticated'));
client.on('ready', () => notify('🟢 WhatsApp Connected & Ready'));
client.on('disconnected', (r) => notify('🔴 WhatsApp Disconnected: ' + escapeHTML(r)));

client.on('message', async (msg) => {
  try {
    const contact = await msg.getContact();
    const name = escapeHTML(contact.pushname || contact.number);
    const body = escapeHTML(msg.body || '[Media]');

    const text = `<b>📩 New Message</b>\n👤 ${name}\n📱 ${contact.number}\n💬 ${body}`;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');
      await bot.sendDocument(CHAT_ID, buffer, { caption: text, parse_mode: 'HTML' });
    } else {
      await notify(text);
    }
  } catch (e) {
    await notify('⚠️ Message error: ' + escapeHTML(e.message));
  }
});

// Telegram -> WhatsApp reply
bot.on('message', async (tgMsg) => {
  try {
    if (!tgMsg.reply_to_message) return;

    const original = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption;
    const match = original.match(/📱\s*(\d+)/);
    if (!match) return;

    const number = match[1];
    const chatId = number + '@c.us';

    await client.sendMessage(chatId, tgMsg.text);
    await notify('✅ Replied to WhatsApp user');
  } catch (e) {
    await notify('❌ Telegram reply error: ' + escapeHTML(e.message));
  }
});

// Health server (Render needs a web port)
const app = express();
app.get('/', (req, res) => res.send('WhatsApp-Telegram bridge running'));
app.listen(PORT, () => console.log('Health server on', PORT));

process.on('uncaughtException', err => notify('❌ Crash: ' + escapeHTML(err.stack)));
process.on('unhandledRejection', err => notify('⚠️ Promise error: ' + escapeHTML(String(err))));

client.initialize();
