const express = require('express');
const router = express.Router();

// Seeded from Google Drive "Ideas Bank & Content Calendar"
const calendar = [
  // June 2026
  { date: '2026-06-05', theme: 'World Environment Day', owner: 'Alan', notes: 'Ask other teams their plan for Unicon', status: 'planned' },
  { date: '2026-06-07', theme: 'UNICON (5–7 Jun)',       owner: 'All', notes: 'Check if any recycling efforts here', status: 'planned' },
  { date: '2026-06-23', theme: 'Youth Camp (23–25 Jun)', owner: 'Matthew', notes: 'Check if collecting recyclables', status: 'planned' },
  // July 2026 — Plastic Free Month
  { date: '2026-07-01', theme: 'Plastic-Free July kickoff', owner: 'Comms Team', notes: 'Reduce single-use plastic focus for the month', status: 'planned' },
  { date: '2026-07-07', theme: 'Tip: Refill your bottle',  owner: 'Berry', notes: 'Sustainable living series', status: 'draft' },
  { date: '2026-07-14', theme: 'Behind-the-scenes: cardboard recycling vlog', owner: 'W2R team', notes: 'Follow rostered person; vlog style', status: 'draft' },
  { date: '2026-07-21', theme: 'HOGC Utility Bill feature', owner: 'Energy team', notes: 'How much do we pay/month in utilities?', status: 'draft' },
  { date: '2026-07-28', theme: 'Feature a team member #greenfluencer', owner: 'Sok Min', notes: 'Skits / did you know format', status: 'idea' },
];

router.get('/',         (req, res) => res.json(calendar));
router.get('/upcoming', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(calendar.filter(e => e.date >= today));
});

// POST to add/update a calendar entry
router.post('/', (req, res) => {
  const entry = { id: Date.now(), ...req.body };
  calendar.push(entry);
  res.status(201).json(entry);
});

module.exports = router;
