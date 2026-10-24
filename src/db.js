// src/db.js
// ─────────────────────────────────────────────────────────────────────────────
//  SQLite Database Layer — better-sqlite3 (synchronous, zero-config)
//  All tables are created on first run. Every exported function is a clean,
//  synchronous CRUD helper consumed by handler.js, ai.js, and scheduler.js.
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'team_bot.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  -- Performance Indexes
  CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_jid, timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
  CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines(due_date);
`);

// Safe migration for existing databases missing notified_24h on tasks
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN notified_24h INTEGER DEFAULT 0;`);
} catch (e) {
  // Column already exists, ignore
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
  if (existing) {
    db.prepare(`
      UPDATE team_members SET
        name      = COALESCE(NULLIF(?, ''), name),
        aliases   = COALESCE(NULLIF(?, ''), aliases),
        role      = COALESCE(NULLIF(?, ''), role),
        skills    = COALESCE(NULLIF(?, ''), skills),
        bio_notes = COALESCE(NULLIF(?, ''), bio_notes),
        updated_at = datetime('now')
      WHERE jid = ?
    `).run(name, aliases, role, skills, bio_notes, jid);
  } else {
    db.prepare(`
      INSERT INTO team_members (jid, name, aliases, role, skills, bio_notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jid, name || jid.split('@')[0], aliases || '', role || '', skills || '', bio_notes || '');
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
  const info = db.prepare(`
    INSERT INTO tasks (title, description, assigned_to_jid, assigned_to_name, project_name, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    title,
    description || '',
    assigned_to_jid || '',
    assigned_to_name || '',
    project_name || '',
    due_date || ''
  );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
}

/** Update a task's status. */
export function updateTaskStatus(task_id, status) {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task_id);
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
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status NOT IN ('done')
      AND due_date != ''
      AND datetime(due_date) <= datetime('now', '+' || ? || ' hours')
      AND datetime(due_date) >= datetime('now')
      AND ${safeFlag} = 0
    ORDER BY datetime(due_date) ASC
  `).all(withinHours);
}

/** Mark a task's notification flag. */
export function markTaskNotified(id, flagField = 'notified_24h') {
  const safeFlag = flagField === 'notified_24h' ? 'notified_24h' : 'notified_24h';
  db.prepare(`UPDATE tasks SET ${safeFlag} = 1 WHERE id = ?`).run(id);
}

// ─── deadlines ────────────────────────────────────────────────────────────────

/** Add a new deadline. */
export function addDeadline({ title, category, due_date, description }) {
  const info = db.prepare(`
    INSERT INTO deadlines (title, category, due_date, description)
    VALUES (?, ?, ?, ?)
  `).run(title, category || 'project', due_date, description || '');
  return db.prepare('SELECT * FROM deadlines WHERE id = ?').get(info.lastInsertRowid);
}

/** List deadlines with optional upcoming filter. */
export function listDeadlines({ upcomingOnly = true } = {}) {
  if (upcomingOnly) {
    return db.prepare(`
      SELECT * FROM deadlines
      WHERE datetime(due_date) >= datetime('now')
      ORDER BY datetime(due_date) ASC
    `).all();
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
  return db.prepare(`
    SELECT * FROM deadlines
    WHERE datetime(due_date) >= datetime('now')
    ORDER BY datetime(due_date) ASC
  `).all();
}

/** Get deadlines due within N hours, filtering by notification flag. */
export function getDeadlinesDueSoon(withinHours = 24, flagField = 'notified_24h') {
  const validFlags = ['notified_24h', 'notified_1h'];
  const safeFlag = validFlags.includes(flagField) ? flagField : 'notified_24h';
  return db.prepare(`
    SELECT * FROM deadlines
    WHERE datetime(due_date) >= datetime('now')
      AND datetime(due_date) <= datetime('now', '+' || ? || ' hours')
      AND ${safeFlag} = 0
    ORDER BY datetime(due_date) ASC
  `).all(withinHours);
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
  const info = db.prepare(`
    INSERT INTO project_notes (project_name, note, added_by)
    VALUES (?, ?, ?)
  `).run(project_name, note, added_by || '');
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
  db.prepare(`
    INSERT INTO messages (group_jid, sender_name, sender_jid, content, has_media)
    VALUES (?, ?, ?, ?, ?)
  `).run(group_jid, sender_name || '', sender_jid || '', content || '', has_media ? 1 : 0);
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
  return db.prepare(`
    SELECT * FROM messages
    WHERE group_jid = ?
      AND timestamp >= datetime('now', '-' || ? || ' hours')
    ORDER BY timestamp ASC
  `).all(group_jid, hoursAgo);
}

/** Delete messages older than specified days (minimum 75 days retention). */
export function pruneOldMessages(days = 75) {
  const retentionDays = Math.max(75, Number(days) || 75);
  const info = db.prepare(`
    DELETE FROM messages
    WHERE timestamp < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
  return info.changes;
}

export default db;
