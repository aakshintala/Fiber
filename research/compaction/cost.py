# Cost of compacting at threshold T versus continuing, replayed on real sessions.
# Prices in units of the model's base input price. Growth per request is the
# positive delta between consecutive requests' context sizes.
import json, glob, os, statistics as st
def pi_sessions():
    out = []
    for p in glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True):
        c = []
        for l in open(p, errors='ignore'):
            try: m = json.loads(l).get('message') or {}
            except: continue
            u = m.get('usage') if m.get('role') == 'assistant' else None
            if u:
                v = (u.get('input') or 0) + (u.get('cacheRead') or 0) + (u.get('cacheWrite') or 0)
                if v: c.append(v)
        if c: out.append(c)
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
            if m.get('id') in seen: continue
            seen.add(m.get('id')); u = m.get('usage') or {}
            v = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
            if v: c.append(v)
        if c: out.append(c)
    return out
# name: (cache read, cache write, output, long-context threshold, long multiplier in, out)
PRICES = {
  'opus-5.5':  (0.05, 1.25, 5.0, None, 1, 1),     # platform.claude.com pricing, 2026-09-24
  'sonnet-5':  (0.10, 1.25, 5.0, None, 1, 1),
  'gpt-6-sol': (0.10, 1.00, 5.0, 272_000, 2, 1.5), # developers.openai.com; 272k tier from research/compaction/thresholds.md
}
N = 2000          # note size, above measured pi summary p50 (1,566)
OUT_PER_STEP = 0  # output identical across policies; excluded
def cost(ctxs, T, W, price):
    r, w, o, L, mi, mo = price
    k = lambda c: mi if (L and c > L) else 1
    base = ctxs[0]; cur = base; total = base * w; comps = 0
    for a, b in zip(ctxs, ctxs[1:]):
        d = max(0, b - a)
        if T and cur + d >= T:
            # note request: read everything cached, write the note
            total += cur * r * k(cur) + N * o * (mo if (L and cur > L) else 1)
            comps += 1
            cur = base + N + W
            total += base * r + (N + W) * w          # system+tools prefix stays cached
        total += cur * r * k(cur + d) + d * w * k(cur + d)
        cur += d
    return total, comps
data = {'pi': pi_sessions(), 'cc': cc_sessions()}
for src, sess in data.items():
    print(f'== {src}: {len(sess)} sessions')
    for pname, price in PRICES.items():
        for W in (0, 30_000, 60_000):
            base_tot = sum(cost(s, None, W, price)[0] for s in sess)
            row = []
            for T in (100_000, 150_000, 200_000, 300_000, 400_000, 600_000):
                tot = sum(cost(s, T, W, price)[0] for s in sess)
                row.append(f'{T//1000}k:{tot/base_tot:.3f}')
            print(f'  {pname:10} W={W//1000:>2}k  ' + '  '.join(row))
# Break-even: steps after compaction needed to recover its cost, and how many
# steps sessions actually ran after first reaching C.
print('== break-even steps S*(C) vs median steps remaining after first reaching C')
for src, sess in data.items():
    for C in (100_000, 150_000, 200_000, 300_000, 400_000):
        rem = [len(s) - next(i for i, v in enumerate(s) if v >= C) for s in sess if max(s) >= C]
        med = st.median(rem) if rem else None
        be = []
        for pname, (r, w, o, L, mi, mo) in PRICES.items():
            kk = mi if (L and C > L) else 1
            B = st.median(x[0] for x in sess); W = 30_000
            num = C * r * kk + N * o + (N + W) * w
            den = (C - B - N - W) * r * kk
            be.append(f'{pname}:{num/den:.1f}')
        print(f'  {src} C={C//1000}k sessions={len(rem):3} median steps remaining={med}  S*(W=30k): ' + ' '.join(be))
