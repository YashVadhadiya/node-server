/*
  Render.com Stable WhatsApp <-> Telegram Bridge (Polling-safe)
  Fixes:
  - Handles Telegram 404 (wrong token / webhook conflict)
  - Forces long polling reset
  - Auto-retry on polling errors
  - Sends QR to Telegram for remote login

  npm i whatsapp-web.js qrcode node-telegram-bot-api express

  Env:
    TELEGRAM_TOKEN
    CHAT_ID
    PORT
*/

const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');

const TELEGRAM_TOKEN = "7697793505:AAHIr4VAnYktrD28_xxx7GItVfZ-NuMY2zI";
const CHAT_ID = "7795828902";
const PORT = 3000;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN or CHAT_ID missing');
  process.exit(1);
}

function escapeHTML(text = '') {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let bot;

function startTelegramBot() {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: { timeout: 10 }
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
    // Restart polling on 404 / token errors
    setTimeout(() => {
      try {
        bot.stopPolling();
      } catch (e) {}
      startTelegramBot();
    }, 5000);
  });

  return bot;
}

startTelegramBot();

async function notify(text) {
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

// WhatsApp client for Render (headless)
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  try {
    const qrBuffer = await qrcode.toBuffer(qr);
    await bot.sendPhoto(CHAT_ID, qrBuffer, { caption: '🔑 Scan this QR in WhatsApp → Linked Devices' });
  } catch (e) {
    await notify('❌ QR send failed: ' + escapeHTML(e.message));
  }
});

client.on('authenticated', () => notify('✅ WhatsApp Authenticated'));
client.on('ready', () => notify('🟢 WhatsApp Connected'));
client.on('disconnected', (r) => notify('🔴 WhatsApp Disconnected: ' + escapeHTML(r)));

client.on('message', async (msg) => {
  try {
    const contact = await msg.getContact();
    const name = escapeHTML(contact.pushname || contact.number);
    const body = escapeHTML(msg.body || '[Media]');

    const text = `<b>📩 WhatsApp Message</b>\n👤 ${name}\n📱 ${contact.number}\n💬 ${body}`;

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

// Telegram → WhatsApp reply
bot.on('message', async (tgMsg) => {
  try {
    if (!tgMsg.reply_to_message) return;
    if (String(tgMsg.chat.id) !== String(CHAT_ID)) return;

    const original = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption;
    const match = original.match(/📱\s*(\d+)/);
    if (!match) return;

    const number = match[1];
    const chatId = number + '@c.us';

    await client.sendMessage(chatId, tgMsg.text);
    await notify('✅ Reply sent');
  } catch (e) {
    await notify('❌ Reply error: ' + escapeHTML(e.message));
  }
});

// Health server for Render
const app = express();
app.get('/', (req, res) => res.send('WA ↔ TG bridge running'));
app.listen(PORT, () => console.log('Health server on port', PORT));

process.on('uncaughtException', err => notify('❌ Crash: ' + escapeHTML(err.stack)));
process.on('unhandledRejection', err => notify('⚠️ Promise error: ' + escapeHTML(String(err))));

client.initialize();
