import subprocess,json,time,statistics,sys,os
def rss(pid):
    return int(subprocess.check_output(["ps","-o","rss=","-p",str(pid)]).strip())/1024
cmds={"node":["node","echo.js"],"bun":["bun","echo.js"],"python3":["python3","echo.py"]}
for name,cmd in cmds.items():
    t0=time.perf_counter()
    p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
    p.stdin.write(json.dumps({"id":0,"params":"x"})+"\n"); p.stdin.flush(); p.stdout.readline()
    start=(time.perf_counter()-t0)*1000
    time.sleep(0.5); idle=rss(p.pid)
    for size in (256,16384):
        payload="a"*size; lat=[]
        for i in range(2000):
            s=time.perf_counter()
            p.stdin.write(json.dumps({"id":i,"params":payload})+"\n"); p.stdin.flush(); p.stdout.readline()
            lat.append((time.perf_counter()-s)*1e6)
        print(f"{name:8} start+first reply {start:6.1f} ms  idle RSS {idle:5.1f} MiB  {size:>6} B round trip median {statistics.median(lat):6.1f} us p99 {sorted(lat)[1979]:7.1f} us")
    p.kill()
# spawn per call, Claude Code style
for name,cmd in cmds.items():
    ts=[]
    for i in range(20):
        s=time.perf_counter()
        p=subprocess.run(cmd,input=json.dumps({"id":1,"params":"x"})+"\n",capture_output=True,text=True)
        ts.append((time.perf_counter()-s)*1000)
    print(f"{name:8} spawn-per-call median {statistics.median(ts):6.1f} ms")
