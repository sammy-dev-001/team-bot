// src/index.js
// ─────────────────────────────────────────────────────────────────────────────
//  Entry point — bootstraps all modules in the correct order:
//    1. Environment validation
//    2. Database (auto-creates tables)
//    3. WhatsApp connection
//    4. Message handler registration
//    5. Scheduler startup
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { connectToWhatsApp, onMessage, getSocket } from './whatsapp.js';
import { handleMessage } from './handler.js';
import { startScheduler } from './scheduler.js';

// ─── Startup banner ───────────────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   🤖  AI WhatsApp Team Bot  — Online 🇳🇬              ║');
console.log('║   Engineering Team Teammate & Assistant              ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// ─── Environment validation ───────────────────────────────────────────────────

if (!process.env.GEMINI_API_KEY) {
  console.error('❌  GEMINI_API_KEY is not set in .env — exiting.');
  process.exit(1);
}

if (!process.env.ALLOWED_GROUP_JID) {
  console.warn('⚠️   ALLOWED_GROUP_JID is not set.');
  console.warn('    The bot will print incoming group JIDs to the console so you can copy the right one.');
  console.warn('');
}

// ─── Register message handler BEFORE connecting ───────────────────────────────
// onMessage() just pushes the callback into an array — safe to call early.
onMessage(handleMessage);

// ─── Connect to WhatsApp ──────────────────────────────────────────────────────

(async () => {
  try {
    await connectToWhatsApp();

    // ── Start scheduler after connection is established ────────────────────
    // Pass getSocket as a getter so the scheduler always references the latest
    // socket even after a reconnect.
    startScheduler(getSocket);

    console.log('\n✅  Bot is live! Listening for messages… 🚀\n');
  } catch (err) {
    console.error('❌  Fatal startup error:', err);
    process.exit(1);
  }
})();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[Main] SIGINT received — shutting down gracefully.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Main] SIGTERM received — shutting down gracefully.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err.message);
  // Keep running — Baileys auto-reconnects
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
  // Keep running
});
