import json, urllib.request, urllib.parse
BASE = "https://mobile-app-backend.soniox.com"
tok = json.load(open("soniox-auth.json", encoding="utf-8-sig"))
H = {"Authorization": f"Bearer {tok['accessToken']}", "Accept": "application/json", "Content-Type": "application/json", "x-os": "Web", "x-app-version": "100.0.0"}
ORG = "b7cc7638-3fb2-443b-8f0e-26219d4ce032"
def call(method, path, params=None, body=None):
    url = BASE + path + (("?" + urllib.parse.urlencode(params)) if params else "")
    req = urllib.request.Request(url, headers=H, method=method, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            ct = r.headers.get("content-type",""); raw = r.read()
            return r.status, ct, (json.loads(raw) if "json" in ct else raw)
    except urllib.error.HTTPError as e:
        return e.code, "", e.read().decode()[:400]
def shape(o, depth=0, maxd=3):
    pad="  "*depth
    if isinstance(o, dict):
        for k,v in o.items():
            if isinstance(v,(dict,list)) and depth<maxd: print(f"{pad}{k}: {type(v).__name__}[{len(v)}]"); shape(v,depth+1,maxd)
            else: print(f"{pad}{k}: {type(v).__name__} = {repr(v)[:80]}")
    elif isinstance(o,list) and o: print(f"{pad}[0] of {len(o)}:"); shape(o[0],depth+1,maxd)

st,_,b = call("GET","/api/v1/projects/",{"organization_id":ORG}); print("=== projects",st); shape(b)
st,_,b = call("GET","/api/v1/transcriptions/",{"limit":25,"offset":0,"organization_id":ORG}); print("\n=== list",st, "count", b.get("count"))
items=b["transcriptions"]
for t in items: print(f"  {t['created_at'][:10]} {t['recording_duration_ms']//60000:4d}min analyses={len(t['analysis_results'])} tokens={len(t['tokens'])} type={t['transcription_type']} name={t['name']!r}")
with_an=[t for t in items if t["analysis_results"]]
pick=(with_an or items)[0]; tid=pick["id"]; print("\npicked", tid, pick["name"])
st,_,d = call("GET",f"/api/v1/transcriptions/{tid}"); print("\n=== detail",st); shape(d, maxd=2)
json.dump(d, open("scripts/_sample_detail.json","w"), indent=1)
if isinstance(d,dict):
    toks=d.get("tokens") or []
    print("tokens:",len(toks)); print("first tokens:", json.dumps(toks[:6], ensure_ascii=False)[:600])
    print("analysis_results sample:", json.dumps(d.get("analysis_results"), ensure_ascii=False)[:1200])
for fmt in ["json","txt"]:
    st,ct,b = call("POST",f"/api/v1/transcriptions/{tid}/export",body={"format":fmt,"speaker_labels":True,"timestamps":True,"language_labels":False,"filename":"x"})
    print(f"\n=== export {fmt} -> {st} {ct}")
    if isinstance(b,(dict,list)): shape(b, maxd=2); print(json.dumps(b, ensure_ascii=False)[:700])
    else: print(b[:600] if isinstance(b,str) else b[:600])
st,_,b = call("GET","/api/v1/transcriptions/sync",{"organization_id":ORG,"limit":2,"offset":0}); print("\n=== sync",st); shape(b, maxd=1)
