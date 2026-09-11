import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN } from "../evals/eval-helpers";
import {
  FAKE_CODEX_DEFAULT_MODEL,
  seededFakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const RESPONSE_TEXT = "COST_ACCOUNTING_COMPLETE";
const FOLLOW_UP_TEXT = "RESUMED_FOLLOW_UP_COMPLETE";

// Real token counts from the Codex subscription billing path
// (responses_protocol.zig buildSubscriptionBilling): total_cost is hard-zero
// and money math is deferred, so every assertion here is tokens only.
const USAGE_DETAILS = {
  input_tokens: 130,
  output_tokens: 25,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  output_tokens_details: { reasoning_tokens: 5 },
};

// The response.completed `id` gives the turn an exact billing identity; a
// completed response without an id leaves billing incomplete instead.
function codexCompletionWithIdentity(text: string, responseId: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: responseId, status: "completed", usage: USAGE_DETAILS },
    })}\n\n`;
}

let session: TmuxSession | null = null;
let codex: ReturnType<typeof startFakeCodex> | null = null;
let root: string | null = null;

afterEach(async () => {
  if (session) {
    await session.kill();
    session = null;
  }
  codex?.stop();
  codex = null;
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function codexEnvironment(home: string) {
  if (!codex) throw new Error("fake codex not started");
  return seededFakeCodexEnv(home, codex, {
    FIBER_PERMISSION_MODE: "auto",
  });
}

function eventLogs(directory: string): string[] {
  const logs: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) logs.push(...eventLogs(path));
    if (entry.isFile() && entry.name === "events.jsonl") logs.push(path);
  }
  return logs;
}

type UsageCheckpoint = {
  billing: string;
  pending: Array<{ id: string }>;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
  models: Array<{ model: string }>;
};

type SessionEvent = {
  kind: string;
  payload?: { usage?: UsageCheckpoint };
};

function eventRecords(events: string): SessionEvent[] {
  return events
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

function latestUsageCheckpoint(events: string): UsageCheckpoint {
  const records = eventRecords(events);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind === "usage_checkpointed" && record.payload?.usage) {
      return record.payload.usage;
    }
  }
  throw new Error("missing usage checkpoint");
}

// The generation fact id is minted by fiber, so wait for the record kind and
// return the published fact for token assertions.
async function waitForUsageGeneration(home: string): Promise<{
  input_tokens: number;
  output_tokens: number;
}> {
  const usagePath = join(home, ".fiber", "usage.jsonl");
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(usagePath, "utf8").trim().split("\n");
      for (const line of lines) {
        const record = JSON.parse(line) as {
          kind?: string;
          fact?: { input_tokens: number; output_tokens: number };
        };
        if (record.kind === "generation" && record.fact) return record.fact;
      }
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for profile usage publication");
}

function writePendingUsageStore(home: string): void {
  const fxDir = join(home, ".fiber");
  mkdirSync(fxDir, { recursive: true, mode: 0o700 });
  // Backdated: fiber treats a marker at or after its own snapshot time as
  // unknown (incomplete), and a runner clock can step between this write and
  // the spawned report.
  const observedAtMs = Date.now() - 60_000;
  writeFileSync(
    join(fxDir, "usage.jsonl"),
    [
      JSON.stringify({
        schema_version: 1,
        kind: "coverage",
        started_at_ms: observedAtMs,
      }),
      JSON.stringify({
        schema_version: 1,
        kind: "pending",
        id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        observed_at_ms: observedAtMs,
      }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(fxDir, "usage.lock"), "", { mode: 0o600 });
}

test(
  "fiber ask settles subscription usage durably without a reconciliation endpoint",
  async () => {
    root = mkdtempSync(join(tmpdir(), "fiber-cost-ask-exit-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    codex = startFakeCodex({
      route: () => codexCompletionWithIdentity(RESPONSE_TEXT, "resp_e2e_settle"),
    });

    const proc = Bun.spawn([FIBER_BIN, "ask", "Reply with the sentinel."], {
      cwd: workspace,
      env: { ...process.env, ...codexEnvironment(home) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    if (exitCode === null) {
      proc.kill();
      await proc.exited;
    }

    expect(exitCode).toBe(0);
    expect(codex.requests).toHaveLength(1);
    const fact = await waitForUsageGeneration(home);
    expect(fact.input_tokens).toBe(130);
    expect(fact.output_tokens).toBe(25);
    const events = eventLogs(home)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const checkpoint = events.indexOf('"kind":"usage_checkpointed"');
    const history = events.indexOf('"kind":"history_turn_committed"');
    expect(checkpoint).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeLessThan(history);
    const usage = latestUsageCheckpoint(events);
    expect(usage.billing).toBe("complete");
    expect(usage.pending).toEqual([]);
    expect(usage.input_tokens).toBe(130);
    expect(usage.output_tokens).toBe(25);
    expect(usage.models.map((item) => item.model)).toContain(
      `codex/${FAKE_CODEX_DEFAULT_MODEL}`,
    );
  },
  10_000,
);

test("fiber usage reports unresolved pending billing as pending", async () => {
  root = mkdtempSync(join(tmpdir(), "fiber-cost-pending-profile-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writePendingUsageStore(home);

  const usage = Bun.spawn(
    [FIBER_BIN, "usage", "--period", "24h", "--json"],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const usageStdout = await new Response(usage.stdout).text();
  const usageStderr = await new Response(usage.stderr).text();
  expect(await usage.exited, usageStderr).toBe(0);
  const report = (JSON.parse(usageStdout.trim()) as { data: unknown }).data as {
    completeness: string;
    totals: { request_count: number };
  };
  expect(report.completeness).toBe("pending");
  expect(report.totals.request_count).toBe(0);
});

test("fiber usage reports a missing generation identity as incomplete", async () => {
  root = mkdtempSync(join(tmpdir(), "fiber-cost-incomplete-profile-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // Default route: response.completed carries usage but no response id, so
  // the turn cannot settle an exact billing identity.
  codex = startFakeCodex();

  const ask = Bun.spawn([FIBER_BIN, "ask", "Reply with the sentinel."], {
    cwd: workspace,
    env: { ...process.env, ...codexEnvironment(home) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const askStderr = await new Response(ask.stderr).text();
  expect(await ask.exited, askStderr).toBe(0);
  expect(codex.requests).toHaveLength(1);

  const usage = Bun.spawn(
    [FIBER_BIN, "usage", "--period", "24h", "--json"],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const usageStdout = await new Response(usage.stdout).text();
  const usageStderr = await new Response(usage.stderr).text();
  expect(await usage.exited, usageStderr).toBe(0);
  const report = (JSON.parse(usageStdout.trim()) as { data: unknown }).data as {
    completeness: string;
    totals: { request_count: number };
  };
  expect(report.completeness).toBe("incomplete");
  expect(report.totals.request_count).toBe(0);
});

describe.skipIf(!tmuxAvailable())("tui: durable session usage", () => {
  for (const resumeMode of ["startup", "picker"] as const) {
    test(
      `usage totals survive ${resumeMode} resume`,
      async () => {
        root = mkdtempSync(join(tmpdir(), `fiber-cost-${resumeMode}-resume-`));
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        let turn = 0;
        codex = startFakeCodex({
          route: () => {
            turn += 1;
            return codexCompletionWithIdentity(
              turn === 1 ? RESPONSE_TEXT : FOLLOW_UP_TEXT,
              `resp_e2e_resume_${turn}`,
            );
          },
        });

        const fixture = Bun.spawn(
          [FIBER_BIN, "ask", "Create usage for resume."],
          {
            cwd: workspace,
            env: { ...process.env, ...codexEnvironment(home) },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(await fixture.exited).toBe(0);

        const fixtureLogs = eventLogs(home);
        expect(fixtureLogs).toHaveLength(1);
        const resumedEventsPath = fixtureLogs[0]!;
        const beforeResume = latestUsageCheckpoint(
          readFileSync(resumedEventsPath, "utf8"),
        );
        expect(beforeResume.billing).toBe("complete");
        expect(beforeResume.pending).toEqual([]);

        session = await TmuxSession.create({
          cmd: resumeMode === "startup" ? `${FIBER_BIN} continue` : FIBER_BIN,
          cwd: workspace,
          env: codexEnvironment(home),
          stderrPath,
        });
        await session.waitForComposer(TIMEOUT);
        if (resumeMode === "picker") {
          await session.sendText("/resume");
          await session.waitForPane(
            (pane) => pane.includes("Sessions") && /\bturns?\b/.test(pane),
            TIMEOUT,
          );
          await session.sendKeys("Enter");
          await session.waitForText("● Session resumed:", TIMEOUT);
        }

        await session.sendText("Confirm resumed input still works.");
        await session.waitForText(FOLLOW_UP_TEXT, TIMEOUT);
        await session.waitForComposer(TIMEOUT);

        await session.sendText("/usage");
        const usage = await session.waitForText(/310 tokens/, TIMEOUT);
        expect(usage).toMatch(/260 input/);
        expect(usage).toMatch(/50 output/);
        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/quit");
        expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
        const resumedEvents = readFileSync(resumedEventsPath, "utf8");
        const afterResume = latestUsageCheckpoint(resumedEvents);
        expect(afterResume.pending).toEqual([]);
        expect(afterResume.models.map((item) => item.model)).toContain(
          `codex/${FAKE_CODEX_DEFAULT_MODEL}`,
        );
        expect(
          eventRecords(resumedEvents)
            .filter((record) => record.kind === "history_turn_committed"),
        ).toHaveLength(2);
      },
      TIMEOUT * 2,
    );
  }

  test(
    "usage dashboard totals survive process resume",
    async () => {
      root = mkdtempSync(join(tmpdir(), "fiber-cost-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      let turn = 0;
      codex = startFakeCodex({
        route: () => {
          turn += 1;
          return codexCompletionWithIdentity(
            RESPONSE_TEXT,
            `resp_e2e_totals_${turn}`,
          );
        },
      });

      session = await TmuxSession.create({
        cwd: workspace,
        env: codexEnvironment(home),
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("Reply with the cost accounting sentinel.");
      await session.waitForText(RESPONSE_TEXT, TIMEOUT);
      await session.waitForComposer(TIMEOUT);
      await session.sendText("/usage");
      const firstUsage = await session.waitForText(/155 tokens/, TIMEOUT);
      expect(firstUsage).toMatch(/130 input/);
      expect(firstUsage).toMatch(/25 output/);
      expect(firstUsage).toMatch(/20 cache read/);
      expect(firstUsage).toMatch(/10 cache write/);
      await session.sendKeys("Left");
      await session.waitForText("[7 days]", TIMEOUT);
      await session.sendKeys("Left");
      await session.waitForText("[24 hours]", TIMEOUT);
      await session.sendKeys("Left");
      const firstSession = await session.waitForText("[Session]", TIMEOUT);
      expect(firstSession).toMatch(/5 reasoning/);
      expect(firstSession).toMatch(/1 request/);
      await session.sendKeys("Escape");
      await session.waitForComposer(TIMEOUT);
      await session.sendText("/quit");
      await session.waitForSessionEnd(TIMEOUT);
      session = null;

      session = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: workspace,
        env: codexEnvironment(home),
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("/usage");
      const resumedUsage = await session.waitForText(/155 tokens/, TIMEOUT);
      expect(resumedUsage).toMatch(/130 input/);
      expect(resumedUsage).toMatch(/25 output/);
      expect(resumedUsage).toMatch(/20 cache read/);
      expect(resumedUsage).toMatch(/10 cache write/);
      await session.sendKeys("Left");
      await session.waitForText("[7 days]", TIMEOUT);
      await session.sendKeys("Left");
      await session.waitForText("[24 hours]", TIMEOUT);
      await session.sendKeys("Left");
      const resumedSession = await session.waitForText(
        "[Session]",
        TIMEOUT,
      );
      expect(resumedSession).toMatch(/5 reasoning/);
      expect(resumedSession).toMatch(/1 request/);
    },
    TIMEOUT * 3,
  );
});
