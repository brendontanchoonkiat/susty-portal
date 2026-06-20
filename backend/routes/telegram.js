'use strict';
const express = require('express');
const router  = express.Router();
const { sendWeeklySnapshot } = require('../utils/weeklySnapshot');

// POST /api/telegram/weekly-snapshot
// Manually trigger the weekly Telegram snapshot (for testing).
// Requires X-Api-Key header matching ADMIN_API_KEY env var.
// Body (optional): { "weekLabel": "Week of 23 Jun 2026" }
router.post('/weekly-snapshot',
  (req, res, next) => req.app.get('requireApiKey')(req, res, next),
  async (req, res) => {
    try {
      const weekLabel = req.body && req.body.weekLabel ? String(req.body.weekLabel) : null;
      const result = await sendWeeklySnapshot(weekLabel);
      res.json({ ok: result.ok, message_id: result.message_id || null, reason: result.reason || null });
    } catch (err) {
      console.error('[Telegram] weekly-snapshot error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
