import subprocess,json,time,sys,os,statistics
N="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/"
S={
 "quotabar":["/opt/homebrew/bin/node","--experimental-strip-types","/Users/aakshintala/work/ClaudeBar/mcp/index.ts"],
 "cursor-delegate":[N+"node","/Users/aakshintala/work/cursor-delegate/dist/index.js"],
 "node_repl":[N+"node_repl"],
}
env=dict(os.environ,NODE_REPL_NODE_MODULE_DIRS="/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",NODE_REPL_NODE_PATH=N+"node",CODEX_HOME=os.path.expanduser("~/.codex"))
def msg(p,o): p.stdin.write((json.dumps(o)+"\n").encode()); p.stdin.flush()
def recv(p,i):
    while True:
        l=p.stdout.readline()
        if not l: raise RuntimeError("eof")
        try: o=json.loads(l)
        except: continue
        if o.get("id")==i: return o
for name,cmd in S.items():
    ts=[];nt=None
    for _ in range(5):
        t=time.perf_counter()
        p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env)
        try:
            msg(p,{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}})
            recv(p,1); msg(p,{"jsonrpc":"2.0","method":"notifications/initialized"})
            msg(p,{"jsonrpc":"2.0","id":2,"method":"tools/list"}); r=recv(p,2)
            ts.append((time.perf_counter()-t)*1000); nt=len(r["result"]["tools"])
        except Exception as e: print(name,"error",e); break
        finally: p.kill(); p.wait()
    if ts: print(f"{name}: tools={nt} spawn->tools/list ms median={statistics.median(ts):.0f} max={max(ts):.0f}")
