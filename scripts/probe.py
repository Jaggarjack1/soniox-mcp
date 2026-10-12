import json, sys, urllib.request, urllib.parse
BASE = "https://mobile-app-backend.soniox.com"
tok = json.load(open("soniox-auth.json", encoding="utf-8-sig"))
H = {"Authorization": f"Bearer {tok['accessToken']}", "Accept": "application/json", "x-os": "Web", "x-app-version": "100.0.0"}

def get(path, params=None):
    url = BASE + path + (("?" + urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})) if params else "")
    req = urllib.request.Request(url, headers=H)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

def shape(o, depth=0, maxd=4):
    pad = "  " * depth
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, (dict, list)) and depth < maxd:
                print(f"{pad}{k}: {type(v).__name__}[{len(v)}]"); shape(v, depth + 1, maxd)
            else:
                s = repr(v); print(f"{pad}{k}: {type(v).__name__} = {s[:70]}")
    elif isinstance(o, list) and o:
        print(f"{pad}[0] of {len(o)}:"); shape(o[0], depth + 1, maxd)

for p, q in [("/api/v1/user/info", None), ("/api/v1/projects/", None), ("/api/v1/tags/", None),
             ("/api/v1/transcriptions/", {"limit": 3, "offset": 0, "order_by": "-created_at"})]:
    st, body = get(p, q); print(f"\n=== GET {p} -> {st}")
    shape(body) if isinstance(body, (dict, list)) else print(body)
    if p.endswith("transcriptions/") and st == 200:
        items = body.get("results") if isinstance(body, dict) else body
        if isinstance(body, dict): print("list top-level keys:", list(body.keys()))
        if items:
            tid = items[0]["id"]; json.dump(items[0], open("scripts/_sample_list_item.json", "w"), indent=1)
            st2, det = get(f"/api/v1/transcriptions/{tid}"); print(f"\n=== GET detail {st2}")
            shape(det, maxd=3)
            json.dump(det, open("scripts/_sample_detail.json", "w"), indent=1)
