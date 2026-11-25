-- Phase 1: health check (A), Telegram webhook (E), storage policy (F)

-- F: no more per-minute price storage. Historical prices come from CLOB prices-history and are cached here
--    only when actually used (backtest / paper trading). Never deleted by cleanup jobs.
create table if not exists public.price_cache (
  token_id    text not null,          -- clobTokenIds[0] (Yes token) of a bucket
  ts          timestamptz not null,
  p           numeric not null,
  market_slug text,
  bucket      text,
  primary key (token_id, ts)
);
create index if not exists price_cache_slug_idx on public.price_cache (market_slug, ts);
alter table public.price_cache enable row level security;
drop policy if exists "read price_cache" on public.price_cache;
create policy "read price_cache" on public.price_cache for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.price_cache from anon, authenticated;
grant select on public.price_cache to anon, authenticated;

-- old per-minute price cache in state is no longer used
delete from public.state where key = 'last_prices';

-- E: Telegram webhook secret (generated in DB, never in repo)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'telegram_webhook_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'telegram_webhook_secret', 'X-Telegram-Bot-Api-Secret-Token for the telegram Edge Function');
  end if;
end $$;

create or replace function public.telegram_auth(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = 'telegram_webhook_secret' and decrypted_secret = p);
$$;
revoke all on function public.telegram_auth(text) from public, anon, authenticated;
grant execute on function public.telegram_auth(text) to service_role;

-- returned only to service_role (the telegram function needs it once for setWebhook)
create or replace function public.telegram_webhook_secret()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telegram_webhook_secret';
$$;
revoke all on function public.telegram_webhook_secret() from public, anon, authenticated;
grant execute on function public.telegram_webhook_secret() to service_role;

-- generic internal invoker: select private.invoke_fn('health', '{"force":true}')
create or replace function private.invoke_fn(fn text, body jsonb default '{}'::jsonb)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-poll-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'poll_secret')),
    body    := body,
    timeout_milliseconds := 55000
  );
$$;
revoke all on function private.invoke_fn(text, jsonb) from public, anon, authenticated;

-- A: health check every 5 min (the function itself skips unless a market has < 4 h left)
select cron.schedule('elon-health', '*/5 * * * *', $cmd$ select private.invoke_fn('health'); $cmd$);

-- F: keep cron history 2 days (posts, paper_*, price_cache are never deleted)
select cron.schedule('elon-cron-cleanup', '17 3 * * *',
  $cmd$ delete from cron.job_run_details where end_time < now() - interval '2 days'; $cmd$);
