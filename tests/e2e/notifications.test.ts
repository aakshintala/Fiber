import { expect, test } from "bun:test";
import {
  chmodSync,
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
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const COMMAND_APPROVAL_PROMPT = "Would you like to run the following command?";

function createNotificationRoot(
  notifications = { turn_end: true, attention_required: true },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-notifications-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const profile = join(home, ".fiber");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  mkdirSync(workspace, { recursive: true });
  chmodSync(profile, 0o700);
  const settingsPath = join(profile, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      permission_mode: "ask",
      notifications,
    }),
    { mode: 0o600 },
  );
  chmodSync(settingsPath, 0o600);
  return { root, home, workspace: realpathSync(workspace) };
}

function notificationEnv(
  home: string,
  codex: ReturnType<typeof startFakeCodex>,
  tracePath: string,
) {
  return fakeCodexEnv(home, codex, {
    FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
    // Sound behavior under test: skip the harness-wide FIBER_SOUND=0 default so
    // the fixture settings and platform default stay authoritative.
    FIBER_SOUND: undefined,
    FIBER_TRACE_LOG: tracePath,
    FIBER_TRACE_SCOPES: "hooks,notifications",
    NO_COLOR: "1",
  });
}

async function waitForTrace(
  path: string,
  predicate: (trace: string) => boolean,
  timeoutMs = TIMEOUT,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const trace = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (predicate(trace)) return trace;
    await Bun.sleep(50);
  }
  const trace = existsSync(path) ? readFileSync(path, "utf8") : "";
  throw new Error(`Timed out waiting for notification trace.\n${trace}`);
}

function bellCount(path: string) {
  if (!existsSync(path)) return 0;
  return [...readFileSync(path)].filter((byte) => byte === 0x07).length;
}

async function waitForBellCount(path: string, expected: number) {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT) {
    if (bellCount(path) === expected) return;
    await Bun.sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${expected} terminal bell(s); received ${bellCount(path)}.`,
  );
}

function handlerStartCount(trace: string, lifecycleEvent: string) {
  return trace
    .split("\n")
    .filter((line) =>
      line.includes("[hooks] event=handler_start") &&
      line.includes(`lifecycle_event=${lifecycleEvent}`)
    )
    .length;
}

function handlerTurnId(trace: string, lifecycleEvent: string) {
  const line = trace
    .split("\n")
    .find((candidate) =>
      candidate.includes("[hooks] event=handler_start") &&
      candidate.includes(`lifecycle_event=${lifecycleEvent}`)
    );
  const match = line?.match(/\bturn_id=(\d+)\b/);
  if (!match) throw new Error(`Missing ${lifecycleEvent} turn ID.\n${trace}`);
  return Number(match[1]);
}

test.skipIf(!tmuxAvailable())(
  "notifications sound handler runs after a real interactive turn",
  async () => {
    const fixture = createNotificationRoot();
    const codex = startFakeCodex({
      route: () => codexFinalText("NOTIFICATION_TURN_COMPLETE"),
    });
    const tracePath = join(fixture.root, "trace.log");
    const stderrPath = join(fixture.root, "stderr.log");
    writeFileSync(stderrPath, "");
    let session: TmuxSession | null = null;
    try {
      session = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: fixture.workspace,
        env: notificationEnv(fixture.home, codex, tracePath),
        stderrPath,
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("Finish this notification fixture.");
      await session.waitForText("NOTIFICATION_TURN_COMPLETE", TIMEOUT);
      const trace = await waitForTrace(
        tracePath,
        (value) => handlerStartCount(value, "PostTurnEnd") === 1,
      );

      expect(handlerStartCount(trace, "PostTurnEnd")).toBe(1);
      expect(trace).toContain("handler=fiber.sound.turn_end");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      if (session) await session.kill();
      codex.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "fiber ask keeps redirected stdout JSON and stderr byte-clean with notifications enabled",
  async () => {
    const fixture = createNotificationRoot();
    const codex = startFakeCodex({
      route: () => codexFinalText("NOTIFICATION_ASK_COMPLETE"),
    });
    const tracePath = join(fixture.root, "trace.log");
    try {
      const result = await runFx(
        ["ask", "--json", "--no-save", "Finish the ask notification fixture."],
        {
          cwd: fixture.workspace,
          env: notificationEnv(fixture.home, codex, tracePath),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.output.trim()).toBe("NOTIFICATION_ASK_COMPLETE");
      expect(result.stderr).toBe("");
      const trace = await waitForTrace(
        tracePath,
        (value) => handlerStartCount(value, "PostTurnEnd") === 1,
      );
      expect(trace).toContain("scope=ask");
    } finally {
      codex.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "fiber ask correlates permission attention and turn-end notifications",
  async () => {
    const fixture = createNotificationRoot();
    const marker = join(fixture.workspace, "ask-permission-marker.txt");
    const codex = startFakeCodex({
      route: (body) => {
        const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
        if (items.some((item) => item.type === "function_call_output")) {
          return codexFinalText("NOTIFICATION_ASK_PERMISSION_COMPLETE");
        }
        return codexToolCall("ask_permission_1", "shell", {
          action: "run",
          command: "touch ask-permission-marker.txt",
          yield_time_ms: 30_000,
          timeout_ms: 600_000,
        });
      },
    });
    const tracePath = join(fixture.root, "trace.log");
    let session: TmuxSession | null = null;
    try {
      session = await TmuxSession.create({
        cmd: `${FIBER_BIN} ask --no-save "Try the prepared command."`,
        cwd: fixture.workspace,
        env: notificationEnv(fixture.home, codex, tracePath),
        remainOnExit: true,
      });
      await session.waitForText("Approve? [y/N]", TIMEOUT);
      expect(existsSync(marker)).toBe(false);
      await session.sendText("n");
      await session.waitForText("NOTIFICATION_ASK_PERMISSION_COMPLETE", TIMEOUT);

      const trace = await waitForTrace(
        tracePath,
        (value) =>
          handlerStartCount(value, "AttentionRequired") === 1 &&
          handlerStartCount(value, "PostTurnEnd") === 1,
      );
      const attentionTurnId = handlerTurnId(trace, "AttentionRequired");
      expect(attentionTurnId).toBeGreaterThan(0);
      expect(handlerTurnId(trace, "PostTurnEnd")).toBe(attentionTurnId);
      expect(trace).toContain("sound play kind=attention_required");
      expect(trace).toContain("sound play kind=turn_end");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (session) await session.kill();
      codex.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "notifications sound handler runs once when a real permission blocks",
  async () => {
    // Keep direct interaction sounds off so the raw pane capture isolates the
    // attention-required transition.
    const fixture = createNotificationRoot({
      turn_end: false,
      attention_required: true,
    });
    const marker = join(fixture.workspace, "permission-marker.txt");
    const codex = startFakeCodex({
      route: (body) => {
        const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
        if (items.some((item) => item.type === "function_call_output")) {
          return codexFinalText("NOTIFICATION_PERMISSION_COMPLETE");
        }
        return codexToolCall("permission_1", "shell", {
          action: "run",
          command: "touch permission-marker.txt",
          yield_time_ms: 30_000,
          timeout_ms: 600_000,
        });
      },
    });
    const tracePath = join(fixture.root, "trace.log");
    const stderrPath = join(fixture.root, "stderr.log");
    const paneOutputPath = join(fixture.root, "pane-output.bin");
    writeFileSync(stderrPath, "");
    writeFileSync(paneOutputPath, "");
    let session: TmuxSession | null = null;
    try {
      session = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: fixture.workspace,
        env: notificationEnv(fixture.home, codex, tracePath),
        stderrPath,
      });
      await session.waitForComposer(TIMEOUT);
      session.startPaneOutputCapture(paneOutputPath);
      await session.sendText("Try the prepared command.");
      await session.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      const waitingTrace = await waitForTrace(
        tracePath,
        (value) => handlerStartCount(value, "AttentionRequired") === 1,
      );

      expect(handlerStartCount(waitingTrace, "AttentionRequired")).toBe(1);
      expect(waitingTrace).toContain("handler=fiber.sound.attention_required");
      expect(existsSync(marker)).toBe(false);
      await waitForBellCount(paneOutputPath, 1);
      await Bun.sleep(250);
      expect(bellCount(paneOutputPath)).toBe(1);

      await session.sendKeys("3");
      await session.waitForText("NOTIFICATION_PERMISSION_COMPLETE", TIMEOUT);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      if (session) await session.kill();
      codex.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
