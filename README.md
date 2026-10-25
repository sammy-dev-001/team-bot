# 🤖 TeamBot — AI WhatsApp Tech Team Assistant & Teammate

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Baileys-25D366.svg)](https://github.com/WhiskeySockets/Baileys)
[![AI](https://img.shields.io/badge/AI-Google_Gemini-4285F4.svg)](https://aistudio.google.com/)
[![Database](https://img.shields.io/badge/Database-SQLite_WAL-003B57.svg)](https://github.com/WiseLibs/better-sqlite3)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An AI-powered WhatsApp teammate engineered for agile software teams, hackathon squads, and startup founders. Living directly in your WhatsApp group, TeamBot acts as a senior engineer: tracking tasks, setting reminders, analyzing hackathon flyers, listening to voice notes, reviewing PRDs, generating 8:00 AM daily standup briefs, and answering technical questions with an authentic Lagos tech ecosystem vibe.

👉 **Read [ABOUT.md](ABOUT.md) for in-depth system architecture, engineering philosophy, and design decisions.**

---

## ⚡ Fast Highlights

* **Dual-Path Routing:** Instant deterministic slash commands (`/tasks`, `/deadlines`, `/notes`, `/status`, `/help`) return in `<30ms` with zero AI cost.
* **Autonomous Tool Loop:** Gemini reads and writes team members, assigns tasks to the best-suited person based on their skills, and manages project milestones.
* **Multimodal Intelligence:** Analyzes UI mockups, extracts deadlines from event flyers, parses documents/PDFs, and listens to WhatsApp voice notes.
* **Daily 8:00 AM Standup:** Automatically digests the past 24 hours of conversation, open tasks, and approaching deadlines into a crisp WhatsApp markdown brief and saves it permanently to `daily_summaries`.
* **Hourly & Minute Watchdog:** Alerts the team 24h and 1h before deadlines and tasks, with minute-by-minute exact due-time reminders directly to assignees.
* **90-Day Unlimited Memory:** SQLite keeps raw chat logs for 90 days with weekly Sunday pruning, while team members, tasks, deadlines, project notes, and daily summaries are preserved forever.
* **On-Demand 90-Day Recall:** The `search_chat_history` tool lets the AI instantly search discussions, links, decisions, and past standups up to 90 days back.
* **Anti-Ban Human Delays:** Random 1.5–3s typing simulation with composing presence before every send.

---

## 📁 Project Structure

```
team-bot/
├── src/
│   ├── index.js        # Entry point — bootstraps connection & scheduler
│   ├── whatsapp.js     # Baileys WhatsApp client, anti-ban presence, DM auth
│   ├── db.js           # SQLite schema, indexes, CRUD helpers, 90-day memory & recall
│   ├── ai.js           # Gemini AI brain, multimodal pipeline, function calling
│   ├── handler.js      # Dual-path router: instant slash commands & AI reasoning
│   └── scheduler.js    # node-cron: 8 AM standup, minute/hourly watchdog, weekly cleanup
├── auth_info/          # Auto-created — multi-file Baileys session (git-ignored)
├── team_bot.db         # Auto-created — embedded SQLite database (git-ignored)
├── .env                # Secret environment variables (git-ignored)
├── .env.example        # Environment template
├── .gitignore          # Git exclusion rules
├── ABOUT.md            # Vision, architecture, and engineering deep-dive
├── README.md           # Project guide & quickstart
└── package.json        # Dependencies & scripts
```

---

## ⚙️ Quickstart

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/sammy-dev-001/team-bot.git
cd team-bot
npm install
```

### 2. Configure Environment

Copy the example configuration:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Google Gemini API Key from https://aistudio.google.com
GEMINI_API_KEY=your_gemini_api_key_here

# Model identifier
GEMINI_MODEL=gemini-3.6-flash

# Group JID(s) — leave blank on first run to discover your JID
ALLOWED_GROUP_JID=

# Admin phone numbers / JIDs allowed to DM the bot
ADMIN_JIDS=

# Bot display name and persona
BOT_NAME=TeamBot

# Local timezone
TIMEZONE=Africa/Lagos

# Raw chat history retention (minimum 90 days, weekly cleanup)
MESSAGE_RETENTION_DAYS=90
```

### 3. First Run & Group Discovery

Start the bot:

```bash
npm start
```

1. Scan the displayed terminal QR code using WhatsApp (*Linked Devices*).
2. Send **any message** in your target WhatsApp group.
3. The console will display:
   ```
   [GROUP DISCOVERY] 📋 Message from group JID: 120363XXXXXXXXXX@g.us
     → Add to ALLOWED_GROUP_JID in your .env and restart.
   ```
4. Copy the JID, paste it into `ALLOWED_GROUP_JID` in `.env`, and restart.

---

## 💬 Commands & Interaction

### ⚡ Instant Slash Commands (Zero Latency & Zero Cost)

| Command | Action |
|---|---|
| `/tasks` | Displays all active, open tasks with @mentions and due dates |
| `/deadlines` | Lists all upcoming project, hackathon, and milestone deadlines |
| `/notes [query]` | Searches or displays architecture decisions, repo links, and project notes |
| `/standup` | Immediately generates and sends an on-demand morning standup brief |
| `/status` or `/ping` | Displays bot uptime, database counts, and system health metrics |
| `/help` | Displays the interactive command menu and guide |

### 🧠 Natural Language AI Teammate

| Trigger | Example |
|---|---|
| `@bot <question>` | `@TeamBot what's the best way to handle JWT token refresh in React Native?` |
| `/bot <instruction>` | `/bot assign the auth middleware task to Fathia, due this Friday` |
| **Voice Note 🎙️** | Send a voice memo asking for an architecture review or assigning a task |
| **Images & Flyers 🖼️** | Share a hackathon flyer to automatically extract and register deadlines |
| **Documents & PRDs 📄** | Share a PDF or API contract for instant engineering critique |
| **Reply to Bot** | Reply directly to any bot message to continue the conversation |
| **Organic Chime-in** | Bot naturally joins high-signal technical discussions |

---

## 🗃️ Database Schema

The bot operates an embedded SQLite database (`better-sqlite3`) in **WAL mode** with compound performance indexes:

| Table | Columns | Purpose |
|---|---|---|
| `team_members` | `jid`, `name`, `role`, `skills`, `aliases`, `bio_notes` | Team directory and skill matching |
| `tasks` | `id`, `title`, `description`, `assigned_to_jid`, `status`, `due_date`, `notified_24h` | Task tracking and assignee mentions |
| `deadlines` | `id`, `title`, `category`, `due_date`, `notified_24h`, `notified_1h` | Hackathons and milestone watchdog |
| `project_notes` | `id`, `project_name`, `note`, `added_by`, `created_at` | Long-term architecture and decision memory |
| `messages` | `id`, `group_jid`, `sender_name`, `content`, `timestamp` | Context window & 75-day retention standup data |

---

## 🔒 Security & Privacy

* **Strict Chat Isolation:** Messages outside `ALLOWED_GROUP_JID` are ignored.
* **DM Authorization:** Private 1-on-1 direct messages require the sender to be in `ADMIN_JIDS` or the registered team directory.
* **Local Data Sovereignty:** Session credentials (`auth_info/`) and databases (`team_bot.db*`) run locally and are permanently git-ignored.
* **No Leaked Tokens:** `.env` and sensitive files are excluded from version control.

---

## 📝 License

Distributed under the [MIT](LICENSE) License. See `LICENSE` for more information.
