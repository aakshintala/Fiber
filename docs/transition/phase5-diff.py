#!/usr/bin/env python3
"""Join a Phase 5 census against the fork-point baseline.

  python3 docs/transition/phase5-diff.py flight-logs/census/results.tsv [platform]

Buckets, in the order they matter:

  REGRESSED   baseline pass -> now fail.            The repair surface.
  DISAPPEARED baseline case with no match now, in a file that still exists.
              Deleted on purpose, renamed, or lost silently. Only the third is
              a defect, and nothing else in the transition can detect it.
  NEWLY-SKIP  baseline pass -> now skip. A test that stopped running is not a
              test that passed.
  NEW         a case with no baseline row. Added since the fork.
  EXPECTED    baseline cases in the five files deleted with a named commit.

Case names are normalized for the identity cutover before matching, so
"fx ask ..." and "fiber ask ..." are the same case.
"""
import csv, re, sys, collections, os

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, 'phase5-baseline.tsv')

# Deleted with a named commit; see phase5-baseline.md.
DELETED_FILES = {
    'acp.test.ts': 'ACP deletion, Phase 1 Slice 23',
    'web-search-fake-gateway.test.ts': '764533fa, replaced by web-search-fake-codex.test.ts',
    'session-recovery.test.ts': 'ACP deletion; Phase 5 rebuilds the 16 cases',
    'oauth-keychain-migration.test.ts': 'e0a5625c, dormant keychain paths',
    'web-search-live.test.ts': 'b286b323, Gateway-backend live search',
}

def norm(name: str) -> str:
    """Collapse the Phase 2 identity cutover so a rename is not a disappearance."""
    s = re.sub(r'\s+', ' ', name.strip())
    s = re.sub(r'\bfx\b', 'fiber', s)
    s = re.sub(r'\bFx\b', 'Fiber', s)
    s = re.sub(r'\.fx\b', '.fiber', s)
    return s

def baseline_status(raw: str, platform: str) -> str:
    if '=' not in raw:
        return raw
    for part in raw.split(';'):
        p, _, v = part.partition('=')
        if p == platform:
            return v
    return 'absent'

def main() -> int:
    census_path = sys.argv[1]
    platform = sys.argv[2] if len(sys.argv) > 2 else 'macos-aarch64'

    base = {}
    for r in csv.DictReader(open(BASELINE), delimiter='\t'):
        base[norm(r['case'])] = (baseline_status(r['status'], platform), r['file'])

    now = {}
    for r in csv.DictReader(open(census_path), delimiter='\t'):
        now[norm(r['case'])] = (r['status'], r['file'])

    buckets = collections.defaultdict(list)
    for key, (bstat, bfile) in sorted(base.items()):
        if key in now:
            nstat, nfile = now[key]
            if bstat == 'pass' and nstat == 'fail':
                buckets['REGRESSED'].append((nfile, key))
            elif bstat == 'pass' and nstat == 'skip':
                buckets['NEWLY-SKIP'].append((nfile, key))
        elif bfile in DELETED_FILES:
            buckets['EXPECTED'].append((bfile, key))
        elif bstat != 'absent':
            buckets['DISAPPEARED'].append((bfile, key))
    for key, (nstat, nfile) in sorted(now.items()):
        if key not in base:
            buckets['NEW'].append((nfile, key))

    order = ['REGRESSED', 'DISAPPEARED', 'NEWLY-SKIP', 'NEW', 'EXPECTED']
    print(f'# Phase 5 baseline diff ({platform})\n')
    print('| bucket | count |')
    print('| --- | --- |')
    for b in order:
        print(f'| {b} | {len(buckets[b])} |')
    for b in order:
        rows = buckets[b]
        if not rows:
            continue
        print(f'\n## {b} ({len(rows)})\n')
        if b == 'EXPECTED':
            per = collections.Counter(f for f, _ in rows)
            for f, c in sorted(per.items()):
                print(f'- {c:4d}  {f} — {DELETED_FILES[f]}')
            continue
        for f, name in rows:
            print(f'- `{f}` — {name}')

    # Exit non-zero when the run needs a human: this is also the unattended guard.
    return 1 if (buckets['REGRESSED'] or buckets['DISAPPEARED'] or buckets['NEWLY-SKIP']) else 0

if __name__ == '__main__':
    sys.exit(main())
