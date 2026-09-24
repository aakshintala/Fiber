import json, glob, os, collections
files=glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))
tot=0; br=0; pts=0; back=[]
for f in files:
    tot+=1; seen=[]; ch=collections.defaultdict(list)
    for l in open(f):
        try: e=json.loads(l)
        except: continue
        u=e.get('uuid'); p=e.get('parentUuid')
        if not u or e.get('isSidechain'): continue
        if e.get('type') not in ('user','assistant'): continue
        if p: ch[p].append(u)
        seen.append(u)
    # branch = a parent with >1 child where the extra child is a user message (rewind)
    b=[k for k,v in ch.items() if len(v)>1]
    if b:
        br+=1; pts+=len(b)
        for k in b:
            if k in seen: back.append(len(seen)-seen.index(k))
print('cc sessions',tot,'with branch',br,'branch points',pts)
if back: back.sort(); print('entries from end p50',back[len(back)//2],'max',back[-1])
