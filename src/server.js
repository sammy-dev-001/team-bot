// src/server.js
// ─────────────────────────────────────────────────────────────────────────────
//  Lightweight Webhook & Health Check Server
//  Listens on SERVER_PORT / PORT to receive GitHub events, deployment alerts,
//  and keep-alive pingers.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { getAllAuthorizedGroupJids } from './db.js';
import { sendSafeMessage } from './whatsapp.js';

/**
 * Broadcasts an alert message to all active authorized WhatsApp group chats.
 */
async function broadcastToSquad(getSocket, messageText) {
  const sock = getSocket();
  if (!sock) {
    console.warn('[Server] Socket not ready — cannot broadcast webhook event.');
    return;
  }

  const groupJids = getAllAuthorizedGroupJids();
  if (!groupJids.length) {
    console.log('[Server] No authorized groups configured for webhook broadcast.');
    return;
  }

  for (const jid of groupJids) {
    try {
      await sendSafeMessage(sock, jid, messageText);
    } catch (err) {
      console.warn(`[Server] Failed to deliver webhook to ${jid}:`, err.message);
    }
  }
}

/**
 * Starts the webhook HTTP server.
 * @param {Function} getSocket - Function that returns current Baileys socket.
 */
export function startWebhookServer(getSocket) {
  const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method.toUpperCase();

    // ── 1. Health check & Status Endpoint ────────────────────────────────────
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          bot: process.env.BOT_NAME || 'D',
          uptime_seconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // Read request body for POST webhooks
    if (method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          req.destroy(); // 2MB safety limit
        }
      });

      req.on('end', async () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (_) {
          payload = {};
        }

        // ── 2. GitHub Webhook (/webhook/github) ───────────────────────────────
        if (url.pathname === '/webhook/github') {
          const event = req.headers['x-github-event'] || 'unknown';

          if (event === 'ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Pong! Webhook connected to D.' }));
            return;
          }

          let alertText = null;

          if (event === 'push') {
            const branch = (payload.ref || '').replace('refs/heads/', '');
            const repo = payload.repository?.full_name || 'repository';
            const pusher = payload.pusher?.name || payload.sender?.login || 'Someone';
            const commits = payload.commits || [];

            if (commits.length > 0) {
              const commitLines = commits
                .slice(0, 3)
                .map((c) => `• _${(c.message || '').split('\n')[0].trim()}_`)
                .join('\n');
              const more = commits.length > 3 ? `\n_...and ${commits.length - 3} more commit(s)_` : '';

              alertText =
                `🐙 *GitHub Push to \`${repo}\`*\n` +
                `🌿 Branch: *${branch}* by _${pusher}_\n\n` +
                `${commitLines}${more}\n\n` +
                `🔗 ${payload.compare || payload.repository?.html_url || ''}`;
            }
          } else if (event === 'pull_request') {
            const pr = payload.pull_request;
            const action = payload.action;
            const repo = payload.repository?.full_name || '';

            if (pr) {
              if (action === 'closed' && pr.merged) {
                alertText =
                  `🎉 *PR #${pr.number} Merged into \`${pr.base?.ref}\`!* 🚀\n` +
                  `📦 Repo: *${repo}*\n` +
                  `📝 *${pr.title}*\n` +
                  `👤 Merged by: _${payload.sender?.login || 'Team'}_\n` +
                  `🔗 ${pr.html_url}`;
              } else if (action === 'opened') {
                alertText =
                  `🔥 *New Pull Request Opened!* 👀\n` +
                  `📦 Repo: *${repo}*\n` +
                  `PR *#${pr.number}: ${pr.title}*\n` +
                  `👤 Author: _${pr.user?.login || 'Teammate'}_\n` +
                  `🔗 ${pr.html_url}\n\n` +
                  `_Squad, please review & approve sharp sharp!_ 🚀`;
              }
            }
          } else if (event === 'issues') {
            const issue = payload.issue;
            const action = payload.action;
            if (issue && (action === 'opened' || action === 'closed')) {
              const icon = action === 'opened' ? '🐛' : '✅';
              alertText =
                `${icon} *Issue #${issue.number} ${action.toUpperCase()}*\n` +
                `📝 *${issue.title}*\n` +
                `👤 By: _${payload.sender?.login || 'Team'}_\n` +
                `🔗 ${issue.html_url}`;
            }
          } else if (event === 'release' && payload.action === 'published') {
            const rel = payload.release;
            alertText =
              `🚀 *New Release Published!* 📦\n` +
              `🏷️ Tag: *${rel.tag_name}* (${rel.name || 'Release'})\n` +
              `🔗 ${rel.html_url}`;
          }

          if (alertText) {
            console.log(`[Server] 🐙 GitHub Webhook event '${event}' received — broadcasting to squad.`);
            await broadcastToSquad(getSocket, alertText);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, event }));
          return;
        }

        // ── 3. Deployment Webhook (/webhook/deploy) ───────────────────────────
        if (url.pathname === '/webhook/deploy') {
          const project = payload.project || payload.name || 'App';
          const env = payload.environment || payload.target || 'production';
          const deployUrl = payload.url || payload.deployment_url || '';
          const status = (payload.status || 'success').toUpperCase();
          const author = payload.author || payload.creator || '';

          const icon = status === 'SUCCESS' || status === 'READY' ? '🚀' : status === 'FAILED' ? '🚨' : '🔄';
          const authorLine = author ? `\n👤 Triggered by: _${author}_` : '';
          const linkLine = deployUrl ? `\n🔗 ${deployUrl}` : '';

          const alertText =
            `${icon} *Deployment ${status}* 🌐\n` +
            `*${project}* (${env})${authorLine}${linkLine}`;

          console.log(`[Server] 🌐 Deploy Webhook received for ${project} (${status}).`);
          await broadcastToSquad(getSocket, alertText);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // Unknown POST route
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
      });
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    console.log(`[Server] 🌐 Webhook & Health server active on port ${PORT}`);
  });

  server.on('error', (err) => {
    console.warn(`[Server] Webhook server notice:`, err.message);
  });

  return server;
}
