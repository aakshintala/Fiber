import sys,json
for l in sys.stdin:
    m=json.loads(l); sys.stdout.write(json.dumps({"id":m["id"],"result":m["params"]})+"\n"); sys.stdout.flush()
