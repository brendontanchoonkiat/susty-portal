-- ============================================================
-- Susty Portal — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Members — maps Telegram user IDs to roster names
CREATE TABLE IF NOT EXISTS members (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT UNIQUE NOT NULL,
  name           TEXT NOT NULL,           -- must match name in roster exactly
  remind_on      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Roster slots
CREATE TABLE IF NOT EXISTS roster_slots (
  id         BIGSERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  week       TEXT NOT NULL,               -- e.g. "Jul W1"
  session    TEXT NOT NULL CHECK (session IN ('SAT','SUN','GPC')),
  team       TEXT[] NOT NULL DEFAULT '{}',
  kg         NUMERIC(8,2),               -- total kg logged for this session
  notes      TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roster_date ON roster_slots(date);

-- 3. Swap requests
CREATE TABLE IF NOT EXISTS swap_requests (
  id                  BIGSERIAL PRIMARY KEY,
  requester_name      TEXT NOT NULL,
  requester_date      TEXT NOT NULL,      -- e.g. "28 Jun 2026"
  reason              TEXT DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','cancelled')),
  matched_with_name   TEXT,
  matched_with_date   TEXT,
  telegram_message_id BIGINT,             -- group message ID for editing
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_swap_status ON swap_requests(status);

-- 4. Session data logs (per-session field entries from Telegram or portal)
CREATE TABLE IF NOT EXISTS data_logs (
  id           BIGSERIAL PRIMARY KEY,
  session_date DATE NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('cardboard','plastic')),
  kg           NUMERIC(8,2) NOT NULL,
  image_url    TEXT,                      -- Supabase Storage public URL
  file_id      TEXT,                      -- Telegram file_id (fallback if no Storage)
  notes        TEXT DEFAULT '',
  logged_by    TEXT NOT NULL,             -- member name
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_datalogs_date ON data_logs(session_date);
CREATE INDEX IF NOT EXISTS idx_datalogs_type ON data_logs(type);

-- 5. Monthly recycling totals (historical data + auto-aggregated from data_logs)
CREATE TABLE IF NOT EXISTS recycling_monthly (
  id            BIGSERIAL PRIMARY KEY,
  month         TEXT NOT NULL,            -- e.g. "Jan 2026"
  year          INT NOT NULL,
  cardboard_kg  NUMERIC(10,2) DEFAULT 0,
  plastic_kg    NUMERIC(10,2) DEFAULT 0,
  source        TEXT DEFAULT 'manual',    -- 'manual' | 'logged' | 'sheets'
  notes         TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month)
);
CREATE INDEX IF NOT EXISTS idx_recycling_year ON recycling_monthly(year);

-- 6. Monthly energy data (electricity kWh + water m³)
CREATE TABLE IF NOT EXISTS energy_monthly (
  id          BIGSERIAL PRIMARY KEY,
  month       TEXT NOT NULL,            -- e.g. "Jun 2026"
  year        INT NOT NULL,
  month_num   INT NOT NULL,             -- 1–12 for ordering
  kwh         NUMERIC(12,2),            -- combined L3+L4 electricity
  m3          NUMERIC(10,2),            -- combined L3+L4 water
  notes       TEXT DEFAULT '',
  source      TEXT DEFAULT 'manual',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month)
);
CREATE INDEX IF NOT EXISTS idx_energy_year ON energy_monthly(year);

-- 7. Attendance — tracks who confirmed for each slot
CREATE TABLE IF NOT EXISTS attendance (
  id              BIGSERIAL PRIMARY KEY,
  roster_slot_id  BIGINT REFERENCES roster_slots(id) ON DELETE CASCADE,
  member_name     TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(roster_slot_id, member_name)
);

-- ============================================================
-- Seed: historical recycling data (from recycling.js)
-- ============================================================
INSERT INTO recycling_monthly (month, year, cardboard_kg, plastic_kg, source) VALUES
  ('Sep 2025', 2025,  83.45,  8.01, 'manual'),
  ('Oct 2025', 2025,  53.62,  9.39, 'manual'),
  ('Nov 2025', 2025,  46.37,  2.54, 'manual'),
  ('Dec 2025', 2025,  57.53,  4.47, 'manual'),
  ('Jan 2026', 2026, 279.70, 13.09, 'manual'),
  ('Feb 2026', 2026,  48.00,  1.12, 'manual'),
  ('Mar 2026', 2026,  64.34,  8.24, 'manual'),
  ('Apr 2026', 2026,  50.70,  2.30, 'manual'),
  ('May 2026', 2026,  49.10,  5.97, 'manual'),
  ('Jun 2026', 2026,  52.30,  0.80, 'manual')
ON CONFLICT (month) DO NOTHING;

-- ============================================================
-- Migration: add month_num column if it was missing from an earlier schema run
-- Safe to run multiple times (DO NOTHING if already exists)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='energy_monthly' AND column_name='month_num'
  ) THEN
    ALTER TABLE energy_monthly ADD COLUMN month_num INT NOT NULL DEFAULT 0;
    -- Backfill month_num from month text (e.g. "Jun 2026" → 6)
    UPDATE energy_monthly SET month_num = EXTRACT(MONTH FROM TO_DATE(month, 'Mon YYYY'))::INT;
  END IF;
END $$;

-- ============================================================
-- Row Level Security (enable after testing)
-- For now, the backend uses the service key which bypasses RLS.
-- ============================================================
-- ALTER TABLE members          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE roster_slots     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE swap_requests    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE data_logs        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE recycling_monthly ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE attendance       ENABLE ROW LEVEL SECURITY;
