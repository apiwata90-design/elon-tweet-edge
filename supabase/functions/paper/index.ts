// Edge Function "paper" — live paper trading (phase 3). pg_cron every minute (x-poll-secret).
// Agents (rules in _shared/paper.ts = backtest v2):
//   2x  checkpoints T−24.5h, T−17.5h · 3x  T−16h, T−7h, T−2.5h   (T = market close)
//   avg7d baseline: at market open buy Yes in the bucket of (posts last 7 d / 168) × hours, hold to settle
// A checkpoint runs once, on the first tick at/after its time; if the tick is > 10 min late it is logged as skipped.
// Fills use real gamma bid/ask at that moment + taker fee. Settles when gamma shows the resolved bucket.
// Every buy / sell / settle → Telegram. Decisions → paper_decisions, positions → paper_positions (mode 'live').
// Body: {} tick · {"report":true} daily report → Telegram (cron 01:00 UTC = 08:00 ICT) · {"report":true,"dry":true} text only
//       {"dry":true} what every agent would do right now (no writes) · {"dry":true,"telegram":true} also send it as 🧪
import {
  esc, fetchMarkets, fmtLeft, getJSON, GM, HR, internalAuth, iso, json, loadSeries, loadState, Market, MIN, officialCount,
  pct, pp, saveState, sb, shortTitle, telegram, th,
} from "../_shared/common.ts";
import { DAY, edgeIcon, makeR, Series } from "../_shared/model.ts";
import {
  AGENTS, BAND_HI, BAND_LO, BASELINE, bestEntry, buyCost, ENTRY, exitCheck, feeRate, marketType, modelP, Side, sideQuote, STAKE,
} from "../_shared/paper.ts";

const GRACE = 10 * MIN, SETTLE_EVERY = 10 * MIN, MODE = "live";

type Pos = {
  id: number; agent: string; market_slug: string; market_type: string; side: Side; bucket: string; entry_ts: string;
  entry_price: number; shares: number; exit_ts: string | null; exit_price: number | null; exit_reason: string | null; pnl: number | null;
};
type Dec = { ts: string; agent: string; market_slug: string; action: string; side?: Side | null; bucket?: string | null; price?: number | null; bid?: number | null; ask?: number | null; p_model?: number | null; edge?: number | null; reason: string };
type Due = { m: Market; agent: string; x: number | null; at: number };

/** cents with 1 decimal (fills and costs differ by tenths of a cent) */
const c1 = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}¢`);
const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const sideTxt = (s: Side) => (s === "yes" ? "Yes" : "No");
const T = (m: Market) => m.e + 1000;
const cp = (d: Due) => (d.x == null ? "เปิดตลาด" : `T−${d.x}h`);

async function openPositions(): Promise<Pos[]> {
  const { data, error } = await sb.from("paper_positions").select("*").eq("mode", MODE).is("exit_ts", null);
  if (error) throw error;
  return (data ?? []) as Pos[];
}
async function insertDecisions(ds: Dec[]) {
  if (!ds.length) return;
  const { error } = await sb.from("paper_decisions").insert(ds.map((d) => ({ mode: MODE, ...d })));
  if (error) throw error;
}

/** current count of a market: xtracker official total, fallback = posts table */
async function countNow(m: Market, now: number) {
  if (m.s > now) return 0;
  const v = await officialCount(m.id);
  if (v != null) return v;
  const { count, error } = await sb.from("posts").select("id", { count: "exact", head: true }).gte("created_at", iso(m.s)).lt("created_at", iso(now));
  if (error) throw error;
  return count ?? 0;
}

/** evaluate one due checkpoint; write = false → nothing stored (dry run) */
async function runDue(d: Due, now: number, ctx: { series: Series; open: Pos[]; P: Map<string, { cur: number; P: number[] }> }, write: boolean) {
  const { m, agent } = d, type = marketType(m)!, ts = iso(now), out: { dec: Dec; msg?: string } = { dec: { ts, agent, market_slug: m.slug, action: "skip", reason: "" } };
  const head = (icon: string, verb: string) => `${icon} <b>Paper ${agent}</b> · ${verb}\n📊 ${esc(shortTitle(m.title))} (${type}) · ${cp(d)} · เหลือ ${fmtLeft(Math.max(0, m.e - now))}`;

  if (agent === BASELINE) {
    const R = makeR(ctx.series), rate = R(m.s - 7 * DAY, m.s) / 168, proj = Math.round(rate * (T(m) - m.s) / HR);
    const i = m.buckets.findIndex((b) => proj >= b.lo && proj <= b.hi), b = m.buckets[i];
    const ask = b ? sideQuote(b, "yes").ask : null;
    const why = `avg7d: ${(rate * 24).toFixed(1)}/วัน → คาด ${proj}`;
    if (!b || ask == null || ask < BAND_LO || ask > BAND_HI) {
      out.dec = { ...out.dec, bucket: b?.t ?? null, ask, bid: b?.bid ?? null, reason: `${why} · ${!b ? "ไม่มี bucket" : ask == null ? "ไม่มี ask" : `ask ${c1(ask)} นอกช่วง 5–95¢`}` };
      return out;
    }
    const cost = buyCost(ask, feeRate(b)), shares = STAKE / cost;
    out.dec = { ...out.dec, action: "buy", side: "yes", bucket: b.t, price: cost, bid: b.bid ?? null, ask: b.ask ?? null, reason: why };
    if (write) {
      const { error } = await sb.from("paper_positions").insert({ mode: MODE, agent, market_slug: m.slug, market_type: type, side: "yes", bucket: b.t, entry_ts: ts, entry_price: cost, shares });
      if (error) throw error;
    }
    out.msg = `${head("⚪", `ซื้อ Yes <b>${esc(b.t)}</b>`)}\n${why}\nask ${c1(ask)} + fee → ต้นทุน ${c1(cost)} · $${STAKE} → ${shares.toFixed(1)} หุ้น`;
    return out;
  }

  // model agents
  if (!ctx.P.has(m.slug)) { const cur = await countNow(m, now); ctx.P.set(m.slug, { cur, P: modelP(m, cur, ctx.series, now) }); }
  const { cur, P } = ctx.P.get(m.slug)!;
  const pos = ctx.open.find((p) => p.agent === agent && p.market_slug === m.slug);
  if (!pos) {
    const be = bestEntry(m, P);
    if (!be || be.edge < ENTRY) {
      const b = be ? m.buckets[be.i] : null;
      out.dec = { ...out.dec, side: be?.side ?? null, bucket: b?.t ?? null, ask: b?.ask ?? null, bid: b?.bid ?? null, p_model: be ? P[be.i] : null, edge: be?.edge ?? null, reason: be ? `edge ดีสุด ${pp(be.edge)} < ${pp(ENTRY)} (ยอด ${cur})` : "ไม่มีราคาในช่วง 5–95¢" };
      return out;
    }
    const b = m.buckets[be.i], shares = STAKE / be.cost;
    out.dec = { ...out.dec, action: "buy", side: be.side, bucket: b.t, price: be.cost, bid: b.bid ?? null, ask: b.ask ?? null, p_model: P[be.i], edge: be.edge, reason: `edge ${pp(be.edge)} ≥ ${pp(ENTRY)} หลังหัก fee (ยอด ${cur})` };
    if (write) {
      const { error } = await sb.from("paper_positions").insert({ mode: MODE, agent, market_slug: m.slug, market_type: type, side: be.side, bucket: b.t, entry_ts: ts, entry_price: be.cost, shares });
      if (error) throw error;
    }
    out.msg = `${head(edgeIcon(be.edge), `ซื้อ ${sideTxt(be.side)} <b>${esc(b.t)}</b>`)}\n` +
      `ยอดตอนนี้ <b>${cur}</b> · โมเดล ${pct(be.Ps)} · ask ${c1(be.ask)} + fee → ต้นทุน ${c1(be.cost)} · edge <b>${pp(be.edge)}</b>\n$${STAKE} → ${shares.toFixed(1)} หุ้น`;
    return out;
  }
  const i = m.buckets.findIndex((b) => b.t === pos.bucket), b = m.buckets[i];
  if (!b) { out.dec = { ...out.dec, action: "hold", side: pos.side, bucket: pos.bucket, reason: "ไม่พบ bucket ในราคาล่าสุด" }; return out; }
  const ex = exitCheck(b, pos.side, P[i]);
  if (!ex.why) {
    out.dec = { ...out.dec, action: "hold", side: pos.side, bucket: b.t, bid: b.bid ?? null, ask: b.ask ?? null, p_model: P[i], edge: ex.edge, reason: `ถือ (P ${pct(ex.Ps)} · ขายได้ ${c1(ex.net)})` };
    return out;
  }
  const pnl = Number(pos.shares) * (ex.net! - Number(pos.entry_price));
  const why = ex.why === "take_profit" ? `ขายได้สุทธิ ${c1(ex.net)} ≥ P ${pct(ex.Ps)} + 3pp` : `edge ${pp(ex.edge!)} ≤ −5pp`;
  out.dec = { ...out.dec, action: "sell", side: pos.side, bucket: b.t, price: ex.net, bid: b.bid ?? null, ask: b.ask ?? null, p_model: P[i], edge: ex.edge, reason: why };
  if (write) {
    const { error } = await sb.from("paper_positions").update({ exit_ts: ts, exit_price: ex.net, exit_reason: ex.why, pnl }).eq("id", pos.id);
    if (error) throw error;
  }
  out.msg = `${head(pnl >= 0 ? "💰" : "🔻", `ขาย ${sideTxt(pos.side)} <b>${esc(b.t)}</b>`)}\n` +
    `${ex.why === "take_profit" ? "ทำกำไร" : "ตัดขาดทุน"}: ${why}\nซื้อ ${c1(Number(pos.entry_price))} → ขาย ${c1(ex.net)} · PnL <b>${money(pnl)}</b> (ยอด ${cur})`;
  return out;
}

/** settle open positions of markets that have ended and resolved on gamma */
async function settle(now: number, open: Pos[]) {
  const msgs: string[] = [], decs: Dec[] = [];
  const bySlug = new Map<string, Pos[]>();
  for (const p of open) bySlug.set(p.market_slug, [...(bySlug.get(p.market_slug) ?? []), p]);
  for (const [slug, ps] of bySlug) {
    // deno-lint-ignore no-explicit-any
    const ev: any = (await getJSON(`${GM}/events?slug=${encodeURIComponent(slug)}`))?.[0];
    if (!ev || Date.parse(ev.endDate) > now) continue;
    // deno-lint-ignore no-explicit-any
    const win = (ev.markets ?? []).filter((x: any) => x.groupItemTitle && Number(JSON.parse(x.outcomePrices || "[]")[0]) === 1);
    if (win.length !== 1) continue;                    // not resolved yet
    const wt = win[0].groupItemTitle as string, lines: string[] = [];
    for (const p of ps) {
      const won = (p.bucket === wt) === (p.side === "yes"), exit = won ? 1 : 0, pnl = Number(p.shares) * (exit - Number(p.entry_price));
      const { error } = await sb.from("paper_positions").update({ exit_ts: iso(now), exit_price: exit, exit_reason: "settle", settled_final: true, pnl }).eq("id", p.id);
      if (error) throw error;
      decs.push({ ts: iso(now), agent: p.agent, market_slug: slug, action: "settle", side: p.side, bucket: p.bucket, price: exit, reason: `จบที่ ${wt} · ${won ? "ถูก" : "ผิด"}` });
      lines.push(`${won ? "✅" : "❌"} ${p.agent} · ${sideTxt(p.side)} ${esc(p.bucket)} (ซื้อ ${c1(Number(p.entry_price))}) → <b>${money(pnl)}</b>`);
    }
    msgs.push(`🏁 <b>Paper · ตลาดปิด</b> ${esc(shortTitle(ev.title ?? slug))} จบที่ <b>${esc(wt)}</b>\n${lines.join("\n")}`);
  }
  await insertDecisions(decs);
  return msgs;
}

/** daily report: closed positions per agent for 1d / 3d / 7d / 30d + open positions */
async function buildReport(now: number) {
  const { data, error } = await sb.from("paper_positions").select("agent,exit_ts,pnl").eq("mode", MODE);
  if (error) throw error;
  const rows = (data ?? []) as { agent: string; exit_ts: string | null; pnl: number | null }[];
  const agents = [...AGENTS.map((a) => a.name), BASELINE];
  const blocks = agents.map((a) => {
    const mine = rows.filter((r) => r.agent === a), open = mine.filter((r) => !r.exit_ts).length;
    const ws = [1, 3, 7, 30].map((d) => {
      const c = mine.filter((r) => r.exit_ts && Date.parse(r.exit_ts) >= now - d * DAY), n = c.length;
      const pnl = c.reduce((s, r) => s + Number(r.pnl ?? 0), 0), win = c.filter((r) => Number(r.pnl) > 0).length;
      return `${d}d: ${n ? `${n} ไม้ · ถูก ${Math.round((win / n) * 100)}% · <b>${money(pnl)}</b> · ROI ${((pnl / (n * STAKE)) * 100).toFixed(0)}%` : "—"}`;
    });
    return `<b>${a}</b>${open ? ` · ถืออยู่ ${open} ไม้` : ""}\n${ws.join("\n")}`;
  });
  return `📒 <b>Paper trading (live)</b> · ${th(now)}\n$${STAKE}/ไม้ · นับไม้ที่ปิดแล้วในช่วงนั้น\n\n${blocks.join("\n\n")}`;
}

Deno.serve(async (req) => {
  if (!(await internalAuth(req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  try {
    if (body?.report) {
      const text = await buildReport(now);
      if (!body.dry) await telegram(text);
      return json({ ok: true, sent: !body.dry, text });
    }

    // dry run: what each agent would do right now on every open market (no writes)
    if (body?.dry) {
      const markets = (await fetchMarkets(now)).filter((m) => marketType(m) && m.s <= now);
      const ctx = { series: await loadSeries(now), open: await openPositions(), P: new Map() };
      const res = [];
      for (const m of markets) for (const a of [...AGENTS.map((x) => x.name), BASELINE]) {
        const r = await runDue({ m, agent: a, x: a === BASELINE ? null : Math.round((T(m) - now) / HR * 2) / 2, at: now }, now, ctx, false);
        res.push({ market: m.slug, ...r.dec, msg: r.msg });
      }
      if (body.telegram) {
        const lines = res.map((r) => `• ${r.agent} · ${esc(shortTitle(markets.find((m) => m.slug === r.market)?.title ?? r.market))}: ${r.action}${r.bucket ? ` ${r.side ? sideTxt(r.side) + " " : ""}${esc(r.bucket)}` : ""} — ${esc(r.reason)}`);
        await telegram(`🧪 <b>ทดสอบ paper (ไม่บันทึก)</b> · ${th(now)}\nถ้าตัดสินใจตอนนี้:\n${lines.join("\n")}`);
      }
      return json({ ok: true, dry: res });
    }

    // tick
    const st = await loadState(["markets", "paper"]);
    const paper = st.paper ?? { done: {}, settle_at: 0 };
    const done: Record<string, number> = paper.done ?? {};
    const markets: Market[] = (st.markets ?? []).filter((m: Market) => marketType(m));
    const due: Due[] = [], missed: Due[] = [];
    for (const m of markets) {
      const cps: Due[] = [...AGENTS.flatMap((a) => a.xs.map((x) => ({ m, agent: a.name, x, at: T(m) - x * HR }))), { m, agent: BASELINE, x: null, at: m.s }];
      for (const d of cps) {
        const key = `${d.agent}|${m.slug}|${d.x ?? "open"}`;
        if (now < d.at || done[key]) continue;
        done[key] = now;
        (now - d.at <= GRACE ? due : missed).push(d);
      }
    }
    const out: Record<string, unknown> = { due: due.length, missed: missed.length };
    const msgs: string[] = [], decs: Dec[] = [];
    for (const d of missed) decs.push({ ts: iso(now), agent: d.agent, market_slug: d.m.slug, action: "skip", reason: `${cp(d)} เลยมาแล้ว ${Math.round((now - d.at) / MIN)} นาที (ระบบไม่ได้รันตอนนั้น)` });

    if (due.length) {
      await saveState({ paper: { ...paper, done } });           // mark first: an overlapping tick must not trade twice
      const fresh = await fetchMarkets(now);                     // real bid/ask + fee right now
      const ctx = { series: await loadSeries(now), open: await openPositions(), P: new Map() };
      for (const d of due) {
        const m = fresh.find((x) => x.slug === d.m.slug) ?? d.m;
        try {
          const r = await runDue({ ...d, m }, now, ctx, true);
          decs.push(r.dec);
          if (r.msg) msgs.push(r.msg);
          if (r.dec.action === "buy" || r.dec.action === "sell") ctx.open = await openPositions();
        } catch (e) { decs.push({ ts: iso(now), agent: d.agent, market_slug: d.m.slug, action: "skip", reason: `error: ${String(e).slice(0, 200)}` }); }
      }
    }

    if (now - (paper.settle_at ?? 0) >= SETTLE_EVERY) {
      const open = await openPositions();
      if (open.length) { try { msgs.push(...await settle(now, open)); } catch (e) { out.settle_error = String(e); } }
      paper.settle_at = now;
    }

    await insertDecisions(decs);
    const errs: string[] = [];
    for (const msg of msgs) { try { await telegram(msg); } catch (e) { errs.push(String(e)); } }
    if (msgs.length) out.alerts = msgs.length;
    if (errs.length) out.alert_errors = errs;

    for (const k of Object.keys(done)) if (now - done[k] > 14 * DAY) delete done[k];
    await saveState({ paper: { ...paper, done } });
    return json({ ok: true, ...out, decisions: decs.map((d) => `${d.agent} ${d.market_slug} ${d.action} ${d.reason}`) });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
