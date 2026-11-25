"""Build index.html from template.html.

The original build read raw data from /home/claude/raw/ (only available where the snapshot
was first made). This version reuses the SNAP object already embedded in the current
index.html, so the page can be rebuilt anywhere:

    python build.py

It does NOT touch data/*.json (those are updated hourly by the GitHub Action).
"""
import json
import re

SRC, OUT, MARK = "template.html", "index.html", "/*__DATA__*/"

old = open(OUT, encoding="utf-8").read()
m = re.search(r"const SNAP=", old)
if not m:
    raise SystemExit("index.html has no 'const SNAP=' — cannot extract snapshot")
snap, _ = json.JSONDecoder().raw_decode(old, m.end())

tpl = open(SRC, encoding="utf-8").read()
if tpl.count(MARK) != 1:
    raise SystemExit(f"{SRC} must contain {MARK} exactly once")

html = tpl.replace(MARK, "const SNAP=" + json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + ";")
open(OUT, "w", encoding="utf-8", newline="\n").write(html)
print(f"{OUT}: {len(html):,} chars, snapTime {snap.get('snapTime')}")
