# Authoring probe: which runtime is easiest for a model to write against?

The efficiency question is settled by the RSS sweep in `../pass2`. This probe
settles the other axis Issue #11 raised: if an AI writes the extensions — which
it will, since Fiber is a coding agent — which runtime does it get right?

## What it measures

Each candidate model is given one language's `host-api-<lang>.md` and the shared
`task.md`, and asked to write the `acme` streaming provider. Nothing else.

## How it is scored — execution, not opinion

Each generated extension is loaded into the **real** interpreter (the pass-1/2
`mlua` and `rquickjs` embeddings) with a stub `host` that replays
`../transcript.sse` through `http_stream`. The score per extension:

- **runs unmodified** (yes/no): does `host.emit` reconstruct `../expected.txt`?
- **fixups to green**: minimal edits to make it run, if it did not.
- **failure class** (the one place human judgment enters):
  - `unavailable-api` — reached for something the embedding lacks (`fetch`,
    `require`, `async`, `os.execute`, npm). The core familiarity signal.
  - `syntax` — did not parse in the target language.
  - `contract` — ran, but misused the documented host API (wrong field, wrong
    registration).
  - `logic` — correct API use, wrong filtering/accumulation.

The judge is `cargo run`, not a model, which also satisfies the delegate rule of
never reviewing an artifact with the model that produced it.

## Fairness

`host-api-{lua,luau,js}.md` are generated from one source (`gen_docs.py`) so they
cannot silently drift; unequal docs would measure doc quality, not familiarity.
Before dispatch, a non-Claude model reviews the three docs for parity.

## Why the small model matters most

A frontier model is smart enough to notice `fetch` is missing and adapt, which
hides the familiarity gradient. A small model writes what its priors say and
exposes the raw gap. So the low end of the roster carries most of the signal —
and it is also the realistic condition, since extensions get written by whatever
model the user is running.
