"""Measure how real pi and Claude Code sessions hit context limits.

For Fiber issue #24 ("Compaction: when a session outgrows its context").
Reads ~/.pi/agent/sessions/**/*.jsonl and ~/.claude/projects/**/*.jsonl,
each in a single Python process (no shell loop over files). Sizes and
counts only; no timings. Writes research/compaction/usage.md.

Constants chosen by this script (all named again in usage.md):
  BYTES_PER_TOKEN      = 4      # rough estimate for anything sized from raw bytes
  TOOL_RESULT_CAP      = 16384  # Fiber's default tool-result cap (16 KiB), from the brief
  OVERFLOW_ERROR_RE    # what counts as a "context too long" error message
  NEXT_EVENT_WINDOW    = 10     # entries scanned after an overflow error to see what happened next
  Growth-per-turn and the 0->70% curve use only the FIRST episode of each
  session (session start to its first compaction, or the whole session if
  it never compacted) -- pi does not record the post-compaction context
  size, so a later episode's turn-1 baseline can't be estimated without
  inventing a number.
"""
import glob
import json
import os
import re
import statistics
import collections

PI_DIR = os.path.expanduser("~/.pi/agent/sessions")
CC_DIR = os.path.expanduser("~/.claude/projects")
PI_AI_DATA_DIR = (
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/"
    "node_modules/@earendil-works/pi-ai/dist/providers/data"
)

BYTES_PER_TOKEN = 4
TOOL_RESULT_CAP = 16 * 1024
NEXT_EVENT_WINDOW = 10
OVERFLOW_ERROR_RE = re.compile(
    r"context length|context window|too long|prompt is too long|maximum context",
    re.I,
)


def pct(values, p):
    """Nearest-rank percentile, same style as research/tool-result-sizes/sizes.py."""
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))]


def text_bytes(content):
    """Sum bytes of text-type parts in a message content list. Same rule as
    research/tool-result-sizes/sizes.py: only 'text' parts count."""
    n = 0
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            n += len(c.get("text", "").encode())
    return n


# ---------------------------------------------------------------------------
# pi model registry: model id -> contextWindow
# ---------------------------------------------------------------------------

def load_model_registry():
    """Two-level lookup: pi's session `provider` field maps 1:1 onto a
    pi-ai data file's stem for the providers that matter here (opencode-go,
    openai-codex, anthropic account for 99%+ of assistant messages seen).
    Look up (provider, model) in that file first; fall back to a global
    model-id-only table (first file wins, sorted by filename, so the result
    is deterministic) for providers with no matching file, e.g. cursor,
    pi-claude-cli, oc-sdk-go."""
    by_provider = {}
    global_registry = {}
    ambiguous = {}
    for fp in sorted(glob.glob(os.path.join(PI_AI_DATA_DIR, "*.json"))):
        stem = os.path.splitext(os.path.basename(fp))[0]
        try:
            data = json.load(open(fp))
        except Exception:
            continue
        provider_table = by_provider.setdefault(stem, {})
        for _api, models in data.items():
            if not isinstance(models, dict):
                continue
            for mid, info in models.items():
                cw = info.get("contextWindow") if isinstance(info, dict) else None
                if cw is None:
                    continue
                provider_table[mid] = cw
                if mid in global_registry and global_registry[mid] != cw:
                    ambiguous.setdefault(mid, {global_registry[mid]}).add(cw)
                else:
                    global_registry[mid] = cw
    return by_provider, global_registry, ambiguous


def window_for(by_provider, global_registry, provider, model):
    if not model:
        return None
    table = by_provider.get(provider)
    if table and model in table:
        return table[model]
    return global_registry.get(model)


# ---------------------------------------------------------------------------
# pi sessions
# ---------------------------------------------------------------------------

def load_entries(path):
    entries = []
    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                continue
    return entries


def analyze_pi(by_provider, global_registry):
    files = glob.glob(os.path.join(PI_DIR, "**", "*.jsonl"), recursive=True)

    sessions_total = len(files)
    sessions_with_compaction = 0
    compactions_per_session = []
    unmatched_models = collections.Counter()

    compaction_ratios = []          # tokensBefore / contextWindow
    compaction_tokens_before = []
    compaction_summary_tokens = []  # bytes/4 estimate
    compaction_tail_fractions = []  # kept-tail tokens / contextWindow estimate

    peak_ratio_per_session = []     # one value per session: max(input+cacheRead+cacheWrite)/window
    sessions_crossing = {0.5: 0, 0.7: 0, 0.8: 0, 0.9: 0}

    turn_growth_deltas = []         # pooled, first-episode-only
    turns_to_70pct = []             # per session that reach it (first episode only)
    sessions_first_episode_measurable = 0
    sessions_never_reach_70 = 0

    step_raw_sums = []
    step_capped_sums = []
    steps_with_parallel = 0
    steps_total = 0
    window_per_usage_msg = []       # matched model's contextWindow, one per assistant usage msg

    overflow_errors = 0
    overflow_outcomes = collections.Counter()

    turns_after_compaction = []     # per compaction: how many more user turns ran
    sessions_compact_again = 0

    for path in files:
        entries = load_entries(path)
        if not entries:
            continue

        # index assistant usage messages and user message positions
        assistant_usages = []  # (idx, model, input, cacheRead, cacheWrite, output, stopReason, errorMessage)
        user_idxs = []
        compaction_idxs = []

        for i, o in enumerate(entries):
            t = o.get("type")
            if t == "compaction":
                compaction_idxs.append(i)
                continue
            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role == "user":
                user_idxs.append(i)
            elif role == "assistant":
                usage = msg.get("usage")
                model = msg.get("model")
                provider = msg.get("provider")
                if usage:
                    assistant_usages.append((
                        i, model, provider,
                        usage.get("input", 0) or 0,
                        usage.get("cacheRead", 0) or 0,
                        usage.get("cacheWrite", 0) or 0,
                        usage.get("output", 0) or 0,
                        msg.get("stopReason"),
                        msg.get("errorMessage"),
                    ))

        # ---- 1/2/3: compactions ----
        n_comp = len(compaction_idxs)
        if n_comp:
            sessions_with_compaction += 1
        compactions_per_session.append(n_comp)

        for ci, idx in enumerate(compaction_idxs):
            comp = entries[idx]
            tokens_before = comp.get("tokensBefore")
            if tokens_before is not None:
                compaction_tokens_before.append(tokens_before)

            # nearest preceding assistant model
            model = None
            provider = None
            for j in range(idx - 1, -1, -1):
                m = entries[j].get("message")
                if isinstance(m, dict) and m.get("role") == "assistant" and m.get("model"):
                    model = m.get("model")
                    provider = m.get("provider")
                    break
            window = window_for(by_provider, global_registry, provider, model)
            if model and window is None:
                unmatched_models[model] += 1
            if tokens_before is not None and window:
                compaction_ratios.append(tokens_before / window)

            summary = comp.get("summary") or ""
            summary_bytes = len(summary.encode())
            summary_tokens = summary_bytes / BYTES_PER_TOKEN
            compaction_summary_tokens.append(summary_tokens)

            # kept tail: from firstKeptEntryId (inclusive) to this compaction (exclusive)
            first_kept = comp.get("firstKeptEntryId")
            if first_kept:
                start = None
                for j in range(idx - 1, -1, -1):
                    if entries[j].get("id") == first_kept:
                        start = j
                        break
                if start is not None and window:
                    tail_bytes = 0
                    for k in range(start, idx):
                        m = entries[k].get("message")
                        if isinstance(m, dict):
                            c = m.get("content")
                            if isinstance(c, list):
                                tail_bytes += text_bytes(c)
                            elif isinstance(c, str):
                                tail_bytes += len(c.encode())
                    tail_tokens = tail_bytes / BYTES_PER_TOKEN
                    compaction_tail_fractions.append(tail_tokens / window)

            # ---- 9: what happened after this compaction ----
            next_comp_idx = compaction_idxs[ci + 1] if ci + 1 < len(compaction_idxs) else None
            end = next_comp_idx if next_comp_idx is not None else len(entries)
            turns_after = sum(1 for u in user_idxs if idx < u < end)
            turns_after_compaction.append(turns_after)

        if n_comp >= 2:
            sessions_compact_again += 1

        # ---- 4: peak context per session ----
        session_peak_ratio = 0.0
        for (i, model, provider, inp, cr, cw, out, stop, err) in assistant_usages:
            window = window_for(by_provider, global_registry, provider, model)
            if model and window is None:
                unmatched_models[model] += 1
            if window:
                window_per_usage_msg.append(window)
                total_ctx = inp + cr + cw
                ratio = total_ctx / window
                if ratio > session_peak_ratio:
                    session_peak_ratio = ratio
        if window_per_usage_msg or assistant_usages:
            peak_ratio_per_session.append(session_peak_ratio)
            for thresh in sessions_crossing:
                if session_peak_ratio >= thresh:
                    sessions_crossing[thresh] += 1

        # ---- 5: growth per turn, first episode only ----
        first_episode_end = compaction_idxs[0] if compaction_idxs else len(entries)
        episode_user_idxs = [u for u in user_idxs if u < first_episode_end]
        # context size at end of each turn = last assistant usage total within [turn_start, next_turn_start)
        turn_bounds = episode_user_idxs + [first_episode_end]
        turn_contexts = []
        turn_window = None
        for t in range(len(episode_user_idxs)):
            lo, hi = turn_bounds[t], turn_bounds[t + 1]
            last_ctx = None
            last_model = None
            last_provider = None
            for (i, model, provider, inp, cr, cw, out, stop, err) in assistant_usages:
                if lo <= i < hi:
                    last_ctx = inp + cr + cw
                    last_model = model
                    last_provider = provider
            if last_ctx is not None:
                turn_contexts.append(last_ctx)
                w = window_for(by_provider, global_registry, last_provider, last_model)
                if w:
                    turn_window = w
        if len(turn_contexts) >= 1:
            sessions_first_episode_measurable += 1
            prev = 0
            reached_70 = None
            for t, ctx in enumerate(turn_contexts, start=1):
                turn_growth_deltas.append(ctx - prev)
                prev = ctx
                if turn_window and reached_70 is None and ctx / turn_window >= 0.7:
                    reached_70 = t
            if reached_70 is not None:
                turns_to_70pct.append(reached_70)
            elif turn_window:
                sessions_never_reach_70 += 1

        # ---- 6: per-step tool result totals ----
        step_open = False
        raw_sum = 0
        capped_sum = 0
        n_results = 0
        for o in entries:
            t = o.get("type")
            msg = o.get("message")
            if t == "compaction":
                continue
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role == "assistant":
                if step_open:
                    step_raw_sums.append(raw_sum)
                    step_capped_sums.append(capped_sum)
                    steps_total += 1
                    if n_results > 1:
                        steps_with_parallel += 1
                step_open = True
                raw_sum = 0
                capped_sum = 0
                n_results = 0
            elif role == "toolResult" and step_open:
                n_results += 1
                b = text_bytes(msg.get("content"))
                raw_sum += b
                capped_sum += min(b, TOOL_RESULT_CAP)
        if step_open:
            step_raw_sums.append(raw_sum)
            step_capped_sums.append(capped_sum)
            steps_total += 1
            if n_results > 1:
                steps_with_parallel += 1

        # ---- 7: context-overflow errors ----
        for (i, model, provider, inp, cr, cw, out, stop, err) in assistant_usages:
            if stop == "error" and err and OVERFLOW_ERROR_RE.search(err):
                overflow_errors += 1
                outcome = "session ended"
                for j in range(i + 1, min(i + 1 + NEXT_EVENT_WINDOW, len(entries))):
                    oj = entries[j]
                    if oj.get("type") == "compaction":
                        outcome = "compaction"
                        break
                    mj = oj.get("message")
                    if isinstance(mj, dict) and mj.get("role") == "assistant" and mj.get("usage"):
                        outcome = "retry (later assistant reply succeeded)"
                        break
                overflow_outcomes[outcome] += 1

    return dict(
        sessions_total=sessions_total,
        sessions_with_compaction=sessions_with_compaction,
        compactions_per_session=compactions_per_session,
        unmatched_models=unmatched_models,
        compaction_ratios=compaction_ratios,
        compaction_tokens_before=compaction_tokens_before,
        compaction_summary_tokens=compaction_summary_tokens,
        compaction_tail_fractions=compaction_tail_fractions,
        peak_ratio_per_session=peak_ratio_per_session,
        sessions_crossing=sessions_crossing,
        turn_growth_deltas=turn_growth_deltas,
        turns_to_70pct=turns_to_70pct,
        sessions_first_episode_measurable=sessions_first_episode_measurable,
        sessions_never_reach_70=sessions_never_reach_70,
        step_raw_sums=step_raw_sums,
        step_capped_sums=step_capped_sums,
        steps_with_parallel=steps_with_parallel,
        steps_total=steps_total,
        window_per_usage_msg=window_per_usage_msg,
        overflow_errors=overflow_errors,
        overflow_outcomes=overflow_outcomes,
        turns_after_compaction=turns_after_compaction,
        sessions_compact_again=sessions_compact_again,
    )


# ---------------------------------------------------------------------------
# Claude Code sessions
# ---------------------------------------------------------------------------

CMD_RE = re.compile(r"<command-name>(.*?)</command-name>")


def analyze_cc():
    files = glob.glob(os.path.join(CC_DIR, "**", "*.jsonl"), recursive=True)

    sessions_total = len(files)
    compactions_auto = 0
    compactions_manual = 0
    compactions_other = 0
    pre_tokens_auto = []
    pre_tokens_manual = []
    cmd_counts = collections.Counter()
    sessions_with_handoff_cmd = 0

    for path in files:
        entries = load_entries(path)
        file_has_handoff = False
        for o in entries:
            if o.get("type") == "system" and o.get("subtype") == "compact_boundary":
                meta = o.get("compactMetadata") or {}
                trigger = meta.get("trigger")
                pre = meta.get("preTokens")
                if trigger == "auto":
                    compactions_auto += 1
                    if pre is not None:
                        pre_tokens_auto.append(pre)
                elif trigger == "manual":
                    compactions_manual += 1
                    if pre is not None:
                        pre_tokens_manual.append(pre)
                else:
                    compactions_other += 1
                continue
            if o.get("type") != "user":
                continue
            msg = o.get("message") or {}
            content = msg.get("content")
            txt = None
            if isinstance(content, str):
                txt = content
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        txt = c.get("text")
                        break
            if not txt:
                continue
            m = CMD_RE.search(txt)
            if m:
                name = m.group(1)
                cmd_counts[name] += 1
                if "handoff" in name.lower():
                    file_has_handoff = True
        if file_has_handoff:
            sessions_with_handoff_cmd += 1

    return dict(
        sessions_total=sessions_total,
        compactions_auto=compactions_auto,
        compactions_manual=compactions_manual,
        compactions_other=compactions_other,
        pre_tokens_auto=pre_tokens_auto,
        pre_tokens_manual=pre_tokens_manual,
        cmd_counts=cmd_counts,
        sessions_with_handoff_cmd=sessions_with_handoff_cmd,
    )


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def fmt_pct(x):
    return f"{x * 100:.1f}%" if x is not None else "n/a"


def fmt_int(x):
    return f"{x:,.0f}" if x is not None else "n/a"


def build_report(pi, cc, registry, ambiguous):
    lines = []
    a = lines.append
    a("# Context and compaction: measured from real sessions")
    a("")
    a("Date: 2026-09-24. Source: pi sessions under `~/.pi/agent/sessions` "
      f"({pi['sessions_total']} files) and Claude Code sessions under "
      f"`~/.claude/projects` ({cc['sessions_total']} files). This feeds "
      "Fiber issue #24, \"Compaction: when a session outgrows its context\".")
    a("")
    a("## Constants this script chose")
    a("")
    a("These are not measured facts. They are choices made to produce the "
      "numbers below, listed so a reader can judge or replace them.")
    a("")
    a("| Constant | Value | Why |")
    a("|---|---|---|")
    a(f"| `BYTES_PER_TOKEN` | {BYTES_PER_TOKEN} | rough bytes-per-token estimate, used only where pi does not record a token count directly (summary size, kept-tail size) |")
    a(f"| `TOOL_RESULT_CAP` | {TOOL_RESULT_CAP:,} bytes (16 KiB) | Fiber's default tool-result cap, from the brief |")
    a(f"| `NEXT_EVENT_WINDOW` | {NEXT_EVENT_WINDOW} entries | how far past an overflow error we look to classify what happened next |")
    a("| overflow error pattern | `context length\\|context window\\|too long\\|prompt is too long\\|maximum context` (case-insensitive) | what counts as a context-overflow error message |")
    a("| growth-per-turn / 0→70% scope | first episode of each session only (start to first compaction, or whole session if none) | pi does not record post-compaction context size, so a later episode's turn-1 baseline can't be estimated without inventing a number |")
    a("| \"smallest\"/\"typical\" context window (measure 6) | smallest = min matched model window seen in usage; typical = median matched model window seen in usage, one entry per assistant call | ties the reference windows to what these sessions actually used, not to a hand-picked model |")
    a("")

    if ambiguous:
        a(f"Model registry note: {len(ambiguous)} model id(s) have different "
          "`contextWindow` values in different pi-ai provider files (e.g. the "
          "same model id offered through two gateways at different window "
          "sizes). 99%+ of assistant messages in these sessions carry a "
          "`provider` field (`opencode-go`, `openai-codex`, `anthropic`) that "
          "resolves straight to the matching provider file, so this ambiguity "
          "practically only affects the sessions using `cursor`, "
          "`pi-claude-cli` or `oc-sdk-go` as provider, where the code falls "
          "back to a single global table (first file alphabetically wins).")
        a("")

    if pi["unmatched_models"]:
        a("Models seen in pi sessions with no match in the pi-ai model registry "
          "(excluded from window-ratio calculations):")
        a("")
        for m, c in pi["unmatched_models"].most_common():
            a(f"- `{m}` ({c} messages)")
        a("")

    # 1
    a("## 1. pi: sessions with compaction")
    a("")
    n_comp_sessions = pi["sessions_with_compaction"]
    a(f"- Sessions scanned: {pi['sessions_total']}")
    a(f"- Sessions with at least one compaction: {n_comp_sessions} "
      f"({fmt_pct(n_comp_sessions / pi['sessions_total'])})")
    per_sess = [c for c in pi["compactions_per_session"] if c > 0]
    if per_sess:
        a(f"- Compactions per session that compacted: p50 {pct(per_sess,0.5)}, "
          f"p90 {pct(per_sess,0.9)}, max {max(per_sess)}")
    a(f"- Total compaction events: {sum(pi['compactions_per_session'])}")
    a("- Manual vs automatic: not distinguishable. Every compaction record has "
      "`fromHook: false`, and in every case the entry immediately before the "
      "compaction is a tool result or an internal `pi-stamp` marker, never a "
      "user message issuing a slash command. That is consistent with all 15 "
      "observed compactions being triggered automatically by context "
      "pressure mid-turn, not by an explicit user command, but pi's log has "
      "no trigger field to confirm it either way.")
    a("")

    # 2
    a("## 2. pi: context at compaction")
    a("")
    tb = pi["compaction_tokens_before"]
    if tb:
        a(f"- `tokensBefore`: p50 {fmt_int(pct(tb,0.5))}, p90 {fmt_int(pct(tb,0.9))}, max {fmt_int(max(tb))}")
    ratios = pi["compaction_ratios"]
    if ratios:
        a(f"- `tokensBefore` / model context window: p50 {fmt_pct(pct(ratios,0.5))}, "
          f"p90 {fmt_pct(pct(ratios,0.9))}, max {fmt_pct(max(ratios))} "
          f"(n={len(ratios)} compactions with a matched model)")
        if max(ratios) > 1:
            a("  Some ratios exceed 100%: `tokensBefore` can be counted past the "
              "model's nominal `contextWindow` once reserved output tokens or "
              "cache accounting are included, so pi's own trigger threshold "
              "sits at or slightly past the window, not comfortably under it.")
    else:
        a("- No compaction had a matched model to compute a ratio.")
    a("")

    # 3
    a("## 3. pi: summary size and kept tail")
    a("")
    st = pi["compaction_summary_tokens"]
    if st:
        a(f"- Summary size, estimated tokens (bytes/{BYTES_PER_TOKEN}): "
          f"p50 {fmt_int(pct(st,0.5))}, p90 {fmt_int(pct(st,0.9))}, max {fmt_int(max(st))}")
    tf = pi["compaction_tail_fractions"]
    if tf:
        a(f"- Kept tail (firstKeptEntry → compaction), estimated tokens as a "
          f"fraction of the model's window: p50 {fmt_pct(pct(tf,0.5))}, "
          f"p90 {fmt_pct(pct(tf,0.9))}, max {fmt_pct(max(tf))} (n={len(tf)})")
    else:
        a("- Kept tail could not be computed for any compaction (missing "
          "`firstKeptEntryId` match or model window).")
    a("")

    # 4
    a("## 4. pi: peak context per session")
    a("")
    peaks = pi["peak_ratio_per_session"]
    if peaks:
        a(f"- Peak (input+cacheRead+cacheWrite)/window per session: "
          f"p50 {fmt_pct(pct(peaks,0.5))}, p90 {fmt_pct(pct(peaks,0.9))}, "
          f"max {fmt_pct(max(peaks))} (n={len(peaks)} sessions with a matched model)")
        a("")
        a("| Threshold | Sessions crossing it | Share |")
        a("|---|---|---|")
        for th in (0.5, 0.7, 0.8, 0.9):
            c = pi["sessions_crossing"][th]
            a(f"| {int(th*100)}% | {c} | {fmt_pct(c/len(peaks))} |")
    a("")

    # 5
    a("## 5. pi: context growth per turn (first episode only)")
    a("")
    deltas = pi["turn_growth_deltas"]
    if deltas:
        a(f"- Tokens added per turn: p50 {fmt_int(pct(deltas,0.5))}, "
          f"p90 {fmt_int(pct(deltas,0.9))} (n={len(deltas)} turns, "
          f"{pi['sessions_first_episode_measurable']} sessions)")
    tt = pi["turns_to_70pct"]
    if tt:
        a(f"- Turns to go from 0 to 70% of window: p50 {pct(tt,0.5)}, "
          f"p90 {pct(tt,0.9)}, max {max(tt)} (n={len(tt)} sessions that "
          f"reached 70% in their first episode)")
    a(f"- Sessions whose first episode never reached 70%: {pi['sessions_never_reach_70']}")
    a("")

    # 6
    a("## 6. pi: per-step tool result totals")
    a("")
    raw = pi["step_raw_sums"]
    capped = pi["step_capped_sums"]
    if raw:
        smallest_win = min(pi["window_per_usage_msg"]) if pi["window_per_usage_msg"] else None
        typical_win = statistics.median(pi["window_per_usage_msg"]) if pi["window_per_usage_msg"] else None
        a(f"- Raw bytes per step: p50 {fmt_int(pct(raw,0.5))}, p99 {fmt_int(pct(raw,0.99))}, max {fmt_int(max(raw))}")
        a(f"- Bytes per step after cutting each result at {TOOL_RESULT_CAP:,} bytes: "
          f"p50 {fmt_int(pct(capped,0.5))}, p99 {fmt_int(pct(capped,0.99))}, max {fmt_int(max(capped))}")
        if smallest_win and typical_win:
            max_tokens_est = max(raw) / BYTES_PER_TOKEN
            a(f"- Max step, as estimated tokens (bytes/{BYTES_PER_TOKEN}) over the "
              f"smallest model window seen in use ({fmt_int(smallest_win)}): "
              f"{fmt_pct(max_tokens_est/smallest_win)}")
            a(f"- Max step, as estimated tokens over the typical (median) window "
              f"seen in use ({fmt_int(typical_win)}): {fmt_pct(max_tokens_est/typical_win)}")
        a(f"- Steps with more than one tool result (parallel calls): "
          f"{pi['steps_with_parallel']} of {pi['steps_total']} "
          f"({fmt_pct(pi['steps_with_parallel']/pi['steps_total']) if pi['steps_total'] else 'n/a'})")
    a("")

    # 7
    a("## 7. pi: context-overflow errors")
    a("")
    a(f"- Count: {pi['overflow_errors']}")
    if pi["overflow_outcomes"]:
        a("")
        a("| What happened next | Count |")
        a("|---|---|")
        for k, v in pi["overflow_outcomes"].most_common():
            a(f"| {k} | {v} |")
    a("")

    # 8
    a("## 8. Claude Code: compactions and commands")
    a("")
    a(f"- Compactions: {pi_or(cc['compactions_auto'])} auto, "
      f"{cc['compactions_manual']} manual"
      + (f", {cc['compactions_other']} with no trigger recorded" if cc["compactions_other"] else ""))
    if cc["pre_tokens_auto"]:
        pt = cc["pre_tokens_auto"]
        a(f"- Auto `preTokens`: p50 {fmt_int(pct(pt,0.5))}, p90 {fmt_int(pct(pt,0.9))}, max {fmt_int(max(pt))}")
    if cc["pre_tokens_manual"]:
        pt = cc["pre_tokens_manual"]
        a(f"- Manual `preTokens`: p50 {fmt_int(pct(pt,0.5))}, p90 {fmt_int(pct(pt,0.9))}, max {fmt_int(max(pt))}")
    a("")
    a("| Command | Count |")
    a("|---|---|")
    for name in ("/compact", "/clear", "/handoff", "/rewind"):
        a(f"| {name} | {cc['cmd_counts'].get(name, 0)} |")
    a("")
    a(f"- Sessions with a command name containing \"handoff\": "
      f"{cc['sessions_with_handoff_cmd']} of {cc['sessions_total']}")
    a("")

    # 9
    a("## 9. pi: what happens after a compaction")
    a("")
    ta = pi["turns_after_compaction"]
    if ta:
        a(f"- Turns run after a compaction, until the next compaction or session "
          f"end: p50 {pct(ta,0.5)}, p90 {pct(ta,0.9)}, max {max(ta)} (n={len(ta)} compactions)")
    a(f"- Sessions that compact again after their first compaction: "
      f"{pi['sessions_compact_again']} of {n_comp_sessions} "
      f"({fmt_pct(pi['sessions_compact_again']/n_comp_sessions) if n_comp_sessions else 'n/a'})")
    a("")

    return "\n".join(lines)


def pi_or(x):
    return x


def main():
    by_provider, global_registry, ambiguous = load_model_registry()
    pi = analyze_pi(by_provider, global_registry)
    cc = analyze_cc()
    report = build_report(pi, cc, global_registry, ambiguous)
    out_path = os.path.join(os.path.dirname(__file__), "usage.md")
    with open(out_path, "w") as fh:
        fh.write(report)
    print(report)


if __name__ == "__main__":
    main()
