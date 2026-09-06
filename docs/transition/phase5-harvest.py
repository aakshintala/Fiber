import re, collections, sys

LOG = 'fx-575-fullci.log'
SUPPORTED = ['macos-aarch64', 'linux-x86_64', 'linux-aarch64']

job_re   = re.compile(r'^(E2E \(ReleaseSafe, ([a-z0-9_-]+), shard \d/4\))\t[^\t]*\t\S+ (.*)$')
group_re = re.compile(r'^##\[group\](\S+\.test\.ts):$')
case_re  = re.compile(r'^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$')

cur_file = {}                     # job -> current .test.ts
results  = collections.defaultdict(dict)   # platform -> (file, case) -> status
retries  = []
shard_of = {}                     # (platform, file) -> shard label

for line in open(LOG, errors='replace'):
    m = job_re.match(line.rstrip('\n'))
    if not m:
        continue
    job, plat, rest = m.groups()
    rest = rest.replace('\x1b[0m', '').rstrip()
    g = group_re.match(rest)
    if g:
        cur_file[job] = g.group(1)
        shard_of[(plat, g.group(1))] = job.split('shard ')[1].rstrip(')')
        continue
    if rest.startswith('Retrying failed E2E file after resetting tmux: ') and '"$test_file"' not in rest:
        retries.append((plat, rest.split(': ')[-1]))
        continue
    c = case_re.match(rest)
    if c:
        status, name = c.groups()
        # last write wins, so a retry's pass supersedes the original fail
        results[plat][(cur_file.get(job, '?'), name)] = status

for p in sorted(results):
    c = collections.Counter(results[p].values())
    print(f'{p:16s} {dict(c)} unique cases={len(results[p])}', file=sys.stderr)
print('retries:', retries, file=sys.stderr)

# Union across the three supported platforms.
union = {}
for p in SUPPORTED:
    for k, v in results[p].items():
        union.setdefault(k, {})[p] = v

rows = []
for (f, name) in sorted(union):
    per = union[(f, name)]
    statuses = {per.get(p, 'absent') for p in SUPPORTED}
    status = statuses.pop() if len(statuses) == 1 else \
             ';'.join(f'{p}={per.get(p, "absent")}' for p in SUPPORTED)
    plats = 'all' if all(p in per for p in SUPPORTED) else \
            ','.join(p for p in SUPPORTED if p in per)
    rows.append((status, plats, f, name))

with open('phase5-baseline.tsv', 'w') as out:
    out.write('status\tplatforms\tfile\tcase\n')
    for r in rows:
        out.write('\t'.join(r) + '\n')

byfile = collections.Counter()
for status, plats, f, name in rows:
    byfile[f] += 1
print('files:', len(byfile), 'union cases:', len(rows), file=sys.stderr)
divergent = [r for r in rows if '=' in r[0]]
print('divergent across supported platforms:', len(divergent), file=sys.stderr)
for r in divergent[:15]:
    print('   ', r, file=sys.stderr)
