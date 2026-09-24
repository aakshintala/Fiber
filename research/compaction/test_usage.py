"""Smallest possible check that the parsing helpers in usage.py behave.
Run: python3 research/compaction/test_usage.py
"""
from usage import pct, text_bytes, window_for, OVERFLOW_ERROR_RE

# pct: nearest-rank percentile
assert pct([1, 2, 3, 4, 5], 0.5) == 3
assert pct([], 0.5) is None
assert pct([10], 0.99) == 10

# text_bytes: only sums 'text' parts, ignores images, handles missing content
assert text_bytes([{"type": "text", "text": "abcd"}]) == 4
assert text_bytes([{"type": "text", "text": "ab"}, {"type": "image"}]) == 2
assert text_bytes(None) == 0
assert text_bytes([]) == 0

# window_for: provider-scoped lookup wins over the global fallback
by_provider = {"opencode-go": {"m1": 1000}}
global_registry = {"m1": 2000, "m2": 500}
assert window_for(by_provider, global_registry, "opencode-go", "m1") == 1000
assert window_for(by_provider, global_registry, "some-other-provider", "m1") == 2000
assert window_for(by_provider, global_registry, "opencode-go", "m2") == 500
assert window_for(by_provider, global_registry, "opencode-go", None) is None

# overflow error pattern
assert OVERFLOW_ERROR_RE.search("400: prompt is too long for this model")
assert OVERFLOW_ERROR_RE.search("maximum context length exceeded")
assert not OVERFLOW_ERROR_RE.search("connection refused")

print("ok")
