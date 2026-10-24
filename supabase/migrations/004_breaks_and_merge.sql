-- Run once in the Supabase SQL editor.

-- Breaks inside a ride: engine-off pauses of a minute or more (e.g. rides merged across a stop).
alter table rides
  add column if not exists breaks integer,
  add column if not exists break_s integer;

-- Rides starting again within this many minutes of the last one are merged into it. 0 turns it off.
alter table profiles
  add column if not exists merge_gap_min integer not null default 10;
