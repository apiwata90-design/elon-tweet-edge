# CURRENT_STATE — Elon Tweet Edge

_อัปเดตล่าสุด: 2026-11-25 · เฟส 1 เสร็จ (health, price jump, latency, /status, storage) · เฟส 2–3 ยังไม่เริ่ม_

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

- ทุกบรรทัดโพสต์มี latency: `⏱ นำเข้า +x นาที` (createdAt → importedAt ของ xtracker) · `ส่ง +y นาที` (createdAt → เวลาส่ง)
- P โมเดลและไอคอนสีใน ⚡/⏱ จะเพิ่มในเฟส 2

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
- `poll`/`health`: header `x-poll-secret` ต้องตรงกับ Vault `poll_secret` (สุ่มสร้างในฐานข้อมูล)
- `telegram`: header `X-Telegram-Bot-Api-Secret-Token` ต้องตรงกับ Vault `telegram_webhook_secret` (setWebhook ตั้งให้เอง) และตอบเฉพาะ chat 1893239479
- Vault: `project_url`, `poll_secret`, `telegram_webhook_secret` · ค่าทั้งหมดไม่มีใน repo
- หน้าเว็บมีแค่ publishable key

## ไฟล์
- `supabase/functions/_shared/common.ts`: helper ร่วม (state, telegram, markets, /status)
- `supabase/functions/poll|health|telegram/index.ts`
- `supabase/migrations/`: `…140000_init` (ตาราง/RLS/Realtime) · `…140100_cron` (Vault/cron poll) · `…160000_phase1` (price_cache, webhook secret, `private.invoke_fn`, cron health, cleanup 2 วัน)
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
```
- จำลองระบบล่มจริง: `select cron.alter_job((select jobid from cron.job where jobname='elon-poll'), active := false)` รอ > 3 นาที แล้วรัน health → ⚠️ · เปลี่ยนเป็น `active := true` แล้วรัน health อีกครั้ง → ✅
- Telegram: พิมพ์ `/status` ในแชตกับบอท

## Deploy ซ้ำ
```bash
git pull                                                     # มี bot commit ทุกชั่วโมง
npx supabase functions deploy poll health telegram --use-api # (CLI จะขอ --yes ในโหมด agent)
npx supabase db push --remote                                # เมื่อมี migration ใหม่
python build.py                                              # เมื่อแก้ template.html
```

## ค้าง / ถัดไป
- เฟส 2: โมเดลฝั่ง server (shared module) + ไอคอนสี + backtest G2/G3 → รอ user สั่งเริ่ม
- เฟส 3: paper trading live (หลัง user ดูผล G3)
