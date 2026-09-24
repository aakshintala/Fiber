# Per-session write/edit calls, distinct files written and steps with tool calls,
# over the owner's pi sessions (~/.pi/agent/sessions).
import json, glob, os
files = glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True)
per, steps, distinct = [], [], []
for f in files:
    w = s = 0; paths = set()
    for l in open(f):
        try: e = json.loads(l)
        except ValueError: continue
        if e.get('type') != 'message': continue
        m = e['message']
        if m.get('role') != 'assistant': continue
        calls = [c for c in m.get('content', []) if isinstance(c, dict) and c.get('type') == 'toolCall']
        if calls: s += 1
        for c in calls:
            if c.get('name') in ('write', 'edit'):
                w += 1
                a = c.get('arguments') or {}
                p = a.get('path') or a.get('file_path')
                if p: paths.add(p)
    per.append(w); steps.append(s); distinct.append(len(paths))
def pct(a, q): a = sorted(a); return a[min(len(a) - 1, int(len(a) * q))]
for name, a in [('write/edit calls per session', per), ('steps with tool calls per session', steps), ('distinct files written per session', distinct)]:
    print(name, 'p50', pct(a, .5), 'p90', pct(a, .9), 'p99', pct(a, .99), 'max', max(a))
