-- Elon Tweet Edge: tables, RLS (anon read-only), Realtime, poll auth helper

create table if not exists public.posts (
  id          text primary key,
  created_at  timestamptz not null,
  content     text,
  imported_at timestamptz
);
create index if not exists posts_created_at_idx on public.posts (created_at desc);

create table if not exists public.prices (
  ts          timestamptz not null,
  market_slug text not null,
  bucket      text not null,
  bid         numeric,
  ask         numeric,
  mid         numeric,
  primary key (ts, market_slug, bucket)
);
create index if not exists prices_slug_ts_idx on public.prices (market_slug, ts desc);

-- small key/value store for the poll function (dedup, caches). Readable by anon: never put secrets here.
create table if not exists public.state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- RLS: anon/authenticated may only SELECT; writes only via service_role (bypasses RLS)
alter table public.posts  enable row level security;
alter table public.prices enable row level security;
alter table public.state  enable row level security;

drop policy if exists "read posts"  on public.posts;
drop policy if exists "read prices" on public.prices;
drop policy if exists "read state"  on public.state;
create policy "read posts"  on public.posts  for select to anon, authenticated using (true);
create policy "read prices" on public.prices for select to anon, authenticated using (true);
create policy "read state"  on public.state  for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.posts, public.prices, public.state from anon, authenticated;
grant select on public.posts, public.prices, public.state to anon, authenticated;

-- Realtime: broadcast INSERTs on posts
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts') then
    alter publication supabase_realtime add table public.posts;
  end if;
end $$;

-- poll function auth: compares the x-poll-secret header with the Vault secret, without ever returning it
create or replace function public.poll_auth(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = 'poll_secret' and decrypted_secret = p
  );
$$;
revoke all on function public.poll_auth(text) from public, anon, authenticated;
grant execute on function public.poll_auth(text) to service_role;
