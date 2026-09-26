# File tool usage: pi and Claude Code

Measured 2026-09-26. One process, one pass over each session log.

pi sessions scanned: 689

Claude Code main sessions scanned: 233

Claude Code subagent sessions scanned: 149


'new to session' and 'never read earlier in session' are proxies from in-session tool-call order (what the model itself read/wrote/edited earlier in that log), not actual file mtimes.


## pi

sessions: 689 (645 used any tool)

| tool | calls | sessions using | share of sessions |
|---|---|---|---|
| bash | 27823 | 599 | 92.9% |
| read | 5518 | 563 | 87.3% |
| edit | 3837 | 292 | 45.3% |
| write | 433 | 164 | 25.4% |
| ls | 158 | 56 | 8.7% |

read: 5518 calls. offset only 0.8%, limit only 2.7%, both 61.1%, neither 35.3%
limit values: p50=100 p90=330 max=2000 (n=3453)
path kind: image 0.2%, pdf 0.0%, binary 0.0%, text 99.8%
read errors: 55/5518 (1.00%)
  - file does not exist: 44
  - path is a directory: 6
  - offset beyond eof: 5

edit-family calls: 3837, errors: 255 (6.65%)
  - no match: 132
  - multiple matches: 72
  - no-op replacement: 22
  - edits overlap: 19
  - bad input: 8
  - file not found: 2
blocks per call (pi 'edits'/CC MultiEdit 'edits'): n=3837, >1 block: 32.5%, p50=1 p90=4 max=27
edit targets never read earlier in session: 31.4% (n=3837)

write calls: 433. size bytes: p50=2263 p90=12371 p99=35687 max=66867
write target new to session: 80.1%, overwrite of path seen earlier: 19.9% (n=432)
write targets never read earlier in session: 86.1% (n=432)

CRLF in edit old/new text: 0.00% (n=7223)
CRLF in write content: 0.00% (n=433)

shell calls: 27823. first word ls/find/tree: 2.1%
dedicated 'ls' tool calls (pi only): 158

## Claude Code (main)

sessions: 233 (189 used any tool)

| tool | calls | sessions using | share of sessions |
|---|---|---|---|
| Bash | 13991 | 184 | 97.4% |
| Read | 329 | 91 | 48.1% |
| Edit | 284 | 43 | 22.8% |
| Write | 275 | 92 | 48.7% |

read: 329 calls. offset only 0.6%, limit only 3.0%, both 41.9%, neither 54.4%
limit values: p50=30 p90=150 max=890 (n=148)
path kind: image 1.2%, pdf 0.0%, binary 0.0%, text 98.8%
read errors: 2/329 (0.61%)
  - too large: 1
  - bad input: 1

edit-family calls: 284, errors: 18 (6.34%)
  - symlink target: 9
  - user rejected/denied: 4
  - file not read: 4
  - bad input: 1
replace_all share (CC Edit only): 0.0% (n=284)
edit targets never read earlier in session: 31.1% (n=283)

write calls: 275. size bytes: p50=4304 p90=10638 p99=33272 max=46172
write target new to session: 92.4%, overwrite of path seen earlier: 7.6% (n=275)
write targets never read earlier in session: 93.5% (n=275)

CRLF in edit old/new text: 0.00% (n=284)
CRLF in write content: 0.00% (n=275)

shell calls: 13991. first word ls/find/tree: 2.3%

## Claude Code (subagents)

sessions: 149 (149 used any tool)

| tool | calls | sessions using | share of sessions |
|---|---|---|---|
| Bash | 6938 | 146 | 98.0% |
| Read | 445 | 85 | 57.0% |
| Edit | 221 | 21 | 14.1% |
| Write | 175 | 61 | 40.9% |

read: 445 calls. offset only 1.6%, limit only 3.8%, both 33.7%, neither 60.9%
limit values: p50=60 p90=190 max=650 (n=167)
path kind: image 0.0%, pdf 0.0%, binary 0.0%, text 100.0%
read errors: 3/445 (0.67%)
  - file does not exist: 2
  - bad input: 1

edit-family calls: 221, errors: 24 (10.86%)
  - file not read: 22
  - no match: 1
  - other: 1
replace_all share (CC Edit only): 0.0% (n=221)
edit targets never read earlier in session: 18.1% (n=221)

write calls: 175. size bytes: p50=4336 p90=15061 p99=36445 max=42229
write target new to session: 84.6%, overwrite of path seen earlier: 15.4% (n=175)
write targets never read earlier in session: 92.6% (n=175)

CRLF in edit old/new text: 0.00% (n=221)
CRLF in write content: 0.00% (n=175)

shell calls: 6938. first word ls/find/tree: 1.9%
