# NEXT_TASKS — Elon Tweet Edge

_บันทึก 2026-11-26 · user สั่งงานนี้แล้ว แต่ขอพักไว้ทำต่อพรุ่งนี้ ยังไม่ได้เริ่มลงมือ_

## ⏸ ต้องถาม user ก่อนเขียน DB
ใน Supabase มีแถว backtest v1 (`paper_decisions` 1,914 + `paper_positions` 624, `mode='backtest'`) ต้องให้ user เลือกตอน `--write`:
1. ลบ v1 แล้วเขียน v2 แทน (แนะนำ: ตัวเลข v1 ยังอยู่ในรายงาน v1 และในตารางเทียบของ v2)
2. เก็บ v1 ไว้ แล้วเขียน v2 ด้วยชื่อ agent ใหม่ (`2x@v2` …)
3. ไม่เขียน DB เลย ทำแค่รายงาน

## 1. Backtest v2 (`scripts/backtest.ts`) ปรับตามงานวิจัย calibration แล้วรันใหม่ทั้งหมด
1. ต้นทุน fill คิดตามระดับราคา แทน ±1–2¢ คงที่ โดย half-spread = สัดส่วนของราคา p:
   p < 0.05: 0.66p · 0.05–0.10: 0.29p · 0.10–0.20: 0.13p · 0.20–0.40: 0.05p · 0.40–0.95: 0.02p
   - ฝั่ง No ใช้ราคา (1−p) กับตารางเดียวกัน · ขาย = p − half-spread
   - calibrate ตารางนี้ด้วย bid/ask จริง (`state.markets` + ตาราง `prices` เดิมของวันที่ 25 พ.ย.) แล้วรายงานเทียบ
2. ค่าธรรมเนียม taker = r × p × (1−p) ต่อหุ้น คิดทั้งตอนซื้อและขาย
   - หา r จริงจาก field ของ gamma/clob market (fee rate) หรือจากหน้าตลาด · ถ้าหาไม่ได้ใช้ r = 0.05 และระบุในรายงาน
3. ห้ามเข้าซื้อเมื่อราคาที่จะซื้อ < 0.05 หรือ > 0.95 (longshot bias)
4. 90% CI ใช้ bootstrap ระดับ event (ตลาด) ไม่ใช่ระดับไม้ (v1 ทำระดับตลาดอยู่แล้ว)
5. วัดความแม่นของโมเดลเทียบตลาดที่ทุก checkpoint
   - Brier score ของ P_model เทียบราคากลางตลาด (ทุก bucket)
   - reliability diagram 10 ช่วง
   - แยก 48h/7d และตาม x
   - ช่วงไหนโมเดลไม่ชนะตลาด ให้ agent ไม่เทรดช่วงนั้น (ควรกำหนดช่วงจาก train แล้วนำไปใช้กับ test)
6. sensitivity ของเกณฑ์ edge: 5 / 8 / 10 / 15pp
7. ไม่เลือก checkpoint ใหม่ ใช้ชุดเดิม: 2x = T−24.5h/T−17.5h · 3x = T−16h/T−7h/T−2.5h · + baseline avg7d
8. เขียนผลลง `reports/backtest_v2_<date>.md` เทียบ v1 ในตารางเดียว · ลบ `paper_*` mode='backtest' เดิมก่อน `--write` (**ถามก่อน** ดูด้านบน)

## 2. เฟส 3: live paper trading (ทำพร้อมกัน)
- agent 2x, 3x, baseline avg7d · `mode='live'` · ใช้ logic เดียวกับ backtest
- fill ด้วย bid/ask จริงจาก gamma ณ เวลานั้น + ค่าธรรมเนียมตามข้อ 2
- บันทึก `paper_decisions` / `paper_positions` (ตารางสร้างไว้แล้วใน migration phase2)
- แจ้ง Telegram ทุก buy/sell พร้อมไอคอนสีและเหตุผล
- รายงาน 1d/3d/7d/30d ต่อ agent (จำนวนไม้, อัตราถูก, PnL $, ROI %) ส่ง Telegram ทุกวัน 08:00 ICT
- หน้าเว็บเพิ่มส่วน "Paper trading" (อ่านจาก Supabase ด้วย publishable key): ตารางผล + กราฟ PnL สะสม
- ทดสอบ: เรียก paper decision ด้วยมือ

## 3. จบงาน
อัปเดต CURRENT_STATE.md → commit + push → สรุป (แก้ไฟล์อะไร, ค่าที่ตั้ง, วิธีเช็ก, สิ่งที่ user ต้องทำ)

## ค้างจากรอบก่อน
- ข้อ D (latency ในข้อความโพสต์) ยังไม่เห็นข้อความจริงจาก poll ตัวใหม่
