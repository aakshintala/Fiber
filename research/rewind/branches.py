import json, glob, os, collections
files = glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True)
tot=0; hdr_parent=0; with_branch=0; with_summary=0; branch_points=[]; resets=0; labels=0; ctx_edit=0
depth_back=[]  # how many entries back from leaf the branch point was
for f in files:
    tot+=1
    ids=[]; parent_of={}; children=collections.defaultdict(list); summ=0; header=None
    try:
        for line in open(f):
            try: e=json.loads(line)
            except: continue
            t=e.get('type')
            if t=='session': header=e; continue
            if t=='branch_summary': summ+=1
            if t=='label': labels+=1
            if t=='context_edit': ctx_edit+=1
            i=e.get('id'); p=e.get('parentId')
            if i is None: continue
            if p is None and ids: resets+=1
            if ids and p is not None and p!=ids[-1]:
                # branch: count how far back p is
                try: depth_back.append(len(ids)-1-ids.index(p))
                except ValueError: pass
            ids.append(i)
            if p: children[p].append(i)
    except Exception as ex: continue
    if header and header.get('parentSession'): hdr_parent+=1
    b=sum(1 for k,v in children.items() if len(v)>1)
    if b: with_branch+=1; branch_points.append(b)
    if summ: with_summary+=1
print('sessions',tot)
print('header parentSession (fork/clone/new-with-parent)',hdr_parent)
print('sessions with in-file branch',with_branch,'branch points total',sum(branch_points))
print('sessions with branch_summary',with_summary)
print('extra roots (resetLeaf)',resets,'labels',labels,'context_edit',ctx_edit)
if depth_back:
    d=sorted(depth_back); n=len(d)
    print('entries back from leaf at branch: n',n,'p50',d[n//2],'p90',d[int(n*.9)],'max',d[-1])
