'use strict';
const express = require('express');
const router  = express.Router();
const { electricityData, waterData } = require('../data/energy');
const { validateEnergyUpdate } = require('../middleware/validate');

router.get('/electricity', (_req, res) => res.json(electricityData));
router.get('/water',       (_req, res) => res.json(waterData));

router.get('/summary', (_req, res) => {
  const latest = electricityData.filter(r => r.kwh !== null).slice(-1)[0] || null;
  const total  = electricityData.filter(r => r.kwh).reduce((s, r) => s + r.kwh, 0);
  res.json({ latest, total });
});

// POST requires admin API key + validated body
router.post('/electricity', (req, res, next) => {
  // Delegate to requireApiKey stored on app
  req.app.get('requireApiKey')(req, res, next);
}, validateEnergyUpdate, (req, res) => {
  const { month, kwh } = req.body;
  const entry = electricityData.find(e => e.month === month);
  if (entry) {
    entry.kwh = kwh;
    return res.json({ ok: true, entry });
  }
  electricityData.push({ month, kwh });
  res.status(201).json({ ok: true });
});

module.exports = router;
