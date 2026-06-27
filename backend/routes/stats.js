'use strict';
// GET /api/stats — aggregated recycling + carbon impact
// Used by the portal Overview page and the /stats Telegram command.
// Falls back to static recycling.js data if Supabase is not configured.

const express = require('express');
const router  = express.Router();
const db      = require('../utils/supabase');
const carbon  = require('../utils/carbon');

router.get('/', async (_req, res) => {
  try {
    const rows = await db.getRecyclingStats();
    let data;

    if (rows && rows.length) {
      data = rows;
    } else {
      // Fallback to static data files
      const { cardboardData, plasticData } = require('../data/recycling');
      data = cardboardData.map((r, i) => ({
        month:        r.month,
        year:         parseInt(r.month.slice(-4)),
        cardboard_kg: r.kg,
        plastic_kg:   (plasticData[i] || {}).kg || 0,
      }));
    }

    const byYear    = carbon.summariseByYear(data);
    const allTime   = {
      cardboardKg: data.reduce((s, r) => s + Number(r.cardboard_kg), 0),
      plasticKg:   data.reduce((s, r) => s + Number(r.plastic_kg),   0),
    };
    const allImpact = carbon.calcCO2e(allTime.cardboardKg, allTime.plasticKg);

    res.json({
      allTime: {
        cardboardKg: Math.round(allTime.cardboardKg * 100) / 100,
        plasticKg:   Math.round(allTime.plasticKg   * 100) / 100,
        ...allImpact,
      },
      byYear,
      monthly: data,
    });
  } catch (err) {
    console.error('[Stats] Error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
