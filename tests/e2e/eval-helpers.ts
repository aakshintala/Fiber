// Shared helpers for the e2e suites. Requires a built binary; live suites
// additionally need real Codex credentials (see HAS_API_KEY below).
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const FIBER_BIN = resolve(import.meta.dirname, "../../zig-out/bin/fiber");
export const REPO_ROOT = resolve(import.meta.dirname, "../..");

function loadDotEnv(): Record<string, string> {
  const candidates = [join(REPO_ROOT, ".env"), join(REPO_ROOT, ".env.local")];
  const vars: Record<string, string> = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  }
  return vars;
}

export function shouldLoadDotEnv(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.FIBER_E2E_DISABLE_DOTENV !== "1";
}

const dotEnvVars = shouldLoadDotEnv() ? loadDotEnv() : {};

for (const [k, v] of Object.entries(dotEnvVars)) {
  if (!process.env[k]) process.env[k] = v;
}

const TEST_HOME_PREFIX = "fiber-test-home-";

export function createIsolatedTestHome(): string {
  return mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX));
}

export function cleanupIsolatedTestHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

// Generic fx CLI runner for deterministic command coverage.

export interface FxRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killSent: boolean;
  elapsedMs: number;
  pid: number | null;
  processStateAtTimeout: string;
  processStateAfterClose: string;
}

function captureFxProcessState(): string {
  try {
    return execFileSync("ps", ["-axo", "pid,ppid,stat,etime,command"], {
      encoding: "utf8",
    }).split("\n").filter((line) =>
      line.includes("/zig-out/bin/fiber") ||
      line.includes("mcp-modern-") ||
      line.includes("mcp-legacy-") ||
      line.includes("bun test")
    ).join("\n");
  } catch {
    return "process snapshot unavailable";
  }
}

export async function runFx(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string | Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<FxRunResult> {
  if (!existsSync(FIBER_BIN)) {
    throw new Error(`fiber binary not found at ${FIBER_BIN}. Run 'zig build' first.`);
  }

  const { cwd, timeoutMs = 15_000 } = opts;

  return new Promise<FxRunResult>((resolvePromise) => {
    const env: Record<string, string | undefined> = {
      ...dotEnvVars,
      ...process.env,
      NO_COLOR: "1",
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    };
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    const child = nodeSpawn(FIBER_BIN, args, {
      env,
      cwd: cwd ?? REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdoutBufs.push(d));
    child.stderr.on("data", (d: Buffer) => stderrBufs.push(d));
    child.stdin.end(opts.stdin);

    const startedAtMs = performance.now();
    let timedOut = false;
    let killSent = false;
    let processStateAtTimeout = "";
    const timer = setTimeout(() => {
      timedOut = true;
      processStateAtTimeout = captureFxProcessState();
      killSent = child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdoutBufs).toString(),
        stderr: Buffer.concat(stderrBufs).toString(),
        code,
        signal,
        timedOut,
        killSent,
        elapsedMs: performance.now() - startedAtMs,
        pid: child.pid ?? null,
        processStateAtTimeout,
        processStateAfterClose: code === 0 && !timedOut ? "" : captureFxProcessState(),
      });
    });
  });
}

// Live, model-backed suites need real Codex credentials. This used to key off
// a gateway API key, which the Codex-only runtime never sets, so every gated
// suite skipped silently and reported success.
export const HAS_API_KEY: boolean = !!(
  process.env.FIBER_E2E_LIVE ||
  existsSync(join(process.env.HOME ?? "", ".fiber", "chatgpt-auth.json"))
);
