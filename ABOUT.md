# 🤖 About TeamBot

> **The AI Senior Engineer living directly inside your WhatsApp group.**

TeamBot is an autonomous AI assistant and active teammate designed specifically for fast-paced engineering squads, hackathon teams, and startup founders. Rather than requiring teams to switch between Slack, Jira, Notion, and Discord, TeamBot operates where high-velocity teams already communicate: **WhatsApp**.

---

## 🎯 The Vision

In modern engineering teams, high-signal conversations and critical decisions happen in chat streams:
- *"Who is taking ownership of the payment gateway webhook?"*
- *"We decided on PostgreSQL RLS instead of custom middleware for auth."*
- *"Don't forget the hackathon submission portal closes at 11:59 PM tomorrow."*

Too often, these action items vanish into the scrollback abyss. Standups are missed, flyers with hard deadlines get lost in media galleries, and developers end up duplicating work.

**TeamBot solves this by acting as an attentive, proactive senior teammate in the room.** It remembers who everyone is, tracks open tasks, extracts deadlines from flyers and documents, listens to voice notes, delivers morning standup briefs, and chimes into technical discussions with pragmatic engineering insight.

---

## 🏗️ Architecture & Engineering Design

TeamBot is built with a lightweight, zero-cloud-overhead architecture designed to run reliably 24/7 on local machines, VPS servers, or Docker containers.

```
                    ┌──────────────────────────────────────┐
                    │            WhatsApp Chat             │
                    │      (Group Chat or Private DM)      │
                    └──────────────────┬───────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────────┐
                    │      @whiskeysockets/baileys         │
                    │   • Multi-file auth session          │
                    │   • Auto-reconnect & QR handling     │
                    │   • Anti-ban human typing delays     │
                    │   • Native @phonenumber mentions     │
                    └──────────────────┬───────────────────┘
                                       │
                         Message Routing & Filtering
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────────┐                         ┌───────────────────────┐
│   Fast Slash Commands     │                         │   Multimodal Media    │
│  (/tasks, /deadlines,     │                         │      Pipeline         │
│   /notes, /status, /help) │                         │ • Images (Flyers/UIs) │
│  • <30ms execution        │                         │ • Voice Notes (Audio) │
│  • Zero API latency/cost  │                         │ • Documents (PDF/Code)│
└───────────┬───────────────┘                         └───────────┬───────────┘
            │                                                     │
            │                                                     ▼
            │                                         ┌───────────────────────┐
            │                                         │   Google Gemini API   │
            │                                         │    (@google/genai)    │
            │                                         │ • Rich Team Context   │
            │                                         │ • Multi-step Tool Loop│
            │                                         │ • Function Calling    │
            │                                         └───────────┬───────────┘
            │                                                     │
            └──────────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────────┐
                    │     SQLite Database (WAL Mode)       │
                    │          (better-sqlite3)            │
                    │ • team_members (skills, roles)       │
                    │ • tasks (assignees, status, due)     │
                    │ • deadlines (hackathons, events)     │
                    │ • project_notes (architecture)       │
                    │ • daily_summaries (archived briefs)  │
                    │ • messages (90-day retention)        │
                    └──────────────────┬───────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────────┐
                    │     node-cron Automated Services     │
                    │ • 8:00 AM Daily Morning Standup      │
                    │ • Hourly & Minute Watchdog Alerts    │
                    │ • Weekly 90-Day Raw Chat Cleanup     │
                    └──────────────────────────────────────┘
```

---

## 🧩 Core Pillars

### 1. Dual-Path Execution (Speed + Intelligence)
Not every interaction requires a large language model. TeamBot features a dual-path routing engine:
* **The Deterministic Fast-Path:** Commands like `/tasks`, `/deadlines`, `/notes`, and `/status` execute directly against SQLite in under 30 milliseconds with zero API costs.
* **The Autonomous Reasoning Loop:** Complex natural language questions, code reviews, flyer analysis, and task assignments run through Gemini's multi-step function-calling loop.

### 2. Autonomous Tool Calling (Write & Read Memory)
Gemini doesn't just generate text; it acts as an agent with full CRUD access to the team's operational state:
* `upsert_team_member` — Automatically discovers teammates, roles, and skills.
* `assign_task` & `reassign_task` — Suggests the best-suited teammate based on directory skills.
* `update_task_status` & `delete_task` — Manages Kanban-style task lifecycles.
* `add_deadline` & `list_deadlines` — Keeps track of hackathons, demo days, and sprint milestones.
* `save_project_note` & `get_project_notes` — Permanent memory for architecture decisions and repository links.
* `search_chat_history` — On-demand 90-day recall across raw chat logs and archived daily standup briefs.

### 3. 90-Day Unlimited Memory & Archival
* **90-Day Raw Chat Buffer:** All incoming group and DM messages are retained in SQLite for at least 90 days, indexed by timestamp and group JID.
* **Weekly Automated Cleanup:** A weekly cron job (Sundays at 3:00 AM) safely prunes only raw chat logs older than 90 days.
* **Permanent Data Persistence:** Team directory, tasks, deadlines, project notes, and archived 8:00 AM daily briefs are never deleted.
* **Deep On-Demand Recall:** While immediate context holds the last 30 messages, the AI seamlessly searches the full 90-day archive when asked about older links, decisions, announcements, or discussions.

### 4. Voice Notes & Multimodal Understanding
Modern teams communicate via voice memos and screenshots. TeamBot handles:
* **Voice Notes (PTT):** Transcribes audio voice notes and extracts action items or answers queries.
* **Hackathon Flyers & Posters:** Automatically extracts event dates and saves deadlines to the database.
* **UI Mockups & Architecture Diagrams:** Provides actionable engineering critique and task breakdowns.
* **Documents:** Analyzes PRDs, API specs, and shared code snippets.

### 5. Organic Engineering Teammate
Rather than remaining silent until tagged, TeamBot intelligently listens for technical cues (error logs, architecture debates, performance bottlenecks). Using a 15-minute / 15-message cooldown, it chimes in when it can add genuine engineering value.

---

## 🌍 The Persona & Culture

TeamBot speaks with the sharp, pragmatic voice of a **Lagos tech ecosystem** senior software engineer 🇳🇬:
* Professional, rigorous technical English as the foundation.
* Natural, authentic colloquial warmth (*"no wahala"*, *"sharp sharp"*, *"make we move"*, *"no dulling"*).
* Grounded in reality: actionable advice, realistic estimations, and zero corporate fluff.

---

## 🛣️ Roadmap

- [ ] **GitHub Webhooks Integration:** Announce merged PRs, failed CI/CD builds, and new releases directly into WhatsApp.
- [ ] **Vocal Audio Synthesis:** Respond via native voice note using text-to-speech for hands-free updates.
- [ ] **Vector Embeddings (RAG):** Semantic search across months of technical project notes and architecture decisions.
- [ ] **Multi-Squad Role-Based Access Control:** Fine-grained permissions per sub-team in sprawling organizations.

---

## 📄 License

MIT License. Crafted with passion for engineering teams everywhere.
