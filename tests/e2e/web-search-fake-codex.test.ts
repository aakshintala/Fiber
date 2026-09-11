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
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 15_000;

type PermissionAction = "allow" | "ask" | "deny" | null;

function createIsolatedRoot(
  webSearchPermission: PermissionAction = "allow",
  settings: Record<string, unknown> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-web-search-codex-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  const permission: Record<string, Record<string, string>> = {};
  if (webSearchPermission) permission.web_search = { "*": webSearchPermission };
  writeFileSync(join(home, ".fiber", "settings.json"), JSON.stringify({ ...settings, permission }));
  return { root, home, workspace: realpathSync(workspace) };
}

function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout.trim()) as { data: unknown }).data as {
    output: string;
    tool_calls: Array<{
      name: string;
      status: string;
      web_search?: { searches: number; duration_ms: number };
    }>;
  };
}

function toolNames(body: string): string[] {
  return (JSON.parse(body).tools ?? []).map((tool: { name?: string }) => tool.name);
}

describe("web_search Codex fixture", () => {
  test(
    "web_search call with no configured backend fails without a worker retry",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({
        route: (body) => {
          const items = JSON.parse(body).input ?? [];
          if (items.some((item: any) => item.type === "function_call_output")) {
            return codexFinalText("The native search call was rejected.");
          }
          return codexToolCall("search_outer_1", "web_search", { query: "latest Zig release" });
        },
      });
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Search the web for the latest Zig release."],
          {
            cwd: root.workspace,
            env: fakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.output).toContain("native search call was rejected");
        expect(json.tool_calls).toHaveLength(1);
        expect(json.tool_calls[0].name).toBe("web_search");
        expect(json.tool_calls[0].status).toBe("error");
        expect(codex.requests).toHaveLength(2);
        expect(codex.requests[1].body).toContain(
          "web_search is unavailable: no local runtime with a configured Gateway transport policy is installed",
        );
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "deny permission omits web_search from the advertised tools",
    async () => {
      const root = createIsolatedRoot("deny");
      const codex = startFakeCodex();
      try {
        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Search current Zig release information."],
          {
            cwd: root.workspace,
            env: fakeCodexEnv(root.home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.output).toContain("FAKE_CODEX_RESPONSE");
        expect(json.tool_calls).toHaveLength(0);
        expect(codex.requests).toHaveLength(1);
        expect(toolNames(codex.requests[0].body)).not.toContain("web_search");
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "default ask applies environment model, permission, and step-limit overrides",
    async () => {
      const root = createIsolatedRoot(null, {
        model: FAKE_CODEX_DEFAULT_MODEL,
        permission_mode: "ask",
        max_agent_steps: 9,
      });
      const codex = startFakeCodex({
        route: () => codexToolCall("write_outer_1", "write_file", {
          path: "env-proof.txt",
          content: "environment overrides applied",
        }),
      });
      try {
        const result = await runFx(
          ["ask", "Write the environment override proof file."],
          {
            cwd: root.workspace,
            env: fakeCodexEnv(root.home, codex, {
              FIBER_PERMISSION_MODE: "auto",
              FIBER_MAX_AGENT_STEPS: "1",
            }),
            timeoutMs: TIMEOUT,
          },
        );

        expect(codex.requests).toHaveLength(1);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Agent step limit reached");
        expect(JSON.parse(codex.requests[0].body).model).toBe(FAKE_CODEX_DEFAULT_MODEL);
        expect(readFileSync(join(root.workspace, "env-proof.txt"), "utf8")).toBe(
          "environment overrides applied",
        );
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
