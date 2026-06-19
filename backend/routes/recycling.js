const express = require('express');
const router = express.Router();
const { cardboardData, plasticData, buildSummary } = require('../data/recycling');

router.get('/summary', (req, res) => {
  res.json({
    cardboard: buildSummary(cardboardData),
    plastic:   buildSummary(plasticData),
  });
});

router.get('/cardboard', (req, res) => res.json(cardboardData));
router.get('/plastic',   (req, res) => res.json(plasticData));

module.exports = router;
