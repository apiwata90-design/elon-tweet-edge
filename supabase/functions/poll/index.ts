// Edge Function "poll" — called by pg_cron every 30 s (header x-poll-secret, checked against Vault).
// 1) upsert Elon's posts from the last 10 min (xtracker)
// 2) every ~60 s: active markets (xtracker trackings) + Polymarket prices → prices (only rows that changed)
// 3) Telegram alerts: (a) first post after ≥3 h silence  (b) every new post while a market has < 6 h left
// Body {"test":true} sends a Telegram test message only.
import { createClient } from "npm:@supabase/supabase-js@2";

const XT = "https://xtracker.polymarket.com/api";
const GM = "https://gamma-api.polymarket.com";
const MIN = 60_000, HR = 3_600_000;
const SILENCE_MS = 3 * HR;     // (a)
const FINAL_MS = 6 * HR;       // (b)
const MARKET_EVERY_MS = 55_000; // cron is 30 s → refresh markets/prices every other call

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Bucket = { t: string; lo: number; hi: number };
type Market = { id: string; title: string; slug: string; s: number; e: number; buckets: Bucket[] };
type XPost = { id: string; createdAt: string; content?: string | null; importedAt?: string | null; platformId?: string };
type Prices = Record<string, (number | null)[]>;

const iso = (ms: number) => new Date(ms).toISOString();
const fTH = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
const th = (ms: number) => fTH.format(new Date(ms));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const fmtLeft = (ms: number) => {
  const d = Math.floor(ms / (24 * HR)), h = Math.floor((ms % (24 * HR)) / HR), m = Math.floor((ms % HR) / MIN);
  return (d ? `${d} วัน ` : "") + `${h} ชม. ${String(m).padStart(2, "0")} นาที`;
};
const shortTitle = (t: string) =>
  t.replace(/^Elon Musk #? ?(of )?tweets ?/i, "").replace(/\?$/, "").replace(/, 20\d\d/, "").replace(/^in /, "");
const parseBucket = (raw: string): Bucket => {
  const t = String(raw).replace(/,/g, "").trim();
  const n = (t.match(/\d+/g) || []).map(Number);
  if (t.startsWith("<")) return { t: raw, lo: 0, hi: n[0] - 1 };
  if (t.includes("+")) return { t: raw, lo: n[0], hi: 1e9 };
  return { t: raw, lo: n[0], hi: n[1] ?? n[0] };
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function getJSON(url: string) {
  const r = await fetch(url, {
    headers: { "User-Agent": "elon-tweet-edge/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.json();
}

async function loadState(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await sb.from("state").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function saveState(patch: Record<string, unknown>) {
  const at = new Date().toISOString();
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: at }));
  if (!rows.length) return;
  const { error } = await sb.from("state").upsert(rows);
  if (error) throw error;
}

async function telegram(text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN"), chat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function refreshMarkets(now: number, last: Prices) {
  const u = await getJSON(`${XT}/users/elonmusk?platform=X`);
  const tr = (u?.data?.trackings ?? []).filter((t: any) => t.isActive && t.marketLink && Date.parse(t.endDate) > now);
  const ts = iso(Math.floor(now / 1000) * 1000);
  const rows: Record<string, unknown>[] = [];
  const markets: Market[] = await Promise.all(tr.map(async (t: any) => {
    const slug = String(t.marketLink).split("/").filter(Boolean).pop()!;
    const m: Market = { id: t.id, title: t.title, slug, s: Date.parse(t.startDate), e: Date.parse(t.endDate), buckets: [] };
    try {
      const ev = (await getJSON(`${GM}/events?slug=${encodeURIComponent(slug)}`))?.[0];
      for (const x of ev?.markets ?? []) {
        if (!x.groupItemTitle) continue;
        let op: string[] = [];
        try { op = JSON.parse(x.outcomePrices || "[]"); } catch { /* ignore */ }
        const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
        const bid = n(x.bestBid), ask = n(x.bestAsk), mid = op.length ? Number(op[0]) : null;
        m.buckets.push(parseBucket(x.groupItemTitle));
        const k = `${slug}|${x.groupItemTitle}`, p = last[k];
        if (!p || p[0] !== bid || p[1] !== ask || p[2] !== mid) {
          rows.push({ ts, market_slug: slug, bucket: x.groupItemTitle, bid, ask, mid });
          last[k] = [bid, ask, mid];
        }
      }
    } catch (e) { console.error("prices", slug, String(e)); }
    m.buckets.sort((a, b) => a.lo - b.lo);
    return m;
  }));
  if (rows.length) {
    const { error } = await sb.from("prices").upsert(rows, { onConflict: "ts,market_slug,bucket", ignoreDuplicates: true });
    if (error) throw error;
  }
  const live = new Set(markets.map((m) => m.slug));
  for (const k of Object.keys(last)) if (!live.has(k.split("|")[0])) delete last[k];
  return { markets: markets.sort((a, b) => a.e - b.e), priceRows: rows.length };
}

async function officialCount(m: Market): Promise<number | null> {
  try {
    const j = await getJSON(`${XT}/trackings/${m.id}?includeStats=true`);
    const v = j?.data?.stats?.total;
    return typeof v === "number" ? v : null;
  } catch { return null; }
}

function bucketLine(m: Market, cur: number | null) {
  if (cur == null) return "ยอดตอนนี้ —";
  const b = m.buckets.find((x) => cur >= x.lo && cur <= x.hi), nx = m.buckets.find((x) => x.lo > cur);
  return `ยอดตอนนี้ <b>${cur}</b>${b ? ` · bucket <b>${esc(b.t)}</b>` : ""}` +
    (nx ? ` · ต้องได้อีก <b>${nx.lo - cur}</b> โพสต์ถึง ${esc(nx.t)}` : "");
}
const postLine = (p: XPost) => {
  const link = p.platformId ? ` <a href="https://x.com/elonmusk/status/${esc(p.platformId)}">↗</a>` : "";
  return `• ${th(Date.parse(p.createdAt))} — ${esc(String(p.content ?? "").replace(/\s+/g, " ").slice(0, 160))}${link}`;
};

Deno.serve(async (req) => {
  const { data: ok, error: authErr } = await sb.rpc("poll_auth", { p: req.headers.get("x-poll-secret") ?? "" });
  if (authErr || ok !== true) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  const out: Record<string, unknown> = {};

  try {
    if (body?.test) {
      await telegram(`✅ ทดสอบจาก Edge Function <b>poll</b>\n${th(now)} (เวลาไทย)`);
      return json({ ok: true, test: "telegram sent" });
    }

    const st = await loadState(["last_post_at", "last_market_poll", "markets", "last_prices", "alerted_ids"]);
    const firstRun = st.last_post_at == null;
    const patch: Record<string, unknown> = {};

    // 1) posts
    const from = now - (firstRun ? 12 * HR : 10 * MIN);
    const j = await getJSON(`${XT}/users/elonmusk/posts?platform=X&startDate=${iso(from)}&endDate=${iso(now)}`);
    const api: XPost[] = j?.data ?? [];
    let fresh: XPost[] = [];
    if (api.length) {
      const rows = api.map((p) => ({ id: p.id, created_at: p.createdAt, content: p.content ?? null, imported_at: p.importedAt ?? null }));
      const { data, error } = await sb.from("posts").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
      if (error) throw error;
      const ids = new Set((data ?? []).map((r: { id: string }) => r.id));
      fresh = api.filter((p) => ids.has(p.id)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }
    out.posts_seen = api.length;
    out.posts_new = fresh.length;

    // 2) markets + prices (~every 60 s)
    let markets: Market[] = st.markets ?? [];
    if (!markets.length || !st.last_market_poll || now - st.last_market_poll >= MARKET_EVERY_MS) {
      try {
        const last: Prices = st.last_prices ?? {};
        const r = await refreshMarkets(now, last);
        markets = r.markets;
        Object.assign(patch, { markets, last_prices: last, last_market_poll: now });
        out.price_rows = r.priceRows;
      } catch (e) { out.market_error = String(e); }
    }

    // 3) alerts
    const prevLast: number = st.last_post_at ?? now - 12 * HR;
    const alerted = new Set<string>(st.alerted_ids ?? []);
    const toAlert = firstRun ? [] : fresh.filter((p) => !alerted.has(p.id));
    if (toAlert.length) {
      const open = markets.filter((m) => m.s <= now && m.e > now).sort((a, b) => a.e - b.e);
      const counts = new Map<string, number | null>();
      const count = async (m: Market) => {
        if (!counts.has(m.id)) counts.set(m.id, await officialCount(m));
        return counts.get(m.id)!;
      };
      const msgs: string[] = [];

      // (a) first post after ≥ 3 h silence
      let prev = prevLast;
      for (const p of toAlert) {
        const t = Date.parse(p.createdAt);
        if (t - prev >= SILENCE_MS) {
          const m = open[0];
          msgs.push(`🔔 <b>Elon กลับมาโพสต์</b> หลังเงียบ ${((t - prev) / HR).toFixed(1)} ชม.\n${postLine(p)}` +
            (m ? `\n\n📊 ${esc(shortTitle(m.title))}\n${bucketLine(m, await count(m))}\nเหลือ ${fmtLeft(m.e - now)} (ปิด ${th(m.e + 1000)} เวลาไทย)` : ""));
          break;
        }
        prev = Math.max(prev, t);
      }

      // (b) markets with < 6 h left → every new post
      for (const m of open.filter((x) => x.e - now < FINAL_MS)) {
        const ps = toAlert.filter((p) => Date.parse(p.createdAt) >= m.s && Date.parse(p.createdAt) <= m.e);
        if (!ps.length) continue;
        msgs.push(`⏱ <b>${esc(shortTitle(m.title))}</b> เหลือ ${fmtLeft(m.e - now)}\nโพสต์ใหม่ ${ps.length}:\n` +
          ps.slice(-5).map(postLine).join("\n") + (ps.length > 5 ? `\n…และอีก ${ps.length - 5}` : "") +
          `\n${bucketLine(m, await count(m))}`);
      }

      const errs: string[] = [];
      for (const msg of msgs) { try { await telegram(msg); } catch (e) { errs.push(String(e)); } }
      out.alerts = msgs.length;
      if (errs.length) out.alert_errors = errs;
      for (const p of toAlert) alerted.add(p.id);
      patch.alerted_ids = [...alerted].slice(-200);
    }

    // last post time (for silence detection)
    const newest = Math.max(0, ...fresh.map((p) => Date.parse(p.createdAt)));
    if (firstRun) patch.last_post_at = Math.max(newest, Math.max(0, ...api.map((p) => Date.parse(p.createdAt))) || now - 12 * HR);
    else if (newest > prevLast) patch.last_post_at = newest;

    await saveState(patch);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e), ...out }, 500);
  }
});
