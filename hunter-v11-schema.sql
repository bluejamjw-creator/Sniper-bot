-- HUNTER V11 dedicated learning schema
-- This deliberately uses V11-specific tables so it cannot collide with
-- legacy Hunter/Sniper schemas already present in Supabase.
-- No new Railway environment variables are required.

create extension if not exists pgcrypto;

create table if not exists hunter_v11_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  timestamp timestamptz not null,
  price numeric not null,
  features jsonb not null,
  feature_vector jsonb not null,
  bootstrap_score numeric,
  learned_similarity numeric,
  detection_mode text,
  created_at timestamptz not null default now()
);
create index if not exists hunter_v11_snapshots_symbol_time_idx
  on hunter_v11_snapshots(symbol, timestamp desc);

create table if not exists hunter_v11_detections (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  timestamp timestamptz not null,
  price numeric not null,
  stage text,
  reason text,
  score numeric,
  features jsonb,
  feature_vector jsonb,
  similarity numeric,
  contrast numeric,
  created_at timestamptz not null default now()
);
create index if not exists hunter_v11_detections_symbol_time_idx
  on hunter_v11_detections(symbol, timestamp desc);

create table if not exists hunter_v11_examples (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid references hunter_v11_snapshots(id) on delete set null,
  symbol text not null,
  timestamp timestamptz not null,
  price numeric not null,
  feature_vector jsonb not null,
  outcome_10 boolean,
  outcome_50 boolean,
  outcome_100 boolean,
  outcome_150 boolean,
  mfe_pct_24h numeric,
  mae_pct_24h numeric,
  time_to_10_min numeric,
  time_to_50_min numeric,
  time_to_100_min numeric,
  time_to_150_min numeric,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists hunter_v11_examples_symbol_time_idx
  on hunter_v11_examples(symbol, timestamp desc);
create index if not exists hunter_v11_examples_resolved_idx
  on hunter_v11_examples(resolved_at);

create table if not exists hunter_v11_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  detection_id uuid references hunter_v11_detections(id) on delete set null,
  status text not null default 'OPEN',
  opened_at timestamptz not null,
  closed_at timestamptz,
  open_price numeric not null,
  close_price numeric,
  close_reason text,
  last_price numeric,
  last_score numeric,
  last_similarity numeric,
  last_update timestamptz
);
create index if not exists hunter_v11_positions_symbol_status_idx
  on hunter_v11_positions(symbol, status);
create unique index if not exists hunter_v11_one_open_position_per_symbol
  on hunter_v11_positions(symbol) where status = 'OPEN';

create table if not exists hunter_v11_alerts (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  action text not null check (action in ('OPEN','HOLD','CLOSE')),
  message text not null,
  detection_id uuid references hunter_v11_detections(id) on delete set null,
  timestamp timestamptz not null default now(),
  metadata jsonb
);
create index if not exists hunter_v11_alerts_symbol_action_time_idx
  on hunter_v11_alerts(symbol, action, timestamp desc);

create unique index if not exists hunter_v11_snapshots_symbol_timestamp_uidx
  on hunter_v11_snapshots(symbol, timestamp);
create unique index if not exists hunter_v11_examples_symbol_timestamp_uidx
  on hunter_v11_examples(symbol, timestamp);
