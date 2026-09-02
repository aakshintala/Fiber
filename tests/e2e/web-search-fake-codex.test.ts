import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
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
import { FX_BIN, runFx } from "../evals/eval-helpers";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fx-web-search-codex-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fx"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  const permission: Record<string, Record<string, string>> = {};
  if (webSearchPermission) permission.web_search = { "*": webSearchPermission };
  writeFileSync(join(home, ".fx", "settings.json"), JSON.stringify({ ...settings, permission }));
  return { root, home, workspace: realpathSync(workspace) };
}

function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
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

class AcpClient {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;
  private activeSessionId: string | null = null;

  private constructor(private proc: ChildProcess) {
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const parts = this.buffer.split("\n");
      this.buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
    proc.on("close", () => {
      this.closed = true;
    });
  }

  static create(cwd: string, env: Record<string, string | undefined>) {
    const definedEnv = Object.fromEntries(
      Object.entries({ ...process.env, NO_COLOR: "1", ...env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return new AcpClient(nodeSpawn(FX_BIN, ["acp"], {
      cwd,
      env: definedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  send(message: object) {
    let outgoing = message as any;
    if (
      this.activeSessionId !== null &&
      [
        "session/prompt",
        "session/cancel",
        "session/set_mode",
        "session/set_config_option",
      ].includes(outgoing.method) &&
      outgoing.params?.sessionId === undefined
    ) {
      outgoing = {
        ...outgoing,
        params: { ...(outgoing.params ?? {}), sessionId: this.activeSessionId },
      };
    }
    this.proc.stdin!.write(`${JSON.stringify(outgoing)}\n`);
  }

  async readLine(timeoutMs = TIMEOUT): Promise<any> {
    const line = await new Promise<string>((resolve, reject) => {
      const buffered = this.lines.shift();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => reject(new Error("ACP read timeout")), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    return JSON.parse(line);
  }

  async request(method: string, params: object, id: number) {
    this.send({ jsonrpc: "2.0", id, method, params });
    let response: any;
    do {
      response = await this.readLine();
    } while (response.id !== id);
    if (
      response.error === undefined &&
      method === "session/new" &&
      typeof response.result?.sessionId === "string"
    ) {
      this.activeSessionId = response.result.sessionId;
    }
    return response;
  }

  async close() {
    if (this.closed) return;
    this.proc.stdin!.end();
    this.proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.closed) return;
    this.proc.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startAcpCodeSession(client: AcpClient) {
  await client.request("initialize", { protocolVersion: 1 }, 1);
  await client.request("session/new", { mcpServers: [] }, 2);
  await client.readLine();
  await client.request("session/set_mode", { modeId: "code" }, 3);
}

async function runAcpPrompt(client: AcpClient, text: string) {
  const id = 10;
  client.send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text }] },
  });
  const messages: any[] = [];
  while (true) {
    const message = await client.readLine();
    if (message.id === id && message.result) return messages;
    messages.push(message);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readAcpResponse(client: AcpClient, id: number) {
  while (true) {
    const message = await client.readLine();
    if (message.id === id) return message;
  }
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
          ["ask", "--auto", "--json", "--no-save", "Search the web for the latest Zig release."],
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
          ["ask", "--auto", "--json", "--no-save", "Search current Zig release information."],
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
              FX_PERMISSION_MODE: "auto",
              FX_MAX_AGENT_STEPS: "1",
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

  test(
    "ACP cancel interrupts an active stream and leaves the server usable",
    async () => {
      const root = createIsolatedRoot();
      let closeHanging!: () => void;
      let hangStarted = false;
      const codex = startFakeCodex({
        route: () => {
          hangStarted = true;
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
              closeHanging = () => {
                try {
                  controller.close();
                } catch {}
              };
            },
          }), { headers: { "content-type": "text/event-stream" } });
        },
      });
      const client = AcpClient.create(root.workspace, fakeCodexEnv(root.home, codex));
      try {
        await startAcpCodeSession(client);
        client.send({
          jsonrpc: "2.0",
          id: 10,
          method: "session/prompt",
          params: { prompt: [{ type: "text", text: "Search the web for the latest Zig release." }] },
        });
        await waitFor(() => hangStarted);

        client.send({ jsonrpc: "2.0", method: "session/cancel", params: {} });
        const cancelled = await readAcpResponse(client, 10);
        expect(cancelled.result.stopReason).toBe("cancelled");

        client.send({ jsonrpc: "2.0", id: 11, method: "session/list", params: {} });
        const list = await readAcpResponse(client, 11);
        expect(Array.isArray(list.result.sessions)).toBe(true);
      } finally {
        closeHanging?.();
        await client.close();
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "ACP policy denial omits web_search from the advertised tools",
    async () => {
      const root = createIsolatedRoot("deny");
      const codex = startFakeCodex();
      const client = AcpClient.create(root.workspace, fakeCodexEnv(root.home, codex));
      try {
        await startAcpCodeSession(client);
        const messages = await runAcpPrompt(client, "Issue denied web search.");

        expect(codex.requests).toHaveLength(1);
        expect(toolNames(codex.requests[0].body)).not.toContain("web_search");
        expect(JSON.stringify(messages)).not.toContain("Found 1 result");
      } finally {
        await client.close();
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
