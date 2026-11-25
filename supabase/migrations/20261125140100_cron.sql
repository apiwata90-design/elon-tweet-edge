-- Elon Tweet Edge: call Edge Function "poll" every 30 seconds via pg_cron + pg_net.
-- URL and the shared secret live in Vault. The secret is generated inside the database,
-- so it never appears in this repo or in any terminal.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://ahanxplktggyqxdiydfi.supabase.co', 'project_url',
                                'Base URL for Edge Function calls from pg_cron');
  end if;
  if not exists (select 1 from vault.secrets where name = 'poll_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'poll_secret', 'x-poll-secret header for the poll Edge Function');
  end if;
end $$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- invoke poll (used by cron; can also be called by hand: select private.invoke_poll('{"test":true}'))
create or replace function private.invoke_poll(body jsonb default '{}'::jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/poll',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-poll-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'poll_secret')),
    body    := body,
    timeout_milliseconds := 25000
  );
$$;
revoke all on function private.invoke_poll(jsonb) from public, anon, authenticated;

-- schedule (cron.schedule with an existing name updates it)
select cron.schedule('elon-poll', '30 seconds', $cmd$ select private.invoke_poll(); $cmd$);

-- keep cron history small (2,880 runs/day): drop run details older than 3 days, daily at 03:17 UTC
select cron.schedule('elon-cron-cleanup', '17 3 * * *',
  $cmd$ delete from cron.job_run_details where end_time < now() - interval '3 days'; $cmd$);
