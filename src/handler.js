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
} from './db.js';
import { askAI, generateStandupBrief } from './ai.js';
import { sendSafeMessage } from './whatsapp.js';

// ─── Organic chime-in cooldown state ─────────────────────────────────────────

const cooldown = {
  messagesSinceLastChimeIn: 0,
  lastChimeInAt: 0,
  CHIME_IN_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes
  CHIME_IN_EVERY_N_MESSAGES: 15,          // at most once per 15 messages
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
 * We look for signals that a human expert would want to weigh in on.
 */
function shouldChimeIn(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  const technicalSignals = [
    /\b(bug|error|exception|crash|fix|broken|issue|problem|help)\b/,
    /\b(api|database|schema|endpoint|deploy|server|docker|cloud|ci\/cd)\b/,
    /\b(react|node|python|typescript|sql|mongodb|firebase|redis|aws|gcp)\b/,
    /\b(how do|how can|why does|what's the best|which approach|should we)\b/,
    /\b(architecture|design|pattern|refactor|performance|optimize)\b/,
    /\b(hackathon|deadline|submission|milestone|launch|release)\b/,
    /\b(meeting|standup|planning|sprint|scrum|kanban)\b/,
    /\?/, // Any question mark is a potential cue
  ];

  const casualSignals = [
    /\b(stressed|tired|overwhelmed|panic|scared|nervous|excited)\b/,
    /\b(done|finished|completed|shipped|deployed|live)\b/,
    /🚀|🔥|💡|😭|😅|🤯|🎉/,
  ];

  const hasSignal = [...technicalSignals, ...casualSignals].some((r) => r.test(lower));
  return hasSignal;
}

// ─── Message text extractor ───────────────────────────────────────────────────

/**
 * Pulls the plain text out of any Baileys message, handling all common
 * message types (text, extended text, image caption, audio, document, etc.).
 */
function extractMessageText(msg) {
  const m = msg.message;
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
  const m = msg.message;
  if (!m) return null;

  // Direct media
  if (m.imageMessage) {
    return { type: 'image', mediaMsg: m.imageMessage, mimeType: m.imageMessage.mimetype || 'image/jpeg', isQuoted: false, msg };
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
  const botName = (process.env.BOT_NAME || 'teambot').toLowerCase();

  if (
    text.startsWith('@bot') ||
    text.startsWith('/bot') ||
    text.startsWith(`@${botName}`) ||
    text.startsWith(`/${botName}`)
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
  const botName = (process.env.BOT_NAME || 'teambot').toLowerCase();
  return text
    .replace(new RegExp(`^(@bot|/bot|@${botName}|/${botName})\\b`, 'i'), '')
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
            [mediaObj.type === 'image'
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
  const botNameLower = (process.env.BOT_NAME || 'teambot').toLowerCase();

  const isCommand = (name) =>
    cmd === `/${name}` ||
    cmd === `@bot ${name}` ||
    cmd === `/bot ${name}` ||
    cmd === `@${botNameLower} ${name}` ||
    cmd === `/${botNameLower} ${name}`;

  const isCommandWithArg = (name) =>
    cmd.startsWith(`/${name}`) ||
    cmd.startsWith(`@bot ${name}`) ||
    cmd.startsWith(`/bot ${name}`) ||
    cmd.startsWith(`@${botNameLower} ${name}`) ||
    cmd.startsWith(`/${botNameLower} ${name}`);

  // Help command
  if (isCommand('help') || isCommand('commands')) {
    const botName = process.env.BOT_NAME || 'TeamBot';
    const helpText =
      `🤖 *${botName} Commands & Quick Guide*\n\n` +
      `*⚡ Fast Commands (Instant Response):*\n` +
      `• */tasks* — View all active open team tasks\n` +
      `• */deadlines* — View approaching project & hackathon deadlines\n` +
      `• */notes [keyword]* — Search or view saved project notes\n` +
      `• */standup* — Generate an on-demand morning standup brief\n` +
      `• */status* or */ping* — View bot uptime & health metrics\n` +
      `• */mytasks* — Your personal task list (use in DM for privacy)\n` +
      `• */overdue* — Show all overdue tasks\n` +
      `• */blocked* — Show all blocked tasks\n\n` +
      `*✅ Task Fast Commands:*\n` +
      `• */done #5* — Mark task #5 as done\n` +
      `• */progress #5* — Mark task #5 as in progress\n` +
      `• */block #5 [reason]* — Mark task #5 as blocked\n` +
      `• */assign #5 David* — Reassign task #5 to David\n\n` +
      `*🧠 AI Assistant & Teammate:*\n` +
      `• Tag *@${botName}* or reply to any bot message to plan tasks, debug, or ask questions.\n` +
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
      `🤖 *${process.env.BOT_NAME || 'TeamBot'} Status & Health* 🟢\n\n` +
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

  // ── 5. Determine if bot should respond via AI ────────────────────────────

  const botJid = sock.user?.id ? sock.user.id.replace(':0', '') + '@s.whatsapp.net' : null;
  // In private 1-on-1 DMs, always trigger a response
  const directTrigger = isDM || isDirectTrigger(msg, botJid);
  const orgChimeIn = !directTrigger && canChimeIn() && shouldChimeIn(text);

  if (!directTrigger && !orgChimeIn && !hasMedia) return;

  // For media with no text, only analyze if directly triggered or chime is ok
  if (hasMedia && !text && !directTrigger && !orgChimeIn) return;

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
    else userContent = '(shared an image)';
  } else if (!userContent && hasMedia) {
    userContent = '(shared an attachment)';
  }

  let enrichedMessage = isDM
    ? `[Private 1-on-1 direct chat with ${senderName}]: ${userContent}`
    : `[${senderName} says in group]: ${userContent}`;

  if (!directTrigger) {
    enrichedMessage = `[ORGANIC — Evaluate if worth responding] ${enrichedMessage}

Only chime in if:
- This is a technical question, architecture discussion, bug, or planning matter where you can add clear value.
- Or someone needs quick help or encouragement.
- Otherwise, if no reply is needed or someone else already handled it, respond with exactly: SKIP`;
  }

  if (mediaData) {
    if (mediaData.type === 'audio') {
      enrichedMessage += `\n\n[VOICE NOTE ATTACHED — Listen to the audio voice note carefully. Transcribe or address what the speaker is saying, answer their question, or execute any task assignment / deadline creation requested in the audio.]`;
    } else if (mediaData.type === 'document') {
      enrichedMessage += `\n\n[DOCUMENT ATTACHED — Review the document carefully (e.g. PRD, specification, API docs, code). Provide insightful engineering feedback, answer questions, or extract any tasks / deadlines mentioned.]`;
    } else {
      enrichedMessage += `\n\n[IMAGE ATTACHED — Review the image carefully. If it's a hackathon flyer or event with a deadline, call add_deadline. If it's a UI mockup or architecture diagram, provide constructive engineering feedback and suggest tasks for relevant teammates based on their skills.]`;
    }
  }

  // ── 8. Call AI ───────────────────────────────────────────────────────────

  let aiResult;
  try {
    aiResult = await askAI(remoteJid, enrichedMessage, mediaData);
  } catch (err) {
    console.error('[Handler] AI call failed:', err.message);
    if (directTrigger) {
      await sendSafeMessage(sock, remoteJid, '_Omo, my brain glitched for a second 🤯 Abeg try again._', msg);
    }
    return;
  }

  const aiText = typeof aiResult === 'string' ? aiResult : (aiResult?.text || '');
  const pendingDms = aiResult?.pendingDms || [];

  // ── 9. Respect SKIP signal from organic mode ──────────────────────────────

  if (!directTrigger && aiText.trim() === 'SKIP') {
    return; // Bot decided not to chime in
  }

  // ── 10. Send response ────────────────────────────────────────────────────

  if (aiText.trim()) {
    await sendSafeMessage(sock, remoteJid, aiText, msg);

    if (!directTrigger) {
      resetChimeIn();
    }
  }

  // ── 11. Dispatch any queued private DM notifications ─────────────────────

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
