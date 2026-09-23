# Start one MCP server over stdio, initialize + tools/list, idle 5s, report RSS and footprint of its process tree.
# usage: mcp_measure.py NAME CWD ENVJSON CMD ARGS...
import json, os, subprocess, sys, time, re, threading
name, cwd, envj, *cmd = sys.argv[1:]
env = dict(os.environ, **json.loads(envj))
p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
lines = []
def rd():
    for l in p.stdout: lines.append(l)
threading.Thread(target=rd, daemon=True).start()
def send(o): p.stdin.write((json.dumps(o) + "\n").encode()); p.stdin.flush()
def wait_id(i, t=60):
    end = time.time() + t
    while time.time() < end and p.poll() is None:
        for l in list(lines):
            try:
                m = json.loads(l)
                if m.get("id") == i: return m
            except Exception: pass
        time.sleep(0.1)
    return None
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{"listChanged":True}},"clientInfo":{"name":"rss-probe","version":"0"}}})
init = wait_id(1)
send({"jsonrpc":"2.0","method":"notifications/initialized"})
send({"jsonrpc":"2.0","id":2,"method":"tools/list"})
tl = wait_id(2)
call = os.environ.get("MCP_CALL")  # optional tools/call params JSON, to start a lazy kernel
if call:
    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":json.loads(call)})
    print("call:", str(wait_id(3))[:300], file=sys.stderr)
time.sleep(5)
def tree(pid):
    out = subprocess.run(["ps","-axo","pid=,ppid="],capture_output=True,text=True).stdout.split("\n")
    kids = {}
    for l in out:
        if l.strip():
            a,b = map(int,l.split()); kids.setdefault(b,[]).append(a)
    res, st = [], [pid]
    while st:
        x = st.pop(); res.append(x); st += kids.get(x,[])
    return res
def fp(pid):
    o = subprocess.run(["footprint",str(pid)],capture_output=True,text=True).stdout
    m = re.search(r"phys_footprint:\s+([\d.]+)\s+(\w+)", o)
    if not m: return 0
    v,u = float(m[1]), m[2]
    return v*{"B":1/1024,"KB":1,"MB":1024,"GB":1048576}[u]
pids = tree(p.pid)
rss = sum(int(subprocess.run(["ps","-o","rss=","-p",str(x)],capture_output=True,text=True).stdout.strip() or 0) for x in pids)
f = sum(fp(x) for x in pids)
tools = [t["name"] for t in (tl or {}).get("result",{}).get("tools",[])]
caps = (init or {}).get("result",{}).get("capabilities") if init else None
print(json.dumps({"name":name,"alive":p.poll() is None,"procs":len(pids),"rss_kb":rss,"footprint_kb":round(f),"initialized":init is not None,"tools":tools,"server_caps":caps}))
p.kill()
for x in pids:
    try: os.kill(x, 9)
    except Exception: pass
