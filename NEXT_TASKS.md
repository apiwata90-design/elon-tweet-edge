# NEXT_TASKS — Elon Tweet Edge

_อัปเดต 2026-11-27 · ✅ Backtest v2 เสร็จ (ดู [reports/backtest_v2_2026-11-27.md](reports/backtest_v2_2026-11-27.md)) · ถัดไป: เฟส 3_

## 1. เฟส 3: live paper trading
- agent 2x (T−24.5h/T−17.5h), 3x (T−16h/T−7h/T−2.5h), baseline avg7d · `mode='live'` · logic เดียวกับ backtest v2 (`C_V2` ใน scripts/backtest.ts)
  - เข้าเมื่อ edge ≥ +5pp หลังหักต้นทุน · ขายเมื่อรายรับสุทธิ ≥ P + 3pp หรือ edge ≤ −5pp
  - ห้ามซื้อเมื่อราคา fill < 0.05 หรือ > 0.95
  - **ไม่ใช้** gate "ปิดช่วงที่โมเดลไม่ชนะตลาด" (user เลือก 27 พ.ย. — สัญญาณไม่เสถียร)
- fill ด้วย bid/ask จริงจาก gamma ณ เวลานั้น + fee taker r × f × (1−f) ทั้งซื้อและขาย · r อ่านจาก `feeSchedule.rate` ของตลาด (ตอนนี้ 0.01)
- บันทึก `paper_decisions` / `paper_positions` (ตารางสร้างไว้แล้วใน migration phase2)
- แจ้ง Telegram ทุก buy/sell พร้อมไอคอนสีและเหตุผล
- รายงาน 1d/3d/7d/30d ต่อ agent (จำนวนไม้, อัตราถูก, PnL $, ROI %) ส่ง Telegram ทุกวัน 08:00 ICT
- หน้าเว็บเพิ่มส่วน "Paper trading" (อ่านจาก Supabase ด้วย publishable key): ตารางผล + กราฟ PnL สะสม
- ทดสอบ: เรียก paper decision ด้วยมือ

## 2. จบงาน
อัปเดต CURRENT_STATE.md → commit + push → สรุป (แก้ไฟล์อะไร, ค่าที่ตั้ง, วิธีเช็ก, สิ่งที่ user ต้องทำ)

## ค้างจากรอบก่อน
- ข้อ D (latency ในข้อความโพสต์) ยังไม่เห็นข้อความจริงจาก poll ตัวใหม่
