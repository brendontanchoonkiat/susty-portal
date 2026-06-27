'use strict';
const express = require('express');
const router  = express.Router();
const { sendWeeklySnapshot } = require('../utils/weeklySnapshot');

// ─── Webhook endpoint for grammy bot (production) ─────────────────────────────
// Set TELEGRAM_USE_WEBHOOK=true and configure webhook URL in BotFather:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-railway-url.up.railway.app/api/telegram/webhook&secret_token=<WEBHOOK_SECRET>
router.post('/webhook', express.json(), async (req, res) => {
  // Validate secret token header
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { webhookHandler } = require('../bot/index');
    if (webhookHandler) {
      return webhookHandler(req, res);
    }
    res.json({ ok: true, note: 'Bot in polling mode — webhook not active' });
  } catch (err) {
    console.error('[Telegram] Webhook error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ─── POST /api/telegram/weekly-snapshot (admin, manual trigger) ───────────────
router.post('/weekly-snapshot',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  async (req, res) => {
    try {
      const weekLabel = req.body?.weekLabel ? String(req.body.weekLabel) : null;
      const result = await sendWeeklySnapshot(weekLabel);
      res.json({ ok: result.ok, message_id: result.message_id || null, reason: result.reason || null });
    } catch (err) {
      console.error('[Telegram] weekly-snapshot error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ─── POST /api/telegram/session-summary (admin, manual trigger) ───────────────
router.post('/session-summary',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  async (req, res) => {
    try {
      const date = req.body?.date || new Date().toISOString().split('T')[0];
      const { bot } = require('../bot/index');
      const { postSessionSummary } = require('../utils/reminders');
      await postSessionSummary(bot, date);
      res.json({ ok: true, date });
    } catch (err) {
      console.error('[Telegram] session-summary error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
