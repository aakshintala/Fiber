import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FX_BIN } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  fakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const HAS_TMUX = tmuxAvailable();
if (process.env.FX_REQUIRE_TMUX === "1" && !HAS_TMUX) {
  throw new Error("tmux is required for tui-auth-source-selection.test.ts");
}

const tmuxTest = test.skipIf(!HAS_TMUX);
const TIMEOUT = 30_000;

// Single-line needles: the interactive transcript wraps long notice lines at
// the pane width, so assertions must not depend on full-sentence matches.
const MISSING_LOGIN_NOTICE = "● Auth: Codex needs a subscription login";
const MISSING_LOGIN_HELP = "auth_help=Codex needs a subscription login";

let home: string | null = null;
let stderrPath: string | null = null;
let session: TmuxSession | null = null;
let codex: ReturnType<typeof startFakeCodex> | null = null;
let issuer: ReturnType<typeof startFakeIssuer> | null = null;

afterEach(async () => {
  await session?.kill();
  session = null;
  codex?.stop();
  codex = null;
  issuer?.stop();
  issuer = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  stderrPath = null;
});

function authPath(testHome: string): string {
  return join(testHome, ".fx", "chatgpt-auth.json");
}

function startFx(
  testHome: string,
  testStderrPath: string,
  fakeCodex: ReturnType<typeof startFakeCodex>,
  extraEnv: Record<string, string | undefined> = {},
  width = 100,
): Promise<TmuxSession> {
  return TmuxSession.create({
    cmd: FX_BIN,
    env: {
      ...fakeCodexEnv(testHome, fakeCodex),
      FX_NO_OPEN_BROWSER: "1",
      FX_AUTO_UPGRADE: "0",
      ...extraEnv,
    },
    stderrPath: testStderrPath,
    width: 100,
    height: 30,
  });
}

function startFakeIssuer() {
  const authorizeRequests: Array<{ redirectUri: string; state: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri || !state) {
          return new Response("invalid authorize request", { status: 400 });
        }
        authorizeRequests.push({ redirectUri, state });
        const callback = new URL(redirectUri.replace("localhost", "127.0.0.1"));
        callback.searchParams.set("code", "codex-e2e-code");
        callback.searchParams.set("state", state);
        return Response.redirect(callback.toString(), 302);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    authorizeRequests,
    stop() {
      server.stop(true);
    },
  };
}

async function completeDisplayedCodexLogin(
  activeSession: TmuxSession,
  fixture: ReturnType<typeof startFakeIssuer>,
): Promise<void> {
  await activeSession.waitForText("Sign in with Codex", TIMEOUT);
  const escapes = await activeSession.capturePaneEscapes();
  // tmux capture -e normalizes OSC 8 hyperlinks to the bare \x1b]8;;url form.
  const prefix = `\x1b]8;;${fixture.baseUrl}/oauth/authorize?`;
  const urlStart = escapes.indexOf(prefix) + prefix.length;
  const urlEnd = escapes.indexOf("\x1b\\", urlStart);
  if (urlStart < prefix.length || urlEnd < 0) {
    throw new Error("Codex sign-in hyperlink was not rendered");
  }
  const authorizationUrl = `${fixture.baseUrl}/oauth/authorize?${escapes.slice(urlStart, urlEnd)}`;
  expect(authorizationUrl).toContain("response_type=code");
  expect(authorizationUrl).toContain("redirect_uri=");
  const response = await fetch(authorizationUrl, { redirect: "follow" });
  expect(response.status).toBe(200);
}

tmuxTest(
  "missing login reports missing auth and blocks prompts with recovery guidance",
  async () => {
    home = mkdtempSync(join(tmpdir(), "fx-tui-codex-missing-login-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    codex = startFakeCodex();

    session = await startFx(home, stderrPath, codex);
    await session.waitForComposer(TIMEOUT);
    expect(existsSync(authPath(home))).toBe(false);

    await session.sendText("/status");
    await session.waitForText("auth=missing", TIMEOUT);
    await session.waitForText("auth_refreshable=false", TIMEOUT);
    await session.waitForText(MISSING_LOGIN_HELP, TIMEOUT);

    await session.sendText("Say hello without a login.");
    await session.waitForText(MISSING_LOGIN_NOTICE, TIMEOUT);

    expect(codex.requests).toHaveLength(0);
    expect(session.isAlive()).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  TIMEOUT,
);

tmuxTest(
  "interactive Codex login activates the subscription and sends subscription headers",
  async () => {
    home = mkdtempSync(join(tmpdir(), "fx-tui-codex-login-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    codex = startFakeCodex({
      route: () => codexFinalText("CODEX_SUBSCRIPTION_OK"),
    });
    issuer = startFakeIssuer();

    session = await startFx(home, stderrPath, codex, {
      FX_E2E_CHATGPT_ISSUER_URL: issuer.baseUrl,
      // The sign-in row clips at the pane width, so the authorization URL only
      // survives in the escape stream when the window is wider than the URL.
    }, 320);
    await session.waitForComposer(TIMEOUT);

    await session.sendText("/login");
    await session.waitForText("Connections", TIMEOUT);
    await session.sendKeys("Enter");
    await session.waitForText("Codex subscription", TIMEOUT);
    await session.sendKeys("Enter");
    await completeDisplayedCodexLogin(session, issuer);
    await session.waitForText("Signed in with Codex.", TIMEOUT);

    expect(existsSync(authPath(home))).toBe(true);
    expect(statSync(authPath(home)).mode & 0o077).toBe(0);

    await session.sendText("/status");
    await session.waitForText("auth=Codex subscription", TIMEOUT);
    await session.waitForText("auth_refreshable=true", TIMEOUT);

    await session.sendText("Use the Codex subscription.");
    await session.waitForText("CODEX_SUBSCRIPTION_OK", TIMEOUT);

    expect(codex.requests.length).toBeGreaterThan(0);
    // The authorization-code exchange runs through the same /token fixture
    // endpoint, so the live session carries the exchanged (refreshed) token.
    for (const request of codex.requests) {
      expect(request.authorization).toBe(`Bearer ${codex.refreshedAccessToken}`);
      expect(request.body).not.toContain(codex.refreshedAccessToken);
    }

    const scrollback = await session.captureFullScrollback();
    expect(scrollback).not.toContain(codex.refreshedAccessToken);
    expect(scrollback).not.toContain("codex-e2e-code");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "expired login refreshes at startup and the prompt uses the rotated credential",
  async () => {
    home = mkdtempSync(join(tmpdir(), "fx-tui-codex-expired-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    codex = startFakeCodex({
      route: () => codexFinalText("CODEX_REFRESHED_OK"),
    });
    writeSeededChatGptLogin(home, chatGptAccessToken(), {
      refreshToken: "seeded-refresh-token",
      expiresAtMs: Date.now() - 60_000,
    });

    session = await startFx(home, stderrPath, codex);
    await session.waitForComposer(TIMEOUT);

    // Startup reports the stored expiry without contacting the issuer.
    await session.sendText("/status");
    await session.waitForText("auth=Codex subscription", TIMEOUT);
    await session.waitForText("auth_expired=true", TIMEOUT);
    await session.waitForText("auth_refreshable=true", TIMEOUT);
    expect(codex.tokenRequests).toHaveLength(0);

    await session.sendText("Use the refreshed credential.");
    await session.waitForText("CODEX_REFRESHED_OK", TIMEOUT);

    expect(codex.tokenRequests.length).toBeGreaterThan(0);
    const refreshBody = JSON.parse(codex.tokenRequests[0]!.body) as {
      client_id?: string;
      grant_type?: string;
      refresh_token?: string;
    };
    expect(refreshBody.grant_type).toBe("refresh_token");
    expect(refreshBody.refresh_token).toBe("seeded-refresh-token");
    expect(refreshBody.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");

    const persisted = JSON.parse(readFileSync(authPath(home), "utf8")) as {
      refresh_token: string;
    };
    expect(persisted.refresh_token).toBe("chatgpt-refresh-next");

    expect(codex.requests.length).toBeGreaterThan(0);
    for (const request of codex.requests) {
      expect(request.authorization).toBe(`Bearer ${codex.refreshedAccessToken}`);
    }

    const scrollback = await session.captureFullScrollback();
    for (const secret of [
      "seeded-refresh-token",
      "chatgpt-refresh-next",
      codex.accessToken,
      codex.refreshedAccessToken,
    ]) {
      expect(scrollback).not.toContain(secret);
      expect(readFileSync(stderrPath, "utf8")).not.toContain(secret);
    }
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "logout deletes the local credential and later prompts report the missing login",
  async () => {
    home = mkdtempSync(join(tmpdir(), "fx-tui-codex-logout-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    codex = startFakeCodex({
      route: () => codexFinalText("CODEX_BEFORE_LOGOUT_OK"),
    });
    writeSeededChatGptLogin(home, codex.accessToken);

    session = await startFx(home, stderrPath, codex);
    await session.waitForComposer(TIMEOUT);

    await session.sendText("Use the seeded subscription.");
    await session.waitForText("CODEX_BEFORE_LOGOUT_OK", TIMEOUT);
    expect(codex.requests.length).toBeGreaterThan(0);
    for (const request of codex.requests) {
      expect(request.authorization).toBe(`Bearer ${codex.accessToken}`);
    }
    for (const request of codex.modelRequests) {
      expect(request.authorization).toBe(`Bearer ${codex.accessToken}`);
    }

    await session.sendText("/logout");
    await session.waitForText("Signed out of Codex.", TIMEOUT);
    expect(existsSync(authPath(home))).toBe(false);

    await session.sendText("/logout");
    await session.waitForText("No Codex login session found.", TIMEOUT);

    await session.sendText("Say hello after logout.");
    await session.waitForText(MISSING_LOGIN_NOTICE, TIMEOUT);

    // A blocked prompt keeps its text in the composer; clear it before /status.
    await session.sendKeys("C-u");
    await session.sendText("/status");
    await session.waitForText("auth=missing", TIMEOUT);

    expect(codex.requests).toHaveLength(1);
    const scrollback = await session.captureFullScrollback();
    expect(scrollback).not.toContain(codex.accessToken);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);
