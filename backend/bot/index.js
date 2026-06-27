'use strict';
// ─── Susty Ministry Telegram Bot ─────────────────────────────────────────────
// Uses grammy (https://grammy.dev) — install: npm install grammy
//
// Modes:
//   TELEGRAM_USE_WEBHOOK=true  → webhook at /api/telegram/webhook (production)
//   (default)                  → long-polling (dev / fallback)
//
// Commands registered in BotFather:
//   help       - Show all available commands
//   myroster   - See your upcoming duty dates
//   nextduty   - Your next duty date only
//   roster     - Full roster for the next 4 weeks
//   swap       - Request a duty swap  e.g. /swap 28 Jun overseas trip
//   swaps      - List open swap requests
//   acceptswap - Accept a swap request  e.g. /acceptswap 3
//   log        - Log recycling weight   e.g. /log cardboard 42.5
//   stats      - Ministry-wide recycling stats + carbon impact
//   mystats    - Your personal recycling contribution
//   remind     - Toggle duty reminders  /remind on  or  /remind off
// ─────────────────────────────────────────────────────────────────────────────

const {
  Bot, InlineKeyboard, InputFile, webhookCallback, session,
} = (() => {
  try { return require('grammy'); }
  catch { throw new Error('grammy not installed — run: npm install grammy'); }
})();

const db     = require('../utils/supabase');
const carbon = require('../utils/carbon');

// ─── Fallback roster from JSON (used if Supabase not yet configured) ──────────
function getFallbackRoster() {
  try { return require('../data/roster.json'); } catch { return []; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_CHAT_ID;   // ministry group chat

if (!BOT_TOKEN) {
  console.warn('[Bot] TELEGRAM_BOT_TOKEN not set — bot will not start');
  module.exports = { start: () => {}, webhookHandler: null };
  return;
}

const bot = new Bot(BOT_TOKEN);

// Session stores pending state (e.g. waiting for name after /start)
bot.use(session({ initial: () => ({ awaitingName: false, awaitingLogKg: null }) }));

// ─── Group → PM redirect middleware ──────────────────────────────────────────
// Group chat is OUTPUT only (swap alerts, summaries, reminders).
// Any user command in the group gets a gentle redirect to PM.
// Exception: /start works in both so users can discover the bot from the group.
const GROUP_TYPES = ['group', 'supergroup'];
const BOT_USERNAME_PROMISE = bot.api.getMe().then(me => me.username).catch(() => null);

bot.use(async (ctx, next) => {
  if (!GROUP_TYPES.includes(ctx.chat?.type)) return next(); // allow all DMs

  const text = ctx.message?.text || '';
  const isCommand = text.startsWith('/');
  const isPhoto   = !!ctx.message?.photo;

  // Let /start through in groups so users can find the bot
  if (text.startsWith('/start')) return next();

  // Redirect any other command or photo log attempt to PM
  if (isCommand || isPhoto) {
    const username = await BOT_USERNAME_PROMISE;
    const link = username ? `https://t.me/${username}` : 'the bot directly';
    await ctx.reply(
      `👋 To keep the group tidy, please send commands to me directly!\n\n📲 <a href="${link}">Message me in PM</a>`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message?.message_id }
    ).catch(() => {});
    return; // don't process the command
  }

  return next(); // let non-command group messages through (shouldn't be many)
});

// ─── Resolve member name from Telegram context ────────────────────────────────
async function resolveName(ctx) {
  const member = await db.getMemberByTelegramId(ctx.from.id);
  return member?.name || null;
}

// ─── Format a roster slot for display ────────────────────────────────────────
function fmtSlot(slot) {
  const team = (slot.team || []).join(', ') || '—';
  const sess = slot.session || '';
  const badge = sess === 'GPC' ? '🟣' : sess === 'SAT' ? '🟡' : '🟢';
  return `${badge} <b>${slot.date}</b> (${sess})\n   👥 ${team}`;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function today() { return new Date().toISOString().split('T')[0]; }

// ─── /start ───────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const existing = await db.getMemberByTelegramId(ctx.from.id);
  if (existing) {
    return ctx.reply(
      `Welcome back, <b>${existing.name}</b>! 🌿\nType /help to see all commands.`,
      { parse_mode: 'HTML' }
    );
  }
  ctx.session.awaitingName = true;
  return ctx.reply(
    `👋 Hi! I'm the <b>Susty Ministry Bot</b> 🌿\n\nI help W2R members check rosters, log recycling data, and manage swaps.\n\n` +
    `To get started, what's your name <b>as it appears on the roster</b>?\n` +
    `<i>(e.g. "Brendon" or "Wee Shing")</i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  return ctx.reply(
    `🌿 <b>Susty Ministry Bot — Commands</b>\n\n` +
    `<b>📋 Roster</b>\n` +
    `/myroster — Your upcoming duty dates\n` +
    `/nextduty — Just your next duty\n` +
    `/roster   — Full roster, next 4 weeks\n` +
    `/confirm [date] — Confirm you'll be there\n\n` +
    `<b>🔄 Swaps</b>\n` +
    `/swap [date] [reason] — Request a swap\n` +
    `  <i>e.g. /swap 28 Jun overseas trip</i>\n` +
    `/swaps — See open swap requests\n` +
    `/acceptswap [id] — Volunteer for a swap\n\n` +
    `<b>📦 Data Logging</b>\n` +
    `/log cardboard [kg] — Log cardboard weight\n` +
    `/log plastic [kg]   — Log plastic weight\n` +
    `📷 <i>Or send a photo with caption:</i>\n` +
    `  <i>"cardboard 42.5"  or  "plastic 8.2"</i>\n\n` +
    `<b>📊 Stats &amp; Impact</b>\n` +
    `/stats   — Ministry-wide recycling + CO₂ impact\n` +
    `/mystats — Your personal contribution\n` +
    `/yoy     — Year-on-year comparison\n\n` +
    `<b>⚙️ Settings</b>\n` +
    `/remind on|off — Toggle duty reminders`,
    { parse_mode: 'HTML' }
  );
});

// ─── /myroster ────────────────────────────────────────────────────────────────
bot.command('myroster', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);

  // Fallback: search JSON roster if Supabase not configured
  if (slots === null) {
    const raw = getFallbackRoster();
    const td  = today();
    slots = raw.filter(s => s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase()));
  }

  if (!slots.length) {
    return ctx.reply(`Hi <b>${name}</b>! You have no upcoming duties scheduled. 🎉`, { parse_mode: 'HTML' });
  }

  const lines = slots.slice(0, 8).map(fmtSlot).join('\n\n');
  return ctx.reply(
    `📋 <b>${name}'s Upcoming Duties</b>\n\n${lines}\n\n` +
    `Use /swap [date] [reason] if you need to swap a slot.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /nextduty ────────────────────────────────────────────────────────────────
bot.command('nextduty', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);
  if (slots === null) {
    const raw = getFallbackRoster();
    const td  = today();
    slots = raw.filter(s => s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase()));
  }

  if (!slots.length) {
    return ctx.reply(`Hi <b>${name}</b>! No upcoming duties found. 🎉`, { parse_mode: 'HTML' });
  }

  const next = slots[0];
  const daysUntil = Math.ceil((new Date(next.date) - new Date()) / 86400000);
  const when = daysUntil === 0 ? 'Today!' : daysUntil === 1 ? 'Tomorrow!' : `in ${daysUntil} days`;

  return ctx.reply(
    `📅 <b>${name}'s Next Duty</b>\n\n${fmtSlot(next)}\n\n⏳ <b>${when}</b>`,
    { parse_mode: 'HTML' }
  );
});

// ─── /roster ──────────────────────────────────────────────────────────────────
bot.command('roster', async (ctx) => {
  let slots = await db.getUpcomingRoster(4);
  if (slots === null) {
    const raw = getFallbackRoster();
    const td  = today();
    const limit = new Date(); limit.setDate(limit.getDate() + 28);
    slots = raw.filter(s => s.date >= td && s.date <= limit.toISOString().split('T')[0]);
  }

  if (!slots.length) {
    return ctx.reply('No roster slots in the next 4 weeks.');
  }

  const lines = slots.map(fmtSlot).join('\n\n');
  return ctx.reply(
    `📋 <b>W2R Roster — Next 4 Weeks</b>\n\n${lines}\n\n` +
    `Use /myroster to see only your slots.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /confirm ─────────────────────────────────────────────────────────────────
bot.command('confirm', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const args = ctx.message.text.replace('/confirm', '').trim();
  if (!args) {
    return ctx.reply('Please include the date: /confirm 28 Jun', { parse_mode: 'HTML' });
  }

  // Find the slot
  const db2 = db.getClient();
  if (db2) {
    const { data: slots } = await db2.from('roster_slots')
      .select('*')
      .ilike('date::text', `%${args}%`)
      .contains('team', [name]);

    if (!slots?.length) {
      return ctx.reply(`⚠️ No slot found for "${args}" with your name. Check /myroster.`, { parse_mode: 'HTML' });
    }
    const slot = slots[0];
    // Upsert attendance
    await db2.from('attendance')
      .upsert({ roster_slot_id: slot.id, member_name: name }, { onConflict: 'roster_slot_id,member_name' });
    return ctx.reply(
      `✅ <b>Confirmed!</b> ${name} is set for <b>${slot.date}</b> (${slot.session}).`,
      { parse_mode: 'HTML' }
    );
  }
  return ctx.reply('✅ Got it! (Supabase not configured — confirmation not persisted.)', { parse_mode: 'HTML' });
});

// ─── /swap ────────────────────────────────────────────────────────────────────
bot.command('swap', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const args = ctx.message.text.replace('/swap', '').trim();
  if (!args) {
    return ctx.reply(
      '⚠️ Usage: <code>/swap [date] [reason]</code>\nExample: <code>/swap 28 Jun overseas trip</code>',
      { parse_mode: 'HTML' }
    );
  }

  // Parse: first token(s) that form a date, remainder is reason
  const dateMatch = args.match(/^(\d{1,2}\s+\w+(?:\s+\d{4})?)/);
  if (!dateMatch) {
    return ctx.reply(
      '⚠️ Couldn\'t read the date. Format: <code>/swap 28 Jun reason here</code>',
      { parse_mode: 'HTML' }
    );
  }
  const swapDate = dateMatch[1].trim();
  const reason   = args.slice(swapDate.length).trim() || 'No reason given';

  const swapReq = {
    requester_name: name,
    requester_date: swapDate,
    reason,
    status: 'open',
    created_at: new Date().toISOString(),
  };

  let savedId = null;
  const supa = db.getClient();
  if (supa) {
    const { data, error } = await supa.from('swap_requests').insert(swapReq).select().single();
    if (error) console.error('[Bot] swap insert:', error.message);
    savedId = data?.id;
  }

  // Post to ministry group
  const groupMsg =
    `🔄 <b>Swap Request</b>\n\n` +
    `👤 <b>${name}</b> needs a swap for <b>${swapDate}</b>\n` +
    `📝 Reason: ${reason}\n\n` +
    `To volunteer, reply:\n<code>/acceptswap ${savedId || '?'} [your date]</code>\n\n` +
    `<i>Or tap Open Requests below to see all swaps.</i>`;

  if (GROUP_ID) {
    try {
      const res = await bot.api.sendMessage(GROUP_ID, groupMsg, { parse_mode: 'HTML' });
      // Save message ID for later editing when matched
      if (supa && savedId && res.message_id) {
        await supa.from('swap_requests').update({ telegram_message_id: res.message_id }).eq('id', savedId);
      }
    } catch (err) {
      console.warn('[Bot] Failed to post swap to group:', err.message);
    }
  }

  return ctx.reply(
    `✅ <b>Swap request submitted!</b>\n\n` +
    `📅 Date: ${swapDate}\n📝 Reason: ${reason}\n` +
    `${savedId ? `🆔 Request ID: <b>${savedId}</b>` : ''}\n\n` +
    `Your request has been posted to the group. Team members can reply to volunteer.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /swaps ───────────────────────────────────────────────────────────────────
bot.command('swaps', async (ctx) => {
  const supa = db.getClient();
  let swaps = [];

  if (supa) {
    const { data } = await supa.from('swap_requests')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10);
    swaps = data || [];
  } else {
    // Fallback: read swap-requests.json
    try {
      const raw = require('../data/swap-requests.json');
      swaps = Array.isArray(raw) ? raw.filter(s => s.status === 'open') : [];
    } catch { swaps = []; }
  }

  if (!swaps.length) {
    return ctx.reply('✅ No open swap requests right now!');
  }

  const lines = swaps.map(s =>
    `🆔 <b>#${s.id}</b> — <b>${s.requester_name}</b> on <b>${s.requester_date}</b>\n` +
    `   📝 ${s.reason || 'No reason'}\n` +
    `   → <code>/acceptswap ${s.id} [your date]</code>`
  ).join('\n\n');

  return ctx.reply(`🔄 <b>Open Swap Requests</b>\n\n${lines}`, { parse_mode: 'HTML' });
});

// ─── /acceptswap ──────────────────────────────────────────────────────────────
bot.command('acceptswap', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const args = ctx.message.text.replace('/acceptswap', '').trim().split(/\s+/);
  const id   = parseInt(args[0]);
  const volunteerDate = args.slice(1).join(' ').trim();

  if (!id || isNaN(id)) {
    return ctx.reply(
      '⚠️ Usage: <code>/acceptswap [id] [your date]</code>\nExample: <code>/acceptswap 3 5 Jul</code>',
      { parse_mode: 'HTML' }
    );
  }
  if (!volunteerDate) {
    return ctx.reply(
      `⚠️ Please include your date: <code>/acceptswap ${id} 5 Jul</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const supa = db.getClient();
  if (!supa) {
    return ctx.reply('⚠️ Supabase not configured — swap matching unavailable. Contact your TL directly.');
  }

  const { data: swap, error } = await supa.from('swap_requests')
    .select('*').eq('id', id).single();

  if (error || !swap) {
    return ctx.reply(`⚠️ Swap request #${id} not found.`, { parse_mode: 'HTML' });
  }
  if (swap.status !== 'open') {
    return ctx.reply(`⚠️ Swap #${id} is already ${swap.status}.`, { parse_mode: 'HTML' });
  }
  if (swap.requester_name.toLowerCase() === name.toLowerCase()) {
    return ctx.reply(`⚠️ You can't accept your own swap request.`, { parse_mode: 'HTML' });
  }

  // Match the swap
  await supa.from('swap_requests').update({
    status:             'matched',
    matched_with_name:  name,
    matched_with_date:  volunteerDate,
    updated_at:         new Date().toISOString(),
  }).eq('id', id);

  const matchMsg =
    `✅ <b>Swap Matched!</b>\n\n` +
    `🔄 <b>${swap.requester_name}</b> (${swap.requester_date})\n` +
    `↔️ <b>${name}</b> (${volunteerDate})\n\n` +
    `Please coordinate with each other to confirm the final arrangement. Tag your TL if you need help!`;

  if (GROUP_ID) {
    await bot.api.sendMessage(GROUP_ID, matchMsg, { parse_mode: 'HTML' }).catch(() => {});
  }

  return ctx.reply(
    `✅ <b>Swap matched!</b>\n\nYou'll take <b>${swap.requester_date}</b> for <b>${swap.requester_name}</b>, ` +
    `who will take your <b>${volunteerDate}</b>. A confirmation has been posted to the group.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /log ─────────────────────────────────────────────────────────────────────
bot.command('log', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const args = ctx.message.text.replace('/log', '').trim().toLowerCase().split(/\s+/);
  const type = args[0]; // cardboard | plastic
  const kg   = parseFloat(args[1]);

  if (!['cardboard', 'plastic'].includes(type)) {
    return ctx.reply(
      '⚠️ Usage: <code>/log cardboard 42.5</code>  or  <code>/log plastic 8.2</code>',
      { parse_mode: 'HTML' }
    );
  }
  if (isNaN(kg) || kg <= 0 || kg > 5000) {
    return ctx.reply('⚠️ Please include a valid weight in kg. Example: <code>/log cardboard 42.5</code>', { parse_mode: 'HTML' });
  }

  await saveLog({ name, type, kg, sessionDate: today(), ctx });
});

// ─── Photo handler — caption like "cardboard 42.5" or "plastic 8.2" ──────────
bot.on('message:photo', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return; // silently skip unregistered users in group

  const caption = (ctx.message.caption || '').trim().toLowerCase();
  if (!caption) {
    // Only respond in DMs to avoid spamming group
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

  // Parse "cardboard 42.5" or "plastic 8.2" from caption
  const match = caption.match(/^(cardboard|plastic)\s+(\d+(?:\.\d+)?)/);
  if (!match) return; // caption doesn't match — ignore

  const type      = match[1];
  const kg        = parseFloat(match[2]);
  const photo     = ctx.message.photo.at(-1); // highest resolution
  const fileId    = photo.file_id;

  // Try to get a direct URL and upload to Supabase Storage
  let imageUrl = null;
  try {
    const file       = await bot.api.getFile(fileId);
    const fileUrl    = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imgResp    = await fetch(fileUrl, { signal: AbortSignal.timeout(10000) });
    const buffer     = Buffer.from(await imgResp.arrayBuffer());
    const filename   = `${today()}_${name.replace(/\s+/g,'_')}_${type}_${Date.now()}.jpg`;
    imageUrl         = await db.uploadImage(buffer, filename, 'image/jpeg');
  } catch (err) {
    console.warn('[Bot] Image upload failed:', err.message);
  }

  await saveLog({ name, type, kg, sessionDate: today(), fileId, imageUrl, ctx });
});

// Shared log saver
async function saveLog({ name, type, kg, sessionDate, fileId = null, imageUrl = null, ctx }) {
  const logEntry = {
    session_date: sessionDate,
    type,
    kg,
    image_url:   imageUrl,
    file_id:     fileId,
    notes:       '',
    logged_by:   name,
    created_at:  new Date().toISOString(),
  };

  await db.insertDataLog(logEntry);

  const impact = carbon.calcCO2e(
    type === 'cardboard' ? kg : 0,
    type === 'plastic'   ? kg : 0,
  );

  const emoji     = type === 'cardboard' ? '📦' : '🍶';
  const photoLine = imageUrl ? '\n📷 Photo saved.' : fileId ? '\n📷 Photo received (upload pending).' : '';

  return ctx.reply(
    `${emoji} <b>Logged!</b>\n\n` +
    `${type === 'cardboard' ? '📦 Cardboard' : '🍶 Plastic'}: <b>${kg} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${impact.co2eKg} kg</b>\n` +
    `📅 Session: ${fmtDate(sessionDate)}${photoLine}\n\n` +
    `<i>Use /stats to see cumulative ministry impact.</i>`,
    { parse_mode: 'HTML' }
  );
}

// ─── /stats ───────────────────────────────────────────────────────────────────
bot.command('stats', async (ctx) => {
  const rows = await db.getRecyclingStats();

  let cardboardKg = 0, plasticKg = 0;
  let cardboard25 = 0, plastic25 = 0, cardboard26 = 0, plastic26 = 0;

  if (rows && rows.length) {
    for (const r of rows) {
      const y = Number(r.year);
      if (y === 2025) { cardboard25 += Number(r.cardboard_kg); plastic25 += Number(r.plastic_kg); }
      if (y === 2026) { cardboard26 += Number(r.cardboard_kg); plastic26 += Number(r.plastic_kg); }
    }
    cardboardKg = cardboard25 + cardboard26;
    plasticKg   = plastic25 + plastic26;
  } else {
    // Fallback: use static data
    const { cardboardData, plasticData } = require('../data/recycling');
    cardboardKg = cardboardData.reduce((s, r) => s + r.kg, 0);
    plasticKg   = plasticData.reduce((s, r) => s + r.kg, 0);
    cardboard25 = cardboardData.filter(r => r.month.includes('2025')).reduce((s, r) => s + r.kg, 0);
    plastic25   = plasticData.filter(r => r.month.includes('2025')).reduce((s, r) => s + r.kg, 0);
    cardboard26 = cardboardData.filter(r => r.month.includes('2026')).reduce((s, r) => s + r.kg, 0);
    plastic26   = plasticData.filter(r => r.month.includes('2026')).reduce((s, r) => s + r.kg, 0);
  }

  const total  = carbon.calcCO2e(cardboardKg, plasticKg);
  const y26    = carbon.calcCO2e(cardboard26, plastic26);

  return ctx.reply(
    `♻️ <b>W2R Ministry Impact</b>\n` +
    `<i>Recycling Weekend (Sep 2025 – present)</i>\n\n` +

    `📊 <b>All-Time Totals</b>\n` +
    `📦 Cardboard: <b>${cardboardKg.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${plasticKg.toFixed(1)} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${total.co2eKg} kg</b>\n` +
    `🌳 Trees equivalent: <b>${total.treesEquiv}</b>\n` +
    `🚗 Driving equivalent: <b>${total.carKmEquiv.toLocaleString()} km</b> off the road\n` +
    `🧴 Plastic bottles diverted: <b>${total.bottlesEquiv.toLocaleString()}</b>\n\n` +

    `📅 <b>2026 YTD</b>\n` +
    `📦 ${cardboard26.toFixed(1)} kg cardboard  |  🍶 ${plastic26.toFixed(1)} kg plastic\n` +
    `🌍 ${y26.co2eKg} kg CO₂e avoided\n\n` +

    `<i>Use /yoy for year-on-year comparison.</i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── /yoy ─────────────────────────────────────────────────────────────────────
bot.command('yoy', async (ctx) => {
  const rows = await db.getRecyclingStats();
  let summaries;

  if (rows && rows.length) {
    summaries = carbon.summariseByYear(rows);
  } else {
    const { cardboardData, plasticData } = require('../data/recycling');
    const combined = cardboardData.map((r, i) => ({
      month:        r.month,
      year:         parseInt(r.month.slice(-4)),
      cardboard_kg: r.kg,
      plastic_kg:   (plasticData[i] || {}).kg || 0,
    }));
    summaries = carbon.summariseByYear(combined);
  }

  return ctx.reply(carbon.formatYoY(summaries), { parse_mode: 'HTML' });
});

// ─── /mystats ─────────────────────────────────────────────────────────────────
bot.command('mystats', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const supa = db.getClient();
  if (!supa) {
    return ctx.reply('📊 Personal stats require Supabase to be configured.', { parse_mode: 'HTML' });
  }

  const { data: logs } = await supa.from('data_logs')
    .select('*').eq('logged_by', name);

  const { data: attended } = await supa.from('attendance')
    .select('*, roster_slots(date, session)').eq('member_name', name);

  const myCardboard = (logs || []).filter(l => l.type === 'cardboard').reduce((s, l) => s + Number(l.kg), 0);
  const myPlastic   = (logs || []).filter(l => l.type === 'plastic').reduce((s, l) => s + Number(l.kg), 0);
  const myImpact    = carbon.calcCO2e(myCardboard, myPlastic);
  const sessions    = attended?.length || (logs || []).length;

  return ctx.reply(
    `🌿 <b>${name}'s Personal Impact</b>\n\n` +
    `📋 Sessions attended: <b>${sessions}</b>\n` +
    `📦 Cardboard logged: <b>${myCardboard.toFixed(1)} kg</b>\n` +
    `🍶 Plastic logged:   <b>${myPlastic.toFixed(1)} kg</b>\n\n` +
    `🌍 Your CO₂e contribution: <b>${myImpact.co2eKg} kg</b>\n` +
    `🌳 Trees equivalent: <b>${myImpact.treesEquiv}</b>\n` +
    `🧴 Bottles diverted: <b>${myImpact.bottlesEquiv.toLocaleString()}</b>\n\n` +
    `<i>Every session counts. Thank you for serving! 💪</i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── /remind ──────────────────────────────────────────────────────────────────
bot.command('remind', async (ctx) => {
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const arg = ctx.message.text.replace('/remind', '').trim().toLowerCase();
  if (!['on', 'off'].includes(arg)) {
    return ctx.reply(
      'Usage: <code>/remind on</code>  or  <code>/remind off</code>',
      { parse_mode: 'HTML' }
    );
  }

  const supa = db.getClient();
  if (supa) {
    await supa.from('members').update({ remind_on: arg === 'on' }).eq('telegram_id', ctx.from.id);
  }

  return ctx.reply(
    arg === 'on'
      ? `🔔 Reminders <b>ON</b> — you'll get a heads-up 5 days and 1 day before your duties.`
      : `🔕 Reminders <b>OFF</b> — no more automatic duty reminders.`,
    { parse_mode: 'HTML' }
  );
});

// ─── Text handler — for pending state after /start ────────────────────────────
bot.on('message:text', async (ctx) => {
  // Awaiting name registration
  if (ctx.session.awaitingName) {
    const name = ctx.message.text.trim();
    if (name.length < 2 || name.length > 60) {
      return ctx.reply('Please enter your name as it appears on the roster (2–60 characters).');
    }
    await db.upsertMember(ctx.from.id, name);
    ctx.session.awaitingName = false;
    return ctx.reply(
      `✅ Got it, <b>${name}</b>! You're all set. 🌿\n\nType /help to see what I can do.`,
      { parse_mode: 'HTML' }
    );
  }

  // Awaiting kg after photo was sent without caption
  if (ctx.session.awaitingLogKg) {
    const name  = await resolveName(ctx);
    const text  = ctx.message.text.trim().toLowerCase();
    const match = text.match(/^(cardboard|plastic)\s+(\d+(?:\.\d+)?)/);
    if (!match) {
      return ctx.reply(
        'Please reply with: <code>cardboard 42.5</code>  or  <code>plastic 8.2</code>',
        { parse_mode: 'HTML' }
      );
    }
    const { photoFileId } = ctx.session.awaitingLogKg;
    const type = match[1];
    const kg   = parseFloat(match[2]);
    ctx.session.awaitingLogKg = null;
    await saveLog({ name, type, kg, sessionDate: today(), fileId: photoFileId, ctx });
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error('[Bot] Unhandled error:', err.message);
});

// ─── Helper: prompt unregistered user ────────────────────────────────────────
function promptRegister(ctx) {
  return ctx.reply(
    '👋 You\'re not registered yet! Send /start to set up your account.',
    { parse_mode: 'HTML' }
  );
}

// ─── Start modes ──────────────────────────────────────────────────────────────
function start() {
  const useWebhook = process.env.TELEGRAM_USE_WEBHOOK === 'true';

  if (useWebhook) {
    console.log('[Bot] Webhook mode — handler available at /api/telegram/webhook');
    // Actual listening is handled by the Express route
  } else {
    console.log('[Bot] Starting long-polling...');
    bot.start({
      onStart: () => console.log('[Bot] Long-polling started'),
    });
  }
}

// Webhook callback for use in Express route
const webhookHandler = process.env.TELEGRAM_USE_WEBHOOK === 'true'
  ? webhookCallback(bot, 'express')
  : null;

module.exports = { bot, start, webhookHandler };
