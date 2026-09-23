# Tool result sizes in pi sessions

This script measures the byte length of model-facing text in each tool result
line in pi session logs under `~/.pi/agent/sessions`, and counts how many
results exceeded 4, 8, 16, 32 and 50 KiB.

Run it from the repository root:

```sh
python3 research/tool-result-sizes/sizes.py
```

Last run: 2026-09-22 on macOS, 648 sessions.

| Tool | Calls | Median | p90 | p99 | >8 KiB | >16 KiB | >50 KiB |
|---|---|---|---|---|---|---|---|
| bash | 26,829 | 799 B | 4,856 B | 18,916 B | 4.4% | 1.2% | 0.2% |
| read | 5,070 | 4,444 B | 21,797 B | 51,263 B | 27.5% | 16.8% | 2.5% |
| grep | 1,202 | 1,953 B | 17,331 B | 130,901 B | 21.4% | 10.9% | 2.2% |
| ffgrep | 1,057 | 1,769 B | 12,217 B | 49,494 B | 16.5% | 7.2% | 0.9% |
| find | 136 | 118 B | 3,007 B | 42,073 B | 7.4% | 6.6% | 0.7% |
| web_fetch | 21 | 4,734 B | 33,729 B | 51,475 B | 38.1% | 23.8% | 4.8% |
| edit | 3,567 | 110 B | 149 B | 203 B | 0% | 0% | 0% |

pi caps results at 50 KB, so the >50 KiB column counts tools that bypass pi's
cap. The read figures include reads the model itself limited with offset and
limit.
