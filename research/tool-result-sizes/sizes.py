import json,glob,os,re,collections
S=collections.defaultdict(list); trunc=collections.Counter(); img=collections.Counter()
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'),recursive=True):
    for l in open(f,errors='replace'):
        try: m=json.loads(l).get('message',{})
        except: continue
        if m.get('role')!='toolResult': continue
        t=m.get('toolName','?'); n=0
        for c in m.get('content') or []:
            if c.get('type')=='text':
                n+=len(c.get('text','').encode())
                if re.search(r'Full output:|Use offset=|\[Showing lines|truncated',c.get('text','')[-400:]): trunc[t]+=1
            elif c.get('type')=='image': img[t]+=1
        S[t].append(n)
cuts=[4,8,16,32,50]
print(f"{'tool':22}{'n':>7}{'p50':>7}{'p90':>7}{'p99':>8}{'max':>8} "+' '.join(f'>{c}K' for c in cuts)+'  truncNotice img')
for t,v in sorted(S.items(),key=lambda x:-len(x[1])):
    if len(v)<20: continue
    v.sort(); q=lambda p:v[min(len(v)-1,int(p*len(v)))]
    print(f"{t:22}{len(v):7}{q(.5):7}{q(.9):7}{q(.99):8}{v[-1]:8} "+' '.join(f'{100*sum(x>c*1024 for x in v)/len(v):4.1f}%' for c in cuts)+f"  {trunc[t]:5} {img[t]}")
