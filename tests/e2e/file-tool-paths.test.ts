import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";
import {
  codexFinalText,
  codexInputItems,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  seededFakeCodexEnv,
  startFakeCodex,
} from "./tmux-helpers";

// Migration ledger (gateway -> Codex-only runtime):
// - The Vercel AI Gateway seam was removed (fiber-product-transition: "Fiber is
//   Codex-only at cutover. Remove Vercel AI Gateway"), so every fake-gateway
//   harness here becomes the fake-Codex Responses fixture with a seeded
//   ChatGPT login. Tool results ride function_call_output items matched by
//   call_id; review requests carry <permission_review> and are answered from a
//   separate review queue without consuming the turn queue.
// - Deleted 2 live cases ("live Gateway reads an active added root...",
//   "live Gateway uses shell for removed filesystem operations"): they drive
//   the removed Gateway live-verification transport via FX_GATEWAY_BASE_URL,
//   and a Codex-only live run requires a real ChatGPT login that an isolated
//   fixture home cannot have. Superseded, not regressed.
// - "missing HOME returns HomeNotSet..." rewritten: with HOME unset the ask
//   now exits 1 with {ok:false,error:"HomeNotSet"} before any model request
//   (verified against zig-out/bin/fiber), so the tool-result-level HomeNotSet
//   pin is unreachable; the case still pins HomeNotSet and that tilde is never
//   resolved into the workspace.

const TIMEOUT = 20_000;
const MODEL = FAKE_CODEX_DEFAULT_MODEL;
const REMOVED_FILESYSTEM_TOOLS = [
  "list_files",
  "file_info",
  "delete_file",
  "rename_file",
  "copy_file",
  "create_folder",
  "semantic_search",
  "open_file",
] as const;

type CodexQueue = ReturnType<typeof startFakeCodex>;

function reviewDecision(decision: "clear" | "caution", id: string): string {
  return codexToolCall(id, "permission_decision", {
    risk: decision === "caution" ? "high" : "low",
    decision,
    rationale: "test fixture",
  });
}

type CodexResponse = string | ((body: string) => string | Promise<string>);

// The Codex helper serves one callback instead of a finite queue, so scripted
// multi-step turns pop responses in order, awaiting async fixture steps.
// Unresolved actions pause for a permission review round-trip; review requests
// carry <permission_review> and answer from a separate decision queue without
// consuming the scripted turn queue, and stay out of `requests` so turn
// indices match the gateway era.
function startCodexQueue(
  responses: CodexResponse[],
  reviewResponses: CodexResponse[] = [],
): CodexQueue & { reviewRequests: Array<{ body: string }> } {
  const pending = [...responses];
  const reviews = [...reviewResponses];
  const turnRequests: CodexQueue["requests"] = [];
  const reviewRequests: Array<{ body: string }> = [];
  let fallbackReviews = 0;
  const codex = startFakeCodex({
    route: async (body: string) => {
      if (body.includes("<permission_review>")) {
        reviewRequests.push({ body });
        const next = reviews.shift();
        if (!next) {
          fallbackReviews += 1;
          return reviewDecision("clear", `review_decision_${fallbackReviews}`);
        }
        return typeof next === "function" ? await next(body) : next;
      }
      turnRequests.push({ path: "", authorization: null, body });
      const next = pending.shift();
      if (!next) return codexFinalText("unexpected turn");
      return typeof next === "function" ? await next(body) : next;
    },
  });
  return { ...codex, requests: turnRequests, reviewRequests };
}

function codexEnv(
  root: ReturnType<typeof createIsolatedRoot>,
  codex: CodexQueue,
  extra: Record<string, string | undefined> = {},
) {
  return seededFakeCodexEnv(root.home, codex, {
    FIBER_MODEL: MODEL,
    ...extra,
  });
}

// Tool results ride the Responses input as function_call_output items; the
// output string is the tool's plain-text result.
function toolResultText(body: string, toolCallId: string): string {
  const result = codexInputItems(body).find(
    (item) =>
      item.type === "function_call_output" && item.call_id === toolCallId,
  );
  expect(result).toBeDefined();
  expect(typeof result!.output).toBe("string");
  return result!.output as string;
}

function createIsolatedRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-file-paths-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(join(home, ".fiber", "settings.json"), "{}");
  return {
    root,
    home: realpathSync(home),
    workspace: realpathSync(workspace),
    external: realpathSync(external),
  };
}

function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  if (result.code !== 0) {
    throw new Error(
      `fiber exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return (JSON.parse(result.stdout.trim()) as { data: unknown }).data as {
    output: string;
    tool_calls: Array<{ name: string; status: string }>;
  };
}

function firstCallToolResponses(args: {
  id: string;
  name: string;
  input: object;
  expectedResultRequest: string[];
  expectedResultOutput: string[];
  finalMessage: string;
  beforeToolCall?: () => void;
}): CodexResponse[] {
  return [
    (body) => {
      expect(body).not.toContain("target outside workspace");
      expect(body).not.toContain("use a target inside the workspace");
      expect(body).not.toContain("Not executed");
      args.beforeToolCall?.();
      return codexToolCall(args.id, args.name, args.input);
    },
    (body) => {
      expect(body).not.toContain("target outside workspace");
      expect(body).not.toContain("use a target inside the workspace");
      const resultOutput = toolResultText(body, args.id);
      expect(resultOutput).not.toContain("Not executed");
      for (const expected of args.expectedResultRequest) {
        expect(body).toContain(expected);
      }
      for (const expected of args.expectedResultOutput) {
        expect(resultOutput).toContain(expected);
      }
      return codexFinalText(args.finalMessage);
    },
  ];
}

async function runFirstCallToolScenario(args: {
  root: ReturnType<typeof createIsolatedRoot>;
  id: string;
  name: string;
  input: object;
  expectedResultRequest: string[];
  expectedResultOutput: string[];
  expectedReviews?: number;
  beforeToolCall?: () => void;
}) {
  const codex = startCodexQueue(firstCallToolResponses({
    ...args,
    finalMessage: "tool result handled",
  }));
  try {
    const result = await runFx(
      ["ask", "--permission-mode", "auto", "--json", "--no-save", "Execute the requested file tool once."],
      {
        cwd: args.root.workspace,
        env: codexEnv(args.root, codex),
        timeoutMs: TIMEOUT,
      },
    );
    const json = parseFxJson(result);

    expect(codex.requests).toHaveLength(2);
    expect(codex.reviewRequests).toHaveLength(args.expectedReviews ?? 0);
    expect(codex.requests[0].body).not.toContain(args.id);
    expect(codex.requests[0].body).not.toContain("target outside workspace");
    expect(json.tool_calls).toEqual([{ name: args.name, status: "success" }]);
    const progressLines = result.stderr.split("\n").filter((line) =>
      line.length > 0 && !line.startsWith("[notice]")
    );
    expect(progressLines.length).toBeGreaterThan(0);
    expect(new Set(progressLines).size).toBe(progressLines.length);
  } finally {
    codex.stop();
  }
}

async function runTerminalToolScenario(args: {
  root: ReturnType<typeof createIsolatedRoot>;
  id: string;
  name: string;
  input: object;
  expectedResultRequest: string[];
}) {
  const codex = startCodexQueue([
    codexToolCall(args.id, args.name, args.input),
    codexFinalText("tool result handled"),
  ]);
  try {
    const result = await runFx(
      ["ask", "--permission-mode", "auto", "--json", "--no-save", "Execute the requested file tool once."],
      {
        cwd: args.root.workspace,
        env: codexEnv(args.root, codex),
        timeoutMs: TIMEOUT,
      },
    );
    const json = parseFxJson(result);

    expect(codex.requests).toHaveLength(2);
    expect(codex.reviewRequests).toHaveLength(0);
    expect(codex.requests[0].body).not.toContain(args.id);
    expect(toolResultText(codex.requests[1].body, args.id)).not.toContain(
      "Not executed",
    );
    for (const expected of args.expectedResultRequest) {
      expect(codex.requests[1].body).toContain(expected);
    }
    expect(json.tool_calls).toEqual([{ name: args.name, status: "error" }]);
  } finally {
    codex.stop();
  }
}

describe("filesystem path handling", () => {
  test(
    "empty optional search paths use the workspace root",
    async () => {
      const root = createIsolatedRoot();
      try {
        const fixture = join(root.workspace, "empty-root.txt");
        writeFileSync(fixture, "EMPTY_ROOT_NEEDLE\n");
        const cases = [
          {
            id: "glob_empty_root_1",
            name: "glob_files",
            input: { pattern: "empty-root.txt", path: "" },
            expected: "empty-root.txt",
          },
          {
            id: "grep_empty_root_1",
            name: "grep_files",
            input: { pattern: "EMPTY_ROOT_NEEDLE", path: "" },
            expected: "EMPTY_ROOT_NEEDLE",
          },
        ];

        for (const scenario of cases) {
          await runFirstCallToolScenario({
            root,
            id: scenario.id,
            name: scenario.name,
            input: scenario.input,
            expectedResultRequest: [root.workspace],
            expectedResultOutput: [scenario.expected],
          });
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "active added roots reach read cwd and search admission without loading their instructions",
    async () => {
      const root = createIsolatedRoot();
      const sentinel = "ADDED_ROOT_AGENTS_SENTINEL_MUST_NOT_LOAD";
      try {
        writeFileSync(join(root.external, "AGENTS.md"), sentinel + "\n");
        writeFileSync(join(root.external, "fixture.txt"), "ADDED_ROOT_NEEDLE\n");

        const cases = [
          {
            id: "added_read_1",
            name: "read_file",
            input: { path: join(root.external, "fixture.txt"), line_count: 10 },
            expected: "ADDED_ROOT_NEEDLE",
          },
          {
            id: "added_search_1",
            name: "grep_files",
            input: { pattern: "ADDED_ROOT_NEEDLE", path: root.external },
            expected: "fixture.txt",
          },
          {
            id: "added_cwd_1",
            name: "shell",
            input: { request: { action: "run", yield_time_ms: 30_000, command: "pwd", cwd: root.external } },
            expected: root.external,
          },
        ];

        for (const scenario of cases) {
          const codex = startCodexQueue([
            codexToolCall(scenario.id, scenario.name, scenario.input),
            codexFinalText("added root tool complete"),
          ]);
          try {
            const result = await runFx(
              [
                "--add-dir",
                root.external,
                "ask",
                "--permission-mode", "auto",
                "--json",
                "--no-save",
                "Execute the requested tool once.",
              ],
              {
                cwd: root.workspace,
                env: codexEnv(root, codex),
                timeoutMs: TIMEOUT,
              },
            );
            const json = parseFxJson(result);
            expect(codex.requests).toHaveLength(2);
            for (const request of codex.requests) {
              expect(request.body).not.toContain(sentinel);
              expect(request.body).not.toContain("target outside workspace");
              expect(request.body).not.toContain("context_deferred");
            }
            const toolOutput = toolResultText(
              codex.requests[1]!.body,
              scenario.id,
            );
            expect(toolOutput).not.toContain("Not executed");
            expect(toolOutput).toContain(scenario.expected);
            expect(json.tool_calls.map(({ name, status }) => ({ name, status }))).toEqual([
              { name: scenario.name, status: "success" },
            ]);
          } finally {
            codex.stop();
          }
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "captured commands write through an active added root",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.external, "command-proof.txt");
      const codex = startCodexQueue([
        codexToolCall("added_command_write_1", "shell", { request: {
          action: "run",
          yield_time_ms: 30_000,
          timeout_ms: 600_000,
          command: "printf COMMAND_ADDED_WRITE > command-proof.txt",
          cwd: root.external,
        } }),
        codexFinalText("command write complete"),
      ], [reviewDecision("clear", "added_command_review_1")]);
      try {
        const result = await runFx(
          [
            "--add-dir",
            root.external,
            "ask",
            "--permission-mode", "auto",
            "--json",
            "--no-save",
            "Write the requested fixture once.",
          ],
          {
            cwd: root.workspace,
            env: codexEnv(root, codex),
            timeoutMs: TIMEOUT,
          },
        );
        const json = parseFxJson(result);
        expect(readFileSync(marker, "utf8")).toBe("COMMAND_ADDED_WRITE");
        expect(json.tool_calls.map(({ name, status }) => ({ name, status }))).toEqual([
          { name: "shell", status: "success" },
        ]);
        expect(codex.reviewRequests).toHaveLength(1);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "read_file expands home and canonicalizes relative and absolute external aliases",
    async () => {
      const root = createIsolatedRoot();
      try {
        const homeFile = join(root.home, "fiber-path-fixture.txt");
        const externalFile = join(root.external, "fiber-path-fixture.txt");
        writeFileSync(homeFile, "HOME_FIXTURE_CONTENT\n");
        writeFileSync(externalFile, "EXTERNAL_FIXTURE_CONTENT\n");

        const cases = [
          {
            id: "read_home_1",
            path: "~/fiber-path-fixture.txt",
            canonical: homeFile,
            content: "HOME_FIXTURE_CONTENT",
          },
          {
            id: "read_relative_1",
            path: "../external/fiber-path-fixture.txt",
            canonical: externalFile,
            content: "EXTERNAL_FIXTURE_CONTENT",
          },
          {
            id: "read_absolute_1",
            path: externalFile,
            canonical: externalFile,
            content: "EXTERNAL_FIXTURE_CONTENT",
          },
        ];

        for (const scenario of cases) {
          await runFirstCallToolScenario({
            root,
            id: scenario.id,
            name: "read_file",
            input: { path: scenario.path },
            expectedResultRequest: [scenario.canonical],
            expectedResultOutput: [
              `<path>${scenario.canonical}</path>`,
              scenario.content,
            ],
          });
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "shell reviews and executes external working-directory aliases",
    async () => {
      const root = createIsolatedRoot();
      try {
        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({ sandbox: "none" }),
        );
        const cases = [
          { id: "cwd_absolute", cwd: root.external, canonical: root.external },
          { id: "cwd_relative", cwd: "../external", canonical: root.external },
          { id: "cwd_home", cwd: "~", canonical: root.home },
        ];

        for (const scenario of cases) {
          const marker = join(scenario.canonical, `${scenario.id}.txt`);
          const codex = startCodexQueue([
            codexToolCall(scenario.id, "shell", { request: {
              action: "run",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
              command: `pwd; printf ${scenario.id} > ${scenario.id}.txt`,
              cwd: scenario.cwd,
            } }),
            codexFinalText("external cwd complete"),
          ], [reviewDecision("clear", `${scenario.id}_review_1`)]);
          try {
            const result = await runFx(
              ["ask", "--permission-mode", "auto", "--json", "--no-save", "Run the requested command once."],
              {
                cwd: root.workspace,
                env: codexEnv(root, codex),
                timeoutMs: TIMEOUT,
              },
            );
            const json = parseFxJson(result);
            expect(codex.requests).toHaveLength(2);
            expect(codex.reviewRequests).toHaveLength(1);
            expect(codex.reviewRequests[0]!.body).toContain(
              `cwd: ${scenario.canonical}`,
            );
            expect(codex.requests[1]!.body).toContain(scenario.canonical);
            expect(codex.requests[1]!.body).not.toContain("target outside workspace");
            expect(codex.requests[1]!.body).not.toContain("Not executed");
            expect(readFileSync(marker, "utf8")).toBe(scenario.id);
            expect(
              json.tool_calls.map(({ name, status }) => ({ name, status })),
            ).toEqual([{ name: "shell", status: "success" }]);
          } finally {
            codex.stop();
          }
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "trusted new writes bypass review while external overwrites use exact review",
    async () => {
      const root = createIsolatedRoot();
      try {
        const allowedParent = join(root.external, "missing", "nested");
        const allowedTarget = join(allowedParent, "created.txt");
        const allowedRelativePath = "../external/missing/nested/created.txt";
        const classifiedExternalTarget = join(
          root.external,
          "classified",
          "nested",
          "created.txt",
        );
        mkdirSync(join(root.external, "classified", "nested"), {
          recursive: true,
        });
        writeFileSync(classifiedExternalTarget, "BEFORE_CLASSIFIED_CONTENT");

        const classifiedScenarios = [
          {
            id: "write_trusted_local",
            path: "trusted-local.txt",
            target: join(root.workspace, "trusted-local.txt"),
            resultPath: "trusted-local.txt",
            addDir: false,
            expectedReview: false,
            preexisting: false,
          },
          {
            id: "write_trusted_added",
            path: join(root.external, "trusted", "nested", "created.txt"),
            target: join(root.external, "trusted", "nested", "created.txt"),
            resultPath: join(root.external, "trusted", "nested", "created.txt"),
            addDir: true,
            expectedReview: false,
            preexisting: false,
          },
          {
            id: "write_classified_external",
            path: "../external/classified/nested/created.txt",
            target: classifiedExternalTarget,
            resultPath: classifiedExternalTarget,
            addDir: false,
            expectedReview: true,
            preexisting: true,
          },
        ];
        for (const scenario of classifiedScenarios) {
          const codex = startCodexQueue(firstCallToolResponses({
            id: scenario.id,
            name: "write_file",
            input: { path: scenario.path, content: "CLASSIFIED_CONTENT" },
            expectedResultRequest: [scenario.path],
            expectedResultOutput: [scenario.resultPath],
            finalMessage: "classified write complete",
            beforeToolCall: () => {
              expect(existsSync(scenario.target)).toBe(scenario.preexisting);
              if (scenario.preexisting) {
                expect(readFileSync(scenario.target, "utf8")).toBe(
                  "BEFORE_CLASSIFIED_CONTENT",
                );
              }
            },
          }), scenario.expectedReview
            ? [reviewDecision("clear", `${scenario.id}_review_1`)]
            : []);
          try {
            const classified = await runFx(
              [
                ...(scenario.addDir ? ["--add-dir", root.external] : []),
                "ask",
                "--permission-mode", "auto",
                "--json",
                "--no-save",
                "Execute the requested file tool once.",
              ],
              {
                cwd: root.workspace,
                env: codexEnv(root, codex),
                timeoutMs: TIMEOUT,
              },
            );
            const classifiedJson = parseFxJson(classified);
            expect(codex.requests).toHaveLength(2);
            expect(codex.reviewRequests).toHaveLength(
              scenario.expectedReview ? 1 : 0,
            );
            if (scenario.expectedReview) {
              const reviewBody = codex.reviewRequests[0]!.body;
              expect(reviewBody).toContain("\"permission_decision\"");
              expect(reviewBody).toContain("review_context_kind: normal");
              expect(reviewBody).not.toContain("Execute the requested file tool once.");
              expect(reviewBody).not.toContain("escalation_reason:");
              expect(reviewBody).not.toContain("workspace:");
              expect(reviewBody).not.toContain("external_file_mutation");
              expect(reviewBody).toContain(`target[target]: ${scenario.target}`);
              expect(reviewBody).toContain("action: prepared_file_mutation");
              expect(reviewBody).toContain("preimage: present");
              expect(reviewBody).toContain("additions: 1");
              expect(reviewBody).toContain("deletions: 1");
              expect(reviewBody).toContain("CLASSIFIED_CONTENT");
            }
            expect(classifiedJson.tool_calls).toEqual([
              { name: "write_file", status: "success" },
            ]);
            expect(classified.stderr.match(/^Writing /gm)).toHaveLength(1);
            expect(classified.stderr).not.toContain("Auto agent approved this request");
            expect(readFileSync(scenario.target, "utf8")).toBe("CLASSIFIED_CONTENT");
          } finally {
            codex.stop();
          }
        }

        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({
            permission: {
              edit: {
                [`${root.external}/**`]: "allow",
              },
            },
          }),
        );

        await runFirstCallToolScenario({
          root,
          id: "write_allowed_1",
          name: "write_file",
          input: { path: allowedRelativePath, content: "ALLOWED_CONTENT" },
          expectedResultRequest: [allowedTarget],
          expectedResultOutput: [allowedTarget],
          beforeToolCall: () => {
            expect(existsSync(allowedParent)).toBe(false);
            expect(existsSync(allowedTarget)).toBe(false);
          },
        });
        expect(existsSync(allowedParent)).toBe(true);
        expect(readFileSync(allowedTarget, "utf8")).toBe("ALLOWED_CONTENT");
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "automatic review receives a large prepared overwrite before caution",
    async () => {
      const root = createIsolatedRoot();
      const target = join(root.external, "large-review.txt");
      const tracePath = join(root.root, "permission-trace.log");
      const longReviewRow = `review row 096: ${"x".repeat(2048)}`;
      const content = Array.from(
        { length: 192 },
        (_, index) =>
          index === 95
            ? longReviewRow
            : `review row ${String(index + 1).padStart(3, "0")}: deterministic permission evidence`,
      ).join("\n") + "\n";
      writeFileSync(target, "before\n");
      const codex = startCodexQueue([
        codexToolCall("write_large_review", "write_file", {
          path: "../external/large-review.txt",
          content,
        }),
        (body) => {
          const resultOutput = toolResultText(body, "write_large_review");
          expect(resultOutput).toContain('"reason":"review_caution"');
          expect(resultOutput).toContain("Action held after safety review");
          return codexFinalText("large reviewed write blocked");
        },
      ], [reviewDecision("caution", "large_review_caution_1")]);
      try {
        const result = await runFx(
          [
            "ask",
            "--permission-mode", "auto",
            "--json",
            "--no-save",
            "Execute the requested file tool once.",
          ],
          {
            cwd: root.workspace,
            env: codexEnv(root, codex, {
              FIBER_TRACE_LOG: tracePath,
              FIBER_TRACE_SCOPES: "permission",
            }),
            timeoutMs: TIMEOUT,
          },
        );
        const json = parseFxJson(result);

        expect(codex.requests).toHaveLength(2);
        expect(codex.reviewRequests).toHaveLength(1);
        expect(
          Buffer.byteLength(codex.reviewRequests[0]!.body),
        ).toBeGreaterThan(16 * 1024);
        expect(json.tool_calls).toEqual([
          { name: "write_file", status: "error" },
        ]);
        expect(json.output).toContain("large reviewed write blocked");
        expect(result.stderr).not.toContain("Auto agent approved this request");
        expect(readFileSync(target, "utf8")).toBe("before\n");
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).toContain(
          "event=auto_review_compose_result result=ready",
        );
        expect(trace).toContain(
          "event=auto_review_send attempt=1 max_attempts=1",
        );
        expect(trace).toContain(
          "event=auto_review_result tool_name=write_file decision=caution",
        );
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "headless automatic review caution returns advice without writing",
    async () => {
      const root = createIsolatedRoot();
      const target = join(root.external, "review-required.txt");
      writeFileSync(target, "before");
      const codex = startCodexQueue([
        codexToolCall("write_review_required", "write_file", {
          path: target,
          content: "MUST_NOT_WRITE",
        }),
        (body) => {
          expect(body).toContain("review_caution");
          return codexFinalText("write safely skipped");
        },
      ], [reviewDecision("caution", "review_required_caution_1")]);
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Attempt the requested write once."],
          {
            cwd: root.workspace,
            env: codexEnv(root, codex),
            timeoutMs: TIMEOUT,
          },
        );
        const json = parseFxJson(result);

        expect(result.code).toBe(0);
        expect(codex.requests).toHaveLength(2);
        expect(codex.reviewRequests).toHaveLength(1);
        expect(codex.reviewRequests[0]!.body).not.toContain(
          "escalation_reason:",
        );
        expect(codex.reviewRequests[0]!.body).toContain(
          `target[target]: ${target}`,
        );
        expect(codex.reviewRequests[0]!.body).not.toContain(
          "external_file_mutation",
        );
        expect(result.stdout).toContain("write safely skipped");
        expect(json.tool_calls).toEqual([
          { name: "write_file", status: "error" },
        ]);
        expect(result.stdout).not.toContain("NonInteractivePermissionRequired");
        expect(result.stderr).not.toContain("permission required");
        expect(readFileSync(target, "utf8")).toBe("before");
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "registered typed write and edit use one canonical fiber ask mutation path",
    async () => {
      const root = createIsolatedRoot();
      try {
        const target = join(root.workspace, "typed.txt");
        const tracePath = join(root.root, "trace.log");
        const codex = startCodexQueue([
          codexToolCall("typed_write_1", "write_file", {
            path: "typed.txt",
            content: "before\n",
          }),
          codexToolCall("typed_edit_1", "edit_file", {
            path: "typed.txt",
            old_string: "before",
            new_string: "after",
          }),
          codexFinalText("typed mutations complete"),
        ]);
        try {
          const result = await runFx(
            [
              "ask",
              "--permission-mode", "auto",
              "--quiet",
              "--json",
              "--no-save",
              "Execute the requested typed file mutations.",
            ],
            {
              cwd: root.workspace,
              env: codexEnv(root, codex, {
                FIBER_TRACE_LOG: tracePath,
                FIBER_TRACE_SCOPES: "core,tool",
              }),
              timeoutMs: TIMEOUT,
            },
          );
          const json = parseFxJson(result);

          expect(codex.requests).toHaveLength(3);
          expect(codex.requests[1]!.body).toContain(
            "wrote typed.txt (7 bytes)",
          );
          expect(codex.requests[2]!.body).toContain(
            "edited typed.txt (6 bytes)",
          );
          expect(codex.requests[1]!.body).not.toContain(
            "unexpected typed file callback",
          );
          expect(codex.requests[2]!.body).not.toContain(
            "unexpected typed file callback",
          );
          expect(json.tool_calls).toEqual(
            expect.arrayContaining([
              { name: "write_file", status: "success" },
              { name: "edit_file", status: "success" },
            ]),
          );
          expect(readFileSync(target, "utf8")).toBe("after\n");
          const trace = readFileSync(tracePath, "utf8");
          expect(trace).not.toContain(
            "committed file read tracker refresh failed",
          );
          expect(result.stderr).toBe(
            "Writing typed.txt\n" +
              "Editing typed.txt\n",
          );
        } finally {
          codex.stop();
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "external relative read-only tools resolve their canonical roots",
    async () => {
      const root = createIsolatedRoot();
      try {
        const externalFile = join(root.external, "fixture.txt");
        writeFileSync(externalFile, "EDGE_NEEDLE\n");

        const cases = [
          {
            id: "glob_external_1",
            name: "glob_files",
            input: { pattern: "*.txt", path: "../external" },
            expectedContext: [root.external],
            expectedResult: [externalFile],
          },
          {
            id: "grep_external_1",
            name: "grep_files",
            input: { pattern: "EDGE_NEEDLE", path: "../external" },
            expectedContext: [root.external],
            expectedResult: [externalFile, "EDGE_NEEDLE"],
          },
        ];

        for (const scenario of cases) {
          await runFirstCallToolScenario({
            root,
            id: scenario.id,
            name: scenario.name,
            input: scenario.input,
            expectedResultRequest: scenario.expectedContext,
            expectedResultOutput: scenario.expectedResult,
          });
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "glob pattern cannot escape the separately approved search root",
    async () => {
      const root = createIsolatedRoot();
      try {
        writeFileSync(join(root.external, "outside.txt"), "OUTSIDE\n");
        await runTerminalToolScenario({
          root,
          id: "glob_escape_1",
          name: "glob_files",
          input: { pattern: "../external/*.txt", path: "." },
          expectedResultRequest: ["PathOutsideWorkspace"],
        });

      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "retained edit tool honors canonical external permission targets",
    async () => {
      const root = createIsolatedRoot();
      try {
        const editTarget = join(root.external, "edit.txt");
        writeFileSync(editTarget, "BEFORE_EDIT\n");
        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({
            permission: {
              edit: {
                [`${root.external}/**`]: "allow",
              },
            },
          }),
        );

        const codex = startCodexQueue([
          codexToolCall("edit_read_1", "read_file", {
            path: "../external/edit.txt",
          }),
          (body) => {
            expect(body).not.toContain("target outside workspace");
            const readOutput = toolResultText(body, "edit_read_1");
            expect(readOutput).toContain(`<path>${editTarget}</path>`);
            expect(readOutput).toContain("BEFORE_EDIT");
            expect(readOutput).not.toContain("Not executed");
            expect(readFileSync(editTarget, "utf8")).toBe("BEFORE_EDIT\n");
            return codexToolCall("edit_apply_1", "edit_file", {
              path: "../external/edit.txt",
              old_string: "BEFORE_EDIT",
              new_string: "AFTER_EDIT",
            });
          },
          (body) => {
            const editOutput = toolResultText(body, "edit_apply_1");
            expect(editOutput).toContain(editTarget);
            expect(editOutput).not.toContain("Not executed");
            expect(readFileSync(editTarget, "utf8")).toBe("AFTER_EDIT\n");
            return codexFinalText("edit handled");
          },
        ]);
        try {
          const result = await runFx(
            [
              "ask",
              "--permission-mode", "auto",
              "--json",
              "--no-save",
              "Read and edit the requested external file.",
            ],
            {
              cwd: root.workspace,
              env: codexEnv(root, codex),
              timeoutMs: TIMEOUT,
            },
          );
          const json = parseFxJson(result);
          expect(codex.requests).toHaveLength(3);
          expect(codex.reviewRequests).toHaveLength(0);
          expect(json.tool_calls).toEqual([
            { name: "read_file", status: "success" },
            { name: "edit_file", status: "success" },
          ]);
          expect(
            (result.stderr.split("Reading ../external/edit.txt\n").length - 1),
          ).toBe(1);
          expect(
            (result.stderr.split("Editing ../external/edit.txt\n").length - 1),
          ).toBe(1);
          expect(readFileSync(editTarget, "utf8")).toBe("AFTER_EDIT\n");
        } finally {
          codex.stop();
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "missing HOME returns HomeNotSet without treating tilde as workspace-relative",
    async () => {
      const root = createIsolatedRoot();
      try {
        const literalWorkspacePath = join(
          root.workspace,
          "~",
          "fiber-path-fixture.txt",
        );
        const codex = startCodexQueue([codexFinalText("unexpected turn")]);
        try {
          const result = await runFx(
            ["ask", "--permission-mode", "auto", "--json", "--no-save", "Read the home fixture once."],
            {
              cwd: root.workspace,
              env: codexEnv(root, codex, { HOME: undefined }),
              timeoutMs: TIMEOUT,
            },
          );

          expect(result.code).toBe(1);
          const payload = JSON.parse(result.stdout.trim()) as {
            ok: boolean;
            error?: string;
          };
          expect(payload.ok).toBe(false);
          expect(payload.error).toBe("HomeNotSet");
          expect(codex.requests).toHaveLength(0);
          expect(codex.reviewRequests).toHaveLength(0);
          expect(existsSync(literalWorkspacePath)).toBe(false);
        } finally {
          codex.stop();
        }
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "removed filesystem tools are absent and shell completes the fallback flow",
    async () => {
      const root = createIsolatedRoot();
      const command =
        "mkdir -p fallback-dir && " +
        "printf fallback > fallback-source.txt && " +
        "cp fallback-source.txt fallback-dir/copied.txt && " +
        "mv fallback-dir/copied.txt fallback-dir/renamed.txt && " +
        "ls fallback-dir && " +
        "stat fallback-dir/renamed.txt && " +
        "grep -n fallback fallback-dir/renamed.txt && " +
        "rm -rf fallback-dir fallback-source.txt && " +
        "test ! -e fallback-dir && printf fallback-complete";
      const codex = startCodexQueue([
        (body) => {
          const names = (JSON.parse(body).tools ?? []).map(
            (tool: { name?: string }) => tool.name,
          );
          for (const removed of REMOVED_FILESYSTEM_TOOLS) {
            expect(names).not.toContain(removed);
          }
          expect(names).toEqual(expect.arrayContaining([
            "read_file",
            "write_file",
            "edit_file",
            "glob_files",
            "grep_files",
            "shell",
          ]));
          return codexToolCall("terminal_fallback_1", "shell", { request: {
            action: "run",
            command,
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
          } });
        },
        (body) => {
          const output = toolResultText(body, "terminal_fallback_1");
          expect(output).toContain("renamed.txt");
          expect(output).toContain("fallback");
          expect(output).toContain("fallback-complete");
          expect(existsSync(join(root.workspace, "fallback-dir"))).toBe(false);
          expect(existsSync(join(root.workspace, "fallback-source.txt"))).toBe(false);
          return codexFinalText("shell fallback complete");
        },
      ], [reviewDecision("clear", "fallback_review_1")]);

      try {
        const result = await runFx(
          [
            "ask",
            "--permission-mode", "auto",
            "--json",
            "--no-save",
            "Use the shell to create, inspect, search, copy, rename, and remove disposable files.",
          ],
          {
            cwd: root.workspace,
            env: codexEnv(root, codex),
            timeoutMs: TIMEOUT,
          },
        );
        const json = parseFxJson(result);
        expect(codex.requests).toHaveLength(2);
        expect(codex.reviewRequests).toHaveLength(1);
        expect(json.tool_calls).toEqual([
          expect.objectContaining({ name: "shell", status: "success" }),
        ]);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

});
