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
    awaitingLogDate:    null,   // { type } — waiting for date text after choosing Log Cardboard/Plastic
    logSession:         null,   // { type, sessionDate, measurements: [{kg, fileId, imageUrl}] } — active multi-measurement log flow
    awaitingLogPhoto:   false,  // waiting for a photo for the current measurement in logSession
    awaitingLogKg:      false,  // waiting for a weight for the current measurement (after its photo)
    awaitingAnomalyReason: false, // waiting for a reason after an unusually high total was confirmed
    pendingAnomaly:        null,  // { ls, name, total } — staged until the anomaly reason step finishes
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
    availSlots:            [],     // full slot objects { date, session } for keyboard rebuild
    availSelected:         [],     // dates member marked unavailable
    // Unavailability reasons
    unavailReasons:        {},     // { date: reason }
    awaitingUnavailReason: null,   // date string currently waiting for reason text
    // Monthly "anything happening?" note (asked once per availability submission)
    pendingAvailSave:      null,   // { month, name, avail, unavail, reasons } — staged until the note step finishes
    awaitingMonthlyNote:   false,
    // Profile collection (service / CG / other ministries / DOB)
    pendingProfile:            null,  // { name, isNew, service, cg, otherMinistries, dob }
    awaitingProfileService:    false,
    awaitingProfileCG:         false,
    awaitingProfileMinistries: false,
    awaitingProfileDob:        false,
    // Admin flows
    awaitingCollectMonth:  false,  // TL: waiting for month input for /collect
    awaitingEditAvailName: false,  // TL: waiting for member name to clear availability
    awaitingExcuseName:    false,  // TL: waiting for "Name YYYY-MM-DD" to excuse a member
    awaitingExcuseDate:    null,   // member name once entered, now waiting for end date
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
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// DD MMM YYYY — used in keyboard buttons (e.g. "01 Aug 2026")
function fmtDateShort(d) {
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function today() { return new Date().toISOString().split('T')[0]; }

// Validates a day/month(/year) combo is a real calendar date — rejects things
// like "36 July" or "31 June" that a loose regex would otherwise accept.
function isValidDayMonth(day, monthText, yearText) {
  const monIdx = MONTH_NAMES.findIndex(mn => mn.startsWith((monthText || '').toLowerCase()));
  if (monIdx < 0 || isNaN(day) || day < 1 || day > 31) return false;
  const year = yearText ? parseInt(yearText) : new Date().getFullYear();
  const dt = new Date(year, monIdx, day);
  return dt.getMonth() === monIdx && dt.getDate() === day;
}

// Parse a typed date like "20 Jun" or "20 Jun 2025" → ISO "YYYY-MM-DD", or null if unparseable.
// No year given + result would be in the future → assume the person meant last year.
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function parseLogDate(text) {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s*(\d{4})?$/);
  if (!m) return null;
  const day    = parseInt(m[1]);
  const monIdx = MONTH_NAMES.findIndex(mn => mn.startsWith(m[2].toLowerCase()));
  if (monIdx < 0 || day < 1 || day > 31) return null;
  const typedYear = m[3] ? parseInt(m[3]) : null;
  let year = typedYear || new Date().getFullYear();
  let dt   = new Date(year, monIdx, day);
  // JS Date silently rolls overflow days into the next month (e.g. 32 Jul → 1 Aug,
  // 31 Jun → 1 Jul, 30 Feb → 2 Mar) — reject anything that didn't land exactly
  // on the month/day requested, since that means the date doesn't exist.
  if (dt.getMonth() !== monIdx || dt.getDate() !== day) return null;
  if (!typedYear && dt > new Date()) {
    year -= 1;
    dt = new Date(year, monIdx, day);
    if (dt.getMonth() !== monIdx || dt.getDate() !== day) return null; // e.g. 29 Feb on a non-leap year
  }
  return dt.toISOString().split('T')[0];
}

// Parse a date of birth like "15 Aug 1995" — year is required (unlike swap/log
// dates, DOB can't default to "current year" or "assume last year").
function parseDob(text) {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const day  = parseInt(m[1]);
  const year = parseInt(m[3]);
  if (!isValidDayMonth(day, m[2], m[3])) return null;
  if (year < 1900 || year > new Date().getFullYear()) return null;
  const monIdx = MONTH_NAMES.findIndex(mn => mn.startsWith(m[2].toLowerCase()));
  return new Date(year, monIdx, day).toISOString().split('T')[0];
}

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
    { parse_mode: 'HTML', reply_markup: swapPromptKb() }
  );
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
// Builds the main menu dynamically — hides "My Availability" if user already submitted
async function buildMainMenu(ctx) {
  const name      = ctx.session?.cachedName || (await resolveName(ctx));
  const nextMonth = nextCalendarMonth();
  const supa      = db.getClient();
  let showAvail   = true;
  if (supa && name) {
    const { data } = await supa.from('availability')
      .select('id').eq('member_name', name).eq('month', nextMonth).limit(1);
    if (data?.length) showAvail = false;
  }
  const kb = new InlineKeyboard()
    .text('📋 Roster',         'menu:roster').row()
    .text('🪣 Duty Needs',     'menu:duty').row()
    .text('📊 Stats & Impact', 'menu:stats').row()
    .text('✏️ My Profile',     'menu:profile');
  if (showAvail) kb.row().text('📅 My Availability', 'menu:avail');
  return kb;
}

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
  .text('🤰 Excuse Member from Roster', 'admin:excuse').row()
  .text('👥 View Registered Members', 'admin:members').row()
  .text('📇 Member Profiles', 'admin:profiles').row()
  .text('← Back', 'menu:main');

function backToMain() {
  return new InlineKeyboard().text('← Back to Menu', 'menu:main');
}

function swapPromptKb() {
  return new InlineKeyboard().text('✖️ Cancel', 'swap:cancel');
}

// Discards an in-progress swap request or swap-acceptance flow.
async function cancelSwapFlow(ctx, { viaButton = false } = {}) {
  ctx.session.awaitingSwapDate   = false;
  ctx.session.pendingSwapDate    = null;
  ctx.session.awaitingSwapReason = false;
  ctx.session.awaitingAcceptDate = null;

  const kb  = new InlineKeyboard().text('← Back to Menu', 'menu:main');
  const msg = '❌ <b>Swap cancelled.</b> Nothing was submitted.';
  if (viaButton) {
    return ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb }));
  }
  return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
}

bot.callbackQuery('swap:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  return cancelSwapFlow(ctx, { viaButton: true });
});

function backToAdmin() {
  return new InlineKeyboard().text('← Back to Admin', 'admin:menu');
}

async function sendMainMenu(ctx, text) {
  const kb = await buildMainMenu(ctx);
  return ctx.reply(text || '🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML',
    reply_markup: kb,
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
    // Self-heal: if their stored name doesn't match the roster's canonical
    // spelling (e.g. someone registered as "Judy Koh" back when "judy koh"
    // wasn't yet a recognised alias for "Judy"), quietly correct it. Without
    // this, roster/duty lookups silently come up empty forever since
    // roster_slots.team only ever contains the canonical name.
    let canonicalName = existing.name;
    const resolved = await db.resolveCanonicalName(existing.name);
    if (resolved?.canonical && resolved.canonical !== existing.name) {
      canonicalName = resolved.canonical;
    }
    if (ctx.session) ctx.session.cachedName = canonicalName;

    // Opportunistically keep telegram_username fresh for already-registered
    // members too (covers anyone who registered before this was tracked, or
    // who has since changed their @username), and fix a drifted name at the
    // same time.
    if (canonicalName !== existing.name || (ctx.from.username && ctx.from.username !== existing.telegram_username)) {
      // Fall back to whatever username is already stored so a fix triggered
      // purely by the name drift never clobbers a previously-captured username.
      db.upsertMember(ctx.from.id, canonicalName, ctx.from.username || existing.telegram_username).catch(() => {});
    }
    return sendMainMenu(ctx, `Welcome back, <b>${canonicalName}</b>! 🌿\n\nWhat do you need?`);
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
  const val         = ctx.match[1];
  const candidates  = ctx.session.pendingNameCandidates || [];
  const typedName   = ctx.session.pendingTypedName || '';
  const isNewMember = val === 'custom'; // true = no matching roster row at all (INSERT); false = matched an existing one (UPDATE)

  const finalName = isNewMember ? typedName : (candidates[parseInt(val)] || typedName);

  ctx.session.awaitingNameConfirm   = false;
  ctx.session.pendingNameCandidates = [];
  ctx.session.pendingTypedName      = null;
  ctx.session.cachedName            = finalName;

  await db.upsertMember(ctx.from.id, finalName, ctx.from.username);

  // Every first-time registration — matched to an existing roster row or not —
  // goes through profile collection. Any pending deep-link (e.g. accept a swap)
  // resumes automatically once finalizeProfile() finishes.
  await ctx.editMessageText(`✅ Registered as <b>${finalName}</b>! 🌿`, { parse_mode: 'HTML' }).catch(() => {});
  return startProfileCollection(ctx, finalName, isNewMember);
});

// ─── Callback: main menus ─────────────────────────────────────────────────────
bot.callbackQuery('menu:main', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = await buildMainMenu(ctx);
  await ctx.editMessageText('🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML', reply_markup: kb,
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
    '🪣 <b>Duty Needs</b>\n\nLog your recycling — photo + weight for each measurement.\n\n' +
    '<i>💡 Missed logging on the day? You can back-add it — just type a past date when asked instead of tapping Today.</i>',
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

// ─── Profile collection (service day / CG / other ministries / DOB) ──────────
// Triggered automatically for brand-new members right after registration, and
// available any time via "✏️ My Profile" so existing members can fill it in
// or update it later.
function serviceLabel(code) {
  return code === 'BOTH' ? 'Both / Either' : code === 'SAT' ? 'Saturday' : code === 'SUN' ? 'Sunday' : '—';
}

async function startProfileCollection(ctx, name, isNew) {
  ctx.session.pendingProfile         = { name, isNew };
  ctx.session.awaitingProfileService = true;
  const kb = new InlineKeyboard()
    .text('Saturday', 'profile:service:SAT').text('Sunday', 'profile:service:SUN').row()
    .text('Both / Either', 'profile:service:BOTH');
  const intro = isNew
    ? `📝 <b>Quick profile setup</b>\n\nJust a few questions to get you set up.\n\n`
    : `📝 <b>My Profile</b>\n\nLet's fill this in (or update it).\n\n`;
  return ctx.reply(
    `${intro}📅 Which service do you usually attend? <i>(Helps us roster you on the right day.)</i>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.callbackQuery('menu:profile', async (ctx) => {
  await ctx.answerCallbackQuery();
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  return startProfileCollection(ctx, name, false);
});

bot.callbackQuery(/^profile:service:(SAT|SUN|BOTH)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.pendingProfile) return;
  const code = ctx.match[1];
  ctx.session.pendingProfile.service  = code;
  ctx.session.awaitingProfileService  = false;
  ctx.session.awaitingProfileCG       = true;
  const text = `✅ Service: <b>${serviceLabel(code)}</b>\n\n👥 Which CG (cell group) are you part of?`;
  await ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => ctx.reply(text, { parse_mode: 'HTML' }));
});

async function finalizeProfile(ctx) {
  const p = ctx.session.pendingProfile;
  ctx.session.pendingProfile            = null;
  ctx.session.awaitingProfileService    = false;
  ctx.session.awaitingProfileCG         = false;
  ctx.session.awaitingProfileMinistries = false;
  ctx.session.awaitingProfileDob        = false;
  if (!p) return sendMainMenu(ctx);

  const patch = {
    service_preference: p.service || null,
    cg: p.cg || null,
    other_ministries: p.otherMinistries || null,
    date_of_birth: p.dob || null,
  };

  if (db.getClient()) {
    if (p.isNew) {
      await db.insert('member_roster', {
        name: p.name,
        aliases: [],
        sat_serves: 0, sun_serves: 0, gpc_serves: 0, total_serves: 0,
        points: 0, priority: '✅ Serve Next', is_active: true,
        ...patch,
      });
    } else {
      await db.updateMemberRosterStats(p.name, patch);
    }
  }

  const summary =
    `✅ <b>Profile saved!</b>\n\n` +
    `📅 Service: <b>${serviceLabel(p.service)}</b>\n` +
    `👥 CG: <b>${p.cg || 'None'}</b>\n` +
    `🙏 Other ministries: <b>${p.otherMinistries || 'None'}</b>\n` +
    `🎂 DOB: <b>${p.dob ? fmtDate(p.dob) : 'Not provided'}</b>`;

  // Resume a pending deep-link (e.g. this happened mid registration for an accept-swap link)
  if (ctx.session.pendingDeeplink?.startsWith('acceptswap_')) {
    const swapId = parseInt(ctx.session.pendingDeeplink.replace('acceptswap_', ''));
    ctx.session.pendingDeeplink = null;
    await ctx.reply(summary, { parse_mode: 'HTML' });
    return handleAcceptSwap(ctx, swapId, p.name);
  }

  return sendMainMenu(ctx, `${summary}\n\nWhat do you need?`);
}

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
    { parse_mode: 'HTML', reply_markup: swapPromptKb() }
  );
});

// ─── Callback: duty needs ─────────────────────────────────────────────────────
// Starts (or resumes) a multi-measurement log session for `type` on `sessionDate`.
function logPromptKb() {
  return new InlineKeyboard().text('✖️ Cancel', 'log:cancel');
}

// Discards whatever's in progress and offers to start the same type over again.
// Used by both the Cancel button and typing "cancel"/"stop"/"restart" mid-flow.
async function cancelLogFlow(ctx, { viaButton = false } = {}) {
  const type = ctx.session.logSession?.type || ctx.session.awaitingLogDate?.type || null;
  ctx.session.logSession       = null;
  ctx.session.awaitingLogPhoto = false;
  ctx.session.awaitingLogKg    = false;
  ctx.session.awaitingLogDate  = null;

  const kb = new InlineKeyboard();
  if (type) kb.text(`🔄 Start Over — ${type === 'cardboard' ? 'Cardboard' : 'Plastic'}`, `action:log:${type}`).row();
  kb.text('← Back to Menu', 'menu:main');

  const msg = '❌ <b>Entry discarded.</b> Nothing was saved.\n\nWant to start over?';
  if (viaButton) {
    return ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb }));
  }
  return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
}

async function startLogSession(ctx, type, sessionDate) {
  ctx.session.awaitingLogDate  = null;
  ctx.session.logSession       = { type, sessionDate, measurements: [] };
  ctx.session.awaitingLogPhoto = true;
  ctx.session.awaitingLogKg    = false;
  const emoji   = type === 'cardboard' ? '📦' : '🍶';
  const dateTag = sessionDate === today() ? ' (today)' : '';
  await ctx.reply(
    `${emoji} <b>Logging ${type} — ${fmtDate(sessionDate)}${dateTag}</b>\n\n📷 Send a photo of measurement #1.`,
    { parse_mode: 'HTML', reply_markup: logPromptKb() }
  );
}

function askLogDate(type) {
  return new InlineKeyboard().text('📅 Today', `logdate:${type}:today`).row().text('← Back', 'menu:duty');
}

bot.callbackQuery('action:log:cardboard', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingLogDate = { type: 'cardboard' };
  await ctx.reply(
    `📦 <b>Log Cardboard</b>\n\nWhen was this collected? Tap Today, or type a past date to back-add a missed log (e.g. <code>20 Jun</code>).`,
    { parse_mode: 'HTML', reply_markup: askLogDate('cardboard') }
  );
});

bot.callbackQuery('action:log:plastic', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingLogDate = { type: 'plastic' };
  await ctx.reply(
    `🍶 <b>Log Plastic</b>\n\nWhen was this collected? Tap Today, or type a past date to back-add a missed log (e.g. <code>20 Jun</code>).`,
    { parse_mode: 'HTML', reply_markup: askLogDate('plastic') }
  );
});

bot.callbackQuery(/^logdate:(cardboard|plastic):today$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await startLogSession(ctx, ctx.match[1], today());
});

bot.callbackQuery('log:more', async (ctx) => {
  await ctx.answerCallbackQuery();
  const ls = ctx.session.logSession;
  if (!ls) return;
  ctx.session.awaitingLogPhoto = true;
  ctx.session.awaitingLogKg    = false;
  const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
  await ctx.reply(
    `${emoji} Send a photo of measurement #${ls.measurements.length + 1}.`,
    { parse_mode: 'HTML', reply_markup: logPromptKb() }
  );
});

bot.callbackQuery('log:done', async (ctx) => {
  await ctx.answerCallbackQuery();
  const ls = ctx.session.logSession;
  if (!ls || !ls.measurements.length) return;

  const total = Math.round(ls.measurements.reduce((s, m) => s + m.kg, 0) * 100) / 100;
  const lines = ls.measurements.map((m, i) => `  ${i + 1}. ${m.kg} kg`).join('\n');
  const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
  const text  =
    `${emoji} <b>Confirm ${ls.type} log — ${fmtDate(ls.sessionDate)}</b>\n\n${lines}\n\n` +
    `<b>Total: ${total} kg</b>\n\nSave this?`;
  const kb = new InlineKeyboard().text('✅ Confirm', 'log:confirm').text('✖️ Cancel', 'log:cancel');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
});

bot.callbackQuery('log:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  return cancelLogFlow(ctx, { viaButton: true });
});

// Compares a just-logged total against the trailing average for that type
// (summed per session_date, last 8 sessions). Needs at least 3 prior sessions
// of history before it'll flag anything, to avoid false positives early on.
const ANOMALY_THRESHOLD_MULTIPLIER = parseFloat(process.env.ANOMALY_THRESHOLD_MULTIPLIER || '1.75');
const ANOMALY_MIN_HISTORY = 3;
const ANOMALY_SAMPLE_SIZE = 8;

async function checkAnomaly(type, total) {
  const supa = db.getClient();
  if (!supa) return { isAnomaly: false };

  const { data: logs } = await supa.from('data_logs')
    .select('session_date, kg')
    .eq('type', type)
    .order('session_date', { ascending: false })
    .limit(300);
  if (!logs?.length) return { isAnomaly: false };

  const byDate = new Map();
  for (const l of logs) byDate.set(l.session_date, (byDate.get(l.session_date) || 0) + Number(l.kg));

  const sessionTotals = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, kg]) => kg);

  if (sessionTotals.length < ANOMALY_MIN_HISTORY) return { isAnomaly: false };

  const sample = sessionTotals.slice(0, ANOMALY_SAMPLE_SIZE);
  const avg    = sample.reduce((s, v) => s + v, 0) / sample.length;
  const isAnomaly = avg > 0 && total > avg * ANOMALY_THRESHOLD_MULTIPLIER;

  return { isAnomaly, avg: Math.round(avg * 10) / 10 };
}

// Writes the confirmed log to data_logs, rolls up the month, and replies —
// shared by the normal-total path and the anomaly-reason path.
async function finalizeLogSave(ctx, ls, name, total, anomalyNote) {
  ctx.session.logSession            = null;
  ctx.session.awaitingLogPhoto      = false;
  ctx.session.awaitingLogKg         = false;
  ctx.session.awaitingAnomalyReason = false;
  ctx.session.pendingAnomaly        = null;

  const isBackdated = ls.sessionDate !== today();
  const noteParts = [isBackdated ? 'Backdated entry' : '', anomalyNote ? `Reason for spike: ${anomalyNote}` : '']
    .filter(Boolean);
  const notes = noteParts.join(' — ');

  for (const m of ls.measurements) {
    await db.insertDataLog({
      session_date: ls.sessionDate, type: ls.type, kg: m.kg,
      image_url: m.imageUrl, file_id: m.fileId,
      notes,
      logged_by: name,
      created_at: new Date().toISOString(),
    });
  }

  await rollUpMonthlyTotal(
    ls.sessionDate,
    ls.type === 'cardboard' ? total : 0,
    ls.type === 'plastic'   ? total : 0
  );
  try { require('../routes/recycling').bustCache(); } catch (_) {}

  const impact = carbon.calcCO2e(ls.type === 'cardboard' ? total : 0, ls.type === 'plastic' ? total : 0);
  const emoji  = ls.type === 'cardboard' ? '📦' : '🍶';
  const n      = ls.measurements.length;

  await ctx.reply(
    `${emoji} <b>Logged!</b>\n\n${n} measurement${n > 1 ? 's' : ''} · <b>${total} kg</b> ${ls.type}\n` +
    `🌍 CO₂e avoided: <b>${impact.co2eKg} kg</b>\n📅 ${fmtDate(ls.sessionDate)}${isBackdated ? ' (backdated)' : ''}` +
    `${anomalyNote ? `\n📝 <i>${anomalyNote}</i>` : ''}`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  return sendMainMenu(ctx);
}

bot.callbackQuery('log:confirm', async (ctx) => {
  await ctx.answerCallbackQuery();
  const ls = ctx.session.logSession;
  if (!ls) return;
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const total   = Math.round(ls.measurements.reduce((s, m) => s + m.kg, 0) * 100) / 100;
  const anomaly = await checkAnomaly(ls.type, total);

  if (anomaly.isAnomaly) {
    ctx.session.awaitingAnomalyReason = true;
    ctx.session.pendingAnomaly        = { ls, name, total };
    const kb = new InlineKeyboard().text('Nothing special — just save it', 'log:anomalyskip');
    const text =
      `📈 <b>Heads up</b> — ${total} kg is well above the usual average for ${ls.type} (~${anomaly.avg} kg).\n\n` +
      `Anything special happening (a big event, planned contractor collection, etc.)? This helps explain spikes later when someone looks back.\n\n` +
      `Type a reason, or tap the button to save without one.`;
    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  }

  return finalizeLogSave(ctx, ls, name, total, '');
});

bot.callbackQuery('log:anomalyskip', async (ctx) => {
  await ctx.answerCallbackQuery();
  const pending = ctx.session.pendingAnomaly;
  if (!pending) return;
  return finalizeLogSave(ctx, pending.ls, pending.name, pending.total, '');
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
  ctx.session.availSlots    = monthSlots;
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
    const sessLabel = (s.session && s.session !== '?') ? ` (${s.session})` : '';
    const sessIcon  = s.session === 'GPC' ? ' 🟣' : s.session === 'SAT' ? ' 🟡' : s.session === '?' ? '' : ' 🟢';
    kb.text(`${prefix}${fmtDateShort(s.date)}${sessIcon}${sessLabel}`, `avail:toggle:${s.date}`).row();
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

  // Recover slots from session, or fall back to reading dates from the keyboard buttons
  let slots = ctx.session.availSlots || [];
  if (!slots.length) {
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard || [];
    const dates = rows.flat()
      .filter(b => b.callback_data?.startsWith('avail:toggle:'))
      .map(b => b.callback_data.replace('avail:toggle:', ''));
    slots = dates.map(d => ({ date: d, session: '?' }));
    ctx.session.availSlots = slots;
    ctx.session.availDates = dates;
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
  const unavail = ctx.session.availSelected || [];
  const reasons = ctx.session.unavailReasons || {};

  // Recover month from session or parse from the message header text
  let month = ctx.session.availMonth;
  if (!month) {
    const msgText = ctx.callbackQuery.message?.text || '';
    const mm = msgText.match(/—\s+(.+)/);
    if (mm) month = mm[1].trim();
  }

  // Recover all dates from session or from keyboard buttons
  let allD = ctx.session.availDates || [];
  if (!allD.length && ctx.session.availSlots?.length) {
    allD = ctx.session.availSlots.map(s => s.date);
  }
  if (!allD.length) {
    // Last resort: read from the keyboard (the avail:submit button is on this message)
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard || [];
    allD = rows.flat()
      .filter(b => b.callback_data?.startsWith('avail:toggle:'))
      .map(b => b.callback_data.replace('avail:toggle:', ''));
  }
  const avail = allD.filter(d => !unavail.includes(d));

  if (!month) return ctx.reply('⚠️ Session expired. Please try again.', { reply_markup: backToMain() });

  // Stage everything and ask one more general question before actually saving.
  ctx.session.pendingAvailSave   = { month, name, avail, unavail, reasons };
  ctx.session.awaitingMonthlyNote = true;

  const text =
    `📝 Last thing — is anything happening this month we should know about?\n\n` +
    `<i>e.g. celebrating a wedding or birthday, an unusually busy work stretch, travel, exams — anything that might affect your availability or energy for duty.</i>\n\n` +
    `Type your answer, or tap Skip.`;
  const kb = new InlineKeyboard().text('Skip', 'avail:skipmonthlynote');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
});

async function finalizeAvailability(ctx, monthlyNote) {
  const pending = ctx.session.pendingAvailSave;
  ctx.session.pendingAvailSave    = null;
  ctx.session.awaitingMonthlyNote = false;
  if (!pending) return sendMainMenu(ctx);

  const { month, name, avail, unavail, reasons } = pending;
  const note = (monthlyNote || '').trim();
  const hasReasons = Object.keys(reasons).length > 0;
  const notes = (hasReasons || note)
    ? JSON.stringify({ reasons, monthlyNote: note })
    : '';
  await db.saveAvailability(month, name, avail, unavail, notes);

  ctx.session.availMonth            = null;
  ctx.session.availDates            = [];
  ctx.session.availSlots            = [];
  ctx.session.availSelected         = [];
  ctx.session.unavailReasons        = {};
  ctx.session.awaitingUnavailReason = null;

  const lines = unavail.length
    ? unavail.map(d => {
        const r = reasons[d];
        return `❌ ${fmtDateShort(d)}${r ? ` — <i>${r}</i>` : ''}`;
      }).join('\n')
    : '✅ All clear — you\'re available for every date!';

  const noteLine = note ? `\n\n📝 <i>${note}</i>` : '';

  const msg =
    `✅ <b>Submitted for ${month}!</b>\n\n${lines}${noteLine}\n\n` +
    `<i>Your TL will see this when planning the roster.</i>`;

  return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: backToMain() });
}

bot.callbackQuery('avail:skipmonthlynote', async (ctx) => {
  await ctx.answerCallbackQuery();
  return finalizeAvailability(ctx, '');
});

bot.callbackQuery('avail:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.availMonth            = null;
  ctx.session.availDates            = [];
  ctx.session.availSlots            = [];
  ctx.session.availSelected         = [];
  ctx.session.unavailReasons        = {};
  ctx.session.awaitingUnavailReason = null;
  ctx.session.pendingAvailSave      = null;
  ctx.session.awaitingMonthlyNote   = false;
  const kb = await buildMainMenu(ctx);
  await ctx.editMessageText('🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML', reply_markup: kb,
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

  // Get all registered members, minus anyone duty-exempt (active on the team
  // but never rostered — no point asking them for physical-duty unavailability)
  const exemptNames = new Set(await db.getDutyExemptNames());
  const members = (await db.getAllRegisteredMembers()).filter(m => !exemptNames.has((m.name || '').toLowerCase()));
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
  const lines = members.map((m, i) => `${i + 1}. <b>${m.name}</b>${m.telegram_username ? ` — @${m.telegram_username}` : ''}`).join('\n');
  await ctx.editMessageText(
    `👥 <b>Registered Members (${members.length})</b>\n\n${lines}`,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// Admin: Member Profiles — service day / CG / other ministries / DOB for
// everyone, in one place for manual roster planning (combine with
// "Edit Member Availability" / the availability table for unavailabilities).
bot.callbackQuery('admin:profiles', async (ctx) => {
  await ctx.answerCallbackQuery();
  const supa = db.getClient();
  if (!supa) {
    return ctx.editMessageText('⚠️ Supabase not configured.', { reply_markup: backToAdmin() });
  }
  const roster = await db.getMemberRoster();
  if (!roster.length) {
    return ctx.editMessageText('No active members yet.', { reply_markup: backToAdmin() });
  }
  const lines = roster.map((m, i) => {
    const service   = serviceLabel(m.service_preference);
    const cg        = m.cg || '—';
    const ministry  = m.other_ministries || '—';
    const dob       = m.date_of_birth ? fmtDateShort(m.date_of_birth) : '—';
    const exemptTag = m.duty_exempt ? ' 🚫<i>not on duty</i>' : '';
    return `${i + 1}. <b>${m.name}</b>${exemptTag} — ${service} · CG: ${cg} · Ministries: ${ministry} · 🎂 ${dob}`;
  }).join('\n');
  await ctx.editMessageText(
    `📇 <b>Member Profiles (${roster.length})</b>\n\n${lines}\n\n` +
    `<i>"—" means they haven't filled in their profile yet (bot menu → ✏️ My Profile).</i>`,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// ─── Admin: Excuse member from roster ─────────────────────────────────────────
bot.callbackQuery('admin:excuse', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingExcuseName = true;
  await ctx.editMessageText(
    `🤰 <b>Excuse Member from Roster</b>\n\n` +
    `Send the member's name and the date to excuse them until (inclusive):\n\n` +
    `Format: <code>Clarice 2026-11-30</code>\n\n` +
    `<i>They will be removed from all slots from today up to that date.\n` +
    `Their member_roster status will be set to inactive until that date.</i>`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
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
  // Waiting for a photo for the current measurement in an active log session
  if (ctx.session.awaitingLogPhoto && ctx.session.logSession) {
    ctx.session.awaitingLogPhoto = false;

    const name = await resolveName(ctx);
    if (!name) return promptRegister(ctx);

    const ls    = ctx.session.logSession;
    const photo = ctx.message.photo.at(-1);
    let imageUrl = null;
    try {
      const file    = await bot.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const resp    = await fetch(fileUrl, { signal: AbortSignal.timeout(10000) });
      const buffer  = Buffer.from(await resp.arrayBuffer());
      const fname   = `${ls.sessionDate}_${name.replace(/\s+/g, '_')}_${ls.type}_${Date.now()}.jpg`;
      imageUrl      = await db.uploadImage(buffer, fname, 'image/jpeg');
    } catch (err) {
      console.warn('[Bot] Image upload failed:', err.message);
    }

    ls.measurements.push({ kg: null, fileId: photo.file_id, imageUrl });
    ctx.session.awaitingLogKg = true;
    const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
    return ctx.reply(
      `${emoji} <b>Photo #${ls.measurements.length} saved.</b>\n\nHow many kg was this measurement? (e.g. <code>42.5</code>)`,
      { parse_mode: 'HTML', reply_markup: logPromptKb() }
    );
  }

  // Photo sent without going through Log Cardboard/Plastic first
  if (ctx.chat.type === 'private') {
    return ctx.reply(
      '📷 Got a photo! To log a collection, tap <b>Log Cardboard</b> or <b>Log Plastic</b> from the menu first so I can record the weight too.',
      { parse_mode: 'HTML' }
    );
  }
});

// ─── Monthly rollup ───────────────────────────────────────────────────────────
// Adds `addCardboardKg`/`addPlasticKg` onto whatever recycling_monthly already
// has for the calendar month containing sessionDate (creates the row if it
// doesn't exist yet). Deliberately additive, NOT a re-sum of all data_logs for
// that month: many months (everything before the bot went live) have a
// recycling_monthly total sourced from the imported Total-sheet baseline with
// no matching data_logs rows at all. A full re-sum would silently overwrite
// that baseline down to just whatever's in data_logs — which is exactly how a
// back-added log for an old month could wipe out real history. Incrementing
// is safe for both old (imported) and new (bot-only) months.
async function rollUpMonthlyTotal(sessionDate, addCardboardKg = 0, addPlasticKg = 0) {
  try {
    const supa = db.getClient();
    if (!supa) return;
    const dt       = new Date(sessionDate + 'T00:00:00');
    const monthNum = String(dt.getMonth() + 1);  // '1'–'12' — matches recycling_monthly.month (text)
    const yearNum  = dt.getFullYear();

    const rows     = await db.query('recycling_monthly', { month: monthNum, year: yearNum });
    const existing = rows && rows[0];

    const newCardboard = Math.round(((existing?.cardboard_kg || 0) + addCardboardKg) * 100) / 100;
    const newPlastic   = Math.round(((existing?.plastic_kg   || 0) + addPlasticKg)   * 100) / 100;

    await db.upsertMonthlyTotal(monthNum, yearNum, newCardboard, newPlastic, 'logged');
  } catch (err) {
    console.warn('[Bot] Failed to update monthly totals:', err.message);
  }
}

// ─── Text handler — multi-step flows ─────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Typed cancel — safety net alongside the Cancel button, works at any stage
  // of the log flow (date entry, waiting for photo, waiting for weight) or the
  // swap-request / swap-acceptance flow.
  if (/^(cancel|stop|restart)$/i.test(text)) {
    if (ctx.session.awaitingLogDate || ctx.session.logSession) return cancelLogFlow(ctx);
    if (ctx.session.awaitingSwapDate || ctx.session.awaitingSwapReason || ctx.session.awaitingAcceptDate) {
      return cancelSwapFlow(ctx);
    }
  }

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
      await db.upsertMember(ctx.from.id, finalName, ctx.from.username);

      const matchNote = canonical.toLowerCase() !== text.trim().toLowerCase()
        ? `\n<i>(Matched to roster name: <b>${canonical}</b>)</i>` : '';

      // Matched an existing roster row, but this is still their first-ever
      // registration — collect their profile too (any pending deep-link
      // resumes automatically once finalizeProfile() finishes).
      await ctx.reply(`✅ Got it, <b>${finalName}</b>! 🌿${matchNote}`, { parse_mode: 'HTML' });
      return startProfileCollection(ctx, finalName, false);
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

  // Profile: CG — required, every member has one
  if (ctx.session.awaitingProfileCG && ctx.session.pendingProfile) {
    if (!text || text.length < 2 || /^(none|skip|-|n\/a)$/i.test(text)) {
      return ctx.reply(`👥 Which CG (cell group) are you part of?`, { parse_mode: 'HTML' });
    }
    ctx.session.pendingProfile.cg         = text;
    ctx.session.awaitingProfileCG         = false;
    ctx.session.awaitingProfileMinistries = true;
    return ctx.reply(
      `🙏 Are you serving in any other ministries? <i>(e.g. Ushering, Worship — type "None" if not.)</i>`,
      { parse_mode: 'HTML' }
    );
  }

  // Profile: other ministries
  if (ctx.session.awaitingProfileMinistries && ctx.session.pendingProfile) {
    ctx.session.pendingProfile.otherMinistries = /^(none|skip|-)$/i.test(text) ? null : text;
    ctx.session.awaitingProfileMinistries      = false;
    ctx.session.awaitingProfileDob             = true;
    return ctx.reply(
      `🎂 What's your date of birth? <i>(e.g. 15 Aug 1995)</i>`,
      { parse_mode: 'HTML' }
    );
  }

  // Profile: date of birth — required, final step, then save
  if (ctx.session.awaitingProfileDob && ctx.session.pendingProfile) {
    const dob = parseDob(text);
    if (!dob) {
      return ctx.reply(
        `⚠️ "${text}" isn't a valid date. Please enter your date of birth like <code>15 Aug 1995</code>.`,
        { parse_mode: 'HTML' }
      );
    }
    ctx.session.pendingProfile.dob = dob;
    return finalizeProfile(ctx);
  }

  // Log — step 0: date typed instead of tapping "Today" (back-add a missed log)
  if (ctx.session.awaitingLogDate) {
    const { type } = ctx.session.awaitingLogDate;
    const parsed = parseLogDate(text);
    if (!parsed) {
      return ctx.reply(
        `⚠️ "${text}" isn't a valid date. Try a format like <code>20 Jun</code> or <code>20 Jun 2025</code>, or tap Today above.`,
        { parse_mode: 'HTML', reply_markup: logPromptKb() }
      );
    }
    if (parsed > today()) {
      return ctx.reply(
        `⚠️ That's in the future — enter a past date, or tap Today.`,
        { parse_mode: 'HTML', reply_markup: logPromptKb() }
      );
    }
    return startLogSession(ctx, type, parsed);
  }

  // Anomaly reason — typed instead of tapping "Nothing special"
  if (ctx.session.awaitingAnomalyReason && ctx.session.pendingAnomaly) {
    const { ls, name, total } = ctx.session.pendingAnomaly;
    return finalizeLogSave(ctx, ls, name, total, text);
  }

  // Log — weight for the current measurement (after its photo was received)
  if (ctx.session.awaitingLogKg && ctx.session.logSession) {
    const kg = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(kg) || kg <= 0 || kg > 5000) {
      return ctx.reply(
        `⚠️ Enter a valid weight in kg, e.g. <code>42.5</code>`,
        { parse_mode: 'HTML', reply_markup: logPromptKb() }
      );
    }
    ctx.session.awaitingLogKg = false;
    const ls   = ctx.session.logSession;
    const last = ls.measurements[ls.measurements.length - 1];
    last.kg    = kg;

    const runningTotal = Math.round(ls.measurements.reduce((s, m) => s + m.kg, 0) * 100) / 100;
    const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
    return ctx.reply(
      `${emoji} Measurement #${ls.measurements.length}: <b>${kg} kg</b>\n` +
      `Running total: <b>${runningTotal} kg</b>\n\n` +
      `Is there another measurement to add for this same session? ` +
      `<i>(e.g. a second box that was weighed separately)</i>`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
          .text('➕ Add another', 'log:more').text('✅ That\'s all', 'log:done').row()
          .text('✖️ Cancel', 'log:cancel') }
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

  // Monthly "anything happening this month?" note — final step after Submit
  if (ctx.session.awaitingMonthlyNote) {
    return finalizeAvailability(ctx, text);
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

    const exemptNames = new Set(await db.getDutyExemptNames());
    const members = (await db.getAllRegisteredMembers()).filter(m => !exemptNames.has((m.name || '').toLowerCase()));
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

  // Admin: excuse member from roster — format: "Clarice 2026-11-30"
  if (ctx.session.awaitingExcuseName) {
    ctx.session.awaitingExcuseName = false;
    const parts      = text.trim().split(/\s+/);
    const untilDate  = parts[parts.length - 1];
    const memberName = parts.slice(0, -1).join(' ');

    if (!memberName || !/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
      return ctx.reply(
        `⚠️ Invalid format. Use: <code>Clarice 2026-11-30</code>`,
        { parse_mode: 'HTML', reply_markup: backToAdmin() }
      );
    }

    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');

    const todayStr = new Date().toISOString().split('T')[0];

    // Remove member from all roster_slots between today and untilDate
    const { data: slotsToUpdate } = await supa.from('roster_slots')
      .select('id, date, team')
      .gte('date', todayStr)
      .lte('date', untilDate)
      .contains('team', [memberName]);

    let slotsChanged = 0;
    for (const slot of (slotsToUpdate || [])) {
      const newTeam = (slot.team || []).filter(n => n !== memberName);
      await supa.from('roster_slots')
        .update({ team: newTeam, updated_at: new Date().toISOString() })
        .eq('id', slot.id);
      slotsChanged++;
    }

    // Mark member inactive in member_roster
    // NOTE: member_roster has no `notes` column — writing to it used to make
    // this whole update silently fail, so is_active never actually flipped.
    // Use the real `excused_until` column instead (see add_excused_until_column.sql).
    const { error: excuseErr } = await supa.from('member_roster')
      .update({ is_active: false, excused_until: untilDate, updated_at: new Date().toISOString() })
      .ilike('name', memberName);
    if (excuseErr) console.error('[Bot] admin:excuse update failed:', excuseErr.message);

    return ctx.reply(
      `✅ <b>${memberName}</b> excused until <b>${untilDate}</b>\n\n` +
      `📋 Removed from <b>${slotsChanged}</b> upcoming slot${slotsChanged !== 1 ? 's' : ''}\n` +
      `🔒 Marked inactive in member roster\n\n` +
      `<i>To reinstate, use /admin → Excuse Member again with a past date, or update Supabase directly.</i>`,
      { parse_mode: 'HTML', reply_markup: backToAdmin() }
    );
  }

  // Swap: step 1 — collect date
  if (ctx.session.awaitingSwapDate) {
    const dateMatch = text.match(/^((\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?)/);
    if (!dateMatch || !isValidDayMonth(parseInt(dateMatch[2]), dateMatch[3], dateMatch[4])) {
      return ctx.reply(
        `⚠️ "${text}" isn't a valid date. Try a format like <code>28 Jun</code>.`,
        { parse_mode: 'HTML', reply_markup: swapPromptKb() }
      );
    }
    ctx.session.awaitingSwapDate   = false;
    ctx.session.pendingSwapDate    = dateMatch[1].trim();
    ctx.session.awaitingSwapReason = true;
    return ctx.reply(
      `📅 Date: <b>${ctx.session.pendingSwapDate}</b>\n\n📝 What's the reason for swapping?`,
      { parse_mode: 'HTML', reply_markup: swapPromptKb() }
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
    const dateMatch = text.match(/^((\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?)/);
    if (!dateMatch || !isValidDayMonth(parseInt(dateMatch[2]), dateMatch[3], dateMatch[4])) {
      return ctx.reply(
        `⚠️ "${text}" isn't a valid date. Try a format like <code>5 Jul</code>.`,
        { parse_mode: 'HTML', reply_markup: swapPromptKb() }
      );
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
