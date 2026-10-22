-- Run once in the Supabase SQL editor.

create table if not exists profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  currency text not null default '₹',
  fuel_price real
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  tank_l real,
  unique (user_id, name)
);

create table if not exists fuel_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  vehicle_name text not null,
  filled_at timestamptz not null default now(),
  litres real not null,
  amount real,
  price_per_l real,
  full_tank boolean not null default false,
  source text not null default 'manual',
  note text
);
create index if not exists fuel_logs_user_filled on fuel_logs (user_id, filled_at);

alter table readings add column if not exists fuel_level real;

alter table profiles enable row level security;
alter table vehicles enable row level security;
alter table fuel_logs enable row level security;

create policy "own profile" on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own vehicles" on vehicles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own fuel logs" on fuel_logs for all using (user_id = auth.uid()) with check (user_id = auth.uid());
