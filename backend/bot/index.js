'use strict';
// ─── Susty Ministry Telegram Bot ─────────────────────────────────────────────
// Button-driven UX. Three main menus:
//   📋 Roster       → My Roster, Next Duty, Full Roster, Swaps, Request Swap
//   🪣 Recycling Logs → Log Cardboard, Log Plastic (+ photo + caption)
//   📊 Stats        → Team Stats, Year on Year, My Stats
// ─────────────────────────────────────────────────────────────────────────────

const {
  Bot, InlineKeyboard, webhookCallback, session, InputFile,
} = (() => {
  try { return require('grammy'); }
  catch { throw new Error('grammy not installed — run: npm install grammy'); }
})();

const db     = require('../utils/supabase');
const carbon = require('../utils/carbon');
const commsNotify = require('../utils/commsNotify');
function getReminders() {
  try { return require('../utils/reminders'); } catch { return null; }
}
function getRosterImage() {
  try { return require('../utils/rosterImage'); } catch (err) {
    console.warn('[rosterImage] not available:', err.message);
    return null;
  }
}

// Who gets pinged when a roster broadcast hits a problem (image render/send
// failure, or a team-name mismatch) — defaults to Brendon. Comma-separated
// names, set ROSTER_ALERT_NAMES on Railway to add more.
const ROSTER_ALERT_NAMES = (process.env.ROSTER_ALERT_NAMES || 'Brendon').split(',').map(n => n.trim());

// DMs each name in ROSTER_ALERT_NAMES (looked up in `members` by telegram_id,
// same pattern as reminders.js's ccDutyReminders/TL digest). Best-effort —
// a missing/un-registered alert name is skipped silently, but any send
// failure is logged so it shows up in Railway logs at least.
async function notifyRosterAlert(message) {
  const supa = db.getClient();
  if (!supa) return;
  for (const alertName of ROSTER_ALERT_NAMES) {
    const { data: person } = await supa.from('members').select('telegram_id').ilike('name', alertName).single();
    if (!person?.telegram_id) continue;
    await bot.api.sendMessage(person.telegram_id, message, { parse_mode: 'HTML' })
      .catch(err => console.warn('[rosterAlert] failed to DM', alertName, ':', err.message));
  }
}

// Cross-checks every team member name in a batch of roster_slots against the
// current active member_roster (name or alias, case-insensitive) — catches
// typos, stale names, or anyone who's left/been deactivated (e.g. Boone)
// still sitting in roster_slots.team before it goes out to the whole group.
// Returns [] if everything matches.
async function findRosterNameMismatches(mSlots) {
  const supa = db.getClient();
  if (!supa) return [];
  const roster = await db.getMemberRoster(); // is_active = true only
  const validNames = new Set();
  for (const m of roster) {
    validNames.add(m.name.toLowerCase());
    for (const a of (m.aliases || [])) validNames.add(a.toLowerCase());
  }
  const mismatches = [];
  for (const s of mSlots) {
    for (const name of (s.team || [])) {
      if (!validNames.has(String(name).toLowerCase())) {
        mismatches.push({ date: s.date, session: s.session, name });
      }
    }
  }
  return mismatches;
}

function getFallbackRoster() {
  try { return require('../data/roster.json'); } catch { return []; }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_CHAT_ID;
// Private test channel/group for trying out roster broadcasts (calendar
// image, etc.) before they go out to the real group. Set TELEGRAM_TEST_CHAT_ID
// on Railway to the test channel's chat ID (same -100... format as GROUP_ID).
const TEST_GROUP_ID = process.env.TELEGRAM_TEST_CHAT_ID;

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
    editingIndex:       null,   // measurements[] index being edited (weight or photo) from the review/edit screen — null when just adding a new one
    awaitingAnomalyReason: false, // waiting for a reason after an unusually high total was confirmed
    pendingAnomaly:        null,  // { ls, name, total } — staged until the anomaly reason step finishes
    pendingSwapDate:    null,   // ISO date the member picked from their upcoming-duties list
    awaitingSwapReason: false,
    pendingSwapReason:  null,   // set once reason is collected, awaiting final Confirm tap
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
    // Sequential per-date unavailability reason collection (after Submit,
    // one date at a time — reasons live in pendingAvailSave.reasons as
    // they're collected, not here)
    awaitingSeqUnavailReason: null, // date currently awaiting a typed reason
    availReasonQueue:      [],     // remaining unavail dates still needing a reason
    availReasonTotal:      0,      // for the "Reason X of N" progress line
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
    awaitingSendCalendarMonth: false, // TL: waiting for month input for Send Roster to Group
    awaitingEditAvailName: false,  // TL: waiting for member name to clear availability
    awaitingExcuseName:    false,  // TL: waiting for "Name YYYY-MM-DD" to excuse a member
    awaitingExcuseDate:    null,   // member name once entered, now waiting for end date
    // Comms post review (added for portal planning calendar workflow)
    awaitingCommsReject:      null,  // comms_posts id: TL is typing feedback to send back to the tagged member(s)
    awaitingCommsScheduleTime: null, // comms_posts id: TL is typing a time-of-day for the scheduled "time to post" ping
    // GPC W2R Check-in (one-off, added 8 Jul 2026)
    pendingGpcCheckin:         null,  // { ministry_status, other_ministry?, duration?, arrival_note? } — staged until final save
    awaitingGpcOtherMinistry:  false, // waiting for free-text ministry name after "Also another ministry" tap
    awaitingGpcArrivalNote:    false, // waiting for free-text arrival note after "Just a short while" tap
  }),
}));

// ─── Group → PM redirect ──────────────────────────────────────────────────────
// The bot should never actually interact with members inside the main group —
// only via PM. This silently swallows EVERY incoming update from a
// group/supergroup chat (any message type: text, commands — including
// /start — photos, stickers, docs, voice, etc., AND any inline-button tap)
// before it reaches session/menu logic below — no reply of any kind, so the
// bot never posts in the group in response to a member.
// (There used to be a /start exception here on the theory that Telegram
// deep-links might route through the group — that's wrong: t.me/<bot>?start=
// links always open a private chat with the bot, never post /start into a
// group. Removed 3 Jul 2026 after Brendon found the bot still replying to
// /start in the group.)
// Note: this only affects updates members SEND to the bot in the group. Bot-
// initiated broadcasts the team leads rely on (swap request posts, roster
// calendar posts, swap-matched confirmations — all via GROUP_ID) are a
// separate, one-way outbound path and are unaffected by this guard.
// (Previously sent a rate-limited "message me in PM" nudge — removed 3 Jul
// 2026 per Brendon: no bot activity in the group at all, full stop.)
const GROUP_TYPES = ['group', 'supergroup'];
// Still needed elsewhere (swap "Accept swap" deep-link button uses the
// bot's own username to build a t.me/<username>?start=... URL).
const BOT_USERNAME_PROMISE = bot.api.getMe().then(me => me.username).catch(() => null);

bot.use(async (ctx, next) => {
  if (!GROUP_TYPES.includes(ctx.chat?.type)) return next();

  // Inline button taps on any bot message posted in the group — answer
  // silently (no popup, no reply) so nothing visibly happens.
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  // Every update type — including /start and every other command, photos,
  // stickers, docs, voice, plain text, etc. — is swallowed here. No reply,
  // nothing reaches bot logic.
  return;
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
// Same list, original casing, for display in member-facing messages (e.g.
// "message Brendon, Judy or Wee Shing directly").
const TL_DISPLAY_NAMES = (() => {
  const names = (process.env.TL_NAMES || 'Brendon,Judy,Wee Shing').split(',').map(n => n.trim());
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
})();
async function isTL(ctx) {
  const name = await resolveName(ctx);
  return name ? TL_NAMES.includes(name.toLowerCase()) : false;
}

// ─── Feature rollout phases ────────────────────────────────────────────────
// Soft-launch schedule agreed with Brendon (2 Jul 2026, roster unlocked early 2 Jul):
//   Phase 1 (now):        Roster viewing + duty-swap requests live for regular members
//   Recycling Logs:       manually toggled live by Brendon when he's ready — NOT
//                          date-driven. Planned for around Sat 4 Jul, but only goes
//                          live once RECYCLING_LOGS_LIVE=true is set on Railway (no
//                          redeploy needed). See recyclingLogsLive() below.
//   Phase 3 (Sat 11 Jul): full bot + portal launch — everything unlocked (Stats, Profile, Availability)
// TLs (TL_NAMES) always see the full menu regardless of phase/toggle, so they can
// test/admin ahead of each unlock. Dates are Singapore time (+08:00).
const PHASE_3_DATE = new Date('2026-07-11T00:00:00+08:00');
function currentPhase() {
  const now = new Date();
  if (now >= PHASE_3_DATE) return 3;
  return 1;
}
// ─── Generic bot_settings boolean toggles ─────────────────────────────────
// Backs manual feature switches that need to (a) survive Railway restarts —
// a plain in-memory flag resets on every redeploy — and (b) be flippable by
// Brendon from inside the bot itself via /admin, not just Railway env vars.
// Each setting also accepts an env-var hard override, and phase 3 (11 Jul
// full launch) always forces everything on regardless of these toggles.
// Cached 30s per key so menu renders don't hit Supabase every time.
const _settingsCache = {};
async function getBoolSetting(key, envOverrideVar) {
  if (envOverrideVar && process.env[envOverrideVar] === 'true') return true;
  if (currentPhase() >= 3) return true;

  const now = Date.now();
  const cached = _settingsCache[key];
  if (cached && now - cached.fetchedAt < 30000) return cached.value;

  const supa = db.getClient();
  if (!supa) return false;
  const { data } = await supa.from('bot_settings').select('value').eq('key', key).maybeSingle();
  const value = data?.value === 'true';
  _settingsCache[key] = { value, fetchedAt: now };
  return value;
}
async function setBoolSetting(key, value) {
  const supa = db.getClient();
  if (!supa) return { error: new Error('Supabase not configured') };
  const { error } = await supa.from('bot_settings')
    .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (!error) _settingsCache[key] = { value, fetchedAt: Date.now() };
  return { error };
}

// Recycling Logs (duty logging) — toggle via RECYCLING_LOGS_LIVE env var or
// /admin → "🚀 Toggle Recycling Logs Live".
function recyclingLogsLive() {
  return getBoolSetting('recycling_logs_live', 'RECYCLING_LOGS_LIVE');
}
// Duty-swap requests/browsing — paused 3 Jul 2026 while July's roster gets
// locked in (pending Kai Jie + Alan confirmations); Brendon will re-enable
// once Aug/Sep rosters go out. Toggle via SWAP_REQUESTS_LIVE env var or
// /admin → "🔄 Toggle Swap Requests Live".
function swapRequestsLive() {
  return getBoolSetting('swap_requests_live', 'SWAP_REQUESTS_LIVE');
}
// Roster broadcast test mode — when ON, "Send Roster to Group" posts to
// TELEGRAM_TEST_CHAT_ID instead of the real group. Deliberately does NOT use
// getBoolSetting() (that helper force-returns true once currentPhase() >= 3,
// which would wrongly force test mode ON after the 11 Jul full launch — this
// is a manual routing switch, unrelated to feature-rollout phases). Toggle
// via /admin → "🧪 Toggle Roster Test Mode".
async function rosterBroadcastTestMode() {
  if (process.env.ROSTER_TEST_MODE === 'true') return true;
  if (process.env.ROSTER_TEST_MODE === 'false') return false;
  const supa = db.getClient();
  if (!supa) return false;
  const { data } = await supa.from('bot_settings').select('value').eq('key', 'roster_broadcast_test_mode').maybeSingle();
  return data?.value === 'true';
}
// Availability broadcast test mode — when ON, "Collect Availability" only DMs
// the names listed in TEST_AS_REGULAR_NAMES instead of every registered
// member. Unlike the roster broadcast (which reroutes to a whole separate
// test channel), there's no equivalent "test DM" concept — individual DMs
// always go to a real person — so this reuses TEST_AS_REGULAR_NAMES (the
// existing "who's dogfooding right now" list) as the recipient allowlist.
// Deliberately NOT getBoolSetting() for the same reason as roster test mode:
// that helper force-returns true once currentPhase() >= 3, which would
// wrongly force this on after the 11 Jul full launch. Toggle via /admin →
// "🧪 Toggle Availability Test Mode".
async function availabilityBroadcastTestMode() {
  if (process.env.AVAILABILITY_TEST_MODE === 'true') return true;
  if (process.env.AVAILABILITY_TEST_MODE === 'false') return false;
  const supa = db.getClient();
  if (!supa) return false;
  const { data } = await supa.from('bot_settings').select('value').eq('key', 'availability_broadcast_test_mode').maybeSingle();
  return data?.value === 'true';
}
// Non-TL members who also get the full menu early (testers), on top of TLs.
const EARLY_ACCESS_NAMES = (process.env.EARLY_ACCESS_NAMES || 'Jonathan Poon,Esther')
  .split(',').map(n => n.trim().toLowerCase());
// Names in this list are forced into the gated regular-member experience even
// if they're a TL or in EARLY_ACCESS_NAMES — for dogfooding the rollout as a
// normal user without losing TL status elsewhere. Set on Railway (no redeploy
// needed) e.g. TEST_AS_REGULAR_NAMES=Brendon, and unset it when done testing.
const TEST_AS_REGULAR_NAMES = (process.env.TEST_AS_REGULAR_NAMES || '')
  .split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
async function hasEarlyAccess(ctx) {
  const name = await resolveName(ctx);
  if (name && TEST_AS_REGULAR_NAMES.includes(name.toLowerCase())) return false;
  if (await isTL(ctx)) return true;
  return name ? EARLY_ACCESS_NAMES.includes(name.toLowerCase()) : false;
}
// Use this (not raw isTL) for anything that decides what a TL gets to SEE
// (extra menu items, unrestricted date ranges, swap visibility, etc) — it
// respects TEST_AS_REGULAR_NAMES so Brendon's dogfooding override actually
// hides admin-only UI too. Raw isTL is still correct for gating admin
// ACTIONS (e.g. the /admin toggles) — he should still be able to operate
// those while dogfooding the regular-member view.
async function isTLForGating(ctx) {
  const name = await resolveName(ctx);
  if (name && TEST_AS_REGULAR_NAMES.includes(name.toLowerCase())) return false;
  return isTL(ctx);
}

// Comms has its own, smaller cast (commsNotify.COMMS_TL_NAMES — currently
// Judy + Brendon) than the ministry-wide roster/duty TL list, so a
// roster-only TL like Wee Shing doesn't see comms review/approval screens.
// Use this for anything comms-specific that decides who gets TL controls.
async function isCommsTL(ctx) {
  const name = await resolveName(ctx);
  if (!name) return false;
  if (TEST_AS_REGULAR_NAMES.includes(name.toLowerCase())) return false;
  return commsNotify.COMMS_TL_NAMES.map(n => n.toLowerCase()).includes(name.toLowerCase());
}
// Replies with a "not live yet" message and returns true if this feature is
// still gated for this user; call at the top of a gated handler and `return`
// if it resolves true. TLs and EARLY_ACCESS_NAMES bypass every gate.
// editMessageText throws (synchronously, caught below as a rejected promise)
// when there's no callback query to attach the edit to — so this is safe to
// call from both button-driven contexts (edits in place) and non-button ones
// like the /start deep-link (falls back to a fresh reply).
async function blockedByPhase(ctx, minPhase) {
  if (currentPhase() >= minPhase) return false;
  if (await hasEarlyAccess(ctx)) return false;
  const text = `🚧 <b>Coming soon!</b> This feature unlocks on <b>11 Jul</b>. Stay tuned 🌿`;
  const opts = { parse_mode: 'HTML', reply_markup: backToMain() };
  await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return true;
}
// Same idea as blockedByPhase, but for Recycling Logs specifically — gated on
// the manual RECYCLING_LOGS_LIVE switch rather than a fixed date.
async function blockedByRecyclingGate(ctx) {
  if (await recyclingLogsLive()) return false;
  if (await hasEarlyAccess(ctx)) return false;
  const text = `🚧 <b>Coming soon!</b> Recycling Logs isn't live yet. Stay tuned 🌿`;
  const opts = { parse_mode: 'HTML', reply_markup: backToMain() };
  await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return true;
}
// Swap requests/browsing/accepting — paused while the current month's roster
// gets locked in. TLs and EARLY_ACCESS_NAMES bypass (they still manage swaps
// already in flight / are testing ahead of general rollout).
async function blockedBySwapGate(ctx) {
  if (await swapRequestsLive()) return false;
  if (await isTLForGating(ctx)) return false;
  if (await hasEarlyAccess(ctx)) return false;
  const text =
    `🔒 <b>Duty swaps are paused for now</b> while this month's roster gets finalized. ` +
    `They'll reopen once the next roster goes out — stay tuned 🌿`;
  const opts = { parse_mode: 'HTML', reply_markup: backToMain() };
  await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return true;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtSlot(slot) {
  const team  = (slot.team || []).join(', ') || '—';
  const sess  = slot.session || '';
  const badge = sess === 'GPC' ? '🟣' : sess === 'SAT' ? '🟡' : '🟢';
  // fmtDateShort defined below — formats raw ISO date (e.g. "2026-07-05") as
  // DD MMM YYYY ("05 Jul 2026"). Previously this printed slot.date as-is,
  // which is why My Roster/Next Duty/Full Roster showed raw ISO dates.
  return `${badge} <b>${fmtDateShort(slot.date)}</b> (${sess})\n   👥 ${team}`;
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

// Last calendar day of the current month, ISO format. Regular members can
// only see roster info up to this date; TLs can see beyond it (e.g. next
// month's roster, while it's still being finalized/unannounced).
function endOfCurrentMonth() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return end.toISOString().split('T')[0];
}

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

// Normalizes any typed month string ("Jul 2026", "july 2026", "JULY  2026")
// to the canonical "July 2026" form that roster_slots comparisons use
// (built from `new Date(...).toLocaleDateString('en-SG', {month:'long', ...})`,
// which always returns the FULL month name). Without this, typing an
// abbreviated month like "Jul 2026" would never match an existing roster
// because "july 2026" !== "jul 2026" — this bit Send Roster to Group's
// specific-month option (4 Jul 2026: reported "no roster created" for a
// month that clearly had one, because Brendon typed "Jul" not "July").
// Returns null if unparseable.
function canonicalizeMonthLabel(input) {
  const parts = String(input).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const mIdx = MONTH_NAMES.findIndex(m => m.startsWith(parts[0].toLowerCase()));
  const year = parseInt(parts[1], 10);
  if (mIdx < 0 || isNaN(year)) return null;
  const name = MONTH_NAMES[mIdx];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
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

// Resolves roster slots for a given month label (e.g. "Aug 2026") from
// Supabase, falling back to generated Sat/Sun placeholder dates if that
// month's roster hasn't been created yet. Shared by every availability
// collection path (self-service My Availability, admin:collect, /collect).
async function getMonthSlots(monthLabel) {
  monthLabel = canonicalizeMonthLabel(monthLabel) || monthLabel;
  const supa = db.getClient();
  if (!supa) return { slots: [], generatedFallback: false };
  const { data: allSlots } = await supa.from('roster_slots').select('date, session').order('date');
  let slots = (allSlots || []).filter(s => {
    const label = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
    return label.toLowerCase() === monthLabel.toLowerCase();
  });
  let generatedFallback = false;
  if (!slots.length) {
    slots = generateWeekends(monthLabel);
    generatedFallback = slots.length > 0;
  }
  return { slots, generatedFallback };
}

// Returns "August 2026" for the month after today
function nextCalendarMonth() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
}

// Shared logic for accepting a swap — used by deep-link, post-registration
// resume, and the accept: callback. editMessageText falls back to ctx.reply
// automatically when there's no callback query to edit (the first two cases).
async function handleAcceptSwap(ctx, swapId, name) {
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');
  const { data: swap } = await supa.from('swap_requests').select('*').eq('id', swapId).single();
  if (!swap || swap.status !== 'open') {
    const t = `⚠️ Swap #${swapId} is no longer available.`;
    return ctx.editMessageText(t, { reply_markup: backToMain() }).catch(() => ctx.reply(t, { reply_markup: backToMain() }));
  }
  if (swap.requester_name.toLowerCase() === name.toLowerCase()) {
    const t = `⚠️ You can't accept your own swap.`;
    return ctx.editMessageText(t, { reply_markup: backToMain() }).catch(() => ctx.reply(t, { reply_markup: backToMain() }));
  }
  ctx.session.awaitingAcceptDate = {
    swapId, requesterName: swap.requester_name, requesterDate: swap.requester_date,
  };
  const t =
    `🔄 Accepting swap for <b>${swap.requester_name}</b>'s duty on <b>${swap.requester_date}</b>.\n\n` +
    `📅 What date are <b>you</b> offering in return? (e.g. <code>5 Jul</code>)`;
  return ctx.editMessageText(t, { parse_mode: 'HTML', reply_markup: swapPromptKb() })
    .catch(() => ctx.reply(t, { parse_mode: 'HTML', reply_markup: swapPromptKb() }));
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
  const phase = currentPhase();
  if (phase < 3 && !(await hasEarlyAccess(ctx))) {
    // Roster submenu already has "Open Swaps" / "Request Swap" — don't
    // duplicate those two at the top level too.
    const kb = new InlineKeyboard()
      .text('📋 Roster', 'menu:roster').row()
      .text('📢 Comms',  'menu:comms');
    if (await recyclingLogsLive()) kb.row().text('🪣 Recycling Logs', 'menu:duty');
    return kb;
  }

  const kb = new InlineKeyboard()
    .text('📋 Roster',         'menu:roster').row()
    .text('🪣 Recycling Logs', 'menu:duty').row()
    .text('📢 Comms',          'menu:comms').row()
    .text('📊 Stats & Impact', 'menu:stats').row()
    .text('✏️ My Profile',     'menu:profile');
  if (showAvail) kb.row().text('📅 My Availability', 'menu:avail');
  return kb;
}

// Swap buttons are hidden entirely (not just gated on click) while swaps are
// paused — see swapRequestsLive(). TLs and EARLY_ACCESS_NAMES still see them
// (TLs to manage any swaps still in flight from before the pause; early
// access testers to test the flow ahead of general rollout).
async function buildRosterMenu(ctx) {
  const kb = new InlineKeyboard()
    .text('🗓 My Roster',   'action:myroster').text('⏭ Next Duty', 'action:nextduty').row()
    .text('📋 Full Roster', 'action:roster').row();
  if ((await swapRequestsLive()) || (await isTLForGating(ctx)) || (await hasEarlyAccess(ctx))) {
    kb.text('🔄 Open Swaps', 'action:swaps').text('📨 Request Swap', 'action:swap').row();
  }
  kb.text('← Back', 'menu:main');
  return kb;
}

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
  .text('🚀 Toggle Recycling Logs Live', 'admin:togglerecycling').row()
  .text('🔄 Toggle Swap Requests Live', 'admin:toggleswaps').row()
  .text('🧪 Toggle Roster Test Mode', 'admin:togglerostertest').row()
  .text('🧪 Toggle Availability Test Mode', 'admin:toggleavailtest').row()
  .text('🔔 Test Reminders Now', 'admin:testreminders').row()
  .text('📋 Send GPC W2R Check-in', 'admin:gpccheckin').row()
  .text('← Back', 'menu:main');

function backToMain() {
  return new InlineKeyboard().text('← Back to Menu', 'menu:main');
}

// Used by My Roster / Next Duty / Full Roster results — returns to the
// Roster submenu (not all the way out to the main menu), matching where the
// member tapped in from.
function backToRoster() {
  return new InlineKeyboard().text('← Back to Roster', 'menu:roster');
}

function swapPromptKb() {
  return new InlineKeyboard().text('✖️ Cancel', 'swap:cancel');
}

function swapConfirmKb() {
  return new InlineKeyboard()
    .text('✅ Confirm & Send', 'swap:confirm').row()
    .text('✖️ Cancel',         'swap:cancel');
}

// Discards an in-progress swap request or swap-acceptance flow.
async function cancelSwapFlow(ctx, { viaButton = false } = {}) {
  ctx.session.pendingSwapDate    = null;
  ctx.session.awaitingSwapReason = false;
  ctx.session.pendingSwapReason  = null;
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
  await ctx.answerCallbackQuery().catch(() => {});
  return cancelSwapFlow(ctx, { viaButton: true });
});

bot.callbackQuery('swap:confirm', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name     = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  const swapDate = ctx.session.pendingSwapDate;
  const reason   = ctx.session.pendingSwapReason;
  if (!swapDate || !reason) {
    return ctx.editMessageText('⚠️ This swap request has expired — please start again.', {
      parse_mode: 'HTML', reply_markup: backToMain(),
    }).catch(() => ctx.reply('⚠️ This swap request has expired — please start again.', { reply_markup: backToMain() }));
  }
  ctx.session.pendingSwapDate   = null;
  ctx.session.pendingSwapReason = null;

  const dateLabel = fmtDateShort(swapDate);
  let savedId = null;
  const supa = db.getClient();
  if (supa) {
    const { data, error } = await supa.from('swap_requests')
      .insert({ requester_name: name, requester_date: dateLabel, reason, status: 'open' })
      .select().single();
    if (error) console.error('[Bot] swap insert:', error.message);
    savedId = data?.id;
  }

  const groupMsg =
    `🔄 <b>Swap Request</b>\n\n` +
    `👤 <b>${name}</b> needs a swap for <b>${dateLabel}</b>\n📝 ${reason}\n\n` +
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

  const msg =
    `✅ <b>Swap request posted!</b>\n\n📅 ${dateLabel}\n📝 ${reason}\n\n` +
    `Team members will see it in the group and can accept via the bot.`;
  return ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: backToMain() })
    .catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: backToMain() }));
});

// Confirm / can't-make-it buttons attached to the 5-day and 1-day DM duty
// reminders (utils/reminders.js → confirmKb). These replace the old group
// broadcast — the whole point is the ask-and-response happens in PM only.
bot.callbackQuery(/^remind:confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Thanks for confirming! ✅' }).catch(() => {});
  const text = '✅ <b>Confirmed</b> — see you there! 💪🌿';
  await ctx.editMessageText(text, { parse_mode: 'HTML' })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML' }));
});

bot.callbackQuery(/^remind:cantmake:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});

  // Swap requests are currently paused for regular members (see
  // bot_settings.swap_requests_live, §3/§4a PROJECT_STATE) — sending them to
  // a Request Swap button that just says "paused" is a dead end. While
  // that's the case, tell them to message a TL directly instead. TLs
  // themselves always bypass the swap gate, so they still get routed there.
  if ((await swapRequestsLive()) || (await isTLForGating(ctx)) || (await hasEarlyAccess(ctx))) {
    const text =
      `⚠️ Got it — noted that you can't make it.\n\n` +
      `Please head to <b>Roster → Request Swap</b> so we can find someone to cover this slot.`;
    const kb = new InlineKeyboard().text('📋 Go to Roster', 'menu:roster');
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
  } else {
    const text =
      `⚠️ Got it — noted that you can't make it.\n\n` +
      `Duty swaps are paused for now, so please message <b>${TL_DISPLAY_NAMES}</b> directly to sort out coverage for this slot. 🙏`;
    await ctx.editMessageText(text, { parse_mode: 'HTML' })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML' }));
  }
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
    if (await blockedBySwapGate(ctx)) return;
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
  await ctx.answerCallbackQuery().catch(() => {});
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
  await ctx.answerCallbackQuery().catch(() => {});
  const kb = await buildMainMenu(ctx);
  await ctx.editMessageText('🌿 <b>Susty Ministry Bot</b>\n\nWhat do you need?', {
    parse_mode: 'HTML', reply_markup: kb,
  }).catch(() => sendMainMenu(ctx));
});

bot.callbackQuery('menu:roster', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(
    '📋 <b>Roster</b>\n\nView your duties, the full roster, or manage swaps.',
    { parse_mode: 'HTML', reply_markup: await buildRosterMenu(ctx) }
  );
});

bot.callbackQuery('menu:duty', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByRecyclingGate(ctx)) return;
  await ctx.editMessageText(
    '🪣 <b>Recycling Logs</b>\n\nLog your recycling — photo + weight for each measurement.\n\n' +
    '<i>💡 Missed logging on the day? You can back-add it — just type a past date when asked instead of tapping Today.</i>',
    { parse_mode: 'HTML', reply_markup: dutyMenu }
  );
});

bot.callbackQuery('menu:stats', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByPhase(ctx, 3)) return;
  await ctx.editMessageText(
    '📊 <b>Stats & Impact</b>\n\nSee how much W2R has recycled and the impact made.',
    { parse_mode: 'HTML', reply_markup: statsMenu }
  );
});

// ─── Comms (post planning / review) ────────────────────────────────────────────
// Planning (date, caption, image, details) happens in the portal's Comms tab —
// any member can propose a post there. The bot's job is the review layer: a
// member submits their (self-checked) post from the portal, which DMs every TL
// a preview with Approve/Reject here; once approved, a TL posts it manually
// and taps "Mark as Posted" to close the loop. See utils/commsNotify.js and
// routes/comms.js (POST /:id/submit) for the portal-side half of this.
function backToCommsKb() {
  return new InlineKeyboard().text('← Back', 'menu:comms');
}

function commsCancelKb() {
  return new InlineKeyboard().text('✖️ Cancel', 'comms:cancelflow');
}

function commsStatusLabel(status) {
  return (status || '').replace(/_/g, ' ');
}

bot.callbackQuery('menu:comms', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  const supa = db.getClient();

  if (await isCommsTL(ctx)) {
    let pendingCount = 0, approvedCount = 0;
    if (supa) {
      const { data: pr } = await supa.from('comms_posts').select('id').eq('status', 'pending_review');
      const { data: ap } = await supa.from('comms_posts').select('id').eq('status', 'approved');
      pendingCount = pr?.length || 0;
      approvedCount = ap?.length || 0;
    }
    const kb = new InlineKeyboard()
      .text(`✅ Pending Approvals (${pendingCount})`, 'menu:commsapprovals').row()
      .text(`📮 Ready to Post (${approvedCount})`, 'menu:commspost').row()
      .text('← Back', 'menu:main');
    return ctx.editMessageText(
      '📢 <b>Comms</b>\n\nPost planning happens in the portal Comms tab. Review and post from here.',
      { parse_mode: 'HTML', reply_markup: kb }
    ).catch(() => ctx.reply('📢 <b>Comms</b>', { parse_mode: 'HTML', reply_markup: kb }));
  }

  // Regular member — show what's waiting on them: tagged as an assignee, OR
  // (for older posts / self-proposed ones) named as owner/created_by.
  let mine = [];
  if (supa) {
    const { data } = await supa.from('comms_posts').select('*')
      .in('status', ['draft', 'pending_review', 'needs_changes'])
      .order('date');
    mine = (data || []).filter(p =>
      (Array.isArray(p.assignees) && p.assignees.includes(name)) ||
      p.created_by === name || p.owner === name
    );
  }
  const lines = mine.length
    ? mine.map(p =>
        `• ${fmtDateShort(p.date)} — ${commsNotify.escHtml(p.theme)} <i>(${commsStatusLabel(p.status)})</i>` +
        (p.rejected_reason && p.status === 'needs_changes' ? `\n   💬 ${commsNotify.escHtml(p.rejected_reason)}` : '')
      ).join('\n')
    : 'Nothing pending right now.';
  return ctx.editMessageText(
    `📢 <b>Comms</b>\n\nPlan and submit posts from the portal Comms tab.\n\n<b>Your posts:</b>\n${lines}`,
    { parse_mode: 'HTML', reply_markup: backToMain() }
  ).catch(() => ctx.reply('📢 Comms', { reply_markup: backToMain() }));
});

bot.callbackQuery('menu:commsapprovals', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return;
  const supa = db.getClient();
  const { data } = supa
    ? await supa.from('comms_posts').select('*').eq('status', 'pending_review').order('date')
    : { data: [] };
  if (!data?.length) {
    return ctx.editMessageText('✅ No posts waiting for review.', { reply_markup: backToCommsKb() })
      .catch(() => ctx.reply('✅ No posts waiting for review.', { reply_markup: backToCommsKb() }));
  }
  const kb = new InlineKeyboard();
  data.forEach(p => kb.text(`${fmtDateShort(p.date)} — ${(p.theme || '').slice(0, 40)}`, `comms:view:${p.id}`).row());
  kb.text('← Back', 'menu:comms');
  return ctx.editMessageText('✅ <b>Pending Approvals</b>\n\nTap a post to review.', { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply('✅ Pending Approvals', { reply_markup: kb }));
});

bot.callbackQuery('menu:commspost', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return;
  const supa = db.getClient();
  const { data } = supa
    ? await supa.from('comms_posts').select('*').eq('status', 'approved').order('date')
    : { data: [] };
  if (!data?.length) {
    return ctx.editMessageText('📮 No approved posts waiting to go live.', { reply_markup: backToCommsKb() })
      .catch(() => ctx.reply('📮 No approved posts waiting to go live.', { reply_markup: backToCommsKb() }));
  }
  const kb = new InlineKeyboard();
  data.forEach(p => kb.text(`${fmtDateShort(p.date)} — ${(p.theme || '').slice(0, 40)}`, `comms:view:${p.id}`).row());
  kb.text('← Back', 'menu:comms');
  return ctx.editMessageText('📮 <b>Ready to Post</b>\n\nTap a post to view + mark posted.', { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply('📮 Ready to Post', { reply_markup: kb }));
});

// Shows a full preview (image if attached) with the action buttons for
// whatever state the post is currently in. Sent as a fresh message (rather
// than edited in place) since the list message may be text-only but the
// preview may need to become a photo message.
function commsAssigneeLine(p) {
  const names = Array.isArray(p.assignees) && p.assignees.length
    ? p.assignees.map(commsNotify.escHtml).join(', ')
    : commsNotify.escHtml(p.created_by || p.owner || '—');
  return `👤 Tagged: ${names}`;
}

// Singapore-local "is this post's date today" check — the bot/Railway run in
// UTC, so this can't just compare against `new Date()` directly.
function isPostDateTodaySGT(dateStr) {
  const nowSGT = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const todaySGT = nowSGT.toISOString().split('T')[0];
  return dateStr === todaySGT;
}

// Parses free-typed times like "6pm", "6:30pm", "18:30" — returns {hour,min}
// in 24h, or null if unparseable.
function parseTimeOfDay(text) {
  const m = text.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (min > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, min };
}

bot.callbackQuery(/^comms:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return;
  const id = Number(ctx.match[1]);
  const supa = db.getClient();
  const { data: p } = supa ? await supa.from('comms_posts').select('*').eq('id', id).single() : { data: null };
  if (!p) return ctx.reply('⚠️ Post not found — it may have been edited or deleted.');

  // Comment count (added 9 Jul 2026, per Esther's feedback) — lets a TL
  // glancing at this preview know feedback has been left, without needing
  // to open the portal.
  let commentCount = 0;
  if (supa) {
    const { count } = await supa.from('comms_comments').select('id', { count: 'exact', head: true }).eq('post_id', id);
    commentCount = count || 0;
  }

  const caption =
    `📅 <b>${fmtDateShort(p.date)}</b>\n📝 <b>${commsNotify.escHtml(p.theme)}</b>\n` +
    (p.caption ? `\n"${commsNotify.escHtml(p.caption)}"\n` : '') +
    (p.details ? `\n🗒 ${commsNotify.escHtml(p.details)}\n` : '') +
    `\n${commsAssigneeLine(p)}\n📌 Status: ${commsStatusLabel(p.status)}` +
    (commentCount ? `\n💬 ${commentCount} comment${commentCount > 1 ? 's' : ''} (see the portal to read them)` : '');

  let kb;
  if (p.status === 'pending_review') {
    kb = new InlineKeyboard().text('✅ Approve', `comms:approve:${p.id}`).text('💬 Request Changes', `comms:requestchanges:${p.id}`);
  } else if (p.status === 'approved') {
    kb = new InlineKeyboard()
      .text('▶️ Post Now', `comms:postnow:${p.id}`).row()
      .text('⏰ Schedule Reminder Time', `comms:schedule:${p.id}`);
  } else {
    kb = backToCommsKb();
  }
  // TLs can delete straight away from here too, not just confirm a member's
  // portal-side deletion request.
  kb.row().text('🗑 Delete Post', `comms:confirmdelete:${p.id}`);

  await commsNotify.sendPostPreview(bot, ctx.chat.id, p, { caption, replyMarkup: kb });
});

bot.callbackQuery(/^comms:approve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  const name = await resolveName(ctx);
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  const { data: p, error } = await supa.from('comms_posts')
    .update({ status: 'approved', approved_by: name, approved_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error || !p) return ctx.reply('⚠️ Could not approve — post may no longer exist.');

  commsNotify.notifyAssigneesApproved(p).catch(() => {});

  // Always offer both options together — post right now, or pick an exact
  // reminder time — regardless of whether the post's date is today. (Used to
  // only show one or the other based on date, which read as a missing
  // button when a TL approved something scheduled for today but still
  // wanted to set a specific time later. Simpler and more predictable to
  // just always show both.)
  const doneMsg = isPostDateTodaySGT(p.date)
    ? `✅ Approved by ${name}. It's scheduled for today — post it whenever you're ready.`
    : `✅ Approved by ${name}. You'll get a reminder closer to ${fmtDateShort(p.date)} — or pick an exact time now.`;
  await ctx.editMessageCaption({ caption: doneMsg, parse_mode: 'HTML' })
    .catch(() => ctx.editMessageText(doneMsg, { parse_mode: 'HTML' }))
    .catch(() => ctx.reply(doneMsg));

  const kb = new InlineKeyboard()
    .text('▶️ Post Now', `comms:postnow:${p.id}`).row()
    .text('⏰ Schedule Reminder Time', `comms:schedule:${p.id}`);
  await ctx.reply('When you\'re ready:', { reply_markup: kb }).catch(() => {});
});

bot.callbackQuery(/^comms:requestchanges:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  ctx.session.awaitingCommsReject = id;
  await ctx.reply(
    '💬 What should change? Type your feedback — this gets sent straight to whoever\'s tagged on it, and the post stays linked so they can just edit and re-send (no need to start over).',
    { reply_markup: commsCancelKb() }
  );
});

bot.callbackQuery(/^comms:schedule:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  ctx.session.awaitingCommsScheduleTime = id;
  await ctx.reply(
    '⏰ What time should I remind you to post this (Singapore time)? e.g. <code>6:30pm</code> or <code>18:30</code>.',
    { parse_mode: 'HTML', reply_markup: commsCancelKb() }
  );
});

// Cancel button attached to the Request Changes / Schedule Time text
// prompts — clears whichever "awaiting" flag is set. Typing cancel/stop
// still works too (see the message:text handler's cancel block).
bot.callbackQuery('comms:cancelflow', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.session.awaitingCommsReject) {
    ctx.session.awaitingCommsReject = null;
    return ctx.editMessageText('Cancelled — post left as-is.').catch(() => ctx.reply('Cancelled — post left as-is.'));
  }
  if (ctx.session.awaitingCommsScheduleTime) {
    ctx.session.awaitingCommsScheduleTime = null;
    return ctx.editMessageText('Cancelled — no reminder time set.').catch(() => ctx.reply('Cancelled — no reminder time set.'));
  }
  return ctx.editMessageText('Nothing to cancel.').catch(() => {});
});

// Tapping this now does two things when a channel is configured
// (COMMS_CHANNEL_ID): actually publishes the image+caption there, THEN marks
// the post as posted — one tap instead of copy-pasting out to the channel
// manually. If publishing fails (bot not an admin there, wrong ID, etc.), the
// post is deliberately NOT marked posted, so a failed publish never shows as
// "done." Falls back to the original reminder-only behavior (just marks
// posted, TL already published it themselves elsewhere) if no channel is set.
bot.callbackQuery(/^comms:(?:markposted|postnow):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  const name = await resolveName(ctx);
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  const { data: post } = await supa.from('comms_posts').select('*').eq('id', id).single();
  if (!post) return ctx.reply('⚠️ Post not found — it may have been edited or deleted.');

  let publishNote = '';
  const result = await commsNotify.publishToCommsChannel(post);
  if (!result.skipped) {
    if (!result.ok) {
      return ctx.reply(
        `⚠️ Couldn't publish to the channel: ${result.error}\n\n` +
        `Nothing was marked posted. Fix the issue (bot needs to be an admin in the channel — check COMMS_CHANNEL_ID) and try again.`
      );
    }
    publishNote = result.link ? `\n🔗 ${result.link}` : '\n📮 Sent to the channel.';
  }

  const { data: p, error } = await supa.from('comms_posts')
    .update({ status: 'posted', posted_by: name, posted_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error || !p) return ctx.reply('⚠️ Published, but could not update the post status — check the portal.');

  const doneMsg = `📮 Marked as posted by ${name}. Nice work! 🌿${publishNote}`;
  await ctx.editMessageCaption({ caption: doneMsg, parse_mode: 'HTML' })
    .catch(() => ctx.editMessageText(doneMsg, { parse_mode: 'HTML' }))
    .catch(() => ctx.reply(doneMsg));
});

// A member requested deletion via the portal; TL confirms or keeps it.
bot.callbackQuery(/^comms:confirmdelete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  const { error } = await supa.from('comms_posts').delete().eq('id', id);
  if (error) return ctx.reply('⚠️ Could not delete — post may no longer exist.');

  const doneMsg = '🗑 Post deleted.';
  await ctx.editMessageText(doneMsg, { parse_mode: 'HTML' }).catch(() => ctx.reply(doneMsg));
});

bot.callbackQuery(/^comms:canceldelete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isCommsTL(ctx))) return ctx.reply('⚠️ TL only.');
  const id = Number(ctx.match[1]);
  const supa = db.getClient();
  if (!supa) return ctx.reply('⚠️ Supabase not configured.');

  const { error } = await supa.from('comms_posts')
    .update({ delete_requested: false, delete_requested_by: null })
    .eq('id', id);
  if (error) return ctx.reply('⚠️ Could not update — post may no longer exist.');

  const doneMsg = '↩️ Kept — post was not deleted.';
  await ctx.editMessageText(doneMsg, { parse_mode: 'HTML' }).catch(() => ctx.reply(doneMsg));
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
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByPhase(ctx, 3)) return;
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  return startProfileCollection(ctx, name, false);
});

bot.callbackQuery(/^profile:service:(SAT|SUN|BOTH)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!ctx.session.pendingProfile) return;
  const code = ctx.match[1];
  ctx.session.pendingProfile.service  = code;
  ctx.session.awaitingProfileService  = false;
  ctx.session.awaitingProfileCG       = true;
  const text = `✅ Service: <b>${serviceLabel(code)}</b>\n\n👥 Which CG are you part of?`;
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
  await ctx.answerCallbackQuery().catch(() => {});
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);
  if (slots === null) {
    const td = today();
    slots = getFallbackRoster().filter(s =>
      s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase())
    );
  }

  let hiddenLater = false;
  if (!(await isTLForGating(ctx))) {
    const cutoff = endOfCurrentMonth();
    const before = slots.length;
    slots = slots.filter(s => s.date <= cutoff);
    hiddenLater = slots.length < before;
  }

  const hint = hiddenLater ? '\n\n<i>Next month’s roster isn’t published yet.</i>' : '';
  const text = slots.length
    ? `🗓 <b>${name}'s Upcoming Duties</b>\n\n${slots.slice(0, 8).map(fmtSlot).join('\n\n')}${hint}`
    : `Hi <b>${name}</b>! No upcoming duties scheduled this month. 🎉${hint}`;

  // Edit the roster-menu message in place instead of posting a new bubble —
  // keeps everything in one chat message, and Back returns to the Roster
  // submenu (not all the way out to the main menu).
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToRoster() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToRoster() }));
});

bot.callbackQuery('action:nextduty', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  let slots = await db.getUpcomingRosterForMember(name);
  if (slots === null) {
    const td = today();
    slots = getFallbackRoster().filter(s =>
      s.date >= td && (s.team || []).some(t => t.toLowerCase() === name.toLowerCase())
    );
  }

  if (!(await isTLForGating(ctx))) {
    const cutoff = endOfCurrentMonth();
    slots = slots.filter(s => s.date <= cutoff);
  }

  if (!slots.length) {
    const emptyText = `Hi <b>${name}</b>! No upcoming duties this month. 🎉`;
    return ctx.editMessageText(emptyText, { parse_mode: 'HTML', reply_markup: backToRoster() })
      .catch(() => ctx.reply(emptyText, { parse_mode: 'HTML', reply_markup: backToRoster() }));
  }

  const next     = slots[0];
  const daysLeft = Math.ceil((new Date(next.date) - new Date()) / 86400000);
  const when     = daysLeft === 0 ? 'Today!' : daysLeft === 1 ? 'Tomorrow!' : `in ${daysLeft} days`;

  // Weekend view (added 9 Jul 2026, per Esther's feedback): if this member
  // is also rostered the adjacent SAT/SUN day of the same duty weekend,
  // show both together instead of just the earlier day.
  const weekendSlots = ['SAT', 'SUN'].includes(next.session)
    ? slots.filter(s => ['SAT', 'SUN'].includes(s.session) &&
        Math.abs(Math.round((new Date(s.date) - new Date(next.date)) / 86400000)) <= 1)
    : [next];
  const body = weekendSlots.length > 1
    ? weekendSlots.map(fmtSlot).join('\n\n')
    : fmtSlot(next);

  const text = `⏭ <b>${name}'s Next Duty</b>\n\n${body}\n\n⏳ <b>${when}</b>`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToRoster() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToRoster() }));
});

bot.callbackQuery('action:roster', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  let slots = await db.getUpcomingRoster(4);
  if (slots === null) {
    const td    = today();
    const limit = new Date(); limit.setDate(limit.getDate() + 28);
    slots = getFallbackRoster().filter(s =>
      s.date >= td && s.date <= limit.toISOString().split('T')[0]
    );
  }

  const admin = await isTLForGating(ctx);
  let heading = 'Next 4 Weeks';
  if (!admin) {
    const cutoff = endOfCurrentMonth();
    slots   = slots.filter(s => s.date <= cutoff);
    heading = 'This Month';
  }

  const text = slots.length
    ? `📋 <b>W2R Roster — ${heading}</b>\n\n${slots.map(fmtSlot).join('\n\n')}`
    : `No roster slots for ${admin ? 'the next 4 weeks' : 'the rest of this month'}.`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToRoster() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToRoster() }));
});

bot.callbackQuery('action:swaps', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedBySwapGate(ctx)) return;
  const supa = db.getClient();
  let swaps  = [];

  if (supa) {
    const { data } = await supa.from('swap_requests')
      .select('*').eq('status', 'open')
      .order('created_at', { ascending: false }).limit(10);
    swaps = data || [];
  }

  if (!swaps.length) {
    const emptyText = '✅ No open swap requests right now!';
    return ctx.editMessageText(emptyText, { reply_markup: backToRoster() })
      .catch(() => ctx.reply(emptyText, { reply_markup: backToRoster() }));
  }

  const kb = new InlineKeyboard();
  for (const s of swaps) {
    kb.text(`Accept #${s.id} — ${s.requester_name} · ${s.requester_date}`, `accept:${s.id}`).row();
  }
  kb.text('← Back to Menu', 'menu:main');

  const lines = swaps.map(s =>
    `🆔 <b>#${s.id}</b> — <b>${s.requester_name}</b> on <b>${s.requester_date}</b>\n   📝 ${s.reason || 'No reason'}`
  ).join('\n\n');

  const text = `🔄 <b>Open Swap Requests</b>\n\n${lines}\n\n<i>Tap a button below to accept.</i>`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
});

bot.callbackQuery(/^accept:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedBySwapGate(ctx)) return;
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  return handleAcceptSwap(ctx, parseInt(ctx.match[1]), name);
});

bot.callbackQuery('action:swap', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedBySwapGate(ctx)) return;
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
    const emptyText = `📨 <b>Request a Swap</b>\n\nYou have no upcoming duties to swap. 🎉`;
    return ctx.editMessageText(emptyText, { parse_mode: 'HTML', reply_markup: backToRoster() })
      .catch(() => ctx.reply(emptyText, { parse_mode: 'HTML', reply_markup: backToRoster() }));
  }

  const kb = new InlineKeyboard();
  for (const s of slots.slice(0, 10)) {
    const badge = s.session === 'GPC' ? '🟣' : s.session === 'SAT' ? '🟡' : '🟢';
    kb.text(`${badge} ${fmtDateShort(s.date)} (${s.session})`, `swapdate:${s.date}`).row();
  }
  kb.text('✖️ Cancel', 'swap:cancel');

  const text = `📨 <b>Request a Swap</b>\n\n📅 Which of your upcoming duties do you need to swap?`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
});

bot.callbackQuery(/^swapdate:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);
  ctx.session.pendingSwapDate    = ctx.match[1];
  ctx.session.awaitingSwapReason = true;
  const text = `📅 Date: <b>${fmtDateShort(ctx.session.pendingSwapDate)}</b>\n\n📝 What's the reason for swapping?`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: swapPromptKb() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: swapPromptKb() }));
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
  ctx.session.editingIndex     = null;

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
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByRecyclingGate(ctx)) return;
  ctx.session.awaitingLogDate = { type: 'cardboard' };
  const text = `📦 <b>Log Cardboard</b>\n\nWhen was this collected? Tap Today, or type a past date to back-add a missed log (e.g. <code>20 Jun</code>).`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: askLogDate('cardboard') })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: askLogDate('cardboard') }));
});

bot.callbackQuery('action:log:plastic', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByRecyclingGate(ctx)) return;
  ctx.session.awaitingLogDate = { type: 'plastic' };
  const text = `🍶 <b>Log Plastic</b>\n\nWhen was this collected? Tap Today, or type a past date to back-add a missed log (e.g. <code>20 Jun</code>).`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: askLogDate('plastic') })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: askLogDate('plastic') }));
});

bot.callbackQuery(/^logdate:(cardboard|plastic):today$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await startLogSession(ctx, ctx.match[1], today());
});

bot.callbackQuery('log:more', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const ls = ctx.session.logSession;
  if (!ls) return;
  ctx.session.awaitingLogPhoto = true;
  ctx.session.awaitingLogKg    = false;
  const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
  const text = `${emoji} Send a photo of measurement #${ls.measurements.length + 1}.`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: logPromptKb() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: logPromptKb() }));
});

// Shared review/confirmation screen — used after "That's all" and whenever an
// edit (weight change, photo replace, delete) finishes and hands back control.
// Always clears editingIndex so a stray in-progress edit can't leak into a
// later step.
async function renderLogReview(ctx) {
  const ls = ctx.session.logSession;
  if (!ls || !ls.measurements.length) return;
  ctx.session.editingIndex = null;

  const total = Math.round(ls.measurements.reduce((s, m) => s + m.kg, 0) * 100) / 100;
  const lines = ls.measurements.map((m, i) => `  ${i + 1}. ${m.kg} kg`).join('\n');
  const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
  const text  =
    `${emoji} <b>Confirm ${ls.type} log — ${fmtDate(ls.sessionDate)}</b>\n\n${lines}\n\n` +
    `<b>Total: ${total} kg</b>\n\nSave this?`;
  const kb = new InlineKeyboard()
    .text('✅ Confirm', 'log:confirm').text('✏️ Edit', 'log:edit').row()
    .text('✖️ Cancel', 'log:cancel');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}

bot.callbackQuery('log:done', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  return renderLogReview(ctx);
});

bot.callbackQuery('log:cancel', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  return cancelLogFlow(ctx, { viaButton: true });
});

// ─── Edit flow (from the review screen) ───────────────────────────────────────
// Lets a member fix a mistake at final review instead of cancelling and
// restarting the whole session: change a measurement's weight, re-send its
// photo, or delete it outright. Nothing is saved to the DB until Confirm is
// tapped on the review screen, so all of this is safe to poke at freely.
function editListKb(ls) {
  const kb = new InlineKeyboard();
  ls.measurements.forEach((m, i) => {
    kb.text(`✏️ #${i + 1} — ${m.kg} kg`, `log:edititem:${i}`).row();
  });
  kb.text('➕ Add another measurement', 'log:more').row();
  kb.text('← Back to review', 'log:backreview');
  return kb;
}

bot.callbackQuery('log:edit', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const ls = ctx.session.logSession;
  if (!ls || !ls.measurements.length) return renderLogReview(ctx);
  const text = `✏️ <b>Edit entries</b>\n\nTap a measurement to change its weight, replace its photo, or delete it.`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: editListKb(ls) })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: editListKb(ls) }));
});

bot.callbackQuery('log:backreview', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  return renderLogReview(ctx);
});

bot.callbackQuery(/^log:edititem:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const idx = parseInt(ctx.match[1], 10);
  const ls  = ctx.session.logSession;
  if (!ls || !ls.measurements[idx]) return renderLogReview(ctx);
  const m  = ls.measurements[idx];
  const kb = new InlineKeyboard()
    .text('⚖️ Change weight', `log:editkg:${idx}`).row()
    .text('📷 Re-send photo', `log:editphoto:${idx}`).row()
    .text('🗑️ Delete this entry', `log:delitem:${idx}`).row()
    .text('← Back', 'log:edit');
  const text = `Measurement #${idx + 1} — currently <b>${m.kg} kg</b>.\n\nWhat would you like to do?`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
});

bot.callbackQuery(/^log:editkg:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const idx = parseInt(ctx.match[1], 10);
  const ls  = ctx.session.logSession;
  if (!ls || !ls.measurements[idx]) return renderLogReview(ctx);
  ctx.session.editingIndex  = idx;
  ctx.session.awaitingLogKg = true;
  const text = `⚖️ Enter the new weight for measurement #${idx + 1} (currently ${ls.measurements[idx].kg} kg):`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: logPromptKb() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: logPromptKb() }));
});

bot.callbackQuery(/^log:editphoto:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const idx = parseInt(ctx.match[1], 10);
  const ls  = ctx.session.logSession;
  if (!ls || !ls.measurements[idx]) return renderLogReview(ctx);
  ctx.session.editingIndex     = idx;
  ctx.session.awaitingLogPhoto = true;
  const text = `📷 Send the new photo for measurement #${idx + 1}.`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: logPromptKb() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: logPromptKb() }));
});

bot.callbackQuery(/^log:delitem:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const idx = parseInt(ctx.match[1], 10);
  const ls  = ctx.session.logSession;
  if (!ls || !ls.measurements[idx]) return renderLogReview(ctx);
  ls.measurements.splice(idx, 1);

  if (!ls.measurements.length) {
    // Nothing left — don't dead-end; go straight back to "send a photo"
    // rather than forcing a full cancel/restart.
    ctx.session.awaitingLogPhoto = true;
    ctx.session.awaitingLogKg    = false;
    ctx.session.editingIndex     = null;
    const emoji = ls.type === 'cardboard' ? '📦' : '🍶';
    const text  = `🗑️ Deleted. No measurements left.\n\n${emoji} Send a photo of measurement #1.`;
    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: logPromptKb() })
      .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: logPromptKb() }));
  }
  return renderLogReview(ctx);
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
  await ctx.answerCallbackQuery().catch(() => {});
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
  await ctx.answerCallbackQuery().catch(() => {});
  const pending = ctx.session.pendingAnomaly;
  if (!pending) return;
  return finalizeLogSave(ctx, pending.ls, pending.name, pending.total, '');
});

// ─── Callback: availability ───────────────────────────────────────────────────
bot.callbackQuery('menu:avail', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (await blockedByPhase(ctx, 3)) return;
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
      const alreadyText =
        `📅 You've already submitted availability for <b>${targetMonth}</b>.\n\n` +
        `<i>To make changes, contact your TL.</i>`;
      return ctx.editMessageText(alreadyText, { parse_mode: 'HTML', reply_markup: backToMain() })
        .catch(() => ctx.reply(alreadyText, { parse_mode: 'HTML', reply_markup: backToMain() }));
    }
  }

  // Get slots for next month from DB; fall back to generated weekends
  const { slots: monthSlots } = await getMonthSlots(targetMonth);

  if (!monthSlots.length) {
    const noDatesText = `No dates available for ${targetMonth} yet.`;
    return ctx.editMessageText(noDatesText, { reply_markup: backToMain() })
      .catch(() => ctx.reply(noDatesText, { reply_markup: backToMain() }));
  }

  // Full month shown regardless of registered service day (reverted 3 Jul
  // 2026 per Brendon after trial feedback — service_preference is still
  // captured at registration, it's just no longer used to hide dates here).
  ctx.session.availMonth    = targetMonth;
  ctx.session.availDates    = monthSlots.map(s => s.date);
  ctx.session.availSlots    = monthSlots;
  ctx.session.availSelected = [];

  await ctx.editMessageText(
    `📅 <b>Unavailability — ${targetMonth}</b>\n\nTap any date you <b>cannot</b> serve.\nLeave dates untouched if you're available.\n\n` +
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
  await ctx.answerCallbackQuery().catch(() => {});
  const date    = ctx.match[1];
  const unavail = ctx.session.availSelected || [];

  const isNowUnavail = !unavail.includes(date);
  if (isNowUnavail) {
    ctx.session.availSelected = [...unavail, date];
  } else {
    ctx.session.availSelected = unavail.filter(d => d !== date);
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

  // Per-date reason prompts removed 3 Jul 2026 per Brendon's trial feedback —
  // they cluttered the chat and buried the one question that actually
  // matters (the end-of-flow "anything happening this month?" note). Toggling
  // now just updates the keyboard in place; no follow-up message.
  await ctx.editMessageReplyMarkup({
    reply_markup: buildAvailKeyboard(slots, ctx.session.availSelected),
  }).catch(() => {});
});

bot.callbackQuery('avail:submit', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name    = await resolveName(ctx);
  const unavail = ctx.session.availSelected || [];

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

  if (!month) {
    const expiredText = '⚠️ Session expired. Please try again.';
    return ctx.editMessageText(expiredText, { reply_markup: backToMain() })
      .catch(() => ctx.reply(expiredText, { reply_markup: backToMain() }));
  }

  // Stage everything. Reasons are collected one date at a time below — a
  // tester found a single combined free-text ask confusing — then a clearly
  // signposted final "anything else this month?" question closes the flow,
  // so nobody mistakes finishing the reasons for finishing the whole thing
  // (3 Jul 2026 trial feedback: she didn't realize she still had to come
  // back for the monthly-happenings question).
  ctx.session.pendingAvailSave = { month, name, avail, unavail, reasons: {} };

  if (unavail.length) {
    ctx.session.availReasonQueue = [...unavail];
    ctx.session.availReasonTotal = unavail.length;
    return askNextUnavailReason(ctx);
  }
  return askMonthlyNote(ctx);
});

// Asks for a reason for the next unavailable date in the queue, one at a
// time, with a "X of N" progress indicator so it's clear how many are left
// and that more steps are coming. Skip is per-date, not all-or-nothing.
async function askNextUnavailReason(ctx) {
  const queue = ctx.session.availReasonQueue || [];
  const date  = queue.shift();
  ctx.session.availReasonQueue         = queue;
  ctx.session.awaitingSeqUnavailReason = date;

  const total = ctx.session.availReasonTotal || 1;
  const idx   = total - queue.length;
  const text =
    `📝 <b>Reason ${idx} of ${total}</b>\n\nWhy can't you make it on <b>${fmtDateShort(date)}</b>?\n\n` +
    `<i>Type a reason, or tap Skip.</i>`;
  const kb = new InlineKeyboard().text('Skip', 'avail:seqreason:skip');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}

// Called after a reason is typed or skipped for the current date — moves to
// the next queued date, or (once every date is done) clearly hands off to
// the one final "anything else this month?" question, explicitly flagged as
// the last step so it isn't missed.
async function continueUnavailReasonFlow(ctx) {
  if ((ctx.session.availReasonQueue || []).length) {
    return askNextUnavailReason(ctx);
  }
  return askMonthlyNote(ctx, { justFinishedReasons: true });
}

async function askMonthlyNote(ctx, { justFinishedReasons = false } = {}) {
  ctx.session.awaitingMonthlyNote = true;
  const text = justFinishedReasons
    ? `✅ Got all your reasons!\n\n📝 <b>One last question</b> — anything else happening this month we should know about? <i>(celebrations, a busy work period, travel, exams, etc.)</i>\n\nType your answer, or tap Skip.`
    : `📝 Last thing — is anything happening this month we should know about?\n\n` +
      `<i>e.g. celebrating a wedding or birthday, an unusually busy work stretch, travel, exams — anything that might affect your availability or energy for duty.</i>\n\n` +
      `Type your answer, or tap Skip.`;
  const kb = new InlineKeyboard().text('Skip', 'avail:skipmonthlynote');
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}

bot.callbackQuery('avail:seqreason:skip', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const date = ctx.session.awaitingSeqUnavailReason;
  if (date && ctx.session.pendingAvailSave) ctx.session.pendingAvailSave.reasons[date] = '';
  ctx.session.awaitingSeqUnavailReason = null;
  return continueUnavailReasonFlow(ctx);
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

  ctx.session.availMonth               = null;
  ctx.session.availDates               = [];
  ctx.session.availSlots               = [];
  ctx.session.availSelected            = [];
  ctx.session.awaitingSeqUnavailReason = null;
  ctx.session.availReasonQueue         = [];
  ctx.session.availReasonTotal         = 0;

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
  await ctx.answerCallbackQuery().catch(() => {});
  return finalizeAvailability(ctx, '');
});

bot.callbackQuery('avail:cancel', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.availMonth               = null;
  ctx.session.availDates               = [];
  ctx.session.availSlots               = [];
  ctx.session.availSelected            = [];
  ctx.session.awaitingSeqUnavailReason = null;
  ctx.session.availReasonQueue         = [];
  ctx.session.availReasonTotal         = 0;
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
        `📅 <b>Unavailability Check — ${args}</b>\n\nHi <b>${m.name}</b>! Tap any date you <b>cannot</b> serve.\nLeave dates untouched if you're available.\n\n<i>❌ = can't serve  ·  no mark = available</i>`,
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
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.').catch(() => {});
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
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.awaitingCollectMonth = true;
  const testMode = await availabilityBroadcastTestMode();
  await ctx.editMessageText(
    `📅 <b>Collect Availability</b>\n\nWhich month? (e.g. <code>Aug 2026</code>)\n\n` +
    (testMode
      ? `🧪 <b>Test mode is ON</b> — this will only DM ${TEST_AS_REGULAR_NAMES.join(', ')}, not the real team.`
      : `<i>This will DM all registered members asking for their availability.</i>`),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
  );
});

// Admin: Send Roster to Group — choose "upcoming" (old default: next 2
// months, auto-grouped) or a specific month (added 4 Jul 2026 per Brendon).
bot.callbackQuery('admin:sendcalendar', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!GROUP_ID) {
    return ctx.editMessageText('⚠️ TELEGRAM_CHAT_ID not set.', { reply_markup: backToAdmin() });
  }
  const testMode = await rosterBroadcastTestMode();
  const kb = new InlineKeyboard()
    .text('📅 Upcoming (next 2 months)', 'admin:sendcalendar:upcoming').row()
    .text('🗓 Specific Month', 'admin:sendcalendar:specific').row()
    .text('← Cancel', 'admin:menu');
  await ctx.editMessageText(
    `📋 <b>Send Roster to Group</b>\n\n` +
    (testMode
      ? `🧪 <b>Test mode is ON</b> — this will post to the test channel, not the real group.\n\n`
      : '') +
    `Send everything upcoming, or just one specific month?`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

bot.callbackQuery('admin:sendcalendar:upcoming', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  return sendRosterToGroup(ctx, null);
});

bot.callbackQuery('admin:sendcalendar:specific', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.awaitingSendCalendarMonth = true;
  await ctx.editMessageText(
    `🗓 <b>Send Roster to Group — Specific Month</b>\n\nWhich month? (e.g. <code>Aug 2026</code>)`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
  );
});

// Fetches + posts the roster to GROUP_ID. monthLabel === null → old default
// behavior (everything in the next 2 months from today, auto-grouped and
// posted one message per month found). monthLabel = a specific month string
// (e.g. "Aug 2026") → only that month, straight from roster_slots — no
// generated Sat/Sun placeholder fallback here, since posting placeholder
// dates with no real team assignments into the group would be misleading.
async function sendRosterToGroup(ctx, monthLabel) {
  const supa = db.getClient();
  const byMonth = {};

  // Resolve destination chat — test mode routes to TELEGRAM_TEST_CHAT_ID
  // instead of the real group. If test mode is on but the test chat ID isn't
  // configured, fail loudly rather than silently posting to the real group.
  const testMode = await rosterBroadcastTestMode();
  const targetChatId = testMode ? TEST_GROUP_ID : GROUP_ID;
  if (testMode && !TEST_GROUP_ID) {
    const t = '⚠️ Roster Test Mode is ON but TELEGRAM_TEST_CHAT_ID isn\'t set on Railway. Set it, or turn test mode off, then try again.';
    return ctx.editMessageText(t, { reply_markup: backToAdmin() })
      .catch(() => ctx.reply(t, { reply_markup: backToAdmin() }));
  }

  if (monthLabel) {
    // Normalize typed input ("Jul 2026" → "July 2026") — roster_slots dates
    // are always compared against the FULL month name, so an abbreviated
    // month here would never match and would wrongly report "no roster
    // created yet" even when one exists (fixed 4 Jul 2026).
    const canonical = canonicalizeMonthLabel(monthLabel);
    if (!canonical) {
      const t = `⚠️ Couldn't parse "<b>${escapeHtml(monthLabel)}</b>". Try: <code>Aug 2026</code>`;
      return ctx.editMessageText(t, { parse_mode: 'HTML', reply_markup: backToAdmin() })
        .catch(() => ctx.reply(t, { parse_mode: 'HTML', reply_markup: backToAdmin() }));
    }
    monthLabel = canonical;

    let slots = [];
    if (supa) {
      const { data: allSlots } = await supa.from('roster_slots').select('*').order('date');
      slots = (allSlots || []).filter(s => {
        const label = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
        return label.toLowerCase() === monthLabel.toLowerCase();
      });
    }
    if (!slots.length) {
      const t = `No roster created for <b>${monthLabel}</b> yet.`;
      return ctx.editMessageText(t, { parse_mode: 'HTML', reply_markup: backToAdmin() })
        .catch(() => ctx.reply(t, { parse_mode: 'HTML', reply_markup: backToAdmin() }));
    }
    byMonth[monthLabel] = slots;
  } else {
    let slots = [];
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
    for (const s of slots) {
      const m = new Date(s.date).toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(s);
    }
  }

  const rosterImage = getRosterImage();
  const posted  = [];
  const skipped = [];

  for (const [month, mSlots] of Object.entries(byMonth)) {
    // Safety check 1: team names must match the current active member_roster
    // (name or alias) — catches typos and stale names (e.g. someone who's
    // left, like Boone) before they go out to the whole group. If anything
    // doesn't match, skip this month entirely and alert the TL to fix the
    // data rather than posting something wrong.
    const mismatches = await findRosterNameMismatches(mSlots);
    if (mismatches.length) {
      const detail = mismatches.map(m => `• ${fmtDateShort(m.date)} (${m.session}): "${m.name}"`).join('\n');
      await notifyRosterAlert(
        `⚠️ <b>Roster broadcast skipped — ${month}</b>\n\n` +
        `These team names in <code>roster_slots</code> don't match any active member_roster name/alias:\n${detail}\n\n` +
        `Fix the name(s) (typo, or the person needs re-adding/re-activating) and re-run Send Roster to Group.`
      );
      skipped.push({ month, reason: 'name mismatch' });
      continue;
    }

    // Calendar image next. If the sharp/rosterImage module is missing, or
    // rendering/sending it fails for any reason, do NOT fall back to
    // text-only — silently posting a degraded version could look like it
    // worked when it didn't. Instead skip this month, alert Brendon with the
    // exact error so it can be pasted back here to debug, and move on.
    if (!rosterImage) {
      await notifyRosterAlert(`⚠️ <b>Roster broadcast skipped — ${month}</b>\n\nrosterImage module isn't available (sharp not installed?). Nothing was posted to the group.`);
      skipped.push({ month, reason: 'rosterImage module unavailable' });
      continue;
    }
    // Image is now the ONLY post per month — per Brendon, the separate
    // detailed text listing that used to follow it was redundant clutter
    // (4 Jul 2026: "the listed roster got sent together with the image
    // which I don't want"). Caption is a plain label — 🧪 (test) tag only
    // when it's actually going to the test channel, nothing extra otherwise.
    try {
      const png = await rosterImage.generateRosterImage(month, mSlots);
      const caption = `📋 W2R Roster — ${month}` + (testMode ? ' 🧪 (test)' : '');
      await bot.api.sendPhoto(targetChatId, new InputFile(png, `roster-${month.replace(/\s+/g, '-')}.png`), {
        caption,
      });
    } catch (err) {
      console.warn('[sendcalendar] image generation/send failed:', err.message);
      await notifyRosterAlert(
        `⚠️ <b>Roster broadcast skipped — ${month}</b>\n\nImage generation/send failed, nothing was posted to the group. Error:\n<code>${escapeHtml(err.message)}</code>`
      );
      skipped.push({ month, reason: 'image failed' });
      continue;
    }

    posted.push(month);
    await new Promise(r => setTimeout(r, 600));
  }

  const dest = testMode ? 'the 🧪 test channel' : 'the group';
  let doneText;
  if (posted.length && !skipped.length) {
    doneText = `✅ Roster for <b>${posted.join(' & ')}</b> posted to ${dest}.`;
  } else if (posted.length && skipped.length) {
    doneText = `⚠️ Posted to ${dest}: <b>${posted.join(' & ')}</b>.\nSkipped: <b>${skipped.map(s => `${s.month} (${s.reason})`).join(', ')}</b> — alert DM'd to ${ROSTER_ALERT_NAMES.join(', ')}.`;
  } else {
    doneText = `❌ Nothing posted. Skipped: <b>${skipped.map(s => `${s.month} (${s.reason})`).join(', ')}</b> — alert DM'd to ${ROSTER_ALERT_NAMES.join(', ')}.`;
  }
  await ctx.editMessageText(doneText, { parse_mode: 'HTML', reply_markup: backToAdmin() })
    .catch(() => ctx.reply(doneText, { parse_mode: 'HTML', reply_markup: backToAdmin() }));
}

// Admin: Edit Member Availability — ask for name
bot.callbackQuery('admin:editavail', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  ctx.session.awaitingEditAvailName = true;
  await ctx.editMessageText(
    `✏️ <b>Edit Member Availability</b>\n\nEnter the member's name to clear their submission for <b>${nextCalendarMonth()}</b>:\n\n` +
    `<i>They'll be able to re-submit via the bot.</i>`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Cancel', 'admin:menu') }
  );
});

// Admin: View registered members
bot.callbackQuery('admin:members', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
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
  await ctx.answerCallbackQuery().catch(() => {});
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

// ─── GPC W2R Check-in (one-off broadcast, added 8 Jul 2026) ────────────────
// DMs every member on the Jul 23-27 GPC roster (including TLs on their own
// duty days) a reminder of their slot(s) + TL, then collects two answers via
// inline buttons: (1) W2R only vs. also another ministry that day, (2) there
// the whole day vs. just a short while (+ when). One row per member in
// `gpc_checkin`, upserted — resending the check-in overwrites, not
// duplicates. This is deliberately hardcoded to the known GPC date range
// rather than derived from `week` text, since GPC week's `week` value
// changed from 'GPC D1'-'D5' to 'W4' (see PROJECT_STATE §7) and isn't a
// stable filter to key off going forward.
const GPC_START = '2026-07-23';
const GPC_END   = '2026-07-27';

// Convention (matches every GPC roster row as of 8 Jul 2026): team[0] is the
// TL for that day, the rest are servers.
async function getGpcRosterByMember() {
  const supa = db.getClient();
  if (!supa) return {};
  const { data } = await supa.from('roster_slots')
    .select('*')
    .eq('session', 'GPC')
    .gte('date', GPC_START)
    .lte('date', GPC_END)
    .order('date');
  const byMember = {}; // name -> [{ date, tl }]
  for (const slot of (data || [])) {
    const team = slot.team || [];
    const tl = team[0] || '—';
    for (const name of team) {
      if (!byMember[name]) byMember[name] = [];
      byMember[name].push({ date: slot.date, tl });
    }
  }
  return byMember;
}

function gpcCheckinMsg(memberName, days) {
  const lines = days.map(d => {
    const tlNote = d.tl === memberName ? 'You (TL)' : d.tl;
    return `• <b>${fmtDateShort(d.date)}</b> — TL: ${tlNote}`;
  }).join('\n');
  return (
    `🌿 <b>GPC W2R Check-in</b>\n\n` +
    `Hey ${memberName}! Quick reminder of your GPC W2R slot(s):\n\n` +
    `${lines}\n\n` +
    `One question as we finalize planning — on your GPC day(s), are you serving <b>only</b> on W2R, or also on another ministry that day?`
  );
}

function gpcQ1Kb() {
  return new InlineKeyboard()
    .text('✅ W2R only', 'gpc:q1:w2ronly').row()
    .text('🙏 Also another ministry', 'gpc:q1:other').row()
    .text('❓ Not sure yet', 'gpc:q1:unsure');
}

function gpcQ2Kb() {
  return new InlineKeyboard()
    .text('🕐 There the whole day', 'gpc:q2:full').row()
    .text('⏱ Just a short while', 'gpc:q2:short');
}

bot.callbackQuery('admin:gpccheckin', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return;
  const byMember = await getGpcRosterByMember();
  const names = Object.keys(byMember);
  if (!names.length) {
    return ctx.editMessageText(`No GPC roster slots found for ${GPC_START} to ${GPC_END}.`, { reply_markup: backToAdmin() });
  }
  const kb = new InlineKeyboard()
    .text(`📤 Send to ${names.length} members`, 'admin:gpccheckin:send').row()
    .text('📋 View Responses So Far', 'admin:gpccheckin:responses').row()
    .text('← Cancel', 'admin:menu');
  const t1 =
    `📋 <b>GPC W2R Check-in</b>\n\n` +
    `This will DM <b>${names.length}</b> members (everyone on the Jul 23–27 GPC roster, including TLs) with a reminder of their slot(s) plus two quick questions:\n` +
    `1️⃣ W2R only, or also another ministry that day?\n` +
    `2️⃣ There the whole day, or just a short while?\n\n` +
    `Recipients: ${names.join(', ')}`;
  const o1 = { parse_mode: 'HTML', reply_markup: kb };
  await ctx.editMessageText(t1, o1).catch(() => ctx.reply(t1, o1));
});

bot.callbackQuery('admin:gpccheckin:send', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return;
  const byMember = await getGpcRosterByMember();
  const sent = [];
  const failed = [];
  for (const [name, days] of Object.entries(byMember)) {
    const member = await db.getMemberByName(name);
    if (!member?.telegram_id) { failed.push(name); continue; }
    try {
      await bot.api.sendMessage(member.telegram_id, gpcCheckinMsg(name, days), {
        parse_mode: 'HTML', reply_markup: gpcQ1Kb(),
      });
      sent.push(name);
    } catch (err) {
      console.warn('[gpccheckin] failed to DM', name, ':', err.message);
      failed.push(name);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  const summary =
    `✅ Sent to ${sent.length}: ${sent.join(', ') || '—'}` +
    (failed.length ? `\n⚠️ Couldn't reach (not registered on the bot?): ${failed.join(', ')}` : '');
  const oSummary = { parse_mode: 'HTML', reply_markup: backToAdmin() };
  await ctx.editMessageText(summary, oSummary).catch(() => ctx.reply(summary, oSummary));
});

bot.callbackQuery('admin:gpccheckin:responses', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return;
  const rows = await db.getGpcCheckinResponses();
  if (!rows.length) {
    return ctx.editMessageText('No responses yet.', { reply_markup: backToAdmin() });
  }
  const statusLabel = { w2r_only: '✅ W2R only', unsure: '❓ Not sure' };
  const durationLabel = { full_day: '🕐 Whole day', short_while: '⏱ Short while' };
  const lines = rows.map((r, i) => {
    const ms = r.ministry_status === 'other_ministry'
      ? `🙏 Also: ${r.other_ministry || '—'}`
      : (statusLabel[r.ministry_status] || '❓ No answer');
    const dur = r.duration ? (durationLabel[r.duration] || r.duration) + (r.arrival_note ? ` (${escapeHtml(r.arrival_note)})` : '') : '—';
    return `${i + 1}. <b>${r.member_name}</b> — ${ms} · ${dur}`;
  }).join('\n');
  const tResp = `📋 <b>GPC Check-in Responses (${rows.length})</b>\n\n${lines}`;
  const oResp = { parse_mode: 'HTML', reply_markup: backToAdmin() };
  await ctx.editMessageText(tResp, oResp).catch(() => ctx.reply(tResp, oResp));
});

bot.callbackQuery(/^gpc:q1:(w2ronly|other|unsure)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const status = ctx.match[1];
  const name = await resolveName(ctx);
  // Previously: silent `return` here left the member staring at the same
  // message with no feedback if resolveName() ever came back empty (found
  // 9 Jul 2026 — "selected 'also another ministry', not directed to any
  // page"). Now tells them what to do instead of doing nothing.
  if (!name) {
    return ctx.reply(`⚠️ Couldn't find your registration. Please tap /start first, then try the check-in link again.`);
  }
  if (status === 'other') {
    ctx.session.pendingGpcCheckin = { ministry_status: 'other_ministry' };
    ctx.session.awaitingGpcOtherMinistry = true;
    const t = `🙏 Which other ministry are you serving that day?`;
    const o = { parse_mode: 'HTML' };
    return ctx.editMessageText(t, o).catch(() => ctx.reply(t, o));
  }
  ctx.session.pendingGpcCheckin = { ministry_status: status };
  const t2 = `Got it! One more thing — will you be there for the <b>whole day</b>, or just a <b>short while</b>?`;
  const o2 = { parse_mode: 'HTML', reply_markup: gpcQ2Kb() };
  await ctx.editMessageText(t2, o2).catch(() => ctx.reply(t2, o2));
});

bot.callbackQuery(/^gpc:q2:(full|short)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const duration = ctx.match[1];
  const name = await resolveName(ctx);
  if (!name) {
    return ctx.reply(`⚠️ Couldn't find your registration. Please tap /start first, then try the check-in link again.`);
  }
  if (!ctx.session.pendingGpcCheckin) {
    // Session was reset (e.g. bot restarted between steps) — recover
    // gracefully instead of leaving the tap looking like it did nothing.
    return ctx.reply(`⚠️ That check-in step expired (the bot may have restarted). Please ask your Team Lead to resend the GPC W2R Check-in.`);
  }
  if (duration === 'short') {
    ctx.session.pendingGpcCheckin.duration = 'short_while';
    ctx.session.awaitingGpcArrivalNote = true;
    const t = `⏱ Roughly when will you come down / for how long? <i>(e.g. "after 10am service, ~1 hour")</i>`;
    const o = { parse_mode: 'HTML' };
    return ctx.editMessageText(t, o).catch(() => ctx.reply(t, o));
  }
  ctx.session.pendingGpcCheckin.duration = 'full_day';
  await db.saveGpcCheckin(name, ctx.session.pendingGpcCheckin);
  ctx.session.pendingGpcCheckin = null;
  const t3 = `✅ Thanks, ${name}! Got your answer — see you at GPC 🌿`;
  const o3 = { parse_mode: 'HTML' };
  await ctx.editMessageText(t3, o3).catch(() => ctx.reply(t3, o3));
});

// ─── Admin: generic feature-toggle handler ─────────────────────────────────
// Shared by every bot_settings on/off toggle in /admin.
async function handleAdminToggle(ctx, { key, envVar, label, onLiveMsg, onHiddenMsg }) {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.').catch(() => {});

  const wasLive   = await getBoolSetting(key, envVar);
  const goingLive = !wasLive;

  const { error } = await setBoolSetting(key, goingLive);
  if (error) {
    console.error(`[Bot] toggle ${key} failed:`, error.message);
    return ctx.editMessageText(`⚠️ Couldn't save: ${error.message}`, { reply_markup: backToAdmin() });
  }

  const note = process.env[envVar] === 'true'
    ? `\n\n<i>Note: ${envVar}=true is also set on Railway, which forces ${label} on regardless of this toggle — remove that env var if you want this button to actually control it.</i>`
    : '';

  await ctx.editMessageText(
    (goingLive ? onLiveMsg : onHiddenMsg) + note,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
}

bot.callbackQuery('admin:togglerecycling', (ctx) => handleAdminToggle(ctx, {
  key: 'recycling_logs_live',
  envVar: 'RECYCLING_LOGS_LIVE',
  label: 'Recycling Logs',
  onLiveMsg:   '✅ <b>Recycling Logs is now LIVE</b> for all members! 🌿',
  onHiddenMsg: '🔒 <b>Recycling Logs is now hidden</b> again for regular members.',
}));

bot.callbackQuery('admin:toggleswaps', (ctx) => handleAdminToggle(ctx, {
  key: 'swap_requests_live',
  envVar: 'SWAP_REQUESTS_LIVE',
  label: 'Swap Requests',
  onLiveMsg:   '✅ <b>Swap Requests is now LIVE</b> for all members! 🌿',
  onHiddenMsg: '🔒 <b>Swap Requests is now paused</b> for regular members (TLs still see it).',
}));

// Roster broadcast test mode — NOT handleAdminToggle/getBoolSetting, since
// that helper force-returns true once currentPhase() >= 3 (11 Jul full
// launch), which would wrongly force every future roster broadcast into the
// test channel. This is a manual routing switch, independent of feature
// rollout phases.
bot.callbackQuery('admin:togglerostertest', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.').catch(() => {});

  if (!TEST_GROUP_ID) {
    return ctx.editMessageText(
      '⚠️ <b>TELEGRAM_TEST_CHAT_ID</b> is not set on Railway — add your test channel\'s chat ID first, then this toggle will work.',
      { parse_mode: 'HTML', reply_markup: backToAdmin() }
    );
  }

  const wasOn   = await rosterBroadcastTestMode();
  const goingOn = !wasOn;
  const { error } = await setBoolSetting('roster_broadcast_test_mode', goingOn);
  if (error) {
    console.error('[Bot] toggle roster_broadcast_test_mode failed:', error.message);
    return ctx.editMessageText(`⚠️ Couldn't save: ${error.message}`, { reply_markup: backToAdmin() });
  }

  const note = process.env.ROSTER_TEST_MODE === 'true'
    ? `\n\n<i>Note: ROSTER_TEST_MODE=true is also set on Railway, which forces this on regardless of this toggle.</i>`
    : '';
  await ctx.editMessageText(
    (goingOn
      ? '🧪 <b>Roster Test Mode is now ON.</b> "Send Roster to Group" will post to the test channel instead of the real group.'
      : '✅ <b>Roster Test Mode is now OFF.</b> "Send Roster to Group" will post to the real group again.') + note,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// Availability broadcast test mode toggle — see availabilityBroadcastTestMode()
// for why this isn't handleAdminToggle/getBoolSetting.
bot.callbackQuery('admin:toggleavailtest', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.').catch(() => {});

  if (!TEST_AS_REGULAR_NAMES.length) {
    return ctx.editMessageText(
      '⚠️ <b>TEST_AS_REGULAR_NAMES</b> is not set on Railway — add your name(s) there first (e.g. <code>TEST_AS_REGULAR_NAMES=Brendon</code>), then this toggle will know who to DM.',
      { parse_mode: 'HTML', reply_markup: backToAdmin() }
    );
  }

  const wasOn   = await availabilityBroadcastTestMode();
  const goingOn = !wasOn;
  const { error } = await setBoolSetting('availability_broadcast_test_mode', goingOn);
  if (error) {
    console.error('[Bot] toggle availability_broadcast_test_mode failed:', error.message);
    return ctx.editMessageText(`⚠️ Couldn't save: ${error.message}`, { reply_markup: backToAdmin() });
  }

  const note = process.env.AVAILABILITY_TEST_MODE === 'true'
    ? `\n\n<i>Note: AVAILABILITY_TEST_MODE=true is also set on Railway, which forces this on regardless of this toggle.</i>`
    : '';
  await ctx.editMessageText(
    (goingOn
      ? `🧪 <b>Availability Test Mode is now ON.</b> "Collect Availability" will only DM: ${TEST_AS_REGULAR_NAMES.join(', ')} — not the real team.`
      : '✅ <b>Availability Test Mode is now OFF.</b> "Collect Availability" will DM every registered member again.') + note,
    { parse_mode: 'HTML', reply_markup: backToAdmin() }
  );
});

// ─── Admin: fire the daily reminder cron on demand ─────────────────────────────
// Runs the exact same functions the 09:00 SGT cron calls (sendDutyReminders +
// sendBirthdayReminders) right now, so Brendon can verify the whole pipeline —
// Supabase queries, message formatting, Telegram delivery — without waiting
// for a real duty 5 days out or a birthday to line up.
bot.callbackQuery('admin:testreminders', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await isTL(ctx))) return ctx.answerCallbackQuery('⚠️ TL only.').catch(() => {});

  const reminders = getReminders();
  if (!reminders) {
    return ctx.editMessageText('⚠️ Could not load utils/reminders.js.', { reply_markup: backToAdmin() });
  }

  await ctx.editMessageText('🔔 Running duty + birthday reminders now… check your DMs and the console/Railway logs.', {
    reply_markup: backToAdmin(),
  });

  try {
    await reminders.sendDutyReminders(bot);
    await reminders.sendBirthdayReminders(bot);
    if (reminders.sendCommsReminders) await reminders.sendCommsReminders(bot);
    if (reminders.checkScheduledCommsPosts) await reminders.checkScheduledCommsPosts(bot);
    const doneMsg =
      `✅ <b>Test run complete.</b>\n\n` +
      `This only sends to members who actually have a slot exactly 5 or 1 day from today, ` +
      `or a birthday today/in 7 days — if nobody qualifies today, no DMs go out and that's expected, ` +
      `not a failure. Check Railway logs for "[Reminders] Sent…" lines to confirm it ran.`;
    await ctx.editMessageText(doneMsg, { parse_mode: 'HTML', reply_markup: backToAdmin() })
      .catch(() => ctx.reply(doneMsg, { parse_mode: 'HTML', reply_markup: backToAdmin() }));
  } catch (err) {
    console.error('[Bot] admin:testreminders failed:', err.message);
    const failMsg = `⚠️ Reminder test failed: ${err.message}`;
    await ctx.editMessageText(failMsg, { reply_markup: backToAdmin() })
      .catch(() => ctx.reply(failMsg, { reply_markup: backToAdmin() }));
  }
});

// ─── Admin: Excuse member from roster ─────────────────────────────────────────
bot.callbackQuery('admin:excuse', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
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
  await ctx.answerCallbackQuery().catch(() => {});
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

  const text =
    `♻️ <b>W2R Ministry Impact</b>\n<i>Sep 2025 – present</i>\n\n` +
    `📊 <b>All-Time</b>\n` +
    `📦 Cardboard: <b>${cb.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${pl.toFixed(1)} kg</b>\n` +
    `🌍 CO₂e avoided: <b>${total.co2eKg} kg</b>\n` +
    `🌳 Trees equiv: <b>${total.treesEquiv}</b>\n` +
    `🚗 Car km saved: <b>${total.carKmEquiv.toLocaleString()}</b>\n` +
    `🧴 Bottles diverted: <b>${total.bottlesEquiv.toLocaleString()}</b>\n\n` +
    `📅 <b>2026 YTD</b>\n` +
    `📦 ${cb26.toFixed(1)} kg  |  🍶 ${pl26.toFixed(1)} kg  |  🌍 ${y26.co2eKg} kg CO₂e`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToMain() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() }));
});

bot.callbackQuery('action:yoy', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
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

  const text = carbon.formatYoY(summaries);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToMain() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() }));
});

bot.callbackQuery('action:mystats', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const name = await resolveName(ctx);
  if (!name) return promptRegister(ctx);

  const supa = db.getClient();
  if (!supa) {
    const noSupaText = '📊 Personal stats require Supabase.';
    return ctx.editMessageText(noSupaText, { reply_markup: backToMain() })
      .catch(() => ctx.reply(noSupaText, { reply_markup: backToMain() }));
  }

  // Credit-splitting (added per Brendon, 9 Jul 2026): whoever taps "Log Cardboard/Plastic" was
  // just the one holding the phone — everyone rostered on roster_slots.team for that date did
  // the actual duty, so kg logged for a date is split evenly across that date's whole team
  // rather than 100% going to the logger. Own solo logs on dates with no matching roster_slots
  // row (ad hoc/backdated entries) still get full credit — nothing to split against.
  const { data: myRosterSlots } = await supa.from('roster_slots').select('date, team').contains('team', [name]);
  const rosterDates = [...new Set((myRosterSlots || []).map(s => s.date))];

  const { data: allSlotsForDates } = rosterDates.length
    ? await supa.from('roster_slots').select('date, team').in('date', rosterDates)
    : { data: [] };
  const teamByDate = {};
  (allSlotsForDates || []).forEach(s => {
    const set = teamByDate[s.date] || new Set();
    (s.team || []).forEach(n => set.add(n));
    teamByDate[s.date] = set;
  });

  const { data: logsOnRosterDates } = rosterDates.length
    ? await supa.from('data_logs').select('*').in('session_date', rosterDates)
    : { data: [] };
  const { data: ownLogs } = await supa.from('data_logs').select('*').eq('logged_by', name);

  let myCb = 0, myPl = 0;
  (logsOnRosterDates || []).forEach(l => {
    const teamSize = teamByDate[l.session_date]?.size || 1;
    const share = Number(l.kg) / teamSize;
    if (l.type === 'cardboard') myCb += share;
    else if (l.type === 'plastic') myPl += share;
  });
  (ownLogs || []).forEach(l => {
    if (rosterDates.includes(l.session_date)) return; // already credited (split) above
    if (l.type === 'cardboard') myCb += Number(l.kg);
    else if (l.type === 'plastic') myPl += Number(l.kg);
  });

  const impact  = carbon.calcCO2e(myCb, myPl);
  // "Sessions" = duty already served, not future scheduled roster slots — fixed 11 Jul 2026
  // (was counting every roster_slots row incl. months ahead, via a dead `attendance` table
  // lookup that always returned 0 rows and fell through to the unfiltered rosterDates count).
  const pastRosterDates = rosterDates.filter(d => d <= today());
  const sessions = pastRosterDates.length || (ownLogs || []).length;

  const text =
    `🌿 <b>${name}'s Personal Impact</b>\n\n` +
    `📋 Sessions: <b>${sessions}</b>\n` +
    `📦 Cardboard: <b>${myCb.toFixed(1)} kg</b>\n` +
    `🍶 Plastic:   <b>${myPl.toFixed(1)} kg</b>\n\n` +
    `🌍 CO₂e saved: <b>${impact.co2eKg} kg</b>\n` +
    `🌳 Trees equiv: <b>${impact.treesEquiv}</b>\n` +
    `🧴 Bottles diverted: <b>${impact.bottlesEquiv.toLocaleString()}</b>\n\n` +
    `<i>Every session counts. Thank you! 💪</i>`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backToMain() })
    .catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: backToMain() }));
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

    // Re-sending a photo for an existing measurement from the edit screen —
    // replace in place, weight is untouched, straight back to review.
    if (ctx.session.editingIndex != null && ls.measurements[ctx.session.editingIndex]) {
      const idx = ctx.session.editingIndex;
      ls.measurements[idx].fileId   = photo.file_id;
      ls.measurements[idx].imageUrl = imageUrl;
      ctx.session.editingIndex = null;
      await ctx.reply(`📷 Photo for measurement #${idx + 1} updated.`, { parse_mode: 'HTML' });
      return renderLogReview(ctx);
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
    if (ctx.session.awaitingSwapReason || ctx.session.pendingSwapReason || ctx.session.awaitingAcceptDate) {
      return cancelSwapFlow(ctx);
    }
    if (ctx.session.awaitingCommsReject) {
      ctx.session.awaitingCommsReject = null;
      return ctx.reply('Cancelled — post left as-is.');
    }
    if (ctx.session.awaitingCommsScheduleTime) {
      ctx.session.awaitingCommsScheduleTime = null;
      return ctx.reply('Cancelled — no reminder time set.');
    }
  }

  // Comms: TL is typing feedback after tapping "Request Changes" on a
  // pending post — comment loop, not a hard reject: status goes to
  // needs_changes (post stays linked) rather than back to draft.
  if (ctx.session.awaitingCommsReject) {
    const id = ctx.session.awaitingCommsReject;
    ctx.session.awaitingCommsReject = null;
    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');

    const { data: p, error } = await supa.from('comms_posts')
      .update({ status: 'needs_changes', rejected_reason: text })
      .eq('id', id).select().single();
    if (error || !p) return ctx.reply('⚠️ Could not update — post may no longer exist.');

    // Also drop this into the visible comment thread (added 9 Jul 2026, per
    // Brendon/Judy's feedback) — previously this text only showed as small
    // grey "TL feedback" text in the status line, easy to miss. It now
    // appears as a normal-size comment card in the same place everyone
    // else's feedback lands, so there's one place to look, not two.
    const tlName = (await resolveName(ctx)) || 'TL';
    const { error: commentErr } = await supa.from('comms_comments').insert({ post_id: id, author_name: tlName, comment: text });
    if (commentErr) console.warn('[Comms] Failed to mirror Request Changes note as a comment:', commentErr.message);

    const who = Array.isArray(p.assignees) && p.assignees.length ? p.assignees.join(', ') : (p.created_by || p.owner || 'the owner');
    await ctx.reply(`💬 Sent back to ${who} with your feedback.`);
    commsNotify.notifyAssigneesChangesRequested(p, text).catch(() => {});
    return;
  }

  // Comms: TL is typing a time-of-day for the scheduled "time to post" ping
  if (ctx.session.awaitingCommsScheduleTime) {
    const id = ctx.session.awaitingCommsScheduleTime;
    const parsed = parseTimeOfDay(text);
    if (!parsed) {
      return ctx.reply('⚠️ Couldn\'t read that time. Try something like <code>6:30pm</code> or <code>18:30</code>.', { parse_mode: 'HTML' });
    }
    ctx.session.awaitingCommsScheduleTime = null;
    const supa = db.getClient();
    if (!supa) return ctx.reply('⚠️ Supabase not configured.');

    const { data: p } = await supa.from('comms_posts').select('date').eq('id', id).single();
    if (!p) return ctx.reply('⚠️ Post not found — it may have been edited or deleted.');

    const pad = (n) => String(n).padStart(2, '0');
    const scheduledAt = new Date(`${p.date}T${pad(parsed.hour)}:${pad(parsed.min)}:00+08:00`);

    const { error } = await supa.from('comms_posts')
      .update({ scheduled_post_time: scheduledAt.toISOString(), scheduled_reminder_sent: false })
      .eq('id', id);
    if (error) return ctx.reply('⚠️ Could not save that time.');

    const displayHour = parsed.hour % 12 === 0 ? 12 : parsed.hour % 12;
    const ampmLabel = parsed.hour < 12 ? 'am' : 'pm';
    await ctx.reply(`⏰ Got it — I'll ping you at ${displayHour}:${pad(parsed.min)}${ampmLabel} SGT with a Mark as Posted button.`);
    return;
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

  // GPC Check-in: other ministry name
  if (ctx.session.awaitingGpcOtherMinistry && ctx.session.pendingGpcCheckin) {
    ctx.session.pendingGpcCheckin.other_ministry = text;
    ctx.session.awaitingGpcOtherMinistry = false;
    return ctx.reply(
      `Got it! One more thing — will you be there for the <b>whole day</b>, or just a <b>short while</b>?`,
      { parse_mode: 'HTML', reply_markup: gpcQ2Kb() }
    );
  }

  // GPC Check-in: arrival note (short while), then save
  if (ctx.session.awaitingGpcArrivalNote && ctx.session.pendingGpcCheckin) {
    ctx.session.pendingGpcCheckin.arrival_note = text;
    ctx.session.awaitingGpcArrivalNote = false;
    const name = await resolveName(ctx);
    if (name) await db.saveGpcCheckin(name, ctx.session.pendingGpcCheckin);
    ctx.session.pendingGpcCheckin = null;
    return ctx.reply(`✅ Thanks${name ? `, ${name}` : ''}! Got your answer — see you at GPC 🌿`, { parse_mode: 'HTML' });
  }

  // Profile: CG — required, every member has one
  if (ctx.session.awaitingProfileCG && ctx.session.pendingProfile) {
    if (!text || text.length < 2 || /^(none|skip|-|n\/a)$/i.test(text)) {
      return ctx.reply(`👥 Which CG are you part of?`, { parse_mode: 'HTML' });
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

    // Changing the weight of an existing measurement from the edit screen —
    // update in place, straight back to review (not the "add another" prompt).
    if (ctx.session.editingIndex != null && ls.measurements[ctx.session.editingIndex]) {
      const idx = ctx.session.editingIndex;
      ls.measurements[idx].kg  = kg;
      ctx.session.editingIndex = null;
      await ctx.reply(`⚖️ Measurement #${idx + 1} updated to <b>${kg} kg</b>.`, { parse_mode: 'HTML' });
      return renderLogReview(ctx);
    }

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

  // Sequential per-date unavailability reason (one at a time, after Submit)
  if (ctx.session.awaitingSeqUnavailReason) {
    const date = ctx.session.awaitingSeqUnavailReason;
    if (ctx.session.pendingAvailSave) ctx.session.pendingAvailSave.reasons[date] = text;
    ctx.session.awaitingSeqUnavailReason = null;
    return continueUnavailReasonFlow(ctx);
  }

  // Monthly "anything happening this month?" note — final step after Submit
  if (ctx.session.awaitingMonthlyNote) {
    return finalizeAvailability(ctx, text);
  }

  // Admin: send roster to group — specific month
  if (ctx.session.awaitingSendCalendarMonth) {
    ctx.session.awaitingSendCalendarMonth = false;
    return sendRosterToGroup(ctx, text.trim());
  }

  // Admin: collect availability month
  if (ctx.session.awaitingCollectMonth) {
    ctx.session.awaitingCollectMonth = false;
    const monthArg = canonicalizeMonthLabel(text.trim()) || text.trim();

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
    let members = (await db.getAllRegisteredMembers()).filter(m => !exemptNames.has((m.name || '').toLowerCase()));

    const testMode = await availabilityBroadcastTestMode();
    if (testMode) {
      members = members.filter(m => TEST_AS_REGULAR_NAMES.includes((m.name || '').toLowerCase()));
      if (!members.length) {
        return ctx.reply(
          `⚠️ Test mode is ON but none of TEST_AS_REGULAR_NAMES (${TEST_AS_REGULAR_NAMES.join(', ') || 'none set'}) are registered with the bot yet.`,
          { reply_markup: backToAdmin() }
        );
      }
    }
    if (!members.length) return ctx.reply('⚠️ No registered members yet.', { reply_markup: backToAdmin() });

    let sent = 0;
    const failed = []; // { name, reason } — surfaced below instead of only console.warn

    for (const m of members) {
      if (!m.telegram_id) {
        failed.push({ name: m.name, reason: 'no telegram_id on file (never registered with the bot)' });
        continue;
      }
      try {
        await bot.api.sendMessage(
          m.telegram_id,
          (testMode ? '🧪 <b>[TEST — not the real request]</b>\n\n' : '') +
          `📅 <b>Unavailability Check — ${monthArg}</b>\n\nHi <b>${m.name}</b>! Tap any date you <b>cannot</b> serve.\nLeave dates untouched if you're available.\n\n<i>❌ = can't serve  ·  no mark = available</i>`,
          { parse_mode: 'HTML', reply_markup: buildAvailKeyboard(monthSlots, []) }
        );
        await db.saveAvailability(monthArg, m.name, [], monthSlots.map(s => s.date));
        sent++;
      } catch (err) {
        console.warn(`[Bot] collect: failed to DM ${m.name}:`, err.message);
        failed.push({ name: m.name, reason: err.message });
      }
    }

    const note = generatedFallback
      ? `\n\n<i>⚠️ No roster created for ${monthArg} yet — used generated Sat/Sun dates.</i>`
      : '';
    const failNote = failed.length
      ? `\n\n⚠️ <b>Not sent to:</b>\n${failed.map(f => `  • <b>${f.name}</b> — ${f.reason}`).join('\n')}`
      : '';
    return ctx.reply(
      (testMode ? '🧪 <b>Test mode</b> — ' : '') +
      `✅ Availability request for <b>${monthArg}</b> sent to <b>${sent}/${members.length}</b> ${testMode ? 'test ' : ''}members.${note}${failNote}`,
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

  // Swap: collect reason, then show a confirmation card — nothing is posted
  // until the member taps "Confirm & Send" (handled by the swap:confirm callback).
  if (ctx.session.awaitingSwapReason) {
    const swapDate = ctx.session.pendingSwapDate;
    const reason   = text || 'No reason given';
    ctx.session.awaitingSwapReason = false;
    ctx.session.pendingSwapReason  = reason;

    return ctx.reply(
      `🔄 <b>Confirm Swap Request</b>\n\n📅 ${fmtDateShort(swapDate)}\n📝 ${reason}\n\n` +
      `<i>Team members will see this in the group and can accept it.</i>`,
      { parse_mode: 'HTML', reply_markup: swapConfirmKb() }
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
