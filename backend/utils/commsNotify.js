'use strict';
// ─── Comms Post Notifications ───────────────────────────────────────────────
// Shared by routes/comms.js (portal-triggered: submit for review) and
// bot/index.js (bot-triggered: approve/reject/mark posted). Lazy-requires the
// bot instance so this module can be safely required from either side
// without creating a load-order/circular-require problem (same pattern as
// routes/recycling.js's bustCache() being lazy-required from bot/index.js).

const db = require('./supabase');

const TL_NAMES = (process.env.TL_NAMES || 'Brendon,Judy,Wee Shing').split(',').map(n => n.trim());

function getBot() {
  try { return require('../bot/index').bot; } catch { return null; }
}

async function getTLTelegramIds() {
  const supa = db.getClient();
  if (!supa) return [];
  const ids = [];
  for (const name of TL_NAMES) {
    const { data } = await supa.from('members').select('telegram_id').ilike('name', name).single();
    if (data?.telegram_id) ids.push({ name, telegram_id: data.telegram_id });
  }
  return ids;
}

async function getTelegramIdForName(name) {
  const supa = db.getClient();
  if (!supa || !name) return null;
  const { data } = await supa.from('members').select('telegram_id').ilike('name', name).single();
  return data?.telegram_id || null;
}

function fmtDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

// Called right after a member taps "Submit for Review" in the portal —
// DMs every TL a preview (image if present) with Approve/Reject buttons.
async function notifyTLsSubmitted(post) {
  const bot = getBot();
  if (!bot) { console.warn('[CommsNotify] Bot not available, skipping TL notify'); return; }
  const { InlineKeyboard } = require('grammy');
  const kb = new InlineKeyboard()
    .text('✅ Approve', `comms:approve:${post.id}`)
    .text('✖️ Reject', `comms:reject:${post.id}`);

  const caption =
    `📢 <b>New post ready for review</b>\n\n` +
    `📅 <b>${fmtDate(post.date)}</b>\n` +
    `📝 <b>${post.theme}</b>\n` +
    (post.caption ? `\n"${post.caption}"\n` : '') +
    (post.details ? `\n🗒 ${post.details}\n` : '') +
    `\n👤 Planned by: ${post.created_by || post.owner || 'Unknown'}`;

  const tls = await getTLTelegramIds();
  for (const tl of tls) {
    try {
      if (post.image_url) {
        await bot.api.sendPhoto(tl.telegram_id, post.image_url, { caption, parse_mode: 'HTML', reply_markup: kb });
      } else {
        await bot.api.sendMessage(tl.telegram_id, caption, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err) {
      console.warn(`[CommsNotify] Failed to notify TL ${tl.name}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function notifyOwnerApproved(post) {
  const bot = getBot();
  if (!bot) return;
  const id = await getTelegramIdForName(post.created_by || post.owner);
  if (!id) return;
  const msg = `✅ <b>Post approved!</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${post.theme}\n\nA TL will post it — you'll see it move to "posted" once it's live.`;
  await bot.api.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => {});
}

async function notifyOwnerRejected(post, reason) {
  const bot = getBot();
  if (!bot) return;
  const id = await getTelegramIdForName(post.created_by || post.owner);
  if (!id) return;
  const msg =
    `✖️ <b>Post sent back for changes</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${post.theme}\n\n` +
    (reason ? `💬 Feedback: ${reason}\n\n` : '') +
    `Update it in the portal Comms tab, then submit for review again.`;
  await bot.api.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => {});
}

module.exports = {
  TL_NAMES, getTLTelegramIds, getTelegramIdForName,
  notifyTLsSubmitted, notifyOwnerApproved, notifyOwnerRejected, fmtDate,
};
