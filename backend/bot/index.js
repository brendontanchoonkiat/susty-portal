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
    awaitingLogKg:      null,   // { type, photoFileId? }
    awaitingSwapDate:   false,
    pendingSwapDate:    null,
    awaitingSwapReason: false,
    awaitingAcceptDate: null,   // { swapId, requesterName, requesterDate }
    cachedName:         null,
    // Availability collation
    availMonth:         null,   // month being collected e.g. "Aug 2026"
    availDates:         [],     // roster dates for that month
    availSelected:      [],     // dates member marked available
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

function backToMain() {
  return new InlineKeyboard().text('← Back to Menu', 'menu:main');
}

async function sendMainMenu(ctx, text) {
  return ctx.reply(text || '🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML',
    reply_markup: mainMenu,
  });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const existing = await db.getMemberByTelegramId(ctx.from.id);
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
  const name   = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const swapId = parseInt(ctx.match[1]);
  const supa   = db.getClient();
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
  await ctx.reply(
    `🔄 Accepting swap for <b>${swap.requester_name}</b>'s duty on <b>${swap.requester_date}</b>.\n\n` +
    `📅 What date are <b>you</b> offering in return? (e.g. <code>5 Jul</code>)`,
    { parse_mode: 'HTML' }
  );
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
    `📦 <b>Log Cardboard</b>\n\nHow many kg? (e.g. <code>42.5</code>)\n\n` +
    `<i>💡 Or send a photo with caption: <code>cardboard 42.5</code></i>`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('action:log:plastic', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingLogKg = { type: 'plastic' };
  await ctx.reply(
    `🍶 <b>Log Plastic</b>\n\nHow many kg? (e.g. <code>8.2</code>)\n\n` +
    `<i>💡 Or send a photo with caption: <code>plastic 8.2</code></i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── Callback: availability ───────────────────────────────────────────────────
bot.callbackQuery('menu:avail', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  // Find next upcoming month with roster slots
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  const today = new Date().toISOString().split('T')[0];
  const { data: upcoming } = await supa.from('roster_slots')
    .select('date, week, session').gte('date', today).order('date').limit(20);

  if (!upcoming || !upcoming.length) {
    return ctx.reply('No upcoming roster slots found.', { reply_markup: backToMain() });
  }

  // Group by month, show the nearest upcoming month
  const monthOf = d => { const dt = new Date(d); return dt.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' }); };
  const nearestMonth = monthOf(upcoming[0].date);
  const monthSlots   = upcoming.filter(s => monthOf(s.date) === nearestMonth);

  ctx.session.availMonth    = nearestMonth;
  ctx.session.availDates    = monthSlots.map(s => s.date);
  ctx.session.availSelected = [];

  await ctx.editMessageText(
    `📅 <b>Availability — ${nearestMonth}</b>\n\nTap the dates you <b>CAN</b> serve. Tap again to deselect.\n\n` +
    `<i>Dates will turn ✅ when selected.</i>`,
    { parse_mode: 'HTML', reply_markup: buildAvailKeyboard(monthSlots, []) }
  );
});

function buildAvailKeyboard(slots, selected) {
  const kb = new InlineKeyboard();
  for (const s of slots) {
    const label = s.date;
    const badge = selected.includes(s.date) ? '✅ ' : '';
    const sess  = s.session === 'GPC' ? '🟣' : s.session === 'SAT' ? '🟡' : '🟢';
    kb.text(`${badge}${sess} ${s.date} (${s.session})`, `avail:toggle:${s.date}`).row();
  }
  kb.text('💾 Submit Availability', 'avail:submit');
  return kb;
}

bot.callbackQuery(/^avail:toggle:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.match[1];
  const sel  = ctx.session.availSelected || [];

  if (sel.includes(date)) {
    ctx.session.availSelected = sel.filter(d => d !== date);
  } else {
    ctx.session.availSelected = [...sel, date];
  }

  const month = ctx.session.availMonth;
  const supa  = db.getClient();
  const { data: slots } = supa
    ? await supa.from('roster_slots').select('date,session')
        .in('date', ctx.session.availDates).order('date')
    : { data: ctx.session.availDates.map(d => ({ date: d, session: '?' })) };

  await ctx.editMessageReplyMarkup({
    reply_markup: buildAvailKeyboard(slots || [], ctx.session.availSelected),
  }).catch(() => {});
});

bot.callbackQuery('avail:submit', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name   = await resolveName(ctx);
  const month  = ctx.session.availMonth;
  const avail  = ctx.session.availSelected || [];
  const allD   = ctx.session.availDates    || [];
  const unavail = allD.filter(d => !avail.includes(d));

  if (!month) return ctx.reply('⚠️ Session expired. Please try again.', { reply_markup: backToMain() });

  await db.saveAvailability(month, name, avail, unavail);
  ctx.session.availMonth    = null;
  ctx.session.availDates    = [];
  ctx.session.availSelected = [];

  const lines = avail.length
    ? avail.map(d => `✅ ${d}`).join('\n')
    : '(None selected — marked as unavailable for all dates)';

  await ctx.reply(
    `✅ <b>Availability saved for ${month}!</b>\n\n${lines}\n\n` +
    `<i>Your TL will see this when planning the next roster.</i>`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  );
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

  // Get roster slots for that month
  const { data: slots } = await supa.from('roster_slots')
    .select('date, session').order('date');

  const monthSlots = (slots || []).filter(s => {
    const dt = new Date(s.date);
    const label = dt.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
    return label.toLowerCase() === args.toLowerCase();
  });

  if (!monthSlots.length) {
    return ctx.reply(`⚠️ No roster slots found for "${args}". Check the portal roster.`);
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
        `📅 <b>Availability Check — ${args}</b>\n\nHi <b>${m.name}</b>! Please mark the dates you can serve next month.\nTap ✅ to select, tap again to deselect.\n\n<i>Press Submit when done.</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      // Prime their session state via a workaround — store in DB instead
      await db.saveAvailability(args, m.name, [], monthSlots.map(s => s.date));
      sent++;
    } catch (err) {
      console.warn(`[Bot] collect: failed to DM ${m.name}:`, err.message);
    }
  }

  // Store month + dates in a simple config so members' button presses know the context
  await ctx.reply(
    `✅ Sent availability request for <b>${args}</b> to <b>${sent}/${members.length}</b> registered members.\n\n` +
    `Use the portal → Members to view responses as they come in.`,
    { parse_mode: 'HTML' }
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
  const name = await resolveName(ctx);
  if (!name) return;

  const caption = (ctx.message.caption || '').trim().toLowerCase();
  if (!caption) {
    if (ctx.chat.type === 'private') {
      ctx.session.awaitingLogKg = { photoFileId: ctx.message.photo.at(-1).file_id };
      return ctx.reply(
        '📷 Photo received! What are you logging?\n\n' +
        'Reply with: <code>cardboard 42.5</code>  or  <code>plastic 8.2</code>',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  const match = caption.match(/^(cardboard|plastic)\s+(\d+(?:\.\d+)?)/);
  if (!match) return;

  const type  = match[1];
  const kg    = parseFloat(match[2]);
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

  await saveLog({ name, type, kg, sessionDate: today(), fileId: photo.file_id, imageUrl, ctx });
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

  // Registration
  if (ctx.session.awaitingName) {
    if (text.length < 2 || text.length > 60) {
      return ctx.reply('Please enter your name as it appears on the roster (2–60 chars).');
    }
    // Try to match to a canonical name via aliases
    const canonical = await resolveTypedName(text);
    const finalName = canonical || text.trim();

    await db.upsertMember(ctx.from.id, finalName);
    ctx.session.awaitingName = false;
    ctx.session.cachedName   = finalName;

    const matchNote = canonical && canonical.toLowerCase() !== text.trim().toLowerCase()
      ? `\n<i>(Matched to roster name: <b>${canonical}</b>)</i>` : '';
    return sendMainMenu(ctx, `✅ Got it, <b>${finalName}</b>! You're all set. 🌿${matchNote}\n\nWhat do you need?`);
  }

  // Log weight — button flow (no photo)
  if (ctx.session.awaitingLogKg && !ctx.session.awaitingLogKg.photoFileId) {
    const { type } = ctx.session.awaitingLogKg;
    const kg = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(kg) || kg <= 0 || kg > 5000) {
      return ctx.reply(`⚠️ Enter a valid weight in kg, e.g. <code>42.5</code>`, { parse_mode: 'HTML' });
    }
    ctx.session.awaitingLogKg = null;
    const name = await resolveName(ctx);
    if (!name) return promptRegister(ctx);
    return saveLog({ name, type, kg, sessionDate: today(), ctx });
  }

  // Log weight — after photo without caption
  if (ctx.session.awaitingLogKg?.photoFileId) {
    const match = text.toLowerCase().match(/^(cardboard|plastic)\s+(\d+(?:\.\d+)?)/);
    if (!match) {
      return ctx.reply(
        'Reply with: <code>cardboard 42.5</code>  or  <code>plastic 8.2</code>',
        { parse_mode: 'HTML' }
      );
    }
    const { photoFileId } = ctx.session.awaitingLogKg;
    ctx.session.awaitingLogKg = null;
    const name = await resolveName(ctx);
    if (!name) return promptRegister(ctx);
    return saveLog({ name, type: match[1], kg: parseFloat(match[2]), sessionDate: today(), fileId: photoFileId, ctx });
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
      `<i>Open the bot and tap Roster → Open Swaps to volunteer.</i>`;

    if (GROUP_ID) {
      try {
        const sent = await bot.api.sendMessage(GROUP_ID, groupMsg, { parse_mode: 'HTML' });
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
