import json, glob, os, re, collections

# Excludes the live session that produced this measurement (its prompt text
# contains phrases like "modified since" / "has not been read", which would
# self-contaminate the error-message counts below).
SELF = "174d9475-ef5c-449f-9723-ad5906089d4d"

IMG_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
BIN_EXT = {"zip", "exe", "bin", "db", "sqlite", "dylib", "so", "a", "o",
           "class", "jar", "wasm", "tar", "gz", "ico", "mp4", "mp3", "wav",
           "ttf", "woff", "woff2", "pyc"}


def ext_of(path):
    if not isinstance(path, str):
        return ""
    base = path.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def path_kind(path):
    e = ext_of(path)
    if e in IMG_EXT:
        return "image"
    if e == "pdf":
        return "pdf"
    if e in BIN_EXT:
        return "binary"
    return "text"


def norm_err(msg, kind):
    """Group an error string into a small bucket label."""
    if not msg:
        return "(empty)"
    m = msg
    if kind == "edit":
        if "has not been read" in m or "File has not been read" in m:
            return "file not read"
        if "modified since" in m:
            return "modified since read"
        if "overlap" in m:
            return "edits overlap"
        if re.search(r"Found \d+ occurrences|multiple occurrences|not unique|multiple times", m):
            return "multiple matches"
        if "Could not find" in m or "not found in file" in m or "String to replace not found" in m:
            return "no match"
        if "symbolic link" in m:
            return "symlink target"
        if "No changes made" in m and "identical" in m:
            return "no-op replacement"
        if "must not be empty" in m or "Validation failed" in m or "InputValidationError" in m or "could not be parsed as JSON" in m:
            return "bad input"
        if "ENOENT" in m or "Could not edit file" in m:
            return "file not found"
        if "auto mode classifier" in m or "user doesn't want to proceed" in m or "rejected" in m:
            return "user rejected/denied"
        return "other"
    if kind == "read":
        if "does not exist" in m or "ENOENT" in m:
            return "file does not exist"
        if "EISDIR" in m:
            return "path is a directory"
        if "beyond end of file" in m:
            return "offset beyond eof"
        if "exceeds maximum allowed tokens" in m or "exceeds" in m and "tokens" in m:
            return "too large"
        if "InputValidationError" in m or "could not be parsed as JSON" in m:
            return "bad input"
        if "image" in m.lower() and "not support" in m.lower():
            return "unsupported image"
        if "auto mode classifier" in m or "rejected" in m:
            return "user rejected/denied"
        return "other"
    return "other"


def pctl(v, p):
    if not v:
        return 0
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))]


def new_src():
    return {
        "n_sessions": 0,
        "n_sessions_with_any_tool": 0,
        "call_counts": collections.Counter(),
        "session_counts": collections.Counter(),
        "read_offset_only": 0, "read_limit_only": 0, "read_both": 0, "read_neither": 0,
        "read_limits": [],
        "read_path_kind": collections.Counter(),
        "read_errors": 0,
        "read_err_bucket": collections.Counter(),
        "edit_errors": 0,
        "edit_err_bucket": collections.Counter(),
        "edit_blocks": [],       # pi only: edits-per-call
        "edit_replace_all": 0,   # CC Edit only
        "edit_calls_for_replace_all": 0,
        "edit_crlf": 0, "edit_total_for_crlf": 0,
        "write_sizes": [],
        "write_crlf": 0, "write_total_for_crlf": 0,
        "write_new_vs_seen": collections.Counter(),  # 'new' / 'seen'
        "stale_edit": collections.Counter(),   # 'never read earlier' / 'read earlier'  (pi only)
        "stale_write": collections.Counter(),  # pi only
        "ls_calls": 0,
        "shell_calls": 0,
        "shell_first_word": collections.Counter(),
    }


pi = new_src()
cc_main = new_src()
cc_sub = new_src()

# ---------------- pi sessions ----------------
for f in glob.glob(os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl"), recursive=True):
    if SELF in f:
        continue
    pi["n_sessions"] += 1
    seen_tools_this_session = set()
    touched_paths = set()   # any read/write/edit target seen so far this session
    read_paths = set()      # paths seen via 'read' so far this session
    any_call = False
    for l in open(f, errors="replace"):
        try:
            d = json.loads(l)
        except Exception:
            continue
        if d.get("type") != "message":
            continue
        m = d.get("message", {})
        role = m.get("role")
        if role == "assistant":
            for c in m.get("content") or []:
                if c.get("type") != "toolCall":
                    continue
                name = c.get("name")
                args = c.get("arguments") or {}
                any_call = True
                if name in ("read", "write", "edit", "ls", "bash"):
                    pi["call_counts"][name] += 1
                    seen_tools_this_session.add(name)
                if name == "ls":
                    pi["ls_calls"] += 1
                if name == "bash":
                    pi["shell_calls"] += 1
                    cmd = str(args.get("command") or "").strip()
                    first = cmd.split()[0] if cmd else ""
                    first = first.split("/")[-1]
                    pi["shell_first_word"][first if first in ("ls", "find", "tree") else "other"] += 1
                if name == "read":
                    path = args.get("path")
                    has_off = "offset" in args
                    has_lim = "limit" in args
                    if has_off and has_lim:
                        pi["read_both"] += 1
                    elif has_off:
                        pi["read_offset_only"] += 1
                    elif has_lim:
                        pi["read_limit_only"] += 1
                    else:
                        pi["read_neither"] += 1
                    if has_lim and isinstance(args.get("limit"), (int, float)):
                        pi["read_limits"].append(args.get("limit"))
                    pi["read_path_kind"][path_kind(path)] += 1
                    if path:
                        read_paths.add(path)
                        touched_paths.add(path)
                elif name == "write":
                    path = args.get("path")
                    content = args.get("content") or ""
                    if not isinstance(content, str):
                        content = str(content)
                    pi["write_sizes"].append(len(content.encode("utf-8", "replace")))
                    pi["write_total_for_crlf"] += 1
                    if "\r\n" in content:
                        pi["write_crlf"] += 1
                    if path:
                        pi["write_new_vs_seen"]["seen" if path in touched_paths else "new"] += 1
                        pi["stale_write"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
                elif name == "edit":
                    path = args.get("path")
                    edits = args.get("edits") or []
                    if not isinstance(edits, list):
                        edits = []
                    pi["edit_blocks"].append(len(edits))
                    for e in edits:
                        if not isinstance(e, dict):
                            continue
                        pi["edit_total_for_crlf"] += 1
                        if "\r\n" in (e.get("oldText") or "") or "\r\n" in (e.get("newText") or ""):
                            pi["edit_crlf"] += 1
                            break
                    if path:
                        pi["stale_edit"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
        elif role == "toolResult":
            tn = m.get("toolName")
            if tn == "read" and m.get("isError"):
                pi["read_errors"] += 1
                txt = "".join(c.get("text", "") for c in (m.get("content") or []) if c.get("type") == "text")
                pi["read_err_bucket"][norm_err(txt, "read")] += 1
            elif tn == "edit" and m.get("isError"):
                pi["edit_errors"] += 1
                txt = "".join(c.get("text", "") for c in (m.get("content") or []) if c.get("type") == "text")
                pi["edit_err_bucket"][norm_err(txt, "edit")] += 1
    if any_call:
        pi["n_sessions_with_any_tool"] += 1
    for t in seen_tools_this_session:
        pi["session_counts"][t] += 1

# ---------------- Claude Code sessions ----------------
CC_FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit"}

for f in glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True):
    if SELF in f:
        continue
    is_sub = "/subagents/" in f
    dst = cc_sub if is_sub else cc_main
    dst["n_sessions"] += 1
    seen_tools_this_session = set()
    touched_paths = set()
    read_paths = set()
    any_call = False
    id_to_name = {}
    for l in open(f, errors="replace"):
        try:
            d = json.loads(l)
        except Exception:
            continue
        t = d.get("type")
        if t == "assistant":
            m = d.get("message", {})
            for c in m.get("content") or []:
                if c.get("type") != "tool_use":
                    continue
                name = c.get("name")
                inp = c.get("input") or {}
                id_to_name[c.get("id")] = name
                any_call = True
                if name in CC_FILE_TOOLS or name == "Bash":
                    dst["call_counts"][name] += 1
                    seen_tools_this_session.add(name)
                if name == "Bash":
                    dst["shell_calls"] += 1
                    cmd = str(inp.get("command") or "").strip()
                    first = cmd.split()[0] if cmd else ""
                    first = first.split("/")[-1]
                    dst["shell_first_word"][first if first in ("ls", "find", "tree") else "other"] += 1
                if name == "Read":
                    path = inp.get("file_path")
                    has_off = "offset" in inp
                    has_lim = "limit" in inp
                    if has_off and has_lim:
                        dst["read_both"] += 1
                    elif has_off:
                        dst["read_offset_only"] += 1
                    elif has_lim:
                        dst["read_limit_only"] += 1
                    else:
                        dst["read_neither"] += 1
                    if has_lim and isinstance(inp.get("limit"), (int, float)):
                        dst["read_limits"].append(inp.get("limit"))
                    dst["read_path_kind"][path_kind(path)] += 1
                    if path:
                        read_paths.add(path)
                        touched_paths.add(path)
                elif name == "Write":
                    path = inp.get("file_path")
                    content = inp.get("content") or ""
                    if not isinstance(content, str):
                        content = str(content)
                    dst["write_sizes"].append(len(content.encode("utf-8", "replace")))
                    dst["write_total_for_crlf"] += 1
                    if "\r\n" in content:
                        dst["write_crlf"] += 1
                    if path:
                        dst["write_new_vs_seen"]["seen" if path in touched_paths else "new"] += 1
                        dst["stale_write"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
                elif name == "Edit":
                    path = inp.get("file_path")
                    dst["edit_calls_for_replace_all"] += 1
                    if inp.get("replace_all"):
                        dst["edit_replace_all"] += 1
                    dst["edit_total_for_crlf"] += 1
                    if "\r\n" in (inp.get("old_string") or "") or "\r\n" in (inp.get("new_string") or ""):
                        dst["edit_crlf"] += 1
                    if path:
                        dst["stale_edit"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
                elif name == "MultiEdit":
                    path = inp.get("file_path")
                    edits = inp.get("edits") or []
                    if not isinstance(edits, list):
                        edits = []
                    dst["edit_blocks"].append(len(edits))
                    for e in edits:
                        if not isinstance(e, dict):
                            continue
                        dst["edit_total_for_crlf"] += 1
                        if "\r\n" in (e.get("old_string") or "") or "\r\n" in (e.get("new_string") or ""):
                            dst["edit_crlf"] += 1
                            break
                    if path:
                        dst["stale_edit"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
                elif name == "NotebookEdit":
                    path = inp.get("notebook_path")
                    if path:
                        dst["stale_edit"]["read earlier" if path in read_paths else "never read earlier"] += 1
                        touched_paths.add(path)
        elif t == "user":
            m = d.get("message", {})
            cont = m.get("content")
            if not isinstance(cont, list):
                continue
            for c in cont:
                if not (isinstance(c, dict) and c.get("type") == "tool_result"):
                    continue
                name = id_to_name.get(c.get("tool_use_id"))
                if name not in CC_FILE_TOOLS:
                    continue
                if not c.get("is_error"):
                    continue
                txt = c.get("content")
                if isinstance(txt, list):
                    txt = "".join(x.get("text", "") for x in txt if isinstance(x, dict))
                txt = txt or ""
                if name == "Read":
                    dst["read_errors"] += 1
                    dst["read_err_bucket"][norm_err(txt, "read")] += 1
                else:  # Edit / MultiEdit / NotebookEdit / Write treated as edit-family errors
                    dst["edit_errors"] += 1
                    dst["edit_err_bucket"][norm_err(txt, "edit")] += 1
    if any_call:
        dst["n_sessions_with_any_tool"] += 1
    for t in seen_tools_this_session:
        dst["session_counts"][t] += 1


def report(name, d):
    lines = [f"\n## {name}\n"]
    lines.append(f"sessions: {d['n_sessions']} ({d['n_sessions_with_any_tool']} used any tool)\n")
    lines.append("| tool | calls | sessions using | share of sessions |")
    lines.append("|---|---|---|---|")
    for tool, n in d["call_counts"].most_common():
        sc = d["session_counts"][tool]
        pct = 100 * sc / d["n_sessions_with_any_tool"] if d["n_sessions_with_any_tool"] else 0
        lines.append(f"| {tool} | {n} | {sc} | {pct:.1f}% |")

    total_read = d["read_offset_only"] + d["read_limit_only"] + d["read_both"] + d["read_neither"]
    if total_read:
        lines.append(f"\nread: {total_read} calls. offset only {100*d['read_offset_only']/total_read:.1f}%, "
                      f"limit only {100*d['read_limit_only']/total_read:.1f}%, both {100*d['read_both']/total_read:.1f}%, "
                      f"neither {100*d['read_neither']/total_read:.1f}%")
        if d["read_limits"]:
            lims = d["read_limits"]
            lines.append(f"limit values: p50={pctl(lims,.5)} p90={pctl(lims,.9)} max={max(lims)} (n={len(lims)})")
        pk = d["read_path_kind"]
        tot_pk = sum(pk.values()) or 1
        lines.append(f"path kind: image {100*pk['image']/tot_pk:.1f}%, pdf {100*pk['pdf']/tot_pk:.1f}%, "
                      f"binary {100*pk['binary']/tot_pk:.1f}%, text {100*pk['text']/tot_pk:.1f}%")
        lines.append(f"read errors: {d['read_errors']}/{total_read} ({100*d['read_errors']/total_read:.2f}%)")
        for b, n in d["read_err_bucket"].most_common():
            lines.append(f"  - {b}: {n}")

    edit_calls = d["call_counts"].get("edit", 0) + d["call_counts"].get("Edit", 0) + \
        d["call_counts"].get("MultiEdit", 0) + d["call_counts"].get("NotebookEdit", 0)
    if edit_calls:
        lines.append(f"\nedit-family calls: {edit_calls}, errors: {d['edit_errors']} "
                      f"({100*d['edit_errors']/edit_calls:.2f}%)")
        for b, n in d["edit_err_bucket"].most_common():
            lines.append(f"  - {b}: {n}")
        if d["edit_blocks"]:
            bl = d["edit_blocks"]
            multi = sum(1 for x in bl if x > 1)
            lines.append(f"blocks per call (pi 'edits'/CC MultiEdit 'edits'): n={len(bl)}, "
                          f">1 block: {100*multi/len(bl):.1f}%, p50={pctl(bl,.5)} p90={pctl(bl,.9)} max={max(bl)}")
        if d["edit_calls_for_replace_all"]:
            lines.append(f"replace_all share (CC Edit only): "
                          f"{100*d['edit_replace_all']/d['edit_calls_for_replace_all']:.1f}% "
                          f"(n={d['edit_calls_for_replace_all']})")
        se = d["stale_edit"]
        tot_se = sum(se.values())
        if tot_se:
            lines.append(f"edit targets never read earlier in session: "
                          f"{100*se['never read earlier']/tot_se:.1f}% (n={tot_se})")

    if d["write_sizes"]:
        ws = d["write_sizes"]
        lines.append(f"\nwrite calls: {len(ws)}. size bytes: p50={pctl(ws,.5)} p90={pctl(ws,.9)} "
                      f"p99={pctl(ws,.99)} max={max(ws)}")
        wv = d["write_new_vs_seen"]
        tot_wv = sum(wv.values())
        if tot_wv:
            lines.append(f"write target new to session: {100*wv['new']/tot_wv:.1f}%, "
                          f"overwrite of path seen earlier: {100*wv['seen']/tot_wv:.1f}% (n={tot_wv})")
        sw = d["stale_write"]
        tot_sw = sum(sw.values())
        if tot_sw:
            lines.append(f"write targets never read earlier in session: "
                          f"{100*sw['never read earlier']/tot_sw:.1f}% (n={tot_sw})")

    if d["edit_total_for_crlf"]:
        lines.append(f"\nCRLF in edit old/new text: {100*d['edit_crlf']/d['edit_total_for_crlf']:.2f}% "
                      f"(n={d['edit_total_for_crlf']})")
    if d["write_total_for_crlf"]:
        lines.append(f"CRLF in write content: {100*d['write_crlf']/d['write_total_for_crlf']:.2f}% "
                      f"(n={d['write_total_for_crlf']})")

    if d["shell_calls"]:
        sfw = d["shell_first_word"]
        hits = sfw["ls"] + sfw["find"] + sfw["tree"]
        lines.append(f"\nshell calls: {d['shell_calls']}. first word ls/find/tree: "
                      f"{100*hits/d['shell_calls']:.1f}%")
        if d["ls_calls"]:
            lines.append(f"dedicated 'ls' tool calls (pi only): {d['ls_calls']}")
    return "\n".join(lines)


out = ["# File tool usage: pi and Claude Code\n",
       "Measured 2026-09-26. One process, one pass over each session log.\n",
       f"pi sessions scanned: {pi['n_sessions']}\n",
       f"Claude Code main sessions scanned: {cc_main['n_sessions']}\n",
       f"Claude Code subagent sessions scanned: {cc_sub['n_sessions']}\n",
       "\n'new to session' and 'never read earlier in session' are proxies from "
       "in-session tool-call order (what the model itself read/wrote/edited "
       "earlier in that log), not actual file mtimes.\n"]
out.append(report("pi", pi))
out.append(report("Claude Code (main)", cc_main))
out.append(report("Claude Code (subagents)", cc_sub))

text = "\n".join(out) + "\n"
print(text)
with open(os.path.join(os.path.dirname(__file__), "usage.md"), "w") as fh:
    fh.write(text)
