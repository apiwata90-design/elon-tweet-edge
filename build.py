import json
enc=open('/home/claude/raw/hourly_enc.txt').read().strip()
weeks=json.load(open('/home/claude/raw/weeks.json'))
mk=json.load(open('/home/claude/raw/snap_markets.json'))
TH={'Political / regulatory clash':('การเมือง/ขัดแย้งกับรัฐ','EU ปรับ X, รับเหรียญจาก Trump, วันเลือกตั้ง'),
'Product launch (Musk co.)':('เปิดตัวผลิตภัณฑ์','Robotaxi ไม่มีคนคุม, Grok Bot'),
'Starship launch':('Starship launch','Flight 12, 14, 15'),
'Tesla earnings':('งบ Tesla','Q4-25, Q3-26'),
'US holiday':('วันหยุดสหรัฐฯ','Thanksgiving, Christmas, New Year, 4 ก.ค.'),
'Capital-markets event':('IPO (Initial Public Offering) / ตลาดทุน','SpaceX IPO 12 มิ.ย.')}
ev=json.load(open('/home/claude/out_events.json'))['summary']
order=['Political / regulatory clash','Product launch (Musk co.)','Tesla earnings','Starship launch','US holiday','Capital-markets event']
evs=[]
for t in order:
    e=next(x for x in ev if x['type']==t)
    evs.append(dict(type=t,th=TH[t][0],ex=TH[t][1],r1=e['avg_ratio'],d48=e['avg_delta48'],n=e['n']))
L='https://www.latintimes.com/elon-musk-dealbook-summit-political-bet-tesla-starlink-601556'
expl={
'2025-12-05':dict(t='EU ปรับ X €120 ล้านตาม DSA (Digital Services Act – กฎหมายบริการดิจิทัลของ EU) — Musk ตอบโต้หนักเรื่องเสรีภาพการพูด/ยุโรป',s='https://www.aljazeera.com/amp/news/2025/12/5/eu-hits-musks-x-with-140m-fine-for-deceptive-blue-tick-ad-transparency'),
'2025-12-06':dict(t='วันถัดจาก EU ปรับ X — โพสต์เรื่องยุโรป/censorship ต่อเนื่อง + ปฏิเสธข่าวระดมทุน SpaceX $800B',s='https://www.techspot.com/news/110520-elon-musk-calls-eu-abolished-x-cuts-off.html'),
'2026-01-22':dict(t='Tesla เริ่ม Robotaxi ไม่มี safety monitor ที่ Austin + อยู่ร่วมงาน Davos WEF (World Economic Forum)',s='https://techcrunch.com/2026/01/22/tesla-launches-robotaxi-rides-in-austin-with-no-human-safety-driver/'),
'2026-01-29':dict(t='วันหลังงบ Tesla Q4-25 (28 ม.ค.) + โปรโมต Grok Imagine (วิดีโอ/API) อย่างหนัก — จากเนื้อหาโพสต์',s='https://ir.tesla.com/press-release/tesla-releases-fourth-quarter-and-full-year-2025-financial-results'),
'2026-02-10':dict(t='ประเด็นการเมือง: เอกสารศาลคดี Epstein, แก๊งล่วงละเมิดในอังกฤษ — รีโพสต์จำนวนมาก (จากเนื้อหาโพสต์)',s=None),
'2026-03-19':dict(t='โปรโมต Grok Imagine templates + Grok Heavy (จากเนื้อหาโพสต์)',s=None),
'2026-04-12':dict(t='ถกเรื่อง Starlink ถูกปฏิเสธใบอนุญาตในแอฟริกาใต้ + วัคซีน + ผู้อพยพ (จากเนื้อหาโพสต์)',s=None),
'2026-05-20':dict(t='SpaceX ต้องเปิดเอกสาร S-1 ยื่น IPO ภายใน 20 พ.ค. + ดีล AI compute กับ Anthropic → ตามด้วย Starship V3 Flight 12 (22 พ.ค.) สัปดาห์นั้นสูงกว่าฐาน 1.64×',s='https://www.fool.com/investing/2026/05/17/spacex-accelerates-ipo-timeline-10-things-to-know/'),
'2026-05-22':dict(t='Starship V3 Flight 12',s='https://pbs.org/newshour/science/spacex-launches-its-biggest-starship-mega-rocket-yet-on-test-flight'),
'2026-08-19':dict(t='โปรโมต Grok Bot (เปิด beta 11 ส.ค. ขยายไปแพ็กเกจอื่น 21 ส.ค.) + Starlink',s='https://x.ai/news/grok-bot-more-plans'),
'2026-08-20':dict(t='โปรโมต Grok Bot ต่อเนื่อง (คำว่า grok/bot/build เด่นสุด) + Starship catch',s='https://x.ai/news/grok-bot-more-plans'),
'2026-10-07':dict(t='อัปเดตใหญ่ Grok Bot/Grok Build + แคมเปญ Starlink India',s=None),
'2026-10-08':dict(t='รับ National Medal of Science จาก Trump + Starlink Mobile/คลื่นความถี่ + Starlink India',s='https://www.malaymail.com/amp/news/world/2026/10/09/trump-calls-musk-a-national-treasure-while-handing-him-top-us-science-honour/238334'),
'2026-10-14':dict(t='เปิดตัว Grok Voice 3.0 + การเมืองเลือกตั้งวุฒิสภาเท็กซัส',s='https://x.ai/news'),
'2026-10-30':dict(t='เร่งชวนโหวตก่อนเลือกตั้งกลางเทอม 3 พ.ย. (Musk ทุ่มราว $500M หนุนผู้สมัคร Republican)',s=L),
'2026-11-14':dict(t='วันหลัง Starship Flight 15 (13 พ.ย.) + รีโพสต์ภาษาเยอรมัน/ฝรั่งเศสจำนวนมาก',s='https://www.space.com/space-exploration/launches-spacecraft/spacex-starship-flight-15-chopsticks-double-catch-super-heavy-ship'),
'2026-06-13':dict(t='วันหลัง SpaceX IPO เข้าเทรด (12 มิ.ย.) — เงียบผิดปกติ',s='https://www.npr.org/2026/06/11/nx-s1-5853199/spacex-is-poised-for-blastoff-with-an-ipo-likely-to-break-records'),
'2026-07-04':dict(t='วันชาติสหรัฐฯ (US holiday)',s=None),
'2026-07-03':dict(t='ช่วงหยุดยาว 4 ก.ค.',s=None),
'2026-02-05':dict(t='วันให้สัมภาษณ์ podcast ยาวกับ Dwarkesh Patel/John Collison (จากเนื้อหาโพสต์)',s=None),
'2026-11-10':dict(t='น่าจะเป็นช่วงเดินทางเอเชีย (ร่วมคณะสหรัฐฯ ช่วง APEC เซินเจิ้น) — เขตเวลาเปลี่ยน',s=L),
'2026-11-12':dict(t='น่าจะเป็นช่วงเดินทางเอเชีย (ร่วมคณะสหรัฐฯ ช่วง APEC เซินเจิ้น)',s=L),
'2026-07-09':dict(t='Grok 4.5 ขึ้นอันดับต้นในหลาย benchmark — โปรโมตหนัก (จากเนื้อหาโพสต์)',s='https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/'),
'2026-06-23':dict(t='ถกเรื่อง USAID/DOGE (ตอบโต้ข้อกล่าวหาว่า DOGE ทำให้เด็กเสียชีวิต) — รีโพสต์จำนวนมาก (จากเนื้อหาโพสต์)',s=None),
'2026-05-18':dict(t='โปรโมต Grok Imagine/Grok Build + ประเด็นคดีความในศาล — ก่อนสัปดาห์ S-1 SpaceX (จากเนื้อหาโพสต์)',s=None),
'2026-08-26':dict(t='ไม่พบข่าวอธิบายชัด — โพสต์เพียงช่วงสั้น ๆ (น่าจะเดินทาง/ติดภารกิจ)',s=None),
'2025-11-01':dict(t='ไม่พบข่าวอธิบายชัด — วันเสาร์ที่เงียบมาก',s=None),
'2026-07-20':dict(t='ไม่พบข่าวอธิบายชัด — ช่วงรอ Starship Flight 13 ที่เลื่อนจาก 16 ก.ค.',s='https://www.space.com/space-exploration/launches-spacecraft/spacex-targets-july-16-for-starship-flight-13-reveals-what-went-wrong-on-previous-launch/amp/'),
'2026-04-14':dict(t='ไม่พบข่าวอธิบายชัด — โพสต์เป็นช่วง ๆ (น่าจะเดินทาง)',s=None),
'2025-12-13':dict(t='ไม่พบข่าวอธิบายชัด — ทั้ง 16 โพสต์อยู่ในช่วง 80 นาทีเดียว',s=None),
'2026-07-26':dict(t='ไม่พบข่าวอธิบายชัด — วันอาทิตย์ที่เงียบ',s=None),
}
up=[dict(d='2026-11-26',t='Thanksgiving สหรัฐฯ (ปี 2025 วันนี้กลับสูงกว่าฐาน 1.28×)',type='US holiday'),
dict(d='2026-12-10',t='Starship Flight 16 — ครั้งแรกจาก Florida LC-39A (วันยังไม่ยืนยัน)',type='Starship launch',est=True,s='https://tech-insider.org/spacex-lc-39a-florida-pad-key-test-2026/'),
dict(d='2026-12-25',t='Christmas (ปี 2025 = 0.44× ของฐาน)',type='US holiday'),
dict(d='2027-01-01',t='New Year (ปี 2026 = 0.59× ของฐาน)',type='US holiday'),
dict(d='2027-01-02',t='Tesla ยอดส่งมอบ Q4 (ตามรอบปกติ)',est=True),
dict(d='2027-01-20',t='Davos WEF ช่วงปลาย ม.ค. (ปี 2026 Musk ไปร่วม)',est=True),
dict(d='2027-01-27',t='Tesla งบ Q4-2026',type='Tesla earnings',est=True,s='https://en.arincen.com/instruments/TSLA/earnings')]
SNAP=dict(t0='2025-11-01T00:00:00Z',enc=enc,weeks=weeks,markets=mk,snapTime='2026-11-25T12:37:00Z',evSummary=evs,expl=expl,upcoming=up)
html=open('template.html').read().replace('/*__DATA__*/','const SNAP='+json.dumps(SNAP,ensure_ascii=False,separators=(',',':'))+';')
open('index.html','w').write(html)
import os; os.makedirs('data',exist_ok=True)
json.dump(dict(t0=SNAP['t0'],enc=enc),open('data/hourly.json','w'))
print(len(html))
