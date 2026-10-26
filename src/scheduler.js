// src/scheduler.js
// ─────────────────────────────────────────────────────────────────────────────
//  Cron Job Scheduler — node-cron
//  Jobs:
//   1. Daily 8:00 AM Standup Brief        (0 8 * * *)
//   2. Hourly Deadline & Task Watchdog    (0 * * * *)
//   3. Minute-level Due Task Watchdog     (* * * * *)
//   4. Weekly Raw Chat Cleanup (Sunday)   (0 3 * * 0)
// ─────────────────────────────────────────────────────────────────────────────

import cron from 'node-cron';
import 'dotenv/config';
import {
  getMessagesSince,
  getOpenTasks,
  getUpcomingDeadlines,
  getDeadlinesDueSoon,
  markDeadlineNotified,
  getTasksDueSoon,
  markTaskNotified,
  getTasksDueNow,
  markTaskDueNotified,
  saveDailySummary,
  pruneOldMessages,
  getNow,
} from './db.js';
import { generateStandupBrief } from './ai.js';
import { sendSafeMessage } from './whatsapp.js';

const TIMEZONE = process.env.TIMEZONE || 'Africa/Lagos';

// ─── Helper: parse configured target group JIDs ──────────────────────────────

function getTargetGroups() {
  const raw = process.env.ALLOWED_GROUP_JID || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a task into a human-readable WhatsApp line with a @mention.
 */
function formatTask(t) {
  // Use display name first. Only use @mention if JID is a real phone number (@s.whatsapp.net).
  // Never prepend @ to an internal @lid ID (which WhatsApp turns into a Congolese +243 number).
  let assignee = t.assigned_to_name || 'Unassigned';
  if (t.assigned_to_jid && t.assigned_to_jid.endsWith('@s.whatsapp.net')) {
    assignee = `@${t.assigned_to_jid.split('@')[0]}`;
  }

  // Preserve full date and time if present
  let due = 'no due date';
  if (t.due_date) {
    const cleanDue = t.due_date.replace('T', ' ');
    due = cleanDue.includes(':') ? `due ${cleanDue}` : `due ${cleanDue.slice(0, 10)}`;
  }

  return `• #${t.id} *${t.title}* → ${assignee} | _${t.status}_ | ${due}`;
}

/**
 * Extract all unique member JIDs from a list of tasks (for the mentions array).
 * Only includes real phone numbers ending in @s.whatsapp.net to avoid corrupted mentions.
 */
function extractTaskMentions(tasks) {
  return [
    ...new Set(
      tasks
        .map((t) => t.assigned_to_jid)
        .filter((jid) => jid && jid.endsWith('@s.whatsapp.net'))
    ),
  ];
}

// ─── Job 1: Daily Standup Brief @ 8:00 AM ────────────────────────────────────

async function runDailyStandup(sock) {
  const groups = getTargetGroups();
  if (groups.length === 0) {
    console.warn('[Scheduler] Daily Standup skipped — ALLOWED_GROUP_JID not set.');
    return;
  }

  console.log('[Scheduler] 📋 Running daily standup brief…');

  const openTasks   = getOpenTasks();
  const deadlines   = getUpcomingDeadlines();
  const mentions    = extractTaskMentions(openTasks);

  for (const groupJid of groups) {
    try {
      const last24h = getMessagesSince(groupJid, 24);
      const brief = await generateStandupBrief(groupJid, last24h, openTasks, deadlines);

      await sendSafeMessage(sock, groupJid, brief, null, mentions);
      console.log(`[Scheduler] ✅ Daily standup sent to ${groupJid}`);

      // Automatically save 8:00 AM Daily Brief into daily_summaries (kept forever)
      try {
        const todayDate = getNow().slice(0, 10);
        saveDailySummary({ date: todayDate, summary_text: brief });
        console.log(`[Scheduler] 💾 Saved 8:00 AM Daily Brief into daily_summaries for ${todayDate}`);
      } catch (saveErr) {
        console.error('[Scheduler] Failed to save daily summary:', saveErr.message);
      }
    } catch (err) {
      console.error(`[Scheduler] ❌ Daily standup failed for ${groupJid}:`, err.message);
    }
  }
}

// ─── Job 2: Hourly Watchdog ───────────────────────────────────────────────────

async function runWatchdog(sock) {
  const groups = getTargetGroups();
  console.log('[Scheduler] 👀 Running hourly watchdog…');

  const primaryGroup = groups[0];

  // ── 2a. Deadlines within 24 hours (first alert) ────────────────────────────

  try {
    const soon24h = getDeadlinesDueSoon(24, 'notified_24h');

    for (const d of soon24h) {
      const hoursLeft = Math.max(
        0,
        Math.round((new Date(d.due_date).getTime() - Date.now()) / 3_600_000)
      );

      const alertText =
        `⚠️ *DEADLINE ALERT* ⚠️\n\n` +
        `*${d.title}* [${d.category.toUpperCase()}] is due in ~${hoursLeft} hour(s)!\n` +
        `📅 *Due:* ${d.due_date}\n` +
        (d.description ? `📝 ${d.description}\n` : '') +
        `\nTeam, make we wrap this up sharp sharp. No dulling! 🚀`;

      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, alertText);
      }
      markDeadlineNotified(d.id, 'notified_24h');
      console.log(`[Scheduler] ⚠️  24h alert sent for deadline "${d.title}"`);
    }
  } catch (err) {
    console.error('[Scheduler] Deadline 24h watchdog error:', err.message);
  }

  // ── 2b. Deadlines within 1 hour (final alert) ──────────────────────────────

  try {
    const soon1h = getDeadlinesDueSoon(1, 'notified_1h');

    for (const d of soon1h) {
      const alertText =
        `🚨 *FINAL HOUR ALERT!* 🚨\n\n` +
        `*${d.title}* [${d.category.toUpperCase()}] is due in LESS THAN 1 HOUR!\n` +
        `📅 *Due:* ${d.due_date}\n` +
        (d.description ? `📝 ${d.description}\n` : '') +
        `\nIf you're still pushing commits or wrapping up, please finish up now o! 🏃‍♂️💨`;

      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, alertText);
      }
      markDeadlineNotified(d.id, 'notified_1h');
      console.log(`[Scheduler] 🚨 1h alert sent for deadline "${d.title}"`);
    }
  } catch (err) {
    console.error('[Scheduler] Deadline 1h watchdog error:', err.message);
  }

  // ── 2c. Tasks due within 24 hours (anti-spam: alerted only once) ───────────

  try {
    const tasksDue = getTasksDueSoon(24, 'notified_24h');

    if (tasksDue.length > 0) {
      const lines = tasksDue.map(formatTask).join('\n');
      const mentions = extractTaskMentions(tasksDue);

      const alertText =
        `⏰ *Tasks Due Soon (Next 24h)*\n\n${lines}\n\n` +
        `Let's get these over the line today team! 💪`;

      // Broadcast the 24h group summary to configured team groups
      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, alertText, null, mentions);
      }

      // Mark tasks as notified so the watchdog doesn't spam every hour
      for (const t of tasksDue) {
        markTaskNotified(t.id, 'notified_24h');
      }

      if (groups.length > 0) {
        console.log(`[Scheduler] ⏰ Task due-soon alert sent (${tasksDue.length} task(s))`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Task watchdog error:', err.message);
  }
}

// ─── Job 3: Minute-level Due Reminder Watchdog ───────────────────────────────

async function runDueReminderWatchdog(sock) {
  try {
    const dueTasks = getTasksDueNow();
    if (dueTasks.length === 0) return;

    const groups = getTargetGroups();

    for (const task of dueTasks) {
      const alertText =
        `⏰ *REMINDER: TASK DUE NOW!* ⏰\n\n` +
        `*Task:* ${task.title}\n` +
        (task.description ? `📝 *Details:* ${task.description}\n` : '') +
        (task.project_name ? `📁 *Project:* ${task.project_name}\n` : '') +
        `📅 *Due:* ${task.due_date}\n` +
        `\nOya, time to get this done! 🚀`;

      // 1. If assigned to a user, notify them in their DM (works even in DM testing)
      if (task.assigned_to_jid) {
        await sendSafeMessage(sock, task.assigned_to_jid, alertText);
        console.log(`[Scheduler] 🔔 Due reminder sent to ${task.assigned_to_jid} for task #${task.id}`);
      }

      // 2. Broadcast to team groups if configured
      for (const groupJid of groups) {
        if (groupJid !== task.assigned_to_jid) {
          const mention = task.assigned_to_jid ? [task.assigned_to_jid] : [];
          await sendSafeMessage(sock, groupJid, alertText, null, mention);
        }
      }

      markTaskDueNotified(task.id);
    }
  } catch (err) {
    console.error('[Scheduler] Minute reminder watchdog error:', err.message);
  }
}

// ─── Bootstrap scheduler ─────────────────────────────────────────────────────

/**
 * Start all cron jobs. Receives the Baileys socket getter so it always uses
 * the latest reconnected socket.
 *
 * @param {Function} getSocket - () => sock   (from whatsapp.js)
 */
export function startScheduler(getSocket) {
  // Minute-by-minute task due watchdog (for exact scheduled reminders)
  cron.schedule(
    '* * * * *',
    () => {
      const sock = getSocket();
      if (!sock) return;
      runDueReminderWatchdog(sock);
    },
    { timezone: TIMEZONE }
  );

  // Daily standup: 8:00 AM every day in configured timezone
  cron.schedule(
    '0 8 * * *',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Standup skipped — socket not ready.');
      runDailyStandup(sock);
    },
    { timezone: TIMEZONE }
  );

  // Hourly watchdog
  cron.schedule(
    '0 * * * *',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Watchdog skipped — socket not ready.');
      runWatchdog(sock);
    },
    { timezone: TIMEZONE }
  );

  // Weekly raw chat log pruning at 3:00 AM every Sunday (keeps at least 90 days)
  // Only prunes raw chat logs from messages; team_members, tasks, deadlines,
  // project_notes, and daily_summaries are kept forever.
  cron.schedule(
    '0 3 * * 0',
    () => {
      try {
        const retentionDays = Math.max(90, Number(process.env.MESSAGE_RETENTION_DAYS) || 90);
        const pruned = pruneOldMessages(retentionDays);
        if (pruned > 0) {
          console.log(`[Scheduler] 🧹 Weekly cleanup: pruned ${pruned} raw chat log(s) older than ${retentionDays} days.`);
        }
      } catch (err) {
        console.error('[Scheduler] Weekly message pruning error:', err.message);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(`[Scheduler] ✅ Jobs started (timezone: ${TIMEZONE})`);
  console.log('  • Due Reminder Watchdog → every minute (* * * * *)');
  console.log('  • Daily Standup → 8:00 AM (daily)');
  console.log('  • Hourly Watchdog → every :00');
  console.log('  • Weekly Raw Chat Cleanup → 3:00 AM Sundays (weekly, >= 90 days retention)');
}
