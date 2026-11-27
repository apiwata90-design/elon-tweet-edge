-- Phase 3: live paper trading (Edge Function "paper")
-- tick every minute: due checkpoints (2x / 3x / avg7d) → paper_decisions / paper_positions (mode 'live') + Telegram
select cron.schedule('elon-paper', '* * * * *', $cmd$ select private.invoke_fn('paper'); $cmd$);
-- daily report 08:00 ICT = 01:00 UTC
select cron.schedule('elon-paper-report', '0 1 * * *', $cmd$ select private.invoke_fn('paper', '{"report":true}'); $cmd$);

-- open live positions are read every tick
create index if not exists paper_positions_open_idx on public.paper_positions (mode, market_slug) where exit_ts is null;
