// Paper-trading backtest (G2) + checkpoint search (G3).
//   deno run -A scripts/backtest.ts            → report only (reports/backtest_<date>.md)
//   deno run -A scripts/backtest.ts --write    → also writes .cache/backtest/sql/*.sql for paper_* / price_cache
// Data: posts (Supabase, publishable key, read-only) · markets (xtracker trackings + gamma) ·
//       prices (clob.polymarket.com/prices-history fidelity=1, last 48 h of each market + market open).
// No look-ahead: at checkpoint t the model sees only posts with created_at < t and prices with t' ≤ t.
import { cdf, DAY, HR, nowcast, Series } from "../supabase/functions/_shared/model.ts";
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
const HYP2 = [7, 2.5], HYP3 = [16, 7, 2.5];
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

// ---------- 5. agents ----------
const buyFill = (p: number) => p + (p < 0.05 || p > 0.95 ? 0.02 : 0.01);
type Pos = { m: M; side: "yes" | "no"; b: number; k0: number; entry: number; shares: number; k1: number | null; exit: number; reason: string; pnl: number; t1: number };
type Dec = { ts: number; m: M; action: string; side?: string; b?: number; price?: number; p?: number; P?: number; edge?: number; reason: string };

/** best entry at grid k: max over buckets and sides of P_side − buyFill(price_side) */
function bestEntry(mi: number, k: number) {
  const m = markets[mi], P = PM[mi][k];
  let best: { b: number; side: "yes" | "no"; fill: number; edge: number; p: number; P: number } | null = null;
  for (let b = 0; b < m.buckets.length; b++) {
    const p = PRICES[mi][b][k];
    if (p == null) continue;
    for (const side of ["yes", "no"] as const) {
      const q = side === "yes" ? p : 1 - p, Ps = side === "yes" ? P[b] : 1 - P[b], fill = buyFill(q);
      if (fill >= 1) continue;
      const edge = Ps - fill;
      if (!best || edge > best.edge) best = { b, side, fill, edge, p, P: P[b] };
    }
  }
  return best;
}
const BEST = markets.map((_, mi) => XS.map((x) => bestEntry(mi, gi(x))));   // [market][xs idx]
const bestAt = (mi: number, k: number) => BEST[mi][k - 1];

function runAgent(mi: number, xs: number[], log?: Dec[]): Pos[] {
  const m = markets[mi], G = grid(m), out: Pos[] = [];
  let pos: Pos | null = null;
  for (const x of [...xs].sort((a, b) => b - a)) {
    const k = gi(x), ts = G[k];
    if (!pos) {
      const be = bestAt(mi, k);
      if (be && be.edge >= ENTRY) {
        pos = { m, side: be.side, b: be.b, k0: k, entry: be.fill, shares: STAKE / be.fill, k1: null, exit: 0, reason: "", pnl: 0, t1: m.T };
        log?.push({ ts, m, action: "buy", side: be.side, b: be.b, price: be.fill, p: be.p, P: be.P, edge: be.edge, reason: `edge ${(be.edge * 100).toFixed(1)}pp ≥ +5pp` });
      } else log?.push({ ts, m, action: "skip", side: be?.side, b: be?.b, p: be?.p, P: be?.P, edge: be?.edge, reason: be ? `edge ดีสุด ${(be.edge * 100).toFixed(1)}pp < +5pp` : "ไม่มีราคา" });
      continue;
    }
    const p = PRICES[mi][pos.b][k];
    if (p == null) { log?.push({ ts, m, action: "hold", side: pos.side, b: pos.b, reason: "ไม่มีราคา" }); continue; }
    const P = PM[mi][k][pos.b], q = pos.side === "yes" ? p : 1 - p, Ps = pos.side === "yes" ? P : 1 - P;
    const bid = q - 0.01, edge = Ps - buyFill(q);
    const why = bid >= Ps + TAKE ? "take_profit" : edge <= STOP ? "stop_loss" : null;
    if (why) {
      pos.k1 = k; pos.exit = Math.max(0, bid); pos.reason = why; pos.pnl = pos.shares * (pos.exit - pos.entry); pos.t1 = ts;
      log?.push({ ts, m, action: "sell", side: pos.side, b: pos.b, price: pos.exit, p, P, edge, reason: why === "take_profit" ? `bid ${(bid * 100).toFixed(1)}¢ ≥ P+3pp` : `edge ${(edge * 100).toFixed(1)}pp ≤ −5pp` });
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

/** baseline avg7d: at open buy Yes in the bucket containing count + (posts last 7 d / 168) × hours left; hold */
function runBaseline(mi: number, log?: Dec[]): Pos[] {
  const m = markets[mi], rate = countIn(m.s - 7 * DAY, m.s) / 168, proj = Math.round(rate * (m.T - m.s) / HR);
  const b = m.buckets.findIndex((x) => proj >= x.lo && proj <= x.hi), p = b >= 0 ? PRICES[mi][b][0] : null;
  if (b < 0 || p == null || buyFill(p) >= 1) { log?.push({ ts: m.s, m, action: "skip", reason: `proj ${proj}: ไม่มีราคา` }); return []; }
  const entry = buyFill(p), shares = STAKE / entry, won = m.buckets[b].win;
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
const idx = (f: (m: M) => boolean) => markets.map((m, i) => (f(m) ? i : -1)).filter((i) => i >= 0);
const TRAIN = idx((m) => m.T < TEST_FROM), TEST = idx((m) => m.T >= TEST_FROM);
const evalSet = (xs: number[], ids: number[]) => stats(ids.flatMap((i) => runAgent(i, xs)), ids.length);
const pnlOf = (xs: number[], ids: number[]) => { let s = 0; for (const i of ids) for (const p of runAgent(i, xs)) s += p.pnl; return s; };

// ---------- 6. search (train) ----------
console.log("search …");
const singles = XS.map((x) => ({ x, train: pnlOf([x], TRAIN), test: pnlOf([x], TEST), t48: pnlOf([x], idx((m) => m.type === "48h")), t7: pnlOf([x], idx((m) => m.type === "7d")) }));
let best2 = { xs: HYP2, pnl: -Infinity }, best3 = { xs: HYP3, pnl: -Infinity };
const pairPnl: number[][] = XS.map(() => XS.map(() => NaN));
for (let a = 0; a < XS.length; a++) for (let b = 0; b < a; b++) {
  const xs = [XS[a], XS[b]], v = pnlOf(xs, TRAIN);
  pairPnl[a][b] = v;
  if (v > best2.pnl) best2 = { xs, pnl: v };
}
for (let a = 0; a < XS.length; a++) for (let b = 0; b < a; b++) for (let c = 0; c < b; c++) {
  const xs = [XS[a], XS[b], XS[c]], v = pnlOf(xs, TRAIN);
  if (v > best3.pnl) best3 = { xs, pnl: v };
}
// choose: best-from-train must beat the hypothesis on TEST by more than 10% (of |hyp|), else use the hypothesis
function choose(best: number[], hyp: number[]) {
  const b = pnlOf(best, TEST), h = pnlOf(hyp, TEST);
  return { xs: b > h + 0.1 * Math.abs(h) ? best : hyp, bestTest: b, hypTest: h, usedBest: b > h + 0.1 * Math.abs(h) };
}
const ch2 = choose(best2.xs, HYP2), ch3 = choose(best3.xs, HYP3);

// ---------- 7. report ----------
const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
const fx = (xs: number[]) => xs.map((x) => `T−${x}h`).join(", ");
const row = (name: string, s: Stats, c = "") => `| ${name} | ${s.n} | ${money(s.pnl)} | ${c} | ${pc(s.roi)} | ${pc(s.win)} | ${money(-s.mdd)} | ${money(s.early)} | ${money(s.held)} |`;
/** 90% bootstrap CI of total PnL, resampling markets (2,000 draws, fixed seed) */
function ci(per: number[]) {
  if (!per.length) return "—";
  let a = 12345 >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const sums: number[] = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let i = 0; i < per.length; i++) s += per[(rnd() * per.length) | 0]; sums.push(s); }
  sums.sort((x, y) => x - y);
  const f = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(0)}`;
  return `${f(sums[100])} … ${f(sums[1899])}`;
}
const head = "| agent | ไม้ | PnL | 90% CI (bootstrap) | ROI | อัตราถูก | max DD | PnL ขายระหว่างทาง | PnL ถือจนจบ |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|";
const base = (ids: number[]) => stats(ids.flatMap((i) => runBaseline(i)), ids.length);
const perM = (fn: (i: number) => Pos[], ids: number[]) => ids.map((i) => fn(i).reduce((s, p) => s + p.pnl, 0));
const ra = (name: string, xs: number[], ids: number[]) => row(`${name} (${fx(xs)})`, evalSet(xs, ids), ci(perM((i) => runAgent(i, xs), ids)));
const block = (title: string, ids: number[]) => [
  `### ${title} (${ids.length} ตลาด)`, head,
  ra("2x ที่เลือก", ch2.xs, ids), ra("3x ที่เลือก", ch3.xs, ids),
  ra("2x ดีสุดจาก train", best2.xs, ids), ra("3x ดีสุดจาก train", best3.xs, ids),
  ra("สมมติฐาน 2x", HYP2, ids), ra("สมมติฐาน 3x", HYP3, ids),
  row("baseline avg7d", base(ids), ci(perM((i) => runBaseline(i), ids))), ""].join("\n");
const by = (f: (m: M) => boolean, ids: number[]) => ids.filter((i) => f(markets[i]));
const bins = Array.from({ length: 12 }, (_, i) => i * 4);   // 4 h bins of x
const heat = bins.map((lo1) => bins.map((lo2) => {
  const v: number[] = [];
  for (let a = 0; a < XS.length; a++) for (let b = 0; b < a; b++) if (XS[a] > lo1 && XS[a] <= lo1 + 4 && XS[b] > lo2 && XS[b] <= lo2 + 4) v.push(pairPnl[a][b]);
  return v.length ? Math.max(...v) : null;
}));
const today = new Date(Date.now() + 7 * HR).toISOString().slice(0, 10);
const md = [
  `# Backtest paper trading — ${today}`,
  "",
  `- ข้อมูล: ${markets.length} ตลาดที่ปิดแล้ว (48h ${markets.filter((m) => m.type === "48h").length}, 7d ${markets.filter((m) => m.type === "7d").length}) ปิดตั้งแต่ ${ict(markets[0].T)} ถึง ${ict(markets[markets.length - 1].T)} ICT`,
  `- train = ปิด ม.ค.–ส.ค. 2026 (${TRAIN.length} ตลาด) · test = ปิด ก.ย.–พ.ย. 2026 (${TEST.length} ตลาด)`,
  `- โมเดล: analog 60 วัน, น้ำหนักแนวโน้ม 7d/60d = 0.5, ${SIMS.toLocaleString()} sims (\`supabase/functions/_shared/model.ts\` ตัวเดียวกับ Edge Function) · โพสต์จากตาราง posts (created_at < t)`,
  `- ราคา: CLOB prices-history fidelity=1 → ราคาล่าสุดที่ t' ≤ t · ซื้อ = p + 0.01 (p < 0.05 หรือ > 0.95: + 0.02) · ขาย = p − 0.01 · settle ตามผล resolved`,
  `- agent: $${STAKE}/ไม้ · ถือได้ครั้งละ 1 ไม้/ตลาด (ขายแล้วเข้าใหม่ได้ที่ checkpoint ถัดไป) · เข้าเมื่อ edge ≥ +5pp (ฝั่ง Yes หรือ No ที่ดีสุด) · ขายเมื่อ bid ≥ P + 3pp หรือ edge ≤ −5pp`,
  `- checkpoint = T − x ชม. ก่อนปิด (T มาจาก endDate ของ xtracker เป็น UTC จึงรองรับ DST) · สแกน x = 0.5 … 48 ชม. ทุก 30 นาที`,
  "",
  "## ผลการเลือก checkpoint",
  `- 2 จุด: ดีสุดจาก train = **${fx(best2.xs)}** (train ${money(best2.pnl)}) · บน test: ดีสุด ${money(ch2.bestTest)} vs สมมติฐาน ${money(ch2.hypTest)} → ใช้ **${ch2.usedBest ? "ชุดดีสุด" : "ชุดสมมติฐาน"} (${fx(ch2.xs)})**`,
  `- 3 จุด: ดีสุดจาก train = **${fx(best3.xs)}** (train ${money(best3.pnl)}) · บน test: ดีสุด ${money(ch3.bestTest)} vs สมมติฐาน ${money(ch3.hypTest)} → ใช้ **${ch3.usedBest ? "ชุดดีสุด" : "ชุดสมมติฐาน"} (${fx(ch3.xs)})**`,
  `- กติกา: ใช้ชุดดีสุดเฉพาะเมื่อชนะสมมติฐานบน test เกิน 10% ไม่งั้นใช้ชุดสมมติฐาน`,
  "",
  "## ผลบน test (ก.ย.–พ.ย. 2026)",
  block("ทั้งหมด", TEST), block("48h", by((m) => m.type === "48h", TEST)), block("7d", by((m) => m.type === "7d", TEST)),
  "## ผลบน train (ม.ค.–ส.ค. 2026) — ใช้เลือกชุด ไม่ใช่ผลจริง",
  block("ทั้งหมด", TRAIN),
  "## PnL ตาม x (agent จุดเดียว: ตัดสินใจครั้งเดียวที่ T − x แล้วถือจนจบ)",
  "| x (ชม.) | train | test | 48h ทั้งหมด | 7d ทั้งหมด |", "|---:|---:|---:|---:|---:|",
  ...singles.filter((_, i) => i % 2 === 1).map((s) => `| ${s.x} | ${money(s.train)} | ${money(s.test)} | ${money(s.t48)} | ${money(s.t7)} |`),
  "",
  "## Heatmap PnL บน train ของชุด 2 จุด (ค่าดีสุดในช่อง 4 ชม.) — แถว = จุดแรก x₁, คอลัมน์ = จุดที่สอง x₂ (x₁ > x₂)",
  `| x₁ \\ x₂ | ${bins.map((b) => `${b}–${b + 4}`).join(" | ")} |`, `|---|${bins.map(() => "---:").join("|")}|`,
  ...bins.map((b, i) => `| ${b}–${b + 4} | ${heat[i].map((v) => (v == null ? "" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`)).join(" | ")} |`),
  "",
  "## ข้อจำกัด",
  "- โพสต์เริ่ม 1 พ.ย. 2025 → ตลาดต้น ม.ค. มี analog ไม่ครบ 60 วัน (ข้าม analog ที่ก่อนข้อมูลเริ่ม)",
  "- ราคาจาก prices-history เป็นราคากลาง ไม่ใช่ bid/ask จริง → ใช้ spread สมมติ ±1–2¢ · ไม่คิด slippage จากขนาดไม้/ความลึก order book",
  "- การเลือกชุด 3 จุดจาก ~140,000 ชุดเสี่ยง overfit → ใช้ test แยกและกติกา 10% ข้างบน · test มีแค่ ~60 ตลาด ดู 90% CI ก่อนสรุปว่าชุดไหนดีกว่า",
  "- bucket ที่ไม่มีประวัติราคาใน CLOB เลย (~18% ของ token ส่วนใหญ่เป็น bucket ไกล ๆ ที่ไม่มีการเทรด) ถูกตัดออกจากการพิจารณา",
  "- ตลาดที่ xtracker ไม่มี marketLink (~60 ตลาด) หา slug จากชื่อตลาด · ตลาดที่หาไม่เจอหรือยังไม่ resolve ถูกตัดออก",
  "",
].join("\n");
await Deno.mkdir(new URL("reports/", ROOT), { recursive: true });
const reportFile = new URL(`reports/backtest_${today}.md`, ROOT);
await Deno.writeTextFile(reportFile, md);
console.log(`report → ${reportFile.pathname}`);
console.log(JSON.stringify({ best2, best3, ch2, ch3 }));

// ---------- 8. SQL for paper_* and price_cache (mode = 'backtest') ----------
if (WRITE) {
  const q = (v: unknown) => v == null ? "null" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(6)) : "null") : `'${String(v).replace(/'/g, "''")}'`;
  const dec: string[] = [], pos: string[] = [], pc: string[] = [];
  const used = new Set<string>();
  const agents: [string, (i: number, log: Dec[]) => Pos[], number[] | null][] = [
    ["2x", (i, l) => runAgent(i, ch2.xs, l), ch2.xs], ["3x", (i, l) => runAgent(i, ch3.xs, l), ch3.xs], ["avg7d", (i, l) => runBaseline(i, l), null],
  ];
  for (const [agent, fn, xs] of agents) {
    for (let i = 0; i < markets.length; i++) {
      const m = markets[i], log: Dec[] = [], ps = fn(i, log);
      for (const d of log) {
        const b = d.b != null ? m.buckets[d.b].t : null;
        dec.push(`(${q(iso(d.ts))},'backtest',${q(agent)},${q(m.slug)},${q(d.action)},${q(d.side)},${q(b)},${q(d.price)},${q(d.p != null ? d.p - 0.01 : null)},${q(d.p != null ? d.p + 0.01 : null)},${q(d.P)},${q(d.edge)},${q(d.reason)})`);
      }
      for (const p of ps) {
        const G = grid(m);
        pos.push(`('backtest',${q(agent)},${q(m.slug)},${q(m.type)},${q(p.side)},${q(m.buckets[p.b].t)},${q(iso(G[p.k0]))},${q(p.entry)},${q(p.shares)},${q(iso(p.t1))},${q(p.exit)},${q(p.reason)},${p.reason === "settle"},${q(p.pnl)})`);
      }
      const ks = xs ? xs.map(gi) : [0];
      for (const k of ks) m.buckets.forEach((b, bi) => {
        const p = PRICES[i][bi][k], key = `${b.token}|${grid(m)[k]}`;
        if (p != null && !used.has(key)) { used.add(key); pc.push(`(${q(b.token)},${q(iso(grid(m)[k]))},${q(p)},${q(m.slug)},${q(b.t)})`); }
      });
    }
  }
  const dir = new URL("sql/", CACHE);
  await Deno.mkdir(dir, { recursive: true });
  for (const e of Deno.readDirSync(dir)) Deno.removeSync(new URL(e.name, dir));
  const chunk = (name: string, head: string, rows: string[], tail = "") => {
    for (let i = 0, n = 0; i < rows.length; i += 2000, n++) Deno.writeTextFileSync(new URL(`${name}_${String(n).padStart(3, "0")}.sql`, dir), `${head}\n${rows.slice(i, i + 2000).join(",\n")}\n${tail};\n`);
  };
  chunk("1_decisions", "insert into public.paper_decisions (ts,mode,agent,market_slug,action,side,bucket,price,bid,ask,p_model,edge,reason) values", dec);
  chunk("2_positions", "insert into public.paper_positions (mode,agent,market_slug,market_type,side,bucket,entry_ts,entry_price,shares,exit_ts,exit_price,exit_reason,settled_final,pnl) values", pos);
  chunk("3_price_cache", "insert into public.price_cache (token_id,ts,p,market_slug,bucket) values", pc, "on conflict do nothing");
  console.log(`sql → ${dir.pathname}: decisions ${dec.length}, positions ${pos.length}, price_cache ${pc.length}`);
}
