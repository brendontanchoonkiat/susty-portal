-- GPC W2R Check-in — one response per member covering all their GPC days
-- (Jul 23-27 2026). Run this in Supabase SQL Editor before using the new
-- "📋 Send GPC W2R Check-in" admin flow.

create table if not exists gpc_checkin (
  id              bigint generated always as identity primary key,
  member_name     text not null,
  ministry_status text,           -- 'w2r_only' | 'other_ministry' | 'unsure'
  other_ministry  text,           -- filled when ministry_status = 'other_ministry'
  duration        text,           -- 'full_day' | 'short_while'
  arrival_note    text,           -- filled when duration = 'short_while'
  responded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint gpc_checkin_member_name_key unique (member_name)
);

-- Verification
select * from gpc_checkin order by member_name;
