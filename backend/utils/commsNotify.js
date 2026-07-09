'use strict';
// ─── Comms Post Notifications ───────────────────────────────────────────────
// Shared by routes/comms.js (portal-triggered: tag/submit) and bot/index.js
// (bot-triggered: approve/request-changes/mark posted). Lazy-requires the bot
// instance so this module can be safely required from either side without
// creating a load-order/circular-require problem (same pattern as
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

// Who a post's content notifications go to — the tagged assignee(s) if any
// were set, otherwise fall back to whoever created/owns it (older posts,
// or posts nobody explicitly tagged).
function recipientNames(post) {
  if (Array.isArray(post.assignees) && post.assignees.length) return post.assignees;
  const fallback = post.created_by || post.owner;
  return fallback ? [fallback] : [];
}

function fmtDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

async function dmNames(names, msg, opts = {}) {
  const bot = getBot();
  if (!bot) return;
  for (const name of names) {
    const id = await getTelegramIdForName(name);
    if (!id) continue;
    try { await bot.api.sendMessage(id, msg, { parse_mode: 'HTML', ...opts }); }
    catch (err) { console.warn(`[CommsNotify] DM to ${name} failed:`, err.message); }
    await new Promise(r => setTimeout(r, 200));
  }
}

// Called right after a TL tags one or more members on a post (create or
// edit) — lets them know something's waiting on them in the portal.
async function notifyAssigneesTagged(post) {
  if (!Array.isArray(post.assignees) || !post.assignees.length) return;
  const msg =
    `📌 <b>You've been tagged on a comms post</b>\n\n` +
    `📅 <b>${fmtDate(post.date)}</b>\n📝 <b>${post.theme}</b>\n\n` +
    `Fill in the caption, notes and image in the portal Comms tab, then tap Submit for Review when it's ready.`;
  await dmNames(post.assignees, msg);
}

// Called right after a member taps "Submit for Review" in the portal —
// DMs every TL a preview (image if present) with Approve/Request Changes buttons.
async function notifyTLsSubmitted(post) {
  const bot = getBot();
  if (!bot) { console.warn('[CommsNotify] Bot not available, skipping TL notify'); return; }
  const { InlineKeyboard } = require('grammy');
  const kb = new InlineKeyboard()
    .text('✅ Approve', `comms:approve:${post.id}`)
    .text('💬 Request Changes', `comms:requestchanges:${post.id}`);

  const assignees = Array.isArray(post.assignees) && post.assignees.length ? post.assignees.join(', ') : null;
  const caption =
    `📢 <b>New post ready for review</b>\n\n` +
    `📅 <b>${fmtDate(post.date)}</b>\n` +
    `📝 <b>${post.theme}</b>\n` +
    (post.caption ? `\n"${post.caption}"\n` : '') +
    (post.details ? `\n🗒 ${post.details}\n` : '') +
    `\n👤 Tagged: ${assignees || post.created_by || post.owner || 'Unknown'}`;

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

async function notifyAssigneesApproved(post) {
  const msg = `✅ <b>Post approved!</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${post.theme}\n\nA TL will post it — you'll see it move to "posted" once it's live.`;
  await dmNames(recipientNames(post), msg);
}

// Comment-loop feedback — post stays linked (status: needs_changes), not a
// hard reject. Member edits in the portal and taps Submit for Review again.
async function notifyAssigneesChangesRequested(post, comment) {
  const msg =
    `💬 <b>Changes requested on your post</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${post.theme}\n\n` +
    (comment ? `"${comment}"\n\n` : '') +
    `Update it in the portal Comms tab, then tap Submit for Review again — no need to start over.`;
  await dmNames(recipientNames(post), msg);
}

module.exports = {
  TL_NAMES, getTLTelegramIds, getTelegramIdForName, recipientNames,
  notifyAssigneesTagged, notifyTLsSubmitted, notifyAssigneesApproved, notifyAssigneesChangesRequested,
  fmtDate,
};
