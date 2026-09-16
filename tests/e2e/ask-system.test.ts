import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexFinalText,
  FAKE_CODEX_DEFAULT_MODEL,
  seededFakeCodexEnv,
  startFakeCodex,
} from "./tmux-helpers";

// Deterministic coverage for `fiber ask --system` (no credential, no live
// model): asserts what --system does to the outgoing provider request rather
// than what a model replies. Local runner on purpose: this file must not
// depend on tests/evals (being removed), so FIBER_BIN and the spawn helper
// live here instead of in eval-helpers.
const FIBER_BIN = resolve(import.meta.dirname, "../../zig-out/bin/fiber");
const TIMEOUT_MS = 30_000;

const BASE_PROMPT_MARKER = "You are fiber";
const OVERRIDE_SENTINEL = "ASK_SYSTEM_OVERRIDE_SENTINEL_7Q2X";
const PROJECT_SENTINEL = "ASK_SYSTEM_PROJECT_SENTINEL_7Q2X";
const SKILL_SENTINEL = "ASK_SYSTEM_SKILL_SENTINEL_7Q2X";
const SKILL_NAME = "ask-system-carve-skill";

type IsolatedRoot = { root: string; home: string; workspace: string };

function createIsolatedRoot(): IsolatedRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-ask-system-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".fiber", "settings.json"), "{}");
  return { root, home, workspace: realpathSync(workspace) };
}

async function runAsk(
  args: string[],
  root: IsolatedRoot,
  codex: ReturnType<typeof startFakeCodex>,
) {
  const proc = Bun.spawn([FIBER_BIN, ...args], {
    cwd: root.workspace,
    env: {
      ...process.env,
      ...seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
      NO_COLOR: "1",
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function requestInstructions(body: string): string {
  return (JSON.parse(body) as { instructions: string }).instructions;
}

function advertisedToolNames(body: string): string[] {
  return ((JSON.parse(body) as { tools?: Array<{ name?: string }> }).tools ?? []).map(
    (tool) => tool.name ?? "",
  );
}

describe("fiber ask --system", () => {
  test(
    "replaces the built-in base prompt with the override text",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({ route: () => codexFinalText("SYSTEM_OVERRIDE_DONE") });
      try {
        const result = await runAsk(
          [
            "ask",
            "--json",
            "--no-save",
            "--permission-mode",
            "auto",
            "--system",
            OVERRIDE_SENTINEL,
            "Reply exactly OK.",
          ],
          root,
          codex,
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const json = (JSON.parse(result.stdout.trim()) as { data: { output: string } }).data;
        expect(json.output).toContain("SYSTEM_OVERRIDE_DONE");
        expect(codex.requests).toHaveLength(1);
        const instructions = requestInstructions(codex.requests[0]!.body);
        expect(instructions).toContain(OVERRIDE_SENTINEL);
        expect(instructions).not.toContain(BASE_PROMPT_MARKER);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "sends the built-in base prompt without --system",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({ route: () => codexFinalText("BASE_PROMPT_DONE") });
      try {
        const result = await runAsk(
          ["ask", "--json", "--no-save", "--permission-mode", "auto", "Reply exactly OK."],
          root,
          codex,
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const json = (JSON.parse(result.stdout.trim()) as { data: { output: string } }).data;
        expect(json.output).toContain("BASE_PROMPT_DONE");
        expect(codex.requests).toHaveLength(1);
        expect(requestInstructions(codex.requests[0]!.body)).toContain(BASE_PROMPT_MARKER);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "carve-out holds: tool, skill, project, and runtime context still apply with --system",
    async () => {
      const root = createIsolatedRoot();
      writeFileSync(join(root.workspace, "AGENTS.md"), `${PROJECT_SENTINEL} line\n`);
      const skillDir = join(root.workspace, ".agents", "skills", SKILL_NAME);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${SKILL_NAME}\ndescription: carve-out probe skill\n---\n\n${SKILL_SENTINEL} body\n`,
      );
      const codex = startFakeCodex({ route: () => codexFinalText("CARVE_OUT_DONE") });
      try {
        const result = await runAsk(
          [
            "ask",
            "--json",
            "--no-save",
            "--permission-mode",
            "auto",
            "--system",
            OVERRIDE_SENTINEL,
            `$${SKILL_NAME} do the thing.`,
          ],
          root,
          codex,
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toContain("Loaded skill");
        const json = (JSON.parse(result.stdout.trim()) as { data: { output: string } }).data;
        expect(json.output).toContain("CARVE_OUT_DONE");
        expect(codex.requests).toHaveLength(1);
        const body = codex.requests[0]!.body;
        const instructions = requestInstructions(body);

        // The override still replaces only the built-in base prompt.
        expect(instructions).toContain(OVERRIDE_SENTINEL);
        expect(instructions).not.toContain(BASE_PROMPT_MARKER);

        // Project context survives.
        expect(instructions).toContain(PROJECT_SENTINEL);

        // Skill context survives: advertised catalog and loaded content.
        expect(instructions).toContain("<available_skills>");
        expect(instructions).toContain(SKILL_SENTINEL);
        expect(instructions).toContain(`<skill_content name="${SKILL_NAME}"`);

        // Runtime context survives: turn context carries the workspace root.
        expect(instructions).toContain("<fiber-turn-context>");
        expect(instructions).toContain(root.workspace);

        // Tool context survives: the model still receives the tool surface.
        expect(advertisedToolNames(body)).toContain("read_file");
        expect(advertisedToolNames(body).length).toBeGreaterThan(0);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
