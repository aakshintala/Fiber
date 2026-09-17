import { afterAll, afterEach, expect } from "bun:test";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { FIBER_BIN } from "./eval-helpers";
import {
  terminalFixtureShell,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

export const INTERNAL_MODE = "--fiber-internal-terminal-host";
export const HEADER_BYTES = 28;
export const TERMINAL_FIXTURE_SHELL = terminalFixtureShell();
export const CLEANUP_CHILD_EXIT_TIMEOUT_MS = 5_000;
export const PRIVATE_TMUX_COMMAND_TIMEOUT_MS = 5_000;
export const PRIVATE_TMUX_SETTLE_TIMEOUT_MS = 5_000;
export const PRIVATE_TMUX_BLOCKING_COMMAND_PHASES = 5;
export const PRIVATE_TMUX_CLEANUP_TIMEOUT_MS =
  PRIVATE_TMUX_COMMAND_TIMEOUT_MS * PRIVATE_TMUX_BLOCKING_COMMAND_PHASES +
  PRIVATE_TMUX_SETTLE_TIMEOUT_MS;
export const MAX_PRIVATE_TMUX_SERVERS_PER_TEST = 14;
export const CLEANUP_FINALIZATION_BUDGET_MS = 5_000;
export const TMUX_SHELL_START_DEADLINE_MS = 60_000;
export const TMUX_MARKER_IO_DEADLINE_MS = 14_000;
export const TMUX_COMMAND_STARTUP_MARKER_IO_PHASES = 4;
export const TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS =
  TMUX_SHELL_START_DEADLINE_MS +
  TMUX_MARKER_IO_DEADLINE_MS * TMUX_COMMAND_STARTUP_MARKER_IO_PHASES +
  CLEANUP_FINALIZATION_BUDGET_MS;
export const TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS =
  TMUX_SHELL_START_DEADLINE_MS +
  TMUX_MARKER_IO_DEADLINE_MS +
  CLEANUP_FINALIZATION_BUDGET_MS;
export const TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS = 1_000;
export const NATIVE_STARTUP_OBSERVATION_BUDGET_MS = 30_000;
export const TERMINAL_OPERATION_OBSERVATION_BUDGET_MS = 20_000;
export const TMUX_EXPLICIT_BACKEND_TEST_TIMEOUT_MS =
  TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS * 2 +
  TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS +
  CLEANUP_CHILD_EXIT_TIMEOUT_MS +
  CLEANUP_FINALIZATION_BUDGET_MS;
export const TMUX_DELAYED_PROFILE_TEST_TIMEOUT_MS =
  TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS +
  TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS +
  CLEANUP_FINALIZATION_BUDGET_MS;
export const SHELL_STARTUP_PHASE_BUDGET_MS =
  2_500 + CLEANUP_FINALIZATION_BUDGET_MS;
// Bash and zsh each run normal, boundary, and clean delayed command phases.
// Configured login, signal, and forged completion add three before finalization.
export const SHELL_STARTUP_FIXTURE_TEST_TIMEOUT_MS =
  2 * 3 * SHELL_STARTUP_PHASE_BUDGET_MS +
  3 * SHELL_STARTUP_PHASE_BUDGET_MS +
  CLEANUP_FINALIZATION_BUDGET_MS;
export const CLEANUP_HOOK_TIMEOUT_MS =
  Math.max(
    CLEANUP_CHILD_EXIT_TIMEOUT_MS,
    PRIVATE_TMUX_CLEANUP_TIMEOUT_MS * MAX_PRIVATE_TMUX_SERVERS_PER_TEST,
  ) + CLEANUP_FINALIZATION_BUDGET_MS;
export const homes: string[] = [];
export const children: ChildProcessWithoutNullStreams[] = [];
export const hostPids: number[] = [];
export const fixtureArtifacts: string[] = [];
export const terminalHostFixtureState = {
  currentClientFixtureBinary: null as string | null,
  currentThreadForkFixtureBinary: null as string | null,
};

export function loginShellProfile(): string | null {
  const shell = userInfo().shell;
  if (shell.endsWith("/zsh")) return ".zprofile";
  if (shell.endsWith("/bash")) return ".bash_profile";
  return null;
}

export const privateTmuxServers = new Map<string, PrivateTmuxResource>();
export const transportRoots = new Set<string>();
export const TERMINAL_OWNER_SESSION = "terminal-fixture-owner";
export const authorityBySession = new Map<string, Record<string, unknown>>();
export const homeBySession = new Map<string, string>();
export const writeLeaseSessions = new Set<string>();

export type Range = { minimum: number; current: number };
export type WireFrame = {
  revision: number;
  kind: number;
  subject: number;
  correlation: number;
  payload: unknown;
};


export async function cleanupOwnedTestResources(
  cleanupTmux: typeof cleanupPrivateTmuxServer = cleanupPrivateTmuxServer,
  waitForChildExit: typeof waitForExit = waitForCleanupChildExit,
): Promise<void> {
  const ownedHostPids = hostPids.splice(0);
  const ownedChildren = children.splice(0);
  const ownedTmuxResources = [...privateTmuxServers.values()];
  privateTmuxServers.clear();
  const ownedHomes = homes.splice(0);
  const ownedTransportRoots = [...transportRoots];
  transportRoots.clear();
  authorityBySession.clear();
  homeBySession.clear();
  writeLeaseSessions.clear();

  let firstFailure: unknown;
  let failed = false;
  const recordFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    firstFailure = error;
  };

  for (const pid of ownedHostPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        recordFailure(error);
      }
    }
  }
  for (const child of ownedChildren) {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        recordFailure(error);
      }
    }
  }
  const childCleanupTasks = ownedChildren.map(async (child) => {
    try {
      await waitForChildExit(child);
    } catch (error) {
      recordFailure(error);
    }
  });
  const tmuxCleanupTasks = ownedTmuxResources.map(async (resource) => {
    try {
      await cleanupTmux(resource);
    } catch (error) {
      recordFailure(error);
    }
  });
  const tmuxAndFilesystemCleanup = Promise.all(tmuxCleanupTasks).then(() => {
    for (const home of ownedHomes) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (error) {
        recordFailure(error);
      }
    }
    for (const root of ownedTransportRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        recordFailure(error);
      }
    }
  });
  await Promise.all([...childCleanupTasks, tmuxAndFilesystemCleanup]);
  if (failed) throw firstFailure;
}

export function makeHome(): string {
  // Keep the profile endpoint (<HOME>/.fiber/terminal-host-v7/host.sock)
  // under the macOS 104-byte socket limit. tmpdir() on macOS is a ~48-char
  // /var/folders/... path that pushes the endpoint to ~109 bytes, tripping
  // the product's NameTooLong fallback (hashed root under /private/tmp).
  // The fallback is covered by dedicated makeLongHome tests; these tests
  // exercise the non-fallback layout via hostPaths().
  const home = mkdtempSync(join("/tmp", "fiber-terminal-host-"));
  chmodSync(home, 0o700);
  const owner = join(home, ".fiber", "sessions", TERMINAL_OWNER_SESSION);
  mkdirSync(owner, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".fiber"), 0o700);
  chmodSync(join(home, ".fiber", "sessions"), 0o700);
  chmodSync(owner, 0o700);
  homes.push(home);
  return home;
}

export function isolateZshStartupFixture(home: string): void {
  const contents = "unsetopt GLOBAL_RCS\n";
  const zshenv = join(home, ".zshenv");
  writeFileSync(zshenv, contents);
  expect(readFileSync(zshenv, "utf8")).toBe(contents);
}

export type PrivateTmuxResource = {
  socket: string;
  durableDir: string;
  identities: Set<string>;
};

export function rememberPrivateTmuxServer(home: string): PrivateTmuxResource {
  const socket = terminalTransportPaths(home).tmuxSocket;
  const existing = privateTmuxServers.get(socket);
  if (existing) return existing;
  if (privateTmuxServers.size >= MAX_PRIVATE_TMUX_SERVERS_PER_TEST) {
    throw new Error(
      `test owns more than ${MAX_PRIVATE_TMUX_SERVERS_PER_TEST} private tmux servers`,
    );
  }
  const resource = {
    socket,
    durableDir: hostPaths(home).dir,
    identities: new Set<string>(),
  };
  privateTmuxServers.set(socket, resource);
  return resource;
}

export function rememberPrivateTmuxIdentities(resource: PrivateTmuxResource): void {
  if (!existsSync(resource.socket)) return;
  try {
    const names = execFileSync(
      "tmux",
      ["-S", resource.socket, "list-sessions", "-F", "#{session_name}"],
      {
        encoding: "utf8",
        stdio: "pipe",
        timeout: PRIVATE_TMUX_COMMAND_TIMEOUT_MS,
      },
    );
    for (const name of names.trim().split("\n")) {
      if (name.startsWith("fiber-") && name.length === 38) {
        resource.identities.add(name.slice("fiber-".length));
      }
    }
  } catch {}
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processGroupId(pid: number): number {
  const value = Number(
    execFileSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
    }).trim(),
  );
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`missing process group for ${pid}`);
  }
  return value;
}

export function processFdCount(pid: number): number {
  const proc = `/proc/${pid}/fd`;
  if (existsSync(proc)) return readdirSync(proc).length;
  const output = execFileSync(
    "lsof",
    ["-a", "-p", String(pid), "-Fn"],
    { encoding: "utf8" },
  );
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("n")),
  ).size;
}

export function directChildPids(pid: number): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  });
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([child]) => child);
}

export type TmuxCleanupProof = {
  identities: string[];
  panePids: number[];
  processPids: number[];
};

export function privateTmuxProcessPids(
  socket: string,
  identities: string[],
  timeoutMs = PRIVATE_TMUX_COMMAND_TIMEOUT_MS,
): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2]! } : null;
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null)
    .filter((entry) =>
      entry.command.includes(socket) ||
      identities.some((identity) => entry.command.includes(identity))
    )
    .map((entry) => entry.pid);
}

export function tmuxPeerArtifacts(): string[] {
  return readdirSync("/tmp")
    .filter((name) =>
      name.startsWith("fiber-tmux-capture-") ||
      name.startsWith("fiber-tmux-marker-")
    )
    .sort();
}

export function tmuxCaptureHelperPids(): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2]! } : null;
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null)
    .filter((entry) =>
      entry.command.includes(FIBER_BIN) &&
      entry.command.includes("--fiber-internal-terminal-tmux-capture")
    )
    .map((entry) => entry.pid)
    .sort((left, right) => left - right);
}

export function tmuxBackendIdentities(resource: PrivateTmuxResource): string[] {
  const root = resource.durableDir;
  if (!existsSync(root)) return [];
  const identities = new Set<string>();
  for (const name of readdirSync(root)) {
    if (!name.endsWith("-manifest.json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(root, name), "utf8")) as {
        backend_identity?: string;
      };
      if (value.backend_identity) identities.add(value.backend_identity);
    } catch {}
  }
  return [...identities];
}

export async function cleanupPrivateTmuxServer(
  resource: PrivateTmuxResource,
): Promise<TmuxCleanupProof> {
  const { socket } = resource;
  for (const identity of tmuxBackendIdentities(resource)) {
    resource.identities.add(identity);
  }
  rememberPrivateTmuxIdentities(resource);
  const identities = [...resource.identities];
  let panePids: number[] = [];
  if (existsSync(socket)) {
    try {
      panePids = execFileSync(
        "tmux",
        ["-S", socket, "list-panes", "-a", "-F", "#{pane_pid}"],
        {
          encoding: "utf8",
          stdio: "pipe",
          timeout: PRIVATE_TMUX_COMMAND_TIMEOUT_MS,
        },
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
    } catch {}
  }
  const processPids = privateTmuxProcessPids(socket, identities);
  if (existsSync(socket)) {
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], {
        stdio: "pipe",
        timeout: PRIVATE_TMUX_COMMAND_TIMEOUT_MS,
      });
    } catch {}
  }
  for (const pid of privateTmuxProcessPids(socket, identities)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const settleDeadline = Date.now() + PRIVATE_TMUX_SETTLE_TIMEOUT_MS;
  await waitFor(() => {
    const remainingMs = settleDeadline - Date.now();
    if (remainingMs <= 0) return false;
    return panePids.every((pid) => !processExists(pid)) &&
      privateTmuxProcessPids(socket, identities, remainingMs).length === 0;
  }, PRIVATE_TMUX_SETTLE_TIMEOUT_MS);
  for (const identity of identities) {
    rmSync(`/tmp/fiber-tmux-capture-${identity}.sock`, { force: true });
    rmSync(`/tmp/fiber-tmux-marker-${identity}.sock`, { force: true });
  }
  rmSync(socket, { force: true });
  return { identities, panePids, processPids };
}

export async function runClientFixture(
  home: string,
  idleMs = 500,
  extraEnv: NodeJS.ProcessEnv = {},
  binary = FIBER_BIN,
) {
  const current = binary === FIBER_BIN;
  const executable = current ? buildCurrentClientFixture() : binary;
  const args = current ? [] : ["--fiber-internal-terminal-client-fixture"];
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      HOME: home,
      SHELL: TERMINAL_FIXTURE_SHELL,
      FIBER_TERMINAL_HOST_IDLE_MS: String(idleMs),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const stdout = streamText(child.stdout);
  const stderr = streamText(child.stderr);
  const exitCode = await waitForExit(child);
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

export function buildCurrentClientFixture(): string {
  if (terminalHostFixtureState.currentClientFixtureBinary !== null) return terminalHostFixtureState.currentClientFixtureBinary;
  const repoRoot = join(import.meta.dir, "../..");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "fiber-terminal-client-fixture-"));
  const binary = join(fixtureRoot, "terminal-client-fixture");
  fixtureArtifacts.push(fixtureRoot);
  execFileSync(
    "zig",
    [
      "build-exe",
      "-ODebug",
      "-lc",
      `-femit-bin=${binary}`,
      join(repoRoot, "src", "terminal_client_fixture.zig"),
    ],
    { cwd: repoRoot, stdio: "pipe", timeout: 120_000 },
  );
  terminalHostFixtureState.currentClientFixtureBinary = binary;
  return binary;
}

export function buildThreadForkFixture(): string {
  if (terminalHostFixtureState.currentThreadForkFixtureBinary !== null) {
    return terminalHostFixtureState.currentThreadForkFixtureBinary;
  }
  const repoRoot = join(import.meta.dir, "../..");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "fiber-terminal-thread-fork-"));
  const source = join(fixtureRoot, "thread-fork.c");
  const binary = join(fixtureRoot, "thread-fork");
  fixtureArtifacts.push(fixtureRoot);
  writeFileSync(
    source,
    String.raw`#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *proof_path;
static const char *term_path;

static void on_term(int signal_number) {
    (void)signal_number;
    int fd = open(term_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        (void)write(fd, "term", 4);
        (void)close(fd);
    }
    _exit(0);
}

static void *fork_child(void *unused) {
    (void)unused;
    int ready[2];
    if (pipe(ready) != 0) _exit(69);
    pid_t worker_tid = (pid_t)syscall(SYS_gettid);
    pid_t child_pid = fork();
    if (child_pid < 0) _exit(70);
    if (child_pid == 0) {
        close(ready[0]);
        if (setpgid(0, 0) != 0) _exit(71);
        struct sigaction action = {0};
        action.sa_handler = on_term;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGTERM, &action, NULL) != 0) _exit(72);
        (void)write(ready[1], "1", 1);
        close(ready[1]);
        for (;;) pause();
    }

    close(ready[1]);
    char ready_byte = 0;
    if (read(ready[0], &ready_byte, 1) != 1) _exit(74);
    close(ready[0]);

    int fd = open(proof_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) _exit(73);
    dprintf(fd, "%d %d %d\n", getpid(), worker_tid, child_pid);
    close(fd);
    (void)write(STDOUT_FILENO, "thread-fork-ready\n", 18);
    int status = 0;
    (void)waitpid(child_pid, &status, 0);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc != 3) return 64;
    proof_path = argv[1];
    term_path = argv[2];
    pthread_t worker;
    if (pthread_create(&worker, NULL, fork_child, NULL) != 0) return 65;
    if (pthread_join(worker, NULL) != 0) return 66;
    return 0;
}
`,
  );
  execFileSync(
    "zig",
    ["cc", "-O2", "-pthread", source, "-o", binary],
    { cwd: repoRoot, stdio: "pipe", timeout: 120_000 },
  );
  terminalHostFixtureState.currentThreadForkFixtureBinary = binary;
  return binary;
}

buildCurrentClientFixture();

export function hostPaths(home: string) {
  const dir = join(home, ".fiber", "terminal-host-v7");
  return {
    dir,
    socket: join(dir, "host.sock"),
    lock: join(dir, "host.lock"),
    identity: join(dir, "host.json"),
  };
}

export function terminalTransportPaths(home: string) {
  const durable = hostPaths(home);
  const capacity = process.platform === "darwin"
    ? 104
    : process.platform === "linux"
    ? 108
    : 0;
  if (capacity === 0 || Buffer.byteLength(durable.socket) < capacity) {
    return {
      dir: durable.dir,
      socket: durable.socket,
      tmuxSocket: join(durable.dir, "tmux.sock"),
    };
  }
  const digest = createHash("sha256")
    .update("fiber.terminal.transport.v3\0")
    .update(home)
    .digest("hex")
    .slice(0, 32);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("missing Unix uid");
  const base = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const dir = join(base, `fiber-terminal-${uid}-${digest}`);
  return {
    dir,
    socket: join(dir, "host.sock"),
    tmuxSocket: join(dir, "tmux.sock"),
  };
}

export function makeLongHome(endpointBytes = 141): string {
  const root = mkdtempSync(join(tmpdir(), "fiber-terminal-long-home-"));
  const endpointSuffix = join(".fiber", "terminal-host-v7", "host.sock");
  const componentBytes = endpointBytes -
    Buffer.byteLength(root) -
    Buffer.byteLength(endpointSuffix) -
    2;
  if (componentBytes <= 0) throw new Error("temporary root is too long");
  const home = join(root, "x".repeat(componentBytes));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const owner = join(home, ".fiber", "sessions", TERMINAL_OWNER_SESSION);
  mkdirSync(owner, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".fiber"), 0o700);
  chmodSync(join(home, ".fiber", "sessions"), 0o700);
  chmodSync(owner, 0o700);
  homes.push(home, root);
  transportRoots.add(terminalTransportPaths(home).dir);
  return home;
}

export function durableTerminalRecord(home: string): {
  path: string;
  value: { session_id: string; lifecycle: string };
} {
  const state = join(
    home,
    ".fiber",
    "sessions",
    TERMINAL_OWNER_SESSION,
    "terminal",
    "state",
  );
  const name = readdirSync(state).find((entry) =>
    entry.startsWith("record-") && entry.endsWith(".json")
  );
  if (!name) throw new Error("terminal record not found");
  const path = join(state, name);
  return {
    path,
    value: JSON.parse(readFileSync(path, "utf8")),
  };
}

export function durableTerminalRecordFor(
  home: string,
  sessionId: string,
): Record<string, unknown> {
  return JSON.parse(readFileSync(join(
    home,
    ".fiber",
    "sessions",
    TERMINAL_OWNER_SESSION,
    "terminal",
    "state",
    `record-${sessionId}.json`,
  ), "utf8"));
}

export function durableEventIds(home: string, sessionId: string): number[] {
  const state = join(
    home,
    ".fiber",
    "sessions",
    TERMINAL_OWNER_SESSION,
    "terminal",
    "state",
  );
  const prefix = `event-${sessionId}-`;
  return readdirSync(state)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
    .map((entry) => Number(entry.slice(prefix.length, -".json".length)))
    .sort((left, right) => left - right);
}

export function rememberRecoveredAuthority(
  sessionId: string,
  cwd: string,
  backend: "native" | "tmux",
): void {
  const persistence = (withPersistence({ cwd, backend }) as {
    persistence: {
      grant: { principal: Record<string, unknown>; actor: string; generation: unknown };
      proof: unknown;
    };
  }).persistence;
  authorityBySession.set(sessionId, {
    principal: persistence.grant.principal,
    actor: persistence.grant.actor,
    generation: persistence.grant.generation,
    proof: persistence.proof,
  });
}

export function startHost(
  home: string,
  range: Range = { minimum: 4, current: 5 },
  idleMs = 350,
  extraEnv: NodeJS.ProcessEnv = {},
  binary = FIBER_BIN,
): ChildProcessWithoutNullStreams {
  const child = spawn(binary, [INTERNAL_MODE], {
    env: {
      ...process.env,
      HOME: home,
      SHELL: TERMINAL_FIXTURE_SHELL,
      FIBER_TERMINAL_HOST_IDLE_MS: String(idleMs),
      FIBER_TERMINAL_HOST_PROTOCOL_MIN: String(range.minimum),
      FIBER_TERMINAL_HOST_PROTOCOL_CURRENT: String(range.current),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

export function startHostWithAdvertisedProtocol(
  home: string,
  idleMs = 350,
  extraEnv: NodeJS.ProcessEnv = {},
  binary = FIBER_BIN,
): ChildProcessWithoutNullStreams {
  const child = spawn(binary, [INTERNAL_MODE], {
    env: {
      ...process.env,
      HOME: home,
      SHELL: TERMINAL_FIXTURE_SHELL,
      FIBER_TERMINAL_HOST_IDLE_MS: String(idleMs),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

export const protocolFixtureDefinitions = {
  incompatible: {
    range: { minimum: 2, current: 3 },
    capabilities: 3,
  },
  previous: {
    range: { minimum: 3, current: 4 },
    capabilities: 3,
  },
  signal_limited: {
    range: { minimum: 4, current: 5 },
    capabilities: 15,
  },
  current_checkpoint: {
    range: { minimum: 4, current: 5 },
    capabilities: 31,
  },
} as const;

export function protocolFixtureEnv(
  fixture: (typeof protocolFixtureDefinitions)[keyof typeof protocolFixtureDefinitions],
): NodeJS.ProcessEnv {
  return {
    FIBER_TERMINAL_HOST_PROTOCOL_MIN: String(fixture.range.minimum),
    FIBER_TERMINAL_HOST_PROTOCOL_CURRENT: String(fixture.range.current),
    FIBER_TERMINAL_HOST_PROTOCOL_CAPABILITIES: String(fixture.capabilities),
  };
}

export type WaitForEvidence = {
  description?: string;
  child?: ChildProcessWithoutNullStreams;
  stderrTail?: () => string;
};

export async function expectAbsentDuring(path: string, windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(existsSync(path)).toBe(false);
    await Bun.sleep(10);
  }
  expect(existsSync(path)).toBe(false);
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  description = "fixture",
  evidence: WaitForEvidence = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      const child = evidence.child ?? null;
      let stderrTail = "";
      try {
        stderrTail = evidence.stderrTail?.() ?? "";
      } catch {}
      throw new Error(
        `fixture timed out waiting for ${evidence.description ?? description} after ${timeoutMs}ms` +
          (child
            ? `; host pid=${child.pid ?? "unknown"} exitCode=${child.exitCode} signal=${child.signalCode}`
            : "") +
          (stderrTail ? `\nHost stderr tail:\n${stderrTail.slice(-4_000)}` : ""),
      );
    }
    await Bun.sleep(10);
  }
}

export async function expectProfileFailedRejection(
  tracePath: string,
  sessionId: string | undefined,
  label: string,
): Promise<void> {
  // code=2 is StartupFailure.profile_failed. It also fires for a plain
  // child exit, so every call site pairs this with the forged payload
  // surfacing as inert session output: the spoof pin is rejection PLUS
  // unhonored bytes, which a plain exit cannot satisfy.
  expect(sessionId).toBeDefined();
  await waitFor(
    () =>
      existsSync(tracePath) &&
      readFileSync(tracePath, "utf8").includes(
        `tmux startup failed id=${sessionId} code=2`,
      ),
    5_000,
    label,
  );
}

export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return 128;
  return await new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", reject);
  });
}

export async function waitForCleanupChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return 128;
  return await new Promise<number>((resolve, reject) => {
    const finish = (result: () => void): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      result();
    };
    const onExit = (code: number | null): void =>
      finish(() => resolve(code ?? 1));
    const onError = (error: Error): void => finish(() => reject(error));
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(
        `fixture child ${child.pid ?? "unknown"} did not exit within ` +
          `${CLEANUP_CHILD_EXIT_TIMEOUT_MS}ms of cleanup`,
      )));
    }, CLEANUP_CHILD_EXIT_TIMEOUT_MS);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

export function encodeFrame(
  revision: number,
  kind: number,
  subject: number,
  correlation: number,
  payload: unknown,
  requiredCapabilities = 0,
): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("FXTH", 0, "ascii");
  header.writeUInt16LE(revision, 4);
  header[6] = kind;
  header[7] = subject;
  header.writeBigUInt64LE(BigInt(requiredCapabilities), 8);
  header.writeBigUInt64LE(BigInt(correlation), 16);
  header.writeUInt32LE(body.length, 24);
  return Buffer.concat([header, body]);
}

export class FrameClient {
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private failure: Error | undefined;

  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
      this.wake = undefined;
    });
    socket.on("error", (error) => {
      this.failure = error;
      this.wake?.();
      this.wake = undefined;
    });
    socket.on("close", () => {
      this.failure ??= new Error("socket closed");
      this.wake?.();
      this.wake = undefined;
    });
  }

  static async connect(path: string): Promise<FrameClient> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new FrameClient(socket);
  }

  send(frame: Buffer): void {
    this.socket.write(frame);
  }

  async read(): Promise<WireFrame> {
    while (this.buffer.length < HEADER_BYTES) await this.waitForData();
    const payloadLength = this.buffer.readUInt32LE(24);
    const frameLength = HEADER_BYTES + payloadLength;
    while (this.buffer.length < frameLength) await this.waitForData();
    const bytes = this.buffer.subarray(0, frameLength);
    this.buffer = this.buffer.subarray(frameLength);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("FXTH");
    return {
      revision: bytes.readUInt16LE(4),
      kind: bytes[6],
      subject: bytes[7],
      correlation: Number(bytes.readBigUInt64LE(16)),
      payload: JSON.parse(bytes.subarray(HEADER_BYTES).toString("utf8")),
    };
  }

  close(): void {
    this.socket.end();
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    if (this.failure) throw this.failure;
  }
}

export async function handshake(
  socketPath: string,
  clientRange: Range,
  capabilities = 31,
  helloRevision = clientRange.current,
): Promise<{
  client: FrameClient;
  hostRange: Range;
  hostCapabilities: number;
  helloRevision: number;
  revision?: number;
}> {
  const client = await FrameClient.connect(socketPath);
  client.send(
    encodeFrame(helloRevision, 0, 0, 0, {
      hello: {
        range: clientRange,
        capabilities,
        required_capabilities: 0,
      },
    }),
  );
  const hello = await client.read();
  const hostHello = (hello.payload as {
    hello: { range: Range; capabilities: number };
  }).hello;
  const hostRange = hostHello.range;
  const minimum = Math.max(clientRange.minimum, hostRange.minimum);
  const current = Math.min(clientRange.current, hostRange.current);
  return {
    client,
    hostRange,
    hostCapabilities: hostHello.capabilities,
    helloRevision: hello.revision,
    revision: minimum <= current ? current : undefined,
  };
}

export async function requestScreen(
  client: FrameClient,
  revision: number,
  correlation: number,
): Promise<WireFrame> {
  client.send(
    encodeFrame(revision, 1, 2, correlation, {
      request: { screen: { session_id: "terminal-fixture" } },
    }),
  );
  return client.read();
}

export const actionSubjects = {
  start: 0,
  read: 1,
  screen: 2,
  write: 3,
  wait: 4,
  inspect: 5,
  list: 6,
  resize: 7,
  signal: 8,
  close: 9,
} as const;

export async function requestAction(
  client: FrameClient,
  revision: number,
  correlation: number,
  action: keyof typeof actionSubjects,
  value: unknown,
): Promise<WireFrame> {
  let payload = action === "start"
    ? ("persistence" in (value as Record<string, unknown>)
      ? value
      : withPersistence(value as Record<string, unknown>))
    : withAuthority(action, value as Record<string, unknown>);
  const writeSessionId = action === "write"
    ? (value as { session_id: string }).session_id
    : undefined;
  if (
    action === "write" &&
    !("lease" in (value as Record<string, unknown>)) &&
    !writeLeaseSessions.has(writeSessionId!)
  ) {
    const acquire = withAuthority("write", {
      session_id: (value as { session_id: string }).session_id,
      lease: "acquire",
    });
    client.send(
      encodeFrame(
        revision,
        1,
        actionSubjects.write,
        correlation + 1_000_000,
        { request: { write: acquire } },
        1,
      ),
    );
    success(await client.read(), "write");
    writeLeaseSessions.add(writeSessionId!);
    payload = { ...(payload as Record<string, unknown>), lease: "use" };
  } else if (action === "write" && !("lease" in (value as Record<string, unknown>))) {
    payload = { ...(payload as Record<string, unknown>), lease: "use" };
  }
  client.send(
    encodeFrame(
      revision,
      1,
      actionSubjects[action],
      correlation,
      { request: { [action]: payload } },
      1,
    ),
  );
  const frame = await client.read();
  if (action === "start") rememberStartAuthority(frame, payload as Record<string, unknown>);
  if (action === "write" && (value as { lease?: string }).lease === "acquire" &&
      (frame.payload as { response?: { success?: unknown } }).response?.success) {
    writeLeaseSessions.add(writeSessionId!);
  }
  if (
    (action === "close" ||
      (action === "write" && ["release", "revoke"].includes(
        (value as { lease?: string }).lease ?? "",
      ))) && writeSessionId
  ) {
    writeLeaseSessions.delete(writeSessionId);
  }
  return frame;
}

export function withAuthority(
  action: keyof typeof actionSubjects,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sessionId = action === "list"
    ? authorityBySession.keys().next().value
    : value.session_id as string;
  const authority = value.authority ??
    (sessionId ? authorityBySession.get(sessionId) : undefined);
  if (!authority) return value;
  if (action !== "list") return { ...value, authority };
  if (value.owner_authority) return value;
  const { authority: _, authority_session_id: __, ...filters } = value;
  return {
    ...filters,
    owner_authority: ownerCatalogAuthorityForSession(sessionId, authority),
  };
}

export function rememberStartAuthority(
  frame: WireFrame,
  request: Record<string, unknown>,
): void {
  const start = (frame.payload as {
    response?: { success?: { start?: { session?: { session_id?: string } } } };
  }).response?.success?.start;
  const failedSessionId = (frame.payload as {
    response?: { failure?: { action?: string; session_id?: string } };
  }).response?.failure;
  const sessionId = start?.session?.session_id ??
    (failedSessionId?.action === "start" ? failedSessionId.session_id : undefined);
  const persistence = request.persistence as {
    grant: { principal: Record<string, unknown>; actor: string; generation: unknown };
    proof: unknown;
  } | undefined;
  if (!sessionId || !persistence) return;
  authorityBySession.set(sessionId, {
    principal: persistence.grant.principal,
    actor: persistence.grant.actor,
    generation: persistence.grant.generation,
    proof: persistence.proof,
  });
  const home = homes.find((candidate) => existsSync(join(
    candidate,
    ".fiber",
    "sessions",
    TERMINAL_OWNER_SESSION,
    "terminal",
    "state",
    `record-${sessionId}.json`,
  )));
  if (home) homeBySession.set(sessionId, home);
}

export function ownerCatalogAuthorityForSession(
  sessionId: string,
  sessionAuthority: Record<string, unknown>,
): Record<string, unknown> {
  const home = homeBySession.get(sessionId);
  if (!home) throw new Error(`terminal owner home not found for ${sessionId}`);
  const principal = sessionAuthority.principal as Record<string, string>;
  const actor = sessionAuthority.actor as string;
  const ownerPrincipal = {
    profile_user: principal.profile_user,
    durable_session_id: principal.durable_session_id,
    workspace_root: principal.workspace_root,
    transport_role: principal.transport_role,
  };
  const proof = { bytes: Array(32).fill(11) };
  const claim = { principal: ownerPrincipal, actor, proof };
  const key = ownerCatalogDigest(
    "fiber.terminal.owner-catalog-key.v2\0",
    ownerPrincipal,
    actor,
  ).toString("hex");
  const verifier = ownerCatalogDigest(
    "fiber.terminal.owner-catalog-proof.v2\0",
    ownerPrincipal,
    actor,
    Buffer.from(proof.bytes),
  );
  const terminalRoot = join(
    home,
    ".fiber",
    "sessions",
    ownerPrincipal.durable_session_id,
    "terminal",
  );
  const state = join(terminalRoot, "state");
  const proofs = join(terminalRoot, "proofs");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(proofs, { recursive: true, mode: 0o700 });
  writeFileSync(join(proofs, `catalog-proof-${key}`), Buffer.from(proof.bytes), {
    mode: 0o600,
  });
  writeFileSync(
    join(state, `catalog-authority-${key}.json`),
    JSON.stringify({
      schema_version: 2,
      principal: ownerPrincipal,
      actor,
      verifier: [...verifier],
    }),
    { mode: 0o600 },
  );
  return claim;
}

export function ownerCatalogDigest(
  domain: string,
  principal: Record<string, string>,
  actor: string,
  proof?: Buffer,
): Buffer {
  const hash = createHash("sha256");
  hash.update(domain);
  if (proof) hash.update(proof);
  hash.update(actor);
  hash.update(principal.transport_role);
  for (const value of [
    principal.profile_user,
    principal.durable_session_id,
    principal.workspace_root,
  ]) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest();
}

export function authorityVariant(
  sessionId: string,
  changes: {
    actor?: string;
    principal?: Record<string, unknown>;
    generation?: unknown;
    proof?: unknown;
  },
): Record<string, unknown> {
  const current = authorityBySession.get(sessionId)! as {
    principal: Record<string, unknown>;
    actor: string;
    generation: unknown;
    proof: unknown;
  };
  return {
    ...current,
    ...changes,
    principal: changes.principal ?? current.principal,
  };
}

export function withPersistence(value: Record<string, unknown>): Record<string, unknown> {
  const cwd = typeof value.cwd === "string" ? value.cwd : "/";
  const backend = value.backend === "tmux" ? "tmux" : "native";
  return {
    ...value,
    persistence: {
      grant: {
        principal: {
          profile_user: "terminal-fixture",
          durable_session_id: TERMINAL_OWNER_SESSION,
          workspace_root: cwd,
          cwd,
          transport_role: "interactive",
          backend,
          lifetime: "session",
        },
        actor: "agent",
        controls: {
          read: true,
          screen: true,
          write: true,
          wait: true,
          inspect: true,
          list: true,
          resize: true,
          signal: true,
          close: true,
        },
        generation: { value: 1 },
      },
      proof: { bytes: Array(32).fill(7) },
      direct_human_model_read_only: false,
    },
  };
}

export function success(frame: WireFrame, action: string): Record<string, unknown> {
  const response = (frame.payload as {
    response?: { success?: Record<string, Record<string, unknown>> };
  }).response;
  const value = response?.success?.[action];
  if (!value) {
    throw new Error(
      `expected successful ${action} response: ${JSON.stringify(frame.payload)}`,
    );
  }
  return value;
}

export function failure(frame: WireFrame): { action: string; code: string } {
  const value = (
    frame.payload as {
      response?: { failure?: { action: string; code: string } };
    }
  ).response?.failure;
  if (!value) throw new Error("expected failure response");
  return value;
}

export function failureCode(frame: WireFrame): string | undefined {
  return (frame.payload as {
    response?: { failure?: { code?: string } };
  }).response?.failure?.code;
}

export async function readSession(
  client: FrameClient,
  revision: number,
  correlation: number,
  sessionId: string,
  offset = 0,
): Promise<{ output: string; session: Record<string, unknown> }> {
  const frame = await requestAction(client, revision, correlation, "read", {
    session_id: sessionId,
    cursor: { segment: 1, offset },
  });
  return success(frame, "read") as {
    output: string;
    session: Record<string, unknown>;
  };
}

export async function startCommand(
  client: FrameClient,
  revision: number,
  correlation: number,
  options: {
    cwd: string;
    command?: string;
    shell?: unknown;
    backend?: "native" | "tmux";
    returnWhen?: unknown;
    waitMs?: number;
    dimensions?: { rows: number; columns: number };
    startupAttempts?: number;
  },
): Promise<Record<string, unknown>> {
  const tmuxResource = options.backend === "tmux"
    ? rememberPrivateTmuxServer(options.cwd)
    : null;
  const startupAttempts = Math.max(1, options.startupAttempts ?? 1);
  let frame: WireFrame | undefined;
  for (let attempt = 0; attempt < startupAttempts; attempt++) {
    frame = await requestAction(
      client,
      revision,
      correlation + attempt * 10_000,
      "start",
      {
        cwd: options.cwd,
        command: options.command,
        shell: options.shell ?? { user_login: {} },
        backend: options.backend ?? "native",
        return_when: options.returnWhen ?? { started: {} },
        wait_ceiling_ms: options.waitMs ?? 20_000,
        dimensions: options.dimensions ?? { rows: 24, columns: 80 },
      },
    );
    if (failureCode(frame) !== "startup_failed" || attempt + 1 === startupAttempts) {
      break;
    }
    await Bun.sleep(50);
  }
  if (tmuxResource) rememberPrivateTmuxIdentities(tmuxResource);
  return success(frame!, "start");
}

export async function finishStartupObservation(
  client: FrameClient,
  revision: number,
  correlation: number,
  initial: Record<string, unknown>,
  backend: "native" | "tmux",
  returnWhen: unknown,
  safetyCeilingMs: number,
): Promise<Record<string, unknown>> {
  const outcome = initial.outcome as Record<string, unknown>;
  if (!("safety_ceiling" in outcome)) return initial;
  expect(initial).toMatchObject({
    outcome: { safety_ceiling: {} },
    session: { backend },
  });
  expect(["starting", "running"]).toContain(
    (initial.session as { lifecycle: string }).lifecycle,
  );
  const sessionId = (initial.session as { session_id: string }).session_id;
  const observed = success(
    await requestAction(client, revision, correlation, "wait", {
      session_id: sessionId,
      return_when: returnWhen,
      safety_ceiling_ms: safetyCeilingMs,
    }),
    "wait",
  );
  if ("safety_ceiling" in (observed.outcome as Record<string, unknown>)) {
    throw new Error(
      `terminal startup did not finish within the observation budget: ${JSON.stringify(observed)}`,
    );
  }
  return observed;
}

export async function startInteractiveTmuxFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  options: {
    cwd: string;
    command: string;
    marker: string;
  },
): Promise<Record<string, unknown>> {
  const started = await finishStartupObservation(
    client,
    revision,
    correlation + 1,
    await startCommand(client, revision, correlation, {
      cwd: options.cwd,
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { started: {} },
      waitMs: TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
    }),
    "tmux",
    { started: {} },
    TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS,
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  success(
    await requestAction(client, revision, correlation + 2, "write", {
      session_id: sessionId,
      payload: { text: `${options.command}\n` },
    }),
    "write",
  );
  const ready = success(
    await requestAction(client, revision, correlation + 3, "wait", {
      session_id: sessionId,
      return_when: { match: options.marker },
      safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
    }),
    "wait",
  );
  expect(ready.outcome).toEqual({ condition_met: {} });
  return started;
}

export async function forceCloseStartedFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  started: Record<string, unknown>,
): Promise<void> {
  const sessionId = (started.session as { session_id: string }).session_id;
  success(
    await requestAction(client, revision, correlation, "close", {
      session_id: sessionId,
      policy: "force",
    }),
    "close",
  );
}

export async function forceCloseTerminalFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  sessionId: string,
): Promise<void> {
  success(
    await requestAction(
      client,
      revision,
      correlation,
      "close",
      { session_id: sessionId, policy: "force" },
    ),
    "close",
  );
}

export type StartedFixtureCleanup = {
  correlation: number;
  started: Record<string, unknown>;
};

export async function forceCloseStartedFixtures(
  client: FrameClient,
  revision: number,
  cleanups: StartedFixtureCleanup[],
): Promise<void> {
  for (const cleanup of cleanups) {
    await forceCloseStartedFixture(
      client,
      revision,
      cleanup.correlation,
      cleanup.started,
    );
  }
}

export async function startNativeShellFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  options: {
    cwd: string;
    shell?: unknown;
    dimensions?: { rows: number; columns: number };
    initialMonitors?: unknown[];
  },
): Promise<Record<string, unknown>> {
  let lastObservation: Record<string, unknown> | undefined;
  const deferredCleanup: StartedFixtureCleanup[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptCorrelation = correlation + attempt * 10_000;
    const initial = await startCommand(client, revision, attemptCorrelation, {
      cwd: options.cwd,
      shell: options.shell ?? {
        executable: { path: TERMINAL_FIXTURE_SHELL, clean_start: true },
      },
      backend: "native",
      returnWhen: { started: {} },
      waitMs: NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
      dimensions: options.dimensions,
      initialMonitors: options.initialMonitors,
    });
    const outcome = initial.outcome as Record<string, unknown>;
    if (!("safety_ceiling" in outcome)) {
      await forceCloseStartedFixtures(client, revision, deferredCleanup);
      return initial;
    }

    lastObservation = initial;
    deferredCleanup.push({
      correlation: attemptCorrelation + 9_000,
      started: initial,
    });
    if (attempt === 0) {
      console.error("Retrying native shell fixture after startup observation ceiling");
    }
  }
  await forceCloseStartedFixtures(client, revision, deferredCleanup);
  throw new Error(
    `native shell startup retry exhausted: ${JSON.stringify(lastObservation)}`,
  );
}

export async function startInteractiveNativeFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  options: {
    cwd: string;
    command: string;
    marker: string;
    shell?: unknown;
    dimensions?: { rows: number; columns: number };
    initialMonitors?: unknown[];
  },
): Promise<Record<string, unknown>> {
  const started = await startNativeShellFixture(client, revision, correlation, options);
  const sessionId = (started.session as { session_id: string }).session_id;
  success(
    await requestAction(client, revision, correlation + 2, "write", {
      session_id: sessionId,
      payload: { text: `${options.command}\n` },
    }),
    "write",
  );
  const ready = success(
    await requestAction(client, revision, correlation + 3, "wait", {
      session_id: sessionId,
      return_when: { match: options.marker },
      safety_ceiling_ms: NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2,
    }),
    "wait",
  );
  expect(ready.outcome).toEqual({ condition_met: {} });
  return started;
}

export async function startNativeCommandFixture(
  client: FrameClient,
  revision: number,
  correlation: number,
  options: {
    cwd: string;
    command: string;
    shell: unknown;
    returnWhen: unknown;
    waitMs?: number;
    dimensions?: { rows: number; columns: number };
    initialMonitors?: unknown[];
  },
): Promise<Record<string, unknown>> {
  let lastObservation: Record<string, unknown> | undefined;
  const deferredCleanup: StartedFixtureCleanup[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptCorrelation = correlation + attempt * 3;
    const startedInitial = await startCommand(
      client,
      revision,
      attemptCorrelation,
      {
        cwd: options.cwd,
        command: options.command,
        shell: options.shell,
        backend: "native",
        returnWhen: options.returnWhen,
        waitMs: Math.max(
          options.waitMs ?? 0,
          NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
        ),
        dimensions: options.dimensions,
        initialMonitors: options.initialMonitors,
      },
    );
    const outcome = startedInitial.outcome as Record<string, unknown>;
    if (!("safety_ceiling" in outcome)) {
      await forceCloseStartedFixtures(client, revision, deferredCleanup);
      return startedInitial;
    }

    lastObservation = startedInitial;
    deferredCleanup.push({
      correlation: attemptCorrelation + 2,
      started: startedInitial,
    });
    if (attempt === 0) {
      console.error("Retrying native command fixture after startup observation ceiling");
    }
  }
  await forceCloseStartedFixtures(client, revision, deferredCleanup);
  throw new Error(
    `native command startup retry exhausted: ${JSON.stringify(lastObservation)}`,
  );
}


export function registerTerminalHostCleanupHooks(): void {
  afterEach(async () => {
    await cleanupOwnedTestResources();
  }, CLEANUP_HOOK_TIMEOUT_MS);

  afterAll(() => {
    for (const root of fixtureArtifacts.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
