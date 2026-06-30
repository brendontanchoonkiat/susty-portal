'use strict';
// Supabase client — gracefully no-ops if env vars are not set
// so existing JSON-file fallbacks keep working during migration.

let _client = null;

function getClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.warn('[Supabase] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — running in offline mode');
    return null;
  }

  // Lazy-require so the package is optional until configured
  try {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(url, key, {
      auth: { persistSession: false },
    });
    console.log('[Supabase] Client initialised');
  } catch (err) {
    console.warn('[Supabase] @supabase/supabase-js not installed — run npm install @supabase/supabase-js');
    return null;
  }

  return _client;
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

async function query(table, filters = {}) {
  const db = getClient();
  if (!db) return null;
  let q = db.from(table).select('*');
  for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
  const { data, error } = await q;
  if (error) { console.error(`[Supabase] query ${table}:`, error.message); return null; }
  return data;
}

async function insert(table, row) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) { console.error(`[Supabase] insert ${table}:`, error.message); return null; }
  return data;
}

async function update(table, id, patch) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) { console.error(`[Supabase] update ${table}:`, error.message); return null; }
  return data;
}

async function remove(table, id) {
  const db = getClient();
  if (!db) return false;
  const { error } = await db.from(table).delete().eq('id', id);
  if (error) { console.error(`[Supabase] delete ${table}:`, error.message); return false; }
  return true;
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

async function getMemberByTelegramId(telegramId) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('members').select('*').eq('telegram_id', telegramId).single();
  return data || null;
}

async function getMemberByName(name) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('members').select('*')
    .ilike('name', name.trim()).single();
  return data || null;
}

// ─── Resolve a typed name to canonical name via member_roster aliases ─────────
// Returns { canonical, roster } or null. Case-insensitive alias match.
async function resolveCanonicalName(typedName) {
  const db = getClient();
  if (!db) return null;
  const lower = typedName.trim().toLowerCase();

  // Exact name match first
  const { data: exact } = await db.from('member_roster')
    .select('*').ilike('name', lower).single();
  if (exact) return { canonical: exact.name, roster: exact };

  // Alias match — check if any alias in the aliases array matches
  const { data: all } = await db.from('member_roster').select('*').eq('is_active', true);
  if (!all) return null;
  for (const m of all) {
    const aliases = m.aliases || [];
    if (aliases.some(a => a.toLowerCase() === lower)) {
      return { canonical: m.name, roster: m };
    }
  }
  return null;
}

// ─── Fuzzy name matching ──────────────────────────────────────────────────────
// Returns roster names that are likely matches for a typed name.
// Matching rules (in priority order):
//   1. Typed name is a substring of a roster name   ("Shing"  → "Wee Shing")
//   2. A roster name word starts with the typed name ("Wee"    → "Wee Shing")
//   3. Any typed word (≥3 chars) appears in a roster name
async function fuzzyMatchRosterNames(typedName) {
  const db = getClient();
  if (!db) return [];
  const { data: all } = await db.from('member_roster').select('name').eq('is_active', true);
  if (!all) return [];

  const lower      = typedName.trim().toLowerCase();
  const typedWords = lower.split(/\s+/).filter(w => w.length >= 3);
  const results    = [];

  for (const m of all) {
    const rosterLower = m.name.toLowerCase();
    const rosterWords = rosterLower.split(/\s+/);

    if (rosterLower.includes(lower))                                             { results.push({ name: m.name, score: 3 }); continue; }
    if (rosterWords.some(w => w.startsWith(lower)))                              { results.push({ name: m.name, score: 2 }); continue; }
    if (typedWords.length && typedWords.some(w => rosterLower.includes(w)))      { results.push({ name: m.name, score: 1 }); }
  }

  // Sort by score desc, dedupe, return names only
  return [...new Map(results.sort((a, b) => b.score - a.score).map(r => [r.name, r])).values()]
    .map(r => r.name);
}

// ─── Availability helpers ─────────────────────────────────────────────────────
async function getAllRegisteredMembers() {
  const db = getClient();
  if (!db) return [];
  const { data } = await db.from('members').select('*').order('name');
  return data || [];
}

async function saveAvailability(month, memberName, datesAvail, datesUnavail, notes = '') {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('availability').upsert(
    { month, member_name: memberName, dates_avail: datesAvail, dates_unavail: datesUnavail, notes, updated_at: new Date().toISOString() },
    { onConflict: 'month,member_name' }
  ).select().single();
  if (error) { console.error('[Supabase] saveAvailability:', error.message); return null; }
  return data;
}

async function getAvailabilitySummary(month) {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db.from('availability')
    .select('*').eq('month', month).order('member_name');
  if (error) { console.error('[Supabase] getAvailabilitySummary:', error.message); return []; }
  return data || [];
}

async function getMemberRoster() {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db.from('member_roster')
    .select('*').eq('is_active', true).order('priority').order('name');
  if (error) { console.error('[Supabase] getMemberRoster:', error.message); return []; }
  return data || [];
}

async function updateMemberRosterStats(name, patch) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('member_roster')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('name', name).select().single();
  if (error) { console.error('[Supabase] updateMemberRosterStats:', error.message); return null; }
  return data;
}

async function upsertMember(telegramId, name) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('members')
    .upsert({ telegram_id: telegramId, name: name.trim() }, { onConflict: 'telegram_id' })
    .select().single();
  if (error) { console.error('[Supabase] upsertMember:', error.message); return null; }
  return data;
}

async function getUpcomingRosterForMember(name) {
  const db = getClient();
  if (!db) return null;
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await db.from('roster_slots')
    .select('*')
    .gte('date', today)
    .contains('team', [name])
    .order('date', { ascending: true });
  if (error) { console.error('[Supabase] getUpcomingRosterForMember:', error.message); return null; }
  return data || [];
}

async function getUpcomingRoster(weeks = 4) {
  const db = getClient();
  if (!db) return null;
  const today = new Date();
  const until = new Date(today);
  until.setDate(until.getDate() + weeks * 7);
  const { data, error } = await db.from('roster_slots')
    .select('*')
    .gte('date', today.toISOString().split('T')[0])
    .lte('date', until.toISOString().split('T')[0])
    .order('date', { ascending: true });
  if (error) { console.error('[Supabase] getUpcomingRoster:', error.message); return null; }
  return data || [];
}

async function insertDataLog(log) {
  return insert('data_logs', log);
}

async function getDataLogsForDate(sessionDate) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('data_logs')
    .select('*')
    .eq('session_date', sessionDate)
    .order('created_at', { ascending: true });
  if (error) { console.error('[Supabase] getDataLogsForDate:', error.message); return null; }
  return data || [];
}

async function getRecyclingStats(year = null) {
  const db = getClient();
  if (!db) return null;
  let q = db.from('recycling_monthly').select('*').order('year').order('month');
  if (year) q = q.eq('year', year);
  const { data, error } = await q;
  if (error) { console.error('[Supabase] getRecyclingStats:', error.message); return null; }
  return data || [];
}

async function upsertMonthlyTotal(month, year, cardboardKg, plasticKg, source = 'logged') {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('recycling_monthly')
    .upsert(
      { month, year, cardboard_kg: cardboardKg, plastic_kg: plasticKg, source, updated_at: new Date().toISOString() },
      { onConflict: 'month,year' }
    ).select().single();
  if (error) { console.error('[Supabase] upsertMonthlyTotal:', error.message); return null; }
  return data;
}

// Upload image buffer to Supabase Storage; returns public URL or null
async function uploadImage(buffer, filename, mimeType = 'image/jpeg') {
  const db = getClient();
  if (!db) return null;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'session-images';
  try {
    const { data, error } = await db.storage
      .from(bucket)
      .upload(`logs/${filename}`, buffer, { contentType: mimeType, upsert: false });
    if (error) { console.error('[Supabase] uploadImage:', error.message); return null; }
    const { data: urlData } = db.storage.from(bucket).getPublicUrl(data.path);
    return urlData?.publicUrl || null;
  } catch (err) {
    console.error('[Supabase] uploadImage exception:', err.message);
    return null;
  }
}

module.exports = {
  getClient,
  query, insert, update, remove,
  getMemberByTelegramId, getMemberByName, upsertMember,
  resolveCanonicalName, fuzzyMatchRosterNames,
  getUpcomingRosterForMember, getUpcomingRoster,
  insertDataLog, getDataLogsForDate,
  getRecyclingStats, upsertMonthlyTotal,
  uploadImage,
  getAllRegisteredMembers,
  saveAvailability, getAvailabilitySummary,
  getMemberRoster, updateMemberRosterStats,
};
