-- ============================================================
-- Susty Portal Migration 2 — Run in Supabase SQL Editor
-- Adds: member aliases, serve stats, availability table
-- Corrects: recycling_monthly totals, roster_slots
-- ============================================================

-- 1. Add columns to members table
ALTER TABLE members ADD COLUMN IF NOT EXISTS aliases      TEXT[]   DEFAULT '{}';
ALTER TABLE members ADD COLUMN IF NOT EXISTS sat_serves   INT      DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS sun_serves   INT      DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS gpc_serves   INT      DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS total_serves INT      DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS points       NUMERIC(5,1) DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS priority     TEXT     DEFAULT '';

-- 2. Availability collation table
CREATE TABLE IF NOT EXISTS availability (
  id            BIGSERIAL PRIMARY KEY,
  month         TEXT NOT NULL,
  member_name   TEXT NOT NULL,
  dates_avail   TEXT[] NOT NULL DEFAULT '{}',
  dates_unavail TEXT[] NOT NULL DEFAULT '{}',
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month, member_name)
);
CREATE INDEX IF NOT EXISTS idx_avail_month ON availability(month);

-- 3. Corrected recycling_monthly (from actual spreadsheet totals)
INSERT INTO recycling_monthly (month, year, cardboard_kg, plastic_kg, source) VALUES
  ('Sep 2025', 2025,  83.450,  8.010, 'manual'),
  ('Oct 2025', 2025,  53.620,  9.390, 'manual'),
  ('Nov 2025', 2025,  46.365,  2.540, 'manual'),
  ('Dec 2025', 2025,  57.530,  4.470, 'manual'),
  ('Jan 2026', 2026, 279.695, 13.085, 'manual'),
  ('Feb 2026', 2026,  47.995,  1.115, 'manual'),
  ('Mar 2026', 2026,  64.340,  8.235, 'manual'),
  ('Apr 2026', 2026,  50.698,  2.300, 'manual'),
  ('May 2026', 2026,  49.100,  5.970, 'manual'),
  ('Jun 2026', 2026,  70.640,  0.800, 'manual')
ON CONFLICT (month) DO UPDATE SET
  cardboard_kg = EXCLUDED.cardboard_kg,
  plastic_kg   = EXCLUDED.plastic_kg,
  updated_at   = NOW();

-- 4. Clear old roster_slots and re-seed from Roster tab
TRUNCATE roster_slots CASCADE;
INSERT INTO roster_slots (date, week, session, team, notes) VALUES
  ('2026-06-06', 'Jun W1', 'SAT', '{"Brendon","Matthew","Esther","Wee Shing"}', 'TL: Brendon'),
  ('2026-06-07', 'Jun W1', 'SUN', '{"Brendon","Kai Jie","Judy"}', 'TL: Brendon'),
  ('2026-06-13', 'Jun W2', 'SAT', '{"Candice","Clara"}', 'TL: TBC'),
  ('2026-06-14', 'Jun W2', 'SUN', '{"Jace","Jeslyn"}', 'TL: TBC'),
  ('2026-06-20', 'Jun W3', 'SAT', '{"Wee Shing","Matthew","Pamela"}', 'TL: Wee Shing'),
  ('2026-06-21', 'Jun W3', 'SUN', '{"Judy","Kai Jie","Brendon"}', 'TL: Judy'),
  ('2026-06-27', 'Jun W4', 'SAT', '{"Candice","Wee Shing"}', 'TL: TBC'),
  ('2026-06-28', 'Jun W4', 'SUN', '{"Brendon","Jace","Jia Yu"}', 'TL: Brendon'),
  ('2026-07-04', 'Jul W1', 'SAT', '{"Wee Shing","Clara","Pamela","Matthew","Esther"}', 'TL: Wee Shing'),
  ('2026-07-05', 'Jul W1', 'SUN', '{"Judy","Brendon","Jiayi","Jeslyn","Jace"}', 'TL: Judy'),
  ('2026-07-11', 'Jul W2', 'SAT', '{"Wee Shing","Candice","Victor","Pamela","Barry"}', 'TL: Wee Shing'),
  ('2026-07-12', 'Jul W2', 'SUN', '{"Brendon","Jia Yu","Jonathan Poon","Clarice","Sok Min"}', 'TL: Brendon'),
  ('2026-07-18', 'Jul W3', 'SAT', '{"Wee Shing","Clara"}', 'TL: Wee Shing'),
  ('2026-07-19', 'Jul W3', 'SUN', '{"Judy","Kai Jie","Jia Yu","Jace","Jeslyn"}', 'TL: Judy'),
  ('2026-07-23', 'GPC D1', 'GPC', '{"Wee Shing","Candice","Clara","Matthew","Debra"}', 'GPC Day 1 (Thu) — TL: Wee Shing'),
  ('2026-07-24', 'GPC D2', 'GPC', '{"Brendon","Clarice","Jiayi","Jeslyn","Victor"}', 'GPC Day 2 (Fri) — TL: Brendon'),
  ('2026-07-25', 'GPC D3', 'GPC', '{"Judy","Candice","Alan","Matthew","Elaine"}', 'GPC Day 3 (Sat) — TL: Judy'),
  ('2026-07-26', 'GPC D4', 'GPC', '{"Wee Shing","Clarice","Jace","Jeslyn","Jiayi"}', 'GPC Day 4 (Sun) — TL: Wee Shing'),
  ('2026-07-27', 'GPC D5', 'GPC', '{"Brendon","Clarice","Jonathan Poon","Jeslyn","Barry"}', 'GPC Day 5 (Mon) — TL: Brendon');

-- 5. Seed member roster metadata (upsert by name, no telegram_id yet)
-- This is a reference table — members link when they do /start in the bot
CREATE TABLE IF NOT EXISTS member_roster (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  aliases       TEXT[] NOT NULL DEFAULT '{}',
  sat_serves    INT DEFAULT 0,
  sun_serves    INT DEFAULT 0,
  gpc_serves    INT DEFAULT 0,
  total_serves  INT DEFAULT 0,
  points        NUMERIC(5,1) DEFAULT 0,
  priority      TEXT DEFAULT '',
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO member_roster (name, aliases, sat_serves, sun_serves, gpc_serves, total_serves, points, priority) VALUES
  ('Alan', '{"alan"}', 0, 0, 1, 1, 1.5, '✅ Serve Next'),
  ('Barry', '{"barry"}', 1, 0, 1, 2, 2.5, '⚠️ Soon'),
  ('Brendon', '{"brendon"}', 1, 5, 2, 8, 9.0, '— Rest'),
  ('Candice', '{"candice"}', 3, 0, 2, 5, 6.0, '— Rest'),
  ('Clara', '{"clara","clara cheong"}', 3, 0, 1, 4, 4.5, '— Rest'),
  ('Debra', '{"debra","debs"}', 0, 0, 1, 1, 1.5, '✅ Serve Next'),
  ('Elaine', '{"elaine"}', 0, 0, 1, 1, 1.5, '✅ Serve Next'),
  ('Esther', '{"esther"}', 2, 0, 0, 2, 2.0, '✅ Serve Next'),
  ('Jace', '{"jace"}', 0, 4, 1, 5, 5.5, '— Rest'),
  ('Jeslyn', '{"jeslyn","jeslynn"}', 0, 3, 3, 6, 7.5, '— Rest'),
  ('Jia Yu', '{"jia yu","jiayu"}', 0, 1, 0, 1, 1.0, '✅ Serve Next'),
  ('Jiayi', '{"jiayi"}', 0, 1, 2, 3, 4.0, '— Rest'),
  ('Jonathan Poon', '{"jonathan poon","jonathan"}', 0, 1, 0, 1, 1.0, '✅ Serve Next'),
  ('Judy', '{"judy","judy koh"}', 0, 3, 1, 4, 4.5, '— Rest'),
  ('Kai Jie', '{"kai jie","kaijie"}', 0, 3, 0, 3, 3.0, '⚠️ Soon'),
  ('Matthew', '{"matthew"}', 3, 0, 2, 5, 6.0, '— Rest'),
  ('Pamela', '{"pamela"}', 3, 0, 0, 3, 3.0, '⚠️ Soon'),
  ('Sok Min', '{"sok min","sokmin"}', 0, 1, 0, 1, 1.0, '✅ Serve Next'),
  ('Victor', '{"victor"}', 1, 0, 1, 2, 2.5, '⚠️ Soon'),
  ('Wee Shing', '{"wee shing","shing","ws"}', 5, 0, 2, 7, 8.0, '— Rest')
ON CONFLICT (name) DO UPDATE SET
  aliases=EXCLUDED.aliases, sat_serves=EXCLUDED.sat_serves,
  sun_serves=EXCLUDED.sun_serves, gpc_serves=EXCLUDED.gpc_serves,
  total_serves=EXCLUDED.total_serves, points=EXCLUDED.points,
  priority=EXCLUDED.priority, updated_at=NOW();