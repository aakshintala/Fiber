import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexInputItems,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const EXPIRED_REFRESH_TOKEN = "expired-refresh-token";
const RETRY_REFRESH_TOKEN = "retry-refresh-token";

function writeChatGptLogin(
  home: string,
  refreshToken: string,
  expiresAtMs = Date.now() - 60_000,
): void {
  writeSeededChatGptLogin(home, chatGptAccessToken(), {
    refreshToken,
    expiresAtMs,
  });
}

function startFakeChatGptTokens(tokens: string[]) {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({ method: request.method, path: url.pathname, body });
      const accessToken = tokens.shift();
      if (!accessToken) return new Response("unexpected refresh", { status: 500 });
      return Response.json({
        access_token: chatGptAccessToken("acct_e2e", accessToken),
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });
    },
  });
  return {
    tokenUrl: `http://127.0.0.1:${server.port}/token`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function sessionIdsFromHome(home: string): string[] {
  return readdirSync(join(home, ".fiber", "sessions"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && entry.name !== "latest")
    .map((entry) => entry.name)
    .sort();
}

test(
  "fx ask refreshes an expired login then forces one refresh and retry after 401",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fx-auth-refresh-e2e-"));
    const tokens = startFakeChatGptTokens([EXPIRED_REFRESH_TOKEN, RETRY_REFRESH_TOKEN]);
    writeChatGptLogin(home, "seeded-refresh-token");
    const requests: string[] = [];
    let unauthorizedLeft = 1;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/models") {
          return Response.json({ models: [
            { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
          ] });
        }
        requests.push(await req.text());
        if (unauthorizedLeft > 0) {
          unauthorizedLeft -= 1;
          return Response.json({ error: { message: "expired" } }, { status: 401 });
        }
        return new Response(codexFinalText("REFRESHED_LOGIN_RESPONSE"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const result = await runFx(
        ["ask", "--json", "--no-save", "exercise the refreshed login"],
        {
          env: {
            ...fakeCodexEnv(home, {
              responsesUrl: `http://127.0.0.1:${server.port}/responses`,
              modelsUrl: `http://127.0.0.1:${server.port}/models`,
              tokenUrl: tokens.tokenUrl,
            } as ReturnType<typeof startFakeCodex>),
            FIBER_DISABLE_KEYCHAIN: "1",
          },
          timeoutMs: TIMEOUT,
        },
      );

      expect(
        result.code,
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);
      expect(JSON.parse(result.stdout).output).toContain("REFRESHED_LOGIN_RESPONSE");
      expect(requests).toHaveLength(2);
      expect(requests[0]).not.toContain("EXPIRED");
      expect(
        tokens.requests.map((request) => `${request.method} ${request.path}`),
      ).toEqual(["POST /token", "POST /token"]);
      const firstBody = JSON.parse(tokens.requests[0].body);
      const secondBody = JSON.parse(tokens.requests[1].body);
      expect(firstBody).toMatchObject({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "seeded-refresh-token",
      });
      expect(secondBody).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "rotated-refresh-token",
      });

      const persisted = JSON.parse(
        readFileSync(join(home, ".fiber", "chatgpt-auth.json"), "utf8"),
      );
      expect(persisted.refresh_token).toBe("rotated-refresh-token");
      expect(result.stdout).not.toContain(EXPIRED_REFRESH_TOKEN);
      expect(result.stdout).not.toContain(RETRY_REFRESH_TOKEN);
      expect(result.stderr).not.toContain(EXPIRED_REFRESH_TOKEN);
      expect(result.stderr).not.toContain(RETRY_REFRESH_TOKEN);
    } finally {
      server.stop(true);
      tokens.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "status and doctor report an expired login instead of refreshing it",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "fx-auth-expired-report-e2e-"));
    const tokens = startFakeChatGptTokens([EXPIRED_REFRESH_TOKEN]);
    writeChatGptLogin(home, "seeded-refresh-token");
    const authPath = join(home, ".fiber", "chatgpt-auth.json");
    const seededAuthFile = readFileSync(authPath, "utf8");
    const env = {
      HOME: home,
      AI_GATEWAY_API_KEY: undefined,
      VERCEL_OIDC_TOKEN: undefined,
      FIBER_DISABLE_KEYCHAIN: "1",
    };

    try {
      const status = await runFx(["status", "--json"], { env, timeoutMs: TIMEOUT });
      expect(
        status.code,
        `stdout: ${status.stdout}\nstderr: ${status.stderr}`,
      ).toBe(0);
      const statusJson = JSON.parse(status.stdout);
      expect(statusJson.auth).toBe("Codex subscription");
      expect(statusJson.auth_expired).toBe(true);
      expect(statusJson.auth_refreshable).toBe(true);

      const doctor = await runFx(["doctor", "--json"], { env, timeoutMs: TIMEOUT });
      expect(doctor.code).toBe(0);
      const doctorJson = JSON.parse(doctor.stdout);
      expect(doctorJson.auth).toBe("Codex subscription");
      expect(doctorJson.auth_expired).toBe(true);
      const authCheck = doctorJson.checks.find(
        (check: { name: string }) => check.name === "auth",
      );
      expect(authCheck.status).toBe("warn");
      expect(authCheck.detail).toContain("expired");

      // A read-only diagnostic must neither contact the issuer nor rewrite the session.
      expect(tokens.requests).toEqual([]);
      expect(readFileSync(authPath, "utf8")).toBe(seededAuthFile);
      expect(status.stdout).not.toContain("expired-access-token");
      expect(doctor.stdout).not.toContain("expired-access-token");
    } finally {
      tokens.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test(
  "codex 401 after refresh discards only the new empty session and preserves resume last",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fx-auth-empty-session-e2e-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    writeChatGptLogin(home, "seeded-refresh-token", Date.now() + 60 * 60 * 1000);
    const codex = startFakeCodex();
    let askCount = 0;
    const seedText = "SEED_SESSION_RESPONSE";
    const route = (body: string): string => {
      const items = codexInputItems(body);
      const lastUser = items.filter((item: any) => item.role === "user").at(-1);
      const lastText = (Array.isArray(lastUser?.content) ? lastUser.content : [])
        .map((part: any) => part.text ?? "")
        .join("");
      if (lastText.includes("Persist the seed session.")) {
        return codexFinalText(seedText);
      }
      return codexFinalText("RESUMED_SESSION_RESPONSE");
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/models") {
          return Response.json({ models: [
            { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
          ] });
        }
        if (path === "/token") {
          return Response.json({
            access_token: chatGptAccessToken("acct_e2e", "refreshed-token"),
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
          });
        }
        const body = await req.text();
        askCount += 1;
        codex.requests.push({ path, authorization: req.headers.get("authorization"), body });
        if (body.includes("Reject this new saved session.")) {
          return Response.json({ error: { message: "rejected" } }, { status: 401 });
        }
        return new Response(route(body), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const env = {
      ...fakeCodexEnv(home, {
        responsesUrl: `http://127.0.0.1:${server.port}/responses`,
        modelsUrl: `http://127.0.0.1:${server.port}/models`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
      } as ReturnType<typeof startFakeCodex>),
      FIBER_DISABLE_KEYCHAIN: "1",
    };

    try {
      const seed = await runFx(
        ["ask", "--json", "--auto", "Persist the seed session."],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(
        seed.code,
        `stdout: ${seed.stdout}\nstderr: ${seed.stderr}`,
      ).toBe(0);
      expect(seed.stderr).toBe("");
      const seedJson = JSON.parse(seed.stdout);
      expect(seedJson.output).toContain(seedText);
      expect(seedJson.session_id.length).toBeGreaterThan(0);
      const seedSessionId = seedJson.session_id as string;
      expect(sessionIdsFromHome(home)).toEqual([seedSessionId]);

      const rejected = await runFx(
        ["ask", "--json", "--auto", "Reject this new saved session."],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(rejected.code).toBe(1);
      const rejectedJson = JSON.parse(rejected.stdout);
      expect(rejectedJson).toMatchObject({
        exit_code: 1,
        session_id: "",
        steps: 0,
        tool_calls: [],
      });
      expect(rejectedJson.error).toBeUndefined();
      expect(sessionIdsFromHome(home)).toEqual([seedSessionId]);

      const sessionsResult = await runFx(
        ["sessions", "--json"],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(sessionsResult.code).toBe(0);
      expect(sessionsResult.stderr).toBe("");
      const sessions = JSON.parse(sessionsResult.stdout);
      expect(sessions.count).toBe(1);
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0].id).toBe(seedSessionId);
      expect(sessions.sessions[0].history_len).toBe(1);

      const resumed = await runFx(
        [
          "ask",
          "--json",
          "--auto",
          "--resume",
          "last",
          "Resume the seed session.",
        ],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(
        resumed.code,
        `stdout: ${resumed.stdout}\nstderr: ${resumed.stderr}`,
      ).toBe(0);
      expect(resumed.stderr).toBe("");
      const resumedJson = JSON.parse(resumed.stdout);
      expect(resumedJson.session_id).toBe(seedSessionId);
      expect(resumedJson.output).toContain("RESUMED_SESSION_RESPONSE");
      expect(sessionIdsFromHome(home)).toEqual([seedSessionId]);

      const detail = await runFx(
        ["session", "--id", seedSessionId, "--json"],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(detail.code).toBe(0);
      expect(detail.stderr).toBe("");
      expect(JSON.parse(detail.stdout).history_len).toBe(2);
    } finally {
      server.stop(true);
      codex.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
