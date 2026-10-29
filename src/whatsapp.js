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

    await sockRef.sendMessage(jid, payload, sendOptions);

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
    await sockRef.sendMessage(jid, {
      poll: {
        name,
        values: validOptions,
        selectableCount: Math.max(1, Math.min(selectableCount, validOptions.length)),
      },
    });
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
    } catch (_) {}
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
      // Skip status broadcasts or empty messages
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

      // If message is from the bot's own linked phone, only process if explicitly triggered
      // (allows the developer to test from their own phone without the bot looping on its own replies)
      if (msg.key.fromMe) {
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim().toLowerCase();
        const botName = (process.env.BOT_NAME || 'teambot').toLowerCase();

        const isExplicitSelfCommand =
          text.startsWith('@bot') ||
          text.startsWith('/bot') ||
          text.startsWith(`@${botName}`) ||
          text.startsWith(`/${botName}`) ||
          text.startsWith('/tasks') ||
          text.startsWith('/deadlines') ||
          text.startsWith('/notes') ||
          text.startsWith('/standup') ||
          text.startsWith('/status') ||
          text.startsWith('/ping') ||
          text.startsWith('/help') ||
          text.startsWith('/mytasks') ||
          text.startsWith('/done') ||
          text.startsWith('/progress') ||
          text.startsWith('/block') ||
          text.startsWith('/assign') ||
          text.startsWith('/overdue') ||
          text.startsWith('/blocked') ||
          text.startsWith('/remind') ||
          text.startsWith('/snippet') ||
          text.startsWith('/poll') ||
          text.startsWith('/countdown') ||
          text.startsWith('/audit') ||
          text.startsWith('/activate') ||
          text.startsWith('/start') ||
          text.startsWith('/init');

        if (!isExplicitSelfCommand) continue;
      }

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');

      // ── Message text for command check ────────────────────────────────────
      const rawText = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''
      ).trim().toLowerCase();
      const botName = (process.env.BOT_NAME || 'teambot').toLowerCase();

      const isActivationCommand =
        rawText === '/activate' ||
        rawText === '/start' ||
        rawText === '/init' ||
        rawText.startsWith('/activate') ||
        rawText.startsWith('/start') ||
        rawText.startsWith('/init') ||
        rawText.startsWith('@bot activate') ||
        rawText.startsWith('/bot activate') ||
        rawText.startsWith(`@${botName} activate`) ||
        rawText.startsWith(`/${botName} activate`);

      // ── Private 1-on-1 Direct Message (DM) Support & Auth Check ────────────
      if (!isGroup) {
        const senderJid = remoteJid;
        const isAuthorized = isChatAuthorized(senderJid) || isActivationCommand;

        if (!isAuthorized) {
          // Check if zero members in directory (first-time boot allows DM setup)
          const all = getAllMembers();
          if (all.length > 0 && !isMemberRegistered(senderJid)) {
            console.log(`[WhatsApp] ⛔ Unauthorized DM attempt from ${msg.pushName || senderJid}`);
            continue;
          }
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
      const isAuthorizedGroup = isChatAuthorized(remoteJid);

      if (!isAuthorizedGroup) {
        if (isActivationCommand) {
          console.log(`\n[WhatsApp] 🚀 Activation command detected from new group: ${remoteJid}`);
        } else {
          // Discovery mode: log unactivated group JID for developer visibility
          console.log(`[GROUP DISCOVERY] 📋 Message from unactivated group: ${remoteJid}`);
          console.log(`  ↳ To activate, send "/activate" or "@bot activate" directly in that group!\n`);
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
