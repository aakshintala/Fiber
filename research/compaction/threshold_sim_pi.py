# Simulate absolute-token compaction thresholds on the owner's pi sessions.
# Context per request = input+cacheRead+cacheWrite. Growth = positive deltas
# between consecutive requests (a drop = a real pi compaction; ignored).
# After a simulated compaction, context = base (first request) + NOTE.
import json, glob, os
NOTE = 2000  # measured pi summary p50 ~1,566 tokens, rounded up
sess = []
for p in glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True):
    ctx = []
    for line in open(p, errors='ignore'):
        try: e = json.loads(line)
        except: continue
        m = e.get('message') or {}
        u = m.get('usage') if m.get('role') == 'assistant' else None
        if u:
            c = (u.get('input') or 0) + (u.get('cacheRead') or 0) + (u.get('cacheWrite') or 0)
            if c: ctx.append(c)
    if ctx: sess.append(ctx)
print('sessions with usage', len(sess))
peaks = sorted(max(c) for c in sess)
for T in (50_000, 100_000, 150_000, 200_000, 250_000, 400_000):
    crossed = sum(1 for p in peaks if p >= T)
    comps = []
    for c in sess:
        base, cur, n = c[0], c[0], 0
        for a, b in zip(c, c[1:]):
            cur += max(0, b - a)
            if cur >= T: n += 1; cur = base + NOTE
        comps.append(n)
    tot = sum(comps); multi = sum(1 for x in comps if x > 1)
    print(f'T={T:>7}: sessions reaching {crossed:4} ({crossed/len(sess):5.1%}), simulated compactions {tot:4}, sessions compacting >1x {multi}, max/session {max(comps)}')
print('peak p50/p75/p90/p99', [peaks[int(len(peaks)*q)] for q in (.5,.75,.9,.99)])
print('first-request base p50', sorted(c[0] for c in sess)[len(sess)//2])
