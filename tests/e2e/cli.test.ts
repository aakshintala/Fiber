import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  cleanupIsolatedTestHome,
  createIsolatedTestHome,
  FIBER_BIN,
  REPO_ROOT,
  runFx,
} from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const NO_GATEWAY_AUTH = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
};
const MISSING_AUTH_MESSAGE =
  "fiber needs a Codex subscription login for this model. Run fiber login codex.";
const MODERN_MCP_FIXTURE = join(
  import.meta.dirname,
  "fixtures",
  "mcp-modern-stdio.mjs",
);

function maxLineWidth(text: string): number {
  return Math.max(...text.split(/\r?\n/).map((line) => Bun.stringWidth(line)));
}

function sourceVersion(): string {
  const source = readFileSync(join(REPO_ROOT, "src/main.zig"), "utf8");
  const match = source.match(/pub const version = "([^"]+)";/);
  if (!match) throw new Error("src/main.zig version declaration not found");
  return match[1];
}

function doctorSessionDiagnosticsLimit(): number {
  const source = readFileSync(
    join(REPO_ROOT, "src/core/cli/doctor_runtime.zig"),
    "utf8",
  );
  const match = source.match(/const default_session_diagnostics_limit: usize = (\d+);/);
  if (!match) throw new Error("doctor session diagnostics limit not found");
  return Number(match[1]);
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    // Advisory lock files appear and disappear with credential loads; they are
    // not durable state, so they are excluded from the snapshot.
    if (relative.endsWith(".lock")) return;
    const info = lstatSync(path);
    entries.push(
      // Directory sizes change when lock files are created and removed; only
      // their mode matters for the durable-state comparison.
      `${relative}|${info.isDirectory() ? "dir" : "file"}|${info.mode & 0o777}|${info.isDirectory() ? 0 : info.size}`,
    );
    if (!info.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relative ? join(relative, name) : name);
    }
  };
  visit(root, "");
  return entries;
}

function writeLegacySession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    historyLen?: number;
  } = {},
): void {
  const sessionDir = join(home, ".fiber", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".fiber"), 0o700);
  chmodSync(join(home, ".fiber", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  const historyLen = opts.historyLen ?? 0;
  const authorityId = "0".repeat(32);
  writeFileSync(
    join(sessionDir, "authority.json"),
    JSON.stringify({
      schema_version: 1,
      storage_format: "event_log_v1",
      source: "native_create",
      session_id: sessionId,
      authority_id: authorityId,
    }) + "\n",
    { mode: 0o600 },
  );
  const generation = "1".repeat(32);
  const eventId = "2".repeat(32);
  const createdAtMs = opts.createdAtMs ?? 1;
  const updatedAtMs = opts.updatedAtMs ?? 2;
  const preferences = { model: "gpt-5.4-mini", effort: "medium", fast_mode: false };
  const events =
    JSON.stringify({
      schema_version: 1,
      log_generation: generation,
      seq: 1,
      event_id: eventId,
      timestamp_ms: updatedAtMs,
      kind: "session_started",
      payload: {
        id: sessionId,
        created_at_ms: createdAtMs,
        origin_workspace_root: workspaceRoot,
        workspace_root: workspaceRoot,
        conversation_language: "en",
        preferences,
      },
    }) + "\n";
  writeFileSync(join(sessionDir, "events.jsonl"), events, { mode: 0o600 });
  writeFileSync(join(sessionDir, "commit.lock"), "", { mode: 0o600 });
  const eventBytes = Buffer.byteLength(events);
  writeFileSync(
    join(sessionDir, `commit.${generation}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      log_generation: generation,
      through_seq: 1,
      through_event_id: eventId,
      through_event_log_bytes: eventBytes,
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 3,
      storage_format: "event_log_v1",
      id: sessionId,
      authority_id: authorityId,
      log_generation: generation,
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
      origin_workspace_root: workspaceRoot,
      workspace_root: workspaceRoot,
      conversation_language: "en",
      history_len: historyLen,
      total_input_tokens: 0,
      total_output_tokens: 0,
      last_event_seq: 1,
      event_log_bytes: eventBytes,
      event_log_stat_fingerprint: "0".repeat(64),
      generation_base_seq: 1,
      generation_base_bytes: 1,
      checkpoint_seq: null,
      checkpoint_sha256: null,
      preferences,
    }) + "\n",
    { mode: 0o600 },
  );
}

describe("cli: help", () => {
  test(
    "top-level help aliases render the same accurate navigation page",
    async () => {
      const outputs: string[] = [];
      for (const args of [["help"], ["--help"], ["-h"]]) {
        const result = await runFx(args);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        outputs.push(result.stdout);
      }

      expect(outputs[1]).toBe(outputs[0]);
      expect(outputs[2]).toBe(outputs[0]);
      const stdout = outputs[0]!;
      expect(stdout).not.toContain("\x1b[");
      expect(stdout).not.toContain("\x1b]2;");
      expect(stdout).toStartWith(
        `fiber v${sourceVersion()}\nFast, native coding agent for the terminal.\n`,
      );
      const header = `fiber v${sourceVersion()}\nFast, native coding agent for the terminal.\n`;
      expect(stdout.indexOf(header)).toBe(stdout.lastIndexOf(header));
      expect(stdout).toContain("fiber starts an interactive session by default.");
      expect(stdout).toContain("Commands:\n");
      expect(stdout).toContain("Run one noninteractive request");
      expect(stdout).toContain("Sign in, sign out, and inspect provider");
      expect(stdout).toContain("List available models");
      expect(stdout).not.toContain("Sign in to Vercel or a selected provider");
      expect(stdout).not.toContain("Choose the active model provider");
      expect(stdout).not.toContain("Configure a Vercel AI Gateway API key");
      expect(stdout).not.toContain("Choose a Vercel AI Gateway team");
      expect(stdout).not.toContain("Show Vercel AI Gateway credits");
      expect(stdout).not.toContain("credits|balance");
      expect(stdout).not.toContain("setup");
      expect(stdout).not.toContain("teams");
      expect(stdout).not.toContain("credits");
      expect(stdout).not.toContain("/feedback");
      expect(stdout).toContain("Flags:\n");
      expect(stdout).toContain("--context-limit <spec>");
      expect(stdout).toContain("Set name=bytes|off; repeatable");
      expect(stdout).toContain("--add-dir <path>");
      expect(stdout).toContain("--no-additional-dirs");
      expect(stdout).toContain("Ignore saved additional directories");
      expect(stdout).toContain("-h, --help");
      expect(stdout).toContain("Display this help and exit");
      expect(stdout).not.toContain("-c, --continue");
      expect(stdout).toContain("session resume [last|id]");
      expect(stdout).toContain("-v, --version");
      expect(stdout).toContain("Print the fiber version and exit");
      expect(stdout).not.toContain("Must appear before the command");
      expect(stdout).toContain("Examples:\n");
      expect(stdout).toContain(
        "Run `fiber <command> --help` for command-specific usage and options.",
      );
      expect(stdout).not.toContain("command-specific options and examples");
      expect(stdout).not.toContain("  Work      ");
      expect(stdout).not.toContain("\n\n\nRun `fiber <command> --help`");
    },
    TIMEOUT,
  );

  test(
    "fiber ask help renders documented options through both aliases",
    async () => {
      const env = {
        ...NO_GATEWAY_AUTH,
        FIBER_DISABLE_KEYCHAIN: "1",
      };
      const expected = `fiber ask

Run one noninteractive request

Usage:
  fiber ask [--permission-mode <ask|auto|yolo>] [--model <model-id>] [--effort <level>] [--fast] [--image PATH] [--system TEXT] [--json] [--quiet] [--no-save] [--resume-id <id>] [--retry] [--timeout <seconds>] [--] <prompt>

Options:
  --permission-mode <ask|auto|yolo>  Set permission handling for this request: ask prompts on a TTY, auto reviews unresolved requests, yolo disables checks
  --model <model-id>                 Use one model for this request
  --effort <level>                   Use one reasoning effort for this request
  --fast                             Use the fast tier for this request when the model supports it
  --image PATH                       Attach an image file; repeat for multiple images
  --system TEXT                      Replace the built-in system prompt for this request
  --json                             Emit machine-readable JSON instead of text
  --quiet                            Suppress assistant output
  --no-save                          Do not save the session; incompatible with --resume-id
  --resume-id <id>                   Continue a session by exact id
  --retry                            Resume the paused model response in the selected session
  --timeout <seconds>                Set the maximum request duration in seconds
  --                                 Treat every following argument as prompt text

The prompt may be passed as arguments or piped on stdin when no prompt args are given.
TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.
Operational progress and diagnostics are written to stderr. JSON \`output\` keeps accumulated assistant Markdown; \`final_output\` contains only the completed final response, or an empty string when absent.
--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.
With --permission-mode ask, JSON and quiet requests may prompt on stderr only when stdin is a TTY.
`;

      for (const alias of ["--help", "-h"]) {
        const result = await runFx(["ask", alias], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "fiber session help documents inspect resume and recover",
    async () => {
      for (const args of [
        ["session", "--help"],
        ["session", "resume", "--help"],
      ]) {
        const r = await runFx(args);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Inspect, list, rename, remove, resume, or recover saved sessions");
        expect(r.stdout).toContain("session show <last|id>|--id <id>");
        expect(r.stdout).toContain("session resume [last|<id>]");
        expect(r.stdout).toContain("session recover <id>|--id <id>");
        expect(r.stdout).not.toContain("migrate");
      }
    },
    TIMEOUT,
  );

  test(
    "fiber replay help describes golden output",
    async () => {
      const r = await runFx(["debug", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("--golden <path>");
      expect(r.stdout).toContain("Write the final rendered grid to a file");
      expect(r.stdout).not.toContain("Compare output against a golden file");
    },
    TIMEOUT,
  );

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `fiber ${alias} respects COLUMNS=60`,
      async () => {
        const r = await runFx([alias], { env: { COLUMNS: "60" } });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Commands:");
        expect(r.stdout).toContain("ask");
        expect(r.stdout).toContain("status");
        expect(r.stdout).toContain("doctor");
        expect(maxLineWidth(r.stdout)).toBeLessThanOrEqual(60);
      },
      TIMEOUT,
    );
  }

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `fiber ${alias} hides developer recording surfaces`,
      async () => {
        const r = await runFx([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("--record");
        expect(r.stdout).not.toContain("replay <tape>");
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }

  test(
    "fiber rejects the removed record flag as unknown input",
    async () => {
      const r = await runFx(["--record"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("fiber: unknown subcommand: --record");
      expect(r.stderr).not.toContain("visual terminal capture:");
    },
    TIMEOUT,
  );
});

describe("cli: version", () => {
  for (const alias of ["--version", "-v"]) {
    test(
      `fiber ${alias} prints the source version`,
      async () => {
        const r = await runFx([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${sourceVersion()}\n`);
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }
});

describe("cli: status", () => {
  test(
    "status and doctor expose the MCP profile error that blocks ask startup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-mcp-config-diagnostic-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const fxDir = join(home, ".fiber");
      mkdirSync(fxDir, { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      writeSeededChatGptLogin(home, chatGptAccessToken());
      writeFileSync(join(fxDir, "mcp.json"), "{invalid json", { mode: 0o600 });

      try {
        const env: Record<string, string | undefined> = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: undefined,
          VERCEL_OIDC_TOKEN: undefined,
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const cwd = realpathSync(workspace);
        const before = snapshotTree(home);

        const statusText = await runFx(["status"], { cwd, env });
        const statusJsonResult = await runFx(["status", "--json"], { cwd, env });
        const doctorText = await runFx(["doctor"], { cwd, env });
        const doctorJsonResult = await runFx(["doctor", "--json"], { cwd, env });
        const ask = await runFx(
          ["ask", "--json", "--no-save", "Do nothing."],
          { cwd, env },
        );

        for (const result of [statusText, statusJsonResult, doctorText, doctorJsonResult]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(statusText.stdout).toContain(
          "[status] mcp_config_error=McpConfigInvalidJson\n",
        );
        expect(JSON.parse(statusJsonResult.stdout)).toMatchObject({
          kind: "status",
          ok: true,
          data: { mcp_config_error: "McpConfigInvalidJson" },
        });
        expect(doctorText.stdout).toContain(
          "[fail] mcp_config: failed to load ~/.fiber/mcp.json: McpConfigInvalidJson\n",
        );
        const doctorJson = JSON.parse(doctorJsonResult.stdout);
        expect(doctorJson.data.fail_count).toBe(1);
        expect(
          doctorJson.data.checks.filter(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toEqual([
          {
            name: "mcp_config",
            status: "fail",
            detail: "failed to load ~/.fiber/mcp.json: McpConfigInvalidJson",
          },
        ]);
        expect(ask.code).toBe(1);
        expect(ask.stderr).toBe("");
        expect(JSON.parse(ask.stdout)).toMatchObject({
          kind: "ask",
          ok: false,
          error: "McpConfigInvalidJson",
          code: "McpConfigInvalidJson",
        });
        expect(snapshotTree(home)).toEqual(before);

        writeFileSync(
          join(fxDir, "mcp.json"),
          JSON.stringify({
            "MCP-Servers": { fixture: { command: "node" } },
          }) + "\n",
          { mode: 0o600 },
        );
        const warningStatus = await runFx(["status", "--json"], { cwd, env });
        const warningDoctor = await runFx(["doctor", "--json"], { cwd, env });
        expect(JSON.parse(warningStatus.stdout)).toMatchObject({
          data: {
            mcp_config_warning: {
              cause: "suspicious_server_key",
              key: "MCP-Servers",
              additional_matches: 0,
            },
          },
        });
        expect(
          JSON.parse(warningDoctor.stdout).data.checks.find(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toMatchObject({ status: "warn" });

        writeFileSync(join(fxDir, "mcp.json"), '{"mcp":{}}\n', { mode: 0o600 });
        const validBefore = snapshotTree(home);
        const validStatus = await runFx(["status", "--json"], { cwd, env });
        const validDoctor = await runFx(["doctor", "--json"], { cwd, env });
        expect(validStatus.code).toBe(0);
        expect(validDoctor.code).toBe(0);
        expect(JSON.parse(validStatus.stdout).data).not.toHaveProperty(
          "mcp_config_error",
        );
        expect(
          JSON.parse(validDoctor.stdout).data.checks.some(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toBe(false);
        expect(snapshotTree(home)).toEqual(validBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the missing auth snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-status-noauth-"));
      try {
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(root),
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const status = await runFx(["status", "--json"], { env });
        const doctor = await runFx(["doctor", "--json"], { env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        const doctorJson = JSON.parse(doctor.stdout.trim());
        expect(statusJson).toMatchObject({
          data: {
            auth: "missing",
            auth_refreshable: false,
            auth_help: MISSING_AUTH_MESSAGE,
          },
        });
        expect(statusJson.data).not.toHaveProperty("sandbox");
        expect(doctorJson).toMatchObject({
          data: { auth: "missing", auth_refreshable: false },
        });
        expect(doctorJson.data.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the Codex login snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-status-auth-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const cwd = realpathSync(workspace);

        const statusText = await runFx(["status"], { cwd, env });
        const statusJsonResult = await runFx(["status", "--json"], { cwd, env });
        const doctorText = await runFx(["doctor"], { cwd, env });
        const doctorJsonResult = await runFx(["doctor", "--json"], { cwd, env });

        expect(statusText.code).toBe(0);
        expect(statusJsonResult.code).toBe(0);
        expect(doctorText.code).toBe(0);
        expect(doctorJsonResult.code).toBe(0);
        const statusJson = JSON.parse(statusJsonResult.stdout.trim());
        const doctorJson = JSON.parse(doctorJsonResult.stdout.trim());
        const expectedAuth = {
          auth: "Codex subscription",
          auth_refreshable: true,
        };
        expect(statusJson).toMatchObject({
          data: { ...expectedAuth, connected_providers: ["codex"] },
        });
        expect(doctorJson).toMatchObject({ data: expectedAuth });
        for (const output of [statusText.stdout, doctorText.stdout]) {
          expect(output).toContain("auth=Codex subscription");
          expect(output).toContain("auth_refreshable=true");
        }
        expect(statusText.stdout).toContain("connected_providers=Codex");
        expect(doctorJson.data.checks.find(
          (check: { name: string }) => check.name === "auth",
        ).detail).toContain("refreshable=true");
        for (const output of [
          statusText.stdout,
          statusJsonResult.stdout,
          doctorText.stdout,
          doctorJsonResult.stdout,
        ]) {
          expect(output).not.toContain("header.");
          expect(output).not.toContain("chatgpt-refresh");
          expect(output).not.toContain("team=");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor inspect an expired login without refreshing it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-status-expired-auth-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededChatGptLogin(home, chatGptAccessToken(), {
          expiresAtMs: Date.now() - 60_000,
        });
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const cwd = realpathSync(workspace);
        const authPath = join(home, ".fiber", "chatgpt-auth.json");
        const seededAuthFile = readFileSync(authPath, "utf8");

        const status = await runFx(["status", "--json"], { cwd, env });
        const doctor = await runFx(["doctor", "--json"], { cwd, env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const expectedAuth = {
          auth: "Codex subscription",
          auth_refreshable: true,
          auth_expired: true,
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject({
          data: expectedAuth,
        });
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
          data: expectedAuth,
        });
        expect(readFileSync(authPath, "utf8")).toBe(seededAuthFile);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "a new status process ignores removed credential sources and reads the Codex login",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-status-precedence-"));
      try {
        writeSeededChatGptLogin(root, chatGptAccessToken());
        const envToken = "preferred-environment-token";
        const env = {
          HOME: realpathSync(root),
          VERCEL_OIDC_TOKEN: undefined,
          AI_GATEWAY_API_KEY: envToken,
          FIBER_DISABLE_KEYCHAIN: "1",
        };

        const status = await runFx(["status", "--json"], { env });
        const doctor = await runFx(["doctor", "--json"], { env });

        const expectedAuth = {
          auth: "Codex subscription",
          auth_refreshable: true,
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject({
          data: expectedAuth,
        });
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
          data: expectedAuth,
        });
        expect(status.stdout).not.toContain(envToken);
        expect(doctor.stdout).not.toContain(envToken);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber status --json returns valid status JSON",
    async () => {
      const r = await runFx(["status", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("status");
      expect(json.ok).toBe(true);
      expect(json.data).toHaveProperty("model");
      expect(json.data).toHaveProperty("workspace");
      expect(json.data).toHaveProperty("permission_mode");
      expect(json.data).toHaveProperty("history_turns");
      expect(json.data).toHaveProperty("agent_step_limit");
      expect(json.data.update_channel).toBe("stable");
      expect(json.data.build_channel).toBe("stable");
      expect(json.data.build_revision).toMatch(/^[0-9a-f]{12}$/);
    },
    TIMEOUT,
  );

  test(
    "fiber upgrade help documents release channels",
    async () => {
      const result = await runFx(["upgrade", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("fiber upgrade [--json]");
      expect(result.stdout).not.toContain("--channel");
    },
    TIMEOUT,
  );

  test(
    "fiber status --json defaults permission mode to auto",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-permission-default-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FIBER_PERMISSION_MODE: undefined,
          },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.data.permission_mode).toBe("auto");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor apply an exact FIBER_MAX_AGENT_STEPS override",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-agent-step-limit-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_MAX_AGENT_STEPS: "3",
        };

        const status = await runFx(["status", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout.trim()).data.agent_step_limit).toBe(3);

        const doctor = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        const startup = JSON.parse(doctor.stdout.trim()).data.checks.find(
          (check: { name: string }) => check.name === "startup",
        );
        expect(startup.detail).toContain("agent_step_limit=3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "project profile-only settings are ignored before parsing and profile overrides win",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-profile-config-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".fiber"), { recursive: true });
        mkdirSync(workspace);
        const homeRoot = realpathSync(home);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: homeRoot,
          FIBER_MODEL: undefined,
          FIBER_PERMISSION_MODE: undefined,
          FIBER_MAX_AGENT_STEPS: undefined,
        };

        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
          }) + "\n",
        );
        writeFileSync(
          join(workspace, ".fiber.json"),
          JSON.stringify({
            model: 123,
            permission_mode: "danger",
            permission: { bash: true },
            statusLine: 7,
            max_agent_steps: 7,
          }) + "\n",
        );

        const status = await runFx(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        const first = JSON.parse(status.stdout.trim()).data;
        expect(first.model).toBe("anthropic/claude-sonnet-4.6");
        expect(first.permission_mode).toBe("auto");
        expect(first.agent_step_limit).toBe(7);
        expect(status.stderr).toContain(
          "fiber: config project: ignored_project_user_only_setting; key=model",
        );
        expect(status.stderr).toContain(
          "fiber: config project: ignored_project_user_only_setting; key=permission_mode",
        );
        expect(status.stderr).toContain(
          "fiber: config project: ignored_project_user_only_setting; key=permission",
        );
        expect(status.stderr).toContain(
          "fiber: config project: ignored_project_user_only_setting; key=statusLine",
        );
        expect(status.stderr).not.toContain("danger");

        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
            workspaces: {
              [workspaceRoot]: {
                max_agent_steps: 4,
              },
            },
          }) + "\n",
        );

        const overridden = await runFx(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(overridden.code).toBe(0);
        const second = JSON.parse(overridden.stdout.trim()).data;
        expect(second.model).toBe("anthropic/claude-sonnet-4.6");
        expect(second.permission_mode).toBe("auto");
        expect(second.agent_step_limit).toBe(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "special settings files fail closed without blocking CLI startup",
    async () => {
      if (platform() === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-config-special-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const fxDir = join(home, ".fiber");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(fxDir, 0o700);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: home,
          FIBER_DISABLE_KEYCHAIN: "1",
          FIBER_SKIP_ONBOARDING: "1",
          FIBER_SOUND: "0",
        };

        expect(spawnSync("mkfifo", [join(fxDir, "settings.json")]).status).toBe(0);
        const userStartedAt = Date.now();
        const user = await runFx(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - userStartedAt).toBeLessThan(3_000);
        expect(user.code).toBe(0);
        expect(JSON.parse(user.stdout)).toMatchObject({ kind: "status" });
        expect(user.stderr).toContain("fiber: config user: durable_path_unsafe");

        rmSync(join(fxDir, "settings.json"));
        expect(spawnSync("mkfifo", [join(workspace, ".fiber.json")]).status).toBe(0);
        const projectStartedAt = Date.now();
        const project = await runFx(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - projectStartedAt).toBeLessThan(3_000);
        expect(project.code).toBe(0);
        expect(JSON.parse(project.stdout)).toMatchObject({ kind: "status" });
        expect(project.stderr).toContain("fiber: config project: durable_path_unsafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: usage", () => {
  test(
    "fiber usage reads rolling local facts without credentials or profile mutation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-usage-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".fiber");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        chmodSync(fxDir, 0o700);
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 60 * 60 * 1000,
              model: "provider/a",
              input_tokens: 15,
              output_tokens: 3,
              cache_read_tokens: 5,
              cache_write_tokens: 1,
              reasoning_tokens: 2,
              total_cost: 0.25,
            },
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAW",
              created_at_ms: now - 2 * 24 * 60 * 60 * 1000,
              model: "provider/b",
              input_tokens: 10,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: null,
              total_cost: 0.1,
            },
          },
        ];
        const usagePath = join(fxDir, "usage.jsonl");
        writeFileSync(
          usagePath,
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        chmodSync(usagePath, 0o600);
        const before = readFileSync(usagePath, "utf8");
        const entriesBefore = readdirSync(fxDir).sort();
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_DISABLE_KEYCHAIN: "1",
        };

        const text = await runFx(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stderr).toBe("");
        expect(text.stdout).toContain("Usage (30 days)");
        expect(text.stdout).toContain("Total tokens  30");
        expect(text.stdout.indexOf("provider/a")).toBeLessThan(
          text.stdout.indexOf("provider/b"),
        );

        const json = await runFx(
          ["usage", "--json", "--period", "24h"],
          { env },
        );
        expect(json.code).toBe(0);
        expect(json.stderr).toBe("");
        const report = JSON.parse(json.stdout);
        expect(report).toMatchObject({
          kind: "usage",
          data: {
            schema_version: 1,
            period: "24h",
            completeness: "complete",
            totals: {
              total_tokens: 18,
              input_tokens: 15,
              output_tokens: 3,
              request_count: 1,
            },
          },
        });
        expect(report.data.models.map((model: { model: string }) => model.model))
          .toEqual(["provider/a"]);
        expect(readFileSync(usagePath, "utf8")).toBe(before);
        expect(readdirSync(fxDir).sort()).toEqual(entriesBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber usage preserves known totals when the ledger is incomplete",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-usage-incomplete-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".fiber");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 2,
              model: "provider/model",
              input_tokens: 4,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: 1,
              total_cost: 0.01,
            },
          },
          {
            schema_version: 1,
            kind: "incident",
            occurred_at_ms: now - 1,
            completeness: "incomplete",
          },
        ];
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_DISABLE_KEYCHAIN: "1",
        };

        const text = await runFx(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain("Known totals may be incomplete.");
        expect(text.stdout).toContain("Total tokens  6");

        const json = await runFx(["usage", "--json"], { env });
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({
          data: {
            completeness: "incomplete",
            totals: { total_tokens: 6, spend: 0.01 },
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber usage distinguishes empty, invalid, corrupt, and unsafe local state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-usage-states-"));
      try {
        const home = realpathSync(root);
        const env = { ...NO_GATEWAY_AUTH, HOME: home, FIBER_DISABLE_KEYCHAIN: "1" };
        const empty = await runFx(["usage", "--json"], { env });
        expect(empty.code).toBe(0);
        expect(JSON.parse(empty.stdout)).toMatchObject({
          data: { coverage: { status: "not_started" }, totals: null },
        });
        expect(existsSync(join(home, ".fiber"))).toBe(false);

        const invalid = await runFx(
          ["usage", "--period", "session", "--json"],
          { env },
        );
        expect(invalid.code).toBe(2);
        expect(JSON.parse(invalid.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageArgs",
        });

        const fxDir = join(home, ".fiber");
        mkdirSync(fxDir, { mode: 0o700 });
        chmodSync(fxDir, 0o700);
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          `${JSON.stringify({
            schema_version: 1,
            kind: "coverage",
            started_at_ms: Date.now() - 1,
          })}\n`,
          { mode: 0o600 },
        );
        if (platform() !== "win32") {
          chmodSync(fxDir, 0o755);
          const entries = readdirSync(fxDir);
          const unsafeDirectory = await runFx(["usage", "--json"], { env });
          expect(unsafeDirectory.code).toBe(1);
          expect(JSON.parse(unsafeDirectory.stdout)).toMatchObject({
            kind: "usage",
            code: "PrivateStatePermissionsUnsupported",
          });
          expect(lstatSync(fxDir).mode & 0o777).toBe(0o755);
          expect(readdirSync(fxDir)).toEqual(entries);
          chmodSync(fxDir, 0o700);
        }
        writeFileSync(join(fxDir, "usage.jsonl"), "{\"broken\":true}\n", {
          mode: 0o600,
        });
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const corrupt = await runFx(["usage", "--json"], { env });
        expect(corrupt.code).toBe(1);
        expect(JSON.parse(corrupt.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageStore",
        });

        if (platform() !== "win32") {
          rmSync(join(fxDir, "usage.jsonl"));
          const fifo = spawnSync("mkfifo", [join(fxDir, "usage.jsonl")]);
          expect(fifo.status).toBe(0);
          const special = await runFx(["usage", "--json"], { env });
          expect(special.code).toBe(1);
          expect(JSON.parse(special.stdout)).toMatchObject({
            kind: "usage",
            code: "DurablePathUnsafe",
          });

          rmSync(join(fxDir, "usage.jsonl"));
          const socketPath = join(fxDir, "usage.jsonl");
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
              server.off("error", reject);
              resolve();
            });
          });
          try {
            const socket = await runFx(["usage", "--json"], { env });
            expect(socket.code).toBe(1);
            expect(JSON.parse(socket.stdout)).toMatchObject({
              kind: "usage",
              code: "DurablePathUnsafe",
            });
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber usage preserves known totals but fails closed when recovery storage is unsafe",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-usage-recovery-"));
      try {
        const home = join(root, "home");
        const fxDir = join(home, ".fiber");
        mkdirSync(fxDir, { recursive: true, mode: 0o700 });
        chmodSync(fxDir, 0o700);
        writeFileSync(
          join(fxDir, "usage.jsonl"),
          [
            {
              schema_version: 1,
              kind: "coverage",
              started_at_ms: Date.now() - 40 * 24 * 60 * 60 * 1000,
            },
            {
              schema_version: 1,
              kind: "generation",
              fact: {
                id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                created_at_ms: Date.now() - 1,
                model: "provider/model",
                input_tokens: 4,
                output_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 1,
                total_cost: 0.01,
              },
            },
          ].map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
        const outside = join(root, "outside");
        writeFileSync(outside, "not a session directory");
        symlinkSync(outside, join(fxDir, "sessions"));

        const result = await runFx(["usage", "--json"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FIBER_DISABLE_KEYCHAIN: "1",
          },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          kind: "usage",
          data: {
            coverage: { status: "full" },
            completeness: "incomplete",
            totals: { total_tokens: 6, spend: 0.01 },
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: permissions", () => {
  test(
    "fiber permissions --json returns valid permissions JSON",
    async () => {
      const r = await runFx(["permissions", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("permissions");
      expect(json.ok).toBe(true);
      expect(json.data).toHaveProperty("mode");
      expect(json.data).toHaveProperty("grant_count");
      expect(json.data.grant_scope).toBe("session");
      expect(json.data.runtime_grants_available).toBe(false);
      expect(json.data.rules_scope).toBe("persistent_config");
      expect(Array.isArray(json.data.rules)).toBe(true);
      expect(Array.isArray(json.data.grants)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("cli: doctor", () => {
  test(
    "fiber doctor --json returns valid doctor JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-doctor-json-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.ok).toBe(true);
        expect(Array.isArray(json.data.checks)).toBe(true);
        expect(json.data).toHaveProperty("ok_count");
        expect(json.data).toHaveProperty("warn_count");
        expect(json.data).toHaveProperty("fail_count");
        expect(json.data.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
        for (const check of json.data.checks) {
          expect(check).toHaveProperty("name");
          expect(check).toHaveProperty("status");
          expect(check).toHaveProperty("detail");
          expect(["ok", "warn", "fail"]).toContain(check.status);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber doctor --json leaves an empty home unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-doctor-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runFx(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout.trim()).kind).toBe("doctor");
        expect(existsSync(join(home, ".fiber"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber doctor --json bounds session diagnostics without summary cache",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-doctor-bounded-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const limit = doctorSessionDiagnosticsLimit();
        const sessionCount = limit + 32;
        for (let i = 0; i < sessionCount; i += 1) {
          writeLegacySession(
            home,
            workspaceRoot,
            `doctor-bounded-${String(i).padStart(3, "0")}`,
            { updatedAtMs: i + 1 },
          );
        }

        expect(existsSync(join(home, ".fiber", "sessions", "summary.json"))).toBe(false);

        const r = await runFx(["doctor", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: home,
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.length).toBeLessThan(64 * 1024);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.data.checks.length).toBeLessThan(sessionCount);
        expect(json.data.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              status: "warn",
              detail: expect.stringContaining(
                `truncated after ${limit} session director`,
              ),
            }),
            expect.objectContaining({
              name: "sessions",
              status: "warn",
              detail: expect.stringContaining(
                "unavailable without a full session scan",
              ),
            }),
          ]),
        );
        expect(
          json.data.checks.some((check: { detail: string }) =>
            check.detail.includes(`${sessionCount} saved session(s)`),
          ),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: logout", () => {
  test(
    "fiber logout deletes the saved Codex login",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fiber-e2e-logout-codex-"));
      const authPath = join(home, ".fiber", "chatgpt-auth.json");
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());

        const logout = await runFx(["auth", "logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FIBER_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of Codex.\n");
        expect(logout.stderr).toBe("");
        expect(existsSync(authPath)).toBe(false);

        const status = await runFx(["status", "--json"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FIBER_DISABLE_KEYCHAIN: "1",
          },
        });
        expect(JSON.parse(status.stdout)).toMatchObject({
          data: { auth: "missing", auth_refreshable: false },
        });
        for (const secret of ["header.", "chatgpt-refresh"]) {
          expect(logout.stdout).not.toContain(secret);
          expect(logout.stderr).not.toContain(secret);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber logout removes a saved login rejected for unsafe permissions",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fiber-e2e-logout-rejected-login-"));
      const authPath = join(home, ".fiber", "chatgpt-auth.json");
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());
        chmodSync(authPath, 0o644);

        const logout = await runFx(["auth", "logout"], {
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            FIBER_DISABLE_KEYCHAIN: "1",
          },
        });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("Signed out of Codex.\n");
        expect(logout.stderr).toBe("");
        expect(existsSync(authPath)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber logout fails when the saved login cannot be deleted",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fiber-e2e-logout-delete-failure-"));
      const fxDir = join(home, ".fiber");
      const authPath = join(fxDir, "chatgpt-auth.json");
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());
        chmodSync(fxDir, 0o500);

        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const logout = await runFx(["auth", "logout"], { env });
        const status = await runFx(["status", "--json"], { env });

        expect(logout.code).toBe(1);
        expect(logout.stdout).toBe("");
        expect(logout.stderr).toBe(
          "fiber auth logout: failed to durably remove saved Codex login\n",
        );
        expect(existsSync(authPath)).toBe(true);
        expect(JSON.parse(status.stdout).data.auth).toBe("Codex subscription");
      } finally {
        chmodSync(fxDir, 0o700);
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber logout with no saved Codex login reports absence and keeps missing auth",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fiber-e2e-logout-no-login-"));
      try {
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: "logout-existing-api-key",
          VERCEL_OIDC_TOKEN: undefined,
          FIBER_DISABLE_KEYCHAIN: "1",
        };
        const logout = await runFx(["auth", "logout"], { env });
        const status = await runFx(["status", "--json"], { env });

        expect(logout.code).toBe(0);
        expect(logout.stdout).toBe("No Codex login session found.\n");
        expect(logout.stderr).toBe("");
        expect(JSON.parse(status.stdout)).toMatchObject({
          data: { auth: "missing", auth_refreshable: false },
        });
        expect(logout.stdout).not.toContain("logout-existing-api-key");
        expect(status.stdout).not.toContain("logout-existing-api-key");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: read-only no-create matrix", () => {
  const probes = [
    { args: ["status", "--json"], code: 0, kind: "status" },
    { args: ["sessions", "--json"], code: 0, kind: "session.list", count: 0 },
    { args: ["session", "show", "last", "--json"], code: 1, error: "no saved sessions" },
    { args: ["session", "show", "--id", "missing.valid-id", "--json"], code: 1, error: "record not found" },
    { args: ["doctor", "--json"], code: 0, kind: "doctor" },
  ] as const;

  for (const probe of probes) {
    test(
      `${probe.args.join(" ")} leaves an empty home unchanged`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "fiber-e2e-no-create-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(home);
          mkdirSync(workspace);
          const before = snapshotTree(home);

          const result = await runFx([...probe.args], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_GATEWAY_AUTH,
              HOME: realpathSync(home),
              FIBER_E2E_FAIL_ON_DURABLE_MUTATION: "1",
            },
            timeoutMs: TIMEOUT,
          });

          expect(result.code).toBe(probe.code);
          if ("kind" in probe) {
            const output = JSON.parse(result.stdout);
            expect(output.kind).toBe(probe.kind);
            if ("count" in probe) expect(output.data.count).toBe(probe.count);
          } else {
            const output = JSON.parse(result.stdout);
            expect(output.error).toContain(probe.error);
            expect(result.stderr).toBe("");
          }
          expect(snapshotTree(home)).toEqual(before);
          expect(existsSync(join(home, ".fiber"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: missing durable home", () => {
  test(
    "read-only commands tolerate a nonexistent HOME and saved ask bootstraps it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-missing-home-path-"));
      const home = join(root, "missing-home");
      const workspace = join(root, "workspace");
      const codex = startFakeCodex();
      try {
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const baseEnv = {
          HOME: home,
          ...NO_GATEWAY_AUTH,
          FIBER_DISABLE_KEYCHAIN: "1",
        };

        const status = await runFx(["status", "--json"], {
          cwd,
          env: baseEnv,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(status.stderr).toBe("");
        expect(JSON.parse(status.stdout).kind).toBe("status");
        expect(existsSync(home)).toBe(false);

        const listed = await runFx(["sessions", "--json"], {
          cwd,
          env: baseEnv,
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "session.list",
          ok: true,
          data: { count: 0, sessions: [] },
        });
        expect(existsSync(home)).toBe(false);

        // The ask credential lives in the profile directory, so the durable
        // home is bootstrapped with the login file before the saved session.
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const asked = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "Persist under the new home."],
          {
            cwd,
            env: fakeCodexEnv(home, codex),
            timeoutMs: TIMEOUT,
          },
        );
        expect(asked.code).toBe(0);
        expect(JSON.parse(asked.stdout).data.output.trim()).toBe(
          "FAKE_CODEX_RESPONSE",
        );
        expect(existsSync(join(home, ".fiber", "sessions"))).toBe(true);
        expect(codex.requests).toHaveLength(1);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session commands fail precisely while doctor remains available without HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-no-home-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_GATEWAY_AUTH,
          HOME: undefined,
        };

        for (const args of [
          ["sessions", "--json"],
          ["session", "show", "last", "--json"],
          ["session", "show", "--id", "missing.valid-id", "--json"],
        ]) {
          const result = await runFx(args, { cwd, env, timeoutMs: TIMEOUT });
          expect(result.code).toBe(1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual(
            expect.objectContaining({
              code: "HomeNotSet",
            }),
          );
        }

        const doctor = await runFx(["doctor", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout).data.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "state",
              detail: expect.stringContaining("HomeNotSet"),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: sessions", () => {
  test(
    "fiber sessions --json returns valid sessions JSON",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "fiber-e2e-sessions-empty-"));
      try {
        const r = await runFx(["sessions", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("session.list");
        expect(json.data).toHaveProperty("count");
        expect(Array.isArray(json.data.sessions)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber sessions text shows named, unnamed, and renamed sessions",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-names-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".fiber", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".fiber"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const named = {
          id: "named-session",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          title: "Investigate cache misses",
          preview: null,
          display_metadata_present: true,
          created_at_ms: 1,
          updated_at_ms: 3,
          conversation_language: "en",
          history_len: 2,
        };
        const unnamed = {
          ...named,
          id: "unnamed-session",
          title: null,
          display_metadata_present: false,
          updated_at_ms: 2,
          history_len: 0,
        };
        const scriptOnly = {
          ...named,
          id: "script-only-session",
          title: "Review landing page",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
          history_len: 1,
        };
        const indexPath = join(sessionsDir, "index.json");
        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [scriptOnly, named, unnamed],
          }),
          { mode: 0o600 },
        );

        const first = await runFx(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        expect(first.stdout).toContain(
          " - Investigate cache misses\n   id=named-session | 2 turns | English | updated 1970-01-01 00:00:00.003 UTC",
        );
        expect(first.stdout).toContain(
          " - Untitled session\n   id=unnamed-session | 0 turns | English | updated 1970-01-01 00:00:00.002 UTC",
        );
        expect(first.stdout).toContain(
          " - Review landing page\n   id=script-only-session | 1 turn | Latin script | updated 2023-11-14 22:13:20.123 UTC",
        );
        expect(first.stdout).not.toContain("updated_at_ms");
        expect(first.stdout).not.toContain("language=");

        const structured = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(structured.code).toBe(0);
        expect(structured.stderr).toBe("");
        expect(JSON.parse(structured.stdout).data.sessions[0]).toMatchObject({
          id: "script-only-session",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
        });

        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [
              scriptOnly,
              { ...named, title: "Investigate cache hits" },
              unnamed,
            ],
          }),
          { mode: 0o600 },
        );
        const renamed = await runFx(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(renamed.code).toBe(0);
        expect(renamed.stderr).toBe("");
        expect(renamed.stdout).toContain(
          " - Investigate cache hits\n   id=named-session | 2 turns | English",
        );
        expect(renamed.stdout).not.toContain("Investigate cache misses");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session listing pages a 9001-entry index without scanning session directories",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-pages-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".fiber", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".fiber"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const sessions = Array.from({ length: 9_001 }, (_, index) => {
          const id = `indexed-session-${index.toString().padStart(5, "0")}`;
          return {
            id,
            workspace_root: workspaceRoot,
            origin_workspace_root: workspaceRoot,
            title: id,
            preview: `${id} preview`,
            display_metadata_present: true,
            created_at_ms: 20_000 - index,
            updated_at_ms: 20_000 - index,
            conversation_language: "en",
            history_len: 0,
          };
        });
        writeFileSync(
          join(sessionsDir, "index.json"),
          JSON.stringify({ schema_version: 3, sessions }),
          { mode: 0o600 },
        );

        const first = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(Buffer.byteLength(first.stdout)).toBeLessThan(100_000);
        const firstJson = JSON.parse(first.stdout) as {
          count: number;
          has_more: boolean;
          next_cursor: string;
          sessions: Array<{ id: string; history_len: number }>;
        };
        expect(firstJson.data.count).toBe(100);
        expect(firstJson.data.has_more).toBe(true);
        expect(firstJson.data.sessions).toHaveLength(100);
        expect(firstJson.data.sessions[0]).toMatchObject({
          id: "indexed-session-00000",
          history_len: 0,
        });
        expect(firstJson.data.sessions[99].id).toBe("indexed-session-00099");

        const second = await runFx(
          ["sessions", "--json", "--continuation", firstJson.data.next_cursor],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(second.code).toBe(0);
        const secondJson = JSON.parse(second.stdout) as {
          count: number;
          has_more: boolean;
          sessions: Array<{ id: string }>;
        };
        expect(secondJson.data.count).toBe(100);
        expect(secondJson.data.has_more).toBe(true);
        expect(secondJson.data.sessions[0].id).toBe("indexed-session-00100");
        expect(secondJson.data.sessions[99].id).toBe("indexed-session-00199");

        const one = await runFx(["sessions", "--json", "--limit", "1"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(one.code).toBe(0);
        expect(JSON.parse(one.stdout)).toMatchObject({
          data: {
            count: 1,
            has_more: true,
            sessions: [{ id: "indexed-session-00000" }],
          },
        });

        const invalid = await runFx(["sessions", "--limit", "0"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(invalid.code).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session lists use projections without opening unreadable event logs",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-projections-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const fixture = spawnSync(
          "python3",
          [
            join(REPO_ROOT, "benchmarks", "session_list_fixture.py"),
            "--home",
            home,
            "--workspace",
            workspaceRoot,
            "--sessions",
            "2",
            "--log-size",
            "4096",
            "--deny-event-read",
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status).toBe(0);

        const before = snapshotTree(join(home, ".fiber"));
        const listed = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "session.list",
          ok: true,
          data: {
          count: 2,
          sessions: [
            {
              id: "benchmark-session-01",
              title: "Benchmark session 01",
              preview: "Benchmark session 01 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1001,
              updated_at_ms: 2001,
              history_len: 1,
              conversation_language: "en",
            },
            {
              id: "benchmark-session-00",
              title: "Benchmark session 00",
              preview: "Benchmark session 00 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1000,
              updated_at_ms: 2000,
              history_len: 0,
              conversation_language: "en",
            },
          ],
          },
        });
        expect(snapshotTree(join(home, ".fiber"))).toEqual(before);

        const latest = await runFx(["session", "show", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(0);
        expect(JSON.parse(latest.stdout)).toEqual({
          kind: "session.show",
          ok: true,
          data: {
            id: "benchmark-session-01",
            title: "Benchmark session 01",
            preview: "Benchmark session 01 preview",
            workspace_root: workspaceRoot,
            origin_workspace_root: workspaceRoot,
            created_at_ms: 1001,
            updated_at_ms: 2001,
            history_len: 1,
            conversation_language: "en",
          },
        });
        expect(snapshotTree(join(home, ".fiber"))).toEqual(before);

        const detail = await runFx(
          ["session", "show", "--id", "benchmark-session-00", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).not.toBe(0);
        expect(detail.stderr).toContain("AccessDenied");
        expect(snapshotTree(join(home, ".fiber"))).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "workspace-scoped session discovery filters list and last by cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-workspace-sessions-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        writeLegacySession(home, workspaceARoot, "workspace-a-older", {
          updatedAtMs: 20,
        });
        writeLegacySession(home, workspaceARoot, "workspace-a-latest", {
          updatedAtMs: 40,
        });
        writeLegacySession(home, workspaceBRoot, "workspace-b-newest", {
          updatedAtMs: 80,
        });

        const listA = await runFx(["sessions", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listA.code).toBe(0);
        const jsonA = JSON.parse(listA.stdout);
        expect(jsonA.kind).toBe("session.list");
        expect(jsonA.data.count).toBe(2);
        expect(jsonA.data.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-a-latest", "workspace-a-older"]);

        const lastA = await runFx(["session", "show", "last", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(lastA.code).toBe(0);
        expect(JSON.parse(lastA.stdout).data.id).toBe("workspace-a-latest");

        const listB = await runFx(["sessions", "--json"], {
          cwd: workspaceBRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listB.code).toBe(0);
        const jsonB = JSON.parse(listB.stdout);
        expect(jsonB.data.count).toBe(1);
        expect(jsonB.data.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-b-newest"]);

        const exactForeign = await runFx(
          ["session", "show", "--id", "workspace-b-newest", "--json"],
          {
            cwd: workspaceARoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(exactForeign.code).toBe(0);
        expect(JSON.parse(exactForeign.stdout).data.id).toBe("workspace-b-newest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session discovery reports corrupt records and distinguishes an unreadable latest session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-corrupt-sessions-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "readable-session", {
          updatedAtMs: 30,
        });
        for (const [id, contents] of [
          ["invalid-json", "{"],
          ["truncated", '{"schema_version":2,"id":"truncated"}'],
        ] as const) {
          const directory = join(home, ".fiber", "sessions", id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "session.json"), contents, {
            mode: 0o600,
          });
        }

        const listed = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toMatchObject({
          kind: "session.list",
          data: {
            count: 1,
            skipped_invalid: 2,
            sessions: [{ id: "readable-session" }],
          },
        });

        rmSync(join(home, ".fiber", "sessions", "readable-session"), {
          recursive: true,
          force: true,
        });
        const latest = await runFx(["session", "show", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(1);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout)).toMatchObject({
          error: expect.stringContaining("saved sessions are unreadable"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "profile-wide session discovery recovers sessions after a workspace rename",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-renamed-workspace-"));
      try {
        const home = join(root, "home");
        const original = join(root, "workspace-before");
        const renamed = join(root, "workspace-after");
        mkdirSync(home);
        mkdirSync(original);
        const originalRoot = realpathSync(original);
        writeLegacySession(home, originalRoot, "renamed-workspace-session", {
          updatedAtMs: 40,
        });
        renameSync(original, renamed);
        const renamedRoot = realpathSync(renamed);

        const scoped = await runFx(["sessions", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(JSON.parse(scoped.stdout)).toMatchObject({
          data: { count: 0, sessions: [] },
        });

        const recovered = await runFx(["sessions", "--all", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          data: {
            count: 1,
            sessions: [
              {
                id: "renamed-workspace-session",
                workspace_root: originalRoot,
              },
            ],
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber sessions --json ignores malformed and oversized list caches",
    async () => {
      for (const cached of ["{", "x".repeat(4 * 1024 * 1024 + 1)]) {
        const root = mkdtempSync(join(tmpdir(), "fiber-e2e-sessions-cache-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".fiber", "sessions"), { recursive: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(home, ".fiber", "sessions", "list.json"), cached);

          const r = await runFx(["sessions", "--json"], {
            cwd: realpathSync(workspace),
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          });
          expect(r.code).toBe(0);
          expect(JSON.parse(r.stdout.trim())).toEqual({
            kind: "session.list",
            ok: true,
            data: { count: 0, sessions: [] },
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "exact session flags address special-token and 255-byte IDs literally",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-exact-ids-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const ids = [
          "last",
          "migrate",
          "--json",
          "--allow-large",
          "x".repeat(255),
        ];
        for (const id of ids) writeLegacySession(home, workspaceRoot, id);

        for (const id of ids) {
          const result = await runFx(
            ["session", "show", "--id", id, "--json"],
            {
              cwd: workspaceRoot,
              env: { HOME: home },
              timeoutMs: TIMEOUT,
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).data.id).toBe(id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "expected json failures emit machine-readable stdout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-json-errors-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const cases: Array<{
          args: string[];
          kind: string;
          code: number;
          expectedError?: string;
        }> = [
          {
            args: ["session", "show", "last", "--json"],
            kind: "session.show",
            code: 1,
          },
          {
            args: ["ask", "--json"],
            kind: "ask",
            code: 2,
            expectedError: "MissingPrompt",
          },
          {
            args: ["ask", "--json", "--no-save", "--resume", "last", "hello"],
            kind: "ask",
            code: 2,
            expectedError: "InvalidAskArgs",
          },
        ];

        for (const item of cases) {
          const result = await runFx(item.args, {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          });
          expect(result.code).toBe(item.code);
          expect(result.stdout.trim().length).toBeGreaterThan(0);
          const parsed = JSON.parse(result.stdout.trim());
          expect(parsed.kind ?? item.kind).toBe(item.kind);
          expect(typeof parsed.error).toBe("string");
          if (item.expectedError) expect(parsed.error).toBe(item.expectedError);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: removed task and background commands", () => {
  test(
    "fiber task, fiber tasks, and fiber background are unknown commands",
    async () => {
      for (const command of ["task", "tasks", "background"]) {
        const result = await runFx([command], { env: NO_GATEWAY_AUTH });
        expect(result.code).toBe(2);
        expect(`${result.stdout}\n${result.stderr}`).toContain("unknown subcommand");
      }
    },
    TIMEOUT,
  );

  test(
    "legacy tasks files are ignored by ordinary session loading",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-legacy-tasks-ignored-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "legacy-tasks-session");
        const tasksDir = join(home, ".fiber", "sessions", "legacy-tasks-session", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, "unreadable-legacy-shape.json"), "not json\n");

        const result = await runFx(
          ["session", "show", "--id", "legacy-tasks-session", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_GATEWAY_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).data.id).toBe("legacy-tasks-session");
        expect(existsSync(join(tasksDir, "unreadable-legacy-shape.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

function codexModelsEnv(home: string, modelsUrl: string) {
  return {
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    HOME: home,
    FIBER_DISABLE_KEYCHAIN: "1",
    FIBER_E2E_OPENAI_CODEX_MODELS_URL: modelsUrl,
  };
}

function startCodexModelsServer(response: () => Response) {
  const modelRequests: Array<{ url: string; headers: Headers }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/models") {
        modelRequests.push({ url: req.url, headers: new Headers(req.headers) });
        return response();
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    modelRequests,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    stop() {
      server.stop(true);
    },
  };
}

describe("cli: models", () => {
  test(
    "fiber models renders the authenticated Codex catalog and sends subscription identity",
    async () => {
      const home = createIsolatedTestHome();
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const catalog = {
        models: [
          {
            slug: "gpt-5.4",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "low" }],
            additional_speed_tiers: ["fast"],
            input_modalities: ["text", "image"],
            context_window: 272000,
          },
          {
            slug: "gpt-5.4-mini",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "low" }],
            additional_speed_tiers: [],
            input_modalities: ["text"],
            context_window: 128000,
          },
        ],
      };
      const server = startCodexModelsServer(() => Response.json(catalog));
      try {
        const result = await runFx(["models"], {
          env: codexModelsEnv(home, server.modelsUrl),
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe("[models] 2 available\n - gpt-5.4\n - gpt-5.4-mini\n");

        const json = await runFx(["models", "--json"], {
          env: codexModelsEnv(home, server.modelsUrl),
        });
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout.trim())).toEqual({
          kind: "models",
          ok: true,
          data: {
            count: 2,
            shown_count: 2,
            more_count: 0,
            private_models_hidden: false,
            ids: ["gpt-5.4", "gpt-5.4-mini"],
          },
        });

        expect(server.modelRequests).toHaveLength(2);
        for (const request of server.modelRequests) {
          expect(request.url).toContain("?client_version=");
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${chatGptAccessToken()}`,
          );
          expect(request.headers.get("chatgpt-account-id")).toBe("acct_e2e");
          expect(request.headers.get("originator")).toBe("fiber");
        }
      } finally {
        server.stop();
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test(
    "fiber models rejects redirects without contacting the target",
    async () => {
      const home = createIsolatedTestHome();
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const captureRequests: string[] = [];
      const captureServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          captureRequests.push(`${request.method} ${new URL(request.url).pathname}`);
          return Response.json({ models: [] });
        },
      });
      const redirectServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return Response.redirect(`http://127.0.0.1:${captureServer.port}/capture`, 302);
        },
      });

      try {
        const r = await runFx(["models", "--json"], {
          env: codexModelsEnv(home, `http://127.0.0.1:${redirectServer.port}/models`),
        });

        expect(captureRequests).toEqual([]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout.trim())).toMatchObject({
          kind: "models",
          error: expect.stringContaining("could not list models:"),
          code: expect.any(String),
        });
      } finally {
        redirectServer.stop(true);
        captureServer.stop(true);
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test(
    "fiber models preserves transport and server failures without anonymous retry",
    async () => {
      for (const scenario of [
        {
          name: "unauthorized",
          response: () => Response.json({ error: "rejected" }, { status: 401 }),
          code: "AuthenticationRejected",
        },
        {
          name: "forbidden",
          response: () => Response.json({ error: "rejected" }, { status: 403 }),
          code: "AuthenticationRejected",
        },
        {
          name: "rate limiting",
          response: () => Response.json({ error: "slow down" }, { status: 429 }),
          code: "RateLimited",
        },
        {
          name: "server errors",
          response: () => Response.json({ error: "unavailable" }, { status: 500 }),
          code: "GatewayUnavailable",
        },
        {
          name: "malformed JSON",
          response: () => new Response("{not-json", {
            headers: { "content-type": "application/json" },
          }),
          code: "MalformedResponse",
        },
        {
          name: "a malformed top-level catalog array",
          response: () => Response.json([]),
          code: "MalformedResponse",
        },
        {
          name: "a catalog without models",
          response: () => Response.json({}),
          code: "MalformedResponse",
        },
        {
          name: "a catalog with non-array models",
          response: () => Response.json({ models: {} }),
          code: "MalformedResponse",
        },
        {
          name: "a catalog missing the reviewer model",
          response: () => Response.json({
            models: [{ slug: "gpt-5.4", visibility: "list", supported_in_api: true }],
          }),
          code: "MalformedResponse",
        },
      ]) {
        const home = createIsolatedTestHome();
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const server = startCodexModelsServer(scenario.response);
        try {
          const result = await runFx(["models", "--json"], {
            env: codexModelsEnv(home, server.modelsUrl),
          });

          expect(result.code).not.toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout.trim()).code).toBe(scenario.code);
          expect(server.modelRequests).toHaveLength(1);
        } finally {
          server.stop();
          cleanupIsolatedTestHome(home);
        }
      }
    },
    TIMEOUT,
  );

  test(
    "fiber models preserves connection failures without anonymous retry",
    async () => {
      const home = createIsolatedTestHome();
      writeSeededChatGptLogin(home, chatGptAccessToken());
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing server address");
        const result = await runFx(["models", "--json"], {
          env: codexModelsEnv(home, `http://127.0.0.1:${address.port}/models`),
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim()).code).toBe("TransportFailure");
        expect(connections).toBe(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );

  test(
    "cancelling fiber models does not retry",
    async () => {
      const home = createIsolatedTestHome();
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const server = startCodexModelsServer(() => new Promise<Response>(() => {}));
      const proc = Bun.spawn([FIBER_BIN, "models", "--json"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...codexModelsEnv(home, server.modelsUrl),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const started = Date.now();
        while (server.modelRequests.length === 0) {
          if (Date.now() - started >= TIMEOUT) {
            throw new Error("timed out waiting for the cancellable model request");
          }
          await Bun.sleep(25);
        }
        expect(server.modelRequests).toHaveLength(1);

        proc.kill("SIGTERM");
        await proc.exited;
        expect(server.modelRequests).toHaveLength(1);
      } finally {
        proc.kill("SIGKILL");
        server.stop();
        cleanupIsolatedTestHome(home);
      }
    },
    TIMEOUT,
  );
});

describe("cli: replay failures", () => {
  test(
    "fiber replay --json preserves structured failures for missing and malformed tapes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-replay-json-errors-"));
      try {
        const missing = await runFx(["debug", "replay", join(root, "missing.fibertape"), "--json"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toBe("");
        expect(JSON.parse(missing.stdout.trim())).toMatchObject({
          kind: "debug.replay",
          code: "FileNotFound",
        });

        const malformedPath = join(root, "malformed.fibertape");
        writeFileSync(malformedPath, "not a tape");
        const malformed = await runFx(["debug", "replay", malformedPath, "--json"]);
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toBe("");
        expect(JSON.parse(malformed.stdout.trim())).toMatchObject({
          kind: "debug.replay",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask input validation", () => {
  test(
    "fiber ask rejects invalid UTF-8 stdin before network or session effects",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-invalid-utf8-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname);
          return Response.json({ error: "request should not arrive" }, { status: 400 });
        },
      });

      try {
        const result = await runFx(["ask", "--json", "--no-save"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_GATEWAY_AUTH,
            HOME: realpathSync(home),
            AI_GATEWAY_API_KEY: "invalid-utf8-proof-key",
            FIBER_DISABLE_KEYCHAIN: "1",
            FIBER_E2E_OPENAI_CODEX_RESPONSES_URL: `http://127.0.0.1:${server.port}/responses`,
          },
          stdin: Uint8Array.from([0xff, 0xfe, 0x80, 0x68, 0x69]),
          timeoutMs: TIMEOUT,
        });

        expect(result.code).toBe(2);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          ok: false,
          kind: "ask",
          error: "InvalidPromptText",
          code: "InvalidPromptText",
        });
        expect(requests).toEqual([]);
        expect(existsSync(join(home, ".fiber"))).toBe(false);
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: session", () => {
  test(
    "fiber session with no id exits non-zero or shows usage",
    async () => {
      const r = await runFx(["session"]);
      expect(r.code).not.toBe(0);
    },
    TIMEOUT,
  );

  test(
    "fiber session exact id hides managed child detail",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-private-child-detail-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".fiber", "sessions"), {
          recursive: true,
          mode: 0o700,
        });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const parentId = "visible-parent";
        const childId = "private-child";

        writeLegacySession(home, workspaceRoot, parentId);
        writeLegacySession(home, workspaceRoot, childId);
        const childControl = join(
          home,
          ".fiber",
          "sessions",
          childId,
          "subagent",
        );
        mkdirSync(childControl, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(childControl, "owner.json"),
          JSON.stringify({ schema_version: 1, parent_id: parentId }),
          { mode: 0o600 },
        );

        const parent = await runFx(
          ["session", "show", "--id", parentId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, FIBER_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(parent).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(parent.stdout)).toMatchObject({
          kind: "session.show",
          data: { id: parentId },
        });

        const child = await runFx(
          ["session", "show", "--id", childId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, FIBER_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(child.code).toBe(1);
        expect(child.stderr).toBe("");
        expect(JSON.parse(child.stdout)).toEqual({
          ok: false,
          kind: "session.show",
          error: "record not found",
          code: "SessionNotFound",
        });
        expect(child.stdout).not.toContain(childId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: interactive startup", () => {
  test(
    "interactive startup without TTY exits non-zero",
    async () => {
      const cases: Array<{
        args: string[];
        code: number;
        stderr: string;
        stdoutEmpty: boolean;
      }> = [
        { args: [], code: 1, stderr: "fiber requires an interactive terminal (TTY).\n", stdoutEmpty: true },
        { args: ["resume", "last"], code: 1, stderr: "fiber requires an interactive terminal (TTY).\n", stdoutEmpty: true },
        { args: ["--resume"], code: 2, stderr: "fiber: unknown subcommand: --resume", stdoutEmpty: true },
        { args: ["session", "resume", "last"], code: 1, stderr: "fiber requires an interactive terminal (TTY).\n", stdoutEmpty: true },
        { args: ["session", "resume", "--id", "session.v3"], code: 1, stderr: "fiber requires an interactive terminal (TTY).\n", stdoutEmpty: true },
      ];

      for (const item of cases) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "fiber-e2e-no-tty-")));
        try {
          const r = await runFx(item.args, { env: { HOME: home } });
          expect(r.code).toBe(item.code);
          if (item.stdoutEmpty) expect(r.stdout).toBe("");
          expect(r.stderr).toContain(item.stderr);
          expect(readdirSync(home)).toEqual([]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask success", () => {
  test(
    "fiber ask binds an explicitly invoked skill into the prompt",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-explicit-skill-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const skillDirectory = join(home, ".fiber", "skills", "cli-explicit");
      const skillBody = "CLI_EXPLICIT_SKILL_BODY";
      const codex = startFakeCodex();
      try {
        mkdirSync(skillDirectory, { recursive: true });
        mkdirSync(workspace);
        writeSeededChatGptLogin(home, chatGptAccessToken());
        writeFileSync(
          join(skillDirectory, "SKILL.md"),
          `---\nname: cli-explicit\ndescription: explicit CLI fixture\n---\n\n${skillBody}\n`,
        );

        const result = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--no-save",
            "$cli-explicit apply the selected skill.",
          ],
          {
            cwd: realpathSync(workspace),
            env: fakeCodexEnv(home, codex, {}),
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).data.output.trim()).toBe(
          "FAKE_CODEX_RESPONSE",
        );
        expect(codex.requests).toHaveLength(1);
        expect(codex.requests[0]!.body).toContain(
          "Explicitly invoked skill content for this query:",
        );
        expect(codex.requests[0]!.body).toContain(
          '<skill_content name=\\"cli-explicit\\" resource=\\"SKILL.md\\"',
        );
        expect(codex.requests[0]!.body).toContain(skillBody);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask stdin prompts above the old 1 MiB limit reach Codex byte-for-byte",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-large-stdin-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const sizes = [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024];
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);

        for (const [index, size] of sizes.entries()) {
          const prompt = `B${"x".repeat(size - 2)}E`;
          const result = await runFx(
            ["ask", "--json", "--permission-mode", "auto", "--no-save"],
            {
              cwd: realpathSync(workspace),
              env: fakeCodexEnv(home, codex),
              stdin: prompt,
              timeoutMs: 60_000,
            },
          );

          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).data.output.trim()).toBe(`FAKE_CODEX_RESPONSE`);
          const request = JSON.parse(codex.requests[index]!.body) as {
            input: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>;
          };
          const user = request.input.filter((item) => item.role === "user").at(-1);
          expect(user?.content?.find((part) => part.type === "input_text")?.text).toBe(prompt);
        }

        expect(codex.requests).toHaveLength(sizes.length);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "fiber ask stdin resource overflow has distinct text and JSON errors",
    async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);

      const textResult = await runFx(["ask", "--permission-mode", "auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, FIBER_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(textResult.code).toBe(1);
      expect(textResult.stdout).toBe("");
      expect(textResult.stderr).toBe(
        "fiber ask: prompt exceeds the local input safety limit\n",
      );

      const jsonResult = await runFx(["ask", "--json", "--permission-mode", "auto", "--no-save"], {
        env: { ...NO_GATEWAY_AUTH, FIBER_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(jsonResult.code).toBe(1);
      expect(jsonResult.stderr).toBe("");
      expect(jsonResult.stdout).toBe(
        '{"ok":false,"kind":"ask","error":"PromptResourceLimitExceeded","code":"PromptResourceLimitExceeded"}\n',
      );
    },
    120_000,
  );

  test(
    "fiber ask sends catalog-backed portable reasoning",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-portable-reasoning-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          `${JSON.stringify({ model: FAKE_CODEX_DEFAULT_MODEL, effort: "high" })}\n`,
        );

        const result = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "--no-save", "Use portable reasoning."],
          {
            cwd: realpathSync(workspace),
            env: fakeCodexEnv(home, codex),
            timeoutMs: 60_000,
          },
        );

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).data.output.trim()).toBe("FAKE_CODEX_RESPONSE");
        expect(codex.requests).toHaveLength(1);
        const request = JSON.parse(codex.requests[0].body);
        expect(request.model).toBe(FAKE_CODEX_DEFAULT_MODEL);
        expect(request.reasoning).toEqual({ effort: "high", summary: "auto" });
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "saved ask resumes the exact session while no-save creates no durable state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-persistence-"));
      const replies = ["orange triangle", "blue circle", "green square"];
      const codex = startFakeCodex({
        route: () => codexFinalText(replies[askCount] ?? "unexpected"),
      });
      let askCount = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/models") {
            return Response.json({ models: [
              { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
            ] });
          }
          const body = await req.text();
          codex.requests.push({ path, authorization: req.headers.get("authorization"), body });
          const reply = codexFinalText(replies[askCount] ?? "unexpected");
          askCount += 1;
          return new Response(reply, { headers: { "content-type": "text/event-stream" } });
        },
      });
      try {
        const savedHome = join(root, "saved-home");
        const noSaveHome = join(root, "no-save-home");
        const workspace = join(root, "workspace");
        mkdirSync(savedHome);
        mkdirSync(noSaveHome);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeSeededChatGptLogin(savedHome, chatGptAccessToken());
        const env = fakeCodexEnv(savedHome, {
          responsesUrl: `http://127.0.0.1:${server.port}/responses`,
          modelsUrl: `http://127.0.0.1:${server.port}/models`,
          tokenUrl: codex.tokenUrl,
        } as ReturnType<typeof startFakeCodex>);

        const first = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "Reply with exactly: orange triangle"],
          {
            cwd: workspaceRoot,
            env,
            timeoutMs: 60_000,
          },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const firstJson = JSON.parse(first.stdout.trim());
        expect(typeof firstJson.data.session_id).toBe("string");
        expect(firstJson.data.session_id.length).toBeGreaterThan(0);
        expect(
          existsSync(
            join(savedHome, ".fiber", "sessions", firstJson.data.session_id),
          ),
        ).toBe(true);

        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--resume-id",
            firstJson.data.session_id,
            "Reply with exactly: blue circle",
          ],
          {
            cwd: workspaceRoot,
            env,
            timeoutMs: 60_000,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout.trim()).data.session_id).toBe(
          firstJson.data.session_id,
        );
        // The resumed turn replays the saved conversation to the model.
        const resumedBody = JSON.parse(codex.requests[1]!.body);
        const resumedInput = JSON.stringify(resumedBody.input ?? []);
        expect(resumedInput).toContain("Reply with exactly: orange triangle");
        expect(resumedInput).toContain("orange triangle");
        const detail = await runFx(
          ["session", "show", "--id", firstJson.data.session_id, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: realpathSync(savedHome) },
            timeoutMs: 60_000,
          },
        );
        expect(detail.code).toBe(0);
        expect(JSON.parse(detail.stdout).data.history_len).toBe(2);

        writeSeededChatGptLogin(noSaveHome, chatGptAccessToken());
        const noSave = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "--no-save", "Reply with exactly: green square"],
          {
            cwd: workspaceRoot,
            env: {
              ...env,
              HOME: realpathSync(noSaveHome),
            },
            timeoutMs: 60_000,
          },
        );
        expect(noSave.code).toBe(0);
        expect(noSave.stderr).toBe("");
        expect(JSON.parse(noSave.stdout.trim()).data.session_id).toBe("");
        expect(existsSync(join(noSaveHome, ".fiber", "sessions"))).toBe(false);
        expect(codex.requests).toHaveLength(3);
      } finally {
        server.stop(true);
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test(
    "saved ask survives session cache contention and repairs after release",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-cache-contention-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const lockReady = join(root, "latest-lock-ready");
      const unrelatedReply = `unrelated saved turn ${"x".repeat(64 * 1024)}`;
      const replies = [
        unrelatedReply,
        "first saved turn",
        "contended exact turn",
        "contended latest turn",
        "repairing turn",
      ];
      let askCount = 0;
      const codex = startFakeCodex();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/models") {
            return Response.json({ models: [
              { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
            ] });
          }
          const body = await req.text();
          codex.requests.push({ path, authorization: req.headers.get("authorization"), body });
          const reply = codexFinalText(replies[askCount] ?? "unexpected");
          askCount += 1;
          return new Response(reply, { headers: { "content-type": "text/event-stream" } });
        },
      });
      let lockHolder: ReturnType<typeof Bun.spawn> | null = null;
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const env = fakeCodexEnv(home, {
          responsesUrl: `http://127.0.0.1:${server.port}/responses`,
          modelsUrl: `http://127.0.0.1:${server.port}/models`,
          tokenUrl: codex.tokenUrl,
        } as ReturnType<typeof startFakeCodex>);

        const unrelated = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "Save an unrelated long turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(unrelated.code).toBe(0);
        expect(unrelated.stderr).toBe("");
        const unrelatedJson = JSON.parse(unrelated.stdout);
        const unrelatedSessionId = unrelatedJson.data.session_id as string;
        expect(unrelatedJson.data.output).toBe(unrelatedReply);

        const first = await runFx(
          ["ask", "--json", "--permission-mode", "auto", "Reply with the first saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const sessionId = JSON.parse(first.stdout).data.session_id as string;
        const lockPath = join(home, ".fiber", "sessions", "latest.lock");
        lockHolder = Bun.spawn(
          [
            "python3",
            "-c",
            [
              "import fcntl, os, sys, time",
              "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
              "fcntl.flock(fd, fcntl.LOCK_EX)",
              "open(sys.argv[2], 'w').close()",
              "time.sleep(300)",
            ].join("\n"),
            lockPath,
            lockReady,
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        for (let attempt = 0; attempt < 250 && !existsSync(lockReady); attempt += 1) {
          await Bun.sleep(20);
        }
        expect(existsSync(lockReady)).toBe(true);

        const exact = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--resume-id",
            sessionId,
            "Reply with the contended exact turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(exact.code).toBe(0);
        expect(exact.stderr).toBe("");
        expect(JSON.parse(exact.stdout).data.output.trim()).toBe("contended exact turn");
        const tokenPath = join(
          home,
          ".fiber",
          "sessions",
          "latest",
          "deferred",
          sessionId,
        );
        expect(existsSync(tokenPath)).toBe(true);

        const listed = await runFx(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_GATEWAY_AUTH },
          timeoutMs: 60_000,
        });
        expect(listed.code).toBe(0);
        expect(listed.stderr).toBe("");
        const listedSessions = JSON.parse(listed.stdout).data.sessions;
        expect(listedSessions[0]).toMatchObject({
          id: sessionId,
          history_len: 2,
        });
        expect(listedSessions[1]).toMatchObject({
          id: unrelatedSessionId,
          history_len: 1,
        });
        expect(existsSync(tokenPath)).toBe(true);

        const latest = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--resume-id",
            sessionId,
            "Reply with the contended latest turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(latest.code).toBe(0);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout).data.session_id).toBe(sessionId);
        expect(JSON.parse(latest.stdout).data.output.trim()).toBe("contended latest turn");
        expect(existsSync(tokenPath)).toBe(true);

        lockHolder.kill();
        await lockHolder.exited;
        lockHolder = null;
        const repaired = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--resume-id",
            sessionId,
            "Reply with the repairing turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(repaired.code).toBe(0);
        expect(repaired.stderr).toBe("");
        expect(JSON.parse(repaired.stdout).data.output.trim()).toBe("repairing turn");
        expect(existsSync(tokenPath)).toBe(false);
        const targetDetail = await runFx(
          ["session", "show", "--id", sessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(targetDetail.code).toBe(0);
        expect(targetDetail.stderr).toBe("");
        expect(JSON.parse(targetDetail.stdout).data.history_len).toBe(4);
        const unrelatedDetail = await runFx(
          ["session", "show", "--id", unrelatedSessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(unrelatedDetail.code).toBe(0);
        expect(unrelatedDetail.stderr).toBe("");
        expect(JSON.parse(unrelatedDetail.stdout).data.history_len).toBe(1);
        expect(codex.requests).toHaveLength(5);
      } finally {
        if (lockHolder) {
          lockHolder.kill();
          await lockHolder.exited;
        }
        server.stop(true);
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

describe("cli: error handling", () => {
  test(
    "fiber ask rejects unknown options before a model turn and -- preserves literal prompt text",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-options-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const codex = startFakeCodex();
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const env = fakeCodexEnv(realpathSync(home), codex);

        const rejected = await runFx(["ask", "--definitely-unknown"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(rejected.code).toBe(2);
        expect(rejected.stderr).toContain("usage: fiber ask");
        expect(codex.requests).toHaveLength(0);

        const literal = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--no-save",
            "--",
            "--definitely-prompt-text",
          ],
          {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          },
        );
        expect(literal.code).toBe(0);
        const literalJson = JSON.parse(literal.stdout);
        expect(literalJson.data.output.trim()).toBe(
          "FAKE_CODEX_RESPONSE",
        );
        expect(literalJson.data.final_output).toBe("FAKE_CODEX_RESPONSE");
        expect(codex.requests).toHaveLength(1);
        expect(codex.requests[0]!.body).toContain("--definitely-prompt-text");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask with no prompt exits 2",
    async () => {
      const r = await runFx(["ask"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("missing prompt");
    },
    TIMEOUT,
  );

  test(
    "fiber unknown-command exits 2",
    async () => {
      const r = await runFx(["unknown-command"]);
      expect(r.code).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "fiber ask explains no-save resume conflicts before a model turn",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-resume-no-save-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const codex = startFakeCodex();
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          AI_GATEWAY_API_KEY: undefined,
          VERCEL_OIDC_TOKEN: undefined,
        };

        for (const args of [
          ["ask", "--no-save", "--resume-id", "session.v3", "hello"],
          ["ask", "--resume-id", "session.v3", "--no-save", "hello"],
        ]) {
          const rejected = await runFx(args, {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          });
          expect(rejected.code).toBe(2);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toContain(
            "fiber ask: --no-save cannot be used with --resume-id",
          );
          expect(rejected.stderr).toContain(
            "usage: fiber ask [--permission-mode <ask|auto|yolo>]",
          );
        }
        expect(codex.requests).toHaveLength(0);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: workspace access", () => {
  test(
    "workspace launch modifiers preserve ask help and report friendly option errors",
    async () => {
      const enabled = {
        ...NO_GATEWAY_AUTH,
      };

      const help = await runFx(
        ["--add-dir", "/tmp/shared", "ask", "--help"],
        { env: enabled },
      );
      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("fiber ask\n\n")).toBe(true);
      expect(help.stderr).toBe("");

      const missing = await runFx(["--add-dir"], { env: enabled });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("--add-dir requires a directory path");
      expect(missing.stderr).not.toContain("MissingAddDirectoryValue");

      const duplicate = await runFx(
        ["--no-additional-dirs", "--no-additional-dirs"],
        { env: enabled },
      );
      expect(duplicate.code).toBe(2);
      expect(duplicate.stderr).toContain(
        "--no-additional-dirs may only be specified once",
      );
      expect(duplicate.stderr).not.toContain(
        "DuplicateAdditionalDirectorySuppression",
      );
    },
    TIMEOUT,
  );

  test(
    "workspace commands persist per-primary roots and track availability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-access-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const missing = join(root, "missing");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".fiber"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        const added = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(added.code).toBe(0);
        const addedJson = JSON.parse(added.stdout.trim());
        expect(addedJson).toMatchObject({
          kind: "workspace",
          data: {
            action: "add",
            changed: true,
            limit: 16,
            path: sharedRoot,
          },
        });
        expect(addedJson.data.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: true,
            active: true,
          },
        ]);

        const stored = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        for (const path of [unknownRoot, missing]) {
          const unknownRemoval = await runFx(
            ["workspace", "remove", path, "--json"],
            { cwd: workspaceRoot, env: baseEnv },
          );
          expect(unknownRemoval.code).toBe(1);
          expect(JSON.parse(unknownRemoval.stdout.trim())).toEqual({
            kind: "workspace",
            error: "directory is not configured as an additional workspace",
            code: "UnknownAdditionalDirectory",
          });
        }

        const removed = await runFx(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removed.code).toBe(0);
        expect(JSON.parse(removed.stdout.trim())).toMatchObject({
          data: {
            action: "remove",
            changed: true,
            launch_flag_can_restore: false,
            additional_directories: [],
          },
        });

        const readded = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(readded.code).toBe(0);

        const active = await runFx(["workspace", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(active.code).toBe(0);
        expect(JSON.parse(active.stdout.trim())).toMatchObject({
          data: {
            action: "list",
            changed: false,
            additional_directories: [{ path: sharedRoot, active: true }],
          },
        });

        rmSync(sharedRoot, { recursive: true, force: true });
        const unavailable = await runFx(["workspace", "list", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(unavailable.code).toBe(0);
        expect(JSON.parse(unavailable.stdout.trim()).data.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: false,
            active: false,
          },
        ]);

        const unavailableRemoved = await runFx(
          ["workspace", "remove", `${sharedRoot}${sep}`, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unavailableRemoved.code).toBe(0);
        expect(JSON.parse(unavailableRemoved.stdout.trim())).toMatchObject({
          data: { action: "remove", changed: true, additional_directories: [] },
        });
        const removedSettings = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(
          removedSettings.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        mkdirSync(sharedRoot);
        const restored = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(restored.code).toBe(0);

        const cleared = await runFx(["workspace", "clear", "--json"], {
          cwd: workspaceRoot,
          env: baseEnv,
        });
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout.trim())).toMatchObject({
          data: { action: "clear", changed: true, additional_directories: [] },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "workspace commands mutate persisted aliases by workspace identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-alias-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const sharedLink = join(root, "shared-link");
        const missing = join(root, "missing");
        const realParent = join(root, "real-parent");
        const parentLink = join(root, "parent-link");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".fiber"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(realParent);
        symlinkSync(shared, sharedLink, "dir");
        symlinkSync(realParent, parentLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const settingsPath = join(home, ".fiber", "settings.json");
        const baseEnv = {
          ...NO_GATEWAY_AUTH,
          HOME: realpathSync(home),
        };

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${sharedRoot}${sep}.`,
                  sharedLink,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        const unchanged = await runFx(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unchanged.code).toBe(0);
        expect(JSON.parse(unchanged.stdout.trim())).toMatchObject({
          data: {
            action: "add",
            changed: true,
            saved_changed: true,
            runtime_changed: false,
          },
        });

        const removedAvailable = await runFx(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedAvailable.code).toBe(0);
        expect(JSON.parse(removedAvailable.stdout.trim())).toMatchObject({
          data: { action: "remove", changed: true, additional_directories: [] },
        });
        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${missing}${sep}.`,
                  join(missing, "child", ".."),
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedUnavailable = await runFx(
          ["workspace", "remove", missing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedUnavailable.code).toBe(0);
        expect(JSON.parse(removedUnavailable.stdout.trim())).toMatchObject({
          data: { action: "remove", changed: true, additional_directories: [] },
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        const realMissing = join(realParent, "missing");
        const linkedMissing = join(parentLink, "missing");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [realMissing, linkedMissing],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedLinkedPrefix = await runFx(
          ["workspace", "remove", linkedMissing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedLinkedPrefix.code).toBe(0);
        expect(JSON.parse(removedLinkedPrefix.stdout.trim())).toMatchObject({
          data: { action: "remove", changed: true, additional_directories: [] },
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("cli: MCP profile add", () => {
  test("status and doctor inspect MCP without transport while list stays disconnected", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cli-mcp-inspect-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const pidPath = join(root, "mcp.pid");
    mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    writeFileSync(join(home, ".fiber", "settings.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(home, ".fiber", "mcp.json"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "local",
            command: [process.execPath, MODERN_MCP_FIXTURE],
            environment: { FIBER_MCP_PID_PATH: pidPath },
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = { HOME: home, ...NO_GATEWAY_AUTH };
    try {
      const status = await runFx(["status", "--json"], { cwd: workspace, env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout.trim()).data.mcp).toMatchObject({
        connection_check: "not_checked",
        servers: [{
          name: "fixture",
          source: "profile",
          connection: "not_checked",
          authentication: "not_checked",
        }],
      });
      expect(existsSync(pidPath)).toBe(false);

      const doctor = await runFx(["doctor", "--json"], { cwd: workspace, env });
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout.trim()).data.mcp.connection_check).toBe(
        "not_checked",
      );
      expect(existsSync(pidPath)).toBe(false);

      const passive = await runFx(["mcp", "list"], { cwd: workspace, env });
      expect(passive.code).toBe(0);
      expect(passive.stdout).not.toContain("state=");
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("lists paths and removes profile servers without launching MCP transport", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cli-mcp-manage-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const profileMarker = join(root, "profile-launched");
    const workspaceMarker = join(root, "workspace-launched");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(home, ".fiber", "settings.json"), JSON.stringify({}));
    writeFileSync(
      join(home, ".fiber", "mcp.json"),
      JSON.stringify({
        mcp: {
          shared: {
            command: ["/bin/sh", "-c", `touch ${profileMarker}`],
          },
        },
      }),
    );
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: {
            command: "/bin/sh",
            args: ["-c", `touch ${workspaceMarker}`],
          },
          "workspace-only": {
            command: "/bin/sh",
            args: ["-c", `touch ${workspaceMarker}`],
          },
          broken: {
            command: "${MISSING_LIST_COMMAND}",
          },
        },
      }),
    );
    const env = { HOME: home, ...NO_GATEWAY_AUTH };
    try {
      const path = await runFx(["mcp", "path"], { cwd: workspace, env });
      expect(path.code).toBe(0);
      expect(path.stderr).toBe("");
      expect(path.stdout.trim()).toBe(join(home, ".fiber", "mcp.json"));

      const before = await runFx(["mcp", "list"], { cwd: workspace, env });
      expect(before.code).toBe(0);
      expect(before.stderr).toBe("");
      expect(before.stdout).toMatch(/shared source=profile scope=profile/);
      expect(before.stdout).toMatch(
        /workspace-only source=workspace scope=workspace/,
      );
      expect(before.stdout).not.toMatch(/shared source=workspace scope=workspace/);
      expect(before.stdout).not.toContain("MISSING_LIST_COMMAND");
      expect(existsSync(profileMarker)).toBe(false);
      expect(existsSync(workspaceMarker)).toBe(false);

      const removed = await runFx(["mcp", "remove", "shared"], {
        cwd: workspace,
        env,
      });
      expect(removed.code).toBe(0);
      expect(removed.stderr).toBe("");
      expect(removed.stdout).toContain("Removed MCP server 'shared'");
      expect(JSON.parse(readFileSync(join(home, ".fiber", "mcp.json"), "utf8")))
        .toEqual({ mcp: {} });

      const after = await runFx(["mcp", "list"], { cwd: workspace, env });
      expect(after.code).toBe(0);
      expect(after.stdout).toMatch(/shared source=workspace scope=workspace/);
      expect(existsSync(profileMarker)).toBe(false);
      expect(existsSync(workspaceMarker)).toBe(false);

      const missing = await runFx(["mcp", "remove", "missing"], {
        cwd: workspace,
        env,
      });
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("MCP server 'missing' was not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds local and HTTP servers without launching either server", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cli-mcp-add-")));
    const home = join(root, "home");
    const marker = join(root, "launched");
    mkdirSync(home, { recursive: true });
    try {
      const help = await runFx(["mcp", "--help"], {
        env: { HOME: home, ...NO_GATEWAY_AUTH },
      });
      expect(help.code).toBe(0);
      for (const command of [
        "fiber mcp add NAME COMMAND [ARGS...]",
        "fiber mcp auth NAME",
        "fiber mcp list",
        "fiber mcp logout NAME",
        "fiber mcp path",
        "fiber mcp remove NAME",
        "fiber mcp trust approve|reject NAME",
        "fiber mcp trust approve-all|reset",
      ]) expect(help.stdout).toContain(command);

      const local = await runFx(
        ["mcp", "add", "local", "/bin/sh", "-c", `touch ${marker}`],
        { env: { HOME: home, ...NO_GATEWAY_AUTH } },
      );
      expect(local.code).toBe(0);
      expect(local.stderr).toBe("");
      expect(local.stdout).toContain("Saved MCP server 'local'");
      expect(existsSync(marker)).toBe(false);

      const remote = await runFx(
        [
          "mcp",
          "add",
          "--transport",
          "http",
          "remote",
          "https://example.test/mcp",
        ],
        { env: { HOME: home, ...NO_GATEWAY_AUTH } },
      );
      expect(remote.code).toBe(0);
      expect(remote.stderr).toBe("");

      const profile = JSON.parse(
        readFileSync(join(home, ".fiber", "mcp.json"), "utf8"),
      );
      expect(profile).not.toHaveProperty("mcpServers");
      expect(profile.mcp.local.command).toEqual([
        "/bin/sh",
        "-c",
        `touch ${marker}`,
      ]);
      expect(profile.mcp.remote).toMatchObject({
        type: "http",
        url: "https://example.test/mcp",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes alias input and refuses ambiguous server-like keys", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cli-mcp-alias-")));
    const home = join(root, "home");
    const fxDir = join(home, ".fiber");
    mkdirSync(fxDir, { recursive: true, mode: 0o700 });
    const profilePath = join(fxDir, "mcp.json");
    try {
      writeFileSync(
        profilePath,
        JSON.stringify({ mcpServers: { old: { command: "old-server" } } }),
        { mode: 0o600 },
      );
      const migrated = await runFx(
        ["mcp", "add", "new", "new-server"],
        { env: { HOME: home, ...NO_GATEWAY_AUTH } },
      );
      expect(migrated.code).toBe(0);
      const canonical = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(Object.keys(canonical.mcp).sort()).toEqual(["new", "old"]);
      expect(canonical).not.toHaveProperty("mcpServers");

      const ambiguous = JSON.stringify({
        mcp: { canonical: { command: "canonical-server" } },
        "MCP-Servers": { blocked: { command: "blocked-server" } },
        metadata: { owner: "team" },
      });
      writeFileSync(profilePath, ambiguous, { mode: 0o600 });
      const refused = await runFx(
        ["mcp", "add", "unsafe", "must-not-save"],
        { env: { HOME: home, ...NO_GATEWAY_AUTH } },
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("McpConfigAmbiguousServerKey");
      expect(readFileSync(profilePath, "utf8")).toBe(ambiguous);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent different-name additions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cli-mcp-race-")));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    try {
      const [first, second] = await Promise.all([
        runFx(["mcp", "add", "first", "first-server"], {
          env: { HOME: home, ...NO_GATEWAY_AUTH },
        }),
        runFx(["mcp", "add", "second", "second-server"], {
          env: { HOME: home, ...NO_GATEWAY_AUTH },
        }),
      ]);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const profile = JSON.parse(
        readFileSync(join(home, ".fiber", "mcp.json"), "utf8"),
      );
      expect(Object.keys(profile.mcp).sort()).toEqual(["first", "second"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails precisely without HOME or valid add syntax", async () => {
    const missingHome = await runFx(["mcp", "add", "fixture", "node"], {
      env: { HOME: undefined, ...NO_GATEWAY_AUTH },
    });
    expect(missingHome.code).not.toBe(0);
    expect(missingHome.stderr).toContain("HomeNotSet");

    const invalid = await runFx(
      ["mcp", "add", "--transport", "sse", "fixture", "https://example.test"],
      { env: { HOME: tmpdir(), ...NO_GATEWAY_AUTH } },
    );
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("mcp add NAME COMMAND");
  });
});
