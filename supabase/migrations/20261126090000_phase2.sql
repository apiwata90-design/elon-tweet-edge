-- Phase 2: server-side model input + paper trading tables (backtest now, live in phase 3)

-- hourly post counts for the nowcast model (Edge Functions read ~100 days at a time).
-- Returns one jsonb array [[epoch_seconds, n], …] so PostgREST max_rows (1000) does not truncate it.
create or replace function public.hourly_counts(since timestamptz)
returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from h)::bigint, n) order by h), '[]'::jsonb)
  from (select date_trunc('hour', created_at) as h, count(*)::int as n
        from public.posts where created_at >= since group by 1) q;
$$;
grant execute on function public.hourly_counts(timestamptz) to anon, authenticated, service_role;

create table if not exists public.paper_decisions (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null,
  mode        text not null check (mode in ('backtest', 'live')),
  agent       text not null,
  market_slug text not null,
  action      text not null check (action in ('buy', 'sell', 'hold', 'skip', 'settle')),
  side        text check (side in ('yes', 'no')),
  bucket      text,
  price       numeric,     -- fill price (backtest: p ± spread, live: real ask/bid)
  bid         numeric,     -- real bid/ask stored only here (live) — backtest: p − 0.01 / p + 0.01
  ask         numeric,
  p_model     numeric,     -- model P of the bucket (Yes)
  edge        numeric,     -- edge of the chosen side
  reason      text
);
create index if not exists paper_decisions_idx on public.paper_decisions (mode, agent, market_slug, ts);

create table if not exists public.paper_positions (
  id            bigint generated always as identity primary key,
  mode          text not null check (mode in ('backtest', 'live')),
  agent         text not null,
  market_slug   text not null,
  market_type   text not null,           -- '48h' | '7d'
  side          text not null check (side in ('yes', 'no')),
  bucket        text not null,
  entry_ts      timestamptz not null,
  entry_price   numeric not null,
  shares        numeric not null,
  exit_ts       timestamptz,
  exit_price    numeric,
  exit_reason   text,                    -- take_profit | stop_loss | settle
  settled_final boolean not null default false,
  pnl           numeric
);
create index if not exists paper_positions_idx on public.paper_positions (mode, agent, entry_ts);

alter table public.paper_decisions enable row level security;
alter table public.paper_positions enable row level security;
drop policy if exists "read paper_decisions" on public.paper_decisions;
drop policy if exists "read paper_positions" on public.paper_positions;
create policy "read paper_decisions" on public.paper_decisions for select to anon, authenticated using (true);
create policy "read paper_positions" on public.paper_positions for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.paper_decisions, public.paper_positions from anon, authenticated;
grant select on public.paper_decisions, public.paper_positions to anon, authenticated;
