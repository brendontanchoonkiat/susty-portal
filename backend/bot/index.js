'use strict';
// ─── Susty Ministry Telegram Bot ─────────────────────────────────────────────
// Button-driven UX. Three main menus:
//   📋 Roster       → My Roster, Next Duty, Full Roster, Swaps, Request Swap
//   🪣 Duty Needs   → Log Cardboard, Log Plastic (+ photo + caption)
//   📊 Stats        → Team Stats, Year on Year, My Stats
// ─────────────────────────────────────────────────────────────────────────────

const {
  Bot, InlineKeyboard, webhookCallback, session,
} = (() => {
  try { return require('grammy'); }
  catch { throw new Error('grammy not installed — run: npm install grammy'); }
})();

const db     = require('../utils/supabase');
const carbon = require('../utils/carbon');

function getFallbackRoster() {
  try { return require('../data/roster.json'); } catch { return []; }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.warn('[Bot] TELEGRAM_BOT_TOKEN not set — bot will not start');
  module.exports = { start: () => {}, webhookHandler: null };
  return;
}

const bot = new Bot(BOT_TOKEN);

// ─── Session ──────────────────────────────────────────────────────────────────
bot.use(session({
  initial: () => ({
    awaitingName:       false,
    awaitingLogKg:      null,   // { type } — waiting for weight input
    awaitingLogPhoto:   null,   // { type, kg } — waiting for photo after weight
    awaitingSwapDate:   false,
    pendingSwapDate:    null,
    awaitingSwapReason: false,
    awaitingAcceptDate:    null,   // { swapId, requesterName, requesterDate }
    cachedName:            null,
    pendingDeeplink:       null,   // deep-link payload to handle after registration
    // Name confirmation (fuzzy match)
    awaitingNameConfirm:   false,  // showing candidate name options to user
    pendingNameCandidates: [],     // roster names to show as options
    pendingTypedName:      null,   // what the user originally typed
    // Availability collation
    availMonth:            null,   // month being collected e.g. "Aug 2026"
    availDates:            [],     // roster dates for that month
    availSelected:         [],     // dates member marked available
    // Unavailability reasons
    unavailReasons:        {},     // { date: reason }
    awaitingUnavailReason: null,   // date string currently waiting for reason text
    // Admin flows
    awaitingCollectMonth:  false,  // TL: waiting for month input for /collect
    awaitingEditAvailName: false,  // TL: waiting for member name to clear availability
  }),
}));

// ─── Group → PM redirect ──────────────────────────────────────────────────────
const GROUP_TYPES = ['group', 'supergroup'];
const BOT_USERNAME_PROMISE = bot.api.getMe().then(me => me.username).catch(() => null);

bot.use(async (ctx, next) => {
  if (!GROUP_TYPES.includes(ctx.chat?.type)) return next();
  const text    = ctx.message?.text || '';
  const isPhoto = !!ctx.message?.photo;
  if (text.startsWith('/start')) return next();
  if (text.startsWith('/') || isPhoto) {
    const username = await BOT_USERNAME_PROMISE;
    const link = username ? `https://t.me/${username}` : 'the bot directly';
    await ctx.reply(
      `👋 To keep the group tidy, please message me directly!\n\n📲 <a href="${link}">Open PM</a>`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
    return;
  }
  return next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function resolveName(ctx) {
  if (ctx.session?.cachedName) return ctx.session.cachedName;
  try {
    const member = await db.getMemberByTelegramId(ctx.from.id);
    if (member?.name) {
      if (ctx.session) ctx.session.cachedName = member.name;
      return member.name;
    }
  } catch (err) {
    console.warn('[Bot] resolveName error:', err.message);
  }
  return null;
}

// Resolve typed name → canonical name via member_roster aliases
async function resolveTypedName(typedName) {
  try {
    const result = await db.resolveCanonicalName(typedName);
    return result?.canonical || null;
  } catch { return null; }
}

// Admin check — returns true if user is a TL (in member_roster with known TL status)
// Simple implementation: check if name is in TL_NAMES env var or hardcoded list
const TL_NAMES = (process.env.TL_NAMES || 'Brendon,Judy,Wee Shing')
  .split(',').map(n => n.trim().toLowerCase());
async function isTL(ctx) {
  const name = await resolveName(ctx);
  return name ? TL_NAMES.includes(name.toLowerCase()) : false;
}

function fmtSlot(slot) {
  const team  = (slot.team || []).join(', ') || '—';
  const sess  = slot.session || '';
  const badge = sess === 'GPC' ? '🟣' : sess === 'SAT' ? '🟡' : '🟢';
  return `${badge} <b>${slot.date}</b> (${sess})\n   👥 ${team}`;
}

function fmtDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function today() { return new Date().toISOString().split('T')[0]; }

function promptRegister(ctx) {
  return ctx.reply(
    '👋 You\'re not registered yet! Send /start to set up your account.',
    { parse_mode: 'HTML' }
  );
}

// Generate Sat/Sun dates for a month string like "Aug 2026"
function generateWeekends(monthStr) {
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const parts  = monthStr.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const mIdx = months.findIndex(m => m.startsWith(parts[0].toLowerCase()));
  const year = parseInt(parts[1]);
  if (mIdx < 0 || isNaN(year)) return [];
  const dates = [];
  const d = new Date(year, mIdx, 1);
  while (d.getMonth() === mIdx) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) {
      dates.push({ date: d.toISOString().split('T')[0], session: dow === 6 ? 'SAT' : 'SUN' });
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Returns "August 2026" for the month after today
function nextCalendarMonth() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
}

// Shared logic for accepting a swap — used by deep-link and the accept: callback
async function handleAcceptSwap(ctx, swapId, name) {
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');
  const { data: swap } = await supa.from('swap_requests').select('*').eq('id', swapId).single();
  if (!swap || swap.status !== 'open') {
    return ctx.reply(`⚠️ Swap #${swapId} is no longer available.`, { reply_markup: backToMain() });
  }
  if (swap.requester_name.toLowerCase() === name.toLowerCase()) {
    return ctx.reply(`⚠️ You can't accept your own swap.`, { reply_markup: backToMain() });
  }
  ctx.session.awaitingAcceptDate = {
    swapId, requesterName: swap.requester_name, requesterDate: swap.requester_date,
  };
  return ctx.reply(
    `🔄 Accepting swap for <b>${swap.requester_name}</b>'s duty on <b>${swap.requester_date}</b>.\n\n` +
    `📅 What date are <b>you</b> offering in return? (e.g. <code>5 Jul</code>)`,
    { parse_mode: 'HTML' }
  );
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
const mainMenu = new InlineKeyboard()
  .text('📋 Roster',         'menu:roster').row()
  .text('🪣 Duty Needs',     'menu:duty').row()
  .text('📊 Stats & Impact', 'menu:stats').row()
  .text('📅 My Availability','menu:avail');

const rosterMenu = new InlineKeyboard()
  .text('🗓 My Roster',     'action:myroster').text('⏭ Next Duty',    'action:nextduty').row()
  .text('📋 Full Roster',   'action:roster').row()
  .text('🔄 Open Swaps',    'action:swaps').text('📨 Request Swap', 'action:swap').row()
  .text('← Back',           'menu:main');

const dutyMenu = new InlineKeyboard()
  .text('📦 Log Cardboard', 'action:log:cardboard').row()
  .text('🍶 Log Plastic',   'action:log:plastic').row()
  .text('← Back',           'menu:main');

const statsMenu = new InlineKeyboard()
  .text('🌍 Team Stats',  'action:stats').text('📅 Year on Year', 'action:yoy').row()
  .text('🌿 My Stats',    'action:mystats').row()
  .text('← Back',         'menu:main');

const adminMenu = new InlineKeyboard()
  .text('📅 Collect Availability', 'admin:collect').row()
  .text('📋 Send Roster to Group', 'admin:sendcalendar').row()
  .text('✏️ Edit Member Availability', 'admin:editavail').row()
  .text('👥 View Registered Members', 'admin:members').row()
  .text('← Back', 'menu:main');

function backToMain() {
  return new InlineKeyboard().text('← Back to Menu', 'menu:main');
}

function backToAdmin() {
  return new InlineKeyboard().text('← Back to Admin', 'admin:menu');
}

async function sendMainMenu(ctx, text) {
  return ctx.reply(text || '🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML',
    reply_markup: mainMenu,
  });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const payload  = (ctx.message.text.split(' ')[1] || '').trim();
  const existing = await db.getMemberByTelegramId(ctx.from.id);

  // Deep-link: /start acceptswap_123 — jump straight to acceptance flow
  if (payload.startsWith('acceptswap_')) {
    const swapId = parseInt(payload.replace('acceptswap_', ''));
    if (existing) {
      if (ctx.session) ctx.session.cachedName = existing.name;
      return handleAcceptSwap(ctx, swapId, existing.name);
    }
    // Not registered yet — register first, then resume swap
    ctx.session.awaitingName    = true;
    ctx.session.pendingDeeplink = payload;
    return ctx.reply(
      `👋 Hi! I'm the <b>Susty Ministry Bot</b> 🌿\n\n` +
      `To accept this swap, first tell me your name <b>as it appears on the roster</b>:`,
      { parse_mode: 'HTML' }
    );
  }

  if (existing) {
    if (ctx.session) ctx.session.cachedName = existing.name;
    return sendMainMenu(ctx, `Welcome back, <b>${existing.name}</b>! 🌿\n\nWhat do you need?`);
  }
  ctx.session.awaitingName = true;
  return ctx.reply(
    `👋 Hi! I'm the <b>Susty Ministry Bot</b> 🌿\n\n` +
    `To get started, what's your name <b>as it appears on the roster</b>?\n` +
    `<i>(e.g. "Brendon" or "Wee Shing")</i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── Callback: name confirmation (fuzzy match) ────────────────────────────────
bot.callbackQuery(/^nameconfirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const val        = ctx.match[1];
  const candidates = ctx.session.pendingNameCandidates || [];
  const typedName  = ctx.session.pendingTypedName || '';

  const finalName = val === 'custom'
    ? typedName
    : (candidates[parseInt(val)] || typedName);

  ctx.session.awaitingNameConfirm   = false;
  ctx.session.pendingNameCandidates = [];
  ctx.session.pendingTypedName      = null;
  ctx.session.cachedName            = finalName;

  await db.upsertMember(ctx.from.id, finalName);

  // Resume any pending deep-link (e.g. accept a swap)
  if (ctx.session.pendingDeeplink?.startsWith('acceptswap_')) {
    const swapId = parseInt(ctx.session.pendingDeeplink.replace('acceptswap_', ''));
    ctx.session.pendingDeeplink = null;
    await ctx.editMessageText(`✅ Registered as <b>${finalName}</b>! 🌿`, { parse_mode: 'HTML' }).catch(() => {});
    return handleAcceptSwap(ctx, swapId, finalName);
  }

  return ctx.editMessageText(
    `✅ Got it, <b>${finalName}</b>! You're all set. 🌿\n\nWhat do you need?`,
    { parse_mode: 'HTML', reply_markup: mainMenu }
  ).catch(() => sendMainMenu(ctx, `✅ Got it, <b>${finalName}</b>! You're all set. 🌿\n\nWhat do you need?`));
});

// ─── Callback: main menus ─────────────────────────────────────────────────────
bot.callbackQuery('menu:main', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML', reply_markup: mainMenu,
  }).catch(() => sendMainMenu(ctx));
});

bot.callbackQuery('menu:roster', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    '📋 <b>Roster</b>\n\nView your duties, the full roster, or manage swaps.',
    { parse_mode: 'HTML', reply_markup: rosterMenu }
  );
});

bot.callbackQuery('menu:duty', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    '🪣 <b>Duty Needs</b>\n\nLog your recycling weight for this session.\n\n' +
    '<i>💡 You can also send a photo with caption: <code>cardboard 42.5</code></i>',
    { parse_mode: 'HTML', reply_markup: dutyMenu }
  );
});

bot.callbackQuery('menu:stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    '📊 <b>Stats & Impact</b>\n\nSee how much W2R has recycled and the impact made.',
    { parse_mode: 'HTML', reply_markup: statsMenu }
  );
});

// ─── Callback: roster ─────────────────────────────────────────────────────────
bot.callbackQuery('action:myroster', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);
  if (slots === null) {
    const td = today();
    slots = getFallbackRoster().filter(s =>
      s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase())
    );
  }

  const text = slots.length
    ? `🗓 <b>${name}'s Upcoming Duties</b>\n\n${slots.slice(0, 8).map(fmtSlot).join('\n\n')}`
    : `Hi <b>${name}</b>! No upcoming duties scheduled. 🎉`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() });
});

bot.callbackQuery('action:nextduty', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);
  if (slots === null) {
    const td = today();
    slots = getFallbackRoster().filter(s =>
      s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase())
    );
  }

  if (!slots.length) {
    return ctx.reply(`Hi <b>${name}</b>! No upcoming duties. 🎉`, {
      parse_mode: 'HTML', reply_markup: backToMain(),
    });
  }

  const next     = slots[0];
  const daysLeft = Math.ceil((new Date(next.date) - new Date()) / 86400000);
  const when     = daysLeft === 0 ? 'Today!' : daysLeft === 1 ? 'Tomorrow!' : `in ${daysLeft} days`;

  await ctx.reply(
    `⏭ <b>${name}'s Next Duty</b>\n\n${fmtSlot(next)}\n\n⏳ <b>${when}</b>`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  );
});

bot.callbackQuery('action:roster', async (ctx) => {
  await ctx.answerCallbackQuery();
  let slots = await db.getUpcomingRoster(4);
  if (slots === null) {
    const td    = today();
    const limit = new Date(); limit.setDate(limit.getDate() + 28);
    slots = getFallbackRoster().filter(s =>
      s.date >= td && s.date <= limit.toISOString().split('T')[0]
    );
  }
  const text = slots.length
    ? `📋 <b>W2R Roster — Next 4 Weeks</b>\n\n${slots.map(fmtSlot).join('\n\n')}`
    : 'No roster slots in the next 4 weeks.';
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() });
});

bot.callbackQuery('action:swaps', async (ctx) => {
  await ctx.answerCallbackQuery();
  const supa = db.getClient();
  let swaps  = [];

  if (supa) {
    const { data } = await supa.from('swap_requests')
      .select('*').eq('status', 'open')
      .order('created_at', { ascending: false }).limit(10);
    swaps = data || [];
  }

  if (!swaps.length) {
    return ctx.reply('✅ No open swap requests right now!', { reply_markup: backToMain() });
  }

  const kb = new InlineKeyboard();
  for (const s of swaps) {
    kb.text(`Accept #${s.id} — ${s.requester_name} · ${s.requester_date}`, `accept:${s.id}`).row();
  }
  kb.text('← Back to Menu', 'menu:main');

  const lines = swaps.map(s =>
    `🆔 <b>#${s.id}</b> — <b>${s.requester_name}</b> on <b>${s.requester_date}</b>\n   📝 ${s.reason || 'No reason'}`
  ).join('\n\n');

  await ctx.reply(
    `🔄 <b>Open Swap Requests</b>\n\n${lines}\n\n<i>Tap a button below to accept.</i>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

bot.callbackQuery(/^accept:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  return handleAcceptSwap(ctx, parseInt(ctx.match[1]), name);
});

bot.callbackQuery('action:swap', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  ctx.session.awaitingSwapDate = true;
  await ctx.reply(
    `📨 <b>Request a Swap</b>\n\n📅 Which date do you need to swap? (e.g. <code>28 Jun</code>)`,
    { parse_mode: 'HTML' }
  );
});

// ─── Callback: duty needs ─────────────────────────────────────────────────────
bot.callbackQuery('action:log:cardboard', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingLogKg = { type: 'cardboard' };
  await ctx.reply(
    `📦 <b>Log Cardboard — Step 1 of 2</b>\n\nHow many kg did you collect? (e.g. <code>42.5</code>)`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('action:log:plastic', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingLogKg = { type: 'plastic' };
  await ctx.reply(
    `🍶 <b>Log Plastic — Step 1 of 2</b>\n\nHow many kg did you collect? (e.g. <code>8.2</code>)`,
    { parse_mode: 'HTML' }
  );
});

// ─── Callback: availability ───────────────────────────────────────────────────
bot.callbackQuery('menu:avail', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  // Target the NEXT calendar month (so TL can collect before rostering it)
  const targetMonth = nextCalendarMonth();

  // Check if member already submitted for this month
  const supa = db.getClient();
  if (supa) {
    const { data: existing } = await supa.from('availability')
      .select('id').eq('member_name', name).eq('month', targetMonth).limit(1);
    if (existing?.length) {
      return ctx.reply(
        `📅 You've already submitted availability for <b>${targetMonth}</b>.\n\n` +
        `<i>To make changes, contact your TL.</i>`,
        { parse_mode: 'HTML', reply_markup: backToMain() }
      );
    }
  }

  // Get slots for next month from DB; fall back to generated weekends
  let monthSlots = [];
  if (supa) {
    const { data } = await supa.from('roster_slots')
      .select('date, session').order('date');
    monthSlots = (data || []).filter(s => {
      const label = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
      return label === targetMonth;
    });
  }
  if (!monthSlots.length) monthSlots = generateWeekends(targetMonth);

  if (!monthSlots.length) {
    return ctx.reply(`No dates available for ${targetMonth} yet.`, { reply_markup: backToMain() });
  }

  ctx.session.availMonth    = targetMonth;
  ctx.session.availDates    = monthSlots.map(s => s.date);
  ctx.session.availSelected = [];

  await ctx.editMessageText(
    `📅 <b>Unavailability — ${targetMonth}</b>\n\nTap any date you <b>cannot</b> serve. You'll be asked for a reason.\nLeave dates untouched if you're available.\n\n` +
    `<i>❌ = can't serve  ·  no mark = available</i>`,
    { parse_mode: 'HTML', reply_markup: buildAvailKeyboard(monthSlots, []) }
  );
});

// unavailDates = dates the member CANNOT serve (shown with ❌)
// Unmarked dates = available
function buildAvailKeyboard(slots, unavailDates) {
  const kb = new InlineKeyboard();
  for (const s of slots) {
    const isUnavail = unavailDates.includes(s.date);
    const prefix    = isUnavail ? '❌ ' : '';
    const sess      = s.session === 'GPC' ? '🟣' : s.session === 'SAT' ? '🟡' : '🟢';
    kb.text(`${prefix}${sess} ${s.date} (${s.session})`, `avail:toggle:${s.date}`).row();
  }
  kb.text('✅ Done — Submit', 'avail:submit').text('← Cancel', 'avail:cancel');
  return kb;
}

bot.callbackQuery(/^avail:toggle:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date    = ctx.match[1];
  const unavail = ctx.session.availSelected || [];

  const isNowUnavail = !unavail.includes(date);
  if (isNowUnavail) {
    ctx.session.availSelected = [...unavail, date];
  } else {
    ctx.session.availSelected = unavail.filter(d => d !== date);
    if (ctx.session.unavailReasons) delete ctx.session.unavailReasons[date];
  }

  // Recover availDates from the keyboard if session was lost (e.g. after bot restart)
  if (!ctx.session.availDates?.length) {
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard || [];
    ctx.session.availDates = rows
      .flat()
      .filter(b => b.callback_data?.startsWith('avail:toggle:'))
      .map(b => b.callback_data.replace('avail:toggle:', ''));
  }

  // Rebuild slots list for keyboard
  const supa = db.getClient();
  let slots   = [];
  if (supa && ctx.session.availDates?.length) {
    const { data } = await supa.from('roster_slots')
      .select('date,session').in('date', ctx.session.availDates).order('date');
    slots = data || [];
  }
  if (!slots.length) {
    slots = (ctx.session.availDates || []).map(d => ({ date: d, session: '?' }));
  }

  await ctx.editMessageReplyMarkup({
    reply_markup: buildAvailKeyboard(slots, ctx.session.availSelected),
  }).catch(() => {});

  // If just marked unavailable, ask for reason
  if (isNowUnavail) {
    ctx.session.awaitingUnavailReason = date;
    await ctx.reply(
      `📝 Why can't you make it on <b>${fmtDate(date)}</b>?\n\n<i>Type your reason below, or tap Skip.</i>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('Skip', 'avail:skipreason') }
    );
  }
});

bot.callbackQuery('avail:skipreason', async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.session.awaitingUnavailReason;
  if (date) {
    if (!ctx.session.unavailReasons) ctx.session.unavailReasons = {};
    ctx.session.unavailReasons[date] = '';
    ctx.session.awaitingUnavailReason = null;
  }
  await ctx.editMessageText(
    `❌ <b>${fmtDate(date)}</b> marked as unavailable.\n\n<i>Tap more dates above, or Submit when done.</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.callbackQuery('avail:submit', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name    = await resolveName(ctx);
  const month   = ctx.session.availMonth;
  const unavail = ctx.session.availSelected || [];
  const allD    = ctx.session.availDates    || [];
  const avail   = allD.filter(d => !unavail.includes(d));
  const reasons = ctx.session.unavailReasons || {};

  if (!month) return ctx.reply('⚠️ Session expired. Please try again.', { reply_markup: backToMain() });

  const notes = Object.keys(reasons).length ? JSON.stringify({ reasons }) : '';
  await db.saveAvailability(month, name, avail, unavail, notes);

  ctx.session.availMonth            = null;
  ctx.session.availDates            = [];
  ctx.session.availSelected         = [];
  ctx.session.unavailReasons        = {};
  ctx.session.awaitingUnavailReason = null;

  const lines = unavail.length
    ? unavail.map(d => {
        const r = reasons[d];
        return `❌ ${d}${r ? ` — <i>${r}</i>` : ''}`;
      }).join('\n')
    : '✅ All clear — you\'re available for every date!';

  const msg =
    `✅ <b>Submitted for ${month}!</b>\n\n${lines}\n\n` +
    `<i>Your TL will see this when planning the roster.</i>`;

  await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: backToMain() })
    .catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: backToMain() }));
});

bot.callbackQuery('avail:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.availMonth    = null;
  ctx.session.availDates    = [];
  ctx.session.availSelected = [];
  await ctx.editMessageText('🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML', reply_markup: mainMenu,
  }).catch(() => sendMainMenu(ctx));
});


// ─── /collect command (TL only) — broadcast availability request to all members
bot.command('collect', async (ctx) => {
  if (!(await isTL(ctx))) {
    return ctx.reply('⚠️ This command is for Team Leaders only.');
  }
  const args = ctx.message.text.replace('/collect', '').trim(); // e.g. "Aug 2026"
  if (!args) {
    return ctx.reply('Usage: <code>/collect Aug 2026</code>', { parse_mode: 'HTML' });
  }

  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  // Get roster slots for that month from DB
  const { data: allSlots } = await supa.from('roster_slots')
    .select('date, session').order('date');

  let monthSlots = (allSlots || []).filter(s => {
    const label = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
    return label.toLowerCase() === args.toLowerCase();
  });

  // If the month hasn't been created yet, generate Sat/Sun dates as placeholders
  let generatedFallback = false;
  if (!monthSlots.length) {
    monthSlots = generateWeekends(args);
    if (!monthSlots.length) {
      return ctx.reply(`⚠️ Could not parse "${args}". Use format: <code>Aug 2026</code>`, { parse_mode: 'HTML' });
    }
    generatedFallback = true;
  }

  // Get all registered members
  const members = await db.getAllRegisteredMembers();
  if (!members.length) return ctx.reply('⚠️ No registered members yet.');

  let sent = 0;
  for (const m of members) {
    try {
      const kb = buildAvailKeyboard(monthSlots, []);
      await bot.api.sendMessage(
        m.telegram_id,
        `📅 <b>Unavailability Check — ${args}</b>\n\nHi <b>${m.name}</b>! Tap any date you <b>cannot</b> serve. You'll be asked for a reason each time.\nLeave dates untouched if you're available.\n\n<i>❌ = can't serve  ·  no mark = available</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      await db.saveAvailability(args, m.name, [], monthSlots.map(s => s.date));
      sent++;
    } catch (err) {
      console.warn(`[Bot] collect: failed to DM ${m.name}:`, err.message);
    }
  }

  const note = generatedFallback
    ? `\n\n<i>⚠️ No roster created for ${args} yet — used generated Sat/Sun dates. Update the portal roster and re-run /collect if needed.</i>`
    : '';

  await ctx.reply(
    `✅ Sent availability request for <b>${args}</b> to <b>${sent}/${members.length}</b> registered members.${note}\n\n` +
    `Use the portal → Members to view responses as they come in.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /admin command + TL menu ────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (!(await isTL(ctx))) {
    return ctx.reply('⚠️ This section is for Team Leaders only.');
  }
  return ctx.reply(
    `🔧 <b>Admin Panel</b>\n\nTL-only actions. What do you need?`,
    { parse_mode: 'HTML', reply_markup: adminMenu }
  );
});

bot.callbackQuery('admin:menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.');
  await ctx.editMessageText(
    `🔧 <b>Admin Panel</b>\n\nTL-only actions. What do you need?`,
    { parse_mode: 'HTML', reply_markup: adminMenu }
  ).catch(() => ctx.reply(
    `🔧 <b>Admin Panel</b>\n\nTL-only actions. What do you need?`,
    { parse_mode: 'HTML', reply_markup: adminMenu }
  ));
});

// Admin: Collect Availability — ask for month
bot.callbackQuery('admin:collect', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingCollectMonth = true;
  await ctx.editMessageText(
    `📅 <b>Collect Availability</b>\n\nWhich month? (e.g. <code>Aug 2026</code>)\n\n` +
    `<i>This will DM all registered members asking for their availability.</i>`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
  );
});

// Admin: Send Roster to Group
bot.callbackQuery('admin:sendcalendar', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!GROUP_ID) {
    return ctx.editMessageText('⚠️ TELEGRAM_CHAT_ID not set.', { reply_markup: backToAdmin() });
  }

  const supa = db.getClient();
  let slots  = [];
  if (supa) {
    const td    = today();
    const limit = new Date(); limit.setMonth(limit.getMonth() + 2);
    const { data } = await supa.from('roster_slots')
      .select('*').gte('date', td)
      .lte('date', limit.toISOString().split('T')[0])
      .order('date');
    slots = data || [];
  }
  if (!slots.length) slots = getFallbackRoster().filter(s => s.date >= today());
  if (!slots.length) {
    return ctx.editMessageText('No upcoming roster slots found.', { reply_markup: backToAdmin() });
  }

  const byMonth = {};
  for (const s of slots) {
    const m = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(s);
  }

  for (const [month, mSlots] of Object.entries(byMonth)) {
    const lines = mSlots.map(s => {
      const badge = s.session === 'GPC' ? '🟣' : s.session === 'SAT' ? '🟡' : '🟢';
      const team  = (s.team || []).join(', ') || '—';
      const note  = s.notes ? `\n   📌 ${s.notes}` : '';
      return `${badge} <b>${s.date}</b> (${s.session})\n   👥 ${team}${note}`;
    }).join('\n\n');
    await bot.api.sendMessage(GROUP_ID, `📋 <b>W2R Roster — ${month}</b>\n\n${lines}`, { parse_mode: 'HTML' })
      .catch(err => console.warn('[sendcalendar] failed:', err.message));
    await new Promise(r => setTimeout(r, 600));
  }

  await ctx.editMessageText(
    `✅ Roster for <b>${Object.keys(byMonth).join(' & ')}</b> posted to group.`,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// Admin: Edit Member Availability — ask for name
bot.callbackQuery('admin:editavail', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingEditAvailName = true;
  await ctx.editMessageText(
    `✏️ <b>Edit Member Availability</b>\n\nEnter the member's name to clear their submission for <b>${nextCalendarMonth()}</b>:\n\n` +
    `<i>They'll be able to re-submit via the bot.</i>`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
  );
});

// Admin: View registered members
bot.callbackQuery('admin:members', async (ctx) => {
  await ctx.answerCallbackQuery();
  const supa = db.getClient();
  if (!supa) {
    return ctx.editMessageText('⚠️ Supabase not configured.', { reply_markup: backToAdmin() });
  }
  const members = await db.getAllRegisteredMembers();
  if (!members.length) {
    return ctx.editMessageText('No registered members yet.', { reply_markup: backToAdmin() });
  }
  const lines = members.map((m, i) => `${i + 1}. <b>${m.name}</b>`).join('\n');
  await ctx.editMessageText(
    `👥 <b>Registered Members (${members.length})</b>\n\n${lines}`,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// ─── Callback: stats ──────────────────────────────────────────────────────────
bot.callbackQuery('action:stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await db.getRecyclingStats();
  let cb = 0, pl = 0, cb26 = 0, pl26 = 0;

  if (rows && rows.length) {
    for (const r of rows) {
      const y = Number(r.year);
      if (y === 2026) { cb26 += Number(r.cardboard_kg); pl26 += Number(r.plastic_kg); }
      cb += Number(r.cardboard_kg); pl += Number(r.plastic_kg);
    }
  } else {
    const { cardboardData, plasticData } = require('../data/recycling');
    cb = cardboardData.reduce((s, r) => s + r.kg, 0);
    pl = plasticData.reduce((s, r) => s + r.kg, 0);
  }

  const total = carbon.calcCO2e(cb, pl);
  const y26   = carbon.calcCO2e(cb26, pl26);

  await ctx.reply(
    `♻️ <b>W2R Ministry Impact</b>\n<i>Sep 2025 – present</i>\n\n` +
    `📊 <b>All-Time</b>\n` +
    `📦 Cardboard: <b>${cb.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${pl.toFixed(1)} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${total.co2eKg} kg</b>\n` +
    `🌳 Trees equiv: <b>${total.treesEquiv}</b>\n` +
    `🚗 Car km saved: <b>${total.carKmEquiv.toLocaleString()}</b>\n` +
    `🧴 Bottles diverted: <b>${total.bottlesEquiv.toLocaleString()}</b>\n\n` +
    `📅 <b>2026 YTD</b>\n` +
    `📦 ${cb26.toFixed(1)} kg  |  🍶 ${pl26.toFixed(1)} kg  |  🌍 ${y26.co2eKg} kg CO₂e`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  );
});

bot.callbackQuery('action:yoy', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = await db.getRecyclingStats();
  let summaries;

  if (rows && rows.length) {
    summaries = carbon.summariseByYear(rows);
  } else {
    const { cardboardData, plasticData } = require('../data/recycling');
    const combined = cardboardData.map((r, i) => ({
      month: r.month, year: parseInt(r.month.slice(-4)),
      cardboard_kg: r.kg, plastic_kg: (plasticData[i] || {}).kg || 0,
    }));
    summaries = carbon.summariseByYear(combined);
  }

  await ctx.reply(carbon.formatYoY(summaries), {
    parse_mode: 'HTML', reply_markup: backToMain(),
  });
});

bot.callbackQuery('action:mystats', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const supa = db.getClient();
  if (!supa) return ctx.reply('📊 Personal stats require Supabase.', { reply_markup: backToMain() });

  const { data: logs }     = await supa.from('data_logs').select('*').eq('logged_by', name);
  const { data: attended } = await supa.from('attendance')
    .select('*, roster_slots(date, session)').eq('member_name', name);

  const myCb    = (logs || []).filter(l => l.type === 'cardboard').reduce((s, l) => s + Number(l.kg), 0);
  const myPl    = (logs || []).filter(l => l.type === 'plastic').reduce((s, l) => s + Number(l.kg), 0);
  const impact  = carbon.calcCO2e(myCb, myPl);
  const sessions = attended?.length || (logs || []).length;

  await ctx.reply(
    `🌿 <b>${name}'s Personal Impact</b>\n\n` +
    `📋 Sessions: <b>${sessions}</b>\n` +
    `📦 Cardboard: <b>${myCb.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${myPl.toFixed(1)} kg</b>\n\n` +
    `🌍 CO₂e saved: <b>${impact.co2eKg} kg</b>\n` +
    `🌳 Trees equiv: <b>${impact.treesEquiv}</b>\n` +
    `🧴 Bottles diverted: <b>${impact.bottlesEquiv.toLocaleString()}</b>\n\n` +
    `<i>Every session counts. Thank you! 💪</i>`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  );
});

// ─── Photo handler ────────────────────────────────────────────────────────────
bot.on('message:photo', async (ctx) => {
  // Step 2 of 2: photo received after weight was entered
  if (ctx.session.awaitingLogPhoto) {
    const { type, kg } = ctx.session.awaitingLogPhoto;
    ctx.session.awaitingLogPhoto = null;

    const name = await resolveName(ctx);
    if (!name) return promptRegister(ctx);

    const photo = ctx.message.photo.at(-1);
    let imageUrl = null;
    try {
      const file    = await bot.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const resp    = await fetch(fileUrl, { signal: AbortSignal.timeout(10000) });
      const buffer  = Buffer.from(await resp.arrayBuffer());
      const fname   = `${today()}_${name.replace(/\s+/g, '_')}_${type}_${Date.now()}.jpg`;
      imageUrl      = await db.uploadImage(buffer, fname, 'image/jpeg');
    } catch (err) {
      console.warn('[Bot] Image upload failed:', err.message);
    }

    return saveLog({ name, type, kg, sessionDate: today(), fileId: photo.file_id, imageUrl, ctx });
  }

  // Photo sent without going through the weight step — prompt them to use the menu
  if (ctx.chat.type === 'private') {
    return ctx.reply(
      '📷 Got a photo! To log a collection, tap <b>Log Duty Data</b> from the menu first so I can record the weight too.',
      { parse_mode: 'HTML' }
    );
  }
});

// ─── Shared log saver ─────────────────────────────────────────────────────────
async function saveLog({ name, type, kg, sessionDate, fileId = null, imageUrl = null, ctx }) {
  await db.insertDataLog({
    session_date: sessionDate, type, kg,
    image_url: imageUrl, file_id: fileId,
    notes: '', logged_by: name,
    created_at: new Date().toISOString(),
  });

  const impact    = carbon.calcCO2e(type === 'cardboard' ? kg : 0, type === 'plastic' ? kg : 0);
  const emoji     = type === 'cardboard' ? '📦' : '🍶';
  const photoLine = imageUrl ? '\n📷 Photo saved.' : fileId ? '\n📷 Photo received.' : '';

  return ctx.reply(
    `${emoji} <b>Logged!</b>\n\n` +
    `${type === 'cardboard' ? '📦 Cardboard' : '🍶 Plastic'}: <b>${kg} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${impact.co2eKg} kg</b>\n` +
    `📅 ${fmtDate(sessionDate)}${photoLine}`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  );
}

// ─── Text handler — multi-step flows ─────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Registration — if user types again while in name-confirm, restart matching
  if (ctx.session.awaitingNameConfirm) {
    ctx.session.awaitingNameConfirm   = false;
    ctx.session.pendingNameCandidates = [];
    ctx.session.pendingTypedName      = null;
    ctx.session.awaitingName          = true;
    // fall through to the awaitingName block below
  }

  // Registration
  if (ctx.session.awaitingName) {
    if (text.length < 2 || text.length > 60) {
      return ctx.reply('Please enter your name as it appears on the roster (2–60 chars).');
    }

    // Step 1 — exact / alias match
    const canonical = await resolveTypedName(text);
    if (canonical) {
      const finalName = canonical;
      ctx.session.awaitingName = false;
      ctx.session.cachedName   = finalName;
      await db.upsertMember(ctx.from.id, finalName);

      const matchNote = canonical.toLowerCase() !== text.trim().toLowerCase()
        ? `\n<i>(Matched to roster name: <b>${canonical}</b>)</i>` : '';

      if (ctx.session.pendingDeeplink?.startsWith('acceptswap_')) {
        const swapId = parseInt(ctx.session.pendingDeeplink.replace('acceptswap_', ''));
        ctx.session.pendingDeeplink = null;
        await ctx.reply(`✅ Got it, <b>${finalName}</b>! 🌿${matchNote}`, { parse_mode: 'HTML' });
        return handleAcceptSwap(ctx, swapId, finalName);
      }
      return sendMainMenu(ctx, `✅ Got it, <b>${finalName}</b>! You're all set. 🌿${matchNote}\n\nWhat do you need?`);
    }

    // Step 2 — no exact match: show full roster list to pick from
    const rosterMembers = await db.getMemberRoster();
    const rosterNames   = rosterMembers.map(m => m.name);

    ctx.session.awaitingName          = false;
    ctx.session.awaitingNameConfirm   = true;
    ctx.session.pendingNameCandidates = rosterNames;
    ctx.session.pendingTypedName      = text.trim();

    const kb = new InlineKeyboard();
    rosterNames.forEach((name, i) => kb.text(name, `nameconfirm:${i}`).row());
    kb.text('None of these — use my typed name', 'nameconfirm:custom');

    return ctx.reply(
      `🤔 I couldn't find "<b>${text}</b>" on the roster.\n\nPlease select your name from the list:`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }

  // Log — step 1: weight received, now ask for photo
  if (ctx.session.awaitingLogKg) {
    const { type } = ctx.session.awaitingLogKg;
    const kg = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(kg) || kg <= 0 || kg > 5000) {
      return ctx.reply(`⚠️ Enter a valid weight in kg, e.g. <code>42.5</code>`, { parse_mode: 'HTML' });
    }
    ctx.session.awaitingLogKg   = null;
    ctx.session.awaitingLogPhoto = { type, kg };
    const emoji = type === 'cardboard' ? '📦' : '🍶';
    return ctx.reply(
      `${emoji} <b>Step 2 of 2 — Photo</b>\n\n` +
      `Got it: <b>${kg} kg</b> of ${type}.\n\nNow send a photo of the haul. 📷`,
      { parse_mode: 'HTML' }
    );
  }

  // Unavailability reason
  if (ctx.session.awaitingUnavailReason) {
    const date = ctx.session.awaitingUnavailReason;
    if (!ctx.session.unavailReasons) ctx.session.unavailReasons = {};
    ctx.session.unavailReasons[date] = text;
    ctx.session.awaitingUnavailReason = null;
    return ctx.reply(
      `❌ <b>${fmtDate(date)}</b> marked as unavailable.\n<i>Reason: ${text}</i>\n\nTap more dates above, or Submit when done.`,
      { parse_mode: 'HTML' }
    );
  }

  // Admin: collect availability month
  if (ctx.session.awaitingCollectMonth) {
    ctx.session.awaitingCollectMonth = false;
    const monthArg = text.trim();

    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');

    const { data: allSlots } = await supa.from('roster_slots').select('date, session').order('date');
    let monthSlots = (allSlots || []).filter(s => {
      const label = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
      return label.toLowerCase() === monthArg.toLowerCase();
    });

    let generatedFallback = false;
    if (!monthSlots.length) {
      monthSlots = generateWeekends(monthArg);
      if (!monthSlots.length) {
        return ctx.reply(`⚠️ Could not parse "${monthArg}". Try: <code>Aug 2026</code>`, {
          parse_mode: 'HTML', reply_markup: backToAdmin(),
        });
      }
      generatedFallback = true;
    }

    const members = await db.getAllRegisteredMembers();
    if (!members.length) return ctx.reply('⚠️ No registered members yet.', { reply_markup: backToAdmin() });

    let sent = 0;
    for (const m of members) {
      try {
        await bot.api.sendMessage(
          m.telegram_id,
          `📅 <b>Availability Check — ${monthArg}</b>\n\nHi <b>${m.name}</b>! Please mark the dates you can serve.\nTap a date to select ✅, tap again to deselect.\n\n<i>Press Submit when done.</i>`,
          { parse_mode: 'HTML', reply_markup: buildAvailKeyboard(monthSlots, []) }
        );
        await db.saveAvailability(monthArg, m.name, [], monthSlots.map(s => s.date));
        sent++;
      } catch (err) {
        console.warn(`[Bot] collect: failed to DM ${m.name}:`, err.message);
      }
    }

    const note = generatedFallback
      ? `\n\n<i>⚠️ No roster created for ${monthArg} yet — used generated Sat/Sun dates.</i>`
      : '';
    return ctx.reply(
      `✅ Availability request for <b>${monthArg}</b> sent to <b>${sent}/${members.length}</b> members.${note}`,
      { parse_mode: 'HTML', reply_markup: backToAdmin() }
    );
  }

  // Admin: edit (clear) member availability
  if (ctx.session.awaitingEditAvailName) {
    ctx.session.awaitingEditAvailName = false;
    const memberName  = text.trim();
    const targetMonth = nextCalendarMonth();
    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');
    const { error } = await supa.from('availability')
      .delete().eq('member_name', memberName).eq('month', targetMonth);
    if (error) return ctx.reply(`⚠️ Error: ${error.message}`, { reply_markup: backToAdmin() });
    return ctx.reply(
      `✅ Cleared <b>${memberName}</b>'s availability for <b>${targetMonth}</b>.\n\nThey can now re-submit via the bot.`,
      { parse_mode: 'HTML', reply_markup: backToAdmin() }
    );
  }

  // Swap: step 1 — collect date
  if (ctx.session.awaitingSwapDate) {
    const dateMatch = text.match(/^(\d{1,2}\s+\w+(?:\s+\d{4})?)/);
    if (!dateMatch) {
      return ctx.reply('⚠️ Try a format like: <code>28 Jun</code>', { parse_mode: 'HTML' });
    }
    ctx.session.awaitingSwapDate   = false;
    ctx.session.pendingSwapDate    = dateMatch[1].trim();
    ctx.session.awaitingSwapReason = true;
    return ctx.reply(
      `📅 Date: <b>${ctx.session.pendingSwapDate}</b>\n\n📝 What's the reason for swapping?`,
      { parse_mode: 'HTML' }
    );
  }

  // Swap: step 2 — collect reason + submit
  if (ctx.session.awaitingSwapReason) {
    const name     = await resolveName(ctx);
    const swapDate = ctx.session.pendingSwapDate;
    const reason   = text || 'No reason given';
    ctx.session.awaitingSwapReason = false;
    ctx.session.pendingSwapDate    = null;

    let savedId = null;
    const supa = db.getClient();
    if (supa) {
      const { data, error } = await supa.from('swap_requests')
        .insert({ requester_name: name, requester_date: swapDate, reason, status: 'open' })
        .select().single();
      if (error) console.error('[Bot] swap insert:', error.message);
      savedId = data?.id;
    }

    const groupMsg =
      `🔄 <b>Swap Request</b>\n\n` +
      `👤 <b>${name}</b> needs a swap for <b>${swapDate}</b>\n📝 ${reason}\n\n` +
      `<i>Tap the button below to volunteer for this swap.</i>`;

    if (GROUP_ID) {
      try {
        const botUsername = await BOT_USERNAME_PROMISE;
        const swapKb = botUsername && savedId
          ? new InlineKeyboard().url(`✋ Accept swap`, `https://t.me/${botUsername}?start=acceptswap_${savedId}`)
          : undefined;
        const sent = await bot.api.sendMessage(GROUP_ID, groupMsg, {
          parse_mode: 'HTML',
          reply_markup: swapKb,
        });
        if (supa && savedId) {
          await supa.from('swap_requests')
            .update({ telegram_message_id: sent.message_id }).eq('id', savedId);
        }
      } catch (err) { console.warn('[Bot] Group post failed:', err.message); }
    }

    return ctx.reply(
      `✅ <b>Swap request posted!</b>\n\n📅 ${swapDate}\n📝 ${reason}\n\n` +
      `Team members will see it in the group and can accept via the bot.`,
      { parse_mode: 'HTML', reply_markup: backToMain() }
    );
  }

  // Accept swap — collect volunteer date
  if (ctx.session.awaitingAcceptDate) {
    const dateMatch = text.match(/^(\d{1,2}\s+\w+(?:\s+\d{4})?)/);
    if (!dateMatch) {
      return ctx.reply('⚠️ Try a format like: <code>5 Jul</code>', { parse_mode: 'HTML' });
    }
    const volunteerDate = dateMatch[1].trim();
    const { swapId, requesterName, requesterDate } = ctx.session.awaitingAcceptDate;
    ctx.session.awaitingAcceptDate = null;

    const name = await resolveName(ctx);
    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');

    await supa.from('swap_requests').update({
      status: 'matched', matched_with_name: name,
      matched_with_date: volunteerDate, updated_at: new Date().toISOString(),
    }).eq('id', swapId);

    if (GROUP_ID) {
      await bot.api.sendMessage(
        GROUP_ID,
        `✅ <b>Swap Matched!</b>\n\n🔄 <b>${requesterName}</b> (${requesterDate}) ↔️ <b>${name}</b> (${volunteerDate})\n\n` +
        `Please coordinate to confirm. Tag your TL if needed!`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    return ctx.reply(
      `✅ <b>Swap accepted!</b>\nYou cover <b>${requesterDate}</b> for <b>${requesterName}</b>, ` +
      `who takes your <b>${volunteerDate}</b>.\n\nConfirmation posted to the group.`,
      { parse_mode: 'HTML', reply_markup: backToMain() }
    );
  }

  // Fallback: show menu in DMs
  if (ctx.chat.type === 'private') {
    return sendMainMenu(ctx);
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error('[Bot] Unhandled error:', err.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
function start() {
  const useWebhook = process.env.TELEGRAM_USE_WEBHOOK === 'true';
  if (useWebhook) {
    console.log('[Bot] Webhook mode — handler at /api/telegram/webhook');
  } else {
    console.log('[Bot] Starting long-polling...');
    bot.start({ onStart: () => console.log('[Bot] Long-polling started') });
  }
}

const webhookHandler = process.env.TELEGRAM_USE_WEBHOOK === 'true'
  ? webhookCallback(bot, 'express')
  : null;

module.exports = { bot, start, webhookHandler };
