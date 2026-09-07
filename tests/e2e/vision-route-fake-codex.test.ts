import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, REPO_ROOT, runFx } from "../evals/eval-helpers";
import {
  codexFinalText,
  codexInputItems,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  hasEmptyComposer,
  seededFakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const IMAGE_PATH = join(REPO_ROOT, "tests/e2e/fixtures/placeholder-logo.png");

// Deletion ledger for cases removed with this migration. Evidence:
//
// The Vercel AI Gateway provider bundle (the only source of
// `vision_fallback = true`) was deleted when the runtime became Codex-only
// (commit a198a07c, "Make the runtime Codex-only"). The Codex provider bundle
// ships `capabilities.vision_fallback = false` (src/builtins/providers.zig),
// so the vision tool is never advertised in a Codex turn and the Gemini vision
// provider is unreachable. Probed against zig-out/bin/fiber:
//
// - Text-only model + attached image -> `SubscriptionNativeImageUnavailable`
//   before any provider request (CLI and TUI); the Vision fallback route no
//   longer exists.
// - Image-capable model (`input_modalities` with "image") -> native
//   `input_image` parts in the Codex request; an unadvertised model-initiated
//   `vision` call is rejected with `tool_execution_failed` /
//   "Vision is unavailable for this request." without execution.
//
// Deleted cases and their evidence:
//
// - "fiber ask gates GLM images through Vision without leaking paths",
//   "fiber ask uses Kimi native vision without Vision tool",
//   "text-only non-native ask resolves capability and exposes Vision",
//   "text-only Kimi ask resolves capability and hides Vision": multi-provider
//   catalog routing (GLM/Gemini/Kimi model ids and vision tags) was part of
//   the deleted gateway provider set (a198a07c). The retained native-parts and
//   never-advertised-vision invariants are pinned by the migrated cases below.
// - "fiber ask recovers when the model rejects the post-Vision prompt as
//   assistant prefill": gateway HTTP prefill rejection has no Codex Responses
//   equivalent (same rationale as the classifier/SSE-wire deletions in
//   tui-gateway-stream-lifecycle).
// - "fiber ask executes path-source Vision and cleans transient snapshots",
//   "source replacement deletion and symlink retarget do not change captured
//   Vision bytes", "required Vision rejects read_file and remains required",
//   "fiber ask applies image_adapter_output_bytes to Vision provider capture":
//   the vision tool is never advertised, so required/optional Vision rounds,
//   path-source capture, and provider capture limits are unreachable.
// - "Vision outage is an ordinary failed tool result with the exact notice":
//   the outage tip came from vision provider execution; unreachable.
// - "cold resume rebases image ids and preserves authority across both
//   model-switch directions", "legacy zero image ids repair through durable
//   resume and remain readable after model switch": cross-model vision routing
//   is gone; legacy repair also depended on schema-v2 sessions, and only
//   schema-v3 sessions are readable now (src/core/session/session_discovery.zig).
// - "missing or corrupted owned snapshots fail without a Vision provider
//   request": the `image_unavailable` vision-tool result is unreachable. The
//   observed Codex-native replacement silently omits a corrupt snapshot from
//   the resumed request (no request, exit 0, no tool calls); pinning that
//   silence is a product question, not a mechanical migration.
// - "empty successful Vision provider output is invalid", "malformed Vision
//   provider output retries once", "one malformed Vision provider response is
//   retried and recovers the same image", "one-of-two provider omission
//   preserves evidence without retrying the batch", "one corrupt image does
//   not block its healthy sibling from Vision", "one corrupt first-batch image
//   keeps twenty-image provider batches at seven eight four", "twenty
//   text-only images use sequential Vision provider batches of eight eight and
//   four": vision provider response validation and batching; unreachable.
// - "tmux path-source Vision approval names the canonical image", "tmux
//   path-source Vision accepts hard-linked regular images", "tmux path-source
//   Vision executes the canonical target approved by the user", "tmux
//   path-source Vision rejects regular-file replacement of the approved
//   canonical target", "tmux path-source Vision rejects symlink replacement of
//   the approved canonical target", "tmux path-source Vision rejects FIFO
//   replacement of the approved canonical target", "tmux path-source Vision
//   returns directory failures to the model", "tmux path-source Vision returns
//   FIFO failures without waiting for a peer", "tmux path-source Vision
//   returns Unix socket failures to the model": vision-paths authority flow
//   requires the advertised vision tool; unreachable.
// - "tmux preserves typed permission feedback across a text-only Vision step",
//   "tmux shows ordinary Vision approval activity failure and exact outage
//   tip": driven by the removed `/image` slash command (Slice 16, ca8b34a3)
//   plus the unreachable vision provider.

type CodexQueue = ReturnType<typeof startFakeCodex>;

// The shared fake-codex models template advertises text-only models, so image
// cases point FIBER_E2E_OPENAI_CODEX_MODELS_URL at a catalog with an image
// input modality (same pattern as cli.test.ts's Codex models server).
function startImageModalityCatalog(): { modelsUrl: string; modelRequests: number; stop(): void } {
  let modelRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/models") {
        modelRequests += 1;
        return Response.json({
          models: [
            {
              slug: FAKE_CODEX_DEFAULT_MODEL,
              visibility: "list",
              supported_in_api: true,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
              additional_speed_tiers: [],
              input_modalities: ["text", "image"],
              context_window: 272000,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    get modelRequests() {
      return modelRequests;
    },
    stop() {
      server.stop(true);
    },
  };
}

type ImageCodex = {
  codex: CodexQueue;
  env: (
    home: string,
    extra?: Record<string, string | undefined>,
  ) => Record<string, string | undefined>;
  stop(): void;
};

// Fake Codex whose catalog advertises an image-capable model: attached images
// route natively as `input_image` parts.
function startImageCodex(route?: (body: string) => string): ImageCodex {
  const codex = startFakeCodex(route ? { route } : {});
  const catalog = startImageModalityCatalog();
  return {
    codex,
    env(home, extra = {}) {
      return seededFakeCodexEnv(home, codex, {
        FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
        FIBER_E2E_OPENAI_CODEX_MODELS_URL: catalog.modelsUrl,
        ...extra,
      });
    },
    stop() {
      codex.stop();
      catalog.stop();
    },
  };
}

function createIsolatedRoot(settings: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-vision-route-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".fiber", "settings.json"), JSON.stringify({ permission: {}, ...settings }));
  return { root, home, workspace: realpathSync(workspace) };
}

function createScopedImageFixture(root: ReturnType<typeof createIsolatedRoot>) {
  const nested = join(root.workspace, "assets", "nested");
  const sibling = join(root.workspace, "sibling");
  mkdirSync(nested, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const imagePath = join(nested, "fixture.png");
  copyFileSync(IMAGE_PATH, imagePath);

  const rootRule = "IMAGE_CONTEXT_ROOT_SENTINEL";
  const nestedRule = "IMAGE_CONTEXT_NESTED_SENTINEL";
  const siblingRule = "IMAGE_CONTEXT_SIBLING_MUST_BE_ABSENT";
  writeFileSync(join(root.workspace, "AGENTS.md"), `${rootRule}\n`);
  writeFileSync(join(nested, "AGENTS.md"), `${nestedRule}\n`);
  writeFileSync(join(sibling, "AGENTS.md"), `${siblingRule}\n`);
  return { imagePath, rootRule, nestedRule, siblingRule };
}

function writeMarkedImage(imagePath: string, marker: string) {
  copyFileSync(IMAGE_PATH, imagePath);
  writeFileSync(
    imagePath,
    Buffer.concat([readFileSync(imagePath), Buffer.from(marker)]),
  );
  return readFileSync(imagePath).toString("base64");
}

function expectScopedImageContext(
  body: string,
  fixture: ReturnType<typeof createScopedImageFixture>,
) {
  expect(body).toContain(fixture.rootRule);
  expect(body).toContain(fixture.nestedRule);
  expect(body).not.toContain(fixture.siblingRule);
  expect(body.indexOf(fixture.rootRule)).toBeLessThan(body.indexOf(fixture.nestedRule));
}

// fiber ask --json wraps success payloads in {ok, kind, data}: unwrap it.
function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout.trim()) as { data: unknown }).data as {
    output: string;
    exit_code: number;
    model: string;
    session_id: string;
    tool_calls: Array<{ name: string; status: string }>;
  };
}

// Terminal attach failures answer {ok:false, kind:"ask", error} at the top
// level; request-time capability failures answer {ok:true, ..., data.error}.
function parseAskFailureJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(1);
  const parsed = JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    kind: string;
    error?: string;
    data?: { error?: string; exit_code?: number };
  };
  return parsed;
}

function inputImageParts(body: string) {
  return codexInputItems(body).flatMap((item) =>
    Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>).filter(
          (part) => part.type === "input_image" && typeof part.image_url === "string",
        )
      : [],
  );
}

function advertisedToolNames(body: string): string[] {
  return (JSON.parse(body).tools ?? []).map((tool: { name?: string }) => tool.name);
}

function lastUserText(body: string): string {
  const users = codexInputItems(body).filter((item) => item.role === "user");
  expect(users.length).toBeGreaterThan(0);
  const last = users[users.length - 1]!;
  return (Array.isArray(last.content) ? (last.content as Array<Record<string, unknown>>) : [])
    .map((part) => (part.type === "input_text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function codexToolOutput(body: string, callId: string): string {
  const item = codexInputItems(body).find(
    (entry) => entry.type === "function_call_output" && entry.call_id === callId,
  );
  expect(item).toBeDefined();
  expect(typeof item!.output).toBe("string");
  return item!.output as string;
}

describe("Vision route fake Codex", () => {
  test(
    "fiber ask rejects missing images before any provider request in text and JSON modes",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({ route: () => codexFinalText("unexpected") });
      const missingPath = join(root.workspace, "missing-image.png");
      try {
        const textResult = await runFx(
          ["ask", "--no-save", "--image", missingPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            timeoutMs: TIMEOUT,
          },
        );
        expect(textResult.code).toBe(1);
        expect(textResult.stdout).toBe("");
        expect(textResult.stderr).toContain(missingPath);
        expect(textResult.stderr).toContain("image file not found");

        const jsonResult = await runFx(
          ["ask", "--json", "--no-save", "--image", missingPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            timeoutMs: TIMEOUT,
          },
        );
        const json = parseAskFailureJson(jsonResult);
        expect(json.ok).toBe(false);
        expect(json.error).toContain("FileNotFound");
        expect(json.error).toContain(missingPath);
        expect(jsonResult.stderr).toBe("");
        expect(codex.requests).toHaveLength(0);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "oversized images are rejected once before any provider request and the TUI stays alive",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({ route: () => codexFinalText("unexpected") });
      const oversizedPath = join(root.workspace, "oversized.png");
      writeFileSync(oversizedPath, Buffer.from("\x89PNG\r\n\x1a\n"));
      truncateSync(oversizedPath, 20 * 1024 * 1024 + 1);
      const notice = "image exceeds the 20 MiB limit";
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");
      let session: TmuxSession | null = null;
      try {
        const cliResult = await runFx(
          ["ask", "--no-save", "--image", oversizedPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            timeoutMs: TIMEOUT,
          },
        );
        expect(cliResult.code).toBe(1);
        expect(cliResult.stdout).toBe("");
        expect(cliResult.stderr).toContain(notice);
        expect(cliResult.stderr.split(notice)).toHaveLength(2);
        expect(codex.requests).toHaveLength(0);

        session = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: root.workspace,
          env: {
            ...seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            NO_COLOR: "1",
          },
          stderrPath,
          width: 120,
          height: 40,
        });
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendLiteral("@oversized.png");
        await session.sendKeys("Tab");
        await session.sendKeys("Enter");
        await session.waitForText(notice, TIMEOUT);
        const scrollback = await session.captureFullScrollback();
        expect(scrollback.split(notice)).toHaveLength(2);
        expect(scrollback).not.toContain("attached image: oversized.png");
        expect(codex.requests).toHaveLength(0);
        expect(readFileSync(stderrPath, "utf8")).toBe("");

        // The rejected path text stays in the composer; clear it before quitting.
        session.sendRepeatedKeyThenImmediate("BSpace", 20, "BSpace");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        await session.sendText("/quit");
        expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
        session = null;
      } finally {
        if (session) await session.kill();
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "fiber ask preserves native image parts for the image-capable model without leaking paths",
    async () => {
      const root = createIsolatedRoot();
      const fixture = createScopedImageFixture(root);
      const imageCodex = startImageCodex(() => codexFinalText("Native native image answer"));
      try {
        const result = await runFx(
          [
            "ask",
            "--json",
            "--no-save",
            "--image",
            fixture.imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseFxJson(result);
        expect(json.exit_code).toBe(0);
        expect(json.output).toContain("Native native image answer");
        expect(json.tool_calls).toHaveLength(0);
        expect(imageCodex.codex.requests).toHaveLength(1);
        const body = imageCodex.codex.requests[0].body;
        expect(advertisedToolNames(body)).not.toContain("vision");
        expect(inputImageParts(body).length).toBe(1);
        expect(body).toContain(readFileSync(fixture.imagePath).toString("base64"));
        expectScopedImageContext(body, fixture);
        expect(body).not.toContain(fixture.imagePath);
        expect(lastUserText(body)).not.toContain(root.home);
        expect(lastUserText(body)).not.toContain(root.workspace);
      } finally {
        imageCodex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask normalizes encoded-oversized native images on macOS and rejects elsewhere",
    async () => {
      const root = createIsolatedRoot();
      const imageCodex = startImageCodex(() => codexFinalText("Normalized native image answer"));
      const oversizedPath = join(root.workspace, "encoded-oversized.png");
      copyFileSync(IMAGE_PATH, oversizedPath);
      truncateSync(oversizedPath, (5 * 1024 * 1024 * 3) / 4 + 1);
      const notice = "Unable to prepare this image for upload. Use a smaller image.";
      try {
        if (process.platform === "darwin") {
          const result = await runFx(
            [
              "ask",
              "--json",
              "--no-save",
              "--image",
              oversizedPath,
              "Describe the attached image.",
            ],
            {
              cwd: root.workspace,
              env: imageCodex.env(root.home),
              timeoutMs: TIMEOUT,
            },
          );

          const json = parseFxJson(result);
          expect(json.output).toContain("Normalized native image answer");
          expect(json.tool_calls).toHaveLength(0);
          expect(result.stderr).toBe("");
          expect(imageCodex.codex.requests).toHaveLength(1);
          const parts = inputImageParts(imageCodex.codex.requests[0].body);
          expect(parts).toHaveLength(1);
          const url = parts[0]!.image_url as string;
          expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
          expect(url.length).toBeLessThanOrEqual(5 * 1024 * 1024);
          return;
        }

        const textResult = await runFx(
          ["ask", "--no-save", "--image", oversizedPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );
        expect(textResult.code).toBe(1);
        expect(textResult.stdout).toBe("");
        expect(textResult.stderr).toContain(notice);

        const jsonResult = await runFx(
          ["ask", "--json", "--no-save", "--image", oversizedPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );
        const errorJson = parseAskFailureJson(jsonResult);
        expect(errorJson.error).toBe("ImagePreparationFailed");
        expect(jsonResult.stderr).toBe("");
        expect(imageCodex.codex.requests).toHaveLength(0);
      } finally {
        imageCodex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "unadvertised native Vision rejection recovers and is filtered after resume",
    async () => {
      const root = createIsolatedRoot();
      const fixture = createScopedImageFixture(root);
      let requestCount = 0;
      const imageCodex = startImageCodex(() => {
        requestCount += 1;
        if (requestCount === 1) {
          return codexToolCall("native_vision", "vision", { image_ids: [1], focus: "inspect" });
        }
        if (requestCount === 2) {
          return codexFinalText("recovered after rejected Vision");
        }
        return codexFinalText("continued without historical Vision evidence");
      });
      try {
        const first = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--image",
            fixture.imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );

        const firstJson = parseFxJson(first);
        expect(firstJson.session_id.length).toBeGreaterThan(0);
        expect(firstJson.output).toContain("recovered after rejected Vision");
        expect(firstJson.tool_calls).toContainEqual({ name: "vision", status: "error" });
        expect(imageCodex.codex.requests).toHaveLength(2);
        const rejectionRequest = imageCodex.codex.requests[1];
        const rejectionItems = codexInputItems(rejectionRequest.body);
        expect(rejectionItems).toContainEqual(
          expect.objectContaining({
            type: "function_call",
            call_id: "native_vision",
            name: "vision",
          }),
        );
        const rejectionOutput = JSON.parse(
          codexToolOutput(rejectionRequest.body, "native_vision"),
        );
        expect(rejectionOutput).toMatchObject({
          error: {
            type: "tool_execution_failed",
            tool_name: "vision",
            message: "Vision is unavailable for this request.",
          },
        });
        // The native image is sent with the initial user message only; the
        // follow-up request carries the rejection pair without re-sending it.
        expect(inputImageParts(rejectionRequest.body)).toHaveLength(0);

        const secondImagePath = join(root.workspace, "second.png");
        copyFileSync(IMAGE_PATH, secondImagePath);
        const resumed = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--resume-id",
            firstJson.session_id,
            "--image",
            secondImagePath,
            "Continue with the saved native image context.",
          ],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );
        const resumedJson = parseFxJson(resumed);
        expect(resumedJson.session_id).toBe(firstJson.session_id);
        expect(resumedJson.output).toContain("continued without historical Vision evidence");
        expect(resumedJson.tool_calls).toHaveLength(0);

        expect(imageCodex.codex.requests).toHaveLength(3);
        const resumedRequest = imageCodex.codex.requests[2];
        expect(inputImageParts(resumedRequest.body)).toHaveLength(1);
        const resumedBody = resumedRequest.body;
        expect(resumedBody).not.toContain("native_vision");
        expect(resumedBody).not.toContain("Vision is unavailable for this request.");
        for (const request of imageCodex.codex.requests) {
          expect(request.body).not.toContain(fixture.imagePath);
        }
        const resumedUserText = lastUserText(resumedRequest.body);
        expect(resumedUserText).not.toContain(fixture.imagePath);
        expect(resumedUserText).not.toContain(root.home);
        expect(resumedUserText).not.toContain(root.workspace);

        const detail = await runFx(
          ["session", "show", "--id", firstJson.session_id, "--json"],
          {
            cwd: root.workspace,
            env: imageCodex.env(root.home),
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).toBe(0);
        expect(detail.stderr).toBe("");
        const persisted = JSON.stringify(JSON.parse(detail.stdout));
        expect(persisted).toContain("native_vision");
        expect(persisted).toContain("Vision is unavailable for this request.");
        expect(imageCodex.codex.requests).toHaveLength(3);
      } finally {
        imageCodex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "catalog failure hides image support and rejects unresolved image input",
    async () => {
      const textRoot = createIsolatedRoot();
      const textCodex = startFakeCodex({ route: () => codexFinalText("text answer without Vision") });
      const textCatalog = startImageModalityCatalogWithStatus(503);
      try {
        const textResult = await runFx(
          ["ask", "--json", "--no-save", "Reply exactly OK."],
          {
            cwd: textRoot.workspace,
            env: seededFakeCodexEnv(textRoot.home, textCodex, {
              FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
              FIBER_E2E_OPENAI_CODEX_MODELS_URL: textCatalog.modelsUrl,
            }),
            timeoutMs: TIMEOUT,
          },
        );
        const textJson = parseFxJson(textResult);
        expect(textJson.exit_code).toBe(0);
        expect(textJson.output).toContain("text answer without Vision");
        // Image-free turns never resolve model capabilities, so no catalog fetch.
        expect(textCatalog.modelRequests).toBe(0);
        expect(textCodex.requests).toHaveLength(1);
        expect(advertisedToolNames(textCodex.requests[0].body)).not.toContain("vision");
      } finally {
        textCodex.stop();
        textCatalog.stop();
        rmSync(textRoot.root, { recursive: true, force: true });
      }

      const imageRoot = createIsolatedRoot();
      const imageCodex = startFakeCodex({ route: () => codexFinalText("unexpected") });
      const imageCatalog = startImageModalityCatalogWithStatus(503);
      const fixture = createScopedImageFixture(imageRoot);
      try {
        const imageResult = await runFx(
          [
            "ask",
            "--json",
            "--no-save",
            "--image",
            fixture.imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: imageRoot.workspace,
            env: seededFakeCodexEnv(imageRoot.home, imageCodex, {
              FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
              FIBER_E2E_OPENAI_CODEX_MODELS_URL: imageCatalog.modelsUrl,
            }),
            timeoutMs: TIMEOUT,
          },
        );
        expect(imageResult.code).toBe(1);
        const imageJson = parseAskFailureJson(imageResult);
        expect(imageJson.ok).toBe(true);
        expect(imageJson.data?.error).toContain("ModelImageCapabilityUnavailable");
        expect(imageCatalog.modelRequests).toBe(1);
        expect(imageCodex.requests).toHaveLength(0);
      } finally {
        imageCodex.stop();
        imageCatalog.stop();
        rmSync(imageRoot.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "catalog failure explains unresolved image capability in text mode",
    async () => {
      const root = createIsolatedRoot();
      const fixture = createScopedImageFixture(root);
      const codex = startFakeCodex({ route: () => codexFinalText("unexpected") });
      const catalog = startImageModalityCatalogWithStatus(503);
      try {
        const result = await runFx(
          [
            "ask",
            "--no-save",
            "--image",
            fixture.imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex, {
              FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
              FIBER_E2E_OPENAI_CODEX_MODELS_URL: catalog.modelsUrl,
            }),
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "fiber ask: Unable to verify image support for this model, so the image was not sent. Try again later, choose another model, or remove the image.\n",
        );
        expect(result.stderr).not.toContain("ModelImageCapabilityUnavailable");
        expect(catalog.modelRequests).toBe(1);
        expect(codex.requests).toHaveLength(0);
      } finally {
        codex.stop();
        catalog.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "text-only model with an attached image fails before any provider request",
    async () => {
      const root = createIsolatedRoot();
      const fixture = createScopedImageFixture(root);
      const codex = startFakeCodex({ route: () => codexFinalText("unexpected") });
      try {
        const result = await runFx(
          [
            "ask",
            "--json",
            "--permission-mode", "auto",
            "--no-save",
            "--image",
            fixture.imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: root.workspace,
            env: seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(1);
        const json = parseAskFailureJson(result);
        expect(json.ok).toBe(true);
        expect(json.data?.error).toBe("SubscriptionNativeImageUnavailable");
        expect(codex.requests).toHaveLength(0);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "tmux @ home image path attaches and completes the native image flow",
    async () => {
      const root = createIsolatedRoot({ permission_mode: "ask" });
      const desktop = join(root.home, "Desktop");
      mkdirSync(desktop, { recursive: true });
      const imagePath = join(desktop, "test.png");
      const payload = writeMarkedImage(imagePath, "TMUX_AT_HOME_IMAGE");
      const imageCodex = startImageCodex(() => codexFinalText("@ home image flow complete"));
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");
      let session: TmuxSession | null = null;
      try {
        session = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: root.workspace,
          env: {
            ...imageCodex.env(root.home),
            NO_COLOR: "1",
          },
          stderrPath,
          width: 140,
          height: 50,
        });
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendLiteral("@~/Desktop/test.png");
        await session.waitForText("~/Desktop/test.png", TIMEOUT);
        await session.sendKeys("Tab");
        await session.sendLiteral(" look at this image");
        await session.sendKeys("Enter");

        await session.waitForText("@ home image flow complete", TIMEOUT);
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        expect(imageCodex.codex.requests).toHaveLength(1);
        const body = imageCodex.codex.requests[0].body;
        expect(advertisedToolNames(body)).not.toContain("vision");
        expect(inputImageParts(body).length).toBe(1);
        expect(body).toContain(payload);
        for (const request of imageCodex.codex.requests) {
          expect(request.body).not.toContain(imagePath);
          expect(request.body).not.toContain("~/Desktop/test.png");
        }
        expect(readFileSync(stderrPath, "utf8")).toBe("");

        await session.sendText("/quit");
        expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
        session = null;
      } finally {
        if (session) await session.kill();
        imageCodex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(!tmuxAvailable())(
    "tmux preserves unresolved image-looking paths as prompt text",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeCodex({ route: () => codexFinalText("unresolved path remained prompt text") });
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");
      let session: TmuxSession | null = null;
      try {
        session = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: root.workspace,
          env: {
            ...seededFakeCodexEnv(root.home, codex, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL }),
            NO_COLOR: "1",
          },
          stderrPath,
          width: 140,
          height: 50,
        });
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        const prompt = "Explain why ~other/test.png is not a supported home path.";
        await session.sendText(prompt);
        await session.waitForText("unresolved path remained prompt text", TIMEOUT);
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        expect(codex.requests).toHaveLength(1);
        expect(lastUserText(codex.requests[0].body)).toBe(prompt);
        expect(inputImageParts(codex.requests[0].body)).toHaveLength(0);
        expect(readFileSync(stderrPath, "utf8")).toBe("");

        await session.sendText("/quit");
        expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
        session = null;
      } finally {
        if (session) await session.kill();
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function codexToolShape(callId: string, name: string, args: object): string {
  return `data: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: callId, name },
  })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: JSON.stringify(args),
    })}\n\n` +
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
}

function startImageModalityCatalogWithStatus(status: number): { modelsUrl: string; modelRequests: number; stop(): void } {
  let modelRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/models") {
        modelRequests += 1;
        return new Response("catalog unavailable", { status });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    get modelRequests() {
      return modelRequests;
    },
    stop() {
      server.stop(true);
    },
  };
}
