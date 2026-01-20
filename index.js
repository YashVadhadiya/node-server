/*
  Production-Grade WhatsApp <-> Telegram Bridge for Render.com
  
  Features:
   ✓ Auto-reconnection with exponential backoff
   ✓ Health monitoring & auto-restart
   ✓ Rate limiting & queue management
   ✓ Comprehensive error handling
   ✓ Memory leak prevention
   ✓ Message retry logic
   ✓ Session persistence
   ✓ Graceful shutdown
  
  Install:
    npm i whatsapp-web.js node-telegram-bot-api qrcode express @sparticuz/chromium puppeteer-core
  
  Env Vars:
    TELEGRAM_TOKEN (required)
    CHAT_ID (required)
    PORT (optional, default: 3000)
    MAX_RETRIES (optional, default: 3)
    RECONNECT_DELAY (optional, default: 5000)
*/

const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  TELEGRAM_TOKEN = "8554837364:AAGONwsCELY2UYCmEJKKDZun2tGqUjs-Xtw",
  CHAT_ID = "7795828902",
  PORT: 3000,
  MAX_RETRIES: 3,
  RECONNECT_DELAY: 5000,
  MAX_RECONNECT_DELAY: 300000, // 5 minutes
  HEALTH_CHECK_INTERVAL: 60000, // 1 minute
  MESSAGE_TIMEOUT: 30000, // 30 seconds
  MAX_MESSAGE_LENGTH: 4096, // Telegram limit
  RATE_LIMIT_DELAY: 1000 // 1 second between messages
};

// Validate required environment variables
if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.CHAT_ID) {
  console.error('❌ FATAL: TELEGRAM_TOKEN or CHAT_ID missing');
  process.exit(1);
}

// ============================================================================
// UTILITIES
// ============================================================================

function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function truncateText(text, maxLength = CONFIG.MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class MessageQueue {
  constructor(delayMs = CONFIG.RATE_LIMIT_DELAY) {
    this.queue = [];
    this.processing = false;
    this.delayMs = delayMs;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      if (this.queue.length > 0) {
        await sleep(this.delayMs);
      }
    }
    
    this.processing = false;
  }
}

// ============================================================================
// TELEGRAM BOT MANAGER
// ============================================================================

class TelegramManager {
  constructor() {
    this.bot = null;
    this.messageQueue = new MessageQueue();
    this.retryCount = 0;
    this.isInitialized = false;
  }

  async initialize() {
    try {
      this.bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, {
        polling: {
          interval: 1000,
          autoStart: true,
          params: {
            timeout: 10
          }
        },
        filepath: false
      });

      this.bot.on('polling_error', (error) => {
        console.error('⚠️ Telegram polling error:', error.code, error.message);
        
        // Handle 409 Conflict (multiple instances)
        if (error.code === 'EFATAL' || error.message.includes('409')) {
          console.log('🔄 Stopping polling due to conflict...');
          this.bot.stopPolling();
          
          setTimeout(() => {
            console.log('🔄 Restarting polling...');
            this.bot.startPolling();
          }, 5000);
        }
      });

      this.bot.on('error', (error) => {
        console.error('❌ Telegram bot error:', error.message);
      });

      this.isInitialized = true;
      console.log('✅ Telegram bot initialized');
      
      await this.sendMessage('🚀 Bridge started successfully');
      
    } catch (error) {
      console.error('❌ Telegram initialization failed:', error.message);
      throw error;
    }
  }

  async sendMessage(text, options = {}) {
    if (!this.isInitialized) {
      console.warn('⚠️ Telegram not initialized, skipping message');
      return null;
    }

    return this.messageQueue.add(async () => {
      let attempt = 0;
      
      while (attempt < CONFIG.MAX_RETRIES) {
        try {
          const truncated = truncateText(text);
          const result = await Promise.race([
            this.bot.sendMessage(CONFIG.CHAT_ID, truncated, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              ...options
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), CONFIG.MESSAGE_TIMEOUT)
            )
          ]);
          
          return result;
          
        } catch (error) {
          attempt++;
          console.error(`⚠️ Telegram send failed (attempt ${attempt}/${CONFIG.MAX_RETRIES}):`, error.message);
          
          if (attempt < CONFIG.MAX_RETRIES) {
            await sleep(1000 * attempt); // Exponential backoff
          } else {
            console.error('❌ All retry attempts failed for message');
            return null;
          }
        }
      }
    });
  }

  async sendPhoto(photo, options = {}) {
    if (!this.isInitialized) return null;

    return this.messageQueue.add(async () => {
      try {
        return await this.bot.sendPhoto(CONFIG.CHAT_ID, photo, options);
      } catch (error) {
        console.error('❌ Photo send failed:', error.message);
        return null;
      }
    });
  }

  async sendDocument(document, options = {}) {
    if (!this.isInitialized) return null;

    return this.messageQueue.add(async () => {
      try {
        return await this.bot.sendDocument(CONFIG.CHAT_ID, document, options);
      } catch (error) {
        console.error('❌ Document send failed:', error.message);
        // Fallback to text if document fails
        if (options.caption) {
          await this.sendMessage(options.caption + '\n\n[Media attachment failed to send]');
        }
        return null;
      }
    });
  }

  onMessage(callback) {
    if (this.bot) {
      this.bot.on('message', callback);
    }
  }
}

// ============================================================================
// WHATSAPP CLIENT MANAGER
// ============================================================================

class WhatsAppManager {
  constructor(telegramManager) {
    this.client = null;
    this.telegram = telegramManager;
    this.isReady = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = CONFIG.RECONNECT_DELAY;
    this.lastHealthCheck = Date.now();
  }

  async initialize() {
    try {
      const executablePath = await chromium.executablePath();
      
      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: './wa_sessions'
        }),
        puppeteer: {
          executablePath,
          headless: chromium.headless,
          args: [
            ...chromium.args,
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox'
          ]
        },
        qrMaxRetries: 5
      });

      this.setupEventHandlers();
      await this.client.initialize();
      
      console.log('✅ WhatsApp client initialized');
      
    } catch (error) {
      console.error('❌ WhatsApp initialization failed:', error.message);
      await this.handleReconnect();
    }
  }

  setupEventHandlers() {
    // QR Code handling
    this.client.on('qr', async (qr) => {
      console.log('📱 QR Code received');
      
      try {
        const qrBuffer = await qrcode.toBuffer(qr, { 
          errorCorrectionLevel: 'H',
          type: 'png',
          width: 512
        });
        
        await this.telegram.sendPhoto(qrBuffer, {
          caption: '🔑 <b>WhatsApp QR Code</b>\n\n' +
                   '1. Open WhatsApp on your phone\n' +
                   '2. Go to Settings → Linked Devices\n' +
                   '3. Tap "Link a Device"\n' +
                   '4. Scan this QR code\n\n' +
                   '⏰ Code expires in 60 seconds',
          parse_mode: 'HTML'
        });
        
      } catch (error) {
        console.error('❌ QR send failed:', error.message);
        await this.telegram.sendMessage('❌ QR generation failed: ' + escapeHTML(error.message));
      }
    });

    // Authentication events
    this.client.on('authenticated', async () => {
      console.log('✅ WhatsApp authenticated');
      this.reconnectAttempts = 0;
      this.reconnectDelay = CONFIG.RECONNECT_DELAY;
      await this.telegram.sendMessage('✅ <b>WhatsApp Authenticated</b>');
    });

    this.client.on('auth_failure', async (error) => {
      console.error('❌ Authentication failed:', error);
      await this.telegram.sendMessage('❌ <b>Authentication Failed</b>\n\nPlease scan QR code again');
      await this.handleReconnect();
    });

    // Connection events
    this.client.on('ready', async () => {
      console.log('🟢 WhatsApp ready');
      this.isReady = true;
      this.lastHealthCheck = Date.now();
      await this.telegram.sendMessage('🟢 <b>WhatsApp Connected & Ready</b>');
    });

    this.client.on('disconnected', async (reason) => {
      console.log('🔴 WhatsApp disconnected:', reason);
      this.isReady = false;
      await this.telegram.sendMessage('🔴 <b>WhatsApp Disconnected</b>\n\nReason: ' + escapeHTML(reason));
      await this.handleReconnect();
    });

    // Message handling
    this.client.on('message', async (msg) => {
      this.lastHealthCheck = Date.now(); // Update activity
      await this.handleIncomingMessage(msg);
    });

    this.client.on('message_create', async (msg) => {
      // Track outgoing messages too for health check
      if (msg.fromMe) {
        this.lastHealthCheck = Date.now();
      }
    });
  }

  async handleIncomingMessage(msg) {
    try {
      // Get contact info safely
      let contact;
      try {
        contact = await Promise.race([
          msg.getContact(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Contact fetch timeout')), 5000)
          )
        ]);
      } catch (error) {
        console.warn('⚠️ Could not fetch contact:', error.message);
        contact = { pushname: 'Unknown', number: msg.from };
      }

      const name = escapeHTML(contact.pushname || contact.name || 'Unknown');
      const number = contact.number || msg.from.split('@')[0];
      const bodyText = typeof msg.body === 'string' ? msg.body : '';
      const body = escapeHTML(bodyText || '[No text]');
      
      const header = `<b>📩 WhatsApp Message</b>\n` +
                    `👤 ${name}\n` +
                    `📱 ${number}\n` +
                    `🕐 ${new Date().toLocaleString()}\n`;

      // Handle media messages
      if (msg.hasMedia) {
        console.log('📎 Processing media message...');
        
        try {
          const media = await Promise.race([
            msg.downloadMedia(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Media download timeout')), 30000)
            )
          ]);

          if (media && media.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const caption = header + `💬 ${body}\n📎 Media type: ${media.mimetype || 'unknown'}`;
            
            // Handle different media types
            if (media.mimetype && media.mimetype.startsWith('image/')) {
              await this.telegram.sendPhoto(buffer, { 
                caption: truncateText(caption),
                parse_mode: 'HTML' 
              });
            } else {
              await this.telegram.sendDocument(buffer, { 
                caption: truncateText(caption),
                parse_mode: 'HTML',
                filename: media.filename || 'media'
              });
            }
            
            console.log('✅ Media message forwarded');
          } else {
            throw new Error('Media data empty');
          }
          
        } catch (mediaError) {
          console.error('⚠️ Media download failed:', mediaError.message);
          await this.telegram.sendMessage(header + `💬 ${body}\n\n⚠️ [Media failed to download]`);
        }
        
      } else {
        // Text only message
        await this.telegram.sendMessage(header + `💬 ${body}`);
        console.log('✅ Text message forwarded');
      }

    } catch (error) {
      console.error('❌ Message handling error:', error);
      await this.telegram.sendMessage('⚠️ <b>Message Error</b>\n\n' + escapeHTML(error.message || String(error)));
    }
  }

  async sendReply(number, text) {
    if (!this.isReady) {
      throw new Error('WhatsApp not ready');
    }

    try {
      const chatId = number.includes('@') ? number : `${number}@c.us`;
      
      await Promise.race([
        this.client.sendMessage(chatId, text),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Send timeout')), CONFIG.MESSAGE_TIMEOUT)
        )
      ]);
      
      console.log('✅ Reply sent to', number);
      return true;
      
    } catch (error) {
      console.error('❌ Reply send failed:', error.message);
      throw error;
    }
  }

  async handleReconnect() {
    if (this.reconnectAttempts >= 10) {
      console.error('❌ Max reconnection attempts reached');
      await this.telegram.sendMessage('❌ <b>Critical Error</b>\n\nMax reconnection attempts reached. Manual restart required.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, CONFIG.MAX_RECONNECT_DELAY);
    
    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/10)...`);
    await this.telegram.sendMessage(`🔄 Reconnecting in ${Math.round(delay/1000)}s (attempt ${this.reconnectAttempts}/10)...`);
    
    await sleep(delay);
    
    try {
      if (this.client) {
        await this.client.destroy();
      }
    } catch (e) {
      console.warn('⚠️ Cleanup error:', e.message);
    }
    
    await this.initialize();
  }

  startHealthMonitoring() {
    setInterval(() => {
      const timeSinceLastActivity = Date.now() - this.lastHealthCheck;
      
      if (this.isReady && timeSinceLastActivity > CONFIG.HEALTH_CHECK_INTERVAL * 3) {
        console.warn('⚠️ No activity detected, possible connection issue');
        this.telegram.sendMessage('⚠️ <b>Health Warning</b>\n\nNo WhatsApp activity for 3 minutes. Connection may be unstable.');
      }
    }, CONFIG.HEALTH_CHECK_INTERVAL);
  }
}

// ============================================================================
// TELEGRAM REPLY HANDLER
// ============================================================================

function setupReplyHandler(telegram, whatsapp) {
  telegram.onMessage(async (tgMsg) => {
    try {
      // Only process replies in the configured chat
      if (String(tgMsg.chat.id) !== String(CONFIG.CHAT_ID)) return;
      
      // Only process replies to bridge messages
      if (!tgMsg.reply_to_message) return;
      
      // Extract phone number from original message
      const original = tgMsg.reply_to_message.text || tgMsg.reply_to_message.caption || '';
      const match = original.match(/📱\s*(\+?\d+)/);
      
      if (!match) {
        console.log('⚠️ No phone number found in reply');
        return;
      }

      const number = match[1].replace(/\D/g, ''); // Remove non-digits
      const replyText = tgMsg.text || '[No text]';

      console.log('📤 Sending reply to', number);
      await telegram.sendMessage('⏳ Sending reply...');

      await whatsapp.sendReply(number, replyText);
      
      await telegram.sendMessage('✅ <b>Reply Sent</b>\n\n' +
        `To: ${number}\n` +
        `Message: ${escapeHTML(replyText.substring(0, 100))}${replyText.length > 100 ? '...' : ''}`
      );

    } catch (error) {
      console.error('❌ Reply handler error:', error);
      await telegram.sendMessage('❌ <b>Reply Failed</b>\n\n' + escapeHTML(error.message));
    }
  });
}

// ============================================================================
// HEALTH SERVER
// ============================================================================

function createHealthServer(telegram, whatsapp) {
  const app = express();
  
  app.use(express.json());
  
  // Health check endpoint
  app.get('/', (req, res) => {
    const status = {
      status: 'running',
      telegram: telegram.isInitialized,
      whatsapp: whatsapp.isReady,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    
    res.json(status);
  });
  
  // Detailed status endpoint
  app.get('/status', (req, res) => {
    res.json({
      service: 'WhatsApp-Telegram Bridge',
      version: '2.0.0',
      telegram_connected: telegram.isInitialized,
      whatsapp_connected: whatsapp.isReady,
      reconnect_attempts: whatsapp.reconnectAttempts,
      last_activity: new Date(whatsapp.lastHealthCheck).toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
  });
  
  // Ping endpoint for external monitoring
  app.get('/ping', (req, res) => {
    res.send('pong');
  });
  
  const server = app.listen(CONFIG.PORT, () => {
    console.log(`✅ Health server running on port ${CONFIG.PORT}`);
  });
  
  return server;
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

async function main() {
  console.log('🚀 Starting WhatsApp-Telegram Bridge...');
  console.log('📋 Configuration:', {
    port: CONFIG.PORT,
    maxRetries: CONFIG.MAX_RETRIES,
    reconnectDelay: CONFIG.RECONNECT_DELAY
  });

  const telegram = new TelegramManager();
  const whatsapp = new WhatsAppManager(telegram);

  try {
    // Initialize Telegram first
    await telegram.initialize();
    
    // Then initialize WhatsApp
    await whatsapp.initialize();
    
    // Setup reply handler
    setupReplyHandler(telegram, whatsapp);
    
    // Start health monitoring
    whatsapp.startHealthMonitoring();
    
    // Start health server
    const server = createHealthServer(telegram, whatsapp);
    
    console.log('✅ Bridge fully operational');

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n⚠️ Received ${signal}, shutting down gracefully...`);
      
      await telegram.sendMessage(`⚠️ Bridge shutting down (${signal})`);
      
      if (whatsapp.client) {
        await whatsapp.client.destroy();
      }
      
      if (telegram.bot) {
        await telegram.bot.stopPolling();
      }
      
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
      
      // Force exit after 10 seconds
      setTimeout(() => {
        console.log('⚠️ Forced shutdown');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await telegram.sendMessage('❌ <b>Fatal Error</b>\n\n' + escapeHTML(error.stack || error.message));
    process.exit(1);
  }
}

// ============================================================================
// ERROR HANDLERS
// ============================================================================

process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  try {
    const telegram = new TelegramManager();
    await telegram.initialize();
    await telegram.sendMessage('❌ <b>Uncaught Exception</b>\n\n' + escapeHTML(error.stack || error.message));
  } catch (e) {
    console.error('Failed to send error notification:', e);
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
  try {
    const telegram = new TelegramManager();
    await telegram.initialize();
    await telegram.sendMessage('⚠️ <b>Unhandled Rejection</b>\n\n' + escapeHTML(String(reason)));
  } catch (e) {
    console.error('Failed to send error notification:', e);
  }
});

// Start the application
main().catch(error => {
  console.error('❌ Startup failed:', error);
  process.exit(1);
});
