const express = require('express');
const router = express.Router();

// W2R roster — sourced from Google Drive "Recycling Weekend Roster" sheet
// Sun team = Clarice/Jiayu side; Sat team = Clara/Pamela/Candice side
const w2rRoster = [
  // June 2026
  { week: 'Jun W1',  date: '7 Jun (Sat)',  team: ['Boone-Wy', 'Candice Au'],      session: 'SAT' },
  { week: 'Jun W1',  date: '8 Jun (Sun)',  team: ['Jace Ong', 'Kai Jie'],         session: 'SUN' },
  { week: 'Jun W2',  date: '14 Jun (Sat)', team: ['Pamela Tan', 'Clara Cheong'],  session: 'SAT' },
  { week: 'Jun W2',  date: '15 Jun (Sun)', team: ['Clarice Yuen', 'Jia Yu'],      session: 'SUN' },
  { week: 'Jun W3',  date: '21 Jun (Sat)', team: ['Boone-Wy', 'Candice Au'],      session: 'SAT' },
  { week: 'Jun W3',  date: '22 Jun (Sun)', team: ['Jace Ong', 'Kai Jie'],         session: 'SUN' },
  { week: 'Jun W4',  date: '28 Jun (Sat)', team: ['Pamela Tan', 'Clara Cheong'],  session: 'SAT' },
  { week: 'Jun W4',  date: '29 Jun (Sun)', team: ['Clarice Yuen', 'Jia Yu'],      session: 'SUN' },
  // July 2026
  { week: 'Jul W1',  date: '5 Jul (Sat)',  team: ['Clara Cheong', 'Matthew'],     session: 'SAT' },
  { week: 'Jul W1',  date: '6 Jul (Sun)',  team: ['Brendon', 'Kai Jie'],          session: 'SUN' },
  { week: 'Jul W2',  date: '12 Jul (Sat)', team: ['Jia Yu', 'Pamela Tan'],        session: 'SAT' },
  { week: 'Jul W2',  date: '13 Jul (Sun)', team: ['Clarice Yuen', 'Jace Ong'],    session: 'SUN' },
];

// Full ministry roster placeholder — to be populated per team
const ministryRoster = {
  w2r: w2rRoster,
  energy: [],    // populate when energy team roster is known
  comms: [],     // populate when comms team roster is known
};

router.get('/w2r',       (req, res) => res.json(w2rRoster));
router.get('/ministry',  (req, res) => res.json(ministryRoster));
router.get('/upcoming',  (req, res) => {
  const today = new Date();
  // Return next 4 W2R slots as "upcoming"
  res.json(w2rRoster.slice(0, 4));
});

module.exports = router;
