// Shared helpers for Edge Functions poll / health / telegram.
import { createClient } from "npm:@supabase/supabase-js@2";

export const XT = "https://xtracker.polymarket.com/api";
export const GM = "https://gamma-api.polymarket.com";
export const MIN = 60_000, HR = 3_600_000;

export const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export type Bucket = { t: string; lo: number; hi: number; bid?: number | null; ask?: number | null; mid?: number | null; token?: string | null };
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
export const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}pp`;
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
  const tr = (u?.data?.trackings ?? []).filter((t: any) => t.isActive && t.marketLink && Date.parse(t.endDate) > now);
  // deno-lint-ignore no-explicit-any
  const markets: Market[] = await Promise.all(tr.map(async (t: any) => {
    const slug = String(t.marketLink).split("/").filter(Boolean).pop()!;
    const m: Market = { id: t.id, title: t.title, slug, s: Date.parse(t.startDate), e: Date.parse(t.endDate), buckets: [] };
    try {
      const ev = (await getJSON(`${GM}/events?slug=${encodeURIComponent(slug)}`))?.[0];
      for (const x of ev?.markets ?? []) {
        if (!x.groupItemTitle) continue;
        const arr = (s: string) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
        const op = arr(x.outcomePrices), tok = arr(x.clobTokenIds);
        const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
        m.buckets.push({ ...parseBucket(x.groupItemTitle), bid: n(x.bestBid), ask: n(x.bestAsk), mid: op.length ? Number(op[0]) : null, token: tok[0] ?? null });
      }
    } catch (e) { console.error("gamma", slug, String(e)); }
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

/** text for /status */
export async function buildStatus(now: number) {
  const st = await loadState(["markets", "poll_ok_at", "health", "last_post_at"]);
  const markets: Market[] = (st.markets ?? []).filter((m: Market) => m.e > now).sort((a: Market, b: Market) => a.e - b.e);
  const counts = await Promise.all(markets.map((m) => (m.s <= now ? officialCount(m.id) : Promise.resolve(0))));
  const lines = markets.map((m, i) =>
    `📊 <b>${esc(shortTitle(m.title))}</b>${m.s > now ? ` (เริ่ม ${th(m.s)})` : ""}\n` +
    `${bucketLine(m, counts[i])}\nเหลือ ${fmtLeft(m.e - now)} · ปิด ${th(m.e + 1000)}`);
  const h = st.health ?? {};
  const pollAge = st.poll_ok_at ? Math.round((now - st.poll_ok_at) / 1000) : null;
  const sys = h.down
    ? `⚠️ ระบบมีปัญหา: ${esc((h.reasons ?? []).join(" · "))} (ตั้งแต่ ${th(h.since)})`
    : `✅ ระบบปกติ`;
  const silence = st.last_post_at ? `🤫 เงียบมา ${((now - st.last_post_at) / HR).toFixed(1)} ชม. (โพสต์ล่าสุด ${th(st.last_post_at)})` : "";
  return [`<b>สถานะ</b> · ${th(now)} (เวลาไทย)`, ...lines, `${sys} · poll ล่าสุด ${pollAge ?? "—"} วินาทีที่แล้ว`, silence]
    .filter(Boolean).join("\n\n");
}
