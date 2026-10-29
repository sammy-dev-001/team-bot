// src/handler.js
// ─────────────────────────────────────────────────────────────────────────────
//  Message Handler — wires together WhatsApp events, DB, and the AI brain.
//  Responsibilities:
//    • Auto-member registration (JID discovery)
//    • Passive message logging
//    • Deterministic Fast Slash Commands (/tasks, /deadlines, /notes, /help, etc.)
//    • Direct trigger detection (@mention, reply, /bot prefix, dynamic bot name)
//    • Organic chime-in with intelligent cooldown
//    • Multimodal media analysis (images, audio voice notes, documents)
// ─────────────────────────────────────────────────────────────────────────────

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import 'dotenv/config';
import {
  ensureMemberExists,
  upsertMember,
  authorizeChat,
  logMessage,
  getOpenTasks,
  listDeadlines,
  searchProjectNotes,
  getAllMembers,
  getMessagesSince,
  getUpcomingDeadlines,
  getTasksByMember,
  getOverdueTasks,
  getBlockedTasks,
  updateTaskStatus,
  reassignTask,
  setTaskBlockReason,
  findMemberByName,
  getMember,
  createReminder,
  saveCodeSnippet,
  searchCodeSnippets,
  getRecentAuditLogs,
  saveConversationTurn,
} from './db.js';
import { askAI, generateStandupBrief } from './ai.js';
import { sendSafeMessage, sendPollMessage } from './whatsapp.js';

// ─── Organic chime-in cooldown state ─────────────────────────────────────────

const cooldown = {
  messagesSinceLastChimeIn: 0,
  lastChimeInAt: 0,
  CHIME_IN_COOLDOWN_MS: 2 * 60 * 1000, // 2 minutes
  CHIME_IN_EVERY_N_MESSAGES: 3,         // or every 3 messages
};

/**
 * Returns true if the organic cooldown allows another unsolicited reply.
 */
function canChimeIn() {
  const now = Date.now();
  const timeSinceLast = now - cooldown.lastChimeInAt;
  return (
    cooldown.messagesSinceLastChimeIn >= cooldown.CHIME_IN_EVERY_N_MESSAGES ||
    timeSinceLast >= cooldown.CHIME_IN_COOLDOWN_MS
  );
}

function resetChimeIn() {
  cooldown.messagesSinceLastChimeIn = 0;
  cooldown.lastChimeInAt = Date.now();
}

// ─── Organic engagement classifier ────────────────────────────────────────────

/**
 * Lightweight heuristic: should the bot organically chime in on this message?
 * Looks for questions, technical discussion, bugs, planning, or natural cues.
 */
function shouldChimeIn(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  const technicalSignals = [
    /\b(bug|error|exception|crash|fix|broken|issue|problem|help|stuck|failing|blocker|blocked)\b/,
    /\b(api|database|schema|endpoint|deploy|server|docker|cloud|ci\/cd|backend|frontend)\b/,
    /\b(react|node|python|typescript|sql|mongodb|firebase|redis|aws|gcp|flutter|tailwind)\b/,
    /\b(how do|how can|why does|what's the best|which approach|should we|anyone know|who can)\b/,
    /\b(architecture|design|pattern|refactor|performance|optimize|structure)\b/,
    /\b(hackathon|deadline|submission|milestone|launch|release|project)\b/,
    /\b(meeting|standup|planning|sprint|scrum|kanban)\b/,
    /\?/, // Any question mark
    /\b(d)\b/i, // Mentioning D naturally
  ];

  const casualSignals = [
    /\b(stressed|tired|overwhelmed|panic|scared|nervous|excited|cooking)\b/,
    /\b(done|finished|completed|shipped|deployed|live)\b/,
    /🚀|🔥|💡|😭|😅|🤯|🎉/,
  ];

  const hasSignal = [...technicalSignals, ...casualSignals].some((r) => r.test(lower));
  return hasSignal;
}

/**
 * Helper to unwrap ephemeral, viewOnce, or documentWithCaption wrappers.
 */
function getUnwrappedMessage(msg) {
  let m = msg?.message;
  if (!m) return null;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
  return m;
}

// ─── Message text extractor ───────────────────────────────────────────────────

/**
 * Pulls the plain text out of any Baileys message, handling all common
 * message types (text, extended text, image caption, audio, document, etc.).
 */
function extractMessageText(msg) {
  const m = getUnwrappedMessage(msg);
  if (!m) return '';

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

// ─── Media Attachment Extractor (Images, Voice Notes, Documents) ──────────────

/**
 * Returns media metadata if the message contains an image, audio voice note, or document.
 */
function getMediaAttachment(msg) {
  const m = getUnwrappedMessage(msg);
  if (!m) return null;

  // Direct media
  if (m.imageMessage) {
    return { type: 'image', mediaMsg: m.imageMessage, mimeType: m.imageMessage.mimetype || 'image/jpeg', isQuoted: false, msg };
  }
  if (m.stickerMessage) {
    return { type: 'sticker', mediaMsg: m.stickerMessage, mimeType: m.stickerMessage.mimetype || 'image/webp', isQuoted: false, msg };
  }
  if (m.audioMessage) {
    return { type: 'audio', mediaMsg: m.audioMessage, mimeType: m.audioMessage.mimetype || 'audio/ogg; codecs=opus', isQuoted: false, msg };
  }
  if (m.documentMessage) {
    return { type: 'document', mediaMsg: m.documentMessage, mimeType: m.documentMessage.mimetype || 'application/pdf', isQuoted: false, msg };
  }

  // Quoted media
  const ctx = m.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (quoted?.imageMessage) {
    return { type: 'image', mediaMsg: quoted.imageMessage, mimeType: quoted.imageMessage.mimetype || 'image/jpeg', isQuoted: true, msg };
  }
  if (quoted?.stickerMessage) {
    return { type: 'sticker', mediaMsg: quoted.stickerMessage, mimeType: quoted.stickerMessage.mimetype || 'image/webp', isQuoted: true, msg };
  }
  if (quoted?.audioMessage) {
    return { type: 'audio', mediaMsg: quoted.audioMessage, mimeType: quoted.audioMessage.mimetype || 'audio/ogg; codecs=opus', isQuoted: true, msg };
  }
  if (quoted?.documentMessage) {
    return { type: 'document', mediaMsg: quoted.documentMessage, mimeType: quoted.documentMessage.mimetype || 'application/pdf', isQuoted: true, msg };
  }

  return null;
}

// ─── Direct trigger detector ──────────────────────────────────────────────────

/**
 * Returns true if the message is directly targeting the bot:
 *  - Starts with @bot or /bot or @BOT_NAME or /BOT_NAME (case-insensitive)
 *  - Is a direct reply to one of the bot's messages
 *  - @mentions the bot's own JID
 */
function isDirectTrigger(msg, botJid) {
  const text = extractMessageText(msg).trim().toLowerCase();
  const botName = (process.env.BOT_NAME || 'D').toLowerCase();

  if (
    text.startsWith('@bot') ||
    text.startsWith('/bot') ||
    text.startsWith(`@${botName}`) ||
    text.startsWith(`/${botName}`) ||
    text.startsWith(`${botName} `) ||
    text.startsWith(`${botName},`) ||
    text.startsWith(`${botName}:`) ||
    /^(?:hey|yo|sup|hello|ask)\s+d\b/i.test(text)
  ) {
    return true;
  }

  // Replied-to message from the bot
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant && botJid && ctx.participant === botJid) return true;

  // @mentioned by JID
  const mentions = ctx?.mentionedJid || [];
  if (botJid && mentions.includes(botJid)) return true;

  return false;
}

/**
 * Strips leading bot invocation tags from message text for clean AI prompting.
 */
function stripTriggerPrefix(text) {
  const botName = (process.env.BOT_NAME || 'D').toLowerCase();
  return text
    .replace(new RegExp(`^(?:@bot|/bot|@${botName}|/${botName}|(?:hey|yo|sup|hello)\\s+${botName}|${botName})[,:]?\\s*`, 'i'), '')
    .trim();
}

// ─── Multimodal Media Downloader (Image, Audio, Document) ─────────────────────

/**
 * Download a Baileys media message into a base64-encoded Buffer.
 * Returns { mimeType, base64, type } or null on failure.
 */
async function downloadMediaAsBase64(sock, mediaObj) {
  try {
    const messageToDownload = mediaObj.isQuoted
      ? {
          key: {
            remoteJid: mediaObj.msg.key.remoteJid,
            id: mediaObj.msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: mediaObj.msg.message?.extendedTextMessage?.contextInfo?.participant,
          },
          message: {
            [mediaObj.type === 'sticker'
              ? 'stickerMessage'
              : mediaObj.type === 'image'
              ? 'imageMessage'
              : mediaObj.type === 'audio'
              ? 'audioMessage'
              : 'documentMessage']: mediaObj.mediaMsg,
          },
        }
      : mediaObj.msg;

    const buffer = await downloadMediaMessage(
      messageToDownload,
      'buffer',
      {},
      { logger: { info: () => {}, error: () => {}, warn: () => {} }, reuploadRequest: sock.updateMediaMessage }
    );

    // Clean mimeType for Gemini API (strip codecs parameter)
    let mimeType = mediaObj.mimeType || 'application/octet-stream';
    if (mimeType.includes(';')) {
      mimeType = mimeType.split(';')[0].trim();
    }

    const base64 = buffer.toString('base64');
    return { mimeType, base64, type: mediaObj.type };
  } catch (err) {
    console.error(`[Handler] ${mediaObj.type} download failed:`, err.message);
    return null;
  }
}

// ─── Automated Team Member Intro Parser ──────────────────────────────────────

/**
 * Heuristic extractor for member introductions.
 * Matches structured intro lines or natural language phrases like:
 * "Name: David, Role: Backend Dev, Stack: Node, Postgres"
 * or "I am Tayo, UI/UX Designer using Figma and Tailwind"
 */
function parseMemberIntro(text) {
  if (!text || text.length < 5) return null;

  // Format 1: Key-value pairs (Name: ..., Role: ..., Skills/Stack: ...)
  const hasIntroKeys = /(?:name|alias|role|title|skills|stack|tech)\s*[:=-]/i.test(text);
  if (hasIntroKeys) {
    const nameMatch = text.match(/(?:name|alias|nickname)\s*[:=-]\s*([^\n\r,]+)/i);
    const roleMatch = text.match(/(?:role|title|position)\s*[:=-]\s*([^\n\r,]+)/i);
    const skillsMatch = text.match(/(?:skills|stack|tech|technologies|tools)\s*[:=-]\s*([^\n\r]+)/i);
    const bioMatch = text.match(/(?:building|focus|project|working on)\s*[:=-]\s*([^\n\r]+)/i);

    if (roleMatch || skillsMatch) {
      return {
        name: nameMatch ? nameMatch[1].trim() : '',
        role: roleMatch ? roleMatch[1].trim() : '',
        skills: skillsMatch ? skillsMatch[1].trim() : '',
        bio: bioMatch ? bioMatch[1].trim() : '',
      };
    }
  }

  // Format 2: "I am [Name], [Role] working with [Skills]"
  const naturalMatch = text.match(/(?:i(?:'m| am)|my name is)\s+([A-Z][a-zA-Z0-9_-]+)(?:[,\s]+(?:a|an|the)\s+([a-zA-Z\s/]+?))?(?:(?:working with|skills in|using|stack:|tech:)\s+([^.\n]+))?/i);
  if (naturalMatch && (naturalMatch[2] || naturalMatch[3])) {
    return {
      name: naturalMatch[1].trim(),
      role: naturalMatch[2] ? naturalMatch[2].trim() : '',
      skills: naturalMatch[3] ? naturalMatch[3].trim() : '',
      bio: '',
    };
  }

  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Primary message handler — registered with whatsapp.js via onMessage().
 * Called for every message in the allowed group.
 *
 * @param {object} sock - Active Baileys socket.
 * @param {object} msg  - Baileys message object.
 */
export async function handleMessage(sock, msg) {
  const m = msg.message;
  // Ignore reactions, protocol updates, poll interactions, and ephemeral notifications
  if (
    !m ||
    m.reactionMessage ||
    m.protocolMessage ||
    m.pollUpdateMessage ||
    m.senderKeyDistributionMessage
  ) {
    return;
  }

  const remoteJid = msg.key.remoteJid;
  const isGroup = remoteJid?.endsWith('@g.us');
  const isDM = !isGroup;

  // ── Extract sender info ──────────────────────────────────────────────────

  const senderJid =
    msg.key.participant ||
    msg.key.remoteJid ||
    msg.participant ||
    '';

  const senderName = msg.pushName || senderJid.split('@')[0];
  const text = extractMessageText(msg).trim();
  const mediaObj = getMediaAttachment(msg);
  const hasMedia = !!mediaObj;

  // If there is neither text nor media, ignore it
  if (!text && !hasMedia) {
    return;
  }

  // ── 1. Auto-register member ──────────────────────────────────────────────

  if (senderJid) {
    ensureMemberExists(senderJid, senderName);
  }

  // ── 2. Passive log ───────────────────────────────────────────────────────

  logMessage({
    group_jid: remoteJid,
    sender_name: senderName,
    sender_jid: senderJid,
    content: text || (hasMedia ? `[${mediaObj.type}]` : '[media]'),
    has_media: hasMedia,
  });

  // ── 3. Increment organic cooldown counter ────────────────────────────────

  cooldown.messagesSinceLastChimeIn++;

  // ── 4. Deterministic Fast Slash Commands (zero latency, zero AI cost) ────

  const cmd = text.toLowerCase().trim();
  const botNameLower = (process.env.BOT_NAME || 'D').toLowerCase();

  const isCommand = (name) =>
    cmd === `/${name}` ||
    cmd === `@bot ${name}` ||
    cmd === `/bot ${name}` ||
    cmd === `@${botNameLower} ${name}` ||
    cmd === `/${botNameLower} ${name}` ||
    (isDM && cmd === name);

  const isCommandWithArg = (name) =>
    cmd.startsWith(`/${name}`) ||
    cmd.startsWith(`@bot ${name}`) ||
    cmd.startsWith(`/bot ${name}`) ||
    cmd.startsWith(`@${botNameLower} ${name}`) ||
    cmd.startsWith(`/${botNameLower} ${name}`) ||
    (isDM && (cmd.startsWith(`${name} `) || cmd === name));

  // ── Activation / Onboarding Command ──────────────────────────────────────
  if (isCommand('activate') || isCommand('start') || isCommand('init')) {
    let chatName = senderName;
    if (isGroup) {
      try {
        const metadata = await sock.groupMetadata(remoteJid);
        chatName = metadata?.subject || 'Tech Squad';
      } catch (_) {
        chatName = 'Tech Squad';
      }
    }

    authorizeChat({
      jid: remoteJid,
      name: chatName,
      chat_type: isGroup ? 'group' : 'dm',
      added_by: senderName,
    });

    const botDisplayName = process.env.BOT_NAME || 'D';

    if (isGroup) {
      const welcome =
        `Yo squad! *${botDisplayName}* is in the building 🇳🇬🚀\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `I'm *${botDisplayName}* — your active teammate for *${chatName}*.\n` +
        `I'm here to plan with you guys, track tasks, debug issues, and make sure nobody is slacking.\n\n` +
        `👋 *Make we know who and who dey inside this space sharp sharp:*\n` +
        `Drop a quick intro (or just reply naturally):\n` +
        `• *Name / Alias*\n` +
        `• *Role* (Frontend, Backend, Mobile, UI/UX, DevOps, Lead, etc.)\n` +
        `• *Stack / Tools* (React, Node, Python, Figma, Flutter, etc.)\n` +
        `• *What you're cooking right now*\n\n` +
        `_I'll remember everyone automatically in my directory — zero stress!_ 💪\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🛠️ *What I got you guys covered on:*\n` +
        `• ☀️ *Morning Standups:* 8:00 AM daily brief to start the day sharp.\n` +
        `• 🎯 *Accountability Check:* 2:00 PM check-in on overdue tasks & blockers (no dulling!).\n` +
        `• 📈 *Weekly Retros:* 5:00 PM every Friday to celebrate what got shipped.\n` +
        `• 🚨 *Struggle Detection:* I step in with ideas or suggestions if things get stuck.\n` +
        `• 🗳️ *Team Polls:* Instant polls to make quick decisions.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *Quick Shortcuts:*\n` +
        `• */tasks* — See all open squad tasks\n` +
        `• */standup* — Drop a standup brief anytime\n` +
        `• */poll "Question" "Opt 1" "Opt 2"* — Create a poll\n` +
        `• */countdown* — Check upcoming deadline clocks\n` +
        `• */done #ID* — Tick off a task when you finish\n` +
        `• */help* — See all available shortcuts\n\n` +
        `_You can tag @${botDisplayName}, reply to my messages, or just talk normally in the group — I dey listen. Let's build!_ 🚀`;

      await sendSafeMessage(sock, remoteJid, welcome, msg);
    } else {
      const welcomeDM =
        `Hey *${senderName}*! I'm *${botDisplayName}* 🇳🇬✨\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `We're officially connected 1-on-1. Think of me as your personal partner in crime — here to bounce ideas with, organize your tasks, set reminders, debug code, or just keep you productive without the noise.\n\n` +
        `👋 *Quick check-in so I know your vibe:*\n` +
        `Tell me a little about yourself:\n` +
        `• *Role:* (Frontend, Backend, Design, Mobile, PM, etc.)\n` +
        `• *Stack / Tools:* What you love working with\n` +
        `• *Current Focus:* What you're building right now\n` +
        `_Example: "Role: Backend, Stack: Node & Postgres, Focus: Building the payment flow"_\n` +
        `↳ _I'll save your profile automatically so my help is always personalized to your style!_\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🛠️ *What you can use me for here:*\n` +
        `• 💡 *Brainstorm & Fix Bugs:* Paste any code, error, or idea — we'll figure it out together.\n` +
        `• 📋 *Personal To-Dos:* Manage your private tasks without cluttering group chats.\n` +
        `• ⏰ *Quick Reminders:* Set reminders so you don't forget things (\`/remind in 30 mins to...\`).\n` +
        `• 💾 *Snippet Vault:* Save useful code or notes and grab them whenever you need them.\n` +
        `• ⏳ *Deadlines & Countdowns:* Keep track of sprint goals & hackathon clocks.\n` +
        `• 🎙️ *Voice Notes:* Send me voice notes if you're lazy to type — I listen!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *Your Quick Shortcuts:*\n` +
        `• */mytasks* (or just \`mytasks\`) — See your open tasks\n` +
        `• */done #ID* — Tick off a completed task\n` +
        `• */remind in [time] to [action]* — e.g. \`/remind in 45 mins to push code\`\n` +
        `• */snippet save <Title> \`\`\`code\`\`\`* — Save useful code\n` +
        `• */snippet [search]* — Search your saved snippets\n` +
        `• */countdown* — Live countdown to deadlines\n` +
        `• */help* — See everything I can do\n\n` +
        `_Just chat with me like a teammate. What are you working on today?_ 🚀`;

      await sendSafeMessage(sock, remoteJid, welcomeDM, msg);
    }
    return;
  }

  // ── Auto Member Intro Detection & Storage ────────────────────────────────
  const introData = parseMemberIntro(text);
  if (introData && (introData.role || introData.skills)) {
    const memberName = introData.name || senderName || senderJid.split('@')[0];
    const member = upsertMember({
      jid: senderJid,
      name: memberName,
      role: introData.role,
      skills: introData.skills,
      bio_notes: introData.bio,
    });

    const isPhone = senderJid.endsWith('@s.whatsapp.net');
    const tag = isPhone ? `@${senderJid.split('@')[0]}` : member.name;
    const mention = isPhone ? [senderJid] : [];

    const dmTip = isDM
      ? `\n💡 *Tip:* Type */mytasks* to view your tasks, */remind in 30 mins to [action]* for reminders, or paste code here to debug anytime!`
      : '';

    const confirmMsg =
      `✅ *Profile Saved for ${tag}!* 👤\n\n` +
      `• *Name:* ${member.name}\n` +
      `• *Role:* ${member.role || 'Teammate'}\n` +
      `• *Skills:* ${member.skills || 'General Engineering'}\n` +
      (member.bio_notes ? `• *Focus:* ${member.bio_notes}\n` : '') +
      `\n_You're officially registered in the Team Directory! I'll keep your skills in mind when delegating tasks and reviewing architecture._ 🚀` +
      dmTip;

    await sendSafeMessage(sock, remoteJid, confirmMsg, msg, mention);
    return;
  }

  // Help command
  if (isCommand('help') || isCommand('commands')) {
    const botName = process.env.BOT_NAME || 'D';
    const helpText =
      `🤖 *${botName} Commands & Quick Guide*\n\n` +
      `*⚡ Fast Commands (Instant Response):*\n` +
      `• */activate* — Register & bring bot to life in a group or DM\n` +
      `• */tasks* — View all active open team tasks\n` +
      `• */deadlines* — View approaching project & hackathon deadlines\n` +
      `• */countdown* — Live countdown timer for all deadlines\n` +
      `• */mytasks* — Your personal task list (use in DM for privacy)\n` +
      `• */overdue* — Show all overdue tasks\n` +
      `• */blocked* — Show all blocked tasks\n` +
      `• */notes [keyword]* — Search or view saved project notes\n` +
      `• */snippet [keyword]* — Search saved code snippets & solutions\n` +
      `• */standup* — Generate an on-demand morning standup brief\n` +
      `• */status* or */ping* — View bot uptime & health metrics\n` +
      `• */audit* — View recent team audit trail\n\n` +
      `*✅ Task Fast Commands:*\n` +
      `• */done #5* — Mark task #5 as done\n` +
      `• */progress #5* — Mark task #5 as in progress\n` +
      `• */block #5 [reason]* — Mark task #5 as blocked\n` +
      `• */assign #5 David* — Reassign task #5 to David\n` +
      `• */remind in 30 mins to [action]* — Set a personal reminder\n` +
      `• */poll "Question" "Opt 1" "Opt 2"* — Launch a native WhatsApp poll\n\n` +
      `*🧠 AI Assistant & Teammate:*\n` +
      `• Tag *@${botName}* or reply to any bot message to plan tasks, debug, or ask questions.\n` +
      `• Multi-turn conversational memory persists across turns.\n` +
      `• Send voice notes 🎙️ to ask questions or assign tasks on the go.\n` +
      `• Share flyers 📄, UI mockups 🖼️, or docs for automatic analysis.\n` +
      `• The bot naturally chimes into technical discussions and *will call out delayed or inactive members.*`;
    await sendSafeMessage(sock, remoteJid, helpText, msg);
    return;
  }

  // Active tasks command
  if (isCommand('tasks')) {
    const tasks = getOpenTasks();
    if (tasks.length === 0) {
      await sendSafeMessage(sock, remoteJid, '🎉 *No open tasks!* The board is completely clear.', msg);
      return;
    }
    const taskLines = tasks
      .map((t) => {
        let assignee = t.assigned_to_name || 'Unassigned';
        if (t.assigned_to_jid && t.assigned_to_jid.endsWith('@s.whatsapp.net')) {
          assignee = `@${t.assigned_to_jid.split('@')[0]}`;
        }
        let due = '';
        if (t.due_date) {
          const cleanDue = t.due_date.replace('T', ' ');
          due = cleanDue.includes(':') ? ` | 📅 ${cleanDue}` : ` | 📅 ${cleanDue.slice(0, 10)}`;
        }
        const proj = t.project_name ? `[${t.project_name}] ` : '';
        return `• *#${t.id}* ${proj}*${t.title}*\n  ↳ Assignee: ${assignee} | Status: _${t.status}_${due}`;
      })
      .join('\n\n');

    const mentions = tasks
      .map((t) => t.assigned_to_jid)
      .filter((jid) => jid && jid.endsWith('@s.whatsapp.net'));
    const reply = `📋 *Active Tasks (${tasks.length})*\n\n${taskLines}\n\n_Tag @bot to assign, reassign, or update task status._`;
    await sendSafeMessage(sock, remoteJid, reply, msg, mentions);
    return;
  }

  // Upcoming deadlines command
  if (isCommand('deadlines')) {
    const deadlines = listDeadlines({ upcomingOnly: true });
    if (deadlines.length === 0) {
      await sendSafeMessage(sock, remoteJid, '📅 *No upcoming deadlines recorded.*', msg);
      return;
    }
    const lines = deadlines
      .map((d) => {
        const desc = d.description ? `\n  ↳ ${d.description}` : '';
        return `• *[${d.category.toUpperCase()}] ${d.title}*\n  📅 Due: *${d.due_date}*${desc}`;
      })
      .join('\n\n');

    const reply = `⏰ *Upcoming Deadlines (${deadlines.length})*\n\n${lines}`;
    await sendSafeMessage(sock, remoteJid, reply, msg);
    return;
  }

  // Project notes command
  if (isCommandWithArg('notes')) {
    const query = text
      .replace(/^(\/notes|@bot\s+notes|\/bot\s+notes|@[a-zA-Z0-9_]+\s+notes|\/[a-zA-Z0-9_]+\s+notes)\s*/i, '')
      .trim();
    const notes = searchProjectNotes(query);
    if (notes.length === 0) {
      await sendSafeMessage(
        sock,
        remoteJid,
        `📝 No project notes found${query ? ` matching "${query}"` : ''}.`,
        msg
      );
      return;
    }
    const lines = notes
      .map((n) => {
        const by = n.added_by ? ` (added by ${n.added_by})` : '';
        return `• *[${n.project_name}]* ${n.note}${by}`;
      })
      .join('\n\n');

    const reply = `📝 *Project Notes${query ? ` for "${query}"` : ''}*\n\n${lines}`;
    await sendSafeMessage(sock, remoteJid, reply, msg);
    return;
  }

  // Status / Ping command
  if (isCommand('status') || isCommand('ping')) {
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

    const membersCount = getAllMembers().length;
    const openTasksCount = getOpenTasks().length;
    const deadlinesCount = listDeadlines({ upcomingOnly: true }).length;

    const reply =
      `🤖 *${process.env.BOT_NAME || 'D'} Status & Health* 🟢\n\n` +
      `• *Status:* Online & Operational\n` +
      `• *Uptime:* ${uptimeStr}\n` +
      `• *Team Members:* ${membersCount} registered\n` +
      `• *Open Tasks:* ${openTasksCount}\n` +
      `• *Upcoming Deadlines:* ${deadlinesCount}\n` +
      `• *Timezone:* ${process.env.TIMEZONE || 'Africa/Lagos'}\n\n` +
      `_All systems green. We move! 🚀_`;
    await sendSafeMessage(sock, remoteJid, reply, msg);
    return;
  }

  // On-demand standup command
  if (isCommand('standup')) {
    await sendSafeMessage(sock, remoteJid, '⏳ _Generating on-demand standup brief… make we check the board sharp sharp._', msg);
    try {
      const last24h = getMessagesSince(remoteJid, 24);
      const openTasks = getOpenTasks();
      const deadlines = getUpcomingDeadlines();
      const brief = await generateStandupBrief(remoteJid, last24h, openTasks, deadlines);
      const mentions = openTasks.map((t) => t.assigned_to_jid).filter(Boolean);
      await sendSafeMessage(sock, remoteJid, brief, msg, mentions);
    } catch (err) {
      await sendSafeMessage(sock, remoteJid, `❌ Standup generation failed: ${err.message}`, msg);
    }
    return;
  }

  // ── Fast Task Commands ────────────────────────────────────────────────────

  // /done #ID — mark a task as done
  const doneMatch = cmd.match(/^(?:\/done|@bot done|\/bot done|@[a-z0-9_]+ done)\s+#?(\d+)$/i);
  if (doneMatch) {
    const taskId = parseInt(doneMatch[1], 10);
    const task = updateTaskStatus(taskId, 'done');
    if (!task) {
      await sendSafeMessage(sock, remoteJid, `❌ Task *#${taskId}* not found.`, msg);
    } else {
      await sendSafeMessage(
        sock, remoteJid,
        `✅ *Task #${taskId} marked as done!*\n\n*${task.title}*\n_Nice work! We move. 🚀_`,
        msg
      );
    }
    return;
  }

  // /progress #ID — mark as in_progress
  const progressMatch = cmd.match(/^(?:\/progress|@bot progress|\/bot progress|@[a-z0-9_]+ progress)\s+#?(\d+)$/i);
  if (progressMatch) {
    const taskId = parseInt(progressMatch[1], 10);
    const task = updateTaskStatus(taskId, 'in_progress');
    if (!task) {
      await sendSafeMessage(sock, remoteJid, `❌ Task *#${taskId}* not found.`, msg);
    } else {
      await sendSafeMessage(
        sock, remoteJid,
        `🔄 *Task #${taskId} is now In Progress!*\n\n*${task.title}*\n_Let's get it! 💪_`,
        msg
      );
    }
    return;
  }

  // /block #ID [reason] — mark as blocked with optional reason
  const blockMatch = text.match(/^(?:\/block|@bot block|\/bot block|@[a-z0-9_]+ block)\s+#?(\d+)(?:\s+(.+))?$/i);
  if (blockMatch) {
    const taskId = parseInt(blockMatch[1], 10);
    const reason = blockMatch[2]?.trim() || '';
    const task = setTaskBlockReason(taskId, reason);
    if (!task) {
      await sendSafeMessage(sock, remoteJid, `❌ Task *#${taskId}* not found.`, msg);
    } else {
      const reasonText = reason ? `\n🔒 *Blocker:* ${reason}` : '';
      await sendSafeMessage(
        sock, remoteJid,
        `🔴 *Task #${taskId} marked as Blocked*\n\n*${task.title}*${reasonText}\n\n_Tag @bot to get help unblocking this._`,
        msg
      );
    }
    return;
  }

  // /assign #ID [name] — reassign task to a member
  const assignFastMatch = text.match(/^(?:\/assign|@bot assign|\/bot assign|@[a-z0-9_]+ assign)\s+#?(\d+)\s+(.+)$/i);
  if (assignFastMatch) {
    const taskId = parseInt(assignFastMatch[1], 10);
    const nameQuery = assignFastMatch[2].trim();
    const foundMember = findMemberByName(nameQuery);
    if (!foundMember) {
      await sendSafeMessage(sock, remoteJid, `❌ Couldn't find a team member matching *"${nameQuery}"*. Check /tasks for current assignees or ask @bot to assign by name.`, msg);
    } else {
      const task = reassignTask(taskId, { assigned_to_jid: foundMember.jid, assigned_to_name: foundMember.name });
      if (!task) {
        await sendSafeMessage(sock, remoteJid, `❌ Task *#${taskId}* not found.`, msg);
      } else {
        const mention = foundMember.jid.endsWith('@s.whatsapp.net') ? [`${foundMember.jid}`] : [];
        const tag = foundMember.jid.endsWith('@s.whatsapp.net') ? `@${foundMember.jid.split('@')[0]}` : foundMember.name;
        await sendSafeMessage(
          sock, remoteJid,
          `🔁 *Task #${taskId} Reassigned!*\n\n*${task.title}*\n↳ Now assigned to ${tag}\n\n_${foundMember.name}, the ball is in your court. We dey count on you! 💪_`,
          msg, mention
        );
        // DM the newly assigned member
        if (foundMember.jid.endsWith('@s.whatsapp.net') && foundMember.jid !== senderJid) {
          try {
            await sendSafeMessage(
              sock, foundMember.jid,
              `👋 Hey *${foundMember.name}*!\n\nYou've been reassigned to task *#${task.id}: ${task.title}*${task.project_name ? ` (${task.project_name})` : ''}${task.due_date ? `\n📅 Due: ${task.due_date}` : ''}.\n\nDrop an update in the group when you start. Let's move! 🚀`,
              null
            );
          } catch (_) { /* DM might fail if they haven't messaged the bot */ }
        }
      }
    }
    return;
  }

  // /mytasks — personal task list (works in DM and group)
  if (isCommand('mytasks')) {
    const myJid = senderJid;
    const myTasks = getTasksByMember(myJid);
    if (myTasks.length === 0) {
      await sendSafeMessage(sock, remoteJid, `🎉 *No tasks assigned to you!* The board is clear for you right now.`, msg);
    } else {
      const open = myTasks.filter((t) => t.status !== 'done');
      const done = myTasks.filter((t) => t.status === 'done');
      const formatLine = (t) => {
        const icon = t.status === 'done' ? '✅' : t.status === 'blocked' ? '🔴' : t.status === 'in_progress' ? '🔄' : '⏳';
        const due = t.due_date ? ` | 📅 ${t.due_date.slice(0, 16)}` : '';
        const blocker = t.block_reason ? `\n  🔒 ${t.block_reason}` : '';
        const proj = t.project_name ? ` [${t.project_name}]` : '';
        return `${icon} *#${t.id}*${proj} ${t.title}${due}${blocker}`;
      };
      let reply = `📋 *Your Tasks, ${senderName}*\n\n`;
      if (open.length > 0) reply += `*Open (${open.length}):*\n${open.map(formatLine).join('\n')}\n\n`;
      if (done.length > 0) reply += `*Done (${done.length}):*\n${done.slice(0, 5).map(formatLine).join('\n')}`;
      reply = reply.trim();
      await sendSafeMessage(sock, remoteJid, reply, msg);
    }
    return;
  }

  // /overdue — show all overdue tasks
  if (isCommand('overdue')) {
    const overdue = getOverdueTasks();
    if (overdue.length === 0) {
      await sendSafeMessage(sock, remoteJid, `✅ *No overdue tasks!* Everything is on track.`, msg);
    } else {
      const lines = overdue.map((t) => {
        let assignee = t.assigned_to_name || 'Unassigned';
        if (t.assigned_to_jid?.endsWith('@s.whatsapp.net')) {
          assignee = `@${t.assigned_to_jid.split('@')[0]}`;
        }
        return `⚠️ *#${t.id}* ${t.title}\n  ↳ ${assignee} | Was due: ${t.due_date?.slice(0, 16) || 'N/A'}`;
      }).join('\n\n');
      const mentions = overdue.map((t) => t.assigned_to_jid).filter((j) => j?.endsWith('@s.whatsapp.net'));
      await sendSafeMessage(sock, remoteJid, `🚨 *Overdue Tasks (${overdue.length})*\n\n${lines}\n\n_These need attention ASAP. Let's get them sorted!_`, msg, mentions);
    }
    return;
  }

  // /blocked — show all blocked tasks
  if (isCommand('blocked')) {
    const blocked = getBlockedTasks();
    if (blocked.length === 0) {
      await sendSafeMessage(sock, remoteJid, `✅ *No blocked tasks right now!*`, msg);
    } else {
      const lines = blocked.map((t) => {
        let assignee = t.assigned_to_name || 'Unassigned';
        const blocker = t.block_reason ? `\n  🔒 Reason: ${t.block_reason}` : '';
        return `🔴 *#${t.id}* ${t.title}\n  ↳ ${assignee}${blocker}`;
      }).join('\n\n');
      await sendSafeMessage(sock, remoteJid, `🔴 *Blocked Tasks (${blocked.length})*\n\n${lines}\n\n_Tag @bot to help unblock any of these._`, msg);
    }
    return;
  }

  // /countdown — Live countdown timers for deadlines
  if (isCommand('countdown')) {
    const deadlines = listDeadlines({ upcomingOnly: true });
    if (deadlines.length === 0) {
      await sendSafeMessage(sock, remoteJid, '📅 *No upcoming deadlines on the radar!*', msg);
      return;
    }
    const lines = deadlines.map((d) => {
      const diffMs = new Date(d.due_date).getTime() - Date.now();
      let timer = '';
      if (diffMs > 0) {
        const days = Math.floor(diffMs / 86400000);
        const hours = Math.floor((diffMs % 86400000) / 3600000);
        const mins = Math.floor((diffMs % 3600000) / 60000);
        timer = `⏳ *${days}d ${hours}h ${mins}m left*`;
      } else {
        timer = `🚨 *OVERDUE!*`;
      }
      const desc = d.description ? `\n  ↳ 📝 ${d.description}` : '';
      return `• *[${d.category.toUpperCase()}] ${d.title}*\n  ↳ 📅 Due: ${d.due_date}\n  ↳ ${timer}${desc}`;
    }).join('\n\n');

    await sendSafeMessage(sock, remoteJid, `⏳ *Deadline Radar & Live Countdowns*\n\n${lines}\n\n_Make we push sharp sharp. Time waits for no engineer! 🚀_`, msg);
    return;
  }

  // /poll "Question" "Option 1" "Option 2" ...
  if (isCommandWithArg('poll')) {
    const raw = text.replace(/^(\/poll|@bot\s+poll|\/bot\s+poll|@[a-zA-Z0-9_]+\s+poll|\/[a-zA-Z0-9_]+\s+poll)\s*/i, '').trim();
    const matches = [...raw.matchAll(/"([^"]+)"|'([^']+)'/g)];
    if (matches.length >= 3) {
      const question = matches[0][1] || matches[0][2];
      const options = matches.slice(1).map((m) => (m[1] || m[2]).trim()).filter(Boolean);
      await sendPollMessage(sock, remoteJid, question, options);
    } else {
      await sendSafeMessage(
        sock, remoteJid,
        `💡 *How to launch a poll:*\n\n\`/poll "Question" "Option 1" "Option 2" ["Option 3"]\`\n\n_Example:_\n\`/poll "Which DB should we use?" "Supabase" "PostgreSQL" "Firebase"\``,
        msg
      );
    }
    return;
  }

  // /remind [in X mins/hours/days] to [action]
  if (isCommandWithArg('remind')) {
    const raw = text.replace(/^(\/remind|@bot\s+remind|\/bot\s+remind|@[a-zA-Z0-9_]+\s+remind|\/[a-zA-Z0-9_]+\s+remind)\s*/i, '').trim();
    const match = raw.match(/^(?:in\s+)?(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)\s+(?:to\s+)?(.+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      const reminderText = match[3].trim();
      let ms = 0;
      if (unit.startsWith('m')) ms = num * 60 * 1000;
      else if (unit.startsWith('h')) ms = num * 3600 * 1000;
      else if (unit.startsWith('d')) ms = num * 86400 * 1000;
      const targetDate = new Date(Date.now() + ms);
      const pad = (n) => String(n).padStart(2, '0');
      const dueTime = `${targetDate.getFullYear()}-${pad(targetDate.getMonth()+1)}-${pad(targetDate.getDate())} ${pad(targetDate.getHours())}:${pad(targetDate.getMinutes())}:${pad(targetDate.getSeconds())}`;

      createReminder({
        user_jid: senderJid,
        user_name: senderName,
        target_jid: isDM ? senderJid : remoteJid,
        reminder_text: reminderText,
        due_time: dueTime,
      });

      await sendSafeMessage(
        sock, remoteJid,
        `⏰ *Reminder Set!*\n\n• *Reminder:* ${reminderText}\n• *Deliver At:* ${dueTime}\n• *Destination:* ${isDM ? 'Private DM' : 'This Chat'}\n\n_I'll ping you right on time. No dulling! 🎯_`,
        msg
      );
    } else {
      await sendSafeMessage(
        sock, remoteJid,
        `💡 *How to set a reminder:*\n\n\`/remind in 30 mins to test auth webhook\`\n\`/remind in 2 hours to push commit\`\n\`/remind in 1 day to submit project\``,
        msg
      );
    }
    return;
  }

  // /snippet save [title] ```code``` OR /snippet [query]
  if (isCommandWithArg('snippet')) {
    const raw = text.replace(/^(\/snippet|@bot\s+snippet|\/bot\s+snippet|@[a-zA-Z0-9_]+\s+snippet|\/[a-zA-Z0-9_]+\s+snippet)\s*/i, '').trim();
    if (raw.toLowerCase().startsWith('save')) {
      const rest = raw.slice(4).trim();
      const codeBlockMatch = rest.match(/(?:```([a-zA-Z0-9_+#-]*)\n?([\s\S]+?)```)/);
      if (codeBlockMatch) {
        const lang = codeBlockMatch[1]?.trim() || 'javascript';
        const code = codeBlockMatch[2]?.trim();
        const title = rest.slice(0, rest.indexOf('```')).trim() || 'Code Snippet';
        const snippet = saveCodeSnippet({
          title,
          language: lang,
          code,
          added_by: senderName,
        });
        await sendSafeMessage(
          sock, remoteJid,
          `💾 *Code Snippet Saved (#${snippet.id})*\n\n*${snippet.title}* [${snippet.language}]\n\n_Use \`/snippet ${snippet.title.split(' ')[0]}\` to retrieve it anytime._`,
          msg
        );
      } else {
        await sendSafeMessage(
          sock, remoteJid,
          '💡 *How to save a snippet:*\n`/snippet save <Title>\n```javascript\nconst x = 1;\n```\n`',
          msg
        );
      }
      return;
    }

    // Search snippets
    const results = searchCodeSnippets(raw);
    if (results.length === 0) {
      await sendSafeMessage(sock, remoteJid, `🔍 No code snippets found${raw ? ` matching "${raw}"` : ''}.`, msg);
    } else {
      const formatted = results.map((s) => {
        const by = s.added_by ? ` (added by ${s.added_by})` : '';
        return `📦 *#${s.id} ${s.title}* [${s.language}]${by}\n\`\`\`${s.language}\n${s.code.slice(0, 400)}${s.code.length > 400 ? '\n// ...' : ''}\`\`\``;
      }).join('\n\n');
      await sendSafeMessage(sock, remoteJid, `💻 *Code Snippets${raw ? ` for "${raw}"` : ''}*\n\n${formatted}`, msg);
    }
    return;
  }

  // /audit — view recent system audit logs
  if (isCommand('audit') || isCommand('logs')) {
    const logs = getRecentAuditLogs(10);
    if (logs.length === 0) {
      await sendSafeMessage(sock, remoteJid, '📋 *Audit log is currently empty.*', msg);
    } else {
      const lines = logs.map((l) => {
        return `• [${l.created_at.slice(5, 16)}] *${l.action}* ${l.entity_type} (#${l.entity_id}) by _${l.performed_by}_: ${l.details}`;
      }).join('\n');
      await sendSafeMessage(sock, remoteJid, `🛡️ *Recent Team Audit Trail (Last 10 Actions)*\n\n${lines}`, msg);
    }
    return;
  }

  // ── 5. Determine if bot should respond via AI ────────────────────────────

  const botJid = sock.user?.id ? sock.user.id.replace(':0', '') + '@s.whatsapp.net' : null;
  // In private 1-on-1 DMs, always trigger a response
  const directTrigger = isDM || isDirectTrigger(msg, botJid);
  // In groups, untagged stickers do not trigger unsolicited chime-ins (to avoid spamming meme reactions)
  const orgChimeIn = !directTrigger && canChimeIn() && (shouldChimeIn(text) || (hasMedia && mediaObj.type !== 'sticker'));

  if (!directTrigger && !orgChimeIn) return;

  // ── 6. Handle media multimodal download (image, audio, document) ─────────

  let mediaData = null;
  if (hasMedia) {
    mediaData = await downloadMediaAsBase64(sock, mediaObj);
  }

  // ── 7. Build AI prompt ───────────────────────────────────────────────────

  let userContent = stripTriggerPrefix(text);
  if (!userContent && mediaData) {
    if (mediaData.type === 'audio') userContent = '(sent a voice note)';
    else if (mediaData.type === 'document') userContent = '(shared a document)';
    else if (mediaData.type === 'sticker') userContent = '(sent a sticker)';
    else userContent = '(shared an image)';
  } else if (!userContent && hasMedia) {
    userContent = '(shared an attachment)';
  }

  let enrichedMessage = isDM
    ? `[Private 1-on-1 direct chat with ${senderName}]: ${userContent}`
    : `[${senderName} says in group]: ${userContent}`;

  if (!directTrigger) {
    enrichedMessage = `[ORGANIC GROUP ENGAGEMENT — You were NOT explicitly tagged. Evaluate if you should weigh in]
${senderName} said in group: "${userContent}"

Decision Rules:
- If this is a question, a bug or blocker, technical discussion, someone sharing progress/frustration, deadline talk, or where your advice adds value: CHIME IN naturally and helpfully as D.
- Speak casually, warmly, like an experienced friendly teammate who is active in the room.
- If it's purely 2-person private chit-chat, a trivial greeting, or already answered completely: respond with ONLY the single word: SKIP
- Never say "I'm chiming in because...". Just speak directly as D.`;
  }

  if (mediaData) {
    if (mediaData.type === 'audio') {
      enrichedMessage += `\n\n[VOICE NOTE ATTACHED — Listen to the audio voice note carefully. Transcribe or address what the speaker is saying, answer their question, or execute any task assignment / deadline creation requested in the audio.]`;
    } else if (mediaData.type === 'document') {
      enrichedMessage += `\n\n[DOCUMENT ATTACHED — Review the document carefully (e.g. PRD, specification, API docs, code). Provide insightful engineering feedback, answer questions, or extract any tasks / deadlines mentioned.]`;
    } else if (mediaData.type === 'sticker') {
      enrichedMessage += `\n\n[STICKER ATTACHED — This is a WhatsApp sticker (meme, cartoon, reaction image, or graphic). Inspect the visual, any text/caption written on the sticker, characters, and facial expression. Understand the meme or emotional reaction, and respond or banter back with authentic humor and wit as D!]`;
    } else {
      enrichedMessage += `\n\n[IMAGE ATTACHED — Review the image carefully. If it's a hackathon flyer or event with a deadline, call add_deadline. If it's a UI mockup or architecture diagram, provide constructive engineering feedback and suggest tasks for relevant teammates based on their skills.]`;
    }
  }

  // ── 8. Call AI ───────────────────────────────────────────────────────────

  // Record user's turn in multi-turn conversation memory
  if (text || userContent) {
    saveConversationTurn(remoteJid, senderJid, 'user', text || userContent);
  }

  let aiResult;
  try {
    aiResult = await askAI(remoteJid, enrichedMessage, mediaData, { senderJid, senderName, isDM });
  } catch (err) {
    console.error('[Handler] AI call failed:', err.message);
    if (directTrigger) {
      await sendSafeMessage(sock, remoteJid, '_Omo, my brain glitched for a second 🤯 Abeg try again._', msg);
    }
    return;
  }

  const aiText = typeof aiResult === 'string' ? aiResult : (aiResult?.text || '');
  const pendingDms = aiResult?.pendingDms || [];
  const polls = aiResult?.polls || [];

  // ── 9. Respect SKIP signal from organic mode ──────────────────────────────

  if (!directTrigger && aiText.trim() === 'SKIP') {
    return; // Bot decided not to chime in
  }

  // ── 10. Send response ────────────────────────────────────────────────────

  if (aiText.trim()) {
    await sendSafeMessage(sock, remoteJid, aiText, msg);

    // Save model's reply into multi-turn conversation memory
    saveConversationTurn(remoteJid, botJid || 'D', 'model', aiText.trim());

    if (!directTrigger) {
      resetChimeIn();
    }
  }

  // ── 11. Dispatch any queued native polls ─────────────────────────────────

  for (const p of polls) {
    if (p.name && p.values) {
      try {
        await sendPollMessage(sock, p.jid || remoteJid, p.name, p.values, p.selectableCount || 1);
      } catch (pollErr) {
        console.error('[Handler] Failed to dispatch native poll:', pollErr.message);
      }
    }
  }

  // ── 12. Dispatch any queued private DM notifications ─────────────────────

  for (const dm of pendingDms) {
    if (dm.jid && dm.message) {
      try {
        await sendSafeMessage(sock, dm.jid, dm.message);
        console.log(`[Handler] 📨 Dispatched task DM notification to ${dm.jid}`);
      } catch (dmErr) {
        console.error('[Handler] Failed to dispatch DM notification:', dmErr.message);
      }
    }
  }
}
