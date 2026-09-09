/**
 * Session-recovery E2E (rebuild brief Task 1, plan.md "Session-recovery harness").
 *
 * Uniquely end-to-end here: the `doctor` / `sessions` / `session` CLI text and
 * real recovery copies. events.jsonl survival and checkpoint replay are covered
 * in-process (session_log.zig, session_store.zig) and are not re-proved here.
 *
 * Live: spec cases 1-6 and 10 (SIGKILL at a named `session_log.Boundary` via
 * `FIBER_E2E_SESSION_BOUNDARY`, wired into the `fiber ask` create path) plus 7
 * (watermark validation), 8 (recover copies), 9 (cross-workspace), and 11-16
 * (SIGKILL at each of the six `history_turn_committed` boundaries via
 * `ask --resume-id`). Each case spawns `fiber ask`, waits for the
 * `FIBER_E2E_SESSION_BOUNDARY_READY` file, SIGKILLs the paused pid (the pause
 * loop ignores SIGTERM), and asserts `sessions` / `doctor` / `session` CLI
 * surface behavior. Usage-checkpoint and recovery-checkpoint commits do not
 * honor the boundary pause, so cases 11-16 reach `history_turn_committed`
 * instead of an earlier reseal.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const ASK_TIMEOUT = 60_000;
const CLI_TIMEOUT = 15_000;
const CASE_TIMEOUT = 120_000;
const BOUNDARY_WAIT_MS = 40_000;

type Roots = {
  root: string;
  home: string;
  workspace: string;
};

function makeRoots(prefix: string): Roots {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace: realpathSync(workspace) };
}

function cleanupRoots(roots: Roots): void {
  rmSync(roots.root, { recursive: true, force: true });
}

function sessionDir(home: string, id: string): string {
  return join(home, ".fiber", "sessions", id);
}

function watermarkName(home: string, id: string): string {
  const names = readdirSync(sessionDir(home, id)).filter(
    (name) => name.startsWith("commit.") && name.endsWith(".json"),
  );
  expect(names).toHaveLength(1);
  return names[0]!;
}

/** Drive one saved `ask` turn against the fake Codex helper; returns the session id. */
async function askSaved(
  workspace: string,
  home: string,
  codex: ReturnType<typeof startFakeCodex>,
  prompt: string,
): Promise<string> {
  const result = await runFx(
    ["ask", "--json", "--permission-mode", "auto", prompt],
    {
      cwd: workspace,
      env: fakeCodexEnv(home, codex),
      timeoutMs: ASK_TIMEOUT,
    },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const json = JSON.parse(result.stdout.trim());
  expect(typeof json.data.session_id).toBe("string");
  return json.data.session_id as string;
}

async function showLastId(workspace: string, home: string): Promise<string> {
  const result = await runFx(["session", "show", "last", "--json"], {
    cwd: workspace,
    env: { HOME: home },
    timeoutMs: CLI_TIMEOUT,
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()).data.id as string;
}

const COMMIT_BOUNDARIES = [
  "after_event_append",
  "after_event_sync",
  "after_commit_intent_sync",
  "after_watermark_rename",
  "after_target_namespace_sync",
  "after_commit_intent_remove",
] as const;

type CommitBoundary = (typeof COMMIT_BOUNDARIES)[number];

const PENDING_AFTER_KILL: readonly CommitBoundary[] = [
  "after_commit_intent_sync",
  "after_watermark_rename",
  "after_target_namespace_sync",
];

const TURN_SURVIVES: readonly CommitBoundary[] = [
  "after_watermark_rename",
  "after_target_namespace_sync",
  "after_commit_intent_remove",
];

const VICTIM_PROMPT = "Second model turn.";
const RESOLVE_PROMPT = "Recover after the commit kill.";

const ORPHAN_RECOVERY =
  "rerun fiber doctor after active writers exit; cleanup is guarded";

function orphanDoctorLine(id: string): string {
  return `[warn] session: session ${id}: authority_less_creation_orphan; recovery=${ORPHAN_RECOVERY}`;
}

function pendingDoctorLine(id: string): string {
  return `[warn] session: session ${id}: authority_transition_pending report_only=true; recovery=${ORPHAN_RECOVERY}`;
}

function projectionMissingDoctorLine(id: string): string {
  return `[warn] session: session ${id}: projection_missing; recovery=open the session detail or resume it to rebuild projections`;
}

/**
 * Spawn a fresh `fiber ask`, wait until it pauses at the named create-path
 * boundary, SIGKILL the exact paused pid (the pause loop ignores SIGTERM),
 * and return the single orphaned session id left behind.
 */
async function killCreateAtBoundary(
  roots: Roots,
  codex: ReturnType<typeof startFakeCodex>,
  boundary: string,
): Promise<string> {
  const readyPath = join(roots.root, `boundary-${boundary}.ready`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: "1",
    ...fakeCodexEnv(roots.home, codex, {
      FIBER_E2E_SESSION_BOUNDARY: boundary,
      FIBER_E2E_SESSION_BOUNDARY_READY: readyPath,
    }),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(
    FIBER_BIN,
    ["ask", "--json", "--permission-mode", "auto", "Boundary probe turn."],
    { cwd: roots.workspace, env, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + BOUNDARY_WAIT_MS;
    while (!existsSync(readyPath)) {
      if (Date.now() > deadline) {
        throw new Error(`boundary ${boundary} never paused`);
      }
      await Bun.sleep(100);
    }
    expect(readFileSync(readyPath, "utf8")).toBe(boundary);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited; the close wait below still reaps it.
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const sessionsRoot = join(roots.home, ".fiber", "sessions");
  const orphans = readdirSync(sessionsRoot).filter((name) => {
    if (name === "latest") return false;
    try {
      return statSync(join(sessionsRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  expect(orphans).toHaveLength(1);
  return orphans[0]!;
}

async function askResume(
  workspace: string,
  home: string,
  codex: ReturnType<typeof startFakeCodex>,
  id: string,
  prompt: string,
) {
  const result = await runFx(
    ["ask", "--json", "--permission-mode", "auto", "--resume-id", id, prompt],
    {
      cwd: workspace,
      env: fakeCodexEnv(home, codex),
      timeoutMs: ASK_TIMEOUT,
    },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()).data;
}

/**
 * Resume an existing session, wait until `history_turn_committed` pauses at
 * the named commit boundary, SIGKILL the exact paused pid, and return. Usage
 * and recovery checkpoints do not honor the boundary pause, so the ready
 * file appears after the second model POST.
 */
async function killResumeCommitAtBoundary(
  roots: Roots,
  codex: ReturnType<typeof startFakeCodex>,
  id: string,
  boundary: CommitBoundary,
): Promise<void> {
  const readyPath = join(roots.root, `boundary-model-${boundary}.ready`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: "1",
    ...fakeCodexEnv(roots.home, codex, {
      FIBER_E2E_SESSION_BOUNDARY: boundary,
      FIBER_E2E_SESSION_BOUNDARY_READY: readyPath,
    }),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(
    FIBER_BIN,
    ["ask", "--json", "--permission-mode", "auto", "--resume-id", id, VICTIM_PROMPT],
    { cwd: roots.workspace, env, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + BOUNDARY_WAIT_MS;
    while (!existsSync(readyPath)) {
      if (Date.now() > deadline) {
        throw new Error(`model commit boundary ${boundary} never paused`);
      }
      await Bun.sleep(100);
    }
    expect(readFileSync(readyPath, "utf8")).toBe(boundary);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited; the close wait below still reaps it.
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  expect(codex.requests).toHaveLength(2);
  expect(existsSync(sessionDir(roots.home, id))).toBe(true);
}

async function showSessionJson(
  workspace: string,
  home: string,
  id: string,
): Promise<{ history_len: number; history: Array<{ user?: { text?: string } }> }> {
  const result = await runFx(["session", "show", "--id", id, "--json"], {
    cwd: workspace,
    env: { HOME: home },
    timeoutMs: CLI_TIMEOUT,
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()).data;
}

async function listSessionsJson(
  workspace: string,
  home: string,
): Promise<{ count: number; sessions: unknown[]; skipped_invalid?: number }> {
  const result = await runFx(["sessions", "--json"], {
    cwd: workspace,
    env: { HOME: home },
    timeoutMs: CLI_TIMEOUT,
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()).data;
}

async function doctorLines(workspace: string, home: string): Promise<string[]> {
  const result = await runFx(["doctor"], {
    cwd: workspace,
    env: { HOME: home },
    timeoutMs: CLI_TIMEOUT,
  });
  expect(result.code).toBe(0);
  return result.stdout.split("\n");
}

describe("session-recovery", () => {
  test(
    "case 7: doctor removes only a validated noncurrent watermark",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case7-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await askSaved(
          roots.workspace,
          roots.home,
          codex,
          "Plant a watermark beside me.",
        );
        const dir = sessionDir(roots.home, id);
        const current = watermarkName(roots.home, id);
        const forged = "commit.ffffffffffffffffffffffffffffffff.json";
        const watermark = JSON.parse(
          readFileSync(join(dir, current), "utf8"),
        ) as Record<string, unknown>;
        watermark.log_generation = "f".repeat(32);
        writeFileSync(join(dir, forged), JSON.stringify(watermark), {
          mode: 0o600,
        });
        chmodSync(join(dir, forged), 0o600);

        const doctor = await runFx(["doctor"], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(doctor.stdout.split("\n")).toContainEqual(
          `[ok] session: session ${id}: cleanup_candidate cleanup_removed=1 report_only=0 ignored=1`,
        );
        expect(existsSync(join(dir, forged))).toBe(false);
        expect(existsSync(join(dir, current))).toBe(true);
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    ASK_TIMEOUT,
  );

  test(
    "case 8: session recover copies without mutating the source",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case8-");
      const codex = startFakeCodex({
        route: () => codexFinalText("RESUMED_OK"),
      });
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await askSaved(
          roots.workspace,
          roots.home,
          codex,
          "Corrupt my watermark next.",
        );
        const watermarkPath = join(
          sessionDir(roots.home, id),
          watermarkName(roots.home, id),
        );
        writeFileSync(watermarkPath, "CORRUPT{{{\n");
        const corrupted = readFileSync(watermarkPath, "utf8");

        const corruptText = `fiber session: session ${id} is corrupt; run \`fiber session recover ${id}\``;
        const corruptJsonError = `session ${id} is corrupt; run \`fiber session recover ${id}\``;
        const showCorrupt = await runFx(["session", "show", "--id", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(showCorrupt.code).toBe(1);
        expect(showCorrupt.stdout).toBe("");
        expect(showCorrupt.stderr.trim()).toBe(corruptText);

        const recover = await runFx(["session", "recover", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(recover.code).toBe(0);
        expect(recover.stderr).toBe("");
        const copyMatch = /copied \S+ to (\S+)/.exec(recover.stdout);
        expect(copyMatch).not.toBeNull();
        const copy = copyMatch![1]!;
        expect(recover.stdout).toBe(
          `[session recovery] copied ${id} to ${copy}\nhistory_turns: 1\nresume: fiber resume ${copy}\n`,
        );

        expect(readFileSync(watermarkPath, "utf8")).toBe(corrupted);
        const stillCorrupt = await runFx(
          ["session", "show", "--id", id, "--json"],
          {
            cwd: roots.workspace,
            env: { HOME: roots.home },
            timeoutMs: CLI_TIMEOUT,
          },
        );
        expect(stillCorrupt.code).toBe(1);
        expect(stillCorrupt.stderr).toBe("");
        expect(JSON.parse(stillCorrupt.stdout.trim())).toEqual({
          ok: false,
          kind: "session.show",
          error: corruptJsonError,
          code: "InvalidSessionFormat",
        });

        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            copy,
            "Continue on the copy.",
          ],
          {
            cwd: roots.workspace,
            env: fakeCodexEnv(roots.home, codex),
            timeoutMs: ASK_TIMEOUT,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        const resumedJson = JSON.parse(resumed.stdout.trim());
        expect(resumedJson.data.session_id).toBe(copy);
        expect(resumedJson.data.output).toBe("RESUMED_OK");
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    ASK_TIMEOUT,
  );

  test(
    "case 9: cross-workspace recovery preserves both resume-last pointers",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-e2e-session-case9-"));
      const home = join(root, "home");
      const rawA = join(root, "workspace-a");
      const rawB = join(root, "workspace-b");
      mkdirSync(home, { recursive: true });
      mkdirSync(rawA, { recursive: true });
      mkdirSync(rawB, { recursive: true });
      const workspaceA = realpathSync(rawA);
      const workspaceB = realpathSync(rawB);
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(home, chatGptAccessToken());
        const env = fakeCodexEnv(home, codex);
        const askIn = async (cwd: string, prompt: string) => {
          const result = await runFx(
            ["ask", "--json", "--permission-mode", "auto", prompt],
            { cwd, env, timeoutMs: ASK_TIMEOUT },
          );
          expect(result.code).toBe(0);
          return JSON.parse(result.stdout.trim()).data.session_id as string;
        };
        await askIn(workspaceA, "First in A.");
        const corruptId = await askIn(workspaceA, "Second in A.");
        const healthyB = await askIn(workspaceB, "Only in B.");

        const corruptDir = sessionDir(home, corruptId);
        const watermarkPath = join(
          corruptDir,
          watermarkName(home, corruptId),
        );
        writeFileSync(watermarkPath, "CORRUPT\n");

        const recover = await runFx(["session", "recover", corruptId], {
          cwd: workspaceB,
          env: { HOME: home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(recover.code).toBe(0);
        const copy = (/copied \S+ to (\S+)/.exec(recover.stdout) ?? [])[1];
        expect(typeof copy).toBe("string");

        // Recovery preserves the source timestamps, so the copy and the
        // corrupt source tie on updated_at_ms. One resolving turn on the copy
        // (the case 8 step) disambiguates `show last` deterministically.
        const resolve = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            copy as string,
            "Continue on the copy.",
          ],
          { cwd: workspaceA, env, timeoutMs: ASK_TIMEOUT },
        );
        expect(resolve.code).toBe(0);
        expect(JSON.parse(resolve.stdout.trim()).data.session_id).toBe(copy);

        expect(await showLastId(workspaceA, home)).toBe(copy);
        expect(await showLastId(workspaceB, home)).toBe(healthyB);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    ASK_TIMEOUT,
  );

  // Cases 1-3: uncommitted create orphan at after_event_append,
  // after_event_sync, after_watermark_rename (create path). The killed writer
  // never publishes, so `sessions --json` count is 0 and doctor reports
  // `authority_less_creation_orphan` for the orphaned directory.
  test(
    "case 1: create orphan at after_event_append",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case1-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(roots, codex, "after_event_append");
        expect(existsSync(sessionDir(roots.home, id))).toBe(true);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);

        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          orphanDoctorLine(id),
        );
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  test(
    "case 2: create orphan at after_event_sync",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case2-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(roots, codex, "after_event_sync");
        expect(existsSync(sessionDir(roots.home, id))).toBe(true);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);

        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          orphanDoctorLine(id),
        );
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  test(
    "case 3: create orphan at after_watermark_rename",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case3-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(roots, codex, "after_watermark_rename");
        expect(existsSync(sessionDir(roots.home, id))).toBe(true);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);

        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          orphanDoctorLine(id),
        );
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  // Cases 4-6: proposed authority on create at after_authority_marker_rename,
  // after_authority_namespace_sync, after_authority_intent_remove. The
  // directory exists but list still hides it; a writable load (`ask
  // --resume-id`) confirms the proposed authority, drops any pending intent,
  // and `session show --id` then succeeds with the resolving turn committed.
  test(
    "case 4: proposed authority at after_authority_marker_rename",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case4-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(
          roots,
          codex,
          "after_authority_marker_rename",
        );
        const dir = sessionDir(roots.home, id);
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(true);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);
        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          pendingDoctorLine(id),
        );

        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            id,
            "Confirm the proposed authority.",
          ],
          {
            cwd: roots.workspace,
            env: fakeCodexEnv(roots.home, codex),
            timeoutMs: ASK_TIMEOUT,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout.trim()).data.session_id).toBe(id);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(false);

        const show = await runFx(["session", "show", "--id", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(show.code).toBe(0);
        expect(show.stderr).toBe("");
        expect(show.stdout.split("\n")[0]).toBe(`[session] ${id}`);
        expect(show.stdout.split("\n")).toContainEqual("history_len: 1");
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  test(
    "case 5: proposed authority at after_authority_namespace_sync",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case5-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(
          roots,
          codex,
          "after_authority_namespace_sync",
        );
        const dir = sessionDir(roots.home, id);
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(true);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);
        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          pendingDoctorLine(id),
        );

        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            id,
            "Confirm the proposed authority.",
          ],
          {
            cwd: roots.workspace,
            env: fakeCodexEnv(roots.home, codex),
            timeoutMs: ASK_TIMEOUT,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout.trim()).data.session_id).toBe(id);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(false);

        const show = await runFx(["session", "show", "--id", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(show.code).toBe(0);
        expect(show.stderr).toBe("");
        expect(show.stdout.split("\n")[0]).toBe(`[session] ${id}`);
        expect(show.stdout.split("\n")).toContainEqual("history_len: 1");
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  test(
    "case 6: proposed authority at after_authority_intent_remove",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case6-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(
          roots,
          codex,
          "after_authority_intent_remove",
        );
        const dir = sessionDir(roots.home, id);
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(false);

        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);
        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          projectionMissingDoctorLine(id),
        );

        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            id,
            "Confirm the proposed authority.",
          ],
          {
            cwd: roots.workspace,
            env: fakeCodexEnv(roots.home, codex),
            timeoutMs: ASK_TIMEOUT,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout.trim()).data.session_id).toBe(id);
        expect(existsSync(join(dir, "authority.json"))).toBe(true);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(false);

        const show = await runFx(["session", "show", "--id", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(show.code).toBe(0);
        expect(show.stderr).toBe("");
        expect(show.stdout.split("\n")[0]).toBe(`[session] ${id}`);
        expect(show.stdout.split("\n")).toContainEqual("history_len: 1");
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  // Case 10: fenced create orphan at after_authority_intent_sync. Doctor first
  // reports `authority_transition_pending report_only=true` and list reports
  // `skipped_invalid: 1`; a writable load fails `SessionNotFound` and drops
  // `authority.pending.json`; doctor then reports
  // `authority_less_creation_orphan` and `session show --id` reports
  // "record not found".
  test(
    "case 10: fenced create orphan at after_authority_intent_sync",
    async () => {
      const roots = makeRoots("fiber-e2e-session-case10-");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(roots.home, chatGptAccessToken());
        const id = await killCreateAtBoundary(
          roots,
          codex,
          "after_authority_intent_sync",
        );
        const dir = sessionDir(roots.home, id);
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(true);

        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          pendingDoctorLine(id),
        );
        const list = await listSessionsJson(roots.workspace, roots.home);
        expect(list.count).toBe(0);
        expect(list.sessions).toEqual([]);
        expect(list.skipped_invalid).toBe(1);

        const denied = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode",
            "auto",
            "--resume-id",
            id,
            "Try the fenced orphan.",
          ],
          {
            cwd: roots.workspace,
            env: fakeCodexEnv(roots.home, codex),
            timeoutMs: ASK_TIMEOUT,
          },
        );
        expect(denied.code).toBe(1);
        expect(denied.stderr).toBe("");
        expect(denied.stdout.trim()).toBe(
          '{"ok":false,"kind":"ask","error":"SessionNotFound","code":"SessionNotFound"}',
        );
        expect(existsSync(join(dir, "authority.pending.json"))).toBe(false);

        expect(await doctorLines(roots.workspace, roots.home)).toContainEqual(
          orphanDoctorLine(id),
        );
        const show = await runFx(["session", "show", "--id", id], {
          cwd: roots.workspace,
          env: { HOME: roots.home },
          timeoutMs: CLI_TIMEOUT,
        });
        expect(show.code).toBe(1);
        expect(show.stdout).toBe("");
        expect(show.stderr.trim()).toBe("fiber session: record not found");
      } finally {
        codex.stop();
        cleanupRoots(roots);
      }
    },
    CASE_TIMEOUT,
  );

  // Cases 11-16: kill `history_turn_committed` at each of the six commit
  // boundaries. A second writable load always clears commit.pending.json;
  // the victim turn survives only after watermark publish (the last three).
  for (const [index, boundary] of COMMIT_BOUNDARIES.entries()) {
    test(
      `case ${11 + index}: history_turn_committed recovers after process death at ${boundary}`,
      async () => {
        const roots = makeRoots(`fiber-e2e-session-model-${boundary}-`);
        const codex = startFakeCodex();
        try {
          writeSeededChatGptLogin(roots.home, chatGptAccessToken());
          const id = await askSaved(
            roots.workspace,
            roots.home,
            codex,
            "Plant the model commit victim turn.",
          );
          await killResumeCommitAtBoundary(roots, codex, id, boundary);

          const intentPath = join(sessionDir(roots.home, id), "commit.pending.json");
          if (PENDING_AFTER_KILL.includes(boundary)) {
            expect(existsSync(intentPath)).toBe(true);
          }

          const list = await listSessionsJson(roots.workspace, roots.home);
          expect(list.count).toBe(1);
          expect(list.skipped_invalid ?? 0).toBe(0);

          const resumed = await askResume(
            roots.workspace,
            roots.home,
            codex,
            id,
            RESOLVE_PROMPT,
          );
          expect(resumed.session_id).toBe(id);
          expect(existsSync(intentPath)).toBe(false);

          const detail = await showSessionJson(roots.workspace, roots.home, id);
          const userTexts = detail.history.map((turn) => turn.user?.text);
          const survives = TURN_SURVIVES.includes(boundary);
          expect(detail.history_len).toBe(survives ? 3 : 2);
          if (survives) {
            expect(userTexts).toContain(VICTIM_PROMPT);
          } else {
            expect(userTexts).not.toContain(VICTIM_PROMPT);
          }
        } finally {
          codex.stop();
          cleanupRoots(roots);
        }
      },
      CASE_TIMEOUT,
    );
  }
});
