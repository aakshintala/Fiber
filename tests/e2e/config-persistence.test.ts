import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  composerContains,
  codexFinalText,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  hasEmptyComposer,
  seededFakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 20_000;
const NO_AUTH = {
  AI_GATEWAY_API_KEY: "",
  VERCEL_OIDC_TOKEN: "",
  FIBER_MODEL: undefined,
  NO_COLOR: "1",
};
const CODEX_MODEL = "gpt-5.4";
const CODEX_PICKER_MODEL = "gpt-5.6-sol";

const serialTest = test.serial;
async function waitForStatuslineSetting(
  settingsPath: string,
  key: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  let actual: unknown;
  while (Date.now() < deadline) {
    if (existsSync(settingsPath)) {
      actual = JSON.parse(readFileSync(settingsPath, "utf8")).statusLine?.[key];
      if (actual === expected) return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Timed out waiting for statusLine.${key}=${expected}; last=${JSON.stringify(actual)}`,
  );
}

async function disablePromptHistory(
  session: TmuxSession,
  settingsPath: string,
): Promise<void> {
  await session.sendText("/settings");
  await session.waitForText("←→ Change", TIMEOUT);
  await session.sendLiteral("prompt history");
  await session.waitForPane(
    (pane) => pane.includes("Prompt history") && !pane.includes("Startup scrollback"),
    TIMEOUT,
  );
  await session.sendKeys("Left");
  const deadline = Date.now() + TIMEOUT;
  let enabled: unknown;
  while (Date.now() < deadline) {
    if (existsSync(settingsPath)) {
      enabled = JSON.parse(readFileSync(settingsPath, "utf8")).prompt_history?.enabled;
      if (enabled === false) break;
    }
    await Bun.sleep(25);
  }
  if (enabled !== false) throw new Error("Timed out disabling prompt history");
  await session.sendKeys("Escape");
  await session.waitForPane(
    (pane) => hasEmptyComposer(pane) && !pane.includes("←→ Change"),
    TIMEOUT,
  );
}

// NO_AUTH clears FIBER_MODEL, so these fixtures start from a profile with a
// credential and no model chosen. That is the first-run shape, and fiber opens
// the model picker there rather than leaving the user to discover /model, which
// seeds "/model " into the composer. So a test types the filter alone instead of
// the whole command.
async function filterStartupModelPicker(
  session: TmuxSession,
  filter: string,
): Promise<void> {
  await session.waitForPane((pane) => pane.includes("/model"), TIMEOUT);
  await session.sendLiteral(filter);
}

function tree(root: string, relative = ""): string[] {
  const path = relative ? join(root, relative) : root;
  const entries = readdirSync(path, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = relative ? join(relative, entry.name) : entry.name;
    result.push(child);
    if (entry.isDirectory()) result.push(...tree(root, child));
  }
  return result.sort();
}

function migrationSnapshotPath(home: string, field: string): string {
  const backups = join(home, ".fiber", "backups");
  const name = `settings.json.preference-migration.${field}.json`;
  expect(readdirSync(backups)).toContain(name);
  return join(backups, name);
}

describe.skipIf(!tmuxAvailable())("config persistence", () => {
  let session: TmuxSession | null = null;
  let secondSession: TmuxSession | null = null;

  afterEach(async () => {
    await session?.kill();
    await secondSession?.kill();
    session = null;
    secondSession = null;
  });

  serialTest(
    "user preferences migrate globally and load in another project",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-config-persistence-"));
      const codex = startFakeCodex();
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);
        const projectABytes = "{\"project_future\":{\"name\":\"a\"}}\n";
        const projectBBytes = "{\"project_future\":{\"name\":\"b\"}}\n";
        writeFileSync(join(workspaceA, ".fiber.json"), projectABytes);
        writeFileSync(join(workspaceB, ".fiber.json"), projectBBytes);
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            future_global: { nested: "preserve-me" },
            workspaces: {
              [workspaceARoot]: {
                model: "legacy/project-a",
                permission_mode: "ask",
                effort: "low",
                fast_mode: false,
                startup_scrollback: true,
                prompt_history: { enabled: true, future: "keep-a-history" },
                statusLine: {
                  sandbox: false,
                  context: false,
                  session: false,
                  workspace: false,
                  future: "keep-a-status",
                },
                future_workspace: { nested: "a" },
              },
              [workspaceBRoot]: {
                model: "legacy/project-b",
                permission_mode: "ask",
                effort: "high",
                fast_mode: false,
                startup_scrollback: true,
                prompt_history: { enabled: true, future: "keep-b-history" },
                statusLine: {
                  sandbox: false,
                  context: false,
                  session: false,
                  workspace: false,
                  future: "keep-b-status",
                },
                future_workspace: { nested: "b" },
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const catalogEnv = seededFakeCodexEnv(home, codex, {
          ...NO_AUTH,
        });

        session = await TmuxSession.create({
          cwd: workspaceARoot,
          env: catalogEnv,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendKeys("BTab");
        await session.waitForText("auto ·", TIMEOUT);
        await session.pasteText(`/model ${CODEX_MODEL} auto`);
        const beforeModelCommit = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(beforeModelCommit).not.toHaveProperty("model");
        await session.sendKeys("Enter");
        await session.waitForText(`● Switched to ${CODEX_MODEL}`, TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText("startup_scrollback: off", TIMEOUT);
        await disablePromptHistory(session, join(home, ".fiber", "settings.json"));
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        expect(stored.models.codex).toBe(CODEX_MODEL);
        expect(stored.permission_mode).toBe("auto");
        expect(stored.effort).toBe("auto");
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.prompt_history).toMatchObject({ enabled: false });
        expect(stored.future_global).toEqual({ nested: "preserve-me" });
        for (const [workspaceRoot, futureWorkspace, historyFuture] of [
          [workspaceARoot, "a", "keep-a-history"],
          [workspaceBRoot, "b", "keep-b-history"],
        ] as const) {
          const override = stored.workspaces[workspaceRoot];
          expect(override).not.toHaveProperty("model");
          expect(override).not.toHaveProperty("permission_mode");
          expect(override).not.toHaveProperty("effort");
          expect(override).not.toHaveProperty("startup_scrollback");
          expect(override.prompt_history).toEqual({ future: historyFuture });
          expect(override.future_workspace).toEqual({ nested: futureWorkspace });
        }
        expect(readFileSync(join(workspaceA, ".fiber.json"), "utf8")).toBe(projectABytes);
        expect(readFileSync(join(workspaceB, ".fiber.json"), "utf8")).toBe(projectBBytes);

        const migrationSnapshots = [
          "model",
          "permission_mode",
          "effort",
          "startup_scrollback",
          "prompt_history_enabled",
        ].map((field) => migrationSnapshotPath(home, field));
        for (const snapshotPath of migrationSnapshots) {
          expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
        }

        session = await TmuxSession.create({
          cwd: workspaceBRoot,
          env: catalogEnv,
          stderrPath: stderrBPath,
        });
        const startup = await session.waitForText(
          `auto · ${CODEX_MODEL}`,
          TIMEOUT,
        );
        expect(startup).toContain(`auto · ${CODEX_MODEL}`);
        expect(startup).not.toContain("adaptive");
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        session = await TmuxSession.create({
          cwd: workspaceBRoot,
          env: {
            ...catalogEnv,
            FIBER_MODEL: CODEX_MODEL,
          },
          stderrPath: stderrBPath,
        });
        await session.waitForText("gpt-5", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const afterOverride = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(afterOverride.models.codex).toBe(CODEX_MODEL);
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  serialTest(
    "legacy output settings remain inert and output text follows prompt admission",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-config-output-shadow-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const projectBytes =
          "{\"output_level\":{\"legacy\":true},\"future\":{\"keep\":true}}\n";
        writeFileSync(join(workspace, ".fiber.json"), projectBytes);
        const unrelatedWorkspace = join(root, "unrelated-workspace");
        const settingsBytes =
          JSON.stringify({
            output_level: { legacy: true },
            startup_scrollback: true,
            workspaces: {
              [workspaceRoot]: {
                output_level: ["quiet", 7],
                future_workspace: { keep: true },
              },
              [unrelatedWorkspace]: {
                model: 123,
                future_workspace: { preserve: true },
              },
            },
          }) + "\n";
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          settingsBytes,
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: { ...NO_AUTH, HOME: home },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/output quiet");
        await session.waitForText("Codex needs a subscription login", TIMEOUT);
        expect(composerContains(await session.capturePane(), "/output quiet")).toBe(
          true,
        );
        await session.sendKeys("C-u");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText(
          "startup_scrollback: off (applies on next launch)",
          TIMEOUT,
        );
        await session.waitForStableComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(stored.output_level).toEqual({ legacy: true });
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.workspaces[workspaceRoot]).toEqual({
          output_level: ["quiet", 7],
          future_workspace: { keep: true },
        });
        expect(stored.workspaces[unrelatedWorkspace]).toEqual({
          model: 123,
          future_workspace: { preserve: true },
        });
        expect(readFileSync(join(workspace, ".fiber.json"), "utf8")).toBe(projectBytes);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );


  serialTest(
    "Escape keeps the model picker dismissed until the model trigger restarts",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-model-picker-dismissal-"));
      const codex = startFakeCodex({ extraModels: [CODEX_PICKER_MODEL] });
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({ model: CODEX_MODEL }) + "\n",
        );

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: seededFakeCodexEnv(home, codex, {
            ...NO_AUTH,
          }),
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendLiteral("/model");
        await session.sendKeys("Tab");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);

        await session.sendKeys("Escape");
        await session.waitForPane(
          (pane) =>
            composerContains(pane, "/model") &&
            !pane.includes(CODEX_PICKER_MODEL),
          TIMEOUT,
        );
        await session.sendLiteral("x");
        await session.waitForPane(
          (pane) =>
            composerContains(pane, "/model x") &&
            !pane.includes(CODEX_PICKER_MODEL),
          TIMEOUT,
        );

        await session.sendKeys("C-u");
        await session.sendLiteral("/model");
        await session.sendKeys("Tab");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);

        await session.sendKeys("C-u");
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "settings reasoning effort changes without mutating the selected model",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-settings-effort-"));
      const codex = startFakeCodex();
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        const settingsPath = join(home, ".fiber", "settings.json");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        writeFileSync(
          settingsPath,
          JSON.stringify({ model: CODEX_MODEL, effort: "low" }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          env: seededFakeCodexEnv(home, codex, {
            ...NO_AUTH,
          }),
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/settings");
        await session.waitForText("←→ Change", TIMEOUT);
        await session.sendLiteral("reason");
        const effortSetting = await session.waitForText("Reasoning effort", TIMEOUT);
        expect(effortSetting).toContain("low");
        await session.sendKeys("Right");

        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        const persistenceDeadline = Date.now() + TIMEOUT;
        while (stored.effort !== "high" && Date.now() < persistenceDeadline) {
          await Bun.sleep(25);
          stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        }
        expect(stored).toMatchObject({
          model: CODEX_MODEL,
          effort: "high",
        });
        expect(session.paneStatus()).toEqual({ dead: false, status: null });
        expect(await session.capturePane()).toContain("high");

        await session.sendKeys("Escape");
        await session.waitForComposer(TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
        expect(codex.requests).toHaveLength(0);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "Codex picker effort drives request and persistence",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-anthropic-capabilities-"));
      const replies = ["Codex selected model complete"];
      let replyIndex = 0;
      const codex = startFakeCodex({
        extraModels: [CODEX_PICKER_MODEL],
        route: () => codexFinalText(replies[replyIndex++] ?? "unexpected"),
      });
      try {
        const home = join(root, "home");
        const opusWorkspace = join(root, "opus-workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(opusWorkspace);
        const opusRoot = realpathSync(opusWorkspace);
        const settingsPath = join(home, ".fiber", "settings.json");
        const initialSettings = JSON.stringify({
          model: CODEX_PICKER_MODEL,
          effort: "high",
          fast_mode: false,
        }) + "\n";
        writeFileSync(
          settingsPath,
          initialSettings,
          { mode: 0o600 },
        );
        const catalogEnv = seededFakeCodexEnv(home, codex, {
          ...NO_AUTH,
          FIBER_DISABLE_KEYCHAIN: "1",
        });

        session = await TmuxSession.create({
          cwd: opusRoot,
          env: catalogEnv,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendLiteral(`/model ${CODEX_MODEL}`);
        await session.waitForText(CODEX_MODEL, TIMEOUT);
        await session.sendKeys("C-u");
        await session.waitForPane(
          (pane) =>
            hasEmptyComposer(pane) &&
            !composerContains(pane, CODEX_MODEL),
          TIMEOUT,
        );
        await session.sendLiteral("/model");
        await session.sendKeys("Tab");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        expect(readFileSync(settingsPath, "utf8")).toBe(initialSettings);
        await session.sendKeys("Enter");
        await session.waitForText("default", TIMEOUT);
        for (let i = 0; i < 2; i += 1) await session.sendKeys("Down");
        await session.waitForText("high", TIMEOUT);
        await session.sendKeys("Enter");
        const selectedStatus = await session.waitForText(
          `${CODEX_PICKER_MODEL} · high`,
          TIMEOUT,
        );
        await session.sendText("Use the selected model.");
        await session.waitForText("Codex selected model complete", TIMEOUT);
        expect(codex.requests).toHaveLength(1);
        const request = JSON.parse(codex.requests[0]!.body);
        expect(request.model).toBe(CODEX_PICKER_MODEL);
        expect(codex.requests[0]!.authorization).toBe(
          `Bearer ${chatGptAccessToken()}`,
        );
        expect(request).not.toHaveProperty("service_tier");
        expect(request.reasoning).toEqual({ effort: "high", summary: "auto" });
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored).toMatchObject({
          models: { codex: CODEX_PICKER_MODEL },
          effort: "high",
          fast_mode: false,
        });

        session = await TmuxSession.create({
          cwd: opusRoot,
          env: catalogEnv,
          stderrPath,
        });
        const restoredStatus = await session.waitForText(
          `${CODEX_PICKER_MODEL} · high`,
          TIMEOUT,
        );
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "GPT 5.6 Sol picker effort drives the request",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-openai-capabilities-"));
      const replies = [
        "GPT 5.6 stale effort filtered",
        "GPT 5.6 selected effort complete",
      ];
      let replyIndex = 0;
      const codex = startFakeCodex({
        extraModels: [CODEX_PICKER_MODEL],
        route: () => codexFinalText(replies[replyIndex++] ?? "unexpected"),
      });
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            model: CODEX_PICKER_MODEL,
            effort: "minimal",
          }) + "\n",
          { mode: 0o600 },
        );
        const catalogEnv = seededFakeCodexEnv(home, codex, {
          ...NO_AUTH,
        });

        const staleResult = await runFx(
          ["ask", "--permission-mode", "auto", "--json", "--no-save", "Use stale minimal effort."],
          {
            cwd: workspaceRoot,
            env: catalogEnv,
            timeoutMs: TIMEOUT,
          },
        );
        expect(staleResult.code).toBe(0);
        expect(codex.requests).toHaveLength(1);
        const staleRequest = JSON.parse(codex.requests[0]!.body);
        expect(staleRequest).not.toHaveProperty("reasoning");
        expect(staleRequest).not.toHaveProperty("service_tier");
        expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
          model: CODEX_PICKER_MODEL,
          effort: "minimal",
        });

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: catalogEnv,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendLiteral("/model sol");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        await session.sendKeys("Enter");
        const efforts = await session.waitForText("default", TIMEOUT);
        expect(efforts).not.toContain("minimal");
        for (let i = 0; i < 2; i += 1) await session.sendKeys("Down");
        await session.waitForText("high", TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText(`${CODEX_PICKER_MODEL} · high`, TIMEOUT);
        await session.waitForComposer(TIMEOUT);

        const stored = JSON.parse(
          readFileSync(settingsPath, "utf8"),
        );
        expect(stored).toMatchObject({
          models: { codex: CODEX_PICKER_MODEL },
          effort: "high",
        });

        await session.sendText("Use the selected model.");
        await session.waitForText("GPT 5.6 selected effort complete", TIMEOUT);
        expect(codex.requests).toHaveLength(2);
        const followUp = JSON.parse(codex.requests[1]!.body);
        expect(followUp.model).toBe(CODEX_PICKER_MODEL);
        expect(codex.requests[1]!.authorization).toBe(
          `Bearer ${chatGptAccessToken()}`,
        );
        expect(followUp.reasoning).toEqual({ effort: "high", summary: "auto" });
        expect(followUp).not.toHaveProperty("service_tier");

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "Codex picker selection persists with the selected effort",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-fable-capabilities-"));
      const codex = startFakeCodex({ extraModels: [CODEX_PICKER_MODEL] });
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: seededFakeCodexEnv(home, codex, {
            ...NO_AUTH,
          }),
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await filterStartupModelPicker(session, "sol");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText("default", TIMEOUT);
        for (let i = 0; i < 2; i += 1) await session.sendKeys("Down");
        await session.waitForText("high", TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText(`${CODEX_PICKER_MODEL} · high`, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        expect(stored).toMatchObject({
          models: { codex: CODEX_PICKER_MODEL },
          effort: "high",
        });
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "model picker selection persists when a matching skill exists",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-model-picker-skill-"));
      const codex = startFakeCodex({ extraModels: [CODEX_PICKER_MODEL] });
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        const skillRoot = join(home, ".fiber", "skills", "model-helper");
        mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        writeFileSync(
          join(skillRoot, "SKILL.md"),
          "---\nname: model-helper\ndescription: model helper skill\n---\n\nModel helper body\n",
        );
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: seededFakeCodexEnv(home, codex, {
            ...NO_AUTH,
          }),
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await filterStartupModelPicker(session, "sol");
        const pickerPane = await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        expect(pickerPane).toContain(CODEX_PICKER_MODEL);
        await session.sendKeys("Enter");
        await session.waitForText("default", TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText(`● Switched to ${CODEX_PICKER_MODEL}`, TIMEOUT);
        await session.waitForPane(
          (pane) =>
            hasEmptyComposer(pane) &&
            !pane.includes("model-helper"),
          TIMEOUT,
        );
        expect(await session.capturePane()).not.toContain("saved to user settings");

        const stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        expect(stored.models.codex).toBe(CODEX_PICKER_MODEL);
        expect(stored.effort).toBe("auto");

        const scrollback = await session.captureFullScrollbackEscapes();
        expect(scrollback).toContain(CODEX_PICKER_MODEL);
        expect(scrollback).toContain(`● Switched to ${CODEX_PICKER_MODEL}`);
        expect(codex.requests).toHaveLength(0);

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "Codex catalog reasoning drives portable effort requests and persistence",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-codex-capabilities-"));
      const replies = ["portable auto complete", "portable future complete"];
      let replyIndex = 0;
      const codex = startFakeCodex({
        extraModels: [CODEX_PICKER_MODEL],
        route: () => codexFinalText(replies[replyIndex++] ?? "unexpected"),
      });
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeSeededChatGptLogin(home, chatGptAccessToken());
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: seededFakeCodexEnv(home, codex, {
            ...NO_AUTH,
          }),
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await filterStartupModelPicker(session, "sol");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        await session.sendKeys("Enter");
        const autoEffortPicker = await session.waitForText("default", TIMEOUT);
        expect(autoEffortPicker).toContain("low");
        expect(autoEffortPicker).toContain("high");
        await session.sendKeys("Enter");
        await session.waitForText(`● Switched to ${CODEX_PICKER_MODEL}`, TIMEOUT);

        let stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        expect(stored.models.codex).toBe(CODEX_PICKER_MODEL);

        await session.sendText("Use portable auto.");
        await session.waitForText("portable auto complete", TIMEOUT);
        expect(codex.requests).toHaveLength(1);
        const firstRequest = JSON.parse(codex.requests[0]!.body);
        expect(firstRequest.model).toBe(CODEX_PICKER_MODEL);
        expect(firstRequest).not.toHaveProperty("reasoning");

        await session.sendLiteral("/model sol");
        await session.waitForText(CODEX_PICKER_MODEL, TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText("default", TIMEOUT);
        await session.sendKeys("Down");
        await session.waitForText("low", TIMEOUT);
        await session.sendKeys("Enter");
        await session.waitForText("· low", TIMEOUT);

        stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        const persistenceDeadline = Date.now() + TIMEOUT;
        while (stored.effort !== "low" && Date.now() < persistenceDeadline) {
          await Bun.sleep(25);
          stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        }
        expect(stored).toMatchObject({
          models: { codex: CODEX_PICKER_MODEL },
          effort: "low",
        });

        await session.sendText("Use portable future.");
        await session.waitForText("portable future complete", TIMEOUT);
        expect(codex.requests).toHaveLength(2);
        const secondRequest = JSON.parse(codex.requests[1]!.body);
        expect(secondRequest.reasoning).toEqual({ effort: "low", summary: "auto" });
        expect(secondRequest).not.toHaveProperty("service_tier");

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        stored = JSON.parse(readFileSync(join(home, ".fiber", "settings.json"), "utf8"));
        expect(stored).toMatchObject({
          models: { codex: CODEX_PICKER_MODEL },
          effort: "low",
        });
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "settings persistence remains available when session storage is unavailable",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-config-first-write-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        writeFileSync(join(home, ".fiber", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("/settings startup-scrollback off");
        await session.waitForText("startup_scrollback: off", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(tree(home)).toEqual([
          ".fiber",
          ".fiber/history.jsonl",
          ".fiber/history.lock",
          ".fiber/sessions",
          ".fiber/settings.json",
          ".fiber/settings.lock",
        ]);
        expect(statSync(join(home, ".fiber")).mode & 0o777).toBe(0o700);
        expect(statSync(join(home, ".fiber", "history.jsonl")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".fiber", "history.lock")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".fiber", "settings.json")).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, ".fiber", "settings.lock")).mode & 0o777).toBe(0o600);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  serialTest("config diagnostics preserve invalid, oversized, and unsafe primaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "fiber-config-diagnostics-"));
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      const workspaceRoot = realpathSync(workspace);
      const settingsPath = join(home, ".fiber", "settings.json");

      const malformed = "{bad\n";
      writeFileSync(settingsPath, malformed, { mode: 0o600 });
      const malformedStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(malformedStatus.code).toBe(0);
      expect(malformedStatus.stderr).toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(malformed);

      const malformedStatusLine = "{\"statusLine\":{\"context\":1}}\n";
      writeFileSync(settingsPath, malformedStatusLine, { mode: 0o600 });
      const malformedStatusLineStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(malformedStatusLineStatus.code).toBe(0);
      expect(malformedStatusLineStatus.stderr).toContain("malformed_settings");
      expect(readFileSync(settingsPath, "utf8")).toBe(malformedStatusLine);

      const inertOutputSettings =
        JSON.stringify({
          output_level: { legacy: true },
          workspaces: {
            [workspaceRoot]: {
              output_level: ["quiet", 7],
            },
          },
        }) + "\n";
      writeFileSync(settingsPath, inertOutputSettings, { mode: 0o600 });
      const inertStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertStatus.code).toBe(0);
      expect(inertStatus.stderr).not.toContain("legacy_workspace_preferences");
      const inertDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(inertDoctor.code).toBe(0);
      expect(inertDoctor.stdout).not.toContain("legacy_workspace_preferences");

      session = await TmuxSession.create({
        cwd: workspaceRoot,
        env: { ...NO_AUTH, HOME: home },
      });
      await session.waitForText("Run /help", TIMEOUT);
      expect(await session.capturePane()).not.toContain(
        "legacy_workspace_preferences",
      );
      await session.kill();
      session = null;

      expect(readFileSync(settingsPath, "utf8")).toBe(inertOutputSettings);

      const oversized = JSON.stringify({ padding: "x".repeat(65 * 1024) }) + "\n";
      writeFileSync(settingsPath, oversized, { mode: 0o600 });
      const oversizedDoctor = await runFx(["doctor", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(oversizedDoctor.code).toBe(0);
      expect(oversizedDoctor.stdout).toContain("settings_too_large");
      expect(readFileSync(settingsPath, "utf8")).toBe(oversized);

      const external = join(root, "external-settings.json");
      writeFileSync(external, "{\"model\":\"external\"}\n", { mode: 0o600 });
      rmSync(settingsPath);
      symlinkSync(external, settingsPath);
      const unsafeStatus = await runFx(["status", "--json"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(unsafeStatus.code).toBe(0);
      expect(unsafeStatus.stderr).toContain("durable_path_unsafe");
      expect(readFileSync(external, "utf8")).toBe("{\"model\":\"external\"}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  serialTest(
    "concurrent global mutations preserve both values and unknown keys",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-config-concurrent-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            future_global: { nested: "keep-global" },
            workspaces: {
              [workspaceRoot]: {
                future_workspace: {
                  nested: { keep: true },
                },
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(home, ".fiber", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        [session, secondSession] = await Promise.all([
          TmuxSession.create({ cwd: workspaceRoot, env }),
          TmuxSession.create({ cwd: workspaceRoot, env }),
        ]);
        await Promise.all([
          session.waitForText("Run /help", TIMEOUT),
          secondSession.waitForText("Run /help", TIMEOUT),
        ]);
        await secondSession.sendText("/settings");
        await secondSession.waitForText("←→ Change", TIMEOUT);
        await secondSession.sendLiteral("status line context");
        await secondSession.waitForText(/Status line context\s+off/, TIMEOUT);
        await Promise.all([
          session.sendText("/settings startup-scrollback off"),
          secondSession.sendKeys("Right"),
        ]);
        await Promise.all([
          session.waitForText("startup_scrollback: off", TIMEOUT),
          waitForStatuslineSetting(join(home, ".fiber", "settings.json"), "context", true),
        ]);
        await secondSession.sendKeys("Escape");
        await secondSession.waitForComposer(TIMEOUT);
        await Promise.all([
          session.sendText("/quit"),
          secondSession.sendText("/quit"),
        ]);
        await Promise.all([
          session.waitForSessionEnd(TIMEOUT),
          secondSession.waitForSessionEnd(TIMEOUT),
        ]);
        session = null;
        secondSession = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(stored.future_global).toEqual({ nested: "keep-global" });
        expect(stored.startup_scrollback).toBe(false);
        expect(stored.statusLine).toMatchObject({ context: true });
        expect(stored.workspaces[workspaceRoot]).toMatchObject({
          future_workspace: {
            nested: { keep: true },
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "stale workspace mutations preserve an ordered remove and add",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-concurrent-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const added = join(root, "added");
        const launch = join(root, "launch");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(added);
        mkdirSync(launch);
        const workspaceRoot = realpathSync(workspace);
        const addedRoot = realpathSync(added);
        const launchRoot = realpathSync(launch);
        const savedRoots = Array.from({ length: 15 }, (_, index) => {
          const path = join(root, `saved-${index}`);
          mkdirSync(path);
          return realpathSync(path);
        });
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: savedRoots,
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(home, ".fiber", "sessions"), "blocked\n", {
          mode: 0o600,
        });
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        [session, secondSession] = await Promise.all([
          TmuxSession.create({
            cwd: workspaceRoot,
            env,
            stderrPath: stderrAPath,
          }),
          TmuxSession.create({
            cmd: `${FIBER_BIN} --add-dir ${launchRoot}`,
            cwd: workspaceRoot,
            env,
            stderrPath: stderrBPath,
          }),
        ]);
        await Promise.all([
          session.waitForText("Run /help", TIMEOUT),
          secondSession.waitForText("Run /help", TIMEOUT),
        ]);

        await session.sendText(`/workspace remove ${savedRoots[0]}`);
        await session.waitForText("remove ", TIMEOUT);
        await session.waitForText("saved-14 saved=true", TIMEOUT);
        await secondSession.sendText(`/workspace add ${addedRoot}`);
        await secondSession.waitForText("add ", TIMEOUT);
        await secondSession.waitForText("launch saved=false", TIMEOUT);

        await Promise.all([
          session.sendText("/quit"),
          secondSession.sendText("/quit"),
        ]);
        await Promise.all([
          session.waitForSessionEnd(TIMEOUT),
          secondSession.waitForSessionEnd(TIMEOUT),
        ]);
        session = null;
        secondSession = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(
          stored.workspaces[workspaceRoot].additional_directories,
        ).toEqual([...savedRoots.slice(1), addedRoot]);
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace add rejects effective capacity without changing settings",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-capacity-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const added = join(root, "added");
        const launch = join(root, "launch");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(added);
        mkdirSync(launch);
        const workspaceRoot = realpathSync(workspace);
        const addedRoot = realpathSync(added);
        const launchRoot = realpathSync(launch);
        const savedRoots = Array.from({ length: 15 }, (_, index) => {
          const path = join(root, `saved-${index}`);
          mkdirSync(path);
          return realpathSync(path);
        });
        const settingsPath = join(home, ".fiber", "settings.json");
        const originalSettings =
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: savedRoots,
              },
            },
          }) + "\n";
        writeFileSync(settingsPath, originalSettings, { mode: 0o600 });
        writeFileSync(join(home, ".fiber", "sessions"), "blocked\n", {
          mode: 0o600,
        });

        session = await TmuxSession.create({
          cmd: `${FIBER_BIN} --add-dir ${launchRoot}`,
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${addedRoot}`);
        await session.waitForText(
          "Workspace settings were not changed: additional directory limit reached",
          TIMEOUT,
        );
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(settingsPath, "utf8")).toBe(originalSettings);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal persists after an observed source disappears",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-source-disappears-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const savedLink = join(root, "saved-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        symlinkSync(shared, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        await session.sendText(`/workspace remove ${savedLink}`);
        await session.waitForText("additional directories: (none)", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal persists after an observed source retargets",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-source-moves-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const savedLink = join(root, "saved-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");
        await session.sendText(`/workspace remove ${firstRoot}`);
        await session.waitForText("additional directories: (none)", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal consumes a concurrent exact canonical replacement",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-target-replaced-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const target = join(root, "target");
        const unseenBefore = join(root, "unseen-before");
        const unseenAfter = join(root, "unseen-after");
        const targetLink = join(root, "target-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(target);
        mkdirSync(unseenBefore);
        mkdirSync(unseenAfter);
        symlinkSync(target, targetLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const targetRoot = realpathSync(target);
        const unseenBeforeRoot = realpathSync(unseenBefore);
        const unseenAfterRoot = realpathSync(unseenAfter);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [targetLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  unseenBeforeRoot,
                  targetRoot,
                  unseenAfterRoot,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        await session.sendText(`/workspace remove ${targetRoot}`);
        await session.waitForText("runtime_changed=true", TIMEOUT);
        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenBeforeRoot,
          unseenAfterRoot,
        ]);

        await session.sendText("/clear");
        await session.waitForPane(
          (pane) => hasEmptyComposer(pane) && !pane.includes(targetRoot),
          TIMEOUT,
        );
        await session.sendText("/workspace list");
        await session.waitForText(unseenBeforeRoot, TIMEOUT);
        await session.waitForText(unseenAfterRoot, TIMEOUT);
        const pane = await session.capturePaneGrid();
        expect(pane).not.toContain(targetRoot);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace removal prefers a concurrent canonical survivor before restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-survivor-moves-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const removed = join(root, "removed");
        const survivor = join(root, "survivor");
        const retarget = join(root, "retarget");
        const unseenBefore = join(root, "unseen-before");
        const unseenAfter = join(root, "unseen-after");
        const removedLink = join(root, "removed-link");
        const survivorLinkA = join(root, "survivor-link-a");
        const survivorLinkB = join(root, "survivor-link-b");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(removed);
        mkdirSync(survivor);
        mkdirSync(retarget);
        mkdirSync(unseenBefore);
        mkdirSync(unseenAfter);
        symlinkSync(removed, removedLink, "dir");
        symlinkSync(survivor, survivorLinkA, "dir");
        symlinkSync(survivor, survivorLinkB, "dir");
        const workspaceRoot = realpathSync(workspace);
        const removedRoot = realpathSync(removed);
        const survivorRoot = realpathSync(survivor);
        const retargetRoot = realpathSync(retarget);
        const unseenBeforeRoot = realpathSync(unseenBefore);
        const unseenAfterRoot = realpathSync(unseenAfter);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [removedLink, survivorLinkA, survivorLinkB],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  unseenBeforeRoot,
                  removedLink,
                  survivorLinkA,
                  survivorRoot,
                  survivorLinkB,
                  unseenAfterRoot,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        rmSync(survivorLinkA);
        rmSync(survivorLinkB);
        symlinkSync(retarget, survivorLinkA, "dir");
        symlinkSync(retarget, survivorLinkB, "dir");
        await session.sendText(`/workspace remove ${removedRoot}`);
        await session.waitForText("runtime_changed=true", TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenBeforeRoot,
          survivorRoot,
          unseenAfterRoot,
        ]);
        rmSync(survivorLinkA);
        rmSync(survivorLinkB);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(unseenBeforeRoot, TIMEOUT);
        await secondSession.waitForText(survivorRoot, TIMEOUT);
        await secondSession.waitForText(unseenAfterRoot, TIMEOUT);
        const pane = await secondSession.capturePaneGrid();
        expect(pane).not.toContain(retargetRoot);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace removal uses observed identity and preserves an unseen source",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-source-retarget-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const savedLink = join(root, "saved-link");
        const unseenLink = join(root, "unseen-link");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: { additional_directories: [savedLink] },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: {
            ...NO_AUTH,
            HOME: home,
          },
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);

        symlinkSync(first, unseenLink, "dir");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [savedLink, unseenLink],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");

        await session.sendText(`/workspace remove ${savedLink}`);
        await session.waitForText(firstRoot, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          unseenLink,
        ]);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );

  serialTest(
    "workspace add canonicalizes observed aliases before restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-source-restart-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const first = join(root, "first");
        const second = join(root, "second");
        const added = join(root, "added");
        const savedLink = join(root, "saved-link");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(first);
        mkdirSync(second);
        mkdirSync(added);
        symlinkSync(first, savedLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const firstRoot = realpathSync(first);
        const secondRoot = realpathSync(second);
        const addedRoot = realpathSync(added);
        const settingsPath = join(home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [savedLink, firstRoot],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        rmSync(savedLink);
        symlinkSync(second, savedLink, "dir");
        await session.sendText(`/workspace add ${addedRoot}`);
        await session.waitForText(addedRoot, TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          firstRoot,
          addedRoot,
        ]);
        rmSync(savedLink);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(firstRoot, TIMEOUT);
        await secondSession.waitForText(addedRoot, TIMEOUT);
        const pane = await secondSession.capturePaneGrid();
        expect(pane).not.toContain(secondRoot);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace slash mutations persist across restart and remove cleanly",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-slash-persistence-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared project");
        const stderrAPath = join(root, "stderr-a.log");
        const stderrBPath = join(root, "stderr-b.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrAPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              "saved_changed=trueruntime_changed=true",
            ),
          TIMEOUT,
        );
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const stored = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        secondSession = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath: stderrBPath,
        });
        await secondSession.waitForText("Run /help", TIMEOUT);
        await secondSession.sendText("/workspace list");
        await secondSession.waitForText(sharedRoot, TIMEOUT);
        await secondSession.waitForPane(
          (pane) => pane.replaceAll("\n", "").includes("active=true"),
          TIMEOUT,
        );
        await secondSession.sendText(`/workspace remove ${sharedRoot}`);
        await secondSession.waitForText("additional directories: (none)", TIMEOUT);
        await secondSession.sendText("/quit");
        await secondSession.waitForSessionEnd(TIMEOUT);
        secondSession = null;

        const cleared = JSON.parse(
          readFileSync(join(home, ".fiber", "settings.json"), "utf8"),
        );
        expect(cleared.workspaces?.[workspaceRoot]?.additional_directories).toBeUndefined();
        expect(readFileSync(stderrAPath, "utf8")).toBe("");
        expect(readFileSync(stderrBPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace list marks a directory deleted during the session unavailable",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-live-availability-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace add ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              `${sharedRoot}saved=truecommand_line=falseavailable=trueactive=true`,
            ),
          TIMEOUT,
        );

        rmSync(sharedRoot, { recursive: true });
        await session.sendText("/workspace list");
        await session.waitForPane(
          (pane) =>
            pane.replace(/\s+/g, "").includes(
              `${sharedRoot}saved=truecommand_line=falseavailable=falseactive=false`,
            ),
          TIMEOUT,
        );
        const scrollback = await session.captureFullScrollback();
        expect(scrollback.replace(/\s+/g, "")).toContain(
          `${sharedRoot}saved=truecommand_line=falseavailable=falseactive=false`,
        );

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace list restores canonical access through a new symlinked ancestor",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-restored-canonical-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const realParent = join(root, "real-parent");
        const shared = join(realParent, "shared");
        const parentLink = join(root, "parent-link");
        const source = join(parentLink, "shared");
        const stderrPath = join(root, "stderr.log");
        const fixture = "RESTORED_CANONICAL_ROOT_FIXTURE";
        const instructionSentinel = "RESTORED_ROOT_AGENTS_MUST_NOT_LOAD";
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared, { recursive: true });
        writeFileSync(join(shared, "fixture.txt"), `${fixture}\n`);
        writeFileSync(join(shared, "AGENTS.md"), `${instructionSentinel}\n`);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        writeSeededChatGptLogin(home, chatGptAccessToken());
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            sandbox: "none",
            permission_mode: "auto",
            permission: {},
            workspaces: {
              [workspaceRoot]: { additional_directories: [source] },
            },
          }),
        );

        const fixturePath = join(source, "fixture.txt");
        const codex = startFakeCodex({
          route: (body) => {
            const items = JSON.parse(body).input ?? [];
            if (items.some((item: { type?: string }) => item.type === "function_call_output")) {
              return codexFinalText("RESTORED_CANONICAL_ROOT_COMPLETE");
            }
            return codexToolCall("restored-root-read", "read_file", {
              path: fixturePath,
              line_count: 10,
            });
          },
        });
        try {
          session = await TmuxSession.create({
            cwd: workspaceRoot,
            env: seededFakeCodexEnv(home, codex, {
              FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
            }),
            stderrPath,
          });
          await session.waitForText("Run /help", TIMEOUT);

          symlinkSync(realParent, parentLink, "dir");
          await session.sendText("/workspace list");
          await session.waitForPane(
            (pane) =>
              pane.replace(/\s+/g, "").includes(
                `${sharedRoot}saved=truecommand_line=falseavailable=trueactive=true`,
              ),
            TIMEOUT,
          );

          await session.sendText("Read the restored workspace fixture once.");
          await session.waitForText("RESTORED_CANONICAL_ROOT_COMPLETE", TIMEOUT);
          expect(codex.requests).toHaveLength(2);
          for (const request of codex.requests) {
            expect(request.body).not.toContain(instructionSentinel);
            expect(request.body).not.toContain("target outside workspace");
            expect(request.body).not.toContain("Not executed");
          }
          expect(codex.requests[1]!.body).toContain(fixture);
          expect(readFileSync(stderrPath, "utf8")).toBe("");
          expect(session.isAlive()).toBe(true);
          expect(session.isPaneAlive()).toBe(true);

          await session.sendText("/quit");
          await session.waitForSessionEnd(TIMEOUT);
          session = null;
        } finally {
          codex.stop();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "workspace slash removal explains launch restoration and uses friendly errors",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fiber-workspace-launch-removal-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const stderrPath = join(root, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const env = {
          ...NO_AUTH,
          HOME: home,
        };

        session = await TmuxSession.create({
          cmd: `${FIBER_BIN} --add-dir ${sharedRoot}`,
          cwd: workspaceRoot,
          env,
          stderrPath,
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText(`/workspace remove ${unknownRoot}`);
        await session.waitForText(
          "Workspace update rejected: directory is not configured as an additional workspace",
          TIMEOUT,
        );
        await session.sendText(`/workspace remove ${workspaceRoot}`);
        await session.waitForText(
          "the primary workspace cannot be added or removed",
          TIMEOUT,
        );
        let pane = await session.capturePaneGrid();
        expect(pane).not.toContain("PrimaryDirectory");

        await session.sendText(`/workspace remove ${sharedRoot}`);
        await session.waitForPane(
          (pane) =>
            pane.replaceAll("\n", "").includes("launch_flag_can_restore=true"),
          TIMEOUT,
        );
        await session.waitForText(
          "warning: repeating --add-dir can restore removed access on the next launch",
          TIMEOUT,
        );
        await session.waitForText("additional directories: (none)", TIMEOUT);
        pane = await session.capturePaneGrid();
        expect(pane).not.toContain("PrimaryDirectory");

        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const settingsPath = join(home, ".fiber", "settings.json");
        if (statSync(settingsPath, { throwIfNoEntry: false })) {
          const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
          expect(
            stored.workspaces?.[workspaceRoot]?.additional_directories,
          ).toBeUndefined();
        }
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
