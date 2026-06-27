'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../utils/supabase');

const adminOnly = (req, res, next) => req.app.get('requireApiKey')(req, res, next);

// GET /api/members/roster — list all active roster members (admin)
router.get('/roster', adminOnly, async (_req, res) => {
  try {
    const rows = await db.getMemberRoster();
    res.json(rows);
  } catch (err) {
    console.error('[members] GET /roster:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/members/roster/:name — update serve stats + recalculate points/priority (admin)
router.patch('/roster/:name', adminOnly, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { sat_serves, sun_serves, gpc_serves } = req.body;

  if ([sat_serves, sun_serves, gpc_serves].some(v => v === undefined)) {
    return res.status(400).json({ error: 'sat_serves, sun_serves, gpc_serves are required' });
  }

  const sat   = parseInt(sat_serves, 10) || 0;
  const sun   = parseInt(sun_serves, 10) || 0;
  const gpc   = parseInt(gpc_serves, 10) || 0;
  const total = sat + sun + gpc;
  const points = parseFloat((sat * 1 + sun * 1 + gpc * 1.5).toFixed(2));

  // Priority tiers: ≤3 pts → Serve Next, ≤6 → Soon, else Rest
  const priority = points <= 3 ? 'Serve Next' : points <= 6 ? 'Soon' : 'Rest';

  try {
    const updated = await db.updateMemberRosterStats(name, {
      sat_serves: sat, sun_serves: sun, gpc_serves: gpc,
      total_serves: total, points, priority,
    });
    if (!updated) return res.status(404).json({ error: `Member "${name}" not found` });
    res.json(updated);
  } catch (err) {
    console.error('[members] PATCH /roster/:name:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/members/availability/:month — get availability summary for a month (admin)
router.get('/availability/:month', adminOnly, async (req, res) => {
  const month = decodeURIComponent(req.params.month);
  try {
    const rows = await db.getAvailabilitySummary(month);
    res.json(rows);
  } catch (err) {
    console.error('[members] GET /availability/:month:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
