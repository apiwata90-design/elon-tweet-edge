# CURRENT_STATE — Elon Tweet Edge

_อัปเดตล่าสุด: 2026-11-25 (เพิ่ม backend Supabase)_

## ใช้งานได้แล้ว
| ส่วน | ที่อยู่ | สถานะ |
|---|---|---|
| หน้าเว็บ (GitHub Pages) | https://apiwata90-design.github.io/elon-tweet-edge/ | ✅ live · main / root |
| Repo | https://github.com/apiwata90-design/elon-tweet-edge | public |
| Action `hourly-data` | `.github/workflows/update.yml` | ✅ ทุกชั่วโมง :07 UTC → commit `data/*.json` |
| Supabase | project `ahanxplktggyqxdiydfi` (Singapore) | ✅ ตาราง + RLS + Realtime |
| Edge Function `poll` | `supabase/functions/poll/index.ts` | ✅ deployed (verify_jwt = false, ตรวจ header `x-poll-secret`) |
| Cron `elon-poll` | pg_cron `30 seconds` → `private.invoke_poll()` | ✅ |
| Cron `elon-cron-cleanup` | ทุกวัน 03:17 UTC ลบ `cron.job_run_details` เก่ากว่า 3 วัน | ✅ |
| Telegram | secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (ใน Supabase) | ✅ ทดสอบส่งผ่าน |

## สถาปัตยกรรม
```
pg_cron (30s) ──pg_net──▶ Edge Function poll ──▶ xtracker posts (10 นาทีล่าสุด) ──upsert──▶ posts ──Realtime──▶ หน้าเว็บ
                              │                                                                         (แจ้งเตือน+เสียง)
                              ├─ ทุก ~60s: xtracker trackings + gamma-api ราคา ──▶ prices (เฉพาะแถวที่ราคาเปลี่ยน)
                              ├─ state: last_post_at, markets, last_prices, alerted_ids, last_market_poll
                              └─ Telegram: (a) โพสต์แรกหลังเงียบ ≥3 ชม. (b) ตลาดเหลือ <6 ชม. → ทุกโพสต์ใหม่
GitHub Action (ชม.ละครั้ง) ──▶ data/hourly.json, news.json, launches.json ──▶ หน้าเว็บ
หน้าเว็บ: ดึง xtracker ตรงตามรอบรีเฟรช (5/15/60 นาที) เสมอ = fallback ถ้า Supabase ใช้ไม่ได้
          ตลาดที่เลือกเหลือ <6 ชม. → ดึงราคา Polymarket ทุก 30 วินาที
```

**ความปลอดภัย**
- ตาราง `posts`, `prices`, `state`: anon/authenticated อ่านได้อย่างเดียว ส่วนการเขียนทำได้เฉพาะ service_role (ทดสอบแล้ว: anon insert → 401)
- `poll` ต้องมี header `x-poll-secret` ตรงกับ Vault secret `poll_secret` ที่สุ่มสร้างในฐานข้อมูล ค่านี้ไม่มีใน repo (ทดสอบแล้ว: ไม่มี/ผิด → 401)
- Vault: `project_url`, `poll_secret`
- ในหน้าเว็บมีแค่ publishable key (`sb_publishable_…`) ซึ่งออกแบบมาให้เปิดเผยได้

**ข้อตกลง**
- ตาราง `prices` เก็บเฉพาะแถวที่ bid/ask/mid เปลี่ยนจากครั้งก่อน เพื่อประหยัดพื้นที่ (free tier 500 MB) ถ้าจะทำกราฟให้ใช้ค่าล่าสุดของแต่ละช่วง (forward-fill)
- รอบแรกของ `poll` ดึงโพสต์ย้อน 12 ชม. โดยไม่แจ้งเตือน
- ถ้ามีโพสต์ใหม่หลายโพสต์ในรอบเดียว การแจ้งเตือนแบบ (b) จะรวมเป็น 1 ข้อความต่อตลาด (แสดงสูงสุด 5 โพสต์)
- ยอดในข้อความ Telegram มาจาก `xtracker /trackings/<id>?includeStats=true` (stats.total)

## ไฟล์
- `template.html` → `python build.py` → `index.html` (build.py ดึง SNAP จาก index.html เดิม ไม่ต้องใช้ /home/claude/raw/ แล้ว)
- `supabase/migrations/20261125140000_init.sql` ตาราง, RLS, Realtime, `poll_auth()`
- `supabase/migrations/20261125140100_cron.sql` pg_cron, pg_net, Vault, `private.invoke_poll()`, cron jobs
- `supabase/functions/poll/index.ts` Edge Function
- `supabase/config.jsonc` (`functions.poll.verify_jwt = false`)

## วิธีเช็ก
```bash
# cron ทำงานไหม (ควรเห็น succeeded ทุก 30 วินาที)
npx supabase db query --remote --read-only "select status, start_time from cron.job_run_details order by start_time desc limit 5"
# ผลของ poll (ควรเป็น 200 และ ok:true)
npx supabase db query --remote --read-only "select id, status_code, content::text from net._http_response order by id desc limit 5"
# ข้อมูล
npx supabase db query --remote --read-only "select count(*), max(created_at) from posts"
npx supabase db query --remote --read-only "select key, updated_at from state"
# เรียก poll ด้วยมือ / ส่ง Telegram ทดสอบ
npx supabase db query --remote "select private.invoke_poll()"
npx supabase db query --remote "select private.invoke_poll('{\"test\":true}'::jsonb)"
# log ของฟังก์ชัน: Dashboard → Edge Functions → poll → Logs
```
- หน้าเว็บ: มุมขวาบนต้องขึ้น `LIVE · REALTIME` ถ้าขึ้นแค่ `LIVE` แปลว่า Realtime ใช้ไม่ได้และกำลังใช้ fallback
- ปุ่ม 🔔 แจ้งเตือน: เปิดแล้วเบราว์เซอร์จะขอสิทธิ์ notification และมีเสียง beep เมื่อมีโพสต์ใหม่ (ต้องเปิดแท็บค้างไว้)

## Deploy ซ้ำ
```bash
git pull                                   # มี bot commit ทุกชั่วโมง
npx supabase functions deploy poll --use-api --no-verify-jwt
npx supabase db push --remote              # เมื่อมี migration ใหม่
python build.py                            # เมื่อแก้ template.html
```

## ค้าง / ไอเดียถัดไป
- ยังไม่มี
