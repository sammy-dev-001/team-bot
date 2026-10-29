// src/db.js
// ─────────────────────────────────────────────────────────────────────────────
//  SQLite Database Layer — better-sqlite3 (synchronous, zero-config)
//  All tables are created on first run. Every exported function is a clean,
//  synchronous CRUD helper consumed by handler.js, ai.js, and scheduler.js.
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'team_bot.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Timezone Helpers ────────────────────────────────────────────────────────

/**
 * Returns current timestamp formatted as "YYYY-MM-DD HH:MM:SS"
 * in the configured team timezone (defaults to Africa/Lagos).
 */
export function getNow() {
  const tz = process.env.TIMEZONE || 'Africa/Lagos';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`;
}

/**
 * Returns relative timestamp in configured timezone offset by hoursDelta / daysDelta.
 */
export function getRelativeTime(hoursDelta = 0, daysDelta = 0) {
  const tz = process.env.TIMEZONE || 'Africa/Lagos';
  const target = new Date(Date.now() + hoursDelta * 3600000 + daysDelta * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(target);

  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS team_members (
    jid          TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    aliases      TEXT DEFAULT '',
    role         TEXT DEFAULT '',
    skills       TEXT DEFAULT '',
    bio_notes    TEXT DEFAULT '',
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    description      TEXT DEFAULT '',
    assigned_to_jid  TEXT DEFAULT '',
    assigned_to_name TEXT DEFAULT '',
    project_name     TEXT DEFAULT '',
    status           TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done','blocked')),
    due_date         TEXT DEFAULT '',
    notified_24h     INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (assigned_to_jid) REFERENCES team_members(jid) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS deadlines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    category     TEXT DEFAULT 'project' CHECK(category IN ('hackathon','project','event')),
    due_date     TEXT NOT NULL,
    description  TEXT DEFAULT '',
    notified_24h INTEGER DEFAULT 0,
    notified_1h  INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    note         TEXT NOT NULL,
    added_by     TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid    TEXT NOT NULL,
    sender_name  TEXT DEFAULT '',
    sender_jid   TEXT DEFAULT '',
    content      TEXT DEFAULT '',
    has_media    INTEGER DEFAULT 0,
    timestamp    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    created_at   TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid       TEXT NOT NULL,
    user_name      TEXT DEFAULT '',
    target_jid     TEXT NOT NULL,
    reminder_text  TEXT NOT NULL,
    due_time       TEXT NOT NULL,
    is_sent        INTEGER DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS code_snippets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    language     TEXT DEFAULT 'javascript',
    code         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    added_by     TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT DEFAULT '',
    details       TEXT DEFAULT '',
    performed_by  TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid    TEXT NOT NULL,
    sender_jid  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user','model')),
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS authorized_chats (
    jid         TEXT PRIMARY KEY,
    name        TEXT DEFAULT '',
    chat_type   TEXT DEFAULT 'group' CHECK(chat_type IN ('group', 'dm')),
    status      TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused')),
    added_by    TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Performance Indexes
  CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_jid, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
  CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines(due_date);
  CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_time, is_sent);
  CREATE INDEX IF NOT EXISTS idx_snippets_title ON code_snippets(title);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversation_history(chat_jid, created_at);
`);

// Safe migrations for tasks table
const taskMigrations = [
  `ALTER TABLE tasks ADD COLUMN notified_24h INTEGER DEFAULT 0;`,
  `ALTER TABLE tasks ADD COLUMN notified_due INTEGER DEFAULT 0;`,
  `ALTER TABLE tasks ADD COLUMN completed_at TEXT DEFAULT '';`,
  `ALTER TABLE tasks ADD COLUMN updated_at TEXT DEFAULT '';`,
  `ALTER TABLE tasks ADD COLUMN block_reason TEXT DEFAULT '';`,
  `ALTER TABLE tasks ADD COLUMN notified_overdue_at TEXT DEFAULT '';`,
];
for (const sql of taskMigrations) {
  try { db.exec(sql); } catch (e) { /* Column already exists */ }
}

// ─── team_members ─────────────────────────────────────────────────────────────

/**
 * Insert a minimal member record if the JID doesn't already exist.
 * Used by the auto-discovery logic in handler.js.
 */
export function ensureMemberExists(jid, name) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO team_members (jid, name) VALUES (?, ?)
  `);
  stmt.run(jid, name || jid.split('@')[0]);
}

/**
 * Full upsert — merges new fields with existing data (won't overwrite
 * existing values with blanks).
 */
export function upsertMember({ jid, name, aliases, role, skills, bio_notes }) {
  const existing = db.prepare('SELECT * FROM team_members WHERE jid = ?').get(jid);
  const now = getNow();
  if (existing) {
    db.prepare(`
      UPDATE team_members SET
        name      = COALESCE(NULLIF(?, ''), name),
        aliases   = COALESCE(NULLIF(?, ''), aliases),
        role      = COALESCE(NULLIF(?, ''), role),
        skills    = COALESCE(NULLIF(?, ''), skills),
        bio_notes = COALESCE(NULLIF(?, ''), bio_notes),
        updated_at = ?
      WHERE jid = ?
    `).run(name, aliases, role, skills, bio_notes, now, jid);
  } else {
    db.prepare(`
      INSERT INTO team_members (jid, name, aliases, role, skills, bio_notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jid, name || jid.split('@')[0], aliases || '', role || '', skills || '', bio_notes || '', now);
  }
  return db.prepare('SELECT * FROM team_members WHERE jid = ?').get(jid);
}

/** Get a single member by JID. */
export function getMember(jid) {
  return db.prepare('SELECT * FROM team_members WHERE jid = ?').get(jid);
}

/** Get all team members. */
export function getAllMembers() {
  return db.prepare('SELECT * FROM team_members ORDER BY name').all();
}

/** Find a member by name or alias (case-insensitive partial match). */
export function findMemberByName(name) {
  const lower = `%${name.toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM team_members
    WHERE lower(name) LIKE ? OR lower(aliases) LIKE ?
    LIMIT 1
  `).get(lower, lower);
}

/** Check if a member JID is already registered in the directory. */
export function isMemberRegistered(jid) {
  if (!jid) return false;
  const row = db.prepare('SELECT 1 FROM team_members WHERE jid = ? LIMIT 1').get(jid);
  return !!row;
}

// ─── tasks ────────────────────────────────────────────────────────────────────

/** Create a new task. */
export function createTask({ title, description, assigned_to_jid, assigned_to_name, project_name, due_date }) {
  const now = getNow();
  const info = db.prepare(`
    INSERT INTO tasks (title, description, assigned_to_jid, assigned_to_name, project_name, due_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    description || '',
    assigned_to_jid || '',
    assigned_to_name || '',
    project_name || '',
    due_date || '',
    now
  );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
}

/** Update a task's status. Sets completed_at when marking done. */
export function updateTaskStatus(task_id, status) {
  const now = getNow();
  if (status === 'done') {
    db.prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(status, now, now, task_id);
  } else {
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, task_id);
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
}

/** Reassign a task to another team member. */
export function reassignTask(task_id, { assigned_to_jid, assigned_to_name }) {
  db.prepare(`
    UPDATE tasks SET
      assigned_to_jid = ?,
      assigned_to_name = ?
    WHERE id = ?
  `).run(assigned_to_jid || '', assigned_to_name || '', task_id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
}

/** Delete a task by ID. */
export function deleteTask(task_id) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
  if (!existing) return null;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task_id);
  return existing;
}

/** List tasks with optional filters. */
export function listTasks({ assigned_to_jid, status, project_name } = {}) {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (assigned_to_jid) { query += ' AND assigned_to_jid = ?'; params.push(assigned_to_jid); }
  if (status)          { query += ' AND status = ?';          params.push(status); }
  if (project_name)    { query += ' AND lower(project_name) LIKE ?'; params.push(`%${project_name.toLowerCase()}%`); }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
}

/** Get all open tasks (todo / in_progress / blocked). */
export function getOpenTasks() {
  return db.prepare(`
    SELECT * FROM tasks WHERE status IN ('todo','in_progress','blocked') ORDER BY due_date ASC, created_at ASC
  `).all();
}

/** Get tasks due within the next N hours, filtering by notification flag. */
export function getTasksDueSoon(withinHours = 24, flagField = 'notified_24h') {
  const safeFlag = flagField === 'notified_24h' ? 'notified_24h' : 'notified_24h';
  const now = getNow();
  const future = getRelativeTime(withinHours);
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status NOT IN ('done')
      AND due_date != ''
      AND datetime(due_date) <= datetime(?)
      AND datetime(due_date) > datetime(?)
      AND ${safeFlag} = 0
    ORDER BY datetime(due_date) ASC
  `).all(future, now);
}

/** Mark a task's notification flag. */
export function markTaskNotified(id, flagField = 'notified_24h') {
  const safeFlag = flagField === 'notified_24h' ? 'notified_24h' : 'notified_24h';
  db.prepare(`UPDATE tasks SET ${safeFlag} = 1 WHERE id = ?`).run(id);
}

/** Get tasks that have reached or passed their due date and haven't received a due notification yet. */
export function getTasksDueNow() {
  const now = getNow();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status NOT IN ('done')
      AND due_date != ''
      AND datetime(due_date) <= datetime(?)
      AND (notified_due = 0 OR notified_due IS NULL)
    ORDER BY datetime(due_date) ASC
  `).all(now);
}

/** Mark a task as notified for its due time. */
export function markTaskDueNotified(id) {
  db.prepare(`UPDATE tasks SET notified_due = 1 WHERE id = ?`).run(id);
}

// ─── deadlines ────────────────────────────────────────────────────────────────

/** Add a new deadline. */
export function addDeadline({ title, category, due_date, description }) {
  const now = getNow();
  const info = db.prepare(`
    INSERT INTO deadlines (title, category, due_date, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, category || 'project', due_date, description || '', now);
  return db.prepare('SELECT * FROM deadlines WHERE id = ?').get(info.lastInsertRowid);
}

/** List deadlines with optional upcoming filter. */
export function listDeadlines({ upcomingOnly = true } = {}) {
  if (upcomingOnly) {
    const now = getNow();
    return db.prepare(`
      SELECT * FROM deadlines
      WHERE datetime(due_date) >= datetime(?)
      ORDER BY datetime(due_date) ASC
    `).all(now);
  }
  return db.prepare('SELECT * FROM deadlines ORDER BY datetime(due_date) ASC').all();
}

/** Delete a deadline by ID. */
export function deleteDeadline(id) {
  const existing = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare('DELETE FROM deadlines WHERE id = ?').run(id);
  return existing;
}

/** Get all upcoming (future) deadlines ordered soonest first. */
export function getUpcomingDeadlines() {
  const now = getNow();
  return db.prepare(`
    SELECT * FROM deadlines
    WHERE datetime(due_date) >= datetime(?)
    ORDER BY datetime(due_date) ASC
  `).all(now);
}

/** Get deadlines due within N hours, filtering by notification flag. */
export function getDeadlinesDueSoon(withinHours = 24, flagField = 'notified_24h') {
  const validFlags = ['notified_24h', 'notified_1h'];
  const safeFlag = validFlags.includes(flagField) ? flagField : 'notified_24h';
  const now = getNow();
  const future = getRelativeTime(withinHours);
  return db.prepare(`
    SELECT * FROM deadlines
    WHERE datetime(due_date) >= datetime(?)
      AND datetime(due_date) <= datetime(?)
      AND ${safeFlag} = 0
    ORDER BY datetime(due_date) ASC
  `).all(now, future);
}

/** Mark a deadline's notification flag so we don't spam. */
export function markDeadlineNotified(id, flagField = 'notified_24h') {
  const validFlags = ['notified_24h', 'notified_1h'];
  const safeFlag = validFlags.includes(flagField) ? flagField : 'notified_24h';
  db.prepare(`UPDATE deadlines SET ${safeFlag} = 1 WHERE id = ?`).run(id);
}

// ─── project_notes ────────────────────────────────────────────────────────────

/** Save a project note. */
export function saveProjectNote({ project_name, note, added_by }) {
  const now = getNow();
  const info = db.prepare(`
    INSERT INTO project_notes (project_name, note, added_by, created_at)
    VALUES (?, ?, ?, ?)
  `).run(project_name, note, added_by || '', now);
  return db.prepare('SELECT * FROM project_notes WHERE id = ?').get(info.lastInsertRowid);
}

/** Get all notes for a project. */
export function getProjectNotes(project_name) {
  return db.prepare(`
    SELECT * FROM project_notes WHERE lower(project_name) LIKE ? ORDER BY created_at DESC
  `).all(`%${project_name.toLowerCase()}%`);
}

/** Search project notes across projects and content. */
export function searchProjectNotes(keyword = '') {
  if (!keyword || !keyword.trim()) {
    return db.prepare('SELECT * FROM project_notes ORDER BY created_at DESC LIMIT 20').all();
  }
  const term = `%${keyword.trim().toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM project_notes
    WHERE lower(project_name) LIKE ? OR lower(note) LIKE ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(term, term);
}

// ─── messages ─────────────────────────────────────────────────────────────────

/** Persist a group message. */
export function logMessage({ group_jid, sender_name, sender_jid, content, has_media }) {
  const now = getNow();
  db.prepare(`
    INSERT INTO messages (group_jid, sender_name, sender_jid, content, has_media, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(group_jid, sender_name || '', sender_jid || '', content || '', has_media ? 1 : 0, now);
}

/** Retrieve the last N messages for a group. */
export function getRecentMessages(group_jid, limit = 30) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE group_jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(group_jid, limit);
}

/** Messages from the last N hours (used by the daily standup). */
export function getMessagesSince(group_jid, hoursAgo = 24) {
  const past = getRelativeTime(-hoursAgo);
  return db.prepare(`
    SELECT * FROM messages
    WHERE group_jid = ?
      AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(group_jid, past);
}

// ─── daily_summaries ──────────────────────────────────────────────────────────

/**
 * Save a daily brief summary into daily_summaries.
 * Daily summaries are stored permanently (never pruned).
 */
export function saveDailySummary({ date, summary_text }) {
  const now = getNow();
  const summaryDate = date || now.slice(0, 10);
  const info = db.prepare(`
    INSERT INTO daily_summaries (date, summary_text, created_at)
    VALUES (?, ?, ?)
  `).run(summaryDate, summary_text, now);
  return db.prepare('SELECT * FROM daily_summaries WHERE id = ?').get(info.lastInsertRowid);
}

/** Get a daily summary by date (YYYY-MM-DD). */
export function getDailySummary(date) {
  return db.prepare('SELECT * FROM daily_summaries WHERE date = ? ORDER BY id DESC LIMIT 1').get(date);
}

/** Get recent daily summaries. */
export function getRecentDailySummaries(limit = 14) {
  return db.prepare('SELECT * FROM daily_summaries ORDER BY date DESC, id DESC LIMIT ?').all(limit);
}

// ─── 90-Day Unlimited Recall / Search ─────────────────────────────────────────

/**
 * Search raw messages and daily summaries over the past 90 days.
 * Queries messages (by content, sender_name, timestamp) and daily_summaries (by summary_text, date).
 *
 * @param {object} [options]
 * @param {string} [options.keyword]       - Text to search across chat messages and daily briefs
 * @param {string} [options.sender_name]   - Filter chat messages by sender name
 * @param {number} [options.days_ago_start]- Search window start (days ago, default: 90)
 * @param {number} [options.days_ago_end]  - Search window end (days ago, default: 0)
 */
export function searchChatHistory({ keyword = '', sender_name = '', days_ago_start = 90, days_ago_end = 0 } = {}) {
  const startDays = Math.max(1, Number(days_ago_start) || 90);
  const endDays = Math.max(0, Number(days_ago_end) || 0);
  const actualStartDays = Math.max(startDays, endDays);
  const actualEndDays = Math.min(startDays, endDays);

  const startTime = getRelativeTime(0, -actualStartDays);
  const endTime = getRelativeTime(0, -actualEndDays);
  const startDate = startTime.slice(0, 10);
  const endDate = endTime.slice(0, 10);

  // 1. Search messages within 90-day window
  let messageSql = `
    SELECT id, group_jid, sender_name, sender_jid, content, timestamp
    FROM messages
    WHERE timestamp >= ? AND timestamp <= ?
  `;
  const messageParams = [startTime, endTime];

  if (keyword && keyword.trim()) {
    messageSql += ` AND lower(content) LIKE ?`;
    messageParams.push(`%${keyword.trim().toLowerCase()}%`);
  }

  if (sender_name && sender_name.trim()) {
    messageSql += ` AND lower(sender_name) LIKE ?`;
    messageParams.push(`%${sender_name.trim().toLowerCase()}%`);
  }

  messageSql += ` ORDER BY timestamp DESC LIMIT 50`;
  const messages = db.prepare(messageSql).all(...messageParams);

  // 2. Search daily_summaries
  let summarySql = `
    SELECT id, date, summary_text, created_at
    FROM daily_summaries
    WHERE date >= ? AND date <= ?
  `;
  const summaryParams = [startDate, endDate];

  if (keyword && keyword.trim()) {
    summarySql += ` AND lower(summary_text) LIKE ?`;
    summaryParams.push(`%${keyword.trim().toLowerCase()}%`);
  }

  summarySql += ` ORDER BY date DESC LIMIT 15`;
  const daily_summaries = db.prepare(summarySql).all(...summaryParams);

  return {
    time_window: {
      from: startTime,
      to: endTime,
      days_window: actualStartDays - actualEndDays,
    },
    message_count: messages.length,
    summary_count: daily_summaries.length,
    messages,
    daily_summaries,
  };
}

/**
 * Delete raw chat logs older than specified days (minimum 90 days retention).
 * Weekly cleanup only prunes raw chat logs from messages; team_members, tasks,
 * deadlines, project_notes, and daily_summaries are kept forever.
 */
export function pruneOldMessages(days = 90) {
  const retentionDays = Math.max(90, Number(days) || 90);
  const cutoff = getRelativeTime(0, -retentionDays);
  const info = db.prepare(`
    DELETE FROM messages
    WHERE timestamp < ?
  `).run(cutoff);
  return info.changes;
}

/** Set a task's block reason. */
export function setTaskBlockReason(task_id, reason) {
  const now = getNow();
  db.prepare('UPDATE tasks SET status = ?, block_reason = ?, updated_at = ? WHERE id = ?').run('blocked', reason || '', now, task_id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
}

/** Get all tasks currently overdue (past due_date and not done). */
export function getOverdueTasks() {
  const now = getNow();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status NOT IN ('done')
      AND due_date != ''
      AND datetime(due_date) < datetime(?)
    ORDER BY datetime(due_date) ASC
  `).all(now);
}

/** Get all tasks with 'blocked' status. */
export function getBlockedTasks() {
  return db.prepare(`
    SELECT * FROM tasks WHERE status = 'blocked' ORDER BY created_at ASC
  `).all();
}

/**
 * Get all tasks for a specific member JID, sorted by urgency.
 * Open tasks first (in_progress > blocked > todo), then done.
 */
export function getTasksByMember(jid) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE assigned_to_jid = ?
    ORDER BY
      CASE status
        WHEN 'in_progress' THEN 1
        WHEN 'blocked'     THEN 2
        WHEN 'todo'        THEN 3
        WHEN 'done'        THEN 4
        ELSE 5
      END,
      CASE WHEN due_date = '' THEN 1 ELSE 0 END,
      datetime(due_date) ASC
  `).all(jid);
}

/**
 * Get member activity stats (message count + last active) for the last N days.
 * Used by accountability watchdog and velocity report.
 */
export function getMemberActivityStats(days = 7) {
  const cutoff = getRelativeTime(0, -days);
  return db.prepare(`
    SELECT sender_jid, sender_name,
           COUNT(*) as message_count,
           MAX(timestamp) as last_active
    FROM messages
    WHERE timestamp >= ?
    GROUP BY sender_jid
    ORDER BY message_count DESC
  `).all(cutoff);
}

/**
 * Get team members who have open tasks but haven't sent a message
 * in the last `inactiveDays` days. Used by accountability watchdog.
 */
export function getInactiveMembersWithTasks(inactiveDays = 2) {
  const cutoff = getRelativeTime(0, -inactiveDays);
  const assignees = db.prepare(`
    SELECT DISTINCT assigned_to_jid, assigned_to_name
    FROM tasks
    WHERE status NOT IN ('done') AND assigned_to_jid != ''
  `).all();

  const inactive = [];
  for (const member of assignees) {
    const lastMsg = db.prepare(`
      SELECT timestamp FROM messages
      WHERE sender_jid = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(member.assigned_to_jid);

    const isInactive = !lastMsg || lastMsg.timestamp < cutoff;
    if (isInactive) {
      const tasks = db.prepare(`
        SELECT * FROM tasks
        WHERE assigned_to_jid = ? AND status NOT IN ('done')
      `).all(member.assigned_to_jid);
      inactive.push({
        jid: member.assigned_to_jid,
        name: member.assigned_to_name,
        tasks,
        lastActive: lastMsg?.timestamp || null,
      });
    }
  }
  return inactive;
}

/** Mark an overdue task as nudged (sets notified_overdue_at to now). */
export function markTaskOverdueNotified(task_id) {
  const now = getNow();
  db.prepare('UPDATE tasks SET notified_overdue_at = ? WHERE id = ?').run(now, task_id);
}

/**
 * Get tasks that are overdue and haven't been nudged in the last 24h.
 * Used by the accountability watchdog.
 */
export function getUnnotifiedOverdueTasks() {
  const now = getNow();
  const cutoff24h = getRelativeTime(-24);
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status NOT IN ('done')
      AND due_date != ''
      AND datetime(due_date) < datetime(?)
      AND (notified_overdue_at = '' OR notified_overdue_at IS NULL OR datetime(notified_overdue_at) < datetime(?))
    ORDER BY datetime(due_date) ASC
  `).all(now, cutoff24h);
}

/** Get tasks completed within the last N days (uses completed_at). */
export function getCompletedTasksInRange(days = 7) {
  const cutoff = getRelativeTime(0, -days);
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'done'
      AND completed_at != ''
      AND datetime(completed_at) >= datetime(?)
    ORDER BY datetime(completed_at) DESC
  `).all(cutoff);
}

/** Get tasks created within the last N days. */
export function getCreatedTasksInRange(days = 7) {
  const cutoff = getRelativeTime(0, -days);
  return db.prepare(`
    SELECT * FROM tasks
    WHERE datetime(created_at) >= datetime(?)
    ORDER BY datetime(created_at) DESC
  `).all(cutoff);
}

// ─── Reminders ────────────────────────────────────────────────────────────────

/**
 * Create a new one-shot reminder.
 */
export function createReminder({ user_jid, user_name, target_jid, reminder_text, due_time }) {
  const now = getNow();
  const info = db.prepare(`
    INSERT INTO reminders (user_jid, user_name, target_jid, reminder_text, due_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user_jid, user_name || '', target_jid || user_jid, reminder_text, due_time, now);
  logAudit({
    action: 'CREATE',
    entity_type: 'reminder',
    entity_id: String(info.lastInsertRowid),
    details: `${reminder_text} (due: ${due_time})`,
    performed_by: user_name || user_jid,
  });
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Get all un-sent reminders that have reached their due time.
 */
export function getDueReminders() {
  const now = getNow();
  return db.prepare(`
    SELECT * FROM reminders
    WHERE is_sent = 0
      AND datetime(due_time) <= datetime(?)
    ORDER BY datetime(due_time) ASC
  `).all(now);
}

/**
 * Mark a reminder as sent.
 */
export function markReminderSent(id) {
  db.prepare('UPDATE reminders SET is_sent = 1 WHERE id = ?').run(id);
}

/**
 * List pending reminders for a user.
 */
export function listUserReminders(user_jid) {
  const now = getNow();
  return db.prepare(`
    SELECT * FROM reminders
    WHERE user_jid = ?
      AND is_sent = 0
      AND datetime(due_time) >= datetime(?)
    ORDER BY datetime(due_time) ASC
  `).all(user_jid, now);
}

// ─── Code Snippets ────────────────────────────────────────────────────────────

/**
 * Save a code snippet with title, language, code, and optional description.
 */
export function saveCodeSnippet({ title, language = 'javascript', code, description = '', added_by = '' }) {
  const now = getNow();
  const info = db.prepare(`
    INSERT INTO code_snippets (title, language, code, description, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, language, code, description, added_by, now);
  logAudit({
    action: 'SAVE',
    entity_type: 'snippet',
    entity_id: String(info.lastInsertRowid),
    details: `${title} [${language}]`,
    performed_by: added_by,
  });
  return db.prepare('SELECT * FROM code_snippets WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Search code snippets by title, description, or language.
 */
export function searchCodeSnippets(keyword = '') {
  if (!keyword || !keyword.trim()) {
    return db.prepare('SELECT * FROM code_snippets ORDER BY created_at DESC LIMIT 10').all();
  }
  const term = `%${keyword.trim().toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM code_snippets
    WHERE lower(title) LIKE ?
       OR lower(description) LIKE ?
       OR lower(language) LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(term, term, term);
}

/**
 * Get a specific snippet by ID.
 */
export function getCodeSnippetById(id) {
  return db.prepare('SELECT * FROM code_snippets WHERE id = ?').get(id);
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

/**
 * Append an entry to the audit log.
 */
export function logAudit({ action, entity_type, entity_id = '', details = '', performed_by = '' }) {
  try {
    const now = getNow();
    db.prepare(`
      INSERT INTO audit_log (action, entity_type, entity_id, details, performed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(action, entity_type, String(entity_id), details, performed_by, now);
  } catch (err) {
    console.error('[DB] Failed to write audit log:', err.message);
  }
}

/**
 * Get the latest N audit log entries.
 */
export function getRecentAuditLogs(limit = 20) {
  return db.prepare(`
    SELECT * FROM audit_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

// ─── Rolling Multi-Turn Conversation Memory ───────────────────────────────────

/**
 * Save a conversation turn (user input or assistant reply).
 */
export function saveConversationTurn(chat_jid, sender_jid, role, content) {
  try {
    const now = getNow();
    db.prepare(`
      INSERT INTO conversation_history (chat_jid, sender_jid, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(chat_jid, sender_jid || '', role, content, now);

    // Keep history bounded to last 20 turns per chat to avoid infinite DB growth
    db.prepare(`
      DELETE FROM conversation_history
      WHERE id IN (
        SELECT id FROM conversation_history
        WHERE chat_jid = ?
        ORDER BY id DESC
        LIMIT -1 OFFSET 20
      )
    `).run(chat_jid);
  } catch (err) {
    console.error('[DB] Failed to save conversation turn:', err.message);
  }
}

/**
 * Get recent conversation turns for a chat (ascending order for prompting).
 */
export function getRecentConversationHistory(chat_jid, limit = 8) {
  const rows = db.prepare(`
    SELECT role, content, sender_jid, created_at
    FROM conversation_history
    WHERE chat_jid = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(chat_jid, limit);
  return rows.reverse();
}

// ─── Authorized Chats (Dynamic Registration & Activation) ─────────────────────

/**
 * Register or re-activate a group or DM in the database.
 */
export function authorizeChat({ jid, name = '', chat_type = 'group', added_by = '' }) {
  const now = getNow();
  db.prepare(`
    INSERT INTO authorized_chats (jid, name, chat_type, status, added_by, created_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), authorized_chats.name),
      status = 'active'
  `).run(jid, name || '', chat_type, added_by || '', now);

  logAudit({
    action: 'AUTHORIZE',
    entity_type: chat_type,
    entity_id: jid,
    details: `Authorized ${chat_type} "${name || jid}"`,
    performed_by: added_by || 'system',
  });

  return db.prepare('SELECT * FROM authorized_chats WHERE jid = ?').get(jid);
}

/**
 * Deauthorize or pause a chat.
 */
export function deauthorizeChat(jid) {
  db.prepare("UPDATE authorized_chats SET status = 'paused' WHERE jid = ?").run(jid);
  logAudit({
    action: 'DEAUTHORIZE',
    entity_type: 'chat',
    entity_id: jid,
    details: 'Paused / deauthorized chat',
    performed_by: 'system',
  });
}

/**
 * Check if a chat (group or DM) is authorized to use the bot.
 */
export function isChatAuthorized(jid) {
  if (!jid) return false;
  // 1. Env configured groups
  const envGroups = (process.env.ALLOWED_GROUP_JID || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  if (envGroups.includes(jid)) return true;

  // 2. Env configured admins
  const envAdmins = (process.env.ADMIN_JIDS || '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean);
  const senderNum = jid.split('@')[0];
  if (envAdmins.some((a) => a === jid || a === senderNum || `${a}@s.whatsapp.net` === jid)) {
    return true;
  }

  // 3. Database registered chats
  const row = db.prepare("SELECT 1 FROM authorized_chats WHERE jid = ? AND status = 'active' LIMIT 1").get(jid);
  if (row) return true;

  // 4. Any registered team member is authorized for 1-on-1 DM
  if (isMemberRegistered(jid)) return true;

  return false;
}

/**
 * Get all authorized group JIDs (combining .env and SQLite database).
 */
export function getAllAuthorizedGroupJids() {
  const envGroups = (process.env.ALLOWED_GROUP_JID || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

  const dbRows = db.prepare(`
    SELECT jid FROM authorized_chats
    WHERE chat_type = 'group' AND status = 'active'
  `).all();

  const dbGroups = dbRows.map((r) => r.jid);
  return [...new Set([...envGroups, ...dbGroups])];
}

/**
 * Get all authorized chats.
 */
export function getAllAuthorizedChats() {
  return db.prepare("SELECT * FROM authorized_chats WHERE status = 'active' ORDER BY created_at DESC").all();
}

export default db;
