# CURRENT_STATE — Elon Tweet Edge

_อัปเดตล่าสุด: 2026-11-27 · เฟส 1 เสร็จ · เฟส 2 เสร็จ · หน้าเว็บเพิ่มส่วน "วันนี้" · Backtest v2 เสร็จ · **เฟส 3 live paper trading เปิดแล้ว** (27 พ.ย.)_

## ผล backtest v2 (2026-11-27) — รายละเอียดใน [reports/backtest_v2_2026-11-27.md](reports/backtest_v2_2026-11-27.md)
- ต้นทุนสมจริงขึ้น: half-spread ตามช่วงราคา (ตารางงานวิจัย) · fee taker r·f·(1−f) r = 0.01 (gamma `feeSchedule`, culture_fees) ทั้งซื้อ/ขาย · ห้ามซื้อนอก 5–95¢ · checkpoint ชุดเดิม
- test ($10/ไม้, 60 ตลาด): **2x +$46** (47 ไม้, CI −105…+202) · **3x +$161** (51 ไม้, CI −4…+337) · avg7d +$52 (56 ไม้, CI −215…+369) — v1: +$60 / +$185 / +$68
- โมเดลเทียบตลาด: Brier โมเดลแย่กว่าราคาตลาดเล็กน้อย (skill −1.4% train, −2.4% test) · ราย 4 ชม. train/test สลับเครื่องหมายบ่อย
- gate "ไม่เทรดช่วงที่โมเดลไม่ชนะตลาด" ทดสอบแล้ว **ไม่ใช้** (ปิด 3x หมด, 2x เหลือ −$16) — user เลือก 27 พ.ย.
- spread จริง (567 quotes) แคบกว่าตารางงานวิจัยมาก (เช่น 0.10–0.20: 0.036 vs 0.13) → ตารางงานวิจัยเป็นกรณีระวัง · calibrate แล้ว 3x +$179, 2x +$38
- DB (mode='backtest') = v2 แล้ว (ลบ v1): paper_decisions 1,888 · paper_positions 602 · price_cache 19,380

## ผล backtest v1 (เฟส 2) — รายละเอียดใน [reports/backtest_2026-11-25.md](reports/backtest_2026-11-25.md)
- 224 ตลาดที่ปิดแล้ว (48h 133, 7d 91) · train = ปิด ม.ค.–ส.ค. (164) · test = ปิด ก.ย.–พ.ย. (60)
- checkpoint ที่เลือก: **2x = T−24.5h, T−17.5h** (ชุดดีสุดจาก train ชนะสมมติฐานบน test +$60 vs +$33) · **3x = T−16h, T−7h, T−2.5h** (สมมติฐาน เพราะชุดดีสุดจาก train แพ้บน test: −$77 vs +$185)
- test ($10/ไม้): 2x +$60 (90% CI −106…+236) · 3x +$185 (CI +10…+371) · baseline avg7d +$68 (CI −231…+418)
- test มีแค่ 60 ตลาด → ส่วนต่างส่วนใหญ่ยังอยู่ใน noise · มีแค่ 3x ที่ CI ทั้งช่วงเป็นบวก
- แถว v1 ใน DB ถูกแทนที่ด้วย v2 แล้ว (27 พ.ย.) · ตัวเลข v1 ยังอยู่ในรายงาน v1 และแถว "v1" ของรายงาน v2

## ใช้งานได้แล้ว
| ส่วน | ที่อยู่ | สถานะ |
|---|---|---|
| หน้าเว็บ (GitHub Pages) | https://apiwata90-design.github.io/elon-tweet-edge/ | ✅ live · main / root · Realtime posts + 🔔 |
| Repo | https://github.com/apiwata90-design/elon-tweet-edge | public |
| Action `hourly-data` | `.github/workflows/update.yml` | ✅ ตั้งไว้ทุกชั่วโมง :07 UTC → `data/*.json` (ดูหมายเหตุ schedule ด้านล่าง) |
| Supabase | project `ahanxplktggyqxdiydfi` (Singapore) | ✅ |
| Edge Function `poll` | cron `elon-poll` ทุก 30 วินาที | ✅ posts + markets + price-jump + แจ้งโพสต์ |
| Edge Function `health` | cron `elon-health` ทุก 5 นาที | ✅ ทำงานเฉพาะตอนมีตลาดเหลือ < 4 ชม. |
| Edge Function `telegram` | Telegram webhook | ✅ `/status` (ตอบเฉพาะ chat 1893239479) |
| Edge Function `paper` | cron `elon-paper` ทุก 1 นาที · `elon-paper-report` ทุกวัน 01:00 UTC (08:00 ICT) | ✅ live paper trading 2x / 3x / avg7d (เฟส 3) |
| Cron `elon-cron-cleanup` | ทุกวัน 03:17 UTC | ✅ ลบ `cron.job_run_details` เก่ากว่า 2 วัน |
| ตาราง `posts` | backfill ตั้งแต่ 2025-11-01 | ✅ |

## สถาปัตยกรรม
```
pg_cron 30s ─▶ poll ─▶ xtracker posts (10 นาที) ─upsert─▶ posts ─Realtime─▶ หน้าเว็บ
                 ├─ ทุก ~60s: trackings + gamma quotes ─▶ state.markets (bid/ask/mid/clobToken ต่อ bucket)
                 │             └─ state.mid_hist (mid 5 นาทีล่าสุด) ─▶ ⚡ price jump ≥15pp/5 นาที
                 └─ Telegram: 🔔 กลับมาโพสต์หลังเงียบ ≥3 ชม. · ⏱ ตลาดเหลือ <6 ชม. → ทุกโพสต์ (มี latency)
pg_cron 5m  ─▶ health ─▶ (มีตลาด <4 ชม.) poll ≤3 นาที? · xtracker 200? · gamma 200? · ยอด posts = stats.total?
                         ─▶ ⚠️ ครั้งเดียวเมื่อเริ่มมีปัญหา · ✅ เมื่อกลับมา (ล่มไป X นาที)
Telegram ─webhook─▶ telegram ─▶ /status
pg_cron 1m  ─▶ paper ─▶ checkpoint ที่ถึงเวลา (state.paper.done) ─▶ gamma bid/ask + fee ─▶ paper_decisions / paper_positions (live) ─▶ Telegram
                └─ ทุก 10 นาที: settle ไม้ของตลาดที่ resolve แล้ว · 01:00 UTC: รายงาน 1d/3d/7d/30d
GitHub Action ชม.ละครั้ง ─▶ data/hourly.json, news.json, launches.json
หน้าเว็บ: ดึง xtracker ตรงตามรอบรีเฟรชเสมอ (fallback) · ตลาดเหลือ <6 ชม. ดึงราคาทุก 30 วินาที
```

### การแจ้งเตือน Telegram
| ข้อความ | เงื่อนไข | กันซ้ำ |
|---|---|---|
| 🔔 Elon กลับมาโพสต์ | โพสต์แรกหลังเงียบ ≥ 3 ชม. | ต่อโพสต์ (`state.alerted_ids`) |
| ⏱ ตลาดใกล้ปิด | ตลาดเหลือ < 6 ชม. + มีโพสต์ใหม่ (รวมเป็น 1 ข้อความ/ตลาด/รอบ, แสดงสูงสุด 5) | ต่อโพสต์ |
| ⚡ ราคาขยับแรง | mid ของ bucket ใดก็ได้ในตลาดที่ active ขยับ ≥ 15pp ภายใน 5 นาที | ต่อ bucket ต่อ 15 นาที (`state.jump_alerted`) |
| ⚠️ / ✅ ระบบ | ดูข้อ health | `state.health.down` |
| 🟢🟡🔴 Paper ซื้อ · 💰/🔻 ขาย · ⚪ avg7d ซื้อ | agent ตัดสินใจที่ checkpoint (ไม่ส่งตอน skip/hold) | checkpoint ละครั้ง (`state.paper.done`) |
| 🏁 Paper ตลาดปิด | settle ไม้ทุกตัวของตลาดนั้น (ถูก/ผิด, PnL) | ต่อไม้ (exit_ts) |
| 📒 รายงาน paper | ทุกวัน 08:00 ICT | — |

- ทุกบรรทัดโพสต์มี latency: `⏱ นำเข้า +x นาที` (createdAt → importedAt ของ xtracker) · `ส่ง +y นาที` (createdAt → เวลาส่ง)
- ข้อความ 🔔 ⏱ ⚡ และ /status แสดงผลโมเดล (เฟส 2):
  - ยอด · bucket ปัจจุบัน (P จบในนี้) · "ต้องได้อีก N" เฉพาะเมื่อ P(ถึง bucket ถัดไป) ≥ 2%
  - ทุก bucket ที่ P > 3% แสดงแบบ `🟢 65-89 · โมเดล 97% · ask 91¢ · edge +6pp`
  - ไอคอนตาม edge Yes = P − ask: 🟢🟢 ≥ +10pp · 🟢 +5..+10 · 🟡 −5..+5 · 🔴 −10..−5 · 🔴🔴 ≤ −10
- โมเดลฝั่ง server: [supabase/functions/_shared/model.ts](supabase/functions/_shared/model.ts) (analog 60 วัน, w = 0.5, 20,000 sims) ใช้ร่วมกับ backtest · ผลตรงกับ `simulate()` ใน template ทุก sim (ทดสอบด้วย seed เดียวกัน) · input = `hourly_counts()` 100 วันจากตาราง posts
- หน้าเว็บ: แถวในตาราง bucket ระบายสีตามระดับเดียวกัน (เฉพาะแถวที่ P หรือราคา ≥ 3%) · โมเดลของหน้าเว็บยังอยู่ใน template.html (อัลกอริทึมเดียวกัน)

### หน้าเว็บ: ส่วน "วันนี้" ใน #posts (2026-11-27)
- หัวข้อ: ยอดวันนี้ตามวัน ICT (00:00–24:00) + คาดทั้งวัน · เมนูเปลี่ยนเป็น "วันนี้ / โพสต์"
- การ์ด 4 ใบ: โพสต์แล้ว (เทียบค่าปกติ ณ เวลานี้) · คาดการณ์ตั้ง 12:00 · ตั้ง 18:00 (ใช้เฉพาะข้อมูลก่อนเวลานั้น + ค่าปัจจุบันสีเทา) · เมื่อวาน (จริง vs ที่คาดไว้)
- คาดการณ์ = ยอดที่มีแล้ว + ช่วงเวลาที่เหลือของ 60 วันก่อน × แนวโน้ม 7 วัน/60 วัน (น้ำหนัก `S.set.w`) · ช่วง 80% = p10–p90
- กราฟ + ตารางราย 3 ชม.: โพสต์ | ปกติ | เทียบ (×) | สะสม | สะสมปกติ · ช่วงที่ ≥ 1.3× เป็นสีส้ม
- ปุ่มช่วงข้อมูลเหนือกราฟ: วันนี้ · 3 วัน · 7 วัน · 15 วัน · 1 เดือน · 3 เดือน
  - "วันนี้" = แบบเดิม (ปกติ = เฉลี่ย 60 วัน + เส้นประคาดการณ์)
  - ปุ่มอื่น = เฉลี่ยต่อวันของ N วันเต็มล่าสุด (ไม่รวมวันนี้) + คอลัมน์ p10–p90 · ปกติ = เฉลี่ย 365 วัน · ไม่มีเส้นประ
  - ค่าที่เลือกเก็บใน `S.slotW` (ไม่ save ลง localStorage → เปิดหน้าใหม่กลับเป็น "วันนี้") · คงอยู่ข้ามรอบอัปเดต 60 วินาที
- อัปเดตทุก 60 วินาที (`renderToday` ใน setInterval) และทุกโพสต์ใหม่ (Realtime → `renderAll`)
- โค้ด: `fcDay`, `renderToday`, `slotWindow`, `renderSlotTable`, `drawToday` ใน template.html

### เฟส 3: live paper trading (`paper`) — เริ่ม 2026-11-27
- กติกา = backtest v2 (`_shared/paper.ts`): 2x T−24.5h/T−17.5h · 3x T−16h/T−7h/T−2.5h · avg7d ซื้อ Yes ตอนเปิดตลาด · $10/ไม้ · ถือได้ 1 ไม้/ตลาด/agent
  - เข้า: edge = P ฝั่งนั้น − (ask + fee) ≥ +5pp · ask 5–95¢ · ฝั่ง No ใช้ ask_no = 1 − bid_yes
  - ออก: (bid − fee) ≥ P + 3pp → take_profit · edge ≤ −5pp → stop_loss · ไม่งั้นถือจน settle (exit 1/0 ไม่มี fee)
  - fee = r × f × (1−f) ต่อหุ้น · r = `feeSchedule.rate` ของ bucket (เก็บใน `state.markets[].buckets[].fee`, ตอนนี้ 0.01)
  - ไม่ใช้ gate ปิดช่วง (user เลือก)
- checkpoint รันครั้งเดียวใน tick แรกที่ถึงเวลา · ถ้า tick ช้ากว่า 10 นาที → บันทึก skip "เลยมาแล้ว" (ตอนเปิดระบบ checkpoint ที่ผ่านไปแล้วของตลาดปัจจุบันจะเป็น skip)
- ยอดปัจจุบัน = xtracker stats.total (fallback นับจากตาราง posts) · โมเดล = `nowcast` 20,000 sims (ไม่ fix seed)
- หน้าเว็บส่วน "Paper trading" (`#paper`): แท็บ Live / Backtest v2 · ตาราง 1/3/7/30 วัน/ทั้งหมด (ไม้ · ถูก · PnL · ROI) · กราฟ PnL สะสม · ไม้ที่ถืออยู่ · โหลดใหม่ทุก 5 นาที (`loadPaper`, `renderPaper`, `drawPaper`)

### Health check (A)
- ยอดไม่ตรงต้องเกิดซ้ำ 2 รอบติดกัน (10 นาที) ถึงจะนับเป็นปัญหา เพื่อกันกรณีโพสต์ที่เพิ่งเข้ามาฝั่งใดฝั่งหนึ่งก่อน
- ถ้าระบบอยู่ในสถานะ down อยู่แล้ว health จะยังรันต่อแม้ไม่มีตลาดเหลือ < 4 ชม. เพื่อให้ส่ง ✅ ได้

### พื้นที่ข้อมูล (F)
- เลิกเก็บราคารายนาทีแล้ว ตาราง `prices` เดิมยังอยู่ (มีข้อมูลราว 1 ชม. ของวันที่ 25 พ.ย.) แต่ไม่มีอะไรเขียนเพิ่ม ลบได้ถ้าต้องการ
- `price_cache(token_id, ts, p, market_slug, bucket)` ใช้แคชราคาจาก `clob.polymarket.com/prices-history` เฉพาะที่ใช้จริง (เฟส 2)
- bid/ask จริงจะบันทึกเฉพาะตอนเกิด paper_decisions (เฟส 3)
- งานลบอัตโนมัติมีแค่ `cron.job_run_details` (> 2 วัน) ไม่มีการลบ `posts`, `paper_*`, `price_cache`

### ความปลอดภัย
- ทุกตาราง: anon/authenticated อ่านได้อย่างเดียว เขียนได้เฉพาะ service_role
- `poll`/`health`/`paper`: header `x-poll-secret` ต้องตรงกับ Vault `poll_secret` (สุ่มสร้างในฐานข้อมูล)
- `telegram`: header `X-Telegram-Bot-Api-Secret-Token` ต้องตรงกับ Vault `telegram_webhook_secret` (setWebhook ตั้งให้เอง) และตอบเฉพาะ chat 1893239479
- Vault: `project_url`, `poll_secret`, `telegram_webhook_secret` · ค่าทั้งหมดไม่มีใน repo
- หน้าเว็บมีแค่ publishable key

## ไฟล์
- `supabase/functions/_shared/common.ts`: helper ร่วม (state, telegram, markets, /status, ข้อความโมเดล) · `model.ts` โมเดล · `slug.ts`
- `supabase/functions/poll|health|telegram/index.ts`
- `supabase/migrations/`: `…140000_init` (ตาราง/RLS/Realtime) · `…140100_cron` (Vault/cron poll) · `…160000_phase1` (price_cache, webhook secret, `private.invoke_fn`, cron health, cleanup 2 วัน) · `20261126090000_phase2` (`hourly_counts()`, paper_decisions, paper_positions)
- `template.html` → `python build.py` → `index.html` (build.py ดึง SNAP จาก index.html เดิม)

## วิธีเช็ก
```bash
Q='npx supabase db query --remote --read-only'
$Q "select jobname, active, schedule from cron.job"
$Q "select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j using (jobid) order by d.start_time desc limit 8"
$Q "select id, status_code, content::text from net._http_response order by id desc limit 8"   # ผลของ poll/health/telegram
$Q "select value from state where key='health'"                                                 # สถานะ health
$Q "select count(*), min(created_at), max(created_at) from posts"

# เรียกด้วยมือ
npx supabase db query --remote "select private.invoke_fn('poll')"
npx supabase db query --remote "select private.invoke_fn('poll', '{\"test\":true}')"                 # Telegram ทดสอบ
npx supabase db query --remote "select private.invoke_fn('health', '{\"force\":true}')"              # ตรวจทันที
npx supabase db query --remote "select private.invoke_fn('health', '{\"force\":true,\"simulate\":\"ทดสอบ\"}')"  # จำลองปัญหา
npx supabase db query --remote "select private.invoke_fn('telegram', '{\"info\":true}')"             # สถานะ webhook
npx supabase db query --remote "select private.invoke_fn('telegram', '{\"setup\":true}')"            # ตั้ง webhook ใหม่
npx supabase db query --remote "select private.invoke_fn('paper', '{\"dry\":true}')"                 # paper: ถ้าตัดสินใจตอนนี้ (ไม่บันทึก) → ดูผลใน net._http_response
npx supabase db query --remote "select private.invoke_fn('paper', '{\"dry\":true,\"telegram\":true}')" # + ส่ง 🧪 ไป Telegram
npx supabase db query --remote "select private.invoke_fn('paper', '{\"report\":true}')"              # รายงาน paper ทันที
$Q "select agent, market_slug, action, side, bucket, price, edge, reason, ts from paper_decisions where mode='live' order by id desc limit 20"
$Q "select agent, market_slug, side, bucket, entry_price, exit_reason, pnl from paper_positions where mode='live' order by id desc"
```
- จำลองระบบล่มจริง: `select cron.alter_job((select jobid from cron.job where jobname='elon-poll'), active := false)` รอ > 3 นาที แล้วรัน health → ⚠️ · เปลี่ยนเป็น `active := true` แล้วรัน health อีกครั้ง → ✅
- Telegram: พิมพ์ `/status` ในแชตกับบอท

## Deploy ซ้ำ
```bash
git pull                                                     # มี bot commit ทุกชั่วโมง
npx supabase functions deploy poll health telegram paper --use-api # (CLI จะขอ --yes ในโหมด agent)
npx supabase db push --remote                                # เมื่อมี migration ใหม่
python build.py                                              # เมื่อแก้ template.html
```

## Backtest
```bash
deno run -A scripts/backtest.ts            # v2 → reports/backtest_v2_<วันที่ ICT>.md (แคชราคา/โมเดลใน .cache/backtest/, gitignored)
deno run -A scripts/backtest.ts --write    # + สร้าง .cache/backtest/sql/*.sql: 0_delete (ลบ paper_* mode='backtest' ทั้งหมด) → insert v2 → price_cache
for f in .cache/backtest/sql/*.sql; do npx supabase db query --remote --yes -f "$f"; done
```
- อ่านโพสต์ + bid/ask สำหรับ calibrate ด้วย publishable key (อ่านอย่างเดียว) · เขียน DB ผ่าน `supabase db query` (ไม่ต้องใช้ service key)
- รัน sql ชุดใหม่จะ**ลบแถว backtest เดิมทั้งหมด**แล้วเขียนใหม่ (ถามก่อนรัน)
- config ใน script: `C_V2` (หลัก) · `C_V1` (จำลอง v1 ได้ตัวเลขตรงรายงานเดิม) · `C_GATE` / `C_CAL` / `C_F05` ใช้เทียบในรายงาน
- ตลาดที่ไม่มี marketLink หา slug จากชื่อ ([_shared/slug.ts](supabase/functions/_shared/slug.ts) ใช้ทั้งใน backtest และ live)

## ค้าง / ถัดไป
- ข้อ D (latency) ยังไม่เห็นข้อความจริงจาก poll ตัวใหม่ เพราะยังไม่มีโพสต์ใหม่ขณะที่ตลาดเหลือ < 6 ชม. → เช็กที่ข้อความ ⏱/🔔 ถัดไป
- เฟส 3 paper trading live → รายละเอียดใน [NEXT_TASKS.md](NEXT_TASKS.md)
- ✅ GitHub Action `hourly-data` รันตาม schedule แล้ว (มี commit `data: hourly update` 25–27 พ.ย.)
