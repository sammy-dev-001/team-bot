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

import { isMemberRegistered, getAllMembers } from './db.js';

// ─── Globals ──────────────────────────────────────────────────────────────────

/** The active Baileys socket. Re-assigned on every reconnect. */
let sock = null;

/** Reconnection timer reference to avoid duplicate reconnection loops. */
let reconnectTimer = null;

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
        console.log('[WhatsApp] Reconnecting in 5 seconds…');
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToWhatsApp();
          }, 5000);
        }
      }
    }

    if (connection === 'open') {
      console.log(`[WhatsApp] ✅ Connected as ${sock.user?.name || sock.user?.id}`);
    }
  });

  // ── Auth credentials persistence ───────────────────────────────────────────

  sock.ev.on('creds.update', saveCreds);

  // ── Incoming messages ──────────────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip status broadcasts, empty, or our own messages
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');

      // ── Private 1-on-1 Direct Message (DM) Support & Auth Check ────────────
      if (!isGroup) {
        const senderJid = remoteJid;
        const senderNum = senderJid?.split('@')[0];
        const adminJids = (process.env.ADMIN_JIDS || '')
          .split(',')
          .map((j) => j.trim())
          .filter(Boolean);

        let isAuthorized = false;
        if (adminJids.length > 0) {
          // If ADMIN_JIDS is configured, only whitelisted users can DM
          isAuthorized = adminJids.some(
            (a) => a === senderJid || a === senderNum || `${a}@s.whatsapp.net` === senderJid
          );
        } else {
          // Fallback: If no ADMIN_JIDS set, allow existing directory members or allow first-time testing
          const all = getAllMembers();
          isAuthorized = all.length === 0 || isMemberRegistered(senderJid);
        }

        if (!isAuthorized) {
          console.log(`[WhatsApp] ⛔ Unauthorized DM attempt from ${msg.pushName || senderJid}`);
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
      const rawAllowed = process.env.ALLOWED_GROUP_JID || '';
      const allowedGroups = rawAllowed
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);

      if (allowedGroups.length === 0) {
        // Discovery mode: print group JIDs so the developer can configure .env
        console.log(`\n[GROUP DISCOVERY] 📋 Message from group JID: ${remoteJid}`);
        console.log('  → Add to ALLOWED_GROUP_JID in your .env and restart.\n');
        continue;
      }

      if (!allowedGroups.includes(remoteJid)) continue;

      // Dispatch to all registered message handlers for allowed groups
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
