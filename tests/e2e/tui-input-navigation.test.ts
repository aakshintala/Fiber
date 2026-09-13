import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, REPO_ROOT, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  FAKE_CODEX_DEFAULT_MODEL,
  seededFakeCodexEnv,
  hasEmptyComposer,
  isComposerLine,
  startFakeCodex,
  writeSeededChatGptLogin,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";
import {
  assertPaneContains,
  assertSingleFooter,
} from "./tui-render-assertions";

const HAS_TMUX = tmuxAvailable();
if (process.env.FIBER_REQUIRE_TMUX === "1" && !HAS_TMUX) {
  throw new Error("tmux is required for tui-input-navigation.test.ts");
}

const tmuxTest = test.skipIf(!HAS_TMUX);
const TIMEOUT = 45_000;
const READY_TIMEOUT = 10_000;
const SELECTED_COMPLETION_SGR = "\x1b[1m\x1b[38;5;255m";
const RENDER_TRACE_SCOPES =
  "paint,render,scroll,frame_plan,frame_diff,frame_commit,frame_owner_violation";
const imageFixture = join(
  REPO_ROOT,
  "tests/e2e/fixtures/favicon.png",
);

let session: TmuxSession | null = null;
let testHome: string | null = null;
let codex: ReturnType<typeof startFakeCodex> | null = null;
let modelServer: ReturnType<typeof Bun.serve> | null = null;
let stderrPath: string | null = null;

afterEach(async () => {
  await session?.kill();
  session = null;
  codex?.stop();
  codex = null;
  modelServer?.stop(true);
  modelServer = null;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = null;
  stderrPath = null;
});

// The shared fake catalog is text-only, but suites here attach real images.
// The old gateway models option carried vision/file-input tags; the Codex
// equivalent is the image input modality, copied from the shared payload
// shape with that one addition.
function imageCapableModelsPayload() {
  return {
    models: [FAKE_CODEX_DEFAULT_MODEL, "gpt-5.4"].map((slug) => ({
      slug,
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      additional_speed_tiers: [],
      input_modalities: ["text", "image"],
      context_window: 272000,
    })),
  };
}

type LocalCodex = {
  handle: ReturnType<typeof startFakeCodex>;
  requests: Array<{ body: string }>;
  env: (extra?: Record<string, string | undefined>) => Record<string, string | undefined>;
};

// One fake serving the image-capable model catalog plus a finite reply
// queue, recording into the shared request logs. Used by startFx and every
// local image scenario in this file.
function startLocalCodex(home: string, replies: string[]): LocalCodex {
  const queue = [...replies];
  const handle = startFakeCodex();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") {
        handle.modelRequests.push({
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          url: req.url,
        });
        return Response.json(imageCapableModelsPayload());
      }
      const body = await req.text();
      handle.requests.push({
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body,
      });
      const reply = queue.shift() ?? "unexpected";
      return new Response(codexFinalText(reply), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  codex = handle;
  modelServer = server;
  const urls = {
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    tokenUrl: handle.tokenUrl,
  };
  return {
    handle,
    requests: handle.requests,
    env: (extra = {}) =>
      seededFakeCodexEnv(home, urls as ReturnType<typeof startFakeCodex>, {
        FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
        ...extra,
      }),
  };
}

async function startFx(
  width: number,
  height: number,
  withCodex = false,
  recordRender = false,
  codexResponseCount = 1,
): Promise<TmuxSession> {
  testHome = mkdtempSync(join(tmpdir(), "fiber-tui-input-"));
  stderrPath = join(testHome, "stderr.log");
  writeFileSync(stderrPath, "");
  mkdirSync(join(testHome, ".fiber"), { recursive: true });
  writeFileSync(
    join(testHome, ".fiber", "settings.json"),
    JSON.stringify({ sandbox: "none" }),
  );
  if (withCodex) {
    writeSeededChatGptLogin(testHome, chatGptAccessToken());
    startLocalCodex(
      testHome,
      Array.from({ length: codexResponseCount }, () => "history prompt complete"),
    );
  }
  const active = await TmuxSession.create({
    cmd: withCodex
      ? FIBER_BIN
      : `env -u AI_GATEWAY_API_KEY -u VERCEL_OIDC_TOKEN FIBER_DISABLE_KEYCHAIN=1 FIBER_SKIP_ONBOARDING=1 ${FIBER_BIN}`,
    env: {
      HOME: testHome,
      ...(codex && modelServer
        ? seededFakeCodexEnv(testHome, {
          responsesUrl: `http://127.0.0.1:${modelServer.port}/responses`,
          modelsUrl: `http://127.0.0.1:${modelServer.port}/models`,
          tokenUrl: codex.tokenUrl,
        } as ReturnType<typeof startFakeCodex>, {
          FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
        })
        : {}),
      ...(recordRender
        ? {
          FIBER_RECORD: join(testHome, "session.fibertape"),
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: join(testHome, "trace.log"),
          FIBER_TRACE_SCOPES: RENDER_TRACE_SCOPES,
        }
        : {}),
    },
    width,
    height,
    stderrPath,
  });
  session = active;
  await active.waitForComposer(READY_TIMEOUT);
  return active;
}

function largeTabbedPaste(): string {
  return [
    "\tTAB_START_0001\tquoted=\"value 1\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    `LONGTOKEN_${"X".repeat(220)}_0003`,
    "    indented code block tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7 tok8 tok9 tok10 tok11",
    "Pathish ~/tmp/example/nested/nested/nested/nested/nested/nested/nested/nested/file_12.txt",
    `MARKER_0013 ${"word ".repeat(24)}word`,
    "\tTAB_START_0015\tquoted=\"value 15\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    "\tTAB_START_0029\tquoted=\"value 29\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    "\tTAB_START_0043\tquoted=\"value 43\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    "\tTAB_START_0057\tquoted=\"value 57\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    "\tTAB_START_0071\tquoted=\"value 71\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
    "\tTAB_START_0085\tquoted=\"value 85\"\tansi_like=\\x1b[32mgreen\\x1b[0m",
  ].join("\n") + "\n";
}

function expectCleanStderr(): void {
  if (!stderrPath) throw new Error("stderrPath was not initialized");
  expect(readFileSync(stderrPath, "utf8")).toBe("");
}

async function typeLiteral(active: TmuxSession, text: string): Promise<void> {
  await active.sendKeys(`-l ${shellQuote(text)}`);
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function hexSeq(text: string): string[] {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(16).padStart(2, "0")
  );
}

function isSlashCommandRow(line: string): boolean {
  const visible = line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trimStart();
  return visible.startsWith("/");
}

function selectedSlashRow(escapes: string): string | null {
  const rows = escapes
    .split("\n")
    .filter(isSlashCommandRow);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const line = rows[index]!;
    if (line.includes(SELECTED_COMPLETION_SGR)) return line;
  }
  return null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function rowWithVisiblePredicate(
  escapes: string,
  predicate: (visible: string, raw: string) => boolean,
): string {
  for (const row of escapes.split("\n")) {
    if (predicate(stripAnsi(row), row)) return row;
  }
  throw new Error(`No ANSI row matched predicate\n${escapes}`);
}

function selectedArgumentLabelRow(escapes: string, label: string): string {
  return rowWithVisiblePredicate(
    escapes,
    (visible, raw) =>
      visible.trimStart().startsWith(label) && raw.includes(SELECTED_COMPLETION_SGR),
  );
}

function rowHasBackgroundSgr(row: string): boolean {
  return /\x1b\[[0-9;:]*48[;:]/.test(row) || /\x1b\[(?:4[0-7]|10[0-7])m/.test(row);
}

test("selected slash row ignores the welcome header help hint", () => {
  const header = `${SELECTED_COMPLETION_SGR}fiber\x1b[0m\x1b[38;5;245m v0.3.27 · Run /help for commands`;
  const composer = `${SELECTED_COMPLETION_SGR}┃ /\x1b[39m`;
  const selected = `${SELECTED_COMPLETION_SGR}  /clear\x1b[38;5;245m Clear the conversation`;

  expect(selectedSlashRow(`${header}\n${composer}\n${selected}`)).toBe(selected);
});

async function waitForSelectedSlashLabel(
  active: TmuxSession,
  label: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  let lastRow: string | null = null;
  while (Date.now() - start < timeoutMs) {
    lastRow = selectedSlashRow(await active.capturePaneEscapes());
    if (lastRow?.includes(label)) return lastRow;
    await delay(25);
  }
  throw new Error(`Timed out waiting for selected slash label ${label}; last=${lastRow}`);
}

function rowContaining(grid: string[], needle: string): { index: number; line: string } {
  const index = grid.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`No pane row contains ${JSON.stringify(needle)}\n${grid.join("\n")}`);
  return { index, line: grid[index]! };
}

async function expectOptionColumn(
  active: TmuxSession,
  label: string,
  zeroBasedColumn: number,
): Promise<void> {
  await active.waitForPane((pane) => pane.includes(label), READY_TIMEOUT);
  const matches = (await active.capturePaneGrid()).filter((line) => line.includes(label));
  if (matches.length === 0) throw new Error(`No pane row contains ${JSON.stringify(label)}`);
  const row = matches[matches.length - 1]!;
  expect(row.indexOf(label)).toBe(zeroBasedColumn);
}

async function setupPromptHistory(active: TmuxSession): Promise<void> {
  await active.sendText("zz-history");
  await active.waitForText("history prompt complete", READY_TIMEOUT);
}

async function setupMultilinePromptHistory(active: TmuxSession): Promise<void> {
  await active.sendText("older");
  await active.waitForText("history prompt complete", READY_TIMEOUT);
  await typeLiteral(active, "newer top");
  await active.sendKeys("M-Enter");
  await typeLiteral(active, "newer bottom");
  await active.sendKeys("Enter");
  await active.waitForPane(
    (pane) =>
      codex?.requests.length === 2 &&
      pane.includes("┃") &&
      !pane.includes("Thinking"),
    READY_TIMEOUT,
  );
}

async function waitForActiveFooter(
  active: TmuxSession,
  predicate: (footer: string) => boolean,
): Promise<string> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < READY_TIMEOUT) {
    const grid = await active.capturePaneGrid();
    const failures: string[] = [];
    const footer = assertSingleFooter(grid, failures, "active footer");
    if (footer && failures.length === 0) {
      last = grid.slice(footer.input, footer.bottomDivider).join("\n");
      if (predicate(last)) return last;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for active footer; last=${last}`);
}

async function waitForExactComposerRow(
  active: TmuxSession,
  expected: string,
): Promise<void> {
  const started = Date.now();
  let lastMatches: string[] = [];
  while (Date.now() - started < READY_TIMEOUT) {
    lastMatches = (await active.capturePaneGrid())
      .map((line) => line.trimEnd())
      .filter((line) => line === expected);
    if (lastMatches.length === 1) return;
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for composer row ${JSON.stringify(expected)}; matches=${lastMatches.length}`,
  );
}

async function typeTwoRowDraft(active: TmuxSession): Promise<void> {
  await typeLiteral(active, "draft");
  await active.sendKeys("M-Enter");
  await typeLiteral(active, "tail");
  await active.waitForPane((pane) => pane.includes("tail"), READY_TIMEOUT);
}

function repeatedImagePaste(count: number): string {
  return Array.from({ length: count }, () => imageFixture).join(" ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

tmuxTest(
  "raw control aliases navigate slash completion through submission",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "/");
    await waitForSelectedSlashLabel(active, "/help", READY_TIMEOUT);

    await active.sendHexBytes(["0a"]);
    await waitForSelectedSlashLabel(active, "/new", READY_TIMEOUT);
    await waitForExactComposerRow(active, "┃ /");

    await active.sendHexBytes(["0b"]);
    await waitForSelectedSlashLabel(active, "/help", READY_TIMEOUT);
    await waitForExactComposerRow(active, "┃ /");

    await active.sendKeys("Enter");
    await active.waitForText("Commands 21", READY_TIMEOUT);
    await active.sendKeys("Escape");
    await active.waitForPane(
      (pane) => hasEmptyComposer(pane) && !pane.includes("Enter Open"),
      READY_TIMEOUT,
    );
    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "unknown terminal escape sequences leave the command catalog open",
  async () => {
    const active = await startFx(80, 24);
    await active.sendText("/help");
    await active.waitForPane(
      (pane) =>
        pane.includes("/help") &&
        pane.includes("/quit") &&
        pane.includes("Run /help for commands"),
      READY_TIMEOUT,
    );

    await active.sendHexBytes(hexSeq("\x1b[>0q"));
    const afterUnknown = await active.capturePane();
    expect(afterUnknown).toContain("/help");
    expect(afterUnknown).toContain("/quit");
    expect(afterUnknown).toContain("Run /help for commands");

    await active.sendKeys("Escape");
    await active.waitForPane(
      (pane) => hasEmptyComposer(pane) && !pane.includes("Enter Open"),
      READY_TIMEOUT,
    );
    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "plain Up and Down move exactly one hard-newline visual row per press",
  async () => {
    const active = await startFx(60, 24);
    await typeLiteral(active, "alpha");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "beta");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "gamma");

    await active.waitForPane((pane) => pane.includes("gamma"), READY_TIMEOUT);
    const bottom = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    const middle = await active.waitForCursor(
      (position) => position.row === bottom.row - 1,
      READY_TIMEOUT,
    );
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === middle.row - 1, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor((position) => position.row === middle.row, READY_TIMEOUT);
  },
  TIMEOUT,
);

tmuxTest(
  "plain Up and Down move exactly one narrow-pane soft-wrap row",
  async () => {
    const active = await startFx(18, 24);
    await typeLiteral(active, "abcdefghijklmnopqrstuvwxyz0123456789");
    await active.waitForPane((pane) => pane.includes("6789"), READY_TIMEOUT);
    const bottom = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    const previous = await active.waitForCursor(
      (position) => position.row === bottom.row - 1,
      READY_TIMEOUT,
    );
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === previous.row + 1 && position.col === bottom.col,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "bracketed-pasted tabs preserve columns across rows and vertical arrows move one row",
  async () => {
    const active = await startFx(10, 24);
    await active.pasteText("\tX\naaaaaa\tY");
    await active.waitForPane((pane) => pane.includes("Y"), READY_TIMEOUT);
    const bottom = await active.waitForCursor((position) => position.col === 9, READY_TIMEOUT);
    await active.sendKeys("Up");
    const previous = await active.waitForCursor(
      (position) => position.row === bottom.row - 1,
      READY_TIMEOUT,
    );
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === previous.row + 1 && position.col === bottom.col,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "typed sentences wrap by word and continuation rows never start with a space",
  async () => {
    // 20 cols, prefix "┃ " = 18 content cells per row.
    const active = await startFx(20, 24);

    // "wrapping" (8 cells) does not fit after "hello world " (12 cells),
    // so it moves whole to the next row.
    await typeLiteral(active, "hello world wrapping here");
    let footer = await waitForActiveFooter(
      active,
      (text) => text.includes("hello world") && text.includes("wrapping here"),
    );
    let rows = footer.split("\n");
    const first = rowContaining(rows, "hello world");
    const second = rowContaining(rows, "wrapping here");
    expect(second.index).toBe(first.index + 1);
    expect(first.line).not.toContain("wrapp");
    // Continuation row starts at the prefix column, not a space.
    expect(second.line.indexOf("wrapping here")).toBe(2);

    // A space landing exactly at the margin hangs there: the row after it
    // still starts at the word.
    await active.sendKeys("C-u");
    await typeLiteral(active, "abcdefghijklmnopqr st");
    footer = await waitForActiveFooter(
      active,
      (text) =>
        text.includes("abcdefghijklmnopqr") &&
        text.split("\n").some((line) => line.trim() === "┃ st"),
    );
    rows = footer.split("\n");
    const full = rowContaining(rows, "abcdefghijklmnopqr");
    const next = rowContaining(rows, "st");
    expect(next.index).toBe(full.index + 1);
    expect(next.line.indexOf("st")).toBe(2);

    // Words wider than a full row still split per character: row 0 fills
    // all 18 content cells and the remainder continues on the next row.
    await active.sendKeys("C-u");
    await typeLiteral(active, "ab cdefghijklmnopqrstuvwxyz");
    footer = await waitForActiveFooter(
      active,
      (text) =>
        text.includes("ab cdefghijklmnopq") && text.includes("rstuvwxyz"),
    );
    rows = footer.split("\n");
    const head = rowContaining(rows, "ab cdefghijklmnopq");
    const tail = rowContaining(rows, "rstuvwxyz");
    expect(tail.index).toBe(head.index + 1);
    expect(tail.line.indexOf("rstuvwxyz")).toBe(2);
  },
  TIMEOUT,
);

tmuxTest(
  "Unicode display units repaint after a wide shift and at the right margin",
  async () => {
    const active = await startFx(60, 24);

    await typeLiteral(active, "A🇺🇸B");
    await waitForActiveFooter(active, (footer) => footer.includes("A🇺🇸B"));
    await active.sendKeys("Left Left BSpace");
    const shifted = await waitForActiveFooter(
      active,
      (footer) => footer.includes("🇺🇸B") && !footer.includes("A🇺🇸B"),
    );
    expect(shifted).not.toContain("A🇺🇸B");

    const margin_prefix = "12345678901234567890123456789012345678901234567890123456";
    await active.sendKeys("End C-u");
    await typeLiteral(active, `${margin_prefix}👩‍💻Z`);
    let footer = await waitForActiveFooter(
      active,
      (text) =>
        text.includes(`${margin_prefix}👩‍💻`) &&
        text.split("\n").some((line) => line.trim() === "┃ Z"),
    );
    let rows = footer.split("\n");
    const margin = rowContaining(rows, `${margin_prefix}👩‍💻`);
    const wrapped = rowContaining(rows, "Z");
    expect(wrapped.index).toBe(margin.index + 1);
    expect(wrapped.line.indexOf("Z")).toBe(2);

    const control_prefix = margin_prefix.slice(0, -1);
    await active.sendKeys("C-u");
    await typeLiteral(active, `${control_prefix}👩‍💻Z`);
    footer = await waitForActiveFooter(
      active,
      (text) => text.includes(`${control_prefix}👩‍💻Z`),
    );
    rows = footer.split("\n");
    expect(rowContaining(rows, `${control_prefix}👩‍💻Z`).line).toContain("👩‍💻Z");

    expectCleanStderr();
    expect(active.isAlive()).toBe(true);
  },
  TIMEOUT,
);

tmuxTest(
  "tab edge wrapping handles final cells, wide runes, and following units",
  async () => {
    const active = await startFx(10, 24);

    await active.pasteText("\tX");
    await active.waitForPane((pane) => pane.includes("X"), READY_TIMEOUT);
    await active.waitForCursor((position) => position.col === 9, READY_TIMEOUT);

    await active.sendKeys("C-u");
    await active.pasteText("aaaaaa\t界");
    await active.waitForPane((pane) => pane.includes("界"), READY_TIMEOUT);
    let grid = await active.capturePaneGrid();
    const wide = rowContaining(grid, "界");
    expect(wide.line.indexOf("界")).toBe(2);

    await active.sendKeys("C-u");
    await active.pasteText("aaaaaa\tXY");
    await active.waitForPane((pane) => pane.includes("Y"), READY_TIMEOUT);
    grid = await active.capturePaneGrid();
    const first = rowContaining(grid, "aaaaaa");
    const wrapped = rowContaining(grid, "Y");
    // "XY" is a word: it wraps whole instead of splitting after "X".
    expect(first.line).not.toContain("X");
    expect(wrapped.index).toBe(first.index + 1);
    expect(wrapped.line.indexOf("XY")).toBe(2);
  },
  TIMEOUT,
);

tmuxTest(
  "large tabbed paste keeps frame scroll plan aligned",
  async () => {
    const prompt = largeTabbedPaste();
    expect(new TextEncoder().encode(prompt)).toHaveLength(1003);
    expect(prompt.match(/\t/g)).toHaveLength(21);

    const active = await startFx(72, 16, true, true);
    const tapePath = join(testHome!, "session.fibertape");
    await active.pasteText(prompt);
    await active.waitForText("[Pasted text #1, 11 lines]", READY_TIMEOUT);
    await active.sendKeys("Enter");
    await active.waitForPane(
      (pane) => pane.includes("history prompt complete") && pane.includes("┃"),
      READY_TIMEOUT,
    );

    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
    expect(codex?.requests).toHaveLength(1);

    const messages = JSON.parse(codex!.requests[0]!.body).input as Array<{
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const finalUser = messages[messages.length - 1];
    expect(finalUser?.role).toBe("user");
    expect(finalUser?.content?.[0]).toEqual({ type: "input_text", text: prompt });

    const scrollback = await active.captureFullScrollback();
    const promptTail = scrollback.indexOf("TAB_START_0085");
    const response = scrollback.indexOf("history prompt complete");
    expect(promptTail).toBeGreaterThanOrEqual(0);
    expect(response).toBeGreaterThan(promptTail);

    const trace = readFileSync(join(testHome!, "trace.log"), "utf8");
    expect(trace).toContain("document_append_plan");
    expect(trace).not.toContain("InvalidFrameScrollPlan");
    expect(trace).not.toContain("AnsiBandOverflow");
    expect(trace).not.toContain("frame_owner_violation");

    const goldenPath = join(testHome!, "replay-grid.txt");
    const replay = await runFx(["debug", "replay", tapePath, "--golden", goldenPath], {
      cwd: REPO_ROOT,
      timeoutMs: READY_TIMEOUT,
    });
    expect(replay.code).toBe(0);
    expect(replay.stderr).toBe("");
    const gridText = readFileSync(goldenPath, "utf8");
    const failures: string[] = [];
    assertPaneContains(gridText, "history prompt complete", failures, "replay grid");
    assertSingleFooter(gridText.replace(/\n$/, "").split("\n"), failures, "replay grid");
    expect(failures).toEqual([]);
  },
  TIMEOUT,
);

tmuxTest(
  "long short long vertical movement restores the original preferred column",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "abcdefghijklmnop");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "xy");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "abcdefghijklmnop");
    await active.waitForPane((pane) => pane.includes("xy"), READY_TIMEOUT);

    const bottom = await active.waitForCursor((position) => position.col > 12, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === bottom.row - 1 && position.col < bottom.col, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === bottom.row && position.col === bottom.col,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "plain arrows navigate recalled multiline history before crossing entries",
  async () => {
    const active = await startFx(60, 24, true, false, 2);
    await setupMultilinePromptHistory(active);
    await typeTwoRowDraft(active);

    const bottom = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === bottom.row - 1, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    let footer = await waitForActiveFooter(
      active,
      (text) => text.includes("newer top") && text.includes("newer bottom"),
    );
    expect(footer).not.toContain("older");
    await active.waitForCursor(
      (position) => position.col === 2 + "newer bottom".length,
      READY_TIMEOUT,
    );

    await active.sendKeys("Left");
    const recalledBottom = await active.waitForCursor(
      (position) => position.col === 1 + "newer bottom".length,
      READY_TIMEOUT,
    );
    await active.sendKeys("Up");
    await active.waitForCursor(
      (position) => position.row === recalledBottom.row - 1,
      READY_TIMEOUT,
    );
    footer = await waitForActiveFooter(
      active,
      (text) => text.includes("newer top") && text.includes("newer bottom"),
    );
    expect(footer).not.toContain("older");

    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    footer = await waitForActiveFooter(active, (text) => text.includes("┃ older"));
    expect(footer).not.toContain("newer top");
    expect(footer).not.toContain("newer bottom");
    await active.waitForCursor(
      (position) => position.col === 2 + "older".length,
      READY_TIMEOUT,
    );

    await active.sendKeys("Down");
    footer = await waitForActiveFooter(
      active,
      (text) => text.includes("newer top") && text.includes("newer bottom"),
    );
    expect(footer).not.toContain("older");
    await active.waitForCursor(
      (position) => position.col === 2 + "newer bottom".length,
      READY_TIMEOUT,
    );

    await active.sendKeys("Down");
    footer = await waitForActiveFooter(
      active,
      (text) => text.includes("draft") && text.includes("tail"),
    );
    expect(footer).not.toContain("newer top");
    expect(footer).not.toContain("newer bottom");
    await active.waitForCursor(
      (position) => position.row === bottom.row && position.col === bottom.col,
      READY_TIMEOUT,
    );
    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "composer word editing keeps Option and Ctrl deletion contracts separate",
  async () => {
    const active = await startFx(80, 24);

    await typeLiteral(active, "hello world");
    await active.sendHexBytes(hexSeq("\x1b[98;3u"));
    await typeLiteral(active, "!");
    await active.waitForPane((pane) => pane.includes("hello !world"), READY_TIMEOUT);
    await active.sendHexBytes(hexSeq("\x1b[102;3u"));
    await typeLiteral(active, "!");
    await active.waitForPane((pane) => pane.includes("hello !world!"), READY_TIMEOUT);

    await active.sendKeys("C-a");
    await active.sendHexBytes(hexSeq("\x1bf"));
    await typeLiteral(active, "?");
    await active.waitForPane((pane) => pane.includes("hello? !world!"), READY_TIMEOUT);

    await active.sendKeys("C-u");
    await typeLiteral(active, "foo-bar");
    await active.sendHexBytes(hexSeq("\x1b[119;5u"));
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);

    await active.sendHexBytes(["19"]);
    await active.waitForPane((pane) => pane.includes("foo-bar"), READY_TIMEOUT);

    await active.sendHexBytes(hexSeq("\x1b[127;3u"));
    await active.waitForPane((pane) => pane.includes("foo-"), READY_TIMEOUT);
    expect(active.isAlive()).toBe(true);
  },
  TIMEOUT,
);

tmuxTest(
  "composer aliases edit through raw controls and meta delete",
  async () => {
    const active = await startFx(80, 24, true);

    await setupPromptHistory(active);
    await typeLiteral(active, "draft");
    await active.sendHexBytes(["10"]);
    await active.waitForPane((pane) => pane.includes("┃ zz-history"), READY_TIMEOUT);
    await active.sendHexBytes(["0e"]);
    await active.waitForPane((pane) => pane.includes("draft"), READY_TIMEOUT);
    await active.sendKeys("C-u");

    await typeLiteral(active, "abcd");
    await active.sendHexBytes(["02"]);
    await active.sendHexBytes(["02"]);
    await active.sendHexBytes(["06"]);
    await typeLiteral(active, "X");
    await active.waitForPane((pane) => pane.includes("abcXd"), READY_TIMEOUT);

    await active.sendHexBytes(["04"]);
    await active.waitForPane((pane) => pane.includes("abcX"), READY_TIMEOUT);

    await active.sendKeys("C-u");
    await typeLiteral(active, "alpha beta");
    await active.sendKeys("C-a");
    await active.sendHexBytes(hexSeq("\x1bd"));
    await active.waitForPane((pane) => pane.includes("beta"), READY_TIMEOUT);

    await active.sendKeys("C-u");
    await typeLiteral(active, "one\\");
    await active.sendKeys("Enter");
    await typeLiteral(active, "two");
    await active.waitForPane((pane) => pane.includes("one") && pane.includes("two"), READY_TIMEOUT);

    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "Ctrl+W edit of recalled history preserves the unsent draft",
  async () => {
    const active = await startFx(60, 24, true);
    await setupPromptHistory(active);
    await typeLiteral(active, "draft");
    await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);

    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForPane((pane) => pane.includes("┃ zz-history"), READY_TIMEOUT);
    await active.sendHexBytes(["17"]);
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);

    await active.sendKeys("Down");
    await waitForActiveFooter(active, (footer) => footer === "┃ draft");
    await active.waitForCursor(
      (position) => position.col === 2 + "draft".length,
      READY_TIMEOUT,
    );
    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "Ctrl+L redraws without clearing the draft or session",
  async () => {
    const active = await startFx(80, 24, true, true, 2);
    await setupPromptHistory(active);
    const draft = "CTRL_L_UNSENT_DRAFT";
    await typeLiteral(active, draft);
    await waitForActiveFooter(active, (footer) => footer === `┃ ${draft}`);

    const fullFooter = "Full detail · ctrl o close";
    const response = "history prompt complete";
    const openRetainedTranscript = async () => {
      await active.sendKeys("C-o");
      const pane = await active.waitForPane(
        (pane) => pane.includes(fullFooter) && pane.includes(response),
        READY_TIMEOUT,
      );
      expect(pane).toContain("zz-history");
      expect(pane.split(response)).toHaveLength(2);
    };
    const expectClearedInline = async () => {
      const footer = await waitForActiveFooter(
        active,
        (visible) => visible === `┃ ${draft}`,
      );
      expect(footer).toBe(`┃ ${draft}`);
      await active.waitForPane(
        (pane) => !pane.includes(fullFooter) && !pane.includes(response) &&
          !pane.includes("zz-history"),
        READY_TIMEOUT,
      );
      const scrollback = stripAnsi(await active.captureFullScrollbackEscapes());
      expect(scrollback).toContain(draft);
      expect(scrollback).not.toContain(fullFooter);
      expect(scrollback).not.toContain(response);
      expect(scrollback).not.toContain("zz-history");
    };

    // Establish that the viewer has the response before clearing the display.
    await openRetainedTranscript();
    await active.sendKeys("C-o");
    await waitForActiveFooter(active, (footer) => footer === `┃ ${draft}`);
    await active.waitForPane(
      (pane) => !pane.includes(fullFooter) && pane.includes(response),
      READY_TIMEOUT,
    );

    await active.sendKeys("C-l");
    await expectClearedInline();
    expect(readFileSync(join(testHome!, "trace.log"), "utf8")).toContain(
      "visual_epoch_reset_requested trigger=ctrl_l",
    );

    await openRetainedTranscript();
    await active.sendKeys("C-o");
    await expectClearedInline();

    await active.resizeWindow(72, 20, 300);
    await expectClearedInline();
    await openRetainedTranscript();
    await active.sendKeys("C-o");
    await expectClearedInline();
    expect(codex?.requests).toHaveLength(1);

    await active.sendKeys("Enter");
    await active.waitForPane(
      (pane) => codex?.requests.length === 2 && pane.includes(response),
      READY_TIMEOUT,
    );
    await active.waitForStableComposer(READY_TIMEOUT);
    const scrollback = stripAnsi(await active.captureFullScrollbackEscapes());
    expect(scrollback.split(response)).toHaveLength(2);
    expect(scrollback).not.toContain("zz-history");
    const followup = codex!.requests[1]!.body;
    expect(followup).toContain("zz-history");
    expect(followup).toContain("history prompt complete");
    expect(followup).toContain(draft);
    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "delivered Command and Shift+Option keys edit the composer",
  async () => {
    const active = await startFx(60, 24);
    await typeLiteral(active, "alpha beta");

    await active.sendHexBytes(hexSeq("\x1b[1;9D"));
    await typeLiteral(active, "(");
    await active.sendHexBytes(hexSeq("\x1b[1;9C"));
    await typeLiteral(active, ")");
    await waitForActiveFooter(active, (footer) => footer === "┃ (alpha beta)");

    await active.sendHexBytes(hexSeq("\x1b[1;4D"));
    await typeLiteral(active, "X");
    await waitForActiveFooter(active, (footer) => footer === "┃ (alpha X");

    await active.sendHexBytes(hexSeq("\x1b[97;9u"));
    await typeLiteral(active, "Y");
    await waitForActiveFooter(active, (footer) => footer === "┃ Y");
    await active.sendHexBytes(hexSeq("\x1b[122;9u"));
    await waitForActiveFooter(active, (footer) => footer === "┃ (alpha X");
    await active.sendHexBytes(hexSeq("\x1b[122;10u"));
    await waitForActiveFooter(active, (footer) => footer === "┃ Y");
    await typeLiteral(active, "Z");
    await active.sendHexBytes(hexSeq("\x1b[95;5u"));
    await waitForActiveFooter(active, (footer) => footer === "┃ Y");
    await typeLiteral(active, "Q");
    await active.sendHexBytes(hexSeq("\x1b[27;5;95~"));
    await waitForActiveFooter(active, (footer) => footer === "┃ Y");

    expect(active.isAlive()).toBe(true);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "draft-edge movement resets preferred-column intent",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "abcdefghijklmnop");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "xy");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "abcdefghijklmnop");
    await active.waitForPane((pane) => pane.includes("xy"), READY_TIMEOUT);

    const bottom = await active.waitForCursor((position) => position.col > 12, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === bottom.row - 1 && position.col < bottom.col, READY_TIMEOUT);
    await active.sendHexBytes(hexSeq("\x1b[1;9A"));
    await active.sendKeys("Left");
    await active.sendKeys("Down");
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);

    await active.sendHexBytes(hexSeq("\x1b[1;9B"));
    await active.sendKeys("Right");
    expect(active.isAlive()).toBe(true);
  },
  TIMEOUT,
);

tmuxTest(
  "no-op modified Down at input end resets preferred-column intent",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "abcdef");
    await active.sendKeys("M-Enter");
    await active.waitForCursor((position) => position.col === 2, READY_TIMEOUT);

    await active.sendKeys("Left");
    const topEnd = await active.waitForCursor((position) => position.col > 6, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === topEnd.row + 1 && position.col === 2,
      READY_TIMEOUT,
    );

    await active.sendHexBytes(hexSeq("\x1b[1;2B"));
    await active.sendKeys("Up");
    await active.waitForCursor(
      (position) => position.row === topEnd.row && position.col === 2,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "resize between consecutive vertical moves resets preferred-column intent",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "abcdefghijklmnop");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "xy");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "abcdefghijklmnop");
    await active.waitForPane((pane) => pane.includes("xy"), READY_TIMEOUT);
    const bottom = await active.waitForCursor((position) => position.col > 12, READY_TIMEOUT);

    await active.sendKeys("Up");
    const short = await active.waitForCursor((position) => position.row === bottom.row - 1, READY_TIMEOUT);
    await active.resizeWindow(72, 24, 300);
    await active.waitForPane((pane) => pane.includes("xy"), READY_TIMEOUT);
    const resizedShort = await active.waitForCursor(
      (position) => position.col === short.col,
      READY_TIMEOUT,
    );
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === resizedShort.row + 1,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "long capped input keeps the cursor-containing rows visible",
  async () => {
    const active = await startFx(40, 12);
    const text = Array.from({ length: 20 }, (_, idx) =>
      `line-${String(idx + 1).padStart(2, "0")}`
    ).join("\n");
    await active.pasteText(text);
    await active.waitForPane(
      (pane) => pane.includes("line-20") && pane.includes("line-19"),
      READY_TIMEOUT,
    );
    await active.sendKeys("Up");
    await active.waitForPane(
      (pane) => pane.includes("line-19") && pane.includes("line-18"),
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);

tmuxTest(
  "repeated image-path paste cannot grow direct input past the cap and leaves fx alive",
  async () => {
    const active = await startFx(120, 24);
    await active.pasteText(repeatedImagePaste(80));
    await active.waitForPane((pane) => pane.includes("[Image 1]"), READY_TIMEOUT);
    expect(active.isAlive()).toBe(true);
  },
  TIMEOUT,
);

tmuxTest(
  "unknown and overflowing image placeholders stay literal and vertically targetable",
  async () => {
    const active = await startFx(60, 24);
    await typeLiteral(active, "[Image #999999999999999999999999999999999999]");
    await active.sendKeys("M-Enter");
    await typeLiteral(active, "tail");
    await active.waitForPane(
      (pane) => pane.includes("[Image #999999999999999999999999999999999999]") &&
        pane.includes("tail"),
      READY_TIMEOUT,
    );
    const bottom = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === bottom.row - 1, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor((position) => position.row === bottom.row, READY_TIMEOUT);
  },
  TIMEOUT,
);

tmuxTest(
  "top-level slash and /mo completion rows stay left anchored",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "/");
    await expectOptionColumn(active, "/help", 2);
    await active.sendKeys("C-u");
    await typeLiteral(active, "/mo");
    await expectOptionColumn(active, "/model", 2);
  },
  TIMEOUT,
);

tmuxTest(
  "permission argument picker uses exact rendered columns",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "  /permissions ");
    await expectOptionColumn(active, "ask", 17);
  },
  TIMEOUT,
);

tmuxTest(
  "current composer and submitted prompt use connected rails",
  async () => {
    testHome = mkdtempSync(join(tmpdir(), "fiber-tui-current-rails-"));
    mkdirSync(join(testHome, ".fiber"), { recursive: true });
    writeSeededChatGptLogin(testHome, chatGptAccessToken());
    const localCodex = startLocalCodex(testHome, ["CURRENT_RAIL_MOCK_OK"]);
    const active = await TmuxSession.create({
      cmd: FIBER_BIN,
      env: localCodex.env(),
      width: 80,
      height: 24,
    });
    session = active;
    await active.waitForComposer(READY_TIMEOUT);

    const lines = Array.from(
      { length: 10 },
      (_, index) => `COMPOSER_RAIL_${String(index + 1).padStart(2, "0")}`,
    );
    for (const [index, line] of lines.entries()) {
      if (index > 0) await active.sendKeys("M-Enter");
      await typeLiteral(active, line);
    }
    await active.waitForPane((pane) => pane.includes(lines.at(-1)!), READY_TIMEOUT);
    const composerRows = await active.capturePaneEscapes();
    for (const line of lines) {
      const row = rowWithVisiblePredicate(
        composerRows,
        (visible) => visible.includes(`┃ ${line}`),
      );
      expect(rowHasBackgroundSgr(row)).toBe(false);
      expect(row).toContain(`\x1b[38;5;255m┃\x1b[39m ${line}`);
    }

    const submission = lines.join("\n");
    await active.sendKeys("Enter");
    await active.waitForPane(
      (pane) => pane.includes("CURRENT_RAIL_MOCK_OK") && pane.includes("┃"),
      20_000,
    );
    expect(localCodex.requests.length).toBe(1);
    const request = JSON.parse(localCodex.requests[0]!.body).input as Array<{
      role?: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const user = request.findLast((message) => message.role === "user");
    expect(user?.content?.[0]).toEqual({ type: "input_text", text: submission });

    const transcript = await active.capturePaneEscapes();
    const first = rowWithVisiblePredicate(
      transcript,
      (visible) => visible.includes(`┃ ${lines[0]}`),
    );
    const last = rowWithVisiblePredicate(
      transcript,
      (visible) => visible.includes(lines.at(-1)!),
    );
    expect(rowHasBackgroundSgr(first)).toBe(false);
    expect(rowHasBackgroundSgr(last)).toBe(false);
    expect(first).toContain(`\x1b[38;5;255m┃\x1b[39m \x1b[1m${lines[0]}`);
    expect(stripAnsi(last).trimStart().startsWith("┃ ")).toBe(true);

    await active.sendText("/quit");
  },
  60_000,
);
tmuxTest(
  "wrapped slash prefix keeps current rail composer precedence and preserves selection",
  async () => {
    const active = await startFx(8, 10);
    await typeLiteral(active, "       /");
    const end = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    const moved = await active.waitForCursor((position) => position.row === end.row - 1, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor((position) => position.row === moved.row + 1, READY_TIMEOUT);

    await active.resizeWindow(80, 24, 300);
    await active.waitForPane((pane) => pane.includes("/help"), READY_TIMEOUT);
    await waitForSelectedSlashLabel(active, "/help", READY_TIMEOUT);
  },
  TIMEOUT,
);

tmuxTest(
  "wrapped slash picker does not consume selection-modified arrows",
  async () => {
    const active = await startFx(8, 10);
    await typeLiteral(active, "       /");
    const before = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendHexBytes(hexSeq("\x1b[1;2B"));
    await active.waitForCursor(
      (position) => position.row === before.row && position.col === before.col,
      READY_TIMEOUT,
    );

    await active.resizeWindow(80, 24, 300);
    await active.waitForPane((pane) => pane.includes("/help"), READY_TIMEOUT);
    await waitForSelectedSlashLabel(active, "/help", READY_TIMEOUT);
  },
  TIMEOUT,
);

tmuxTest(
  "wrapped slash prefix submits its visible selection",
  async () => {
    const active = await startFx(8, 10, true);
    await typeLiteral(active, "       /he");
    await active.waitForPane((pane) => pane.includes("/he"), READY_TIMEOUT);
    await active.sendKeys("Enter");
    await active.waitForPane(
      (pane) => hasEmptyComposer(pane) && pane.includes("Tab Ente"),
      READY_TIMEOUT,
    );
    await active.resizeWindow(80, 24, 300);
    await active.waitForText("Commands 21", READY_TIMEOUT);
    expect(codex?.requests).toHaveLength(0);
    expectCleanStderr();
  },
  TIMEOUT,
);

tmuxTest(
  "tiny pane keeps capped multiline slash picker visible and plain arrows navigate it",
  async () => {
    const active = await startFx(8, 6);
    await typeLiteral(active, "       /");
    await active.waitForPane((pane) => pane.includes("/help"), READY_TIMEOUT);
    const before = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === before.row && position.col === before.col,
      READY_TIMEOUT,
    );
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === before.row && position.col === before.col,
      READY_TIMEOUT,
    );
    const selected = await waitForSelectedSlashLabel(active, "/res…", READY_TIMEOUT);
    expect(stripAnsi(selected)).toContain("…");
  },
  TIMEOUT,
);

tmuxTest(
  "resize preserves slash routing and wrapped-composer arrow precedence",
  async () => {
    const active = await startFx(80, 24);
    await typeLiteral(active, "       /");
    await active.waitForPane((pane) => pane.includes("/help"), READY_TIMEOUT);
    const visibleCursor = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === visibleCursor.row && position.col === visibleCursor.col,
      READY_TIMEOUT,
    );
    await waitForSelectedSlashLabel(active, "/new", READY_TIMEOUT);

    await active.resizeWindow(8, 10, 300);
    const wrapped = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Up");
    await active.waitForCursor((position) => position.row === wrapped.row - 1, READY_TIMEOUT);

    await active.resizeWindow(80, 24, 300);
    await waitForSelectedSlashLabel(active, "/new", READY_TIMEOUT);
    const visibleAgain = await active.waitForCursor((position) => position.col > 2, READY_TIMEOUT);
    await active.sendKeys("Down");
    await active.waitForCursor(
      (position) => position.row === visibleAgain.row && position.col === visibleAgain.col,
      READY_TIMEOUT,
    );
  },
  TIMEOUT,
);
