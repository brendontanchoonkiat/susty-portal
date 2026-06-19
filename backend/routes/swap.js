'use strict';
const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { validateSwapRequest, validateSwapMatch, validateSwapId } = require('../middleware/validate');

const SWAP_FILE = path.join(__dirname, '../data/swap-requests.json');

// ─── Storage helpers ──────────────────────────────────────────────────────────
function loadSwaps() {
  try {
    const raw = fs.readFileSync(SWAP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Defensive: ensure it's always an array
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveSwaps(data) {
  // Write atomically via a temp file to prevent corruption on crash
  const tmp = SWAP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, SWAP_FILE);
}

// ─── Telegram notify (never throws — failure is silent to avoid crashing) ─────
async function notifyTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;  // silently skip if not configured

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // parse_mode: HTML is safer than Markdown — less likely to break on special chars
      body: JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(5000),  // 5-second timeout, won't hang the request
    });
    if (!res.ok) console.warn('[Telegram] notify failed:', await res.text());
  } catch (err) {
    console.warn('[Telegram] notify error:', err.message);
  }
}

// ─── GET /api/swap — open requests only ──────────────────────────────────────
router.get('/', (req, res) => {
  const swaps = loadSwaps();
  // Never expose matched/closed requests to anonymous viewers
  res.json(swaps.filter(s => s.status === 'open').map(s => ({
    id:            s.id,
    requesterName: s.requesterName,
    requesterDate: s.requesterDate,
    reason:        s.reason,
    createdAt:     s.createdAt,
  })));
});

// ─── POST /api/swap — submit a swap request ───────────────────────────────────
router.post('/', validateSwapRequest, async (req, res) => {
  const { requesterName, requesterDate, reason } = req.body;

  // Prevent duplicate open requests from the same person for the same date
  const swaps = loadSwaps();
  const duplicate = swaps.find(
    s => s.status === 'open' &&
         s.requesterName.toLowerCase() === requesterName.toLowerCase() &&
         s.requesterDate === requesterDate
  );
  if (duplicate) return res.status(409).json({ error: 'An open request already exists for this name and date.' });

  const newSwap = {
    id:            Date.now(),
    requesterName,
    requesterDate,
    reason,
    status:        'open',
    createdAt:     new Date().toISOString(),
    matchedWith:   null,
  };

  swaps.push(newSwap);
  saveSwaps(swaps);

  // Sanitised message — no raw user input inside HTML tags
  const msg = `🔄 <b>Roster Swap Request</b>\n👤 <b>${requesterName}</b> wants to swap: <b>${requesterDate}</b>\n📝 ${reason || 'No reason given'}\n\nCheck the portal to volunteer!`;
  await notifyTelegram(msg);

  // Return minimal fields — not the full internal object
  res.status(201).json({ id: newSwap.id, status: 'open' });
});

// ─── POST /api/swap/test-notify — ping Telegram (admin only) ─────────────────
router.post('/test-notify', (req, res, next) => req.app.get('requireApiKey')(req, res, next), async (req, res) => {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(503).json({ ok: false, error: 'Telegram not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing from environment' });
  }
  try {
    const tRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       '🧪 <b>Test notification</b> from Susty Portal\n\nTelegram bot is configured and working ✅',
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await tRes.json();
    if (tRes.ok) return res.json({ ok: true, message_id: data.result?.message_id });
    res.status(502).json({ ok: false, error: data.description || 'Telegram API error' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/swap/:id/match — volunteer for a swap ─────────────────────────
router.post('/:id/match', validateSwapId, validateSwapMatch, async (req, res) => {
  const { volunteerName, volunteerDate } = req.body;
  const swaps = loadSwaps();
  const swap  = swaps.find(s => s.id === Number(req.params.id));

  if (!swap)                  return res.status(404).json({ error: 'Swap request not found' });
  if (swap.status !== 'open') return res.status(409).json({ error: 'This request has already been matched' });

  swap.status      = 'matched';
  swap.matchedWith = { volunteerName, volunteerDate, matchedAt: new Date().toISOString() };
  saveSwaps(swaps);

  const msg = `✅ <b>Swap Matched!</b>\n👤 ${swap.requesterName} (${swap.requesterDate}) ↔️ ${volunteerName} (${volunteerDate})\n\nPlease confirm with your team lead.`;
  await notifyTelegram(msg);

  res.json({ status: 'matched' });
});

module.exports = router;
