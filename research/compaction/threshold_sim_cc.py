# Same simulation on Claude Code sessions (main thread only; sidechains skipped).
import json, glob, os, collections
NOTE = 2000
sess = []; models = collections.Counter()
for p in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
    if '/subagents/' in p: continue
    ctx = []; seen = set()
    for line in open(p, errors='ignore'):
        try: e = json.loads(line)
        except: continue
        if e.get('type') != 'assistant' or e.get('isSidechain'): continue
        m = e.get('message') or {}
        if m.get('id') in seen: continue   # one API response is split over several lines
        seen.add(m.get('id'))
        u = m.get('usage') or {}
        c = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
        if c: ctx.append(c); models[m.get('model')] += 1
    if ctx: sess.append(ctx)
print('sessions with usage', len(sess), 'models', models.most_common(6))
peaks = sorted(max(c) for c in sess)
for T in (50_000, 100_000, 150_000, 200_000, 250_000, 400_000):
    crossed = sum(1 for p in peaks if p >= T); comps = []
    for c in sess:
        base, cur, n = c[0], c[0], 0
        for a, b in zip(c, c[1:]):
            cur += max(0, b - a)
            if cur >= T: n += 1; cur = base + NOTE
        comps.append(n)
    print(f'T={T:>7}: sessions reaching {crossed:4} ({crossed/len(sess):5.1%}), simulated compactions {sum(comps):4}, sessions >1x {sum(1 for x in comps if x>1)}, max/session {max(comps)}')
print('peak p50/p75/p90/p99', [peaks[int(len(peaks)*q)] for q in (.5,.75,.9,.99)])
print('base p50', sorted(c[0] for c in sess)[len(sess)//2])
