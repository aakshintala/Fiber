import { describe, expect, test } from "bun:test";
import {
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
  chatGptAccessToken,
  codexFinalText,
  codexToolCall,
  fakeCodexEnv,
  seededFakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const FETCH_URL = "https://example.com/docs";

type PermissionAction = "allow" | "deny" | null;

function codexMultiCall(calls: Array<{ id: string; name: string; args: object }>): string {
  const parts: string[] = [];
  calls.forEach((call, index) => {
    parts.push(`data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "function_call", call_id: call.id, name: call.name },
    })}\n\n`);
    parts.push(`data: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      output_index: index,
      arguments: JSON.stringify(call.args),
    })}\n\n`);
  });
  parts.push(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
  );
  return parts.join("");
}

function isFollowUp(body: string): boolean {
  return (JSON.parse(body).input ?? []).some(
    (item: { type?: string }) => item.type === "function_call_output",
  );
}

function codexRoute(
  calls: Array<{ id: string; name: string; args: object }>,
  finalText: string,
) {
  return (body: string) =>
    isFollowUp(body) ? codexFinalText(finalText) : codexMultiCall(calls);
}

function createIsolatedRoot(args: {
  webFetchPermission?: PermissionAction;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-web-fetch-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  const permission: Record<string, Record<string, string>> = {};
  if (args.webFetchPermission) {
    permission.web_fetch = { "domain:example.com": args.webFetchPermission };
  }
  writeFileSync(join(home, ".fiber", "settings.json"), JSON.stringify({ permission }));
  return { root, home, workspace: realpathSync(workspace) };
}

function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout.trim()) as { data: unknown }).data as {
    output: string;
    session_id: string;
    tool_calls: Array<{
      name: string;
      status: string;
      web_fetch?: {
        url: string;
        bytes: number;
        status: number;
        duration_ms: number;
        cache_hit: boolean;
        artifact: "none" | "stored" | "unavailable";
      };
    }>;
  };
}

function toolSchema(body: string, name: string) {
  return (JSON.parse(body).tools ?? []).find(
    (tool: { name?: string }) => tool.name === name,
  );
}

function expectWebFetchSchema(body: string) {
  const schema = toolSchema(body, "web_fetch");
  expect(schema).toBeDefined();
  expect(schema?.type).toBe("function");
  expect(schema?.parameters.type).toBe("object");
  expect(schema?.parameters.properties.url.type).toBe("string");
  expect(schema?.parameters.properties.prompt).toBeUndefined();
  expect(schema?.parameters.required).toEqual(["url"]);
  expect(schema?.parameters.additionalProperties).toBe(false);
}

function expectNoFetchProgress(text: string) {
  expect(text).not.toContain("Fetching ");
  expect(text).not.toContain("Converting ");
  expect(text).not.toContain("Extracting ");
}

describe("web_fetch fake Codex fixture", () => {
  test(
    "the advertised web_fetch tool schema is strict public shape",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex();
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Say schema ok."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        parseFxJson(result);
        expect(codex.requests).toHaveLength(1);
        expectWebFetchSchema(codex.requests[0].body);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "invalid credentialed web_fetch persists no URL credentials",
    async () => {
      const root = createIsolatedRoot({ webFetchPermission: "allow" });
      const codex = startFakeCodex({
        route: codexRoute(
          [{ id: "fetch_outer_1", name: "web_fetch", args: { url: "https://user:pass@example.com/docs" } }],
          "validation failure handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "Issue invalid credentialed web_fetch."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.tool_calls).toContainEqual({
          name: "web_fetch",
          status: "error",
        });
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain("credential-bearing URLs");
        expectNoFetchProgress(result.stderr);

        const sessionEvents = readFileSync(
          join(root.home, ".fiber", "sessions", json.session_id, "events.jsonl"),
          "utf8",
        );
        expect(sessionEvents).toContain("web_fetch");
        expect(sessionEvents).not.toContain("user:pass");
        expect(sessionEvents).toContain("https://[redacted]@example.com/docs");
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "default policy validates malformed web_fetch before transport",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({
        route: codexRoute(
          [{ id: "fetch_outer_1", name: "web_fetch", args: { url: FETCH_URL, prompt: "legacy" } }],
          "validation failure handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Issue malformed web_fetch."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.tool_calls).toContainEqual({ name: "web_fetch", status: "error" });
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain("web_fetch field");
        expect(codex.requests[1].body).toContain("prompt");
        expect(codex.requests[1].body).not.toContain("permission_required");
        expectNoFetchProgress(result.stderr);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "default fiber ask validates malformed web_fetch before transport",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({
        route: codexRoute(
          [{ id: "fetch_outer_1", name: "web_fetch", args: { url: FETCH_URL, prompt: "legacy" } }],
          "direct validation handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "Issue malformed web_fetch."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain("web_fetch field");
        expect(codex.requests[1].body).toContain("prompt");
        expect(codex.requests[1].body).not.toContain("permission_required");
        expectNoFetchProgress(result.stderr);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "auto parallel invalid web_fetch does not suppress a valid read_file sibling",
    async () => {
      const root = createIsolatedRoot();
      writeFileSync(join(root.workspace, "fixture.txt"), "parallel sibling read");
      const codex = startFakeCodex({
        route: codexRoute(
          [
            { id: "fetch_outer_1", name: "web_fetch", args: { url: "https://example.com/docs", prompt: "legacy" } },
            { id: "read_outer_1", name: "read_file", args: { path: "fixture.txt" } },
          ],
          "parallel invalid handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Issue malformed web_fetch and a sibling read."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        parseFxJson(result);
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain("web_fetch field");
        expect(codex.requests[1].body).toContain("prompt");
        expect(codex.requests[1].body).toContain("not allowed");
        expect(codex.requests[1].body).toContain("parallel sibling read");
        expectNoFetchProgress(result.stderr);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "parallel fallback reports invalid web_fetch once in Ask JSON",
    async () => {
      const root = createIsolatedRoot();
      writeFileSync(join(root.workspace, "fixture.txt"), "parallel fallback read");
      const codex = startFakeCodex({
        route: codexRoute(
          [
            { id: "fetch_outer_1", name: "web_fetch", args: { url: "https://example.com/docs", prompt: "legacy" } },
            { id: "read_outer_1", name: "read_file", args: { path: "fixture.txt" } },
            { id: "read_outer_2", name: "read_file", args: { path: "fixture.txt" } },
            { id: "read_outer_3", name: "read_file", args: { path: "fixture.txt" } },
          ],
          "parallel fallback handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Issue invalid fetch and repeated reads."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(
          json.tool_calls.filter((call) => call.name === "web_fetch"),
        ).toEqual([{ name: "web_fetch", status: "error" }]);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "explicit configured deny returns policy_denied with no fetch progress",
    async () => {
      const root = createIsolatedRoot({ webFetchPermission: "deny" });
      const codex = startFakeCodex({
        route: codexRoute(
          [{ id: "fetch_outer_1", name: "web_fetch", args: { url: FETCH_URL } }],
          "fetch denial handled",
        ),
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Issue denied web_fetch."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.tool_calls).toContainEqual({ name: "web_fetch", status: "error" });
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain("policy_denied");
        expect(json.output).toContain("fetch denial handled");
        expectNoFetchProgress(result.stderr);
        expectNoFetchProgress(json.output);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

});
