import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexSerializedToolCall,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  fakeCodexModelsPayload,
  startFakeCodex,
  writeSeededChatGptLogin,
  terminalFixtureShell,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const TERMINAL_FIXTURE_SHELL = terminalFixtureShell();
const MARKDOWN =
  "# Ask presentation\n\n" +
  "**bold** and [docs](https://example.com)\n\n" +
  "- first item\n- second item\n\n---\n\n" +
  "| Name | Value |\n| --- | --- |\n| one | two |\n\n" +
  "```zig\nconst answer: u8 = 42;\n```\n";

const roots: string[] = [];
const servers: Array<{ stop(): void }> = [];
const sessions: TmuxSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.kill();
  for (const server of servers.splice(0)) server.stop();
  await Promise.all(roots.map(waitForTerminalHostExit));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForTerminalHostExit(root: string): Promise<void> {
  const identityPath = join(root, "home", ".fiber", "terminal-host-v7", "host.json");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(identityPath)) return;
    await Bun.sleep(25);
  }
  throw new Error(`terminal host did not exit for ${root}`);
}

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "fiber-e2e-ask-presentation-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  writeSeededChatGptLogin(home, chatGptAccessToken());
  roots.push(root);
  return { root, home: realpathSync(home), workspace: realpathSync(workspace) };
}

function createShortRoot() {
  const root = realpathSync(mkdtempSync("/tmp/fiber-ask-terminal-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  writeSeededChatGptLogin(home, chatGptAccessToken());
  roots.push(root);
  return { root, home: realpathSync(home), workspace: realpathSync(workspace) };
}

function codexEnv(
  home: string,
  codex: ReturnType<typeof startFakeCodex>,
): Record<string, string | undefined> {
  return fakeCodexEnv(home, codex, {
    FIBER_DISABLE_KEYCHAIN: "1",
    FIBER_SKIP_ONBOARDING: "1",
    FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
    FIBER_PERMISSION_MODE: "auto",
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function terminalCommand(args: string[]): string {
  const fiber_cmd = [FIBER_BIN, ...args].map(shellQuote).join(" ");
  const script = `${fiber_cmd}; code=$?; printf '\\n__FIBER_EXIT_%s__\\n' "$code"; exit "$code"`;
  return `/bin/sh -c ${shellQuote(script)}`;
}

let reviewCount = 0;

// Answers the single forced permission_decision review call with a clear
// decision. Used on every route that serves a tool call in auto mode.
function reviewBranch(body: string) {
  if (!body.includes("<permission_review>")) return null;
  reviewCount += 1;
  return codexToolCall(`review_decision_${reviewCount}`, "permission_decision", {
    risk: "low",
    decision: "clear",
    rationale: "test fixture",
  });
}

function outputCount(body: string): number {
  const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
  return items.filter((item) => item.type === "function_call_output").length;
}

function streamingCodexText(lines: string[]) {
  return (
    lines
      .map(
        (line) =>
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: `${line}\n`,
          })}` + "\n\n",
      )
      .join("") +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 3, output_tokens: lines.length },
      },
    })}` +
      "\n\n"
  );
}

describe("fiber ask presentation", () => {
  test("redirected command output separates the next tool header", async () => {
    const root = createRoot();
    const codex = startFakeCodex({
      route: (body) => {
        const done = outputCount(body);
        if (done === 0) {
          return codexToolCall("no-final-newline", "shell", {
            request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf no-final-newline" },
          });
        }
        if (done === 1) {
          return codexToolCall("next-command", "shell", {
            request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf 'next-output\\n'" },
          });
        }
        return codexFinalText("Commands complete.\n");
      },
    });
    servers.push(codex);

    const result = await runFx(
      ["ask", "--json", "--permission-mode", "yolo", "--no-save", "Run both commands."],
      {
        cwd: root.workspace,
        env: codexEnv(root.home, codex),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Running printf no-final-newline\n");
    expect(result.stderr).toContain("Running printf 'next-output\\n'\n");
    expect(JSON.parse(result.stdout).data.output).toBe("Commands complete.\n");
  }, TIMEOUT);

  test("no-save advertises process-local shell actions and preserves run profiles", async () => {
    const configuredShell = userInfo().shell;
    if (!configuredShell.endsWith("/bash") && !configuredShell.endsWith("/zsh")) return;

    const root = createRoot();
    if (configuredShell.endsWith("/zsh")) {
      writeFileSync(
        join(root.home, ".zprofile"),
        "export FIBER_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n",
      );
      writeFileSync(
        join(root.home, ".zshrc"),
        "export FIBER_PROFILE_RC=rc\nalias fiber_profile_alias='printf alias-user'\n" +
          "fiber_profile_function() { printf function-user; }\n",
      );
    } else {
      writeFileSync(
        join(root.home, ".bash_profile"),
        "export FIBER_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n" +
          "source \"$HOME/.bashrc\"\n",
      );
      writeFileSync(
        join(root.home, ".bashrc"),
        "export FIBER_PROFILE_RC=rc\nalias fiber_profile_alias='printf alias-user'\n" +
          "fiber_profile_function() { printf function-user; }\n",
      );
    }

    const profileCommand =
      "printf 'mode=%s:%s:' \"${FIBER_PROFILE_LOGIN-unset}\" \"${FIBER_PROFILE_RC-unset}\"; " +
      "case :\"$PATH\": in *:\"$HOME/profile-bin\":*) printf 'path-user:';; *) printf 'path-clean:';; esac; " +
      "if alias fiber_profile_alias >/dev/null 2>&1; then fiber_profile_alias; else printf no-alias; fi; printf ':'; " +
      "if command -v fiber_profile_function >/dev/null; then fiber_profile_function; else printf no-function; fi";
    const nestedExecMarker = join(root.workspace, "nested-no-save-ran");
    const shellCalls = [
      { id: "shell-omitted", args: { request: { action: "run", command: profileCommand, yield_time_ms: 30_000 } } },
      { id: "shell-clean", args: { request: { action: "run", command: profileCommand, profile: "clean", yield_time_ms: 30_000 } } },
      { id: "shell-user", args: { request: { action: "run", command: profileCommand, profile: "user", yield_time_ms: 30_000 } } },
      { id: "shell-stale-tty", args: { request: { action: "run", command: "printf should-not-start", tty: true } } },
      { id: "shell-nested-run", args: { request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: `printf nested > ${JSON.stringify(nestedExecMarker)}` } } },
      { id: "shell-neighbor-run", args: { request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf neighbor-exec" } } },
    ];
    const codex = startFakeCodex({
      route: (body) => {
        const done = outputCount(body);
        if (done < shellCalls.length) {
          const call = shellCalls[done]!;
          return codexToolCall(call.id, "shell", call.args);
        }
        return codexFinalText("Shell no-save profiles verified.\n");
      },
    });
    servers.push(codex);

    const result = await runFx(
      ["ask", "--json", "--permission-mode", "yolo", "--no-save", "Verify shell run profiles."],
      {
        cwd: root.workspace,
        env: codexEnv(root.home, codex),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout).data as {
      output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toBe("Shell no-save profiles verified.\n");
    expect(output.tool_calls.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "error" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
    ]);
    expect(codex.requests).toHaveLength(7);

    const firstRequest = JSON.parse(codex.requests[0]!.body) as {
      tools: Array<any>;
    };
    const shellTool = firstRequest.tools.find(({ name }) => name === "shell");
    const shellSchema = shellTool?.parameters;
    expect(Object.keys(shellSchema?.properties ?? {})).toEqual(["request"]);
    expect(shellSchema?.required).toEqual(["request"]);
    expect(shellSchema?.additionalProperties).toBe(false);
    const branches = shellSchema?.properties?.request?.oneOf ?? [];
    expect(branches.map((branch: any) => branch.properties.action.enum[0])).toEqual([
      "run",
      "interact",
      "stop",
      "list",
    ]);
    const serializedShellTool = JSON.stringify(shellTool);
    expect(serializedShellTool).not.toContain('"tty"');
    expect(serializedShellTool).not.toContain('"write"');
    expect(serializedShellTool).not.toContain('"terminal"');

    for (const requestIndex of [1, 3]) {
      expect(codex.requests[requestIndex]!.body).toContain("mode=login:rc:path-user:");
      expect(codex.requests[requestIndex]!.body).toContain("alias-user:function-user");
    }
    expect(codex.requests[2]!.body).toContain("mode=unset:unset:path-clean:");
    expect(codex.requests[2]!.body).toContain("no-alias:no-function");
    expect(codex.requests[4]!.body).toContain("tool_execution_failed");
    expect(codex.requests[4]!.body).toContain("tool_execution_failed");
    expect(codex.requests[4]!.body).not.toContain("authority_denied");
    expect(codex.requests[4]!.body).not.toContain("tool_permission_denied");
    expect(codex.requests[5]!.body).toContain("nested");
    expect(existsSync(nestedExecMarker)).toBe(true);
    expect(codex.requests[6]!.body).toContain("neighbor-exec");
    expect(
      existsSync(join(root.home, ".fiber", "terminal-host-v7", "host.json")),
    ).toBe(false);
  }, TIMEOUT);

  test("redirected and JSON stdout preserve raw assistant Markdown", async () => {
    const root = createRoot();
    const rawCodex = startFakeCodex({ route: () => codexFinalText(MARKDOWN) });
    servers.push(rawCodex);
    const raw = await runFx(["ask", "--no-save", "Render the fixture."], {
      cwd: root.workspace,
      env: codexEnv(root.home, rawCodex),
      timeoutMs: TIMEOUT,
    });

    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe(MARKDOWN);
    expect(raw.stdout).not.toContain("\x1b");
    expect(raw.stderr).toBe("");

    const jsonCodex = startFakeCodex({ route: () => codexFinalText(MARKDOWN) });
    servers.push(jsonCodex);
    const json = await runFx(
      ["ask", "--json", "--no-save", "Render the fixture."],
      {
        cwd: root.workspace,
        env: codexEnv(root.home, jsonCodex),
        timeoutMs: TIMEOUT,
      },
    );

    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).data.output).toBe(MARKDOWN);
    expect(json.stdout).not.toContain("\x1b");
    expect(json.stderr).toBe("");
  }, TIMEOUT);

  test("JSON separates accumulated assistant Markdown from the completed final response", async () => {
    const root = createRoot();
    writeFileSync(join(root.workspace, "fixture.txt"), "fixture contents\n");
    const intermediate = "I will inspect the fixture first.\n";
    const final = "The fixture inspection is complete.";
    const codex = startFakeCodex({
      route: (body) => {
        const reviewed = reviewBranch(body);
        if (reviewed) return reviewed;
        if (outputCount(body) > 0) return codexFinalText(final);
        return codexSerializedToolCall(
          "read_fixture_for_final_output",
          "read_file",
          JSON.stringify({ path: "fixture.txt" }),
          intermediate,
        );
      },
    });
    servers.push(codex);

    const result = await runFx(
      ["ask", "--json", "--permission-mode", "auto", "--no-save", "Inspect fixture.txt."],
      {
        cwd: root.workspace,
        env: codexEnv(root.home, codex),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout).data as {
      output: string;
      final_output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toContain(intermediate.trim());
    expect(output.output).toContain(final.trim());
    expect(output.output.indexOf(intermediate.trim())).toBeLessThan(
      output.output.indexOf(final.trim()),
    );
    expect(output.final_output).toBe(final);
    expect(output.final_output).not.toContain(intermediate.trim());
    expect(output.tool_calls).toEqual([
      { name: "read_file", status: "success" },
    ]);
    expect(codex.requests).toHaveLength(2);
    expect(result.stderr).toContain("Reading fixture.txt");
  }, TIMEOUT);

  test.skipIf(!tmuxAvailable())(
    "TTY stdout uses the Minimal transcript and compact tool group",
    async () => {
      const root = createRoot();
      writeFileSync(join(root.workspace, "fixture.txt"), "fixture contents\n");
      let releaseFinal: (() => void) | undefined;
      const finalReady = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      const codex = startFakeCodex({
        route: async (body) => {
          const reviewed = reviewBranch(body);
          if (reviewed) return reviewed;
          const done = outputCount(body);
          if (done === 0) {
            return codexToolCall("read_fixture", "read_file", { path: "fixture.txt" });
          }
          if (done === 1) {
            return codexSerializedToolCall(
              "read_missing",
              "read_file",
              JSON.stringify({ path: "missing.txt" }),
              "Between groups.\n",
            );
          }
          await finalReady;
          return codexFinalText(MARKDOWN);
        },
      });
      servers.push(codex);

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--permission-mode", "auto",
          "--no-save",
          "Inspect fixture.txt and render the response.",
        ]),
        cwd: root.workspace,
        env: { ...codexEnv(root.home, codex), NO_COLOR: undefined },
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      sessions.push(session);

      await session.waitForText("Between groups.", TIMEOUT);
      await session.resizeWindow(104, 36);
      releaseFinal!();
      await session.waitForText("__FIBER_EXIT_0__", TIMEOUT);
      const pane = await session.capturePane();
      const scrollback = await session.captureFullScrollback();
      const escaped = await session.captureFullScrollbackEscapes();
      expect(scrollback).toContain("Inspect fixture.txt and render the response.");
      expect(pane.match(/1 tool call · 1 read/g)).toHaveLength(2);
      expect(pane).toContain("Reading fixture.txt");
      expect(pane).toContain("Between groups.");
      expect(pane).toContain("Reading missing.txt");
      expect(pane).toContain("failed");
      expect(pane).toContain("Ask presentation");
      expect(pane).toContain("bold and docs");
      expect(pane).toContain("first item");
      expect(pane).toContain("const answer: u8 = 42;");
      expect(pane).toContain("─ zig ─");
      expect(pane).not.toContain("│ const answer: u8 = 42;");
      expect(pane).not.toContain("# Ask presentation");
      expect(pane).not.toContain("**bold**");
      expect(escaped).toContain("\x1b[");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "light theme uses readable syntax colors in TTY code blocks with redirected stdin",
    async () => {
      const root = createRoot();
      const codex = startFakeCodex({ route: () => codexFinalText(MARKDOWN) });
      servers.push(codex);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: `${terminalCommand([
          "ask",
          "--no-save",
          "Render the light-theme fixture.",
        ])} </dev/null`,
        cwd: root.workspace,
        env: {
          ...codexEnv(root.home, codex),
          FIBER_THEME: "light",
          NO_COLOR: undefined,
        },
        width: 120,
        height: 40,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText("__FIBER_EXIT_0__", TIMEOUT);
      const escaped = await session.captureFullScrollbackEscapes();
      expect(escaped).toContain("\x1b[38;5;238mconst\x1b[39m");
      expect(escaped).not.toContain("\x1b[38;5;252mconst\x1b[39m");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY output taller than the pane survives in native scrollback",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 60 },
        (_, index) => `ANSWER_LINE_${String(index + 1).padStart(2, "0")}`,
      );
      const codex = startFakeCodex({
        route: () => codexFinalText(answerLines.map((line) => `${line}\n`).join("")),
      });
      servers.push(codex);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Render every answer line.",
        ]),
        cwd: root.workspace,
        env: codexEnv(root.home, codex),
        width: 80,
        height: 12,
        minimumHistoryLines: 200,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText("__FIBER_EXIT_0__", TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      let previousIndex = -1;
      for (const line of answerLines) {
        const index = scrollback.indexOf(line);
        expect(index, line).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY prints the header before output and releases while the response is open",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 40 },
        (_, index) => `OPEN_STREAM_LINE_${String(index + 1).padStart(2, "0")}`,
      );
      let releaseOutput = () => {};
      const outputGate = new Promise<void>((resolve) => {
        releaseOutput = resolve;
      });
      let releaseResponse = () => {};
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      // The Codex helper serves whole bodies, but this case needs a held
      // stream (header visible before lines, lines before completion), so it
      // keeps a local SSE server speaking the Responses shapes and records
      // into the shared request log.
      const codex = startFakeCodex();
      const streamServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/models") {
            return Response.json(fakeCodexModelsPayload());
          }
          const encoder = new TextEncoder();
          const body = await req.text();
          codex.requests.push({
            path: url.pathname,
            authorization: req.headers.get("authorization"),
            body,
          });
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await outputGate;
                for (const line of answerLines) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      type: "response.output_text.delta",
                      delta: `${line}\n`,
                    })}` + "\n\n",
                  ));
                }
                await responseGate;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                      status: "completed",
                      usage: { input_tokens: 3, output_tokens: answerLines.length },
                    },
                  })}` + "\n\n",
                ));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      servers.push(codex, { stop: () => streamServer.stop(true) });
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Stream every answer line.",
        ]),
        cwd: root.workspace,
        env: codexEnv(root.home, {
          responsesUrl: `http://127.0.0.1:${streamServer.port}/responses`,
          modelsUrl: `http://127.0.0.1:${streamServer.port}/models`,
          tokenUrl: codex.tokenUrl,
        } as ReturnType<typeof startFakeCodex>),
        width: 80,
        height: 12,
        minimumHistoryLines: 200,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      try {
        const requestDeadline = Date.now() + 5_000;
        while (codex.requests.length === 0 && Date.now() < requestDeadline) {
          await Bun.sleep(25);
        }
        expect(codex.requests).toHaveLength(1);

        const headerDeadline = Date.now() + 5_000;
        let initialScrollback = "";
        while (Date.now() < headerDeadline) {
          initialScrollback = await session.captureFullScrollback();
          if (
            initialScrollback.includes("Run /help for commands") &&
            initialScrollback.includes("Stream every answer line.")
          ) break;
          await Bun.sleep(25);
        }
        expect(initialScrollback).toContain("Run /help for commands");
        expect(initialScrollback).toContain("Stream every answer line.");
        expect(initialScrollback).not.toContain(answerLines[0]!);
        expect(initialScrollback.indexOf("Run /help for commands")).toBeLessThan(
          initialScrollback.indexOf("Stream every answer line."),
        );

        releaseOutput();
        const releaseDeadline = Date.now() + 5_000;
        let openScrollback = "";
        while (Date.now() < releaseDeadline) {
          openScrollback = await session.captureFullScrollback();
          if (openScrollback.includes(answerLines[0]!)) break;
          await Bun.sleep(25);
        }
        expect(openScrollback).toContain(answerLines[0]!);
      } finally {
        releaseOutput();
        releaseResponse();
      }

      await session.waitForText("__FIBER_EXIT_0__", TIMEOUT);
      const finalScrollback = await session.captureFullScrollback();
      expect(finalScrollback.split("Run /help for commands")).toHaveLength(2);
      for (const line of answerLines) {
        expect(finalScrollback.split(line)).toHaveLength(2);
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY wrapped output stays ordered and appears exactly once",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 7 },
        (_, index) =>
          `WRAPPED_LINE_${String(index + 1).padStart(2, "0")} ${"x".repeat(190)}`,
      );
      const codex = startFakeCodex({
        route: () => streamingCodexText(answerLines),
      });
      servers.push(codex);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Render every wrapped answer line.",
        ]),
        cwd: root.workspace,
        env: codexEnv(root.home, codex),
        width: 100,
        height: 20,
        minimumHistoryLines: 100,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText(/__FIBER_EXIT_[0-9]+__/, TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("__FIBER_EXIT_0__");
      let previousIndex = -1;
      for (const line of answerLines) {
        const marker = line.slice(0, "WRAPPED_LINE_00".length);
        const index = scrollback.indexOf(marker);
        expect(index, marker).toBeGreaterThan(previousIndex);
        expect(scrollback.split(marker)).toHaveLength(2);
        previousIndex = index;
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY Minimal hides context and auto-approval notices",
    async () => {
      const root = createRoot();
      const instructions = join(root.root, "instructions.md");
      writeFileSync(instructions, "# Fixture instructions\n");
      symlinkSync(instructions, join(root.workspace, "AGENTS.md"));
      const codex = startFakeCodex({
        route: (body) => {
          const reviewed = reviewBranch(body);
          if (reviewed) return reviewed;
          if (outputCount(body) > 0) return codexFinalText("Notice filtering complete.\n");
          return codexToolCall("write_fixture", "shell", {
            request: { action: "run", command: "printf notice-test > ask-notice.txt", timeout_ms: 600_000 },
          });
        },
      });
      servers.push(codex);

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--permission-mode", "auto",
          "--no-save",
          "Run the notice filtering fixture.",
        ]),
        cwd: root.workspace,
        env: { ...codexEnv(root.home, codex), NO_COLOR: undefined },
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      sessions.push(session);

      await session.waitForText("__FIBER_EXIT_0__", TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("Run the notice filtering fixture.");
      expect(scrollback).toContain("Notice filtering complete.");
      expect(scrollback).toContain("1 tool call · 1 command");
      expect(scrollback).not.toContain("project instructions");
      expect(scrollback).not.toContain("Auto agent approved this request");
      expect(scrollback).not.toContain("● System:");
    },
    TIMEOUT,
  );
});
