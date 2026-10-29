// src/scheduler.js
// ─────────────────────────────────────────────────────────────────────────────
//  Cron Job Scheduler — node-cron
//  Jobs:
//   1. Daily 7:45 AM Admin Private Briefing      (45 7 * * *)
//   2. Daily 8:00 AM Standup Brief               (0 8 * * *)
//   3. Daily 2:00 PM Accountability & Struggle    (0 14 * * 1-5)
//   4. Friday 5:00 PM Weekly Velocity & Retro     (0 17 * * 5)
//   5. Hourly Deadline & Task Watchdog           (0 * * * *)
//   6. Minute-level Due Task Watchdog            (* * * * *)
//   7. Weekly Raw Chat Cleanup (Sunday)          (0 3 * * 0)
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
  getOverdueTasks,
  getBlockedTasks,
  getTasksByMember,
  getMemberActivityStats,
  getInactiveMembersWithTasks,
  getUnnotifiedOverdueTasks,
  markTaskOverdueNotified,
  getCompletedTasksInRange,
  getCreatedTasksInRange,
  getAllMembers,
  getAllAuthorizedGroupJids,
  getDueReminders,
  markReminderSent,
  getNow,
} from './db.js';
import {
  generateStandupBrief,
  generateStruggleSuggestion,
  generateAdminBriefing,
  generateWeeklyVelocityReport,
} from './ai.js';
import { sendSafeMessage } from './whatsapp.js';

const TIMEZONE = process.env.TIMEZONE || 'Africa/Lagos';

// ─── Helper: parse configured target group JIDs ──────────────────────────────

function getTargetGroups() {
  return getAllAuthorizedGroupJids();
}

function getAdminJids() {
  const raw = process.env.ADMIN_JIDS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((j) => (j.includes('@') ? j : `${j}@s.whatsapp.net`));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a task into a human-readable WhatsApp line with a @mention.
 */
function formatTask(t) {
  let assignee = t.assigned_to_name || 'Unassigned';
  if (t.assigned_to_jid && t.assigned_to_jid.endsWith('@s.whatsapp.net')) {
    assignee = `@${t.assigned_to_jid.split('@')[0]}`;
  }

  let due = 'no due date';
  if (t.due_date) {
    const cleanDue = t.due_date.replace('T', ' ');
    due = cleanDue.includes(':') ? `due ${cleanDue}` : `due ${cleanDue.slice(0, 10)}`;
  }

  return `• #${t.id} *${t.title}* → ${assignee} | _${t.status}_ | ${due}`;
}

/**
 * Extract all unique member JIDs from a list of tasks (for the mentions array).
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

// ─── Job 1: Daily Admin Private Briefing @ 7:45 AM ───────────────────────────

async function runAdminBriefing(sock) {
  const admins = getAdminJids();
  if (admins.length === 0) return;

  console.log('[Scheduler] 👔 Running 7:45 AM private admin briefing…');

  const overdue = getOverdueTasks();
  const todayDeadlines = getDeadlinesDueSoon(24);
  const inactiveMembers = getInactiveMembersWithTasks(2);

  for (const adminJid of admins) {
    try {
      const myTasks = getTasksByMember(adminJid);
      const adminName = adminJid.split('@')[0];
      const briefing = await generateAdminBriefing(
        adminName,
        myTasks,
        overdue,
        todayDeadlines,
        inactiveMembers
      );
      await sendSafeMessage(sock, adminJid, briefing);
      console.log(`[Scheduler] ✅ Private briefing sent to admin ${adminJid}`);
    } catch (err) {
      console.error(`[Scheduler] ❌ Admin briefing failed for ${adminJid}:`, err.message);
    }
  }
}

// ─── Job 2: Daily Standup Brief @ 8:00 AM ────────────────────────────────────

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

// ─── Job 3: Daily Accountability & Struggle Watchdog @ 2:00 PM (Mon-Fri) ─────

async function runAccountabilityWatchdog(sock) {
  const groups = getTargetGroups();
  if (groups.length === 0) return;

  console.log('[Scheduler] 🕵️‍♂️ Running 2:00 PM Accountability & Struggle Watchdog…');

  const overdueTasks = getUnnotifiedOverdueTasks();
  const blockedTasks = getBlockedTasks();
  const inactiveMembers = getInactiveMembersWithTasks(2);
  const deadlines = getUpcomingDeadlines();

  // 1. Question delaying members on overdue tasks
  if (overdueTasks.length > 0) {
    for (const t of overdueTasks) {
      const isPhoneJid = t.assigned_to_jid && t.assigned_to_jid.endsWith('@s.whatsapp.net');
      const tag = isPhoneJid ? `@${t.assigned_to_jid.split('@')[0]}` : (t.assigned_to_name || 'Teammate');
      const mention = isPhoneJid ? [t.assigned_to_jid] : [];

      const delayMessage =
        `⚠️ *TASK DELAY CHECK* ⚠️\n\n` +
        `Task *#${t.id}: ${t.title}* assigned to ${tag} was due on *${t.due_date}* and is still pending.\n\n` +
        `${tag}, what's the status bro? Any blocker holding you down? Let the team know so we can help or adjust! 💪`;

      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, delayMessage, null, mention);
      }
      markTaskOverdueNotified(t.id);
    }
  }

  // 2. Check in on members who have open tasks but have been silent in group for 48h+
  if (inactiveMembers.length > 0) {
    for (const m of inactiveMembers) {
      const isPhoneJid = m.jid && m.jid.endsWith('@s.whatsapp.net');
      const tag = isPhoneJid ? `@${m.jid.split('@')[0]}` : m.name;
      const mention = isPhoneJid ? [m.jid] : [];
      const taskList = m.tasks.map((t) => `#${t.id} "${t.title}"`).join(', ');

      const checkInMessage =
        `👀 *MEMBER CHECK-IN*\n\n` +
        `Hey ${tag}, noticed you haven't dropped an update in the group recently while holding active task(s): *${taskList}*.\n\n` +
        `How far with progress? If you're blocked or need another pair of hands, give us a quick shout! 🚀`;

      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, checkInMessage, null, mention);
      }
    }
  }

  // 3. Proactive struggle detection: If 3+ tasks are blocked/overdue, or an urgent deadline looms
  const totalStruggles = overdueTasks.length + blockedTasks.length;
  const imminentDeadline = deadlines.some((d) => {
    const diffHours = (new Date(d.due_date).getTime() - Date.now()) / 3_600_000;
    return diffHours > 0 && diffHours <= 48;
  });

  if (totalStruggles >= 3 || (imminentDeadline && totalStruggles >= 1)) {
    console.log('[Scheduler] 🚨 Struggle threshold detected. Generating AI suggestions…');
    for (const groupJid of groups) {
      try {
        const suggestion = await generateStruggleSuggestion(
          groupJid,
          overdueTasks,
          blockedTasks,
          deadlines
        );
        if (suggestion) {
          const mentions = [
            ...overdueTasks.map((t) => t.assigned_to_jid),
            ...blockedTasks.map((t) => t.assigned_to_jid),
          ].filter((j) => j && j.endsWith('@s.whatsapp.net'));

          await sendSafeMessage(sock, groupJid, suggestion, null, [...new Set(mentions)]);
          console.log(`[Scheduler] 💡 Posted struggle intervention to ${groupJid}`);
        }
      } catch (err) {
        console.error('[Scheduler] Failed to generate struggle suggestion:', err.message);
      }
    }
  }
}

// ─── Job 4: Friday 5:00 PM Weekly Velocity & Retrospective Report ────────────

async function runWeeklyVelocityReport(sock) {
  const groups = getTargetGroups();
  if (groups.length === 0) return;

  console.log('[Scheduler] 📊 Generating Friday Weekly Velocity Report…');

  const completed = getCompletedTasksInRange(7);
  const created = getCreatedTasksInRange(7);
  const openTasks = getOpenTasks();
  const activity = getMemberActivityStats(7);

  for (const groupJid of groups) {
    try {
      const report = await generateWeeklyVelocityReport(
        groupJid,
        completed,
        created,
        openTasks,
        activity
      );
      if (report) {
        await sendSafeMessage(sock, groupJid, report);
        console.log(`[Scheduler] ✅ Weekly velocity report sent to ${groupJid}`);
      }
    } catch (err) {
      console.error(`[Scheduler] ❌ Weekly velocity report failed for ${groupJid}:`, err.message);
    }
  }
}

// ─── Job 5: Hourly Watchdog ───────────────────────────────────────────────────

async function runWatchdog(sock) {
  const groups = getTargetGroups();
  console.log('[Scheduler] 👀 Running hourly watchdog…');

  // ── 5a. Deadlines within 24 hours (first alert) ────────────────────────────

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

  // ── 5b. Deadlines within 1 hour (final alert) ──────────────────────────────

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

  // ── 5c. Tasks due within 24 hours (anti-spam: alerted only once) ───────────

  try {
    const tasksDue = getTasksDueSoon(24, 'notified_24h');

    if (tasksDue.length > 0) {
      const lines = tasksDue.map(formatTask).join('\n');
      const mentions = extractTaskMentions(tasksDue);

      const alertText =
        `⏰ *Tasks Due Soon (Next 24h)*\n\n${lines}\n\n` +
        `Let's get these over the line today team! 💪`;

      for (const groupJid of groups) {
        await sendSafeMessage(sock, groupJid, alertText, null, mentions);
      }

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

// ─── Job 6: Minute-level Due Reminder Watchdog ───────────────────────────────

async function runDueReminderWatchdog(sock) {
  try {
    // 6a. Check one-shot user/team reminders
    const dueReminders = getDueReminders();
    for (const rem of dueReminders) {
      const isPhone = rem.user_jid && rem.user_jid.endsWith('@s.whatsapp.net');
      const tag = isPhone ? `@${rem.user_jid.split('@')[0]}` : (rem.user_name || 'Teammate');
      const mention = isPhone ? [rem.user_jid] : [];
      const alert =
        `🔔 *REMINDER ALERT!* 🔔\n\n` +
        `Hey ${tag}, here is what you scheduled to be reminded about:\n\n` +
        `*${rem.reminder_text}*\n\n` +
        `_Scheduled for ${rem.due_time}. Make we get it done! 🎯_`;

      await sendSafeMessage(sock, rem.target_jid, alert, null, mention);
      markReminderSent(rem.id);
      console.log(`[Scheduler] 🔔 Delivered reminder #${rem.id} to ${rem.target_jid}`);
    }

    // 6b. Check tasks that are due now
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

      if (task.assigned_to_jid) {
        await sendSafeMessage(sock, task.assigned_to_jid, alertText);
        console.log(`[Scheduler] 🔔 Due reminder sent to ${task.assigned_to_jid} for task #${task.id}`);
      }

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
 * Start all cron jobs.
 * @param {Function} getSocket - () => sock (from whatsapp.js)
 */
export function startScheduler(getSocket) {
  // 1. Minute-by-minute task due watchdog
  cron.schedule(
    '* * * * *',
    () => {
      const sock = getSocket();
      if (!sock) return;
      runDueReminderWatchdog(sock);
    },
    { timezone: TIMEZONE }
  );

  // 2. Daily Admin Private Briefing: 7:45 AM
  cron.schedule(
    '45 7 * * *',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Admin briefing skipped — socket not ready.');
      runAdminBriefing(sock);
    },
    { timezone: TIMEZONE }
  );

  // 3. Daily standup: 8:00 AM
  cron.schedule(
    '0 8 * * *',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Standup skipped — socket not ready.');
      runDailyStandup(sock);
    },
    { timezone: TIMEZONE }
  );

  // 4. Daily 2:00 PM Accountability & Struggle Watchdog (Mon - Fri)
  cron.schedule(
    '0 14 * * 1-5',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Accountability watchdog skipped — socket not ready.');
      runAccountabilityWatchdog(sock);
    },
    { timezone: TIMEZONE }
  );

  // 5. Friday 5:00 PM Weekly Velocity & Retrospective Report
  cron.schedule(
    '0 17 * * 5',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Velocity report skipped — socket not ready.');
      runWeeklyVelocityReport(sock);
    },
    { timezone: TIMEZONE }
  );

  // 6. Hourly watchdog
  cron.schedule(
    '0 * * * *',
    () => {
      const sock = getSocket();
      if (!sock) return console.warn('[Scheduler] Watchdog skipped — socket not ready.');
      runWatchdog(sock);
    },
    { timezone: TIMEZONE }
  );

  // 7. Weekly raw chat log pruning at 3:00 AM every Sunday (keeps at least 90 days)
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

  console.log(`[Scheduler] ✅ All jobs scheduled (timezone: ${TIMEZONE})`);
  console.log('  • Due Reminder Watchdog          → every minute (* * * * *)');
  console.log('  • Admin Private Briefing         → 7:45 AM daily');
  console.log('  • Group Standup Brief            → 8:00 AM daily');
  console.log('  • Accountability & Struggle Ping → 2:00 PM Mon-Fri');
  console.log('  • Weekly Velocity & Retro Report → 5:00 PM Fridays');
  console.log('  • Hourly Deadline Watchdog       → every :00');
  console.log('  • Weekly Chat Pruning            → 3:00 AM Sundays (>= 90 days retention)');
}
