// Edge Function "poll" — called by pg_cron every 30 s (header x-poll-secret, checked against Vault).
// 1) upsert Elon's posts from the last 10 min (xtracker)
// 2) every ~60 s: active markets + quotes (gamma) → state.markets; rolling 5-min mid history → price-jump alerts
// 3) Telegram: (a) first post after ≥3 h silence (b) every new post while a market has < 6 h left
//    every post line shows latency: posted → imported by xtracker → sent
// Body {"test":true} → Telegram test · {"backfill":{"from":ISO,"to":ISO}} → upsert one window of posts (no alerts)
import {
  cents, esc, fetchMarkets, fmtLeft, fmtMin, getJSON, HR, internalAuth, iso, json, loadState, makeDescriber, Market, MIN,
  pp, saveState, sb, shortTitle, telegram, th, XT,
} from "../_shared/common.ts";

const SILENCE_MS = 3 * HR;       // (a)
const FINAL_MS = 6 * HR;         // (b)
const MARKET_EVERY_MS = 55_000;  // cron 30 s → refresh markets every other call
const JUMP = 0.15;               // C: mid move ≥ 15pp …
const JUMP_WINDOW = 5 * MIN;     //    … within 5 min
const JUMP_COOLDOWN = 15 * MIN;  //    one alert per bucket per 15 min

type XPost = { id: string; createdAt: string; content?: string | null; importedAt?: string | null; platformId?: string };
type Hist = Record<string, [number, number][]>;

const toRow = (p: XPost) => ({ id: p.id, created_at: p.createdAt, content: p.content ?? null, imported_at: p.importedAt ?? null });

async function upsertPosts(posts: XPost[]) {
  const ids = new Set<string>();
  for (let i = 0; i < posts.length; i += 1000) {
    const { data, error } = await sb.from("posts")
      .upsert(posts.slice(i, i + 1000).map(toRow), { onConflict: "id", ignoreDuplicates: true }).select("id");
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.id);
  }
  return ids;
}

/** D: posted → imported (xtracker) → sent, in minutes */
const postLine = (p: XPost, sentAt: number) => {
  const t = Date.parse(p.createdAt), imp = p.importedAt ? Date.parse(p.importedAt) : null;
  const link = p.platformId ? ` <a href="https://x.com/elonmusk/status/${esc(p.platformId)}">↗</a>` : "";
  return `• ${th(t)} — ${esc(String(p.content ?? "").replace(/\s+/g, " ").slice(0, 160))}${link}\n` +
    `   ⏱ นำเข้า +${imp ? fmtMin(imp - t) : "?"} นาที · ส่ง +${fmtMin(sentAt - t)} นาที`;
};

function detectJumps(now: number, markets: Market[], hist: Hist, alerted: Record<string, number>) {
  const next: Hist = {}, hits: { m: Market; t: string; from: number; to: number; ago: number; bid?: number | null; ask?: number | null }[] = [];
  for (const m of markets) {
    for (const b of m.buckets) {
      if (b.mid == null) continue;
      const k = `${m.slug}|${b.t}`;
      const h = (hist[k] ?? []).filter(([t]) => now - t <= JUMP_WINDOW + 20_000);
      let ref: [number, number] | null = null;
      for (const p of h) if (Math.abs(b.mid - p[1]) >= JUMP && (!ref || Math.abs(b.mid - p[1]) > Math.abs(b.mid - ref[1]))) ref = p;
      if (ref && !(alerted[k] && now - alerted[k] < JUMP_COOLDOWN)) {
        hits.push({ m, t: b.t, from: ref[1], to: b.mid, ago: now - ref[0], bid: b.bid, ask: b.ask });
        alerted[k] = now;
      }
      h.push([now, b.mid]);
      next[k] = h;
    }
  }
  for (const k of Object.keys(alerted)) if (now - alerted[k] >= JUMP_COOLDOWN) delete alerted[k];
  return { hist: next, alerted, hits };
}

Deno.serve(async (req) => {
  if (!(await internalAuth(req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  const out: Record<string, unknown> = {};

  try {
    if (body?.test) {
      await telegram(`✅ ทดสอบจาก Edge Function <b>poll</b>\n${th(now)} (เวลาไทย)`);
      return json({ ok: true, test: "telegram sent" });
    }
    if (body?.backfill) {
      const from = Date.parse(body.backfill.from), to = Date.parse(body.backfill.to);
      if (!(to > from) || to - from > 16 * 24 * HR) return json({ ok: false, error: "backfill window must be ≤ 16 days" }, 400);
      const j = await getJSON(`${XT}/users/elonmusk/posts?platform=X&startDate=${iso(from)}&endDate=${iso(to)}`, 60_000);
      const api: XPost[] = j?.data ?? [];
      const ids = await upsertPosts(api);
      return json({ ok: true, backfill: { from: iso(from), to: iso(to), fetched: api.length, inserted: ids.size } });
    }

    const st = await loadState(["last_post_at", "last_market_poll", "markets", "alerted_ids", "mid_hist", "jump_alerted"]);
    const firstRun = st.last_post_at == null;
    const patch: Record<string, unknown> = {};

    // 1) posts
    const from = now - (firstRun ? 12 * HR : 10 * MIN);
    const j = await getJSON(`${XT}/users/elonmusk/posts?platform=X&startDate=${iso(from)}&endDate=${iso(now)}`);
    const api: XPost[] = j?.data ?? [];
    const insertedIds = api.length ? await upsertPosts(api) : new Set<string>();
    const fresh = api.filter((p) => insertedIds.has(p.id)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    out.posts_seen = api.length;
    out.posts_new = fresh.length;

    // 2) markets + quotes (~every 60 s) → price-jump detection (no per-minute price storage)
    let markets: Market[] = st.markets ?? [];
    const msgs: string[] = [];
    const describe = makeDescriber(now);  // official count + model P/edge per market
    if (!markets.length || !st.last_market_poll || now - st.last_market_poll >= MARKET_EVERY_MS) {
      try {
        markets = await fetchMarkets(now);
        const jp = detectJumps(now, markets, st.mid_hist ?? {}, st.jump_alerted ?? {});
        Object.assign(patch, { markets, last_market_poll: now, mid_hist: jp.hist, jump_alerted: jp.alerted });
        out.markets = markets.length;
        for (const m of new Set(jp.hits.map((h) => h.m))) {
          const hs = jp.hits.filter((h) => h.m === m);
          msgs.push(`⚡ <b>ราคาขยับแรง</b> · ${esc(shortTitle(m.title))}\n` +
            hs.map((h) => `• <b>${esc(h.t)}</b>: ${(h.from * 100).toFixed(0)}% → ${(h.to * 100).toFixed(0)}% (${pp(h.to - h.from)} ใน ${Math.max(1, Math.round(h.ago / MIN))} นาที) · bid ${cents(h.bid)} / ask ${cents(h.ask)}`).join("\n") +
            `\n${await describe(m)}\nเหลือ ${fmtLeft(m.e - now)}`);
        }
        out.jumps = jp.hits.length;
      } catch (e) { out.market_error = String(e); }
    }

    // 3) post alerts
    const prevLast: number = st.last_post_at ?? now - 12 * HR;
    const alerted = new Set<string>(st.alerted_ids ?? []);
    const toAlert = firstRun ? [] : fresh.filter((p) => !alerted.has(p.id));
    if (toAlert.length) {
      const open = markets.filter((m) => m.s <= now && m.e > now).sort((a, b) => a.e - b.e);
      // (a) first post after ≥ 3 h silence
      let prev = prevLast;
      for (const p of toAlert) {
        const t = Date.parse(p.createdAt);
        if (t - prev >= SILENCE_MS) {
          const m = open[0];
          msgs.push(`🔔 <b>Elon กลับมาโพสต์</b> หลังเงียบ ${((t - prev) / HR).toFixed(1)} ชม.\n${postLine(p, Date.now())}` +
            (m ? `\n\n📊 ${esc(shortTitle(m.title))}\n${await describe(m)}\nเหลือ ${fmtLeft(m.e - now)} (ปิด ${th(m.e + 1000)} เวลาไทย)` : ""));
          break;
        }
        prev = Math.max(prev, t);
      }
      // (b) markets with < 6 h left → every new post
      for (const m of open.filter((x) => x.e - now < FINAL_MS)) {
        const ps = toAlert.filter((p) => Date.parse(p.createdAt) >= m.s && Date.parse(p.createdAt) <= m.e);
        if (!ps.length) continue;
        const sentAt = Date.now();
        msgs.push(`⏱ <b>${esc(shortTitle(m.title))}</b> เหลือ ${fmtLeft(m.e - now)}\nโพสต์ใหม่ ${ps.length}:\n` +
          ps.slice(-5).map((p) => postLine(p, sentAt)).join("\n") + (ps.length > 5 ? `\n…และอีก ${ps.length - 5}` : "") +
          `\n${await describe(m)}`);
      }
      for (const p of toAlert) alerted.add(p.id);
      patch.alerted_ids = [...alerted].slice(-200);
    }

    const errs: string[] = [];
    for (const msg of msgs) { try { await telegram(msg); } catch (e) { errs.push(String(e)); } }
    if (msgs.length) out.alerts = msgs.length;
    if (errs.length) out.alert_errors = errs;

    // last post time (for silence detection)
    const newest = Math.max(0, ...fresh.map((p) => Date.parse(p.createdAt)));
    if (firstRun) patch.last_post_at = Math.max(newest, ...api.map((p) => Date.parse(p.createdAt)), now - 12 * HR);
    else if (newest > prevLast) patch.last_post_at = newest;

    patch.poll_ok_at = now;  // A: health check reads this
    await saveState(patch);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e), ...out }, 500);
  }
});
