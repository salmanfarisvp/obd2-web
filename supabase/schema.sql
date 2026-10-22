-- Run this in the Supabase SQL editor.

create table rides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  vehicle_name text not null default 'Suzuki Access 125',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  distance_km real,
  duration_s integer,
  avg_speed real,
  max_speed real,
  max_rpm real,
  max_coolant real,
  fuel_l real,
  moving_s integer,
  idle_s integer,
  stops integer,
  note text,
  obd_connected boolean not null default false
);

create table readings (
  id bigint generated always as identity primary key,
  ride_id uuid not null references rides on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  ts timestamptz not null,
  lat double precision,
  lon double precision,
  gps_speed real,
  rpm real,
  speed real,
  coolant real,
  intake_temp real,
  throttle real,
  load real,
  map_kpa real,
  timing real,
  stft real,
  ltft real,
  voltage real,
  fuel_rate real
);
create index readings_ride_ts on readings (ride_id, ts);

create table fault_codes (
  id bigint generated always as identity primary key,
  ride_id uuid not null references rides on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  code text not null,
  detected_at timestamptz not null default now()
);

alter table rides enable row level security;
alter table readings enable row level security;
alter table fault_codes enable row level security;

create policy "own rides" on rides for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own readings" on readings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own fault codes" on fault_codes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
