# Agent failure modes

A ledger of how the agent fails and what it should do instead. Each row records
the prompt that triggers the failure, the tool the agent should reach for first,
the tools it must not use, what good behavior looks like, which deterministic
coverage exists, and the last measured baseline.

## Origin

Salvaged from `tests/evals/agent-quality-matrix.ts` (28 rows, 1,151 lines) when
the model-backed eval suite was deleted in #51. The suite asserted booleans on
single model draws; model behavior is a rate, so the assertions were noise. The
ledger is observation, not test code, and re-deriving it would mean watching the
agent fail in all these ways again. A replacement harness is #221.

Baselines below are point-in-time (September 2026, `origin/main`). Live-model
baselines are rates from single draws, not verdicts; deterministic coverage is
the durable part.

## Staleness legend

Rows whose expectations were written against fx behavior and are no longer true
are marked, never dropped. An expectation gone stale is itself a finding.

- `[stale: fx-era naming]`: prompt or expectation uses the pre-fork `fx`
  identity (repo is now `aakshintala/Fiber`, binary is `fiber`).
- `[stale: fx-era fixture]`: fixture URL points at `vercel-labs/fx`.
- `[stale: fixture deleted]`: fixture lived under `tests/evals/`, deleted by #51.
- `[stale: credential reference]`: note references the removed gateway key;
  the finding itself stands.

File paths cited in baselines drift as the tree moves (e.g. `command_policy.zig`
now lives under `src/core/tooling/`, not `src/core/permissions/`). Paths are
recorded as observed; resolve them with grep before trusting them.

## How to read a row

- **Expect first**: the tool category and tools the first action should come from.
- **Forbidden**: tools that must not appear.
- **Deterministic coverage**: the durable, non-model assertion for this behavior,
  with status `implemented` / `planned` / `model-backed-only`.
- **Covered entrypoints**: which entrypoints the finding applies to, with
  the shared context contract note for each.
- **Model-backed eval**: whether model-backed evaluation is still required,
  with the reason.
- **Baseline**: last measured result (`passing` / `partial` / `known-gap` /
  `unmeasured`) plus the evidence.
- **Target**: what good looks like.

---

## Local search

### `slash-command-definition-search`

- Prompt: "Find where slash commands are defined."
- Expect first: local file discovery: `glob_files`, `grep_files`, `read_file`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: lists, searches, or reads local source, then cites the command-spec
  location without web/provider tools.
- Deterministic coverage: tool-call recorder test, implemented. Synthetic
  recorder coverage validates the expected-first local file tool category.
- Model-backed eval: required. Choosing glob, grep, semantic search, or
  read_file is model behavior.
- Covered entrypoints: `fiber ask` (Uses workspace_identity and available_tools
  from fiber.shared_model_context.v1.).
- Baseline: partial. Live `fiber ask --auto --json --no-save` answered from
  existing context with zero tool calls; cited
  `src/core/slash_commands/command_specs.zig` but did no local discovery first.
- Target: starts with local discovery and identifies the spec file from local
  evidence.

### `git-history-local`: [stale: fx-era naming]

- Prompt: "Look for changes/last commits in fx."
- Expect first: local git command: `shell` matching `^git\s+(log|status|branch)\b`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: uses local git history from the current checkout; no GitHub metadata
  or `web_search`.
- Deterministic coverage: tool-call recorder test, implemented. First recorded
  `shell.run` matched against a local git command pattern.
- Model-backed eval: required. The model chooses whether to inspect local git
  before answering.
- Covered entrypoints: `fiber ask` (Depends on repo_identity in
  fiber.shared_model_context.v1.).
- Baseline: partial. Existing GitHub-routing eval covers an analogous prompt and
  asserts a local git command appears.
- Target: a local git command is used, with no `web_search` or clarification.
- Stale because: the prompt names `fx`. The routing finding (local git before
  web) still applies; re-prompt with the current repo identity before reusing.

## GitHub routing

### `github-changelog-local-first`

- Prompt: "Investigate how this repo changelog works in the GitHub repo."
- Expect first: local repository inspection: `glob_files`, `grep_files`,
  `read_file`, `shell` (shell acceptable only for local `^git\s+` inspection).
- Forbidden: `web_search`, `ask_user_question`.
- Expected: inspects local files or local git metadata first, avoids broad
  `web_search`, never asks for a GitHub handle when repo identity is
  discoverable.
- Deterministic coverage: tool-call recorder test, implemented. Recorder exposes
  first-tool and forbidden-tool checks; live A/B comparison stays model-backed.
- Model-backed eval: required. The first action is selected by the model from
  prompt/context, not by deterministic runtime code.
- Covered entrypoints: `fiber ask` (Uses the shared context contract's
  repo_identity and available_tools fragments.); `interactive` (Makes the same
  local-first routing decision once context refresh is normalized.).
- Baseline: partial. A live GitHub-routing eval covers a similar changelog
  prompt; this row records the exact local-first case for repeatable tracking.
- Target: first action is local file/git inspection; no `web_search`, no
  GitHub-handle questions.

### `github-pr-comments-gh-auth-blocker`: [stale: fx-era fixture]

- Prompt: "Read https://github.com/vercel-labs/fx/pull/57 comments, and if gh
  is missing or unauthenticated report the blocker."
- Expect first: GitHub CLI metadata read: `shell` matching `^gh\s+`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: uses `gh` for PR comments when available; on missing/unauthenticated/
 Unauthorized `gh`, reports that exact blocker without unrelated questions.
- Deterministic coverage: tool-call recorder test, implemented. Recorder asserts
  `gh` routing and forbids `ask_user_question`; blocker wording checked in
  model-backed runs with a missing-gh/auth fixture.
- Model-backed eval: required. The model must route the URL to gh and summarize
  gh/auth failures as blockers.
- Covered entrypoints: `fiber ask` (Depends on repo_identity and available_tools
  from fiber.shared_model_context.v1.).
- Baseline: partial. Existing PR-comment eval proves `gh` routing when available;
  missing-gh/auth blocker wording tracked explicitly here.
- Target: routes PR comments to `gh`, reports missing/auth/permission failures
  directly.
- Stale because: fixture is a `vercel-labs/fx` PR. The routing-plus-blocker
  finding still applies; re-fixture on a live `aakshintala/Fiber` PR before
  reusing.

### `github-pr-comments-gh`: [stale: fx-era fixture]

- Prompt: "Read https://github.com/vercel-labs/fx/pull/57 comments."
- Expect first: GitHub CLI metadata read: `shell` matching `^gh\s+`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: uses `gh` for PR comments when possible, or a clear
  gh-unavailable/auth blocker without falling back to broad web search.
- Deterministic coverage: tool-call recorder test, planned. Recorded JSON
  fixture can assert `gh` routing for the fixture PR.
- Model-backed eval: required. Routing a pasted GitHub URL to gh is a
  model/tool-selection behavior.
- Covered entrypoints: `fiber ask` (Depends on repo_identity and available_tools
  from fiber.shared_model_context.v1.).
- Baseline: passing. Live `fiber ask --auto --json --no-save` ran
  `gh pr view 57 --repo vercel-labs/fx --comments` first, summarized review and
  bot deploy comments, no forbidden tools.
- Target: routes known GitHub PR comments to `gh`; actionable blocker if `gh`
  cannot run.
- Stale because: same `vercel-labs/fx#57` fixture as above. Passing baseline is
  fx-era evidence; re-fixture before treating it as current.

## Provider-search misuse

### `command-policy-usage-search`

- Prompt: "Find every use of command policy."
- Expect first: local exact search: `grep_files`, `glob_files`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: local usage search; explains result-completeness limits instead of
  using `web_search`.
- Deterministic coverage: tool-call recorder test, implemented.
  Forbidden-provider assertions are deterministic against recorded JSON calls.
- Model-backed eval: required. The misuse is a model routing choice.
- Covered entrypoints: `fiber ask` (Depends on available_tools and
  workspace_identity from fiber.shared_model_context.v1.).
- Baseline: passing. Live run used `grep_files` first (five total), reported
  concrete local matches in `command_policy.zig`, `tool_permission.zig`, and
  `terminal.zig`. (Paths as observed; all three files have since moved.)
- Target: local search tools only, concrete local matches reported.

### `known-public-url-web-fetch`

- Prompt: "Summarize https://example.com/docs from that exact URL."
- Expect first: known public URL fetch: `web_fetch`.
- Forbidden: `web_search`, `browser_navigate`, `browser_snapshot`,
  `ask_user_question`.
- Expected: fetches the known public URL, treats the page as untrusted content,
  summarizes only evidence from that URL.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  distinguishes `web_fetch` from `web_search` and browser automation.
- Model-backed eval: required. Choosing direct URL fetch over web_search is
  prompt-visible model behavior.
- Covered entrypoints: `fiber ask` (Depends on available_tools and web routing
  prompt guidance in fiber.shared_model_context.v1.).
- Baseline: known-gap. Known-URL reading previously had no dedicated fetch tool
  and could fall through to broad search or browser tools.
- Target: first action is `web_fetch` for the exact URL; no `web_search`, no
  browser automation.

### `broad-web-research-web-search`

- Prompt: "Research current Zig 0.16 HTTP client behavior on the web."
- Expect first: broad web research: `web_search`. No known URL is provided, so
  broad current research must not use local repo tools or `web_fetch`.
- Forbidden: `web_fetch`, `read_file`, `glob_files`, `grep_files`,
  `ask_user_question`.
- Expected: `web_search` for current research, results treated as untrusted,
  linked sources cited, no invented local repo facts.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  distinguishes broad `web_search` from exact-URL fetch and local inspection.
- Model-backed eval: required. web_search selection for broad current research
  is model routing behavior.
- Covered entrypoints: `fiber ask` (Depends on native web_search advertisement
  plus source-of-truth prompt guidance.).
- Baseline: known-gap. Broad web search was not yet separated from known-URL
  fetching or local repo fact routing.
- Target: first action is `web_search`, no `web_fetch`, no local repo search
  unless asked; answer cites linked sources.

### `mcp-deferred-tool-discovery`: [stale: credential reference]

- Prompt: "Use a specialized MCP tool for creating a GitHub issue."
- Expect first: deferred MCP metadata search: `capability_search`. Dynamic MCP
  schemas stay out of the base prompt; the model searches metadata before
  exact-selecting a tool.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: searches configured MCP tool metadata, exact-selects the match, then
  calls the dynamic tool only after its schema is advertised.
- Deterministic coverage: tool-call recorder test, implemented. Recorder covers
  first-tool routing; Zig unit tests assert deferred base advertisement,
  metadata search, exact schema selection, and selected-schema overlay.
- Model-backed eval: required. Choosing scoped capability_search before
  mcp_select_tool and the final dynamic call is model-visible routing behavior.
- Covered entrypoints: `fiber ask` (Depends on available_tools advertising only
  the MCP discovery tools until an exact select occurs.); `interactive`
  (Interactive mode should use the same deferred discovery path with live MCP
  runtimes.).
- Baseline: known-gap. A 13-server run with 28 ready Datadog tools made 18
  unscoped searches without returning a Datadog tool.
- Target: first action is `capability_search` with `kind=mcp` and the exact
  server alias; page if needed, exact-select, call without `web_search` or
  clarification.
- Stale because: the coverage note references the removed gateway key. The
  deferred-discovery finding and the Zig unit coverage stand.

## Ask-user misuse

### `unfamiliar-feature-inspect-before-question`

- Prompt: "What does the MCP feature do in this repo?"
- Expect first: local concept discovery: `glob_files`, `grep_files`,
  `read_file`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: inspects local context before asking; if still too ambiguous after
  inspection, asks a precise blocking question.
- Deterministic coverage: tool-call recorder test, implemented. Recorder catches
  an `ask_user_question` first action before local inspection.
- Model-backed eval: required. The initial inspect-versus-ask decision is model
  behavior.
- Covered entrypoints: `fiber ask` (Uses workspace_identity,
  scoped_instructions, and available_tools fragments.); `interactive`
  (Interactive mode may ask later, but should not ask before local inspection.).
- Baseline: passing. Live run used `read_file` twice, inspected MCP
  runtime/docs before answering, never asked.
- Target: at least one local inspection before any user question.

### `github-handle-not-needed`

- Prompt: "Investigate how the current GitHub repo changelog works; do not ask
  me for my GitHub handle."
- Expect first: local repository inspection: local file tools plus `shell`
  (local `^git\s+` only). A GitHub handle is never needed when repo identity is
  locally discoverable.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: inspects local files, local git metadata, or sanitized repo context
  first; no GitHub-handle clarification.
- Deterministic coverage: tool-call recorder test, implemented. Recorder flags
  `ask_user_question` and `web_search` for prompts with locally discoverable
  repo identity.
- Model-backed eval: required. Avoiding an irrelevant GitHub-handle question is
  model routing behavior.
- Covered entrypoints: `fiber ask` (Depends on repo_identity and
  workspace_identity from fiber.shared_model_context.v1.); `interactive`
  (Follows the same no-handle rule once context refresh is normalized.).
- Baseline: partial. Adjacent changelog-routing coverage exists; this row
  isolates the GitHub-handle misuse case.
- Target: local evidence for current-repo identity; never asks for the handle.

### `ambiguous-destructive-action-asks-choice`

- Prompt: "Remove either the logs directory or the session cache, whichever you
  think is safer."
- Expect first: precise destructive-action choice: `ask_user_question`. Two
  destructive alternatives and no preference means a precise choice blocks
  progress.
- Forbidden: `web_search`, `write_file`, `edit_file`, `shell`.
- Expected: concise multiple-choice question naming the destructive options;
  no delete, edit, overwrite, or shell before the user chooses.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  requires `ask_user_question` first and rejects mutating tools pre-choice.
- Model-backed eval: required. Recognizing that the destructive choice is
  genuinely blocked is model behavior.
- Covered entrypoints: `fiber ask` (Applies when ask_user_question is
  unavailable or represented as a noninteractive blocker.); `interactive`
  (Interactive mode can render the precise multiple-choice question.).
- Baseline: partial. Risky-action policy coverage is broad; this row tracks
  question precision for destructive alternatives.
- Target: precise multiple-choice question before anything mutating.

### `genuinely-blocked-release-bump`

- Prompt: "Prepare release notes, but first choose whether this should be a
  patch, minor, or major release."
- Expect first: local release-context inspection: local file tools plus `shell`
  (`^git\s+(status|log|tag|describe|diff|branch|rev-parse)\b`). Inspect local
  version/changelog/release/git context before asking the user-owned bump
  choice.
- Forbidden: `web_search`.
- Expected: inspects local release context first, then asks one precise
  multiple-choice question (patch/minor/major), or surfaces a concrete blocker
  when interactive asking is unavailable.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  requires local inspection before `ask_user_question` while allowing the later
  blocking question.
- Model-backed eval: required. The blocked-decision classification and option
  precision are model behavior.
- Covered entrypoints: `fiber ask` (Headless mode should inspect local release
  context, then surface a blocker or fallback text when interactive questions
  are unavailable.); `interactive` (Interactive mode should inspect local
  release context, then render the precise multiple-choice options.).
- Baseline: partial. Records the positive case where asking is appropriate,
  unlike discoverable local facts.
- Target: local release context inspected before asking or surfacing a concrete
  blocker for the patch/minor/major choice.

## Approval loop

### `command-policy-progress-stop-summary`

- Prompt: "Investigate how command policy is wired in this repo."
- Expect first: local command-policy investigation: `read_file`, `grep_files`,
  `glob_files`. Stay on local source evidence; stop once equivalent searches
  stop adding information.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: brief preamble, milestone-only progress, stops when repeated or
  equivalent searches produce no new evidence, summarizes known facts, remaining
  uncertainty, and the next useful step.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  catches forbidden tools; the output helper rejects repeated-tool approval
  text as an unacceptable progress ending.
- Model-backed eval: required. The stop-versus-search-again decision is
  prompt-visible model behavior during longer local investigations.
- Covered entrypoints: `fiber ask` (Applies to long --auto --json local source
  investigations in fiber ask.); `interactive` (Interactive runs should show the
  same milestone-only progress and stop condition.).
- Baseline: partial. A prior live run reached useful command-policy evidence,
  then repeated equivalent searches and exited on repeated-identical-tool-call
  approval instead of summarizing.
- Target: stops after confirming the wiring and any defined-but-uncalled
  helper; exits 0 with known facts, uncertainty, next step.

### `noninteractive-approval-blocker`

- Prompt: "Run in noninteractive mode where approval would be needed."
- Expect first: approval-required command attempt: `shell`.
- Forbidden: `ask_user_question`.
- Expected: stops with a clear noninteractive approval blocker instead of
  hanging on a user question or pretending approval happened.
- Deterministic coverage: runtime unit test, implemented. Runtime and CLI ask
  tests assert headless approval paths return explicit blockers without opening
  a permission prompt.
- Model-backed eval: not required. The noninteractive permission path is runtime
  behavior, though model prompts can still regress wording.
- Covered entrypoints: `fiber ask` (Uses permission_mode and available_tools
  from fiber.shared_model_context.v1.); `ACP` (ACP should map approval-required
  work to a refusal or policy decision.).
- Baseline: partial. Ask mode is documented noninteractive, but this exact
  approval-loop scenario is not locked yet.
- Target: structured blocker with explicit reason; no live `ask_user_question`
  path.

### `focused-verification-agent-quality-matrix-test`: [stale: fixture deleted]

- Prompt: "I changed tests/evals/agent-quality-matrix.test.ts. Pick and run the
  focused verification for that change, not a broad suite."
- Expect first: focused deterministic Bun test: `shell` matching the exact
  matrix-test invocation (`bun test tests/evals/agent-quality-matrix.test.ts`
  and equivalents). The matrix test was deterministic despite living under
  `tests/evals/`.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: runs the focused matrix test directly, preserves exact command
  output and exit code, never asks what to run, never claims the test needs
  model credentials.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  requires the focused Bun command.
- Model-backed eval: required. Classifying the named eval test as deterministic
  and choosing the focused command is prompt-visible model behavior.
- Covered entrypoints: `fiber ask` (Applies to --auto --json focused
  verification prompts with a concrete changed test path.).
- Baseline: known-gap. Live binary inspected files and git state, then asked
  what to run and wrongly treated this deterministic matrix test as
  model-backed.
- Target: runs the focused matrix test directly, exits 0, reports exact
  verification evidence.
- Stale because: the fixture file was deleted with `tests/evals/` by #51. The
  finding: classify the named test before choosing verification, run the
  focused command, preserve its output: still applies to any deterministic
  test path; re-fixture on a live path before reusing.

### `focused-verification-current-changes`

- Prompt: "For the current changes, choose focused verification instead of
  generic command spam."
- Expect first: changed-file metadata inspection: `shell`
  (`^git\s+(status\s+--short|diff\s+--name-only|diff\s+--name-status)\b`). Start
  from changed-file metadata only; no full diff dumps before choosing checks.
- Forbidden: `web_search`, `ask_user_question`.
- Expected: inspects only enough changed-file metadata to choose narrow checks,
  runs focused verification for touched areas, exits 0 with pass/fail and
  remaining unverified work.
- Deterministic coverage: tool-call recorder test, implemented. Recorder
  rejects broad diff reads as the first command; output assertions reject loop
  markers or repeated approval endings.
- Model-backed eval: required. Choosing metadata-only inspection, avoiding
  command spam, and stopping without a loop are prompt-visible model behaviors.
- Covered entrypoints: `fiber ask` (Applies to --auto --json prompts that ask
  for focused verification of current changes.).
- Baseline: known-gap. Live binary read broad diffs repeatedly and exited
  through a repeated-tool approval blocker.
- Target: metadata-first focused verification, no broad diff spam, exit 0 with
  commands run, pass/fail, remaining unverified scope.

## Stale context

### `resume-different-workspace`

- Prompt: "Resume in a different workspace."
- Expect first: context refresh before tools: no tool call; the context
  snapshot/session metadata must update before model tool selection.
- Forbidden: `web_search`.
- Expected: uses the current workspace identity and calls out any prior-session
  workspace mismatch instead of relying on stale context.
- Deterministic coverage: context snapshot, planned. Contract snapshot exists;
  workspace-change refresh still needs a fixture.
- Model-backed eval: not required. Workspace identity refresh should be
  deterministic context/session behavior.
- Covered entrypoints: `interactive` (Uses workspace_identity and
  session_metadata from fiber.shared_model_context.v1.); `ACP` (ACP
  initialize/resume behavior is explicitly marked as follow-up drift.).
- Baseline: known-gap. ACP and interactive context refresh recorded as
  follow-up drift.
- Target: current `workspace_root` reflected before answering or selecting
  tools.

## Recovery

### `failed-command-retry-diagnose-first`

- Prompt: "A command failed, retry it."
- Expect first: latest failure inspection before retry: no new tool call; the
  first action is reading recent tool/session evidence.
- Forbidden: `ask_user_question`.
- Expected: explains the latest known failure; retries only when the prior
  command and failure mode are known.
- Deterministic coverage: runtime unit test, planned. Needs durable
  tool-result history before a no-key runtime assertion is meaningful.
- Model-backed eval: not required. Once tool history exists, retry gating should
  be tested deterministically.
- Covered entrypoints: `interactive` (Depends on session_metadata from
  fiber.shared_model_context.v1.); `fiber ask` (Headless resume should use
  persisted session_metadata when available.).
- Baseline: known-gap. Sessions do not yet persist enough normalized
  tool-result history for reliable retry diagnosis.
- Target: diagnoses the last failure first; never blindly repeats an unknown
  command.

### `tool-failure-explanation`

- Prompt: "Why did this tool fail?"
- Expect first: latest tool-result inspection: answer from the latest tool
  result when present.
- Forbidden: `shell`, `ask_user_question`.
- Expected: explains the latest tool failure from recorded evidence; no setup
  commands unless the evidence is missing.
- Deterministic coverage: runtime unit test, planned. Needs normalized
  latest-tool-result evidence before a deterministic runtime test can assert.
- Model-backed eval: not required. This should become a deterministic
  session-history contract once latest-tool evidence is normalized.
- Covered entrypoints: `interactive` (Uses session_metadata from
  fiber.shared_model_context.v1.); `fiber ask` (Uses persisted session_metadata
  when a headless session is resumed.).
- Baseline: known-gap. No durable normalized latest-tool-failure contract
  across entrypoints.
- Target: answers from the latest tool result, or clearly says the evidence is
  unavailable.

### `gateway-retry-recovery`

- Prompt: "Provider returned 429, recover without repeating local tool actions."
- Expect first: runtime retry without tool replay: no tool call; gateway
  status retry happens inside the transport before any local tool selection or
  replay.
- Forbidden: `write_file`, `edit_file`, `shell`, `ask_user_question`.
- Expected: retries bounded provider rate-limit or transient 5xx failures,
  respects `Retry-After` when present, never duplicates local mutating tool
  actions.
- Deterministic coverage: runtime unit test, implemented. `gateway/client.zig`
  unit coverage asserts retryable 429/5xx policy and bounded `Retry-After`
  delay selection.
- Model-backed eval: not required. Provider retry is deterministic transport
  behavior, not model routing.
- Covered entrypoints: `fiber ask` (Uses the shared gateway transport path.);
  `interactive` (Uses the same gateway client in interactive turns.); `ACP`
  (Uses the same agent runtime gateway transport.).
- Baseline: passing. Retry policy covers 429, 500, 502, 503, 504 with bounded
  backoff and `Retry-After` seconds.
- Target: transient provider failures retried before surfacing an error; local
  tools never replayed as part of retry.

### `finish-reason-length-no-duplicate-mutation`

- Prompt: "The provider hit a length limit while returning tool calls."
- Expect first: clear blocker without tool execution: no tool call; the
  runtime must stop before permission or execution when a length-truncated
  completion includes tool calls.
- Forbidden: `write_file`, `edit_file`, `shell`.
- Expected: preserves the latest partial answer, surfaces a clear
  provider-length blocker, never executes or asks approval for returned tool
  calls.
- Deterministic coverage: runtime unit test, implemented. `agent_runtime.zig`
  coverage asserts length-truncated `write_file` calls produce no permission
  requests and no execution.
- Model-backed eval: not required. The blocker is deterministic runtime behavior
  after a provider finish_reason.
- Covered entrypoints: `fiber ask` (Shares processQueuedPrompt length
  handling.); `interactive` (Shares the same agent runtime stop behavior.);
  `ACP` (Shares the same runtime path over JSON-RPC.).
- Baseline: passing. Runtime blocks untrusted tool calls from length-truncated
  or incomplete completions and records the partial assistant text.
- Target: no mutating tool call duplicated or executed from a truncated
  provider response.

## Frustration

### `frustrated-user-progress-check`

- Prompt: "This is taking too long. What are you doing?"
- Expect first: concise progress and next step: model choice; answer from
  context or use a tool only when needed for an accurate update.
- Forbidden: none.
- Expected: acknowledges the status concern briefly; states current work,
  latest finding or blocker, next action. No defensiveness, no step-by-step
  narration.
- Deterministic coverage: e2e, implemented. Interactive request-shape coverage
  queues the exact text with normal tools and no phrase-specific overlay.
- Model-backed eval: required. Tone, brevity, and interruption handling are
  model-visible prompt behavior.
- Covered entrypoints: `interactive` (Interactive mode should answer the
  user-visible interruption before more tool work.); `fiber ask` (Headless
  resumed sessions should answer from available context when the prompt is
  status-style.).
- Baseline: partial. The host no longer classifies the wording; this row
  measures whether the model gives a useful, proportionate response.
- Target: short status update: current work, latest finding or blocker, next
  action; tool use only for needed evidence.

## Large output

### `large-output-retained`

- Prompt: "Large command output is needed later."
- Expect first: command with retained evidence: `shell`.
- Forbidden: `ask_user_question`.
- Expected: runs or plans the large-output command with an explicit retention
  strategy, or states the current limitation before truncating useful evidence.
- Deterministic coverage: session JSON test, planned. Needs later large-result
  storage/session metadata before durable evidence handles can be asserted.
- Model-backed eval: not required. Large output retention should become a
  runtime/session contract once durable handles are available.
- Covered entrypoints: `fiber ask` (Depends on session_metadata and
  available_tools from fiber.shared_model_context.v1.); `interactive`
  (Interactive sessions should preserve the same large-output evidence
  contract.).
- Baseline: known-gap. Tool outputs are bounded for model context and expose no
  durable large-result handles yet.
- Target: explicit handle or limitation preserved so a later turn can recover
  the evidence.

### `long-running-command-visibility`

- Prompt: "A dev server is running in the background; show me its status and
  logs."
- Expect first: managed shell status: `shell`. Use the owned handle from
  `shell.run`, then `shell.interact` for a bounded output delta without
  rediscovering or replaying the process.
- Forbidden: `ask_user_question`.
- Expected: reports the owned session id, command state, bounded recent output.
  No command rerun, no filesystem log path exposed.
- Deterministic coverage: e2e, implemented. Managed execution coverage proves
  one handle, ordered output deltas, bounded retention, wait continuity, opaque
  replay handles.
- Model-backed eval: not required. The owned-handle and output-delta contract is
  deterministic runtime behavior.
- Covered entrypoints: `interactive` (Ctrl-X exposes managed process state.);
  `fiber ask` (Process-local shell handles remain available for the ask
  lifetime.).
- Baseline: passing. `shell.interact` exposes only fiber-owned execution
  output for the exact returned handle.
- Target: long-running commands inspectable through the same handle without
  replay or invented PID/log authority.

## Resume

### `continue-resume-intent`

- Prompt: "Continue."
- Expect first: context-grounded response or action: model choice; answer
  directly or use a tool when the conversation requires it.
- Forbidden: none.
- Expected: continues the prior task when context suffices, or summarizes the
  blocker instead of asking a vague question.
- Deterministic coverage: runtime unit test, implemented. `processQueuedPrompt`
  tests assert exact user text, normal tool schemas, no phrase-specific system
  overlay.
- Model-backed eval: required. Context-grounded continuation and tool choice are
  model behavior.
- Covered entrypoints: `interactive` (Depends on session_metadata in
  fiber.shared_model_context.v1.); `fiber ask` (Applies when --session or
  persisted session resume is used.).
- Baseline: partial. Prompt follows the normal message path; answer quality
  depends on available conversation and session context.
- Target: continues or reports the exact blocker using prior context.

### `status-question-current-context`

- Prompt: "What are you doing right now?"
- Expect first: context-grounded status response or action: model choice.
- Forbidden: none.
- Expected: current objective, latest meaningful progress or blocker, next step
  from existing context. No new tool plan started.
- Deterministic coverage: e2e, implemented. Ask and interactive request-shape
  coverage preserves exact text and normal tools without a phrase-specific
  overlay.
- Model-backed eval: required. Recognizing a status-style interruption and
  answering from context is model behavior.
- Covered entrypoints: `fiber ask` (Applies to resumed or current-context
  headless turns when prior session context is available.); `interactive`
  (Interactive mode should answer the interruption before continuing tool
  work.).
- Baseline: partial. Host supplies normal conversation context and tools; the
  row measures whether the model uses them well.
- Target: concise status grounded in goal, last progress, blocker if any, next
  step; tools only for needed evidence.

### `continue-after-progress-update`

- Prompt: "Continue from the last useful progress update."
- Expect first: resume from prior progress context: model choice.
- Forbidden: none.
- Expected: resumes from the latest milestone or blocker; no vague question,
  no repeated setup work.
- Deterministic coverage: runtime unit test, implemented.
  `processQueuedPrompt` preserves exact continuation text and normal tools
  without a phrase-specific overlay.
- Model-backed eval: required. Choosing a useful continuation from prior
  progress is model behavior.
- Covered entrypoints: `interactive` (Uses transcript context and any
  session_metadata available under the shared context contract.); `fiber ask`
  (Applies when --session or persisted session resume includes the previous
  progress text.).
- Baseline: partial. Continuation prompts use the normal message path;
  available context depends on transcript and session history.
- Target: continues from the latest meaningful update or states the exact
  blocker.
