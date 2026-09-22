# Authoring-probe results

Five models × three languages × the streaming-provider task. Each model was
given ONLY its language's `host-api-<lang>.md` + `task.md`, with no access to the
repo (see "Isolation" below). Scored by execution: the generated extension is
loaded into the real `mlua`/`rquickjs` interpreter (`../pass3`), the transcript
is replayed through a stub `host.http_stream`, and the emitted text is checked
against `expected.txt`. Outputs in `out/`, cleaned copies scored in `out/clean/`.

## Result: 14 / 15 ran unmodified and correct

| model | tier | Lua 5.4 | Luau | QuickJS JS |
|---|---|:--:|:--:|:--:|
| opus | frontier | pass | pass | pass |
| muse-spark-1.3-contributor | frontier | pass | pass | pass |
| glm-5.3-flash | small | pass | pass | pass |
| composer-2.5 | small | pass | pass | pass |
| qwen3.8-flash | small | pass | **fail** | pass |

The one failure — qwen3.8-flash on Luau — loaded and ran without error but
emitted nothing. Cause: `string.find(line, "^data: ", 1, true)`. The `true` is
the plain-search flag, which makes `^` a literal, so no line ever matches and
nothing is emitted. Its Lua answer used the correct `string.sub(line,1,6)` idiom
and passed. Minimal fix: delete `, 1, true` (one token) → passes.

## Failure taxonomy

- `logic`: 1 (qwen/Luau, above)
- `unavailable-api`: **0**
- `syntax`: 0
- `contract`: 0

## The finding that matters

**No model, in any language, reached for an API the embedding lacks** — no
`fetch`, `require`, `async`, `os.execute`, or npm, in any of the 15 outputs. The
bare-embedding hazard (a model assuming Node/browser JS, or full-stdlib Lua) did
not appear once the doc stated the constraint plainly. The single failure was an
ordinary logic bug, not a familiarity gap, and it was language-incidental (the
same model got Lua and JS right).

**So authoring ability does not differentiate the three runtimes.** At the doc
quality Fiber would actually ship, every model tier writes working Lua, Luau and
QuickJS-JS extensions. The training-data-mass advantage JavaScript has did not
convert into a measurable authoring edge — and, importantly, did not hurt Lua or
Luau either. This does NOT break the Lua-5.4-vs-QuickJS tie; the other axes do.

## Caveats

- n=1 per cell. This is a probe, not a benchmark; the single qwen/Luau failure
  could be variance. Re-running qwen/Luau a few times would tell, if the failure
  mattered to the decision — it does not, since authoring is a wash regardless.
- One task, one shape (streaming provider). A tool that manipulates data
  structures might exercise the languages differently; not tested.
- The docs explicitly warn "NO fetch / NO require / NO async" for JS. That
  warning is doing work — the finding is "a good doc prevents the hazard", not
  "the hazard doesn't exist". `docs/extensions.md` must carry that warning.

## Isolation

- pi models (glm, muse, qwen): run with an empty working directory, prompt passed
  as the argument.
- composer-2.5: cursor-delegate with `CallerProvided` isolation pointing at a dir
  containing only `prompt.txt`.
- opus: subagents instructed to read only the one prompt file.

`out-tainted-run1/` is a discarded first run where models had repo access and
could read `pass2/`'s reference extensions; kept only as a record of the fix.
