import json, glob, os, collections
files = glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True)
byid={}
for f in files:
    try: h=json.loads(open(f).readline())
    except: continue
    byid[h.get('id')]=(f,h)
kinds=collections.Counter(); examples={}
for sid,(f,h) in byid.items():
    ps=h.get('parentSession')
    if not ps: continue
    # does child start with copied history? count message entries before first entry w/ timestamp after header
    lines=[json.loads(l) for l in open(f) if l.strip()]
    msgs=[e for e in lines if e.get('type')=='message']
    htime=h.get('timestamp','')
    copied=sum(1 for e in msgs if e.get('timestamp','')<htime)
    firstuser=next((e['message'].get('content') for e in msgs if e['message'].get('role')=='user'),None)
    if isinstance(firstuser,list): firstuser=' '.join(p.get('text','') for p in firstuser if isinstance(p,dict))
    k='copied-history' if copied else 'fresh'
    kinds[k]+=1
    examples.setdefault(k,[]).append((os.path.relpath(f,os.path.expanduser('~/.pi/agent/sessions')), copied, (firstuser or '')[:100].replace('\n',' ')))
print(kinds)
for k,v in examples.items():
    print('--',k)
    for x in v[:5]: print('  ',x)
print('header keys sample', sorted({k for _,h in byid.values() for k in h}))
def firstuser(f):
    for l in open(f):
        e=json.loads(l)
        if e.get('type')=='message' and e['message'].get('role')=='user':
            c=e['message'].get('content'); return json.dumps(c)[:500]
same=0; tmp=0; parents_found=0
for sid,(f,h) in byid.items():
    ps=h.get('parentSession')
    if not ps: continue
    if '/var-folders' in f or 'var-folders' in f: tmp+=1
    pid=os.path.basename(ps).split('_')[-1].replace('.jsonl','') if '/' in ps else ps
    p=byid.get(pid)
    if p: parents_found+=1; same+= firstuser(f)==firstuser(p[0])
print('child in temp-dir cwd',tmp,'parents found',parents_found,'child first msg == parent first msg',same)
