// Paper-trading backtest v2 (v1 = 2026-11-25: checkpoint search, flat ±1–2¢ spread, no fee).
//   deno run -A scripts/backtest.ts            → report only (reports/backtest_v2_<date>.md)
//   deno run -A scripts/backtest.ts --write    → also writes .cache/backtest/sql/*.sql
//                                                (0_delete removes ALL mode='backtest' paper_* rows, then inserts v2)
// v2: half-spread by price band (research table, calibrated against real bid/ask) · taker fee r·p·(1−p) on buy and sell ·
//     no entry with fill < 0.05 or > 0.95 · model-vs-market Brier / reliability · regimes where the model does not
//     beat the market on TRAIN are not traded · edge threshold sensitivity · checkpoints fixed (no search).
// Data: posts (Supabase, publishable key, read-only) · markets (xtracker trackings + gamma) ·
//       prices (clob.polymarket.com/prices-history fidelity=1, last 48 h of each market + market open).
// No look-ahead: at checkpoint t the model sees only posts with created_at < t and prices with t' ≤ t.
import { cdf, DAY, HR, nowcast, rng, Series } from "../supabase/functions/_shared/model.ts";
import { slugCandidates } from "../supabase/functions/_shared/slug.ts";

const ROOT = new URL("../", import.meta.url);
const CACHE = new URL(".cache/backtest/", ROOT);
const WRITE = Deno.args.includes("--write");
const SIMS = Number(Deno.args.find((a) => a.startsWith("--sims="))?.slice(7) ?? 20_000);

const T0 = Date.UTC(2025, 10, 1);            // posts start (backfill)
const FROM = Date.UTC(2026, 0, 1);           // markets closing from here
const TEST_FROM = Date.UTC(2026, 8, 1);      // train: close Jan–Aug · test: close Sep–Nov
const XS = Array.from({ length: 96 }, (_, i) => (i + 1) * 0.5);   // checkpoint = T − x h, x = 0.5 … 48
const STAKE = 10, ENTRY = 0.05, TAKE = 0.03, STOP = -0.05;
const XS2 = [24.5, 17.5], XS3 = [16, 7, 2.5];  // chosen in v1 (2x = best on train, 3x = hypothesis) — not re-searched
const FEE_R = 0.01;                             // gamma feeSchedule (feeType culture_fees): rate 0.01, exponent 1, takerOnly
const BAND_LO = 0.05, BAND_HI = 0.95;           // no entry when the fill is outside [0.05, 0.95] (longshot bias)
const XT = "https://xtracker.polymarket.com/api", GM = "https://gamma-api.polymarket.com", CLOB = "https://clob.polymarket.com";

// ---------- utils ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url: string, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "elon-tweet-edge-backtest/1.0" }, signal: AbortSignal.timeout(60_000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}
async function cached<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const f = new URL(name, CACHE);
  try { return JSON.parse(await Deno.readTextFile(f)); } catch { /* miss */ }
  const v = await fn();
  await Deno.mkdir(new URL(".", f), { recursive: true });
  await Deno.writeTextFile(f, JSON.stringify(v));
  return v;
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}
const lowerBound = (a: number[], v: number) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; };
const iso = (ms: number) => new Date(ms).toISOString();
const ict = (ms: number) => new Date(ms + 7 * HR).toISOString().slice(0, 16).replace("T", " ");
const parseBucket = (raw: string) => {
  const t = raw.replace(/,/g, "").trim(), n = (t.match(/\d+/g) || []).map(Number);
  if (t.startsWith("<")) return { lo: 0, hi: n[0] - 1 };
  if (t.includes("+")) return { lo: n[0], hi: 1e9 };
  return { lo: n[0], hi: n[1] ?? n[0] };
};

// ---------- 1. posts ----------
const SB_URL = "https://ahanxplktggyqxdiydfi.supabase.co";
const SB_KEY = (await Deno.readTextFile(new URL("template.html", ROOT))).match(/sb_publishable_[A-Za-z0-9_-]+/)![0];
console.log("posts …");
const times: number[] = [];
for (let off = 0; ; off += 1000) {
  const r = await fetch(`${SB_URL}/rest/v1/posts?select=created_at&order=created_at.asc,id.asc&limit=1000&offset=${off}`, { headers: { apikey: SB_KEY } });
  if (!r.ok) throw new Error(`posts ${r.status}`);
  const rows: { created_at: string }[] = await r.json();
  for (const x of rows) times.push(Date.parse(x.created_at));
  if (rows.length < 1000) break;
}
times.sort((a, b) => a - b);
const countIn = (a: number, b: number) => lowerBound(times, b) - lowerBound(times, a);   // [a, b)
const H = new Array<number>(Math.floor((Date.now() - T0) / HR) + 1).fill(0);
for (const t of times) if (t >= T0) H[Math.floor((t - T0) / HR)]++;
/** series as seen at time t: full hours before t + the partial current hour (posts < t only) */
function seriesAt(t: number): Series {
  const i = Math.floor((t - T0) / HR), h = H.slice(0, i);
  h.push(countIn(T0 + i * HR, t));
  return { t0: T0, h };
}
console.log(`  ${times.length} posts ${iso(times[0])} → ${iso(times[times.length - 1])}`);

// ---------- 2. markets ----------
type B = { t: string; lo: number; hi: number; token: string; win: boolean };
type M = { slug: string; title: string; type: "48h" | "7d"; s: number; e: number; T: number; buckets: B[] };
const markets: M[] = await cached("markets.json", async () => {
  const u = await getJSON(`${XT}/users/elonmusk?platform=X`);
  const tr = u.data.trackings.filter((t: any) => {
    const s = Date.parse(t.startDate), e = Date.parse(t.endDate), d = (e - s) / DAY;
    return e >= FROM && e + 1000 <= Date.now() - HR && (d < 3 || (d > 6 && d < 8));
  });
  const out = await pool(tr, 6, async (t: any) => {
    let slug = "", ev: any = null;
    for (const c of slugCandidates(t)) { ev = (await getJSON(`${GM}/events?slug=${encodeURIComponent(c)}`))?.[0]; if (ev) { slug = c; break; } }
    if (!ev) return null;
    const buckets: B[] = [];
    for (const x of ev.markets ?? []) {
      if (!x.groupItemTitle) continue;
      const op = JSON.parse(x.outcomePrices || "[]"), tok = JSON.parse(x.clobTokenIds || "[]");
      buckets.push({ t: x.groupItemTitle, ...parseBucket(x.groupItemTitle), token: tok[0], win: Number(op[0]) === 1 });
    }
    buckets.sort((a, b) => a.lo - b.lo);
    if (buckets.filter((b) => b.win).length !== 1) return null;   // unresolved / ambiguous
    const s = Date.parse(t.startDate), e = Date.parse(t.endDate);
    return { slug, title: t.title, type: (e - s) / DAY < 3 ? "48h" : "7d", s, e, T: e + 1000, buckets } as M;
  });
  return out.filter(Boolean).sort((a: any, b: any) => a.T - b.T) as M[];
});
console.log(`markets: ${markets.length} (48h ${markets.filter((m) => m.type === "48h").length}, 7d ${markets.filter((m) => m.type === "7d").length})`);

// ---------- 3. prices on the grid: G[0] = open, G[k] = T − XS[k−1] ----------
const grid = (m: M) => [m.s, ...XS.map((x) => m.T - x * HR)];
const gi = (x: number) => 1 + XS.indexOf(x);
async function history(token: string, a: number, b: number) {
  const j = await getJSON(`${CLOB}/prices-history?market=${token}&startTs=${Math.floor(a / 1000)}&endTs=${Math.ceil(b / 1000)}&fidelity=1`);
  return ((j?.history ?? []) as { t: number; p: number }[]).sort((x, y) => x.t - y.t);
}
const latestAt = (h: { t: number; p: number }[], g: number) => {
  let v: number | null = null;
  for (const pt of h) { if (pt.t * 1000 <= g) v = pt.p; else break; }
  return v;
};
let done = 0;
const PRICES: (number | null)[][][] = await pool(markets, 3, async (m) => {
  const r = await cached(`prices/${m.slug}.json`, async () => {
    const G = grid(m), p: Record<string, (number | null)[]> = {};
    await pool(m.buckets, 4, async (b) => {
      const late = await history(b.token, m.T - 48 * HR - 30 * 60_000, m.T);
      const open = m.type === "7d" ? await history(b.token, m.s - 60 * 60_000, m.s + 60_000) : late;
      p[b.token] = G.map((g, k) => latestAt(k === 0 ? open : late, g));
    });
    return p;
  });
  if (++done % 20 === 0) console.log(`  prices ${done}/${markets.length}`);
  return m.buckets.map((b) => r[b.token]);           // [bucket][grid]
});

// ---------- 4. model P on every checkpoint ----------
console.log(`model (${SIMS} sims × ${markets.length} markets × ${XS.length} checkpoints) …`);
const PM: number[][][] = await cached(`model_${SIMS}.json`, async () => {
  const t0 = performance.now();
  return markets.map((m, mi) => {
    const G = grid(m);
    const rows = G.map((t, k) => {
      if (k === 0) return [];
      const { x } = nowcast({ series: seriesAt(t), now: t, s: m.s, e: m.e, cur: countIn(m.s, t), sims: SIMS, seed: mi * 1000 + k });
      const P = cdf(x);
      return m.buckets.map((b) => Math.max(0, P(b.lo, b.hi)));
    });
    if ((mi + 1) % 25 === 0) console.log(`  model ${mi + 1}/${markets.length} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
    return rows;                                     // [grid][bucket]
  });
});

// ---------- 5. costs ----------
/** price band of q: 0 <0.05 · 1 0.05–0.10 · 2 0.10–0.20 · 3 0.20–0.40 · 4 0.40–0.95 · 5 >0.95 */
const bandOf = (q: number) => (q < 0.05 ? 0 : q < 0.10 ? 1 : q < 0.20 ? 2 : q < 0.40 ? 3 : q <= 0.95 ? 4 : 5);
const BAND_NAMES = ["< 0.05", "0.05–0.10", "0.10–0.20", "0.20–0.40", "0.40–0.95", "> 0.95"];
const RES = [0.66, 0.29, 0.13, 0.05, 0.02, 0.02];   // research: half-spread / price (> 0.95 not in the table → 0.02)
type Cost = { hs: (q: number) => number; ask: (q: number) => number; buy: (q: number) => number; sell: (q: number) => number };
/** buy cost / share = ask + fee(ask) · sell proceeds / share = bid − fee(bid) · fee(f) = r·f·(1−f) (taker, both sides) */
function mkCost(table: number[], r: number): Cost {
  const hs = (q: number) => q * table[bandOf(q)], fe = (f: number) => r * f * (1 - f);
  return { hs, ask: (q) => q + hs(q), buy: (q) => { const f = q + hs(q); return f + fe(f); }, sell: (q) => { const f = Math.max(0, q - hs(q)); return f - fe(f); } };
}
const v1hs = (q: number) => (q < 0.05 || q > 0.95 ? 0.02 : 0.01);
const V1: Cost = { hs: v1hs, ask: (q) => q + v1hs(q), buy: (q) => q + v1hs(q), sell: (q) => q - 0.01 };

// calibration: real top-of-book bid/ask (table prices = 1 h on 2026-11-25 · state.markets = latest quotes of open markets)
async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return await r.json();
}
const quotes: { b: number; a: number; src: string }[] = [];
for (let off = 0; ; off += 1000) {
  const rows = await sbGet(`prices?select=bid,ask&bid=not.is.null&ask=not.is.null&limit=1000&offset=${off}`);
  for (const x of rows) quotes.push({ b: +x.bid, a: +x.ask, src: "prices" });
  if (rows.length < 1000) break;
}
try {
  const st = await sbGet("state?key=eq.markets&select=value");
  for (const mk of st[0]?.value ?? []) for (const k of mk.buckets ?? []) if (k.bid != null && k.ask != null) quotes.push({ b: +k.bid, a: +k.ask, src: "state" });
} catch (e) { console.log(`  state.markets not readable: ${e}`); }
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const calRatios: number[][] = BAND_NAMES.map(() => []), calCents: number[][] = BAND_NAMES.map(() => []);
for (const { a, b } of quotes) if (a > b && b > 0) { const m = (a + b) / 2, i = bandOf(m); calRatios[i].push((a - b) / 2 / m); calCents[i].push((a - b) / 2 * 100); }
const CAL = RES.map((v, i) => (calRatios[i].length >= 10 ? median(calRatios[i]) : v));   // < 10 quotes → keep research value
console.log(`calibration: ${quotes.length} quotes → ${CAL.map((v) => v.toFixed(3)).join(" / ")}`);

// ---------- 6. model accuracy vs market (every checkpoint × bucket with a price) ----------
const idx = (f: (m: M) => boolean) => markets.map((m, i) => (f(m) ? i : -1)).filter((i) => i >= 0);
const TRAIN = idx((m) => m.T < TEST_FROM), TEST = idx((m) => m.T >= TEST_FROM);
const isTest = new Set(TEST);
type Rec = { mi: number; x: number; P: number; p: number; y: number };
const RECS: Rec[] = [];
markets.forEach((m, mi) => XS.forEach((x) => {
  const k = gi(x);
  m.buckets.forEach((b, bi) => { const p = PRICES[mi][bi][k]; if (p != null) RECS.push({ mi, x, P: PM[mi][k][bi], p, y: b.win ? 1 : 0 }); });
}));
const active = (r: Rec) => r.P >= 0.03 || r.p >= 0.03;          // buckets where trading is possible
function brier(rs: Rec[]) {
  let a = 0, b = 0;
  for (const r of rs) { a += (r.P - r.y) ** 2; b += (r.p - r.y) ** 2; }
  return { n: rs.length, model: rs.length ? a / rs.length : NaN, market: rs.length ? b / rs.length : NaN };
}
const NXB = 12, xb = (x: number) => Math.min(NXB - 1, Math.ceil(x / 4) - 1);   // x bins (0,4] (4,8] … (44,48]
const xbName = (i: number) => `${i * 4}–${i * 4 + 4}`;
const TYPES = ["48h", "7d"] as const;
const regime = (type: string, i: number, test: boolean) => RECS.filter((r) => isTest.has(r.mi) === test && markets[r.mi].type === type && xb(r.x) === i && active(r));
/** gate from TRAIN only: trade a (type, x-bin) only where the model's Brier on active buckets beats the market's */
const BLOCK = new Set<string>();
for (const t of TYPES) for (let i = 0; i < NXB; i++) { const s = brier(regime(t, i, false)); if (!(s.model < s.market)) BLOCK.add(`${t}|${i}`); }
const blocked = (m: M, x: number) => BLOCK.has(`${m.type}|${xb(x)}`);

// ---------- 7. agents ----------
type Cfg = { cost: Cost; band: boolean; gate: boolean; entry: number };
type Pos = { m: M; side: "yes" | "no"; b: number; k0: number; entry: number; shares: number; k1: number | null; exit: number; reason: string; pnl: number; t1: number };
type Dec = { ts: number; m: M; action: string; side?: string; b?: number; price?: number; p?: number; P?: number; edge?: number; reason: string };
const pp = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}pp`;

/** best entry at grid k: max over buckets and sides of P_side − buy cost(price_side) */
function bestEntry(mi: number, k: number, c: Cfg) {
  const m = markets[mi], P = PM[mi][k];
  let best: { b: number; side: "yes" | "no"; cost: number; edge: number; p: number; P: number } | null = null;
  for (let b = 0; b < m.buckets.length; b++) {
    const p = PRICES[mi][b][k];
    if (p == null) continue;
    for (const side of ["yes", "no"] as const) {
      const q = side === "yes" ? p : 1 - p, Ps = side === "yes" ? P[b] : 1 - P[b], ask = c.cost.ask(q), cost = c.cost.buy(q);
      if (cost >= 1 || (c.band && (ask < BAND_LO || ask > BAND_HI))) continue;
      const edge = Ps - cost;
      if (!best || edge > best.edge) best = { b, side, cost, edge, p, P: P[b] };
    }
  }
  return best;
}

function runAgent(mi: number, xs: number[], c: Cfg, log?: Dec[]): Pos[] {
  const m = markets[mi], G = grid(m), out: Pos[] = [];
  let pos: Pos | null = null;
  for (const x of [...xs].sort((a, b) => b - a)) {
    const k = gi(x), ts = G[k];
    if (!pos) {
      if (c.gate && blocked(m, x)) { log?.push({ ts, m, action: "skip", reason: `ช่วง ${m.type} T−${xbName(xb(x))}h โมเดลไม่ชนะตลาด (train) → ไม่เทรด` }); continue; }
      const be = bestEntry(mi, k, c);
      if (be && be.edge >= c.entry) {
        pos = { m, side: be.side, b: be.b, k0: k, entry: be.cost, shares: STAKE / be.cost, k1: null, exit: 0, reason: "", pnl: 0, t1: m.T };
        log?.push({ ts, m, action: "buy", side: be.side, b: be.b, price: be.cost, p: be.p, P: be.P, edge: be.edge, reason: `edge ${pp(be.edge)} ≥ ${pp(c.entry)} (หลังหัก spread + fee)` });
      } else log?.push({ ts, m, action: "skip", side: be?.side, b: be?.b, p: be?.p, P: be?.P, edge: be?.edge, reason: be ? `edge ดีสุด ${pp(be.edge)} < ${pp(c.entry)}` : "ไม่มีราคาในช่วง 5–95¢" });
      continue;
    }
    const p = PRICES[mi][pos.b][k];
    if (p == null) { log?.push({ ts, m, action: "hold", side: pos.side, b: pos.b, reason: "ไม่มีราคา" }); continue; }
    const P = PM[mi][k][pos.b], q = pos.side === "yes" ? p : 1 - p, Ps = pos.side === "yes" ? P : 1 - P;
    const bid = c.cost.sell(q), edge = Ps - c.cost.buy(q);
    const why = bid >= Ps + TAKE ? "take_profit" : edge <= STOP ? "stop_loss" : null;
    if (why) {
      pos.k1 = k; pos.exit = Math.max(0, bid); pos.reason = why; pos.pnl = pos.shares * (pos.exit - pos.entry); pos.t1 = ts;
      log?.push({ ts, m, action: "sell", side: pos.side, b: pos.b, price: pos.exit, p, P, edge, reason: why === "take_profit" ? `ขายได้ ${(bid * 100).toFixed(1)}¢ ≥ P+3pp` : `edge ${pp(edge)} ≤ −5pp` });
      out.push(pos); pos = null;
    } else log?.push({ ts, m, action: "hold", side: pos.side, b: pos.b, p, P, edge, reason: "ถือ" });
  }
  if (pos) {
    const won = m.buckets[pos.b].win === (pos.side === "yes");
    pos.exit = won ? 1 : 0; pos.reason = "settle"; pos.pnl = pos.shares * (pos.exit - pos.entry); pos.t1 = m.T;
    log?.push({ ts: m.T, m, action: "settle", side: pos.side, b: pos.b, price: pos.exit, reason: won ? "ถูก" : "ผิด" });
    out.push(pos);
  }
  return out;
}

/** baseline avg7d: at open buy Yes in the bucket containing count + (posts last 7 d / 168) × hours left; hold (no gate) */
function runBaseline(mi: number, c: Cfg, log?: Dec[]): Pos[] {
  const m = markets[mi], rate = countIn(m.s - 7 * DAY, m.s) / 168, proj = Math.round(rate * (m.T - m.s) / HR);
  const b = m.buckets.findIndex((x) => proj >= x.lo && proj <= x.hi), p = b >= 0 ? PRICES[mi][b][0] : null;
  if (b < 0 || p == null) { log?.push({ ts: m.s, m, action: "skip", reason: `proj ${proj}: ไม่มีราคา` }); return []; }
  const ask = c.cost.ask(p), entry = c.cost.buy(p);
  if (entry >= 1 || (c.band && (ask < BAND_LO || ask > BAND_HI))) { log?.push({ ts: m.s, m, action: "skip", b, p, reason: `proj ${proj}: ราคา ${(ask * 100).toFixed(1)}¢ นอกช่วง 5–95¢` }); return []; }
  const shares = STAKE / entry, won = m.buckets[b].win;
  log?.push({ ts: m.s, m, action: "buy", side: "yes", b, price: entry, p, reason: `avg7d: ${(rate * 24).toFixed(1)}/วัน → คาด ${proj}` });
  log?.push({ ts: m.T, m, action: "settle", side: "yes", b, price: won ? 1 : 0, reason: won ? "ถูก" : "ผิด" });
  return [{ m, side: "yes", b, k0: 0, entry, shares, k1: null, exit: won ? 1 : 0, reason: "settle", pnl: shares * ((won ? 1 : 0) - entry), t1: m.T }];
}

type Stats = { n: number; pnl: number; roi: number; win: number; mdd: number; early: number; held: number; markets: number };
function stats(ps: Pos[], nMarkets: number): Stats {
  const pnl = ps.reduce((s, p) => s + p.pnl, 0), n = ps.length;
  let cum = 0, peak = 0, mdd = 0;
  for (const p of [...ps].sort((a, b) => a.t1 - b.t1)) { cum += p.pnl; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  return {
    n, pnl, roi: n ? pnl / (n * STAKE) : 0, win: n ? ps.filter((p) => p.pnl > 0).length / n : 0, mdd,
    early: ps.filter((p) => p.reason !== "settle").reduce((s, p) => s + p.pnl, 0),
    held: ps.filter((p) => p.reason === "settle").reduce((s, p) => s + p.pnl, 0), markets: nMarkets,
  };
}

// configurations
const C_V1: Cfg = { cost: V1, band: false, gate: false, entry: ENTRY };
const C_RES0: Cfg = { cost: mkCost(RES, 0), band: false, gate: false, entry: ENTRY };
const C_RESF: Cfg = { cost: mkCost(RES, FEE_R), band: false, gate: false, entry: ENTRY };
const C_V2: Cfg = { cost: mkCost(RES, FEE_R), band: true, gate: false, entry: ENTRY };         // main v2 (written to DB)
const C_GATE: Cfg = { ...C_V2, gate: true };   // tested, not used: the per-regime Brier gate flips sign train → test and blocks every 3x checkpoint
const C_CAL: Cfg = { ...C_V2, cost: mkCost(CAL, FEE_R) };
const C_F05: Cfg = { ...C_V2, cost: mkCost(RES, 0.05) };
type Agent = { name: string; run: (i: number, c: Cfg, log?: Dec[]) => Pos[] };
const A2: Agent = { name: "2x", run: (i, c, l) => runAgent(i, XS2, c, l) };
const A3: Agent = { name: "3x", run: (i, c, l) => runAgent(i, XS3, c, l) };
const AB: Agent = { name: "avg7d", run: (i, c, l) => runBaseline(i, c, l) };

// ---------- 8. report ----------
const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
const fx = (xs: number[]) => xs.map((x) => `T−${x}h`).join(", ");
/** 90% bootstrap CI of total PnL, resampling markets (events) — 2,000 draws, fixed seed */
function ci(per: number[]) {
  if (!per.length) return "—";
  const rnd = rng(12345), sums: number[] = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let i = 0; i < per.length; i++) s += per[(rnd() * per.length) | 0]; sums.push(s); }
  sums.sort((x, y) => x - y);
  const f = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(0)}`;
  return `${f(sums[100])} … ${f(sums[1899])}`;
}
const perM = (a: Agent, c: Cfg, ids: number[]) => ids.map((i) => a.run(i, c).reduce((s, p) => s + p.pnl, 0));
const st = (a: Agent, c: Cfg, ids: number[]) => stats(ids.flatMap((i) => a.run(i, c)), ids.length);
const head = "| agent | ไม้ | PnL | 90% CI (bootstrap ระดับตลาด) | ROI | อัตราถูก | max DD | PnL ขายระหว่างทาง | PnL ถือจนจบ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|";
const row = (name: string, a: Agent, c: Cfg, ids: number[]) => {
  const s = st(a, c, ids);
  return `| ${name} | ${s.n} | ${money(s.pnl)} | ${ci(perM(a, c, ids))} | ${pc(s.roi)} | ${pc(s.win)} | ${money(-s.mdd)} | ${money(s.early)} | ${money(s.held)} |`;
};
const block = (title: string, ids: number[]) => [
  `### ${title} (${ids.length} ตลาด)`, head,
  row("**2x v2**", A2, C_V2, ids), row("**3x v2**", A3, C_V2, ids), row("**avg7d v2**", AB, C_V2, ids),
  row("2x v2 + ปิดช่วง (ไม่ใช้)", A2, C_GATE, ids), row("3x v2 + ปิดช่วง (ไม่ใช้)", A3, C_GATE, ids),
  row("2x v1", A2, C_V1, ids), row("3x v1", A3, C_V1, ids), row("avg7d v1", AB, C_V1, ids), ""].join("\n");
const by = (f: (m: M) => boolean, ids: number[]) => ids.filter((i) => f(markets[i]));
const cell = (a: Agent, c: Cfg, ids: number[]) => { const s = st(a, c, ids); return `${money(s.pnl)} (${s.n}) · ${ci(perM(a, c, ids))}`; };
const steps: [string, Cfg][] = [
  ["v1: spread ±1–2¢ · ไม่มี fee", C_V1], ["① spread ตามระดับราคา (ตารางงานวิจัย)", C_RES0], ["② + fee taker r = 0.01", C_RESF],
  ["**③ + ห้ามซื้อนอก 5–95¢ = v2**", C_V2], ["④ + ไม่เทรดช่วงที่โมเดลไม่ชนะตลาด (ทดสอบแล้ว ไม่ใช้)", C_GATE],
  ["v2 แต่ spread ตามที่ calibrate", C_CAL], ["v2 แต่ fee r = 0.05", C_F05],
];
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "—");
const skill = (s: { model: number; market: number }) => (Number.isFinite(s.model) && s.market > 0 ? `${((1 - s.model / s.market) * 100).toFixed(1)}%` : "—");
const brRow = (name: string, rs: Rec[]) => { const s = brier(rs); return `| ${name} | ${s.n.toLocaleString()} | ${f3(s.model)} | ${f3(s.market)} | ${skill(s)} |`; };
const trainR = RECS.filter((r) => !isTest.has(r.mi)), testR = RECS.filter((r) => isTest.has(r.mi));
function relTable(rs: Rec[]) {
  const B = (f: (r: Rec) => number) => {
    const o = Array.from({ length: 10 }, () => ({ n: 0, s: 0, y: 0 }));
    for (const r of rs) { const v = f(r), i = Math.min(9, Math.floor(v * 10)); o[i].n++; o[i].s += v; o[i].y += r.y; }
    return o;
  };
  const a = B((r) => r.P), b = B((r) => r.p), f = (o: { n: number; s: number; y: number }) => o.n ? `${o.n.toLocaleString()} | ${pc(o.s / o.n)} | ${pc(o.y / o.n)}` : "0 | — | —";
  return ["| ช่วงที่ทาย | โมเดล: n | ทายเฉลี่ย | เกิดจริง | ตลาด: n | ทายเฉลี่ย | เกิดจริง |", "|---|---:|---:|---:|---:|---:|---:|",
    ...a.map((_, i) => `| ${i * 10}–${i * 10 + 10}% | ${f(a[i])} | ${f(b[i])} |`)].join("\n");
}
const regimeRows = TYPES.flatMap((t) => Array.from({ length: NXB }, (_, i) => {
  const tr = brier(regime(t, i, false)), te = brier(regime(t, i, true));
  return `| ${t} | ${xbName(i)} | ${tr.n} | ${f3(tr.model)} | ${f3(tr.market)} | ${skill(tr)} | ${te.n} | ${f3(te.model)} | ${f3(te.market)} | ${skill(te)} | ${BLOCK.has(`${t}|${i}`) ? "❌ ไม่เทรด" : "✅ เทรด"} |`;
}));
const usedRegimes = (xs: number[]) => TYPES.map((t) => `${t}: ${xs.map((x) => `T−${x}h ${BLOCK.has(`${t}|${xb(x)}`) ? "❌" : "✅"}`).join(" · ")}`).join(" | ");
const sensRow = (c: Cfg, e: number) => {
  const cc = { ...c, entry: e }, f = (a: Agent, ids: number[]) => { const s = st(a, cc, ids); return `${money(s.pnl)} (${s.n})`; };
  return `| ${(e * 100).toFixed(0)}pp | ${f(A2, TRAIN)} | ${f(A2, TEST)} | ${f(A3, TRAIN)} | ${f(A3, TEST)} |`;
};
const sensHead = "| เกณฑ์ edge | 2x train | 2x test | 3x train | 3x test |\n|---:|---:|---:|---:|---:|";

const today = new Date(Date.now() + 7 * HR).toISOString().slice(0, 10);
const md = [
  `# Backtest paper trading v2 — ${today}`,
  "",
  "## สรุป",
  `- ข้อมูลชุดเดิมของ v1: ${markets.length} ตลาดที่ปิดแล้ว (48h ${markets.filter((m) => m.type === "48h").length}, 7d ${markets.filter((m) => m.type === "7d").length}) · train = ปิด ม.ค.–ส.ค. 2026 (${TRAIN.length}) · test = ปิด ก.ย.–พ.ย. 2026 (${TEST.length})`,
  `- checkpoint ชุดเดิม ไม่ค้นหาใหม่: 2x = ${fx(XS2)} · 3x = ${fx(XS3)} · baseline avg7d`,
  `- test ($${STAKE}/ไม้): 2x v2 ${cell(A2, C_V2, TEST)} · 3x v2 ${cell(A3, C_V2, TEST)} · avg7d v2 ${cell(AB, C_V2, TEST)}  — รูปแบบ: PnL (จำนวนไม้) · 90% CI`,
  `- เทียบ v1 บน test: 2x ${cell(A2, C_V1, TEST)} · 3x ${cell(A3, C_V1, TEST)} · avg7d ${cell(AB, C_V1, TEST)}`,
  "",
  "## สิ่งที่เปลี่ยนจาก v1",
  `- **spread**: half-spread = สัดส่วนของราคา q ของฝั่งที่เทรด (Yes = p, No = 1−p): ${BAND_NAMES.map((b, i) => `${b}: ${RES[i]}q`).join(" · ")} (ช่วง > 0.95 ไม่มีในตาราง ใช้ 0.02q) · ซื้อที่ q + hs · ขายที่ q − hs`,
  `- **fee**: taker r × f × (1−f) ต่อหุ้น ทั้งตอนซื้อและขาย (f = ราคาที่ fill) · r = ${FEE_R} จาก gamma \`feeSchedule\` ของตลาดนี้ (feeType culture_fees, exponent 1, takerOnly) · settle ไม่มี fee · ทดสอบ r = 0.05 ด้วย`,
  `- **ห้ามซื้อ** เมื่อราคาที่ fill < ${BAND_LO} หรือ > ${BAND_HI} (ใช้กับ baseline ด้วย)`,
  "- **ปิดช่วง (ทดสอบแล้ว ไม่ใช้ใน v2)**: แบ่งตาม (ประเภทตลาด × x ทีละ 4 ชม.) ช่วงไหนบน train โมเดลมี Brier (bucket ที่ P หรือราคา ≥ 3%) ไม่ต่ำกว่าตลาด → ไม่เปิดไม้ช่วงนั้น · ผล: ปิดทุก checkpoint ของ 3x และ 2x ฝั่ง 7d · skill ราย 4 ชม. บน train กับ test สลับเครื่องหมายบ่อย (สัญญาณไม่เสถียร) และบน test ทำ PnL แย่ลง → user เลือกไม่ใช้ (27 พ.ย.)",
  "- edge = P ฝั่งนั้น − ต้นทุนต่อหุ้น (ราคา fill + fee) · ขายเมื่อรายรับสุทธิต่อหุ้น ≥ P + 3pp หรือ edge ≤ −5pp (เหมือน v1)",
  "- 90% CI: bootstrap ระดับตลาด (สุ่มตลาดซ้ำ 2,000 รอบ) เหมือน v1",
  "",
  "## เทียบ v1 → v2 ทีละขั้น (test) — PnL (จำนวนไม้) · 90% CI",
  "| ขั้น | 2x | 3x | avg7d |", "|---|---:|---:|---:|",
  ...steps.map(([n, c]) => `| ${n} | ${cell(A2, c, TEST)} | ${cell(A3, c, TEST)} | ${cell(AB, c, TEST)} |`),
  "",
  "## ผลบน test (ก.ย.–พ.ย. 2026)",
  block("ทั้งหมด", TEST), block("48h", by((m) => m.type === "48h", TEST)), block("7d", by((m) => m.type === "7d", TEST)),
  "## ผลบน train (ม.ค.–ส.ค. 2026) — ใช้กำหนดช่วงที่ไม่เทรด",
  block("ทั้งหมด", TRAIN),
  "## Sensitivity: เกณฑ์ edge — PnL (จำนวนไม้)",
  "### v2 (spread ตารางงานวิจัย)", sensHead, ...[0.05, 0.08, 0.10, 0.15].map((e) => sensRow(C_V2, e)), "",
  "### v2 แต่ spread ตามที่ calibrate", sensHead, ...[0.05, 0.08, 0.10, 0.15].map((e) => sensRow(C_CAL, e)), "",
  "### v2 + ปิดช่วง (ไม่ใช้)", sensHead, ...[0.05, 0.08, 0.10, 0.15].map((e) => sensRow(C_GATE, e)), "",
  "## ความแม่นของโมเดลเทียบตลาด",
  "Brier = ค่าเฉลี่ย (ความน่าจะเป็นที่ทาย − ผลจริง 0/1)² ต่อ bucket ทุก checkpoint (x = 0.5…48 ชม.) ที่มีราคา · ยิ่งต่ำยิ่งดี · skill = 1 − Brier โมเดล / Brier ตลาด (บวก = โมเดลดีกว่า) · ตลาด = ราคากลางจาก prices-history",
  "",
  "| ชุด | n | Brier โมเดล | Brier ตลาด | skill |", "|---|---:|---:|---:|---:|",
  brRow("train · ทุก bucket", trainR), brRow("train · P หรือราคา ≥ 3%", trainR.filter(active)),
  brRow("test · ทุก bucket", testR), brRow("test · P หรือราคา ≥ 3%", testR.filter(active)),
  ...TYPES.flatMap((t) => [brRow(`${t} train · ≥ 3%`, trainR.filter((r) => active(r) && markets[r.mi].type === t)), brRow(`${t} test · ≥ 3%`, testR.filter((r) => active(r) && markets[r.mi].type === t))]),
  "",
  "### ตามช่วงเวลาก่อนปิด (bucket ที่ P หรือราคา ≥ 3%) → ช่วงที่ agent เทรด",
  "| ตลาด | x (ชม.) | train n | โมเดล | ตลาด | skill | test n | โมเดล | ตลาด | skill | ตัดสินจาก train |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...regimeRows, "",
  `- checkpoint ของ agent: 2x → ${usedRegimes(XS2)}`,
  `- 3x → ${usedRegimes(XS3)}`,
  "",
  ...TYPES.flatMap((t) => [`### Reliability ${t} (train + test, ทุก bucket) — ทายไว้ X% แล้วเกิดจริงกี่ %`, relTable(RECS.filter((r) => markets[r.mi].type === t)), ""]),
  "## Calibrate spread กับ bid/ask จริง",
  `${quotes.length} quotes (ตาราง \`prices\` 1 ชม. ของ 25 พ.ย. + \`state.markets\` ล่าสุด) · ใช้เฉพาะที่มีทั้ง bid และ ask และ ask > bid > 0 · half-spread / ราคากลาง`,
  "| ช่วงราคา | n | ตารางงานวิจัย | จริง (มัธยฐาน) | จริง (¢, มัธยฐาน) | ใช้ใน \"calibrate\" |", "|---|---:|---:|---:|---:|---:|",
  ...BAND_NAMES.map((b, i) => `| ${b} | ${calRatios[i].length} | ${RES[i]} | ${calRatios[i].length ? median(calRatios[i]).toFixed(3) : "—"} | ${calCents[i].length ? median(calCents[i]).toFixed(2) : "—"} | ${CAL[i].toFixed(3)}${calRatios[i].length < 10 ? " (n < 10 ใช้ค่างานวิจัย)" : ""} |`),
  "",
  "## ข้อจำกัด",
  "- ราคาในอดีตเป็นราคากลางจาก prices-history ไม่ใช่ bid/ask จริง → spread เป็นค่าประมาณ · ข้อมูล bid/ask จริงมีน้อย (ส่วนใหญ่ 1 ชม.) และเป็น top-of-book ไม่รวมความลึก",
  "- fee: r = 0.01 อ่านจาก gamma ณ วันนี้ · ไม่ทราบว่าตลาดช่วง ม.ค.–พ.ย. เก็บ fee อัตราเดียวกันหรือไม่ (Polymarket ปรับโครงสร้าง fee 20 พ.ย. 2026) → ดูแถว r = 0.05 เป็นกรณีแย่",
  "- Brier: bucket ในตลาดเดียวกันไม่อิสระต่อกัน และ checkpoint ที่ติดกันมีข้อมูลซ้อนกัน → n ดูเยอะกว่าจริง · การปิดช่วงใช้ 24 ช่วง ช่วงที่ข้อมูลน้อยอาจตัดสินผิด",
  "- test มี ~60 ตลาด → ดู 90% CI ก่อนสรุปว่าชุดไหนดีกว่า",
  "- ตลาด/ราคา/โมเดลใช้แคชชุดเดียวกับ v1 (`.cache/backtest/`) · โพสต์ดึงใหม่จากตาราง posts",
  "",
].join("\n");
await Deno.mkdir(new URL("reports/", ROOT), { recursive: true });
const reportFile = new URL(`reports/backtest_v2_${today}.md`, ROOT);
await Deno.writeTextFile(reportFile, md);
console.log(`report → ${reportFile.pathname}`);
console.log(`blocked regimes: ${[...BLOCK].join(", ")}`);

// ---------- 9. SQL: replace paper_* mode='backtest' with v2 (C_V2) + price_cache ----------
if (WRITE) {
  const q = (v: unknown) => v == null ? "null" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(6)) : "null") : `'${String(v).replace(/'/g, "''")}'`;
  const dec: string[] = [], pos: string[] = [], pcs: string[] = [];
  const used = new Set<string>();
  const hs = C_V2.cost.hs;
  for (const [a, xs] of [[A2, XS2], [A3, XS3], [AB, null]] as [Agent, number[] | null][]) {
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i], log: Dec[] = [], ps = a.run(i, C_V2, log);
      for (const d of log) {
        const b = d.b != null ? m.buckets[d.b].t : null;
        dec.push(`(${q(iso(d.ts))},'backtest',${q(a.name)},${q(m.slug)},${q(d.action)},${q(d.side)},${q(b)},${q(d.price)},${q(d.p != null ? Math.max(0, d.p - hs(d.p)) : null)},${q(d.p != null ? d.p + hs(d.p) : null)},${q(d.P)},${q(d.edge)},${q(d.reason)})`);
      }
      for (const p of ps) {
        const G = grid(m);
        pos.push(`('backtest',${q(a.name)},${q(m.slug)},${q(m.type)},${q(p.side)},${q(m.buckets[p.b].t)},${q(iso(G[p.k0]))},${q(p.entry)},${q(p.shares)},${q(iso(p.t1))},${q(p.exit)},${q(p.reason)},${p.reason === "settle"},${q(p.pnl)})`);
      }
      for (const k of xs ? xs.map(gi) : [0]) m.buckets.forEach((b, bi) => {
        const p = PRICES[i][bi][k], key = `${b.token}|${grid(m)[k]}`;
        if (p != null && !used.has(key)) { used.add(key); pcs.push(`(${q(b.token)},${q(iso(grid(m)[k]))},${q(p)},${q(m.slug)},${q(b.t)})`); }
      });
    }
  }
  const dir = new URL("sql/", CACHE);
  await Deno.mkdir(dir, { recursive: true });
  for (const e of Deno.readDirSync(dir)) Deno.removeSync(new URL(e.name, dir));
  Deno.writeTextFileSync(new URL("0_delete.sql", dir), "delete from public.paper_decisions where mode = 'backtest';\ndelete from public.paper_positions where mode = 'backtest';\n");
  const chunk = (name: string, head: string, rows: string[], tail = "") => {
    for (let i = 0, n = 0; i < rows.length; i += 2000, n++) Deno.writeTextFileSync(new URL(`${name}_${String(n).padStart(3, "0")}.sql`, dir), `${head}\n${rows.slice(i, i + 2000).join(",\n")}\n${tail};\n`);
  };
  chunk("1_decisions", "insert into public.paper_decisions (ts,mode,agent,market_slug,action,side,bucket,price,bid,ask,p_model,edge,reason) values", dec);
  chunk("2_positions", "insert into public.paper_positions (mode,agent,market_slug,market_type,side,bucket,entry_ts,entry_price,shares,exit_ts,exit_price,exit_reason,settled_final,pnl) values", pos);
  chunk("3_price_cache", "insert into public.price_cache (token_id,ts,p,market_slug,bucket) values", pcs, "on conflict do nothing");
  console.log(`sql → ${dir.pathname}: decisions ${dec.length}, positions ${pos.length}, price_cache ${pcs.length}`);
}
