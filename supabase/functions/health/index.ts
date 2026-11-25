// Edge Function "health" (A) — pg_cron every 5 min. Runs only while some open market has < 4 h left
// (or while the system is already marked down, so recovery is always reported).
// Checks: poll succeeded ≤ 3 min ago · xtracker 200 · gamma-api 200 ·
//         posts-table count == xtracker stats.total for the market closing soonest (mismatch must persist 2 checks)
// Normal → silent · problem → "⚠️ ระบบมีปัญหา: …" once · recovered → "✅ กลับมาปกติ (ล่มไป X นาที)"
// Body: {"force":true} ignore the 4 h window · {"simulate":"reason"} inject a fake problem (testing)
import {
  esc, fmtMin, GM, HR, internalAuth, iso, json, loadState, Market, MIN, officialCount, saveState, sb, shortTitle, telegram, th, XT,
} from "../_shared/common.ts";

const WINDOW = 4 * HR, POLL_MAX_AGE = 3 * MIN;

async function status(url: string) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    await r.body?.cancel();
    return r.status;
  } catch (e) { return `ไม่ตอบ (${(e as Error).name})`; }
}

Deno.serve(async (req) => {
  if (!(await internalAuth(req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  try {
    const st = await loadState(["markets", "poll_ok_at", "health"]);
    const h = st.health ?? { down: false };
    const markets: Market[] = st.markets ?? [];
    const open = markets.filter((m) => m.s <= now && m.e > now).sort((a, b) => a.e - b.e);
    const inWindow = open.some((m) => m.e - now < WINDOW);
    if (!inWindow && !h.down && !body?.force) return json({ ok: true, skipped: "no market < 4h" });

    const problems: string[] = [];
    if (body?.simulate) problems.push(`จำลอง: ${String(body.simulate).slice(0, 80)}`);

    const age = now - (st.poll_ok_at ?? 0);
    if (age > POLL_MAX_AGE) problems.push(`poll ไม่สำเร็จมา ${st.poll_ok_at ? fmtMin(age) : "?"} นาที`);

    const xs = await status(`${XT}/users/elonmusk/posts?platform=X&startDate=${iso(now - MIN)}&endDate=${iso(now)}`);
    if (xs !== 200) problems.push(`xtracker API ตอบ ${xs}`);
    const near = open[0] ?? markets[0];
    const gs = await status(`${GM}/events?slug=${encodeURIComponent(near?.slug ?? "")}`);
    if (gs !== 200) problems.push(`gamma-api ตอบ ${gs}`);

    let mismatch: string | null = null;
    if (open[0] && xs === 200) {
      const m = open[0];
      const [official, { count, error }] = await Promise.all([
        officialCount(m.id),
        sb.from("posts").select("id", { count: "exact", head: true }).gte("created_at", iso(m.s)).lte("created_at", iso(m.e)),
      ]);
      if (error) problems.push(`อ่านตาราง posts ไม่ได้: ${error.message}`);
      else if (official != null && count != null && official !== count) {
        mismatch = `ยอดไม่ตรง ${esc(shortTitle(m.title))}: posts ${count} vs xtracker ${official}`;
        if (h.mismatch_prev) problems.push(mismatch);
      }
    }

    const nh = { ...h, last_check: now, reasons: problems, mismatch_prev: !!mismatch, last_mismatch: mismatch };
    let sent: string | null = null;
    if (problems.length && !h.down) {
      sent = `⚠️ <b>ระบบมีปัญหา</b>: ${esc(problems.join(" · "))}\n${th(now)} (เวลาไทย)`;
      nh.down = true;
      nh.since = now;
    } else if (!problems.length && h.down) {
      sent = `✅ <b>กลับมาปกติ</b> (ล่มไป ${Math.max(1, Math.round((now - h.since) / MIN))} นาที)\n${th(now)} (เวลาไทย)`;
      nh.down = false;
      nh.since = null;
    }
    if (!problems.length) nh.last_ok = now;
    if (sent) await telegram(sent);
    await saveState({ health: nh });
    return json({ ok: true, down: nh.down, problems, mismatch, sent: !!sent, in_window: inWindow });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
