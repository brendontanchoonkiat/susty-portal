'use strict';
const validator = require('validator');

const MAX_NAME_LEN   = 60;
const MAX_DATE_LEN   = 40;
const MAX_REASON_LEN = 300;
const MAX_THEME_LEN  = 200;
const MAX_NOTES_LEN  = 500;
const MAX_OWNER_LEN  = 60;

function sanitise(str) {
  if (typeof str !== 'string') return '';
  return validator.stripLow(validator.escape(str.trim()));
}

function validateSwapRequest(req, res, next) {
  const { requesterName, requesterDate, reason } = req.body;
  if (!requesterName || typeof requesterName !== 'string')
    return res.status(400).json({ error: 'requesterName is required' });
  if (!requesterDate || typeof requesterDate !== 'string')
    return res.status(400).json({ error: 'requesterDate is required' });
  if (requesterName.trim().length > MAX_NAME_LEN)
    return res.status(400).json({ error: 'Name too long' });
  if (requesterDate.trim().length > MAX_DATE_LEN)
    return res.status(400).json({ error: 'Date too long' });
  if (reason && reason.length > MAX_REASON_LEN)
    return res.status(400).json({ error: 'Reason too long' });
  req.body.requesterName = sanitise(requesterName);
  req.body.requesterDate = sanitise(requesterDate);
  req.body.reason        = reason ? sanitise(reason) : '';
  next();
}

function validateSwapMatch(req, res, next) {
  const { volunteerName, volunteerDate } = req.body;
  if (!volunteerName || typeof volunteerName !== 'string')
    return res.status(400).json({ error: 'volunteerName is required' });
  if (!volunteerDate || typeof volunteerDate !== 'string')
    return res.status(400).json({ error: 'volunteerDate is required' });
  if (volunteerName.trim().length > MAX_NAME_LEN)
    return res.status(400).json({ error: 'Name too long' });
  if (volunteerDate.trim().length > MAX_DATE_LEN)
    return res.status(400).json({ error: 'Date too long' });
  req.body.volunteerName = sanitise(volunteerName);
  req.body.volunteerDate = sanitise(volunteerDate);
  next();
}

function validateEnergyUpdate(req, res, next) {
  const { month, kwh } = req.body;
  if (!month || typeof month !== 'string')
    return res.status(400).json({ error: 'month is required' });
  if (kwh === undefined || typeof kwh !== 'number' || kwh < 0 || kwh > 1_000_000)
    return res.status(400).json({ error: 'kwh must be a positive number under 1,000,000' });
  if (!/^[A-Za-z]{3} \d{4}$/.test(month.trim()))
    return res.status(400).json({ error: 'month format must be Mon YYYY e.g. Jan 2026' });
  req.body.month = sanitise(month);
  next();
}

function validateSwapId(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: 'Invalid ID' });
  next();
}

// Validates a comms POST (new entry) — requires theme; owner/notes/date optional
function validateCommsPost(req, res, next) {
  const { theme, owner, notes, date } = req.body;
  if (!theme || typeof theme !== 'string' || !theme.trim())
    return res.status(400).json({ error: 'theme is required' });
  if (theme.length > MAX_THEME_LEN)
    return res.status(400).json({ error: `theme must be under ${MAX_THEME_LEN} chars` });
  if (owner !== undefined && (typeof owner !== 'string' || owner.length > MAX_OWNER_LEN))
    return res.status(400).json({ error: `owner must be a string under ${MAX_OWNER_LEN} chars` });
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES_LEN))
    return res.status(400).json({ error: `notes must be a string under ${MAX_NOTES_LEN} chars` });
  if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())))
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  req.body.theme = sanitise(theme);
  if (owner !== undefined) req.body.owner = sanitise(owner);
  if (notes !== undefined) req.body.notes = sanitise(notes);
  if (date  !== undefined) req.body.date  = date.trim();
  next();
}

// Validates a comms PATCH (status update + optional field edits)
function validateCommsPatch(req, res, next) {
  const { theme, owner, notes, date } = req.body;
  if (theme !== undefined) {
    if (typeof theme !== 'string' || !theme.trim() || theme.length > MAX_THEME_LEN)
      return res.status(400).json({ error: `theme must be a non-empty string under ${MAX_THEME_LEN} chars` });
    req.body.theme = sanitise(theme);
  }
  if (owner !== undefined) {
    if (typeof owner !== 'string' || owner.length > MAX_OWNER_LEN)
      return res.status(400).json({ error: `owner must be a string under ${MAX_OWNER_LEN} chars` });
    req.body.owner = sanitise(owner);
  }
  if (notes !== undefined) {
    if (typeof notes !== 'string' || notes.length > MAX_NOTES_LEN)
      return res.status(400).json({ error: `notes must be a string under ${MAX_NOTES_LEN} chars` });
    req.body.notes = sanitise(notes);
  }
  if (date !== undefined) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    req.body.date = date.trim();
  }
  next();
}

module.exports = { validateSwapRequest, validateSwapMatch, validateEnergyUpdate, validateSwapId, validateCommsPost, validateCommsPatch, sanitise };
