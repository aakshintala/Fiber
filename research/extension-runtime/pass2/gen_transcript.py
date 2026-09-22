#!/usr/bin/env python3
# Synthesizes a realistic Anthropic streaming completion as SSE lines, matching
# the documented wire format (message_start / content_block_delta:text_delta /
# stops / [DONE]). One `data: <json>` line per event, as the host would frame it.
# ~2000 text deltas assembling a ~30 KB assistant message.
import json, sys
words = ("the quick brown fox jumps over a lazy dog while parsing streamed "
         "tokens into an assistant message that grows across many deltas ").split()
lines = []
def data(obj): lines.append("data: " + json.dumps(obj, separators=(",", ":")))
data({"type":"message_start","message":{"id":"msg_bench","role":"assistant","model":"bench","content":[],"usage":{"input_tokens":50,"output_tokens":0}}})
data({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
N = 2000
for i in range(N):
    chunk = words[i % len(words)] + " "
    data({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":chunk}})
    if i % 200 == 0:  # occasional non-text events the extension must skip
        data({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm "}})
data({"type":"content_block_stop","index":0})
data({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":N}})
data({"type":"message_stop"})
lines.append("data: [DONE]")
out = "\n".join(lines) + "\n"
open("transcript.sse","w").write(out)
# expected assembled text, for the harness to verify against
expected = "".join((words[i % len(words)] + " ") for i in range(N))
open("expected.txt","w").write(expected)
print(f"wrote transcript.sse: {len(lines)} lines, expected {len(expected)} chars")
