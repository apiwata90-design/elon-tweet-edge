"""Hourly updater (runs in GitHub Actions).
- Extends data/hourly.json with new posts from xtracker (Polymarket's Post Counter source)
- Writes data/news.json (Google News RSS) and data/launches.json (Launch Library 2, Starship)
Every step is independent: one failure never blocks the others."""
import json, re, time, urllib.request, urllib.parse, datetime as dt, xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
UA = {"User-Agent": "Mozilla/5.0 elon-tweet-edge", "Accept": "application/json"}
HR = 3600

def get(url, raw=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        b = r.read()
    return b if raw else json.loads(b)

def iso(ts): return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def decode(e): return [int(m[1]) if m[1] else int(m[0], 36) for m in re.findall(r"(\{(\d+)\}|.)", e)]
def encode(a): return "".join(format_b36(v) if v < 36 else "{%d}" % v for v in a)
def format_b36(v): return "0123456789abcdefghijklmnopqrstuvwxyz"[v]

def update_hourly():
    d = json.load(open("data/hourly.json"))
    t0 = int(dt.datetime.fromisoformat(d["t0"].replace("Z", "+00:00")).timestamp())
    bins = decode(d["enc"])
    start = t0 + len(bins) * HR
    end = (int(time.time()) // HR) * HR          # only complete hours
    if end <= start: return
    posts, f = [], start
    while f < end:
        to = min(f + 15 * 86400, end)
        j = get(f"https://xtracker.polymarket.com/api/users/elonmusk/posts?platform=X&startDate={iso(f)}&endDate={iso(to)}")
        posts += j.get("data") or []
        f = to
    seen = set()
    bins += [0] * ((end - start) // HR)
    for p in posts:
        if p["id"] in seen: continue
        seen.add(p["id"])
        t = int(dt.datetime.fromisoformat(p["createdAt"].replace("Z", "+00:00")).timestamp())
        if start <= t < end: bins[(t - t0) // HR] += 1
    d["enc"] = encode(bins); d["updated"] = iso(time.time())
    json.dump(d, open("data/hourly.json", "w"))
    print("hourly +", (end - start) // HR, "h,", len(seen), "posts")

def update_news():
    items, seen = [], set()
    for q in ["Elon Musk", "SpaceX Starship launch", "Tesla Musk", "xAI Grok Musk", "Musk interview"]:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q + " when:3d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
        root = ET.fromstring(get(url, raw=True))
        for it in root.iter("item"):
            title = it.findtext("title") or ""
            if title in seen: continue
            seen.add(title)
            src = it.find("source")
            try: date = parsedate_to_datetime(it.findtext("pubDate")).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception: continue
            items.append({"title": title, "link": it.findtext("link"), "source": src.text if src is not None else "", "date": date, "q": q})
    items.sort(key=lambda x: x["date"], reverse=True)
    json.dump({"updated": iso(time.time()), "items": items[:60]}, open("data/news.json", "w"), ensure_ascii=False)
    print("news", len(items))

def update_launches():
    j = get("https://ll.thespacedevs.com/2.2.0/launch/upcoming/?search=starship&limit=8")
    out = [{"d": r["net"], "t": r["name"] + (" · " + r["status"]["abbrev"] if r.get("status") else ""), "type": "Starship launch",
            "est": (r.get("status") or {}).get("abbrev") != "Go"} for r in j.get("results", [])]
    json.dump({"updated": iso(time.time()), "items": out}, open("data/launches.json", "w"), ensure_ascii=False)
    print("launches", len(out))

for fn in (update_hourly, update_news, update_launches):
    try: fn()
    except Exception as e: print(fn.__name__, "failed:", e)
