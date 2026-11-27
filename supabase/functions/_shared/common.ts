// Shared helpers for Edge Functions poll / health / telegram.
import { createClient } from "npm:@supabase/supabase-js@2";
import { bucketProbs, BucketP, DAY, edgeIcon, nowcast, probAtLeast, Series } from "./model.ts";
import { slugCandidates } from "./slug.ts";

export const XT = "https://xtracker.polymarket.com/api";
export const GM = "https://gamma-api.polymarket.com";
export const MIN = 60_000, HR = 3_600_000;

export const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

/** bid/ask = Yes token top-of-book (gamma bestBid/bestAsk) · fee = taker fee rate r (gamma feeSchedule.rate, 0 when fees are off) */
export type Bucket = { t: string; lo: number; hi: number; bid?: number | null; ask?: number | null; mid?: number | null; token?: string | null; fee?: number | null };
export type Market = { id: string; title: string; slug: string; s: number; e: number; buckets: Bucket[] };

export const iso = (ms: number) => new Date(ms).toISOString();
const fTH = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
/** เวลาไทย (ICT) — Intl จัดการ DST ของ ET ให้เองเพราะเวลาปิดตลาดมาเป็น UTC จาก xtracker */
export const th = (ms: number) => fTH.format(new Date(ms));
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
export const fmtLeft = (ms: number) => {
  const d = Math.floor(ms / (24 * HR)), h = Math.floor((ms % (24 * HR)) / HR), m = Math.floor((ms % HR) / MIN);
  return (d ? `${d} วัน ` : "") + `${h} ชม. ${String(m).padStart(2, "0")} นาที`;
};
export const fmtMin = (ms: number) => (ms / MIN).toFixed(1);
export const pp = (x: number) => { const r = Math.round(x * 100); return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)}pp`; };
export const cents = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}¢`);
export const shortTitle = (t: string) =>
  t.replace(/^Elon Musk #? ?(of )?tweets ?/i, "").replace(/\?$/, "").replace(/, 20\d\d/, "").replace(/^in /, "");
export const parseBucket = (raw: string): Bucket => {
  const t = String(raw).replace(/,/g, "").trim();
  const n = (t.match(/\d+/g) || []).map(Number);
  if (t.startsWith("<")) return { t: raw, lo: 0, hi: n[0] - 1 };
  if (t.includes("+")) return { t: raw, lo: n[0], hi: 1e9 };
  return { t: raw, lo: n[0], hi: n[1] ?? n[0] };
};
export const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export async function getJSON(url: string, timeoutMs = 15_000) {
  const r = await fetch(url, {
    headers: { "User-Agent": "elon-tweet-edge/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.json();
}

/** internal calls (pg_cron / manual SQL) carry x-poll-secret, checked against Vault */
export async function internalAuth(req: Request) {
  const { data, error } = await sb.rpc("poll_auth", { p: req.headers.get("x-poll-secret") ?? "" });
  return !error && data === true;
}

// deno-lint-ignore no-explicit-any
export async function loadState(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await sb.from("state").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
export async function saveState(patch: Record<string, unknown>) {
  const at = new Date().toISOString();
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: at }));
  if (!rows.length) return;
  const { error } = await sb.from("state").upsert(rows);
  if (error) throw error;
}

export async function telegram(text: string, chatId?: string | number) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN"), chat = chatId ?? Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function officialCount(trackingId: string): Promise<number | null> {
  try {
    const j = await getJSON(`${XT}/trackings/${trackingId}?includeStats=true`);
    const v = j?.data?.stats?.total;
    return typeof v === "number" ? v : null;
  } catch { return null; }
}

/** active markets (xtracker trackings) + current quotes per bucket from gamma-api */
export async function fetchMarkets(now: number): Promise<Market[]> {
  const u = await getJSON(`${XT}/users/elonmusk?platform=X`);
  // deno-lint-ignore no-explicit-any
  const tr = (u?.data?.trackings ?? []).filter((t: any) => t.isActive && Date.parse(t.endDate) > now);
  // deno-lint-ignore no-explicit-any
  const markets: Market[] = await Promise.all(tr.map(async (t: any) => {
    const cands = slugCandidates(t);
    const m: Market = { id: t.id, title: t.title, slug: cands[0], s: Date.parse(t.startDate), e: Date.parse(t.endDate), buckets: [] };
    try {
      // deno-lint-ignore no-explicit-any
      let ev: any = null;
      for (const c of cands) { ev = (await getJSON(`${GM}/events?slug=${encodeURIComponent(c)}`))?.[0]; if (ev) { m.slug = c; break; } }
      for (const x of ev?.markets ?? []) {
        if (!x.groupItemTitle) continue;
        const arr = (s: string) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
        const op = arr(x.outcomePrices), tok = arr(x.clobTokenIds);
        const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
        const fee = x.feesEnabled === false ? 0 : n(x.feeSchedule?.rate);
        m.buckets.push({ ...parseBucket(x.groupItemTitle), bid: n(x.bestBid), ask: n(x.bestAsk), mid: op.length ? Number(op[0]) : null, token: tok[0] ?? null, fee });
      }
    } catch (e) { console.error("gamma", m.slug, String(e)); }
    m.buckets.sort((a, b) => a.lo - b.lo);
    return m;
  }));
  return markets.sort((a, b) => a.e - b.e);
}

export function bucketOf(m: Market, cur: number | null) {
  return cur == null ? undefined : m.buckets.find((x) => cur >= x.lo && cur <= x.hi);
}
export function bucketLine(m: Market, cur: number | null) {
  if (cur == null) return "ยอดตอนนี้ —";
  const b = bucketOf(m, cur), nx = m.buckets.find((x) => x.lo > cur);
  return `ยอดตอนนี้ <b>${cur}</b>${b ? ` · bucket <b>${esc(b.t)}</b>` : ""}` +
    (nx ? ` · ต้องได้อีก <b>${nx.lo - cur}</b> โพสต์ถึง ${esc(nx.t)}` : "");
}

// ---------- model (phase 2) ----------
export const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

/** hourly post counts for the last ~100 days (posts before now only) */
export async function loadSeries(now: number): Promise<Series> {
  const t0 = Math.floor((now - 100 * DAY) / HR) * HR;
  const { data, error } = await sb.rpc("hourly_counts", { since: iso(t0) });
  if (error) throw error;
  const h = new Array<number>(Math.floor((now - t0) / HR) + 1).fill(0);
  for (const [sec, n] of (data ?? []) as [number, number][]) {
    const i = Math.floor((sec * 1000 - t0) / HR);
    if (i >= 0 && i < h.length) h[i] = n;
  }
  return { t0, h };
}

export type ModelView = { cur: number; bp: BucketP[]; curB?: BucketP; nx?: BucketP; pNext: number };
export function modelFor(m: Market, cur: number, series: Series, now: number): ModelView {
  const { x } = nowcast({ series, now, s: m.s, e: m.e, cur });
  const bp = bucketProbs(x, m.buckets);
  const curB = bp.find((b) => cur >= b.lo && cur <= b.hi), nx = bp.find((b) => b.lo > cur);
  return { cur, bp, curB, nx, pNext: nx ? probAtLeast(x, nx.lo) : 0 };
}

/** count · current bucket with P(end here) · next bucket (only if P ≥ 2%) · buckets with P > 3% + edge icon */
export function modelBlock(v: ModelView) {
  const head = `ยอดตอนนี้ <b>${v.cur}</b>` +
    (v.curB ? ` · bucket <b>${esc(v.curB.t)}</b> (P จบในนี้ ${pct(v.curB.p)})` : "") +
    (v.nx && v.pNext >= 0.02 ? ` · ต้องได้อีก <b>${v.nx.lo - v.cur}</b> ถึง ${esc(v.nx.t)} (P ${pct(v.pNext)})` : "");
  const lines = v.bp.filter((b) => b.p > 0.03).map((b) =>
    `${edgeIcon(b.edge)} ${esc(b.t)} · โมเดล ${pct(b.p)} · ask ${cents(b.ask ?? b.mid)} · edge ${b.edge == null ? "—" : pp(b.edge)}`);
  return [head, ...lines].join("\n");
}

/** per-request memo: official count + model text per market (falls back to bucketLine if the model fails) */
export function makeDescriber(now: number) {
  let series: Promise<Series> | null = null;
  const memo = new Map<string, Promise<string>>();
  return (m: Market) => {
    if (!memo.has(m.id)) {
      memo.set(m.id, (async () => {
        const cur = m.s <= now ? await officialCount(m.id) : 0;
        if (cur == null) return bucketLine(m, null);
        try {
          series ??= loadSeries(now);
          return modelBlock(modelFor(m, cur, await series, now));
        } catch (e) {
          console.error("model", String(e));
          return bucketLine(m, cur);
        }
      })());
    }
    return memo.get(m.id)!;
  };
}

/** text for /status */
export async function buildStatus(now: number) {
  const st = await loadState(["markets", "poll_ok_at", "health", "last_post_at"]);
  const markets: Market[] = (st.markets ?? []).filter((m: Market) => m.e > now).sort((a: Market, b: Market) => a.e - b.e);
  const describe = makeDescriber(now);
  const blocks = await Promise.all(markets.map((m) => describe(m)));
  const lines = markets.map((m, i) =>
    `📊 <b>${esc(shortTitle(m.title))}</b>${m.s > now ? ` (เริ่ม ${th(m.s)})` : ""}\n` +
    `${blocks[i]}\nเหลือ ${fmtLeft(m.e - now)} · ปิด ${th(m.e + 1000)}`);
  const h = st.health ?? {};
  const pollAge = st.poll_ok_at ? Math.round((now - st.poll_ok_at) / 1000) : null;
  const sys = h.down
    ? `⚠️ ระบบมีปัญหา: ${esc((h.reasons ?? []).join(" · "))} (ตั้งแต่ ${th(h.since)})`
    : `✅ ระบบปกติ`;
  const silence = st.last_post_at ? `🤫 เงียบมา ${((now - st.last_post_at) / HR).toFixed(1)} ชม. (โพสต์ล่าสุด ${th(st.last_post_at)})` : "";
  return [`<b>สถานะ</b> · ${th(now)} (เวลาไทย)`, ...lines, `${sys} · poll ล่าสุด ${pollAge ?? "—"} วินาทีที่แล้ว`, silence]
    .filter(Boolean).join("\n\n");
}
