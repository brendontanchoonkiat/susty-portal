'use strict';
// ─── Comms Post Notifications ───────────────────────────────────────────────
// Shared by routes/comms.js (portal-triggered: tag/submit) and bot/index.js
// (bot-triggered: approve/request-changes/mark posted). Lazy-requires the bot
// instance so this module can be safely required from either side without
// creating a load-order/circular-require problem (same pattern as
// routes/recycling.js's bustCache() being lazy-required from bot/index.js).

const db = require('./supabase');

// Comms has its own, smaller cast than the full W2R roster — deliberately
// separate from bot/index.js's ministry-wide TL_NAMES (Brendon/Judy/Wee
// Shing), which is roster/duty-only. Wee Shing is not involved in comms and
// deliberately excluded from both lists below. Configurable via env vars
// (comma-separated) without a redeploy.
//
// Two different lists on purpose (split 9 Jul 2026 per Brendon):
// - COMMS_TL_NAMES: who has TL-level ACCESS in the bot (approve/request
//   changes/post/delete, and can browse Pending Approvals / Ready to Post).
//   Includes Brendon — he stays admin/overseer across everything and wants
//   to be able to check in and act if needed, he just doesn't want to be
//   pushed a DM for every event.
// - COMMS_NOTIFY_NAMES: who actually gets proactively DMed (new submission,
//   delete request, daily digest, etc.) — Judy only. Brendon can still see
//   everything by opening the bot's 📢 Comms menu himself (pull, not push).
const COMMS_TL_NAMES = (process.env.COMMS_TL_NAMES || 'Judy,Brendon').split(',').map(n => n.trim());
const COMMS_NOTIFY_NAMES = (process.env.COMMS_NOTIFY_NAMES || 'Judy').split(',').map(n => n.trim());
const COMMS_MEMBER_NAMES = (process.env.COMMS_MEMBER_NAMES || 'Alan,Esther,Elaine,Matthew,Berry,Brendon').split(',').map(n => n.trim());

// Public portal URL — included in DMs to assignees so they can jump straight
// to the Comms tab to make edits. Same origin the frontend/API are served
// from (server.js serves the static frontend and /api from one Express app).
const PORTAL_URL = process.env.PORTAL_URL || 'https://susty-portal-production.up.railway.app';

// The external Telegram channel finished posts actually get published to
// (added 9 Jul 2026). Not set until Brendon adds the bot as an admin to that
// channel and provides its chat ID — every call site checks for this and
// falls back to the old "TL posts manually, just confirms" behavior when
// it's missing, so nothing breaks before that setup is done.
// COMMS_CHANNEL_USERNAME is optional (public channels only, no leading @) —
// used only to build a t.me link back to the published post in confirmations.
const COMMS_CHANNEL_ID = process.env.COMMS_CHANNEL_ID || null;
const COMMS_CHANNEL_USERNAME = process.env.COMMS_CHANNEL_USERNAME || null;

function getBot() {
  try { return require('../bot/index').bot; } catch { return null; }
}

// Notification recipients (push) — currently just Judy. Separate from
// isCommsTL() in bot/index.js, which gates who can SEE/ACT on comms TL
// screens (Judy + Brendon).
async function getTLTelegramIds() {
  const supa = db.getClient();
  if (!supa) return [];
  const ids = [];
  for (const name of COMMS_NOTIFY_NAMES) {
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

// Telegram's HTML parse_mode treats <, >, & as markup — user-supplied fields
// (theme/caption/details/comment/names) go straight into these messages, so
// an unescaped value could inject a fake link/tag or (at minimum) break
// delivery with a 400 from Telegram. Escape before interpolating into any
// parse_mode: 'HTML' string built in this file. (Portal-side XSS is handled
// separately by the frontend's own esc() helper — this is the Telegram
// message side of the same class of bug.)
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Deep link straight to a post's editor (comms tab, correct tile already
// opened) instead of just the portal homepage — the frontend's restoreTab()
// reads #comms-<id> and calls openCommsEditor(id) once data has loaded.
// Added 9 Jul 2026 per Brendon: assignees/edit-request DMs previously just
// linked to PORTAL_URL, leaving the member to hunt for the right tile among
// several identically-coloured ones (also fixed separately) — easy to give up
// and assume the post/photo/caption was gone when it was just hard to find.
function postLink(post) {
  return `${PORTAL_URL}/#comms-${post.id}`;
}

function fmtDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

// Returns a post's image URLs as an array, whichever column populated it —
// image_urls (new, multi-photo, added 9 Jul 2026) or the legacy single
// image_url (older posts / anything that only ever set the old column).
function postImageUrls(post) {
  if (Array.isArray(post.image_urls) && post.image_urls.length) return post.image_urls;
  return post.image_url ? [post.image_url] : [];
}

// Sends a post's photo(s) + caption to a chat, with an optional inline
// keyboard. Handles all three cases Telegram treats differently:
//  - 0 images  → plain text message (caption + keyboard)
//  - 1 image   → sendPhoto (caption + keyboard both supported directly)
//  - 2+ images → sendMediaGroup (caption goes on the first photo, but
//    Telegram does NOT support reply_markup on media groups at all) —
//    followed by a small separate message carrying the keyboard, if one
//    was requested, so Approve/Request Changes etc. still work.
// Added 9 Jul 2026 for multi-photo comms posts (per Esther's feedback that
// most posts use 1-2 photos, occasionally more).
async function sendPostPreview(bot, chatId, post, { caption = '', replyMarkup } = {}) {
  const images = postImageUrls(post);
  if (images.length >= 2) {
    const { InputMediaBuilder } = require('grammy');
    const media = images.map((url, i) =>
      i === 0 ? InputMediaBuilder.photo(url, { caption, parse_mode: 'HTML' }) : InputMediaBuilder.photo(url)
    );
    await bot.api.sendMediaGroup(chatId, media);
    if (replyMarkup) await bot.api.sendMessage(chatId, '⬆️ Actions for the post above:', { reply_markup: replyMarkup });
    return;
  }
  if (images.length === 1) {
    return bot.api.sendPhoto(chatId, images[0], { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
  }
  return bot.api.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: replyMarkup });
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
    `📅 <b>${fmtDate(post.date)}</b>\n📝 <b>${escHtml(post.theme)}</b>\n\n` +
    `Fill in the caption, notes and image, then tap Submit for Review when it's ready.\n👉 ${postLink(post)}`;
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

  const assignees = Array.isArray(post.assignees) && post.assignees.length ? post.assignees.map(escHtml).join(', ') : null;
  const caption =
    `📢 <b>New post ready for review</b>\n\n` +
    `📅 <b>${fmtDate(post.date)}</b>\n` +
    `📝 <b>${escHtml(post.theme)}</b>\n` +
    (post.caption ? `\n"${escHtml(post.caption)}"\n` : '') +
    (post.details ? `\n🗒 ${escHtml(post.details)}\n` : '') +
    `\n👤 Tagged: ${assignees || escHtml(post.created_by || post.owner) || 'Unknown'}`;

  const tls = await getTLTelegramIds();
  for (const tl of tls) {
    try {
      await sendPostPreview(bot, tl.telegram_id, post, { caption, replyMarkup: kb });
    } catch (err) {
      console.warn(`[CommsNotify] Failed to notify TL ${tl.name}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function notifyAssigneesApproved(post) {
  const msg = `✅ <b>Post approved!</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${escHtml(post.theme)}\n\nA TL will post it — you'll see it move to "posted" once it's live.`;
  await dmNames(recipientNames(post), msg);
}

// Comment-loop feedback — post stays linked (status: needs_changes), not a
// hard reject. Member edits in the portal and taps Submit for Review again.
async function notifyAssigneesChangesRequested(post, comment) {
  const msg =
    `💬 <b>Changes requested on your post</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${escHtml(post.theme)}\n\n` +
    (comment ? `"${escHtml(comment)}"\n\n` : '') +
    `Update it here, then tap Submit for Review again — no need to start over.\n👉 ${postLink(post)}`;
  await dmNames(recipientNames(post), msg);
}

// A member left a comment on a post (added 9 Jul 2026, per Esther's
// feedback — anyone should be able to leave visible feedback, not just the
// TL's private "Request Changes" note). DMs the assignees (whoever's
// actually working on the post) so they see it without having to poll the
// portal; skips DMing the commenter back to themselves.
async function notifyOnNewComment(post, authorName, commentText) {
  const names = recipientNames(post).filter(n => n.toLowerCase() !== (authorName || '').toLowerCase());
  if (!names.length) return;
  const msg =
    `💬 <b>New comment on your post</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${escHtml(post.theme)}\n\n` +
    `<b>${escHtml(authorName)}:</b> "${escHtml(commentText)}"\n\n👉 ${postLink(post)}`;
  await dmNames(names, msg);
}

// A member tapped "Request Deletion" in the portal — nothing is removed yet.
// DMs every comms TL with a preview + Confirm Delete / Keep Post buttons.
async function notifyTLsDeleteRequested(post) {
  const bot = getBot();
  if (!bot) { console.warn('[CommsNotify] Bot not available, skipping delete-request notify'); return; }
  const { InlineKeyboard } = require('grammy');
  const kb = new InlineKeyboard()
    .text('🗑 Confirm Delete', `comms:confirmdelete:${post.id}`)
    .text('↩️ Keep Post', `comms:canceldelete:${post.id}`);
  const msg =
    `🗑 <b>Deletion requested</b>\n\n📅 ${fmtDate(post.date)}\n📝 ${escHtml(post.theme)}\n\n` +
    (post.delete_requested_by ? `Requested by: ${escHtml(post.delete_requested_by)}\n\n` : '') +
    `Confirm to permanently delete this post, or keep it as-is.`;
  const tls = await getTLTelegramIds();
  for (const tl of tls) {
    try { await bot.api.sendMessage(tl.telegram_id, msg, { parse_mode: 'HTML', reply_markup: kb }); }
    catch (err) { console.warn(`[CommsNotify] Delete-request notify to ${tl.name} failed:`, err.message); }
    await new Promise(r => setTimeout(r, 200));
  }
}

// Publishes a post's image+caption straight to the external Telegram channel
// (COMMS_CHANNEL_ID). Returns { ok, skipped, error, link }:
// - skipped: true when no channel is configured yet — callers should fall
//   back to the old manual-post behavior rather than treating this as failure.
// - ok: false + error: something went wrong (bot not an admin there, wrong
//   ID, etc.) — callers should NOT mark the post as posted in this case, so
//   a failed publish never silently shows as "done."
async function publishToCommsChannel(post) {
  if (!COMMS_CHANNEL_ID) return { ok: false, skipped: true };
  const bot = getBot();
  if (!bot) return { ok: false, error: 'Bot not available' };

  const caption = post.caption || post.theme || '';
  try {
    const images = postImageUrls(post);
    let sent;
    if (images.length >= 2) {
      const { InputMediaBuilder } = require('grammy');
      const media = images.map((url, i) => i === 0 ? InputMediaBuilder.photo(url, caption ? { caption } : {}) : InputMediaBuilder.photo(url));
      const sentGroup = await bot.api.sendMediaGroup(COMMS_CHANNEL_ID, media);
      sent = sentGroup?.[0];
    } else if (images.length === 1) {
      sent = await bot.api.sendPhoto(COMMS_CHANNEL_ID, images[0], caption ? { caption } : {});
    } else {
      sent = await bot.api.sendMessage(COMMS_CHANNEL_ID, caption || post.theme);
    }
    const link = (COMMS_CHANNEL_USERNAME && sent?.message_id)
      ? `https://t.me/${COMMS_CHANNEL_USERNAME}/${sent.message_id}` : null;
    return { ok: true, link };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  COMMS_TL_NAMES, COMMS_NOTIFY_NAMES, COMMS_MEMBER_NAMES, PORTAL_URL, COMMS_CHANNEL_ID,
  getTLTelegramIds, getTelegramIdForName, recipientNames,
  notifyAssigneesTagged, notifyTLsSubmitted, notifyAssigneesApproved, notifyAssigneesChangesRequested,
  notifyTLsDeleteRequested, publishToCommsChannel, notifyOnNewComment,
  fmtDate, escHtml, postLink, postImageUrls, sendPostPreview,
};
