// src/whatsapp.js
// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp connection layer using @whiskeysockets/baileys.
//  Handles: persistent auth, QR display, auto-reconnect, anti-ban delays,
//  native @mention injection, and group-JID discovery helper.
// ─────────────────────────────────────────────────────────────────────────────

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import 'dotenv/config';

import { isMemberRegistered, getAllMembers, isChatAuthorized } from './db.js';

// ─── Globals ──────────────────────────────────────────────────────────────────

/** The active Baileys socket. Re-assigned on every reconnect. */
let sock = null;

/** Reconnection timer reference to avoid duplicate reconnection loops. */
let reconnectTimer = null;

/** Exponential backoff reconnect attempts counter. */
let reconnectAttempts = 0;
const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;

/** Track IDs of messages sent by the bot socket itself to prevent self-reply loops. */
const botSentMessageIds = new Set();

/** Callbacks registered by handler.js / scheduler.js */
const messageHandlers = [];

// ─── Silent logger (pino) ────────────────────────────────────────────────────

const logger = pino({ level: 'silent' });

// ─── Helper: random delay (anti-ban) ─────────────────────────────────────────

function randomDelay(minMs = 1500, maxMs = 3000) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs)
  );
}

// ─── Helper: extract JIDs from @mention tags in text ─────────────────────────

/**
 * Scans a string for patterns like @2348012345678 and converts them to
 * full Baileys JIDs (e.g. "2348012345678@s.whatsapp.net").
 */
function extractMentionsFromText(text) {
  const regex = /@(\d{7,15})/g;
  const jids = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    jids.push(`${match[1]}@s.whatsapp.net`);
  }
  return jids;
}

// ─── Core: sendSafeMessage ────────────────────────────────────────────────────

/**
 * Anti-ban safe message sender with native WhatsApp @mention support.
 *
 * @param {object}   sockRef   - The Baileys socket (passed in so callers always
 *                               use the latest socket reference).
 * @param {string}   jid       - Target chat JID (group or individual).
 * @param {string}   text      - Message text (may contain @number tags).
 * @param {object}   [quotedMsg] - Baileys message object to quote (optional).
 * @param {string[]} [mentions]  - Extra JIDs to mention beyond those parsed
 *                                 from `text`. Accepts bare numbers or full JIDs.
 */
export async function sendSafeMessage(sockRef, jid, text, quotedMsg = null, mentions = []) {
  if (!sockRef) {
    console.error('[sendSafeMessage] Socket not available yet.');
    return;
  }

  try {
    // 1. Send composing presence so the bot "feels" human
    await sockRef.sendPresenceUpdate('composing', jid);

    // 2. Anti-ban delay
    await randomDelay(1500, 3000);

    // 3. Collect all mentions: extracted from text + explicitly passed in
    const inlineJids = extractMentionsFromText(text);
    const normalizedExtras = mentions.map((m) =>
      m.includes('@') ? m : `${m}@s.whatsapp.net`
    );
    const allMentions = [...new Set([...inlineJids, ...normalizedExtras])];

    // 4. Build message payload
    const payload = { text, mentions: allMentions };
    const sendOptions = quotedMsg ? { quoted: quotedMsg } : {};

    const sent = await sockRef.sendMessage(jid, payload, sendOptions);
    if (sent?.key?.id) {
      botSentMessageIds.add(sent.key.id);
      if (botSentMessageIds.size > 200) {
        const oldest = botSentMessageIds.values().next().value;
        botSentMessageIds.delete(oldest);
      }
    }

    // 5. Clear composing presence
    await sockRef.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.error('[sendSafeMessage] Failed to send message:', err.message);
  }
}

/**
 * Send a native WhatsApp poll.
 * @param {object}   sockRef         - The Baileys socket.
 * @param {string}   jid             - Target chat JID.
 * @param {string}   name            - Question / topic of the poll.
 * @param {string[]} values          - Array of poll options.
 * @param {number}   [selectableCount=1] - 1 for single-choice, >1 for multiple.
 */
export async function sendPollMessage(sockRef, jid, name, values, selectableCount = 1) {
  if (!sockRef) {
    console.error('[sendPollMessage] Socket not available yet.');
    return;
  }
  try {
    await randomDelay(1000, 2000);
    const validOptions = values.map((v) => v.trim()).filter(Boolean);
    if (validOptions.length < 2) {
      console.warn('[sendPollMessage] Polls require at least 2 options.');
      return;
    }
    const sent = await sockRef.sendMessage(jid, {
      poll: {
        name,
        values: validOptions,
        selectableCount: Math.max(1, Math.min(selectableCount, validOptions.length)),
      },
    });
    if (sent?.key?.id) {
      botSentMessageIds.add(sent.key.id);
      if (botSentMessageIds.size > 200) {
        const oldest = botSentMessageIds.values().next().value;
        botSentMessageIds.delete(oldest);
      }
    }
    console.log(`[WhatsApp] 📊 Sent native poll to ${jid}: "${name}" (${validOptions.length} options)`);
  } catch (err) {
    console.error('[sendPollMessage] Failed to send poll:', err.message);
  }
}

// ─── Core: connectToWhatsApp ─────────────────────────────────────────────────

/**
 * Initialises the Baileys socket, persists auth state, shows QR if needed,
 * and wires up auto-reconnect + message routing.
 *
 * @returns {Promise<object>} Resolves with the active Baileys socket.
 */
export async function connectToWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Remove existing listeners if previous socket exists to prevent memory leaks
  if (sock?.ev) {
    try {
      sock.ev.removeAllListeners();
    } catch (_) { }
  }

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false, // we handle it ourselves below
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  // ── QR Code ────────────────────────────────────────────────────────────────

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan the QR code below with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[WhatsApp] Connection closed. Reason: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log('[WhatsApp] Logged out. Delete auth_info/ and restart.');
      } else {
        const delay = Math.min(
          Math.floor(BASE_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts)),
          MAX_RECONNECT_DELAY_MS
        );
        reconnectAttempts++;
        console.log(`[WhatsApp] Reconnecting in ${Math.round(delay / 1000)}s (backoff attempt ${reconnectAttempts})…`);
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToWhatsApp();
          }, delay);
        }
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log(`[WhatsApp] ✅ Connected as ${sock.user?.name || sock.user?.id}`);
    }
  });

  // ── Auth credentials persistence ───────────────────────────────────────────

  sock.ev.on('creds.update', saveCreds);

  // ── Incoming messages ──────────────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // 1. Skip status broadcasts or empty messages
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

      // 2. Ignore messages sent by the bot socket itself (prevents infinite echo loops)
      if (msg.key.id && botSentMessageIds.has(msg.key.id)) {
        botSentMessageIds.delete(msg.key.id);
        continue;
      }

      // 3. Unwrap ephemeral, view-once, and caption wrappers
      const messageContent =
        msg.message.ephemeralMessage?.message ||
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2?.message ||
        msg.message.documentWithCaptionMessage?.message ||
        msg.message;

      const rawRemoteJid = msg.key.remoteJid;
      const remoteJid = jidNormalizedUser(rawRemoteJid);
      const isGroup = rawRemoteJid?.endsWith('@g.us') || remoteJid?.endsWith('@g.us');

      // ── Message text for command check ────────────────────────────────────
      const rawText = (
        messageContent.conversation ||
        messageContent.extendedTextMessage?.text ||
        messageContent.imageMessage?.caption ||
        messageContent.videoMessage?.caption ||
        messageContent.documentMessage?.caption ||
        ''
      ).trim().toLowerCase();
      const botName = (process.env.BOT_NAME || 'd').toLowerCase();

      const isActivationCommand =
        rawText === '/activate' ||
        rawText === '/start' ||
        rawText === '/init' ||
        rawText === 'activate' ||
        rawText === 'start' ||
        rawText === 'init' ||
        rawText.startsWith('/activate') ||
        rawText.startsWith('/start') ||
        rawText.startsWith('/init') ||
        rawText.startsWith('activate ') ||
        rawText.startsWith('start ') ||
        rawText.startsWith('@bot') ||
        rawText.startsWith('/bot') ||
        rawText.startsWith(`@${botName}`) ||
        rawText.startsWith(`/${botName}`) ||
        rawText.startsWith(`${botName} `) ||
        rawText.startsWith(`${botName},`) ||
        rawText.startsWith(`${botName}:`);

      // ── Private 1-on-1 Direct Message (DM) Support & Auth Check ────────────
      if (!isGroup) {
        const senderJid = remoteJid;
        const adminJids = (process.env.ADMIN_JIDS || '')
          .split(',')
          .map((j) => j.trim())
          .filter(Boolean);

        let isAuthorized = false;
        if (adminJids.length > 0) {
          const senderNum = senderJid?.split('@')[0];
          isAuthorized =
            adminJids.some(
              (a) => a === senderJid || a === senderNum || `${a}@s.whatsapp.net` === senderJid
            ) ||
            isChatAuthorized(rawRemoteJid) ||
            isChatAuthorized(senderJid) ||
            isActivationCommand;
        } else {
          // If no ADMIN_JIDS whitelist configured: all 1-on-1 DMs are welcomed!
          isAuthorized = true;
        }

        if (!isAuthorized) {
          console.log(`[WhatsApp] ⛔ Unauthorized DM ignored from ${msg.pushName || senderJid}`);
          continue;
        }

        console.log(`[WhatsApp] 💬 1-on-1 Private message from ${msg.pushName || remoteJid}`);
        for (const handler of messageHandlers) {
          try {
            await handler(sock, msg);
          } catch (err) {
            console.error('[WhatsApp] Handler error in DM:', err.message);
          }
        }
        continue;
      }

      // ── Multi-Group Chat Handling ──────────────────────────────────────────
      const isAuthorizedGroup =
        isChatAuthorized(rawRemoteJid) ||
        isChatAuthorized(remoteJid);

      if (!isAuthorizedGroup) {
        if (isActivationCommand) {
          console.log(`\n[WhatsApp] 🚀 Activation command detected from new group: ${rawRemoteJid}`);
        } else {
          // Discovery mode: log unactivated group JID for developer visibility
          console.log(`[GROUP DISCOVERY] 📋 Message from unactivated group: ${rawRemoteJid}`);
          console.log(`  ↳ To activate, send "/activate" or "@${botName} activate" directly in that group!\n`);
          continue;
        }
      }

      // Dispatch to all registered message handlers for authorized/activating groups
      for (const handler of messageHandlers) {
        try {
          await handler(sock, msg);
        } catch (err) {
          console.error('[WhatsApp] Handler error in group:', err.message);
        }
      }
    }
  });

  return sock;
}

// ─── Public: register a message handler ──────────────────────────────────────

/**
 * Register a callback that will be invoked for every allowed group message.
 * @param {Function} fn  async (sock, msg) => void
 */
export function onMessage(fn) {
  messageHandlers.push(fn);
}

/** Returns the current active socket (may be null before first connection). */
export function getSocket() {
  return sock;
}
