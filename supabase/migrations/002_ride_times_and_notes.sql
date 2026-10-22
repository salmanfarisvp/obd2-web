-- Run once in the Supabase SQL editor if you created the tables before this change.
alter table rides
  add column if not exists moving_s integer,
  add column if not exists idle_s integer,
  add column if not exists stops integer,
  add column if not exists note text;
