# Replays the owner's sessions under two prompt-cache lifetimes. Each request is
# (context tokens, time). A request within the lifetime of the previous one reads
# the previous context and writes the growth; after the lifetime it writes the
# whole context again. Prices are multiples of base input. Handoffs are ignored.
import json, glob, os, datetime as dt
def ts(s):
    if isinstance(s, (int, float)): return s / (1000 if s > 1e11 else 1)
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
def pi_sessions():
    out = []
    for p in glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True):
        c = []
        for l in open(p, errors='ignore'):
            try: e = json.loads(l)
            except: continue
            m = e.get('message') or {}
            u = m.get('usage') if m.get('role') == 'assistant' else None
            t = e.get('timestamp') or m.get('timestamp')
            if u and t:
                v = (u.get('input') or 0) + (u.get('cacheRead') or 0) + (u.get('cacheWrite') or 0)
                if v: c.append((v, ts(t)))
        if len(c) > 1: out.append(c)
    return out
def cc_sessions():
    out = []
    for p in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
        if '/subagents/' in p: continue
        c, seen = [], set()
        for l in open(p, errors='ignore'):
            try: e = json.loads(l)
            except: continue
            if e.get('type') != 'assistant' or e.get('isSidechain'): continue
            m = e.get('message') or {}
            if m.get('id') in seen or not e.get('timestamp'): continue
            seen.add(m.get('id')); u = m.get('usage') or {}
            v = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
            if v: c.append((v, ts(e['timestamp'])))
        if len(c) > 1: out.append(sorted(c, key=lambda x: x[1]))
    return out
READ = {'opus-5.5': 0.05, 'sonnet-5': 0.10}
POLICY = {'5m': (300, 1.25), '1h': (3600, 2.0)}
def cost(s, life, w, r):
    total = s[0][0] * w
    for (a, ta), (b, tb) in zip(s, s[1:]):
        total += (a * r + max(0, b - a) * w) if tb - ta <= life else b * w
    return total
if __name__ == '__main__':
    for src, sess in {'pi': pi_sessions(), 'cc': cc_sessions()}.items():
        gaps = [tb - ta for s in sess for (_, ta), (_, tb) in zip(s, s[1:])]
        n = len(gaps)
        print(f'== {src}: {len(sess)} sessions, {n} request gaps; '
              f'>5m {sum(g > 300 for g in gaps) / n:.1%}, 5m-1h {sum(300 < g <= 3600 for g in gaps) / n:.1%}, >1h {sum(g > 3600 for g in gaps) / n:.1%}')
        for m, r in READ.items():
            c = {k: sum(cost(s, *p, r) for s in sess) for k, p in POLICY.items()}
            per = [cost(s, *POLICY['1h'], r) / cost(s, *POLICY['5m'], r) for s in sess]
            per.sort()
            print(f'  {m}: 1h/5m total {c["1h"] / c["5m"]:.3f}; per-session p10 {per[len(per)//10]:.3f} p50 {per[len(per)//2]:.3f} p90 {per[9*len(per)//10]:.3f}; 1h cheaper in {sum(x < 1 for x in per) / len(per):.0%} of sessions')
