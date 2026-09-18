import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "./eval-helpers";
import {
  chatGptAccessToken,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 60_000;
const NO_GATEWAY_AUTH = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
};
const INSECURE_ENDPOINT = "http://192.0.2.1:9/v1";
// Opt-in leg: point at a real local server (no routing turn exists yet —
// that leg is owned by #403 — so this only proves the documented config
// shape is accepted for a real URL).
const REAL_OLLAMA_URL = process.env.FIBER_TEST_OLLAMA_URL;

type FixtureRoot = {
  root: string;
  home: string;
  workspace: string;
};

function createFixtureRoot(label: string): FixtureRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `fiber-user-connection-${label}-`)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace: realpathSync(workspace) };
}

function writeConnections(home: string, connections: unknown) {
  writeFileSync(
    join(home, ".fiber", "settings.json"),
    `${JSON.stringify({ connections })}\n`,
  );
}

function baseEnv(home: string): Record<string, string | undefined> {
  return {
    ...NO_GATEWAY_AUTH,
    FIBER_DISABLE_KEYCHAIN: "1",
    HOME: home,
  };
}

describe("user connections", () => {
  test(
    "keyless connection login reports no credential needed",
    async () => {
      const fixture = createFixtureRoot("keyless-login");
      try {
        writeConnections(fixture.home, {
          local: { credential: "none", base_url: "http://127.0.0.1:11434/v1" },
          keyed: { credential: "api_key", base_url: "https://example.com/v1" },
        });

        const ok = await runFx(["auth", "login", "local"], {
          cwd: fixture.workspace,
          env: baseEnv(fixture.home),
          timeoutMs: TIMEOUT,
        });
        expect(ok.code).toBe(0);
        expect(ok.stdout).toBe(
          "fiber auth login: connection 'local' needs no credential.\n",
        );

        for (const name of ["keyed", "unknown"]) {
          const rejected = await runFx(["auth", "login", name], {
            cwd: fixture.workspace,
            env: baseEnv(fixture.home),
            timeoutMs: TIMEOUT,
          });
          expect(rejected.code).not.toBe(0);
          expect(rejected.stdout).not.toContain("needs no credential");
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "keyless connection named like a provider keeps the messaging",
    async () => {
      const fixture = createFixtureRoot("codex-named");
      try {
        writeConnections(fixture.home, {
          codex: { credential: "none", base_url: "http://127.0.0.1:11434/v1" },
        });

        const result = await runFx(["auth", "login", "codex"], {
          cwd: fixture.workspace,
          env: baseEnv(fixture.home),
          timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
          "fiber auth login: connection 'codex' needs no credential.\n",
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "insecure codex override is refused before connecting, naming the connection",
    async () => {
      const fixture = createFixtureRoot("insecure-refusal");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(fixture.home, chatGptAccessToken());
        writeFileSync(
          join(fixture.home, ".fiber", "settings.json"),
          `${JSON.stringify({ model: FAKE_CODEX_DEFAULT_MODEL })}\n`,
        );

        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--no-save", "hi"],
          {
            cwd: fixture.workspace,
            env: {
              ...fakeCodexEnv(fixture.home, codex),
              ...NO_GATEWAY_AUTH,
              FIBER_E2E_OPENAI_CODEX_RESPONSES_URL: INSECURE_ENDPOINT,
            },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(
          `connection 'codex' refuses to send its credential over plain HTTP to '${INSECURE_ENDPOINT}'`,
        );
      } finally {
        codex.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "loopback override still sends the credential",
    async () => {
      const fixture = createFixtureRoot("loopback-control");
      const codex = startFakeCodex();
      try {
        writeSeededChatGptLogin(fixture.home, chatGptAccessToken());
        writeFileSync(
          join(fixture.home, ".fiber", "settings.json"),
          `${JSON.stringify({ model: FAKE_CODEX_DEFAULT_MODEL })}\n`,
        );

        const result = await runFx(
          ["ask", "--permission-mode", "auto", "--no-save", "hi"],
          {
            cwd: fixture.workspace,
            env: {
              ...fakeCodexEnv(fixture.home, codex),
              ...NO_GATEWAY_AUTH,
            },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(codex.requests).toHaveLength(1);
        expect(codex.requests[0].authorization?.startsWith("Bearer ")).toBe(true);
      } finally {
        codex.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!REAL_OLLAMA_URL)(
    "real local server URL is accepted as a keyless connection",
    async () => {
      const fixture = createFixtureRoot("real-ollama");
      try {
        writeConnections(fixture.home, {
          local: { credential: "none", base_url: REAL_OLLAMA_URL },
        });

        const result = await runFx(["auth", "login", "local"], {
          cwd: fixture.workspace,
          env: baseEnv(fixture.home),
          timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
          "fiber auth login: connection 'local' needs no credential.\n",
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
