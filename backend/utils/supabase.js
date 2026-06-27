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
      { onConflict: 'month' }
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
  getUpcomingRosterForMember, getUpcomingRoster,
  insertDataLog, getDataLogsForDate,
  getRecyclingStats, upsertMonthlyTotal,
  uploadImage,
};
