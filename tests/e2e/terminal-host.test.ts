import { expect, test } from "bun:test";
import {
  execFileSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN } from "./eval-helpers";
import {
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";
import {
  CLEANUP_FINALIZATION_BUDGET_MS,
  FrameClient,
  NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
  SHELL_STARTUP_FIXTURE_TEST_TIMEOUT_MS,
  TERMINAL_FIXTURE_SHELL,
  TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
  TERMINAL_OWNER_SESSION,
  TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
  TMUX_MARKER_IO_DEADLINE_MS,
  WireFrame,
  actionSubjects,
  authorityBySession,
  authorityVariant,
  buildCurrentClientFixture,
  buildThreadForkFixture,
  children,
  directChildPids,
  durableTerminalRecordFor,
  encodeFrame,
  expectAbsentDuring,
  expectProfileFailedRejection,
  failure,
  failureCode,
  fileDiffersFrom,
  finishStartupObservation,
  forceCloseTerminalFixture,
  handshake,
  homes,
  hostPaths,
  hostPids,
  isolateZshStartupFixture,
  loginShellProfile,
  makeHome,
  makeLongHome,
  ownerCatalogAuthorityForSession,
  processExists,
  processFdCount,
  processGroupId,
  protocolFixtureDefinitions,
  protocolFixtureEnv,
  readSession,
  readSessionUntilContains,
  readTextIfPresent,
  rememberStartAuthority,
  requestAction,
  requestScreen,
  runClientFixture,
  startCommand,
  startHost,
  startHostWithAdvertisedProtocol,
  startInteractiveNativeFixture,
  startNativeCommandFixture,
  streamText,
  success,
  terminalTransportPaths,
  waitFor,
  waitForExit,
  withAuthority,
  withPersistence,
  writeLeaseSessions,
  registerTerminalHostCleanupHooks,
} from "./terminal-host-helpers";

registerTerminalHostCleanupHooks();

test("fresh hidden host is singular, correlated, reconnectable, private, and idle-clean", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const contenders = Array.from({ length: 4 }, () => startHost(home));
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  await waitFor(
    () => contenders.filter((child) => child.exitCode === null).length === 1,
    10_000,
    "single authoritative host",
  );

  expect(statSync(join(home, ".fiber")).mode & 0o777).toBe(0o700);
  expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  expect(statSync(paths.lock).mode & 0o777).toBe(0o600);
  expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  expect(statSync(paths.identity).mode & 0o777).toBe(0o600);

  const identityBefore = readFileSync(paths.identity, "utf8");
  const first = await handshake(paths.socket, { minimum: 4, current: 4 });
  expect(first.revision).toBe(4);
  const firstResponse = await requestScreen(first.client, first.revision!, 71);
  expect(firstResponse.kind).toBe(2);
  expect(firstResponse.subject).toBe(2);
  expect(firstResponse.correlation).toBe(71);
  expect(firstResponse.payload).toMatchObject({
    response: {
      failure: { action: "screen", code: "protocol_incompatible" },
    },
  });
  first.client.close();

  const second = await handshake(paths.socket, { minimum: 4, current: 4 });
  const secondResponse = await requestScreen(second.client, second.revision!, 72);
  expect(secondResponse.correlation).toBe(72);
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);
  second.client.close();

  const authoritative = contenders.find((child) => child.exitCode === null)!;
  expect(await waitForExit(authoritative)).toBe(0);
  await Promise.all(contenders.map(waitForExit));
  await waitFor(() => !existsSync(paths.socket), 5_000, "retired host socket removal");
  await waitFor(() => !existsSync(paths.identity), 5_000, "retired host identity removal");
  expect(existsSync(paths.socket)).toBe(false);
  expect(existsSync(paths.identity)).toBe(false);
  expect(existsSync(paths.lock)).toBe(true);

  for (const child of contenders) {
    expect(await streamText(child.stdout)).toBe("");
    expect(await streamText(child.stderr)).toBe("");
  }
});

test("host handshake is ready before slow durable recovery", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const child = startHost(home, { minimum: 4, current: 5 }, 350, {
    FIBER_TERMINAL_TEST_STARTUP_RECOVERY_DELAY_MS: "5500",
  });
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));

  const startedAt = Date.now();
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  const response = await requestScreen(connected.client, connected.revision!, 73);
  expect(response.payload).toMatchObject({
    response: {
      failure: { action: "screen", code: "protocol_incompatible" },
    },
  });
  connected.client.close();
  expect(await waitForExit(child)).toBe(0);
  expect(await streamText(child.stdout)).toBe("");
  expect(await streamText(child.stderr)).toBe("");
}, 15_000);

test("idle shutdown survives removal of the endpoint directory", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const child = startHost(home, undefined, 200);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));

  rmSync(paths.dir, { recursive: true, force: true });

  const exitCode = await waitForExit(child);
  const stdout = await streamText(child.stdout);
  const stderr = await streamText(child.stderr);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("fatal host drain timeout exits before shared-state teardown", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const failAccept = join(home, "fail-next-accept");
  const host = startHost(home, undefined, 10_000, {
    FIBER_TERMINAL_TEST_ACCEPT_FAILURE_PATH: failAccept,
  });
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));

  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  writeFileSync(failAccept, "fail\n");

  expect(await waitForExit(host)).toBe(1);
  expect(await streamText(host.stdout)).toBe("");
  expect(await streamText(host.stderr)).toBe("");

  // A normal unwind removes both files. Their presence proves the fatal path
  // stopped the process before stack-owned host state and shared I/O teardown.
  expect(existsSync(paths.socket)).toBe(true);
  expect(existsSync(paths.identity)).toBe(true);
  connected.client.close();

  // The next host recognizes the dead identity, cleans the stale endpoint, and
  // then follows the ordinary idle path, which still performs normal cleanup.
  rmSync(failAccept);
  const replacement = startHost(home, undefined, 100);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  expect(await waitForExit(replacement)).toBe(0);
  expect(existsSync(paths.socket)).toBe(false);
  expect(existsSync(paths.identity)).toBe(false);
}, 15_000);

test("startup recovery failure exits before stalled client teardown", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000, {
    FIBER_TERMINAL_TEST_STARTUP_RECOVERY_DELAY_MS: "1000",
    FIBER_TERMINAL_TEST_STARTUP_RECOVERY_FAILURE: "1",
  });
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));

  const stalled = await FrameClient.connect(paths.socket);
  expect(await waitForExit(host)).toBe(1);
  expect(await streamText(host.stdout)).toBe("");
  expect(await streamText(host.stderr)).toBe("");
  expect(existsSync(paths.socket)).toBe(true);
  expect(existsSync(paths.identity)).toBe(true);
  stalled.close();
}, 15_000);

test("client reconciles an idle-retiring host before admitting a request", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const trace = join(home, "idle-retirement.trace");
  const retiring = startHost(home, undefined, 50, {
    FIBER_TRACE_LOG: trace,
    FIBER_TRACE_SCOPES: "terminal_host",
    FIBER_TERMINAL_TEST_IDLE_EXIT_DELAY_MS: "3000",
  }, buildCurrentClientFixture());

  await waitFor(() =>
    readTextIfPresent(trace)?.includes("host retiring idle=true") ?? false
  );

  expect(await runClientFixture(home, 700)).toEqual({
    exitCode: 0,
    stdout: '{"kind":"response","correlation":1,"code":"authority_denied"}\n',
    stderr: "",
  });
  expect(await waitForExit(retiring)).toBe(0);
  await waitFor(() => !existsSync(paths.identity), 2_000);
}, 15_000);

test("native PTY starts in the requested cwd and reports exact command exit", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const fixtureShell = join(
    home,
    TERMINAL_FIXTURE_SHELL.endsWith("/zsh") ? "zsh" : "bash",
  );
  writeFileSync(
    fixtureShell,
    `#!/bin/sh\ntrap - TTIN TTOU\nkill -TTIN 0\nkill -TTOU 0\nexec ${TERMINAL_FIXTURE_SHELL} "$@"\n`,
    { mode: 0o700 },
  );
  const host = startHost(home, undefined, 5_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

  const started = await requestAction(
    connected.client,
    connected.revision!,
    101,
    "start",
    {
      cwd: home,
      command: "pwd; printf '\\npty-ready\\n'; exit 23",
      shell: { executable: { path: fixtureShell, clean_start: true } },
      backend: "native",
      return_when: { exit: {} },
      wait_ceiling_ms: 20_000,
      dimensions: { rows: 17, columns: 61 },
    },
  );
  expect(started.payload).toMatchObject({
    response: {
      success: {
        start: {
          outcome: { exited: 23 },
          session: { lifecycle: "exited", backend: "native" },
        },
      },
    },
  });
  const sessionId = (
    started.payload as {
      response: { success: { start: { session: { session_id: string } } } };
    }
  ).response.success.start.session.session_id;
  const read = await requestAction(
    connected.client,
    connected.revision!,
    102,
    "read",
    { session_id: sessionId, cursor: { segment: 1, offset: 0 } },
  );
  expect(
    (read.payload as { response: { success: { read: { output: string } } } })
      .response.success.read.output,
  ).toContain(`${home}\r\n`);
  expect(
    (read.payload as { response: { success: { read: { output: string } } } })
      .response.success.read.output,
  ).toContain("pty-ready\r\n");

  const nested = join(home, "nested");
  mkdirSync(nested);
  const nestedStart = await startCommand(
    connected.client,
    connected.revision!,
    103,
    {
      cwd: nested,
      command: "pwd; exit 0",
      shell: { executable: { path: fixtureShell, clean_start: true } },
      returnWhen: { exit: {} },
    },
  );
  const nestedId = (nestedStart.session as { session_id: string }).session_id;
  expect(
    (
      await readSession(
        connected.client,
        connected.revision!,
        104,
        nestedId,
      )
    ).output,
  ).toContain(nested);

  const rawPrivate = await handshake(paths.socket, {
    minimum: 4,
    current: 5,
  });
  await expect(
    requestAction(
      rawPrivate.client,
      rawPrivate.revision!,
      105,
      "start",
      {
        cwd: "nested",
        shell: { executable: { path: TERMINAL_FIXTURE_SHELL, clean_start: true } },
        backend: "native",
        return_when: { started: {} },
        wait_ceiling_ms: 1_000,
        dimensions: { rows: 24, columns: 80 },
      },
    ),
  ).rejects.toThrow("socket closed");

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, 15_000);

test("durable authority survives reconnect and rejects every foreign scope", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  const started = await startInteractiveNativeFixture(
    first.client,
    first.revision!,
    120_000,
    {
      cwd: home,
      command:
        "printf auth-ready; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done",
      marker: "auth-ready",
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;

  const read = await readSession(first.client, first.revision!, 121, sessionId);
  expect(read.output).toContain("auth-ready");
  const screen = await requestAction(
    first.client,
    first.revision!,
    122,
    "screen",
    { session_id: sessionId },
  );
  expect(success(screen, "screen").session).toMatchObject({
    session_id: sessionId,
  });
  const listed = await requestAction(first.client, first.revision!, 123, "list", {});
  expect(
    (success(listed, "list").sessions as Array<{ session_id: string }>)
      .map((session) => session.session_id),
  ).toContain(sessionId);

  first.client.close();
  const reconnected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const inspect = await requestAction(
    reconnected.client,
    reconnected.revision!,
    124,
    "inspect",
    { session_id: sessionId },
  );
  expect(success(inspect, "inspect").session).toMatchObject({
    lifecycle: "running",
  });

  const current = authorityBySession.get(sessionId)! as {
    principal: Record<string, unknown>;
    generation: { value: number };
    proof: { bytes: number[] };
  };
  const foreignClaims = [
    authorityVariant(sessionId, {
      principal: { ...current.principal, profile_user: "foreign-profile" },
    }),
    authorityVariant(sessionId, {
      principal: { ...current.principal, durable_session_id: "foreign-owner" },
    }),
    authorityVariant(sessionId, {
      principal: { ...current.principal, workspace_root: "/foreign-workspace" },
    }),
    authorityVariant(sessionId, {
      principal: { ...current.principal, cwd: "/foreign-cwd" },
    }),
    authorityVariant(sessionId, {
      principal: { ...current.principal, transport_role: "headless" },
    }),
    authorityVariant(sessionId, {
      principal: { ...current.principal, backend: "tmux" },
    }),
    authorityVariant(sessionId, { actor: "human" }),
    authorityVariant(sessionId, { proof: { bytes: [8, ...current.proof.bytes.slice(1)] } }),
    authorityVariant(sessionId, { generation: { value: current.generation.value + 1 } }),
  ];
  let correlation = 125;
  for (const authority of foreignClaims) {
    const rejected = await requestAction(
      reconnected.client,
      reconnected.revision!,
      correlation++,
      "read",
      {
        session_id: sessionId,
        cursor: { segment: 1, offset: 0 },
        authority,
      },
    );
    expect(failure(rejected).code).toBe("authority_denied");
  }

  const observerStart = withPersistence({
    cwd: home,
    command: "printf observer-ready; sleep 90",
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    backend: "native",
    return_when: { match: "observer-ready" },
    wait_ceiling_ms: NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2,
    dimensions: { rows: 24, columns: 80 },
  });
  const observerPersistence = observerStart.persistence as {
    grant: { controls: Record<string, boolean> };
  };
  observerPersistence.grant.controls = {
    read: true,
    screen: true,
    write: false,
    wait: false,
    inspect: true,
    list: true,
    resize: false,
    signal: false,
    close: false,
  };
  const observerFrame = await requestAction(
    reconnected.client,
    reconnected.revision!,
    correlation++,
    "start",
    observerStart,
  );
  const observer = success(observerFrame, "start");
  const observerId = (observer.session as { session_id: string }).session_id;
  expect(observer.session).toMatchObject({ lifecycle: "running" });
  const expanded = await requestAction(
    reconnected.client,
    reconnected.revision!,
    correlation++,
    "write",
    { session_id: observerId, lease: "acquire" },
  );
  expect(failure(expanded).code).toBe("authority_denied");

  const priorIdentity = readFileSync(paths.identity, "utf8");
  reconnected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
  const replacement = startHost(home, undefined, 10_000);
  await waitFor(() => fileDiffersFrom(paths.identity, priorIdentity));
  const afterHostRestart = await handshake(paths.socket, { minimum: 4, current: 5 });
  const recoveredRead = await requestAction(
    afterHostRestart.client,
    afterHostRestart.revision!,
    correlation++,
    "read",
    { session_id: sessionId, cursor: { segment: 1, offset: 0 } },
  );
  expect(success(recoveredRead, "read").session).toMatchObject({ lifecycle: "lost" });

  const closed = await requestAction(
    afterHostRestart.client,
    afterHostRestart.revision!,
    correlation++,
    "close",
    { session_id: sessionId, policy: "force" },
  );
  expect(success(closed, "close").session).toMatchObject({ lifecycle: "closed" });
  const stale = await requestAction(
    afterHostRestart.client,
    afterHostRestart.revision!,
    correlation++,
    "read",
    { session_id: sessionId, cursor: { segment: 1, offset: 0 } },
  );
  expect(failure(stale).code).toBe("authority_denied");

  afterHostRestart.client.close();
  replacement.kill("SIGKILL");
  await waitForExit(replacement);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 10 + 30_000);

test("direct human leases keep the owning model observational", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const directStart = withPersistence({
    cwd: home,
    command: "printf direct-ready; sleep 30",
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    backend: "native",
    return_when: { match: "direct-ready" },
    wait_ceiling_ms: 5_000,
    dimensions: { rows: 24, columns: 80 },
  });
  const persistence = directStart.persistence as {
    grant: { actor: string };
    direct_human_model_read_only: boolean;
  };
  persistence.grant.actor = "human";
  persistence.direct_human_model_read_only = true;
  const startFrame = await requestAction(
    connected.client,
    connected.revision!,
    180,
    "start",
    directStart,
  );
  const started = success(startFrame, "start");
  const sessionId = (started.session as { session_id: string }).session_id;
  const modelAuthority = authorityVariant(sessionId, { actor: "agent" });

  const humanLease = await requestAction(
    connected.client,
    connected.revision!,
    181,
    "write",
    { session_id: sessionId, lease: "acquire" },
  );
  expect(success(humanLease, "write").session).toMatchObject({
    attention: { attention: "user_takeover", write_lease: "human" },
  });
  const modelRead = await requestAction(
    connected.client,
    connected.revision!,
    182,
    "read",
    {
      session_id: sessionId,
      cursor: { segment: 1, offset: 0 },
      authority: modelAuthority,
    },
  );
  expect(success(modelRead, "read").session).toMatchObject({
    next_actions: {
      read: true,
      screen: true,
      write: false,
      wait: false,
      inspect: true,
      list: true,
      resize: false,
      signal: false,
      close: false,
    },
  });
  for (const action of ["screen", "inspect"] as const) {
    const observed = await requestAction(
      connected.client,
      connected.revision!,
      action === "screen" ? 183 : 184,
      action,
      { session_id: sessionId, authority: modelAuthority },
    );
    expect(success(observed, action).session).toMatchObject({ session_id: sessionId });
  }
  const modelList = await requestAction(
    connected.client,
    connected.revision!,
    185,
    "list",
    {
      owner_authority: ownerCatalogAuthorityForSession(sessionId, modelAuthority),
    },
  );
  expect(success(modelList, "list").sessions).toHaveLength(1);
  const conflict = await requestAction(
    connected.client,
    connected.revision!,
    186,
    "write",
    { session_id: sessionId, lease: "acquire", authority: modelAuthority },
  );
  expect(failure(conflict).code).toBe("lease_conflict");

  const released = await requestAction(
    connected.client,
    connected.revision!,
    187,
    "write",
    { session_id: sessionId, lease: "release" },
  );
  expect(success(released, "write").session).toMatchObject({
    attention: { attention: "background", write_lease: "none" },
  });
  const deniedLease = await requestAction(
    connected.client,
    connected.revision!,
    188,
    "write",
    { session_id: sessionId, lease: "acquire", authority: modelAuthority },
  );
  expect(failure(deniedLease).code).toBe("authority_denied");
  for (const [action, value] of [
    ["wait", { return_when: { exit: {} }, safety_ceiling_ms: 1 }],
    ["resize", { dimensions: { rows: 20, columns: 60 } }],
    ["signal", { signal: "interrupt" }],
    ["close", { policy: "force" }],
  ] as const) {
    const denied = await requestAction(
      connected.client,
      connected.revision!,
      189 + ["wait", "resize", "signal", "close"].indexOf(action),
      action,
      { session_id: sessionId, ...value, authority: modelAuthority },
    );
    expect(failure(denied).code).toBe("authority_denied");
  }
  const humanClose = await requestAction(
    connected.client,
    connected.revision!,
    200,
    "close",
    { session_id: sessionId, policy: "force" },
  );
  expect(success(humanClose, "close").session).toMatchObject({ lifecycle: "closed" });
  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, 20_000);

test("revoke and close quiesce writes already queued under stale authority", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const writeBarrier = join(home, "write-barrier");
  const host = startHost(home, undefined, 10_000, {
    FIBER_TERMINAL_TEST_WRITE_DELAY_MS: "180",
    FIBER_TERMINAL_TEST_WRITE_BARRIER_PATH: writeBarrier,
  });
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  let correlation = 220;

  async function startMarkerSession(prefix: string): Promise<string> {
    const fixtureCorrelation = correlation;
    correlation += 4;
    const started = await startInteractiveNativeFixture(
      connected.client,
      connected.revision!,
      fixtureCorrelation,
      {
        cwd: home,
        command:
          `printf '${prefix}-fixture-ready'; ` +
          `while IFS= read -r line; do ` +
          `[ \"$line\" = allowed ] && : > '${join(home, `${prefix}-allowed`)}'; ` +
          `[ \"$line\" = stale ] && : > '${join(home, `${prefix}-stale`)}'; done`,
        marker: `${prefix}-fixture-ready`,
      },
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    const acquired = await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "write",
      { session_id: sessionId, lease: "acquire" },
    );
    expect(success(acquired, "write").accepted_bytes).toBe(0);
    return sessionId;
  }

  const revokedId = await startMarkerSession("revoke");
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.write,
    correlation++,
    { request: { write: withAuthority("write", {
      session_id: revokedId,
      payload: { text: "allowed\n" },
      lease: "use",
    }) } },
    1,
  ));
  await waitFor(() => existsSync(writeBarrier));
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.write,
    correlation++,
    { request: { write: withAuthority("write", {
      session_id: revokedId,
      lease: "revoke",
    }) } },
    1,
  ));
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.write,
    correlation++,
    { request: { write: withAuthority("write", {
      session_id: revokedId,
      payload: { text: "stale\n" },
      lease: "use",
    }) } },
    1,
  ));
  const revokeResponses = [
    await connected.client.read(),
    await connected.client.read(),
    await connected.client.read(),
  ];
  expect(revokeResponses.filter((frame) => {
    const response = (frame.payload as { response?: { success?: { write?: { accepted_bytes: number } } } }).response;
    return (response?.success?.write?.accepted_bytes ?? 0) > 0;
  })).toHaveLength(1);
  expect(revokeResponses.some((frame) => {
    const response = (frame.payload as { response?: { success?: { write?: { accepted_bytes: number } } } }).response;
    return response?.success?.write?.accepted_bytes === 0;
  })).toBe(true);
  expect(revokeResponses.some((frame) => failureCode(frame) === "authority_denied")).toBe(true);
  await waitFor(() => existsSync(join(home, "revoke-allowed")));
  await expectAbsentDuring(join(home, "revoke-stale"), 1_000);

  const closedId = await startMarkerSession("close");
  rmSync(writeBarrier, { force: true });
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.write,
    correlation++,
    { request: { write: withAuthority("write", {
      session_id: closedId,
      payload: { text: "allowed\n" },
      lease: "use",
    }) } },
    1,
  ));
  await waitFor(() => existsSync(writeBarrier));
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.close,
    correlation++,
    { request: { close: withAuthority("close", {
      session_id: closedId,
      policy: "force",
    }) } },
    1,
  ));
  connected.client.send(encodeFrame(
    connected.revision!,
    1,
    actionSubjects.write,
    correlation++,
    { request: { write: withAuthority("write", {
      session_id: closedId,
      payload: { text: "stale\n" },
      lease: "use",
    }) } },
    1,
  ));
  const closeResponses = [
    await connected.client.read(),
    await connected.client.read(),
    await connected.client.read(),
  ];
  const closeFrame = closeResponses.find((frame) => frame.subject === actionSubjects.close)!;
  expect(success(closeFrame, "close").session).toMatchObject({ lifecycle: "closed" });
  const staleFrame = closeResponses.find((frame) =>
    frame.subject === actionSubjects.write && failureCode(frame) === "authority_denied"
  );
  expect(staleFrame).toBeDefined();
  await waitFor(() => existsSync(join(home, "close-allowed")));
  await expectAbsentDuring(join(home, "close-stale"), 1_000);

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 12 + 30_000);

test("private screen snapshots and native cursor replies use the real PTY", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

  const started = await startNativeCommandFixture(
    connected.client,
    connected.revision!,
    150_000,
    {
      cwd: home,
      command: "stty raw -echo; printf '\\033[6n'; IFS= read -r -d R reply; stty sane; IFS= read -r line; printf 'reply:%sR input:%s\\n' \"$reply\" \"$line\"",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      returnWhen: { started: {} },
      waitMs: 5_000,
      dimensions: { rows: 9, columns: 37 },
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  let correlation = 151;
  await waitFor(async () => {
    const page = await readSession(
      connected.client,
      connected.revision!,
      correlation++,
      sessionId,
    );
    return page.output.includes("\u001b[6n");
  });
  const write = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "write",
    { session_id: sessionId, payload: { text: "later\n" } },
  );
  expect(success(write, "write").accepted_bytes).toBe(6);
  const waited = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "wait",
    {
      session_id: sessionId,
      return_when: { exit: {} },
      safety_ceiling_ms: 5_000,
    },
  );
  expect(success(waited, "wait").outcome).toEqual({ exited: 0 });
  const raw = await readSession(
    connected.client,
    connected.revision!,
    correlation++,
    sessionId,
  );
  expect(raw.output).toMatch(/reply:\u001b\[[0-9]+;[0-9]+R input:later/);

  const screenFrame = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "screen",
    { session_id: sessionId },
  );
  const screen = success(screenFrame, "screen") as {
    snapshot: {
      dimensions: { rows: number; columns: number };
      cells: Array<{ kind: string; text: string }>;
    };
  };
  expect(screen.snapshot.dimensions).toEqual({ rows: 9, columns: 37 });
  expect(screen.snapshot.cells).toHaveLength(9 * 37);
  expect(screen.snapshot.cells.map((cell) => cell.text).join(""))
    .toContain("reply:");
  for (let index = 0; index < screen.snapshot.cells.length; index += 1) {
    const cell = screen.snapshot.cells[index]!;
    if (cell.kind === "wide") {
      expect(screen.snapshot.cells[index + 1]?.kind).toBe("continuation");
    }
    if (cell.kind === "continuation") {
      expect(screen.snapshot.cells[index - 1]?.kind).toBe("wide");
    }
  }

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 6 + 30_000);

test("resized screen checkpoint survives a fresh host without raw reflow", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const oldIdentity = readFileSync(paths.identity, "utf8");
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

  const started = await startCommand(
    connected.client,
    connected.revision!,
    170,
    {
      cwd: home,
      command: "printf abcdef; exec /bin/sh -c 'while :; do sleep 30; done'",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      returnWhen: { match: "abcdef" },
      waitMs: 5_000,
      dimensions: { rows: 2, columns: 4 },
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  const resized = await requestAction(
    connected.client,
    connected.revision!,
    171,
    "resize",
    {
      session_id: sessionId,
      dimensions: { rows: 2, columns: 6 },
    },
  );
  expect(success(resized, "resize").dimensions).toEqual({
    rows: 2,
    columns: 6,
  });

  const snapshotRows = (value: unknown): string[] => {
    const snapshot = (value as {
      snapshot: {
        dimensions: { rows: number; columns: number };
        cells: Array<{ kind: string; text: string }>;
      };
    }).snapshot;
    return Array.from({ length: snapshot.dimensions.rows }, (_, row) =>
      snapshot.cells
        .slice(
          row * snapshot.dimensions.columns,
          (row + 1) * snapshot.dimensions.columns,
        )
        .map((cell) => cell.kind === "blank" ? " " : cell.text)
        .join("")
        .trimEnd(),
    );
  };
  const liveScreen = success(
    await requestAction(
      connected.client,
      connected.revision!,
      172,
      "screen",
      { session_id: sessionId },
    ),
    "screen",
  );
  expect(snapshotRows(liveScreen)).toEqual(["abcd", "ef"]);

  host.kill("SIGKILL");
  await waitForExit(host);
  connected.client.close();
  const replacement = startHost(home, undefined, 300);
  await waitFor(
    () => fileDiffersFrom(paths.identity, oldIdentity),
    3_000,
  );
  const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
  const durableScreen = success(
    await requestAction(
      recovered.client,
      recovered.revision!,
      173,
      "screen",
      { session_id: sessionId },
    ),
    "screen",
  );
  expect(snapshotRows(durableScreen)).toEqual(["abcd", "ef"]);
  recovered.client.close();
  expect(await waitForExit(replacement)).toBe(0);
}, 15_000);

test.skipIf(!tmuxAvailable())("private screen text grid matches an actual tmux capture", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const fixture = join(home, "screen-fixture.zsh");
  writeFileSync(
    fixture,
    [
      "printf '\\033[2J\\033[H'",
      "printf '\\033[1;34mfx-grid\\033[0m'",
      "printf '\\033[3;1Hwide: 界 + é'",
      "printf '\\033[5;1Habcdef'",
      "printf '\\033[2D\\033[P'",
      "printf '\\033[7;4Htab\\tstop'",
      "printf '\\033[9;1Hready'",
      "IFS= read -r _",
    ].join("\n"),
  );

  const tmux = await TmuxSession.create({
    cmd: "/bin/zsh -f ./screen-fixture.zsh",
    cwd: home,
    width: 40,
    height: 10,
    startupWaitMs: 0,
  });
  try {
    await tmux.waitForText("ready", 5_000);
    const tmuxGrid = (await tmux.capturePaneGrid()).map((row) =>
      row.replaceAll("\t", "  ").trimEnd()
    );

    const paths = hostPaths(home);
    const host = startHost(home, undefined, 10_000);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
    let correlation = 175;
    const started = await startNativeCommandFixture(
      connected.client,
      connected.revision!,
      175_000,
      {
        cwd: home,
        command: "exec /bin/zsh -f ./screen-fixture.zsh",
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        returnWhen: { started: {} },
        dimensions: { rows: 10, columns: 40 },
      },
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    await waitFor(async () => {
      const page = await readSession(
        connected.client,
        connected.revision!,
        correlation++,
        sessionId,
      );
      return page.output.includes("ready");
    });

    const screen = success(
      await requestAction(
        connected.client,
        connected.revision!,
        correlation++,
        "screen",
        { session_id: sessionId },
      ),
      "screen",
    ) as {
      snapshot: {
        dimensions: { rows: number; columns: number };
        cursor: { row: number; column: number };
        cells: Array<{ kind: string; text: string }>;
      };
    };
    const nativeGrid = Array.from(
      { length: screen.snapshot.dimensions.rows },
      (_, row) => screen.snapshot.cells
        .slice(row * screen.snapshot.dimensions.columns, (row + 1) * screen.snapshot.dimensions.columns)
        .map((cell) => cell.kind === "blank" ? " " : cell.text)
        .join("")
        .trimEnd(),
    );

    expect(screen.snapshot.dimensions).toEqual({ rows: 10, columns: 40 });
    expect(nativeGrid).toEqual(tmuxGrid);
    const tmuxCursor = tmux.cursorPosition();
    expect(screen.snapshot.cursor).toMatchObject({
      row: tmuxCursor.row,
      column: tmuxCursor.col,
    });

    await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "close",
      { session_id: sessionId, policy: "force" },
    );
    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  } finally {
    await tmux.kill();
  }
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2 + 30_000);

test("Bash and zsh preserve trusted normal startup and controlled clean startup", async () => {
  const home = makeHome();
  if (existsSync("/bin/zsh")) isolateZshStartupFixture(home);
  const paths = hostPaths(home);
  const tracePath = join(home, "startup-spoof.trace");
  const host = startHost(home, undefined, 10_000, {
    FIBER_TERMINAL_TEST_COMMAND_BOUNDARY_DELAY_MS: "2500",
    FIBER_TRACE_LOG: tracePath,
  });
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  let correlation = 200;

  const shells = [
    {
      name: "bash",
      path: "/bin/bash",
      profile: ".bash_profile",
      hostileProfile: ".bash_profile",
      marker: "bash-profile",
    },
    {
      name: "zsh",
      path: "/bin/zsh",
      profile: ".zprofile",
      hostileProfile: ".zlogin",
      marker: "zsh-profile",
    },
  ].filter((shell) => existsSync(shell.path));
  expect(shells.length).toBeGreaterThan(0);

  for (const shell of shells) {
    const profileReady = join(home, `${shell.name}-profile-ready`);
    const commandRan = join(home, `${shell.name}-command-ran`);
    const boundaryMatch = `${shell.name}-boundary-match`;
    writeFileSync(
      join(home, shell.profile),
      [
        `printf '${shell.marker}\\n'`,
        `printf '${boundaryMatch}\\n'`,
        `: > '${profileReady}'`,
        `alias fiber_profile_alias="printf '${shell.name}-alias\\\\n'"`,
        `fiber_profile_function() { printf '${shell.name}-function\\\\n'; }`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, shell.hostileProfile),
      "eval() { printf 'forged-eval\\n'; return 42; }\n",
      { flag: "a" },
    );
    const normalInitial = await startCommand(
      connected.client,
      connected.revision!,
      correlation++,
      {
        cwd: home,
        command: [
          "fiber_profile_alias",
          "fiber_profile_function",
          `printf '${shell.name}-command\\n'`,
          "(exit 19)",
        ].join("; "),
        shell: {
          executable: { path: shell.path, clean_start: false },
        },
        returnWhen: { exit: {} },
      },
    );
    const normal = await finishStartupObservation(
      connected.client,
      connected.revision!,
      correlation++,
      normalInitial,
      "native",
      { exit: {} },
      NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
    );
    expect(normal.outcome).toEqual({ exited: 19 });
    const normalSession = (normal.session as { session_id: string }).session_id;
    const normalRead = await readSession(
      connected.client,
      connected.revision!,
      correlation++,
      normalSession,
    );
    expect(normalRead.output).toContain(shell.marker);
    expect(normalRead.output).toContain(`${shell.name}-alias`);
    expect(normalRead.output).toContain(`${shell.name}-function`);
    expect(normalRead.output).toContain(`${shell.name}-command`);
    expect(normalRead.output).not.toContain("forged-eval");

    rmSync(profileReady, { force: true });
    rmSync(commandRan, { force: true });
    const boundaryStartedAt = Date.now();
    const boundaryCorrelation = correlation++;
    const boundaryRequest = withPersistence({
      cwd: home,
      command:
        `: > '${commandRan}'; sleep 0.15; ` +
        `printf '${boundaryMatch}\\n'; sleep 30`,
      shell: {
        executable: { path: shell.path, clean_start: false },
      },
      backend: "native",
      return_when: { match: boundaryMatch },
      wait_ceiling_ms: 5_000,
      dimensions: { rows: 24, columns: 80 },
    });
    connected.client.send(
      encodeFrame(
        connected.revision!,
        1,
        actionSubjects.start,
        boundaryCorrelation,
        {
          request: {
            start: boundaryRequest,
          },
        },
        1,
      ),
    );
    await waitFor(() => existsSync(profileReady));
    await expectAbsentDuring(commandRan, 1_000);
    const boundaryFrame = await connected.client.read();
    rememberStartAuthority(boundaryFrame, boundaryRequest);
    expect(boundaryFrame.correlation).toBe(boundaryCorrelation);
    const boundary = await finishStartupObservation(
      connected.client,
      connected.revision!,
      correlation++,
      success(boundaryFrame, "start"),
      "native",
      { match: boundaryMatch },
      NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
    );
    expect(boundary.outcome).toEqual({ condition_met: {} });
    expect(Date.now() - boundaryStartedAt).toBeGreaterThanOrEqual(2600);
    expect(existsSync(commandRan)).toBe(true);
    const boundaryId = (boundary.session as { session_id: string }).session_id;
    const boundaryOutput = (
      await readSession(
        connected.client,
        connected.revision!,
        correlation++,
        boundaryId,
      )
    ).output;
    expect(boundaryOutput.match(new RegExp(boundaryMatch, "g"))?.length).toBe(2);
    await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "close",
      { session_id: boundaryId, policy: "force" },
    );

    const cleanInitial = await startCommand(
      connected.client,
      connected.revision!,
      correlation++,
      {
        cwd: home,
        command:
          "alias fiber_profile_alias >/dev/null 2>&1 && " +
          "printf 'alias-leaked\\n' || printf 'alias-absent\\n'; " +
          "type fiber_profile_function >/dev/null 2>&1 && " +
          "printf 'function-leaked\\n' || printf 'function-absent\\n'; " +
          `printf '${shell.name}-clean\\n'; exit 0`,
        shell: {
          executable: { path: shell.path, clean_start: true },
        },
        returnWhen: { exit: {} },
      },
    );
    const clean = await finishStartupObservation(
      connected.client,
      connected.revision!,
      correlation++,
      cleanInitial,
      "native",
      { exit: {} },
      NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
    );
    expect(clean.outcome).toEqual({ exited: 0 });
    const cleanSession = (clean.session as { session_id: string }).session_id;
    const cleanRead = await readSession(
      connected.client,
      connected.revision!,
      correlation++,
      cleanSession,
    );
    expect(cleanRead.output).not.toContain(shell.marker);
    expect(cleanRead.output).toContain("alias-absent");
    expect(cleanRead.output).toContain("function-absent");
    expect(cleanRead.output).not.toContain("alias-leaked");
    expect(cleanRead.output).not.toContain("function-leaked");
    expect(cleanRead.output).toContain(`${shell.name}-clean`);
  }

  const configuredLogin = await startCommand(
    connected.client,
    connected.revision!,
    correlation++,
    {
      cwd: home,
      command: "printf configured-login; exit 0",
      shell: { user_login: {} },
      returnWhen: { exit: {} },
    },
  );
  expect(configuredLogin.outcome).toEqual({ exited: 0 });
  const configuredId = (
    configuredLogin.session as { session_id: string }
  ).session_id;
  expect(
    (
      await readSession(
        connected.client,
        connected.revision!,
        correlation++,
        configuredId,
      )
    ).output,
  ).toContain("configured-login");

  if (existsSync("/bin/zsh")) {
    writeFileSync(
      join(home, ".zprofile"),
      "sleep 0.2\n" +
        "fiber_delayed_function() { printf 'delayed-function\\n'; }\n" +
        "printf 'delayed-profile\\n'\n",
    );
    const delayedAt = Date.now();
    const delayed = await startCommand(
      connected.client,
      connected.revision!,
      correlation++,
      {
        cwd: home,
        shell: {
          executable: { path: "/bin/zsh", clean_start: false },
        },
        returnWhen: { started: {} },
      },
    );
    expect(Date.now() - delayedAt).toBeGreaterThanOrEqual(150);
    const delayedId = (delayed.session as { session_id: string }).session_id;
    expect(
      (
        await readSession(
          connected.client,
          connected.revision!,
          correlation++,
          delayedId,
        )
      ).output,
    ).toContain("delayed-profile");
    await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "write",
      {
        session_id: delayedId,
        payload: { text: "fiber_delayed_function\r" },
      },
    );
    const delayedMatch = await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "wait",
      {
        session_id: delayedId,
        return_when: { match: "delayed-function" },
        safety_ceiling_ms: 2_000,
      },
    );
    expect(success(delayedMatch, "wait").outcome).toEqual({
      condition_met: {},
    });
    await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "close",
      { session_id: delayedId, policy: "force" },
    );

    writeFileSync(
      join(home, ".zprofile"),
      "printf '\\001\\000\\000\\000\\000spoofed-ready\\n'; exit 41\n",
    );
    const spoofStartedAt = Date.now();
    const failedStartup = await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "start",
      {
        cwd: home,
        command: "exit 0",
        shell: {
          executable: { path: "/bin/zsh", clean_start: false },
        },
        backend: "native",
        return_when: { exit: {} },
        wait_ceiling_ms: 5_000,
        dimensions: { rows: 24, columns: 80 },
      },
    );
    const spoofElapsed = Date.now() - spoofStartedAt;
    expect(failure(failedStartup)).toMatchObject({
      action: "start",
      code: "startup_failed",
    });
    const failedId = (failure(failedStartup) as { session_id: string }).session_id;
    // Pin the cause: a genuine load timeout also yields startup_failed (at
    // the 5s ceiling), so require the early profile_failed rejection — a
    // fast failure plus the launcher's profile_failed trace marker for
    // this session. The forged shell-ready bytes must also surface as inert
    // output: a detector that honored them would publish started instead of
    // failing, and a plain exit 41 carries no such payload.
    expect(spoofElapsed).toBeLessThan(4_900);
    await expectProfileFailedRejection(
      tracePath,
      failedId,
      "spoofed-profile rejection trace",
    );
    await readSessionUntilContains(
      connected.client,
      connected.revision!,
      () => correlation++,
      failedId,
      "spoofed-ready",
      "spoofed-profile output",
    );

    const signaled = await startCommand(
      connected.client,
      connected.revision!,
      correlation++,
      {
        cwd: home,
        command: "exec /bin/sh -c 'kill -SEGV $$'",
        shell: {
          executable: { path: "/bin/zsh", clean_start: true },
        },
        returnWhen: { exit: {} },
      },
    );
    expect(signaled.outcome).toEqual({ signal: 11 });

    const forgedCompletion = await startNativeCommandFixture(
      connected.client,
      connected.revision!,
      correlation,
      {
        cwd: home,
        command:
          "printf '\\004\\000\\000\\000\\000spoofed-completion\\n'; exit 29",
        shell: {
          executable: { path: "/bin/zsh", clean_start: true },
        },
        returnWhen: { exit: {} },
        waitMs: 5_000,
      },
    );
    correlation += 6;
    expect(forgedCompletion.outcome).toEqual({ exited: 29 });
    const forgedId = (
      forgedCompletion.session as { session_id: string }
    ).session_id;
    expect(
      (
        await readSession(
          connected.client,
          connected.revision!,
          correlation++,
          forgedId,
        )
      ).output,
    ).toContain("spoofed-completion");
  }

  const missing = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "start",
    {
      cwd: home,
      shell: {
        executable: {
          path: "/definitely/missing/bash",
          clean_start: true,
        },
      },
      backend: "native",
      return_when: { started: {} },
      wait_ceiling_ms: 2_000,
      dimensions: { rows: 24, columns: 80 },
    },
  );
  expect(failure(missing)).toMatchObject({
    action: "start",
    code: "shell_unavailable",
  });

  const unsupported = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "start",
    {
      cwd: home,
      shell: {
        executable: { path: "/bin/fish", clean_start: true },
      },
      backend: "native",
      return_when: { started: {} },
      wait_ceiling_ms: 2_000,
      dimensions: { rows: 24, columns: 80 },
    },
  );
  expect(failure(unsupported)).toMatchObject({
    action: "start",
    code: "invalid_request",
  });

  const loginProfile = loginShellProfile();
  if (loginProfile !== null) {
    writeFileSync(
      join(home, loginProfile),
      "printf '\\001\\000\\000\\000\\000spoofed-login\\n'; exit 41\n",
    );
    const tmux = await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "start",
      {
        cwd: home,
        shell: { user_login: {} },
        backend: "tmux",
        return_when: { started: {} },
        wait_ceiling_ms: 2_000,
        dimensions: { rows: 24, columns: 80 },
      },
    );
    expect(failure(tmux)).toMatchObject({
      action: "start",
      code: "startup_failed",
    });
    // Same spoof pin through the tmux login-shell path: early
    // profile_failed rejection plus the forged bytes surfacing as inert
    // output. A plain exiting profile carries no such payload.
    const tmuxFailedId = (failure(tmux) as { session_id?: string }).session_id;
    await expectProfileFailedRejection(
      tracePath,
      tmuxFailedId,
      "login-profile rejection trace",
    );
    await readSessionUntilContains(
      connected.client,
      connected.revision!,
      () => correlation++,
      tmuxFailedId!,
      "spoofed-login",
      "login-profile output",
    );
  }

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, SHELL_STARTUP_FIXTURE_TEST_TIMEOUT_MS + NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 6);

test("writes resize waits cancellation signals and close remain session-scoped", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 200);
  await waitFor(() => existsSync(paths.socket));
  const control = await handshake(paths.socket, { minimum: 4, current: 5 });

  const started = await startNativeCommandFixture(
    control.client,
    control.revision!,
    300_000,
    {
      cwd: home,
      command:
        "exec /bin/sh -c 'trap \"printf term-trap; exit 37\" TERM; trap \"printf winch:; stty size\" WINCH; printf ready; while :; do read line; done'",
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      returnWhen: { match: "ready" },
      waitMs: 5_000,
      dimensions: { rows: 12, columns: 40 },
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  expect(started.outcome).toEqual({ condition_met: {} });
  await Bun.sleep(350);
  expect(existsSync(paths.socket)).toBe(true);
  expect(host.exitCode).toBeNull();

  const unrelated = await handshake(paths.socket, { minimum: 4, current: 5 });
  const ceiling = await requestAction(
    unrelated.client,
    unrelated.revision!,
    299,
    "wait",
    {
      session_id: sessionId,
      return_when: { match: "never-produced-terminal-marker" },
      safety_ceiling_ms: 25,
    },
  );
  expect(success(ceiling, "wait").outcome).toEqual({
    safety_ceiling: {},
  });
  control.client.send(
    encodeFrame(
      control.revision!,
      1,
      actionSubjects.wait,
      301,
      {
        request: {
          wait: withAuthority("wait", {
            session_id: sessionId,
            return_when: { quiet: 20_000 },
            safety_ceiling_ms: 25_000,
          }),
        },
      },
      1,
    ),
  );
  const inspected = await requestAction(
    unrelated.client,
    unrelated.revision!,
    302,
    "inspect",
    { session_id: sessionId },
  );
  expect(success(inspected, "inspect").session).toMatchObject({
    lifecycle: "running",
  });
  control.client.send(
    encodeFrame(control.revision!, 4, 0, 301, { cancel: {} }),
  );
  const cancelled = success(await control.client.read(), "wait");
  expect(cancelled.outcome).toEqual({ cancelled: {} });
  const afterCancel = await requestAction(
    unrelated.client,
    unrelated.revision!,
    300_302,
    "inspect",
    { session_id: sessionId },
  );
  expect(success(afterCancel, "inspect").session).toMatchObject({
    lifecycle: "running",
    attention: { attention: "background", write_lease: "none" },
  });

  control.client.send(
    encodeFrame(control.revision!, 4, 0, 999_999, { cancel: {} }),
  );
  const resized = await requestAction(
    unrelated.client,
    unrelated.revision!,
    303,
    "resize",
    {
      session_id: sessionId,
      dimensions: { rows: 31, columns: 97 },
    },
  );
  expect(success(resized, "resize").dimensions).toEqual({
    rows: 31,
    columns: 97,
  });
  const winch = await requestAction(
    unrelated.client,
    unrelated.revision!,
    304,
    "wait",
    {
      session_id: sessionId,
      return_when: { match: "winch:31 97" },
      safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
    },
  );
  expect(success(winch, "wait").outcome).toEqual({ condition_met: {} });

  const signaled = await requestAction(
    unrelated.client,
    unrelated.revision!,
    305,
    "signal",
    { session_id: sessionId, signal: "terminate" },
  );
  expect(success(signaled, "signal").signal).toBe("terminate");
  const waited = await requestAction(
    unrelated.client,
    unrelated.revision!,
    306,
    "wait",
    {
      session_id: sessionId,
      return_when: { exit: {} },
      safety_ceiling_ms: 5_000,
    },
  );
  expect(success(waited, "wait").outcome).toEqual({ exited: 37 });
  const output = await readSession(
    unrelated.client,
    unrelated.revision!,
    307,
    sessionId,
  );
  expect(output.output).toContain("term-trap");

  const closed = await requestAction(
    unrelated.client,
    unrelated.revision!,
    308,
    "close",
    { session_id: sessionId, policy: "graceful" },
  );
  expect(success(closed, "close").session).toMatchObject({
    lifecycle: "closed",
  });

  const gracefulTarget = await startNativeCommandFixture(
    unrelated.client,
    unrelated.revision!,
    309_000,
    {
      cwd: home,
      command:
        "exec /bin/sh -c 'trap \"printf graceful-trap; exit 0\" TERM; printf \"graceful-ready pid:%s\" \"$$\"; while :; do read line; done'",
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      returnWhen: { match: "graceful-ready" },
    },
  );
  const gracefulId = (
    gracefulTarget.session as { session_id: string }
  ).session_id;
  const gracefulBeforeClose = await readSession(
    unrelated.client,
    unrelated.revision!,
    310,
    gracefulId,
  );
  const gracefulPid = Number(gracefulBeforeClose.output.match(/pid:(\d+)/)?.[1]);
  expect(gracefulPid).toBeGreaterThan(0);
  const gracefulClose = await requestAction(
    unrelated.client,
    unrelated.revision!,
    311,
    "close",
    { session_id: gracefulId, policy: "graceful" },
  );
  expect(success(gracefulClose, "close").session).toMatchObject({
    lifecycle: "closed",
  });
  const staleRead = await requestAction(
    unrelated.client,
    unrelated.revision!,
    312,
    "read",
    { session_id: gracefulId, cursor: { segment: 1, offset: 0 } },
  );
  expect(failure(staleRead).code).toBe("authority_denied");
  await waitFor(() => !processExists(gracefulPid));
  expect(directChildPids(host.pid!)).toEqual([]);

  control.client.close();
  unrelated.client.close();
  expect(await waitForExit(host)).toBe(0);
  expect(existsSync(paths.socket)).toBe(false);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 8 + 60_000);

test.skipIf(process.platform !== "linux")(
  "signal reaches a child forked by a non-leader thread",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const proofPath = join(home, "thread-fork.proof");
    const termPath = join(home, "thread-fork.term");
    const fixture = buildThreadForkFixture();
    const host = startHost(home, undefined, 200);
    await waitFor(() => existsSync(paths.socket));
    const control = await handshake(paths.socket, { minimum: 4, current: 5 });
    let rootPid = 0;
    let childPid = 0;

    try {
      const started = await startNativeCommandFixture(
        control.client,
        control.revision!,
        312_900,
        {
          cwd: home,
          command:
            `exec ${JSON.stringify(fixture)} ${JSON.stringify(proofPath)} ` +
            JSON.stringify(termPath),
          shell: { executable: { path: "/bin/zsh", clean_start: true } },
          returnWhen: { match: "thread-fork-ready" },
        },
      );
      const sessionId = (started.session as { session_id: string }).session_id;
      await waitFor(() => existsSync(proofPath));
      const [rootText, workerText, childText] = readFileSync(proofPath, "utf8")
        .trim()
        .split(/\s+/);
      rootPid = Number(rootText);
      const workerTid = Number(workerText);
      childPid = Number(childText);
      const shellPid = Number(durableTerminalRecordFor(home, sessionId).pid);
      expect(rootPid).toBe(shellPid);
      expect(workerTid).toBeGreaterThan(0);
      expect(workerTid).not.toBe(rootPid);
      expect(childPid).toBeGreaterThan(0);
      const workerChildren = readFileSync(
        `/proc/${rootPid}/task/${workerTid}/children`,
        "utf8",
      ).trim().split(/\s+/).filter(Boolean).map(Number);
      const leaderChildren = readFileSync(
        `/proc/${rootPid}/task/${rootPid}/children`,
        "utf8",
      ).trim().split(/\s+/).filter(Boolean).map(Number);
      expect(workerChildren).toContain(childPid);
      expect(leaderChildren).not.toContain(childPid);
      expect(processGroupId(childPid)).not.toBe(processGroupId(rootPid));

      const signaled = await requestAction(
        control.client,
        control.revision!,
        312_901,
        "signal",
        { session_id: sessionId, signal: "terminate" },
      );
      expect(success(signaled, "signal").signal).toBe("terminate");
      await waitFor(
        () => readTextIfPresent(termPath) === "term",
        2_000,
      );
      await waitFor(() => !processExists(childPid), 5_000);
      const waited = await requestAction(
        control.client,
        control.revision!,
        312_902,
        "wait",
        {
          session_id: sessionId,
          return_when: { exit: {} },
          safety_ceiling_ms: 5_000,
        },
      );
      success(waited, "wait");
      const closed = await requestAction(
        control.client,
        control.revision!,
        312_903,
        "close",
        { session_id: sessionId, policy: "force" },
      );
      expect(success(closed, "close").session).toMatchObject({
        lifecycle: "closed",
      });
    } finally {
      for (const pid of [childPid, rootPid]) {
        if (pid <= 0 || !processExists(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      control.client.close();
      if (host.exitCode === null) await waitForExit(host);
    }
  },
  NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 3 + 30_000,
);

test("force close reports incomplete refresh descendant and shell delivery", async () => {
  if (!existsSync("/bin/zsh")) return;
  const stages = ["refresh", "outside_group", "shell_group"] as const;
  for (const [index, stage] of stages.entries()) {
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHost(home, undefined, TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS, {
      FIBER_TERMINAL_TEST_FAIL_SIGNAL_STAGE: stage,
    });
    await waitFor(() => existsSync(paths.socket));
    const control = await handshake(paths.socket, { minimum: 4, current: 5 });
    let shellPid = 0;

    try {
      const started = await startNativeCommandFixture(
        control.client,
        control.revision!,
        312_910 + index * 10,
        {
          cwd: home,
          command:
            `printf 'force-close-${stage}-ready\\n'; ` +
            "while :; do sleep 0.05; done",
          shell: { executable: { path: "/bin/zsh", clean_start: true } },
          returnWhen: { match: `force-close-${stage}-ready` },
        },
      );
      const sessionId = (started.session as { session_id: string }).session_id;
      shellPid = Number(durableTerminalRecordFor(home, sessionId).pid);
      const closed = await requestAction(
        control.client,
        control.revision!,
        312_911 + index * 10,
        "close",
        { session_id: sessionId, policy: "force" },
      );
      expect(failure(closed)).toMatchObject({
        action: "close",
        code: "session_lost",
        session_id: sessionId,
        retryable: false,
      });
      expect(durableTerminalRecordFor(home, sessionId)).toMatchObject({
        authority_revoked: true,
        lifecycle: "closed",
      });
      const inspect = await requestAction(
        control.client,
        control.revision!,
        312_912 + index * 10,
        "inspect",
        { session_id: sessionId },
      );
      expect(failure(inspect).code).toBe("authority_denied");
    } finally {
      if (shellPid > 0 && processExists(shellPid)) {
        try {
          process.kill(shellPid, "SIGKILL");
        } catch {}
      }
      control.client.close();
      if (host.exitCode === null) await waitForExit(host);
    }
  }
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 8 + 60_000);

test("signal reaches a background job outside the shell process group", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const proofPath = join(home, "background-signal.proof");
  const termPath = join(home, "background-signal.term");
  const stopPath = join(home, "background-signal.stop");
  const scriptPath = join(home, "background-signal.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
trap 'printf term > ${JSON.stringify(termPath)}; exit 0' TERM
printf '%s %s %s\n' "$$" "$PPID" "$(ps -o pgid= -p $$ | tr -d ' ')" > ${JSON.stringify(proofPath)}
while [ ! -e ${JSON.stringify(stopPath)} ]; do sleep 0.05; done
`,
  );
  chmodSync(scriptPath, 0o700);

  const host = startHost(home, undefined, 200);
  await waitFor(() => existsSync(paths.socket));
  const control = await handshake(paths.socket, { minimum: 4, current: 5 });
  let targetPid = 0;

  try {
    const started = await startNativeCommandFixture(
      control.client,
      control.revision!,
      313_000,
      {
        cwd: home,
        command:
          `${JSON.stringify(scriptPath)} & child=$!; ` +
          `while [ ! -s ${JSON.stringify(proofPath)} ]; do sleep 0.05; done; ` +
          "printf 'background-signal-ready\\n'; wait \"$child\"",
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        returnWhen: { match: "background-signal-ready" },
      },
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    const [pidText, parentText, pgidText] = readFileSync(proofPath, "utf8")
      .trim()
      .split(/\s+/);
    targetPid = Number(pidText);
    const targetParentPid = Number(parentText);
    const targetPgid = Number(pgidText);
    const shellPid = Number(durableTerminalRecordFor(home, sessionId).pid);
    expect(targetPid).toBeGreaterThan(0);
    expect(targetParentPid).toBe(shellPid);
    expect(targetPgid).toBe(processGroupId(targetPid));
    expect(targetPgid).not.toBe(processGroupId(shellPid));

    const signaled = await requestAction(
      control.client,
      control.revision!,
      313_010,
      "signal",
      { session_id: sessionId, signal: "terminate" },
    );
    expect(success(signaled, "signal").signal).toBe("terminate");
    await waitFor(
      () => readTextIfPresent(termPath) === "term",
      2_000,
    );
    expect(readFileSync(termPath, "utf8")).toBe("term");
    await waitFor(() => !processExists(targetPid), 5_000);
  } finally {
    writeFileSync(stopPath, "");
    if (targetPid > 0 && processExists(targetPid)) {
      await waitFor(() => !processExists(targetPid), 5_000).catch(() => {
        try {
          process.kill(targetPid, "SIGKILL");
        } catch {}
      });
    }
    control.client.close();
    if (host.exitCode === null) await waitForExit(host);
  }
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 3 + 30_000);

test("force close reaches a background job outside the shell process group", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const proofPath = join(home, "background-force-close.proof");
  const stopPath = join(home, "background-force-close.stop");
  const scriptPath = join(home, "background-force-close.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s %s %s\n' "$$" "$PPID" "$(ps -o pgid= -p $$ | tr -d ' ')" > ${JSON.stringify(proofPath)}
while [ ! -e ${JSON.stringify(stopPath)} ]; do sleep 0.05; done
`,
  );
  chmodSync(scriptPath, 0o700);

  const host = startHost(home, undefined, 200);
  await waitFor(() => existsSync(paths.socket));
  const control = await handshake(paths.socket, { minimum: 4, current: 5 });
  let shellPid = 0;
  let targetPid = 0;

  try {
    const started = await startNativeCommandFixture(
      control.client,
      control.revision!,
      313_020,
      {
        cwd: home,
        command:
          `${JSON.stringify(scriptPath)} & child=$!; ` +
          `while [ ! -s ${JSON.stringify(proofPath)} ]; do sleep 0.05; done; ` +
          "printf 'background-force-close-ready\\n'; wait \"$child\"",
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        returnWhen: { match: "background-force-close-ready" },
      },
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    const [pidText, parentText, pgidText] = readFileSync(proofPath, "utf8")
      .trim()
      .split(/\s+/);
    targetPid = Number(pidText);
    const targetParentPid = Number(parentText);
    const targetPgid = Number(pgidText);
    shellPid = Number(durableTerminalRecordFor(home, sessionId).pid);
    expect(targetPid).toBeGreaterThan(0);
    expect(targetParentPid).toBe(shellPid);
    expect(targetPgid).toBe(processGroupId(targetPid));
    expect(targetPgid).not.toBe(processGroupId(shellPid));

    const closed = await requestAction(
      control.client,
      control.revision!,
      313_030,
      "close",
      { session_id: sessionId, policy: "force" },
    );
    expect(success(closed, "close").session).toMatchObject({
      lifecycle: "closed",
    });
    await waitFor(() => !processExists(shellPid), 5_000);
    await waitFor(() => !processExists(targetPid), 5_000);
  } finally {
    writeFileSync(stopPath, "");
    if (targetPid > 0 && processExists(targetPid)) {
      try {
        process.kill(targetPid, "SIGKILL");
      } catch {}
    }
    if (shellPid > 0 && processExists(shellPid)) {
      try {
        process.kill(shellPid, "SIGKILL");
      } catch {}
    }
    control.client.close();
    if (host.exitCode === null) await waitForExit(host);
  }
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 3 + 30_000);

test.skipIf(!tmuxAvailable())(
  "malformed close recovery cleans only its tmux owner and preserves a live sibling",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const firstHost = startHost(home, undefined, 30_000);
    const firstStdout = streamText(firstHost.stdout);
    const firstStderr = streamText(firstHost.stderr);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const valid = await startCommand(first.client, first.revision!, 313, {
      cwd: home,
      command:
        "printf 'valid-close-sibling-ready\\n'; while IFS= read -r line; do printf 'valid-close-sibling:%s\\n' \"$line\"; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "valid-close-sibling-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const invalid = await startCommand(first.client, first.revision!, 314, {
      cwd: home,
      command: "printf 'invalid-close-owner-ready\\n'; sleep 30",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "invalid-close-owner-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const validId = (valid.session as { session_id: string }).session_id;
    const invalidId = (invalid.session as { session_id: string }).session_id;
    const stateDir = join(
      home,
      ".fiber",
      "sessions",
      TERMINAL_OWNER_SESSION,
      "terminal",
      "state",
    );
    const recordFor = (sessionId: string) => JSON.parse(readFileSync(
      join(stateDir, `record-${sessionId}.json`),
      "utf8",
    )) as { backend_identity: string };
    const validIdentity = recordFor(validId).backend_identity;
    const invalidIdentity = recordFor(invalidId).backend_identity;
    const tmuxSocket = terminalTransportPaths(home).tmuxSocket;
    const panePidFor = (identity: string) => Number(execFileSync(
      "tmux",
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        `fiber-${identity}`,
        "#{pane_pid}",
      ],
      { encoding: "utf8" },
    ).trim());
    const validPanePid = panePidFor(validIdentity);
    const invalidPanePid = panePidFor(invalidIdentity);
    writeFileSync(
      join(stateDir, `close-transaction-${invalidId}.json`),
      "{",
      { mode: 0o600 },
    );

    const oldIdentity = readFileSync(paths.identity, "utf8");
    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);
    expect(await firstStdout).toBe("");
    expect(await firstStderr).toBe("");
    expect(processExists(validPanePid)).toBe(true);
    expect(processExists(invalidPanePid)).toBe(true);

    const replacement = startHost(home, undefined, 5_000);
    const replacementStdout = streamText(replacement.stdout);
    const replacementStderr = streamText(replacement.stderr);
    await waitFor(() =>
      existsSync(paths.socket) && fileDiffersFrom(paths.identity, oldIdentity)
    , 8_000);
    const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
    const listed = success(await requestAction(
      recovered.client,
      recovered.revision!,
      315,
      "list",
      {},
    ), "list") as {
      sessions: Array<{
        session_id: string;
        lifecycle: string;
      }>;
    };
    await waitFor(() => !processExists(invalidPanePid), 5_000);
    expect(processExists(validPanePid)).toBe(true);
    const sessionNames = execFileSync(
      "tmux",
      ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    ).trim().split("\n");
    expect(sessionNames).toEqual([`fiber-${validIdentity}`]);
    expect(existsSync(`/tmp/fiber-tmux-capture-${invalidIdentity}.sock`)).toBe(
      false,
    );
    expect(existsSync(`/tmp/fiber-tmux-marker-${invalidIdentity}.sock`)).toBe(
      false,
    );
    expect(readdirSync(stateDir)).not.toContain(
      `close-transaction-${invalidId}.json`,
    );

    expect(listed.sessions).toContainEqual(expect.objectContaining({
      session_id: validId,
      lifecycle: "running",
    }));
    expect(listed.sessions).toContainEqual(expect.objectContaining({
      session_id: invalidId,
      lifecycle: "closed",
    }));
    const invalidInspect = await requestAction(
      recovered.client,
      recovered.revision!,
      316,
      "inspect",
      { session_id: invalidId },
    );
    expect(failure(invalidInspect).code).toBe("authority_denied");
    success(await requestAction(
      recovered.client,
      recovered.revision!,
      317,
      "write",
      { session_id: validId, payload: { text: "still-live\n" } },
    ), "write");
    const waited = success(await requestAction(
      recovered.client,
      recovered.revision!,
      318,
      "wait",
      {
        session_id: validId,
        return_when: { match: "valid-close-sibling:still-live" },
        safety_ceiling_ms: 5_000,
      },
    ), "wait");
    expect(waited.outcome).toEqual({ condition_met: {} });

    success(await requestAction(
      recovered.client,
      recovered.revision!,
      319,
      "close",
      { session_id: validId, policy: "force" },
    ), "close");
    await waitFor(() => !existsSync(tmuxSocket), 5_000);
    recovered.client.close();
    expect(await waitForExit(replacement)).toBe(0);
    expect(await replacementStdout).toBe("");
    expect(await replacementStderr).toBe("");
  },
  30_000,
);

test.skipIf(!tmuxAvailable())(
  "checked cleanup failure wins over incomplete delivery and retains recovery intent",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const firstHost = startHost(home, undefined, 30_000, {
      FIBER_TERMINAL_TEST_FAIL_TMUX_CLOSE_CLEANUP: "1",
      FIBER_TERMINAL_TEST_FAIL_SIGNAL_STAGE: "outside_group",
    });
    const firstStdout = streamText(firstHost.stdout);
    const firstStderr = streamText(firstHost.stderr);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const firstIdentity = readFileSync(paths.identity, "utf8");
    const sibling = await startCommand(first.client, first.revision!, 336, {
      cwd: home,
      command:
        "printf 'live-sibling-ready\\n'; while IFS= read -r line; do printf 'live-sibling:%s\\n' \"$line\"; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "live-sibling-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const closing = await startCommand(first.client, first.revision!, 337, {
      cwd: home,
      command: "printf 'live-close-ready\\n'; sleep 30",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "live-close-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const siblingId = (sibling.session as { session_id: string }).session_id;
    const closingId = (closing.session as { session_id: string }).session_id;
    const stateDir = join(
      home,
      ".fiber",
      "sessions",
      TERMINAL_OWNER_SESSION,
      "terminal",
      "state",
    );
    const recordFor = (sessionId: string) => JSON.parse(readFileSync(
      join(stateDir, `record-${sessionId}.json`),
      "utf8",
    )) as {
      authority_revoked: boolean;
      backend_identity: string;
      lifecycle: string;
    };
    const siblingIdentity = recordFor(siblingId).backend_identity;
    const closingIdentity = recordFor(closingId).backend_identity;
    const tmuxSocket = terminalTransportPaths(home).tmuxSocket;
    const transactionName = `close-transaction-${closingId}.json`;

    const closeStartedAt = Date.now();
    const failedClose = await requestAction(
      first.client,
      first.revision!,
      338,
      "close",
      { session_id: closingId, policy: "force" },
    );
    expect(Date.now() - closeStartedAt).toBeLessThan(8_000);
    expect(failure(failedClose)).toMatchObject({
      action: "close",
      code: "invalid_request",
    });
    expect(recordFor(closingId)).toMatchObject({
      authority_revoked: true,
      lifecycle: "running",
    });
    expect(readdirSync(stateDir)).toContain(transactionName);
    expect(existsSync(tmuxSocket)).toBe(true);
    const retainedPane = execFileSync(
      "tmux",
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        `fiber-${closingIdentity}`,
        "#{pane_id}|#{pane_dead}",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(retainedPane).toMatch(/^%\d+\|[01]$/);
    execFileSync(
      "tmux",
      ["-S", tmuxSocket, "has-session", "-t", `fiber-${siblingIdentity}`],
    );
    success(await requestAction(
      first.client,
      first.revision!,
      339,
      "write",
      { session_id: siblingId, payload: { text: "before-restart\n" } },
    ), "write");
    const beforeRestart = success(await requestAction(
      first.client,
      first.revision!,
      340,
      "wait",
      {
        session_id: siblingId,
        return_when: { match: "live-sibling:before-restart" },
        safety_ceiling_ms: 5_000,
      },
    ), "wait");
    expect(beforeRestart.outcome).toEqual({ condition_met: {} });

    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);
    expect(await firstStdout).toBe("");
    expect(await firstStderr).toBe("");

    const replacement = startHost(home, undefined, 1_000);
    const replacementStdout = streamText(replacement.stdout);
    const replacementStderr = streamText(replacement.stderr);
    await waitFor(
      () => existsSync(paths.socket) && fileDiffersFrom(paths.identity, firstIdentity),
      8_000,
    );
    const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
    success(await requestAction(
      recovered.client,
      recovered.revision!,
      341,
      "write",
      { session_id: siblingId, payload: { text: "after-restart\n" } },
    ), "write");
    expect(readdirSync(stateDir)).not.toContain(transactionName);
    expect(existsSync(tmuxSocket)).toBe(true);
    const names = execFileSync(
      "tmux",
      ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    ).trim().split("\n");
    expect(names).toEqual([`fiber-${siblingIdentity}`]);
    const afterRestart = success(await requestAction(
      recovered.client,
      recovered.revision!,
      342,
      "wait",
      {
        session_id: siblingId,
        return_when: { match: "live-sibling:after-restart" },
        safety_ceiling_ms: 5_000,
      },
    ), "wait");
    expect(afterRestart.outcome).toEqual({ condition_met: {} });
    success(await requestAction(
      recovered.client,
      recovered.revision!,
      343,
      "close",
      { session_id: siblingId, policy: "force" },
    ), "close");
    await waitFor(() => !existsSync(tmuxSocket), 5_000);
    recovered.client.close();
    expect(await waitForExit(replacement)).toBe(0);
    expect(await replacementStdout).toBe("");
    expect(await replacementStderr).toBe("");
  },
  40_000,
);

test.skipIf(!tmuxAvailable())(
  "checked tmux close recovery retains cleanup intent until a clean retry",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const firstHost = startHost(home, undefined, 30_000, {
      FIBER_TERMINAL_TEST_INTERRUPT_CLOSE_AFTER_COMMIT: "1",
    });
    const firstStdout = streamText(firstHost.stdout);
    const firstStderr = streamText(firstHost.stderr);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const sibling = await startCommand(first.client, first.revision!, 330, {
      cwd: home,
      command:
        "printf 'checked-sibling-ready\\n'; while IFS= read -r line; do printf 'checked-sibling:%s\\n' \"$line\"; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "checked-sibling-ready" },
      waitMs: 8_000,
    });
    const closing = await startCommand(first.client, first.revision!, 331, {
      cwd: home,
      command: "printf 'checked-close-ready\\n'; sleep 30",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "checked-close-ready" },
      waitMs: 8_000,
    });
    const siblingId = (sibling.session as { session_id: string }).session_id;
    const closingId = (closing.session as { session_id: string }).session_id;
    const stateDir = join(
      home,
      ".fiber",
      "sessions",
      TERMINAL_OWNER_SESSION,
      "terminal",
      "state",
    );
    const recordFor = (sessionId: string) => JSON.parse(readFileSync(
      join(stateDir, `record-${sessionId}.json`),
      "utf8",
    )) as { backend_identity: string; lifecycle: string };
    const siblingIdentity = recordFor(siblingId).backend_identity;
    const closingIdentity = recordFor(closingId).backend_identity;
    const tmuxSocket = terminalTransportPaths(home).tmuxSocket;
    const panePidFor = (identity: string) => Number(execFileSync(
      "tmux",
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        `fiber-${identity}`,
        "#{pane_pid}",
      ],
      { encoding: "utf8" },
    ).trim());
    const siblingPanePid = panePidFor(siblingIdentity);
    const closingPanePid = panePidFor(closingIdentity);
    const transactionName = `close-transaction-${closingId}.json`;

    const interrupted = await requestAction(
      first.client,
      first.revision!,
      332,
      "close",
      { session_id: closingId, policy: "force" },
    );
    expect(failure(interrupted)).toMatchObject({
      action: "close",
      code: "invalid_request",
    });
    expect(recordFor(closingId).lifecycle).toBe("running");
    expect(readdirSync(stateDir)).toContain(transactionName);
    expect(processExists(closingPanePid)).toBe(true);
    expect(processExists(siblingPanePid)).toBe(true);

    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);
    expect(await firstStdout).toBe("");
    expect(await firstStderr).toBe("");

    const failedRecovery = startHost(home, undefined, 30_000, {
      FIBER_TERMINAL_TEST_FAIL_TMUX_CLOSE_CLEANUP: "1",
    });
    const failedStdout = streamText(failedRecovery.stdout);
    const failedStderr = streamText(failedRecovery.stderr);
    expect(await waitForExit(failedRecovery)).not.toBe(0);
    expect(await failedStdout).toBe("");
    expect(await failedStderr).toBe("");
    expect(recordFor(closingId).lifecycle).toBe("closed");
    expect(readdirSync(stateDir)).toContain(transactionName);
    expect(processExists(closingPanePid)).toBe(true);
    expect(processExists(siblingPanePid)).toBe(true);
    execFileSync(
      "tmux",
      ["-S", tmuxSocket, "has-session", "-t", `fiber-${closingIdentity}`],
    );
    execFileSync(
      "tmux",
      ["-S", tmuxSocket, "has-session", "-t", `fiber-${siblingIdentity}`],
    );

    const replacement = startHost(home, undefined, 500);
    const replacementStdout = streamText(replacement.stdout);
    const replacementStderr = streamText(replacement.stderr);
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity), 8_000);
    const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
    success(await requestAction(
      recovered.client,
      recovered.revision!,
      333,
      "write",
      { session_id: siblingId, payload: { text: "survived\n" } },
    ), "write");
    await waitFor(() => !processExists(closingPanePid), 5_000);
    expect(processExists(siblingPanePid)).toBe(true);
    expect(readdirSync(stateDir)).not.toContain(transactionName);
    execFileSync(
      "tmux",
      ["-S", tmuxSocket, "has-session", "-t", `fiber-${siblingIdentity}`],
    );
    const names = execFileSync(
      "tmux",
      ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    ).trim().split("\n");
    expect(names).toEqual([`fiber-${siblingIdentity}`]);

    const waited = success(await requestAction(
      recovered.client,
      recovered.revision!,
      334,
      "wait",
      {
        session_id: siblingId,
        return_when: { match: "checked-sibling:survived" },
        safety_ceiling_ms: 5_000,
      },
    ), "wait");
    expect(waited.outcome).toEqual({ condition_met: {} });
    success(await requestAction(
      recovered.client,
      recovered.revision!,
      335,
      "close",
      { session_id: siblingId, policy: "force" },
    ), "close");
    await waitFor(() => !existsSync(tmuxSocket), 5_000);
    recovered.client.close();
    expect(await waitForExit(replacement)).toBe(0);
    expect(await replacementStdout).toBe("");
    expect(await replacementStderr).toBe("");
  },
  40_000,
);

test(
  "reopened cancellation reports open failure and terminates an abandoned response",
  async () => {
    const error = "InjectedCancellationOpenFailure";
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const firstHost = startHost(home, undefined, 30_000);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const started = await startCommand(first.client, first.revision!, 334, {
      cwd: home,
      command: "sleep 30",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
    });
    const sessionId = (started.session as { session_id: string }).session_id;
    const oldIdentity = readFileSync(paths.identity, "utf8");
    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);

    const trace = join(home, `reopened-cancellation-${error}.log`);
    const barrier = join(home, `reopened-cancellation-${error}`);
    const replacement = startHost(home, undefined, 5000, {
      // 300ms races the final force-close handshake below against idle
      // retirement once the failed open leaves no clients or live work;
      // the scheduling lost deterministically on some machines. The case
      // proves force-close-after-failure, not idle timing.
      FIBER_TRACE_LOG: trace,
      FIBER_TRACE_SCOPES: "terminal_host",
      FIBER_TERMINAL_TEST_ORDER_BARRIER: barrier,
      FIBER_TERMINAL_TEST_ORDER_HOLD_CORRELATION: "335",
      FIBER_TERMINAL_TEST_FAIL_CANCELLATION_OPEN: "1",
    });
    await waitFor(() =>
      existsSync(paths.socket) && fileDiffersFrom(paths.identity, oldIdentity)
    );
    const reopened = await handshake(paths.socket, { minimum: 4, current: 5 });
    reopened.client.send(encodeFrame(
      reopened.revision!,
      1,
      actionSubjects.resize,
      335,
      { request: { resize: withAuthority("resize", {
        session_id: sessionId,
        dimensions: { rows: 25, columns: 81 },
      }) } },
      1,
    ));
    await waitFor(() => existsSync(`${barrier}.335.ready`));
    reopened.client.send(encodeFrame(
      reopened.revision!,
      4,
      0,
      335,
      { cancel: {} },
    ));
    await expect(reopened.client.read()).rejects.toThrow("socket closed");
    await waitFor(() =>
      readTextIfPresent(trace)?.includes(
        `cancellation persistence failed correlation=335 session=${sessionId} err=${error}`,
      ) ?? false,
    );

    const cleanup = await handshake(paths.socket, { minimum: 4, current: 5 });
    success(await requestAction(cleanup.client, cleanup.revision!, 336, "close", {
      session_id: sessionId,
      policy: "force",
    }), "close");
    cleanup.client.close();
    expect(await waitForExit(replacement)).toBe(0);
  },
  25_000,
);

test("interactive writes preserve mappings and large output rotates durable segments", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(
    home,
    undefined,
    NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 3,
  );
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

  const interactive = await finishStartupObservation(
    connected.client,
    connected.revision!,
    400_001,
    await startCommand(connected.client, connected.revision!, 400_000, {
      cwd: home,
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      backend: "native",
      returnWhen: { started: {} },
      waitMs: NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
    }),
    "native",
    { started: {} },
    NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2,
  );
  const interactiveId = (
    interactive.session as { session_id: string }
  ).session_id;
  await requestAction(connected.client, connected.revision!, 401, "write", {
    session_id: interactiveId,
    payload: { text: "printf 'text-write force-pid:%s\\\\n' \"$$\"" },
  });
  await requestAction(connected.client, connected.revision!, 402, "write", {
    session_id: interactiveId,
    payload: { keys: ["enter"] },
  });
  await requestAction(connected.client, connected.revision!, 403, "write", {
    session_id: interactiveId,
    payload: { text: "printf 'interrupt-%s\\\\n' running; sleep 30" },
  });
  await requestAction(connected.client, connected.revision!, 404, "write", {
    session_id: interactiveId,
    payload: { keys: ["enter"] },
  });
  // Poll for running evidence before interrupting: the accepted_bytes
  // assert below passes on mere queue acceptance, so require proof the
  // command reached the shell first.
  const interruptReady = await requestAction(
    connected.client,
    connected.revision!,
    405,
    "wait",
    {
      session_id: interactiveId,
      return_when: { match: "interrupt-running" },
      safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
    },
  );
  expect(success(interruptReady, "wait").outcome).toEqual({ condition_met: {} });
  const interrupted = await requestAction(
    connected.client,
    connected.revision!,
    406,
    "write",
    {
      session_id: interactiveId,
      payload: { controls: [{ character: 99 }] },
    },
  );
  expect(success(interrupted, "write").accepted_bytes).toBe(1);
  await requestAction(connected.client, connected.revision!, 407, "write", {
    session_id: interactiveId,
    payload: { paste: "printf 'paste-write\\n'\r" },
  });
  const matched = await requestAction(
    connected.client,
    connected.revision!,
    408,
    "wait",
    {
      session_id: interactiveId,
      return_when: { match: "paste-write" },
      safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
    },
  );
  expect(success(matched, "wait").outcome).toEqual({ condition_met: {} });
  const interactiveOutput = await readSession(
    connected.client,
    connected.revision!,
    409,
    interactiveId,
  );
  expect(interactiveOutput.output).toContain("text-write");
  expect(interactiveOutput.output).toContain("paste-write");
  const forcePid = Number(
    interactiveOutput.output.match(/force-pid:(\d+)/)?.[1],
  );
  expect(forcePid).toBeGreaterThan(0);
  const forceClosed = await requestAction(
    connected.client,
    connected.revision!,
    410,
    "close",
    {
      session_id: interactiveId,
      policy: "force",
    },
  );
  expect(success(forceClosed, "close").session).toMatchObject({
    lifecycle: "closed",
  });
  await waitFor(() => !processExists(forcePid));
  expect(directChildPids(host.pid!)).toEqual([]);

  const large = await startNativeCommandFixture(
    connected.client,
    connected.revision!,
    410_000,
    {
      cwd: home,
      command: "head -c 1100000 /dev/zero | tr '\\\\0' x",
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      returnWhen: { exit: {} },
      waitMs: 15_000,
    },
  );
  expect(large.outcome).toEqual({ exited: 0 });
  const largeId = (large.session as { session_id: string }).session_id;
  let offset = 0;
  let retained = "";
  let largeFacts: Record<string, unknown> | undefined;
  while (true) {
    const page = await readSession(
      connected.client,
      connected.revision!,
      411 + offset,
      largeId,
      offset,
    );
    retained += page.output;
    offset += Buffer.byteLength(page.output);
    largeFacts = page.session;
    const cursor = page.session.output_cursor as { segment: number; offset: number };
    expect(cursor.segment).toBe(1);
    if (offset === cursor.offset) break;
    expect(page.output.length).toBeGreaterThan(0);
  }
  expect(retained).toBe("\0".repeat(1_100_000));
  expect(largeFacts?.raw_gap).toBeNull();

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 10 + 30_000);

test("completed sessions recycle capacity and release every native backend resource", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  let connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const baselineFds = processFdCount(host.pid!);
  let correlation = 450;
  let firstSessionId = "";

  for (let cycle = 0; cycle < 20; cycle++) {
    if (cycle > 0 && cycle % 8 === 0) {
      connected.client.close();
      connected = await handshake(paths.socket, { minimum: 4, current: 5 });
    }
    const started = await startNativeCommandFixture(
      connected.client,
      connected.revision!,
      correlation,
      {
        cwd: home,
        command: `printf 'cycle-${cycle}-pid:%s' "$$"; exit 0`,
        shell: {
          executable: { path: "/bin/zsh", clean_start: true },
        },
        returnWhen: { exit: {} },
      },
    );
    correlation += 6;
    const sessionId = (started.session as { session_id: string }).session_id;
    expect(started.outcome).toEqual({ exited: 0 });
    const output = (
      await readSession(
        connected.client,
        connected.revision!,
        correlation++,
        sessionId,
      )
    ).output;
    const targetPid = Number(
      output.match(new RegExp(`cycle-${cycle}-pid:(\\d+)`))?.[1],
    );
    expect(targetPid).toBeGreaterThan(0);
    if (cycle === 0) {
      firstSessionId = sessionId;
    }
    await waitFor(() => !processExists(targetPid));
    const closed = await requestAction(
      connected.client,
      connected.revision!,
      correlation++,
      "close",
      { session_id: sessionId, policy: "graceful" },
    );
    expect(success(closed, "close").session).toMatchObject({
      lifecycle: "closed",
    });
  }

  await waitFor(() => directChildPids(host.pid!).length === 0);
  await Bun.sleep(50);
  expect(processFdCount(host.pid!)).toBeLessThanOrEqual(baselineFds + 2);
  const historicalList = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "list",
    {},
  );
  expect(
    (success(historicalList, "list").sessions as Array<{
      session_id: string;
      lifecycle: string;
    }>),
  ).toContainEqual(expect.objectContaining({
    session_id: firstSessionId,
    lifecycle: "closed",
  }));

  const historicalRead = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "read",
    { session_id: firstSessionId, cursor: { segment: 1, offset: 0 } },
  );
  expect(failure(historicalRead).code).toBe("authority_denied");
  const historicalInspect = await requestAction(
    connected.client,
    connected.revision!,
    correlation++,
    "inspect",
    { session_id: firstSessionId },
  );
  expect(failure(historicalInspect).code).toBe("authority_denied");

  connected.client.close();
  const previousIdentity = readFileSync(paths.identity, "utf8");
  host.kill("SIGKILL");
  await waitForExit(host);

  const replacement = startHost(home, undefined, 10_000);
  await waitFor(
    () => fileDiffersFrom(paths.identity, previousIdentity),
    10_000,
  );
  const reopened = await handshake(paths.socket, { minimum: 4, current: 5 });
  const reopenedRead = await requestAction(
    reopened.client,
    reopened.revision!,
    correlation++,
    "read",
    { session_id: firstSessionId, cursor: { segment: 1, offset: 0 } },
  );
  expect(failure(reopenedRead).code).toBe("authority_denied");
  const reopenedInspect = await requestAction(
    reopened.client,
    reopened.revision!,
    correlation++,
    "inspect",
    { session_id: firstSessionId },
  );
  expect(failure(reopenedInspect).code).toBe("authority_denied");
  const reopenedList = await requestAction(
    reopened.client,
    reopened.revision!,
    correlation++,
    "list",
    {},
  );
  expect(
    (success(reopenedList, "list").sessions as Array<{
      session_id: string;
      lifecycle: string;
    }>),
  ).toContainEqual(expect.objectContaining({
    session_id: firstSessionId,
    lifecycle: "closed",
  }));
  reopened.client.close();
  replacement.kill("SIGKILL");
  await waitForExit(replacement);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 8 + 120_000);

test("host remains authoritative until natural backend cleanup finishes", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 40, {
    FIBER_TERMINAL_TEST_BACKEND_CLEANUP_DELAY_MS: "500",
  });
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const started = await startNativeCommandFixture(
    connected.client,
    connected.revision!,
    480_000,
    {
      cwd: home,
      command: "printf cleanup-running; IFS= read -r _; exit 0",
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      returnWhen: { match: "cleanup-running" },
    },
  );
  expect(started.outcome).toEqual({ condition_met: {} });
  const sessionId = (started.session as { session_id: string }).session_id;
  success(await requestAction(connected.client, connected.revision!, 481, "write", {
    session_id: sessionId,
    payload: { text: "\n" },
  }), "write");
  connected.client.close();

  await Bun.sleep(250);
  expect(host.exitCode).toBeNull();
  expect(existsSync(paths.socket)).toBe(true);
  expect(existsSync(paths.identity)).toBe(true);
  let duringCleanup: Awaited<ReturnType<typeof handshake>> | null = null;
  let lastHandshakeError: unknown = null;
  const cleanupHandshakeDeadline = Date.now() + 5_000;
  while (duringCleanup === null && Date.now() < cleanupHandshakeDeadline) {
    try {
      duringCleanup = await Promise.race([
        handshake(paths.socket, { minimum: 4, current: 5 }),
        Bun.sleep(1_000).then((): null => {
          throw new Error("handshake attempt timed out");
        }),
      ]);
    } catch (error) {
      lastHandshakeError = error;
      await Bun.sleep(25);
    }
  }
  if (duringCleanup === null) {
    throw new Error(
      `host stopped accepting during backend cleanup: ${String(lastHandshakeError)}`,
    );
  }
  expect(duringCleanup.revision).toBe(5);
  duringCleanup.client.close();

  expect(await waitForExit(host)).toBe(0);
  expect(existsSync(paths.socket)).toBe(false);
  expect(existsSync(paths.identity)).toBe(false);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2 + 30_000);

test("process-token capture failure kills and reaps before returning failure", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const pidFile = join(home, "token-target.pid");
  const host = startHost(
    home,
    undefined,
    NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 4,
    { FIBER_TERMINAL_FIXTURE_FAIL_PROCESS_TOKEN: "1" },
    buildCurrentClientFixture(),
  );
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const startedAt = Date.now();
  let result: WireFrame | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await requestAction(
      connected.client,
      connected.revision!,
      490 + attempt * 10_000,
      "start",
      {
        cwd: home,
        command:
          `printf '%s' "$$" > '${pidFile}'; exec /bin/sleep 30`,
        shell: {
          executable: { path: "/bin/zsh", clean_start: true },
        },
        backend: "native",
        return_when: { exit: {} },
        wait_ceiling_ms: NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
        dimensions: { rows: 24, columns: 80 },
      },
    );
    if (failureCode(result) !== undefined) break;
    const started = success(result, "start");
    expect(started.outcome).toEqual({ safety_ceiling: {} });
    if (attempt === 0) {
      console.error("Retrying process-token failure fixture after startup observation ceiling");
      await forceCloseTerminalFixture(
        connected.client,
        connected.revision!,
        499,
        (started.session as { session_id: string }).session_id,
      );
    }
  }
  expect(result).toBeDefined();
  expect(failure(result!)).toMatchObject({
    action: "start",
    code: "process_identity_unavailable",
  });
  expect(Date.now() - startedAt).toBeLessThan(
    NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2 + 5_000,
  );
  if (existsSync(pidFile)) {
    const targetPid = Number(readFileSync(pidFile, "utf8"));
    expect(targetPid).toBeGreaterThan(0);
    await waitFor(() => !processExists(targetPid));
  }
  await waitFor(() => directChildPids(host.pid!).length === 0);

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 3 + 30_000);

test.skipIf(!tmuxAvailable())(
  "owner catalog keeps every matching session after the first exits and closes",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHost(home, undefined, 10_000);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

    const first = await startInteractiveNativeFixture(
      connected.client,
      connected.revision!,
      490_000,
      {
        cwd: home,
        command: "printf first-catalog-ready; IFS= read -r _; exit 0",
        marker: "first-catalog-ready",
      },
    );
    const second = await startCommand(connected.client, connected.revision!, 491, {
      cwd: home,
      command: "printf second-catalog-ready; sleep 30",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "second-catalog-ready" },
      waitMs: 8_000,
    });
    const firstId = (first.session as { session_id: string }).session_id;
    const secondId = (second.session as { session_id: string }).session_id;

    const bothRunning = success(
      await requestAction(connected.client, connected.revision!, 492, "list", {}),
      "list",
    ).sessions as Array<Record<string, unknown>>;
    expect(bothRunning).toContainEqual(expect.objectContaining({
      session_id: firstId,
      lifecycle: "running",
    }));
    expect(bothRunning).toContainEqual(expect.objectContaining({
      session_id: secondId,
      lifecycle: "running",
    }));

    success(await requestAction(connected.client, connected.revision!, 492_000, "write", {
      session_id: firstId,
      payload: { text: "\n" },
    }), "write");
    const firstExit = success(
      await requestAction(connected.client, connected.revision!, 493, "wait", {
        session_id: firstId,
        return_when: { exit: {} },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(firstExit.outcome).toEqual({ exited: 0 });
    const afterExit = success(
      await requestAction(connected.client, connected.revision!, 494, "list", {}),
      "list",
    ).sessions as Array<Record<string, unknown>>;
    expect(afterExit).toContainEqual(expect.objectContaining({
      session_id: firstId,
      lifecycle: "exited",
    }));
    expect(afterExit).toContainEqual(expect.objectContaining({
      session_id: secondId,
      lifecycle: "running",
    }));

    await requestAction(connected.client, connected.revision!, 495, "close", {
      session_id: firstId,
      policy: "graceful",
    });
    const afterClose = success(
      await requestAction(connected.client, connected.revision!, 496, "list", {}),
      "list",
    ).sessions as Array<Record<string, unknown>>;
    expect(afterClose).toContainEqual(expect.objectContaining({
      session_id: firstId,
      lifecycle: "closed",
    }));
    expect(afterClose).toContainEqual(expect.objectContaining({
      session_id: secondId,
      lifecycle: "running",
    }));

    let filterCorrelation = 497;
    for (const [filters, expectedIds, excludedIds] of [
      [{ lifecycle: "running" }, [secondId], [firstId]],
      [{ backend: "tmux" }, [secondId], [firstId]],
      [{ backend: "native" }, [firstId], [secondId]],
      [{ workspace_root: home }, [firstId, secondId], []],
      [{ task_id: TERMINAL_OWNER_SESSION }, [firstId, secondId], []],
    ] as const) {
      const sessions = success(
        await requestAction(
          connected.client,
          connected.revision!,
          filterCorrelation++,
          "list",
          filters,
        ),
        "list",
      ).sessions as Array<{ session_id: string }>;
      const sessionIds = sessions.map(({ session_id }) => session_id);
      for (const expectedId of expectedIds) {
        expect(sessionIds).toContain(expectedId);
      }
      for (const excludedId of excludedIds) {
        expect(sessionIds).not.toContain(excludedId);
      }
    }

    const validOwnerAuthority = ownerCatalogAuthorityForSession(
      firstId,
      authorityBySession.get(firstId)!,
    );
    const foreignPrincipal = structuredClone(validOwnerAuthority) as {
      principal: { workspace_root: string };
    };
    foreignPrincipal.principal.workspace_root = `${home}-foreign`;
    expect(failure(await requestAction(
      connected.client,
      connected.revision!,
      600,
      "list",
      { owner_authority: foreignPrincipal },
    )).code).toBe("authority_denied");
    const forgedProof = structuredClone(validOwnerAuthority) as {
      proof: { bytes: number[] };
    };
    forgedProof.proof.bytes[0] = 12;
    expect(failure(await requestAction(
      connected.client,
      connected.revision!,
      601,
      "list",
      { owner_authority: forgedProof },
    )).code).toBe("authority_denied");

    await requestAction(connected.client, connected.revision!, 602, "close", {
      session_id: secondId,
      policy: "force",
    });
    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  },
  NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 6 + 30_000,
);

test("concurrent sessions survive disconnect and complete waits independently", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const origin = await handshake(paths.socket, { minimum: 4, current: 5 });

  const first = await startInteractiveNativeFixture(
    origin.client,
    origin.revision!,
    500_000,
    {
      cwd: home,
      command:
        "printf first-ready; IFS= read -r _; printf first-done; IFS= read -r _; exit 0",
      marker: "first-ready",
    },
  );
  const second = await startInteractiveNativeFixture(
    origin.client,
    origin.revision!,
    501_000,
    {
      cwd: home,
      command:
        "printf second-ready; IFS= read -r _; printf second-done; IFS= read -r _; exit 0",
      marker: "second-ready",
    },
  );
  const firstId = (first.session as { session_id: string }).session_id;
  const secondId = (second.session as { session_id: string }).session_id;

  for (const [correlation, sessionId] of [
    [502, firstId],
    [503, secondId],
  ] as const) {
    origin.client.send(
      encodeFrame(
        origin.revision!,
        1,
        actionSubjects.read,
        correlation,
        {
          request: {
            read: withAuthority("read", {
              session_id: sessionId,
              cursor: { segment: 1, offset: 0 },
            }),
          },
        },
        1,
      ),
    );
  }
  const readResponses = [await origin.client.read(), await origin.client.read()];
  expect(new Set(readResponses.map((response) => response.correlation))).toEqual(
    new Set([502, 503]),
  );

  for (const [correlation, sessionId] of [
    [1_500, firstId],
    [1_501, secondId],
  ] as const) {
    const acquired = await requestAction(
      origin.client,
      origin.revision!,
      correlation,
      "write",
      { session_id: sessionId, lease: "acquire" },
    );
    expect(success(acquired, "write").accepted_bytes).toBe(0);
  }

  for (const [correlation, sessionId] of [
    [504, firstId],
    [505, secondId],
  ] as const) {
    origin.client.send(
      encodeFrame(
        origin.revision!,
        1,
        actionSubjects.write,
        correlation,
        {
          request: {
            write: withAuthority("write", {
              session_id: sessionId,
              payload: { text: "\n" },
              lease: "use",
            }),
          },
        },
        1,
      ),
    );
  }
  const writeResponses = [
    await origin.client.read(),
    await origin.client.read(),
  ];
  expect(
    new Set(writeResponses.map((response) => response.correlation)),
  ).toEqual(new Set([504, 505]));
  for (const response of writeResponses) {
    expect(success(response, "write").accepted_bytes).toBe(1);
  }
  origin.client.close();

  const reconnected = await handshake(paths.socket, {
    minimum: 4,
    current: 5,
  });
  const firstInspect = await requestAction(
    reconnected.client,
    reconnected.revision!,
    506,
    "inspect",
    { session_id: firstId },
  );
  expect(success(firstInspect, "inspect").session).toMatchObject({
    lifecycle: "running",
  });

  for (const [correlation, sessionId] of [
    [1_502, firstId],
    [1_503, secondId],
  ] as const) {
    const released = await requestAction(
      reconnected.client,
      reconnected.revision!,
      correlation,
      "write",
      {
        session_id: sessionId,
        payload: { text: "\n" },
        lease: "use",
      },
    );
    expect(success(released, "write").accepted_bytes).toBe(1);
  }

  reconnected.client.send(
    encodeFrame(
      reconnected.revision!,
      1,
      actionSubjects.wait,
      507,
      {
        request: {
          wait: withAuthority("wait", {
            session_id: firstId,
            return_when: { exit: {} },
            safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
          }),
        },
      },
      1,
    ),
  );
  reconnected.client.send(
    encodeFrame(
      reconnected.revision!,
      1,
      actionSubjects.wait,
      508,
      {
        request: {
          wait: withAuthority("wait", {
            session_id: secondId,
            return_when: { exit: {} },
            safety_ceiling_ms: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
          }),
        },
      },
      1,
    ),
  );
  const responses = [
    await reconnected.client.read(),
    await reconnected.client.read(),
  ];
  expect(new Set(responses.map((response) => response.correlation))).toEqual(
    new Set([507, 508]),
  );
  for (const response of responses) {
    expect(success(response, "wait").outcome).toEqual({ exited: 0 });
  }

  const listed = await requestAction(
    reconnected.client,
    reconnected.revision!,
    509,
    "list",
    {},
  );
  const sessionIds = (
    success(listed, "list").sessions as Array<{ session_id: string }>
  ).map((session) => session.session_id);
  expect(sessionIds).toContain(firstId);
  expect(sessionIds).toContain(secondId);

  const screen = await requestAction(
    reconnected.client,
    reconnected.revision!,
    510,
    "screen",
    { session_id: firstId },
  );
  const screenValue = success(screen, "screen") as {
    snapshot: {
      dimensions: { rows: number; columns: number };
      cells: Array<{ kind: string; text: string }>;
    };
  };
  expect(screenValue.snapshot.dimensions).toEqual({ rows: 24, columns: 80 });
  expect(screenValue.snapshot.cells).toHaveLength(24 * 80);
  expect(screenValue.snapshot.cells.map((cell) => cell.text).join(""))
    .toContain("first-ready");
  await requestAction(
    reconnected.client,
    reconnected.revision!,
    512,
    "close",
    { session_id: firstId, policy: "graceful" },
  );
  await requestAction(
    reconnected.client,
    reconnected.revision!,
    513,
    "close",
    { session_id: secondId, policy: "graceful" },
  );
  reconnected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 12 + 30_000);

test("host crash closes the liveness channel and kills the terminal process group", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const oldIdentity = readFileSync(paths.identity, "utf8");
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const started = await startNativeCommandFixture(
    connected.client,
    connected.revision!,
    600,
    {
      cwd: home,
      command:
        "exec /bin/sh -c 'sleep 30 & child=$!; printf \"shell-pid:%s descendant-pid:%s\" \"$$\" \"$child\"; while :; do read line; done'",
      shell: {
        executable: { path: "/bin/zsh", clean_start: true },
      },
      returnWhen: { match: "descendant-pid:" },
      waitMs: TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  const output = (
    await readSession(
      connected.client,
      connected.revision!,
      601,
      sessionId,
    )
  ).output;
  const pids = output.match(/shell-pid:(\d+) descendant-pid:(\d+)/);
  expect(pids).not.toBeNull();
  const shellPid = Number(pids![1]);
  const descendantPid = Number(pids![2]);
  expect(processExists(shellPid)).toBe(true);
  expect(processExists(descendantPid)).toBe(true);

  host.kill("SIGKILL");
  await waitForExit(host);
  await waitFor(() => !processExists(shellPid), 3_000);
  await waitFor(() => !processExists(descendantPid), 3_000);
  connected.client.close();

  const replacement = startHost(home, undefined, 1_000);
  await waitFor(
    () => fileDiffersFrom(paths.identity, oldIdentity),
    3_000,
  );
  const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
  const inspected = await requestAction(
    recovered.client,
    recovered.revision!,
    602,
    "inspect",
    { session_id: sessionId },
  );
  expect(success(inspected, "inspect").session).toMatchObject({
    lifecycle: "lost",
  });
  const durableRead = await readSession(
    recovered.client,
    recovered.revision!,
    603,
    sessionId,
  );
  expect(durableRead.output).toContain("shell-pid:");
  const durableScreen = await requestAction(
    recovered.client,
    recovered.revision!,
    604,
    "screen",
    { session_id: sessionId },
  );
  const recoveredSnapshot = success(durableScreen, "screen") as {
    snapshot: { cells: Array<{ text: string }> };
  };
  expect(recoveredSnapshot.snapshot.cells.map((cell) => cell.text).join(""))
    .toContain("shell-pid:");
  expect(directChildPids(replacement.pid!)).toEqual([]);
  recovered.client.close();
  expect(await waitForExit(replacement)).toBe(0);
  expect(existsSync(paths.socket)).toBe(false);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 2 + 30_000);

test("lazy private client starts once, reconnects, and leaves the host independent", async () => {
  const home = makeHome();
  const paths = hostPaths(home);

  const first = await runClientFixture(home, 700);
  expect(first).toEqual({
    exitCode: 0,
    stdout: '{"kind":"response","correlation":1,"code":"authority_denied"}\n',
    stderr: "",
  });
  await waitFor(() => existsSync(paths.identity));
  const identityBefore = readFileSync(paths.identity, "utf8");
  const hostPid = Number(
    (JSON.parse(identityBefore) as { pid: string }).pid,
  );
  hostPids.push(hostPid);
  expect(() => process.kill(hostPid, 0)).not.toThrow();

  const second = await runClientFixture(home, 700);
  expect(second.exitCode).toBe(0);
  expect(second.stderr).toBe("");
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);
  expect(() => process.kill(hostPid, 0)).not.toThrow();

  await waitFor(() => !existsSync(paths.socket), 2_000);
  expect(existsSync(paths.identity)).toBe(false);
  await waitFor(() => !processExists(hostPid), 2_000);
  expect(() => process.kill(hostPid, 0)).toThrow();
  hostPids.pop();
});

test("official client retains every reserved outcome through the exact capacity boundary", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const result = await runClientFixture(home, 300, {
    FIBER_TERMINAL_OUTCOME_FIXTURE: "retention",
  });

  expect(result).toEqual({
    exitCode: 0,
    stdout: JSON.stringify({
      retained: 32,
      consumed: 32,
      boundary_rejected: true,
    }) + "\n",
    stderr: "",
  });
  await waitFor(() => !existsSync(paths.identity), 2_000);
}, 20_000);

test.each([
  "task_allocation",
  "worker_start",
  "result_allocation",
  "operation_execution",
  "response_encoding",
  "response_write",
])("accepted %s failure disconnects once and leaves later mutation progress", async (point) => {
  const home = makeHome();
  const paths = hostPaths(home);
  const result = await runClientFixture(home, 300, {
    FIBER_TERMINAL_OUTCOME_FIXTURE: "failure",
    FIBER_TERMINAL_TEST_HOST_FAILURE_POINT: point,
    FIBER_TERMINAL_TEST_HOST_FAILURE_CORRELATION: "1",
  });

  expect(result).toEqual({
    exitCode: 0,
    stdout: JSON.stringify({
      failure: point,
      first: "disconnected",
      later: "response",
    }) + "\n",
    stderr: "",
  });
  await waitFor(() => !existsSync(paths.identity), 2_000);
}, 15_000);

test("long profile homes use distinct private transport roots and retain durable ownership", async () => {
  const firstHome = makeLongHome(141);
  const secondHome = makeLongHome(142);
  const firstDurable = hostPaths(firstHome);
  const secondDurable = hostPaths(secondHome);
  const firstTransport = terminalTransportPaths(firstHome);
  const secondTransport = terminalTransportPaths(secondHome);

  expect(Buffer.byteLength(firstDurable.socket)).toBe(141);
  expect(Buffer.byteLength(secondDurable.socket)).toBe(142);
  expect(firstTransport.dir).not.toBe(firstDurable.dir);
  expect(secondTransport.dir).not.toBe(secondDurable.dir);
  expect(firstTransport.dir).not.toBe(secondTransport.dir);
  expect(Buffer.byteLength(firstTransport.socket)).toBeLessThan(
    process.platform === "darwin" ? 104 : 108,
  );

  const [first, second] = await Promise.all([
    runClientFixture(firstHome, 900),
    runClientFixture(secondHome, 900),
  ]);
  expect(first).toEqual({
    exitCode: 0,
    stdout: '{"kind":"response","correlation":1,"code":"authority_denied"}\n',
    stderr: "",
  });
  expect(second).toEqual(first);
  await waitFor(() =>
    existsSync(firstTransport.socket) &&
    existsSync(secondTransport.socket) &&
    existsSync(firstDurable.identity) &&
    existsSync(secondDurable.identity)
  );

  expect(existsSync(firstDurable.socket)).toBe(false);
  expect(existsSync(secondDurable.socket)).toBe(false);
  expect(statSync(firstTransport.dir).mode & 0o777).toBe(0o700);
  expect(statSync(firstTransport.socket).mode & 0o777).toBe(0o600);
  expect(readFileSync(firstDurable.identity, "utf8")).not.toBe(
    readFileSync(secondDurable.identity, "utf8"),
  );
  expect(readdirSync(firstTransport.dir).sort()).toEqual(["host.sock"]);
  expect(readdirSync(secondTransport.dir).sort()).toEqual(["host.sock"]);

  const firstIdentity = readFileSync(firstDurable.identity, "utf8");
  const reconnected = await runClientFixture(firstHome, 900);
  expect(reconnected).toEqual(first);
  expect(readFileSync(firstDurable.identity, "utf8")).toBe(firstIdentity);

  await waitFor(() =>
    !existsSync(firstTransport.socket) &&
    !existsSync(secondTransport.socket) &&
    !existsSync(firstDurable.identity) &&
    !existsSync(secondDurable.identity)
  , 3_000);
  expect(existsSync(firstDurable.lock)).toBe(true);
  expect(existsSync(secondDurable.lock)).toBe(true);
  expect(existsSync(firstTransport.dir)).toBe(false);
  expect(existsSync(secondTransport.dir)).toBe(false);
}, 15_000);

test("long-home transport roots reject symlink and non-private components without mutation", async () => {
  const symlinkHome = makeLongHome(141);
  const symlinkTransport = terminalTransportPaths(symlinkHome);
  const outside = mkdtempSync(join(tmpdir(), "fiber-terminal-foreign-runtime-"));
  homes.push(outside);
  writeFileSync(join(outside, "host.sock"), "foreign");
  symlinkSync(outside, symlinkTransport.dir);

  expect(await runClientFixture(symlinkHome, 200)).toEqual({
    exitCode: 0,
    stdout: '{"kind":"disconnected","correlation":1}\n',
    stderr: "",
  });
  expect(readFileSync(join(outside, "host.sock"), "utf8")).toBe("foreign");
  expect(lstatSync(symlinkTransport.dir).isSymbolicLink()).toBe(true);

  const publicHome = makeLongHome(142);
  const publicTransport = terminalTransportPaths(publicHome);
  mkdirSync(publicTransport.dir, { mode: 0o755 });
  chmodSync(publicTransport.dir, 0o755);
  writeFileSync(join(publicTransport.dir, "foreign"), "retain");

  expect(await runClientFixture(publicHome, 200)).toEqual({
    exitCode: 0,
    stdout: '{"kind":"disconnected","correlation":1}\n',
    stderr: "",
  });
  expect(statSync(publicTransport.dir).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(publicTransport.dir, "foreign"), "utf8")).toBe("retain");
  expect(existsSync(hostPaths(publicHome).identity)).toBe(false);
}, 10_000);

test.skipIf(!tmuxAvailable())(
  "long-home tmux survives host restart with transport-only runtime state",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeLongHome(141);
    const durable = hostPaths(home);
    const transport = terminalTransportPaths(home);
    const firstHost = startHost(home, undefined, 30_000);
    await waitFor(() => existsSync(transport.socket));
    const first = await handshake(transport.socket, { minimum: 4, current: 5 });
    const started = await startCommand(first.client, first.revision!, 701, {
      cwd: home,
      command:
        "printf 'long-tmux-ready\\n'; while IFS= read -r line; do printf 'long-tmux:%s\\n' \"$line\"; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "long-tmux-ready" },
      waitMs: 8_000,
    });
    const sessionId = (started.session as { session_id: string }).session_id;
    const tmuxSocket = transport.tmuxSocket;
    await waitFor(() => existsSync(tmuxSocket));
    expect(statSync(tmuxSocket).mode & 0o777).toBe(0o600);
    expect(existsSync(join(durable.dir, "tmux.sock"))).toBe(false);
    expect(readdirSync(transport.dir).sort()).toEqual([
      "host.sock",
      "tmux.sock",
    ]);
    expect(
      readdirSync(durable.dir).some((name) => name.endsWith("-manifest.json")),
    ).toBe(true);
    expect(
      readdirSync(durable.dir).some((name) => name.endsWith("-lifecycle.bin")),
    ).toBe(true);

    const firstRead = await readSession(
      first.client,
      first.revision!,
      702,
      sessionId,
    );
    expect(firstRead.output).toContain("long-tmux-ready");
    const oldIdentity = readFileSync(durable.identity, "utf8");
    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);
    expect(existsSync(tmuxSocket)).toBe(true);

    const replacement = startHost(home, undefined, 700);
    await waitFor(() =>
      existsSync(transport.socket) &&
      fileDiffersFrom(durable.identity, oldIdentity)
    , 8_000);
    const recovered = await handshake(transport.socket, {
      minimum: 4,
      current: 5,
    });
    const inspected = success(
      await requestAction(recovered.client, recovered.revision!, 703, "inspect", {
        session_id: sessionId,
      }),
      "inspect",
    );
    expect(inspected.session).toMatchObject({
      lifecycle: "running",
      backend: "tmux",
    });
    const gapCursor = (inspected.session as {
      raw_gap?: { available_from: { segment: number; offset: number } };
    }).raw_gap?.available_from;
    expect(gapCursor).toBeDefined();
    success(
      await requestAction(recovered.client, recovered.revision!, 704, "write", {
        session_id: sessionId,
        payload: { text: "recovered\n" },
      }),
      "write",
    );
    success(
      await requestAction(recovered.client, recovered.revision!, 705, "wait", {
        session_id: sessionId,
        return_when: { match: "long-tmux:recovered" },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    const recoveredRead = success(
      await requestAction(recovered.client, recovered.revision!, 706, "read", {
        session_id: sessionId,
        cursor: gapCursor,
      }),
      "read",
    ) as { output: string };
    expect(recoveredRead.output).toContain("long-tmux:recovered");
    success(
      await requestAction(recovered.client, recovered.revision!, 707, "close", {
        session_id: sessionId,
        policy: "force",
      }),
      "close",
    );
    await waitFor(() => !existsSync(tmuxSocket));
    recovered.client.close();
    expect(await waitForExit(replacement)).toBe(0);
    expect(existsSync(transport.socket)).toBe(false);
    expect(existsSync(durable.identity)).toBe(false);
    expect(existsSync(transport.dir)).toBe(false);
  },
  30_000,
);

test("fresh private client reloads owner-scoped authority without retaining proof", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const started = await runClientFixture(home, 700, {
    FIBER_TERMINAL_AUTHORITY_FIXTURE: "start",
  });
  expect(started.exitCode).toBe(0);
  expect(started.stderr).toBe("");
  expect(started.stdout.toLowerCase()).not.toContain("proof");
  expect(started.stdout.toLowerCase()).not.toContain("bytes");
  const startValue = JSON.parse(started.stdout) as {
    session_id: string;
    generation: number;
    minted: boolean;
  };
  expect(startValue).toEqual({
    session_id: expect.any(String),
    generation: 1,
    minted: true,
  });

  await waitFor(() => existsSync(paths.identity));
  const hostPid = Number(
    (JSON.parse(readFileSync(paths.identity, "utf8")) as { pid: string }).pid,
  );
  hostPids.push(hostPid);
  authorityBySession.clear();
  writeLeaseSessions.clear();

  const reloaded = await runClientFixture(home, 700, {
    FIBER_TERMINAL_AUTHORITY_FIXTURE: "reload",
    FIBER_TERMINAL_AUTHORITY_SESSION_ID: startValue.session_id,
  });
  expect(reloaded).toEqual({
    exitCode: 0,
    stdout: '{"read":true,"inspect":true,"closed":true}\n',
    stderr: "",
  });
  expect(reloaded.stdout.toLowerCase()).not.toContain("proof");
  expect(reloaded.stdout.toLowerCase()).not.toContain("bytes");
  await waitFor(() => directChildPids(hostPid).length === 0);
  await waitFor(() => !processExists(hostPid), 2_000);
  expect(existsSync(paths.socket)).toBe(false);
  hostPids.pop();
});

test("private client replaces an endpoint only after dead identity and free-lock proof", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const staleHost = startHost(home, { minimum: 4, current: 5 }, 5_000);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const staleIdentity = readFileSync(paths.identity, "utf8");
  staleHost.kill("SIGKILL");
  await waitForExit(staleHost);
  expect(existsSync(paths.socket)).toBe(true);
  expect(existsSync(paths.identity)).toBe(true);

  const client = await runClientFixture(home, 500);
  expect(client.exitCode).toBe(0);
  expect(client.stderr).toBe("");
  await waitFor(() => existsSync(paths.identity));
  const replacementIdentity = readFileSync(paths.identity, "utf8");
  expect(replacementIdentity).not.toBe(staleIdentity);
  const replacementPid = Number(
    (JSON.parse(replacementIdentity) as { pid: string }).pid,
  );
  hostPids.push(replacementPid);
  expect(() => process.kill(replacementPid, 0)).not.toThrow();

  await waitFor(() => !existsSync(paths.socket), 2_000);
  await waitFor(() => !processExists(replacementPid), 2_000);
  expect(() => process.kill(replacementPid, 0)).toThrow();
  hostPids.pop();
});

test("current client rejects same revision host without complete signal capability before start", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const fixture = protocolFixtureDefinitions.signal_limited;
  const host = startHostWithAdvertisedProtocol(
    home,
    700,
    protocolFixtureEnv(fixture),
  );
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const identityBefore = readFileSync(paths.identity, "utf8");

  const rejected = await runClientFixture(home, 700, {
    FIBER_TERMINAL_CAPABILITY_FIXTURE: "start",
  });
  expect(rejected).toEqual({
    exitCode: 0,
    stdout: '{"kind":"unavailable","correlation":1,"missing_capabilities":16}\n',
    stderr: "",
  });
  expect(host.exitCode).toBeNull();
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);
  const terminalState = join(
    home,
    ".fiber",
    "sessions",
    TERMINAL_OWNER_SESSION,
    "terminal",
    "state",
  );
  expect(
    existsSync(terminalState)
      ? readdirSync(terminalState).filter((name) => name.startsWith("record-"))
      : [],
  ).toEqual([]);

  expect(await waitForExit(host)).toBe(0);
});

test("current client permits graceful close and rejects force close on signal limited host", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const fixture = protocolFixtureDefinitions.signal_limited;
  const host = startHostWithAdvertisedProtocol(
    home,
    1_500,
    protocolFixtureEnv(fixture),
  );
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const identityBefore = readFileSync(paths.identity, "utf8");
  const previousClient = await handshake(
    paths.socket,
    fixture.range,
    fixture.capabilities,
    fixture.range.current,
  );
  const started = success(await requestAction(
    previousClient.client,
    previousClient.revision!,
    451,
    "start",
    {
      cwd: home,
      command: "printf 'authority-reload-ready\\n'; sleep 30",
      shell: { executable: { path: TERMINAL_FIXTURE_SHELL, clean_start: true } },
      backend: "native",
      return_when: { match: "authority-reload-ready" },
      wait_ceiling_ms: 5_000,
      dimensions: { rows: 24, columns: 80 },
    },
  ), "start");
  const sessionId = (started.session as { session_id: string }).session_id;
  previousClient.client.close();

  const forceRejected = await runClientFixture(home, 1_500, {
    FIBER_TERMINAL_CAPABILITY_FIXTURE: "force_close",
    FIBER_TERMINAL_AUTHORITY_FIXTURE_COMPAT: "1",
    FIBER_TERMINAL_AUTHORITY_SESSION_ID: sessionId,
  });
  expect(forceRejected).toEqual({
    exitCode: 0,
    stdout: '{"kind":"unavailable","correlation":1,"missing_capabilities":16}\n',
    stderr: "",
  });
  expect(durableTerminalRecordFor(home, sessionId)).toMatchObject({
    lifecycle: "running",
  });
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);

  const gracefulClosed = await runClientFixture(home, 1_500, {
    FIBER_TERMINAL_AUTHORITY_FIXTURE: "reload",
    FIBER_TERMINAL_AUTHORITY_FIXTURE_COMPAT: "1",
    FIBER_TERMINAL_AUTHORITY_SESSION_ID: sessionId,
  });
  expect(gracefulClosed).toEqual({
    exitCode: 0,
    stdout: '{"read":true,"inspect":true,"closed":true}\n',
    stderr: "",
  });
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);
  expect(await waitForExit(host)).toBe(0);
});

test("protocol fixtures advertise exact evidence and interoperate in both directions", async () => {
  const advertised: Record<string, unknown> = {};
  for (const [name, fixture] of Object.entries(protocolFixtureDefinitions)) {
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHostWithAdvertisedProtocol(
      home,
      300,
      protocolFixtureEnv(fixture),
    );
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
    const connected = await handshake(
      paths.socket,
      fixture.range,
      fixture.capabilities,
      fixture.range.current,
    );
    expect(connected.hostRange, name).toEqual(fixture.range);
    expect(connected.hostCapabilities, name).toBe(fixture.capabilities);
    advertised[name] = {
      range: connected.hostRange,
      capabilities: connected.hostCapabilities,
    };
    connected.client.close();
    expect(await waitForExit(host), name).toBe(0);
  }

  const directionEvidence: Array<Record<string, unknown>> = [];
  {
    const direction = "current client safe action to previous contract host";
    const previous = protocolFixtureDefinitions.previous;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHostWithAdvertisedProtocol(
      home,
      300,
      protocolFixtureEnv(previous),
    );
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
    const hostIdentity = readFileSync(paths.identity, "utf8");
    const inspected = await runClientFixture(home, 300);
    expect(inspected, direction).toEqual({
      exitCode: 0,
      stdout: '{"kind":"response","correlation":1,"code":"authority_denied"}\n',
      stderr: "",
    });
    expect(readFileSync(paths.identity, "utf8"), direction).toBe(hostIdentity);
    expect(await waitForExit(host), direction).toBe(0);
    directionEvidence.push({
      direction,
      client: "active_FIBER_BIN",
      host: "previous_contract",
      result: "safe_request_passed",
    });
  }

  {
    const direction = "previous contract client to current host";
    const previous = protocolFixtureDefinitions.previous;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHostWithAdvertisedProtocol(home, 700);
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
    const connected = await handshake(
      paths.socket,
      previous.range,
      previous.capabilities,
      previous.range.current,
    );
    expect(connected.revision, direction).toBe(4);
    const started = success(await requestAction(
      connected.client,
      connected.revision!,
      401,
      "start",
      {
        cwd: home,
        command: "printf 'compatibility-ready\\n'; sleep 30",
        shell: { executable: { path: TERMINAL_FIXTURE_SHELL, clean_start: true } },
        backend: "native",
        return_when: { match: "compatibility-ready" },
        wait_ceiling_ms: 5_000,
        dimensions: { rows: 24, columns: 80 },
      },
    ), "start");
    const sessionId = (started.session as { session_id: string }).session_id;
    expect(success(await requestAction(
      connected.client,
      connected.revision!,
      402,
      "inspect",
      { session_id: sessionId },
    ), "inspect")).toMatchObject({ session: { session_id: sessionId } });
    success(await requestAction(
      connected.client,
      connected.revision!,
      403,
      "close",
      { session_id: sessionId, policy: "force" },
    ), "close");
    connected.client.close();
    expect(await waitForExit(host), direction).toBe(0);
    directionEvidence.push({
      direction,
      client: "previous_contract",
      host: "active_FIBER_BIN",
      result: "passed",
    });
  }

  {
    const direction = "current client to incompatible contract host";
    const incompatible = protocolFixtureDefinitions.incompatible;
    const current = protocolFixtureDefinitions.current_checkpoint;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHostWithAdvertisedProtocol(
      home,
      700,
      protocolFixtureEnv(incompatible),
    );
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
    const identityBefore = readFileSync(paths.identity, "utf8");
    const rejected = await runClientFixture(home, 700);
    expect(rejected.exitCode, direction).toBe(0);
    expect(rejected.stderr, direction).toBe("");
    expect(JSON.parse(rejected.stdout), direction).toMatchObject({
      kind: "unavailable",
      incompatibility: {
        reason: "revision_mismatch",
        client_range: current.range,
        host_range: incompatible.range,
      },
    });
    expect(host.exitCode, direction).toBeNull();
    expect(readFileSync(paths.identity, "utf8"), direction).toBe(
      identityBefore,
    );
    expect(await waitForExit(host), direction).toBe(0);
    directionEvidence.push({
      direction,
      result: "structured_rejection_identity_preserved",
    });
  }

  {
    const direction = "incompatible contract client to current host";
    const incompatible = protocolFixtureDefinitions.incompatible;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHostWithAdvertisedProtocol(home, 700);
    await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
    const identityBefore = readFileSync(paths.identity, "utf8");
    const connected = await handshake(
      paths.socket,
      incompatible.range,
      incompatible.capabilities,
      incompatible.range.current,
    );
    expect(connected.revision, direction).toBeUndefined();
    expect(connected.hostRange, direction).toEqual(
      protocolFixtureDefinitions.current_checkpoint.range,
    );
    connected.client.close();
    expect(readFileSync(paths.identity, "utf8"), direction).toBe(identityBefore);
    expect(await waitForExit(host), direction).toBe(0);
    directionEvidence.push({
      direction,
      result: "revision_mismatch_identity_preserved",
    });
  }

  console.log("FIBER_TERMINAL_COMPATIBILITY_EVIDENCE " + JSON.stringify({
    fixtures: advertised,
    directions: directionEvidence,
    active_current: {
      source: "FIBER_BIN",
      digest: createHash("sha256").update(readFileSync(FIBER_BIN)).digest("hex"),
    },
  }));
}, 360_000);

test.each([
  {
    name: "new client to previous host",
    hostRange: { minimum: 4, current: 4 },
    clientRange: { minimum: 4, current: 5 },
    revision: 4,
    helloRevision: 4,
  },
  {
    name: "previous client to new host",
    hostRange: { minimum: 4, current: 5 },
    clientRange: { minimum: 4, current: 4 },
    revision: 4,
    helloRevision: 4,
  },
])("$name negotiates the highest shared revision", async ({
  hostRange,
  clientRange,
  revision,
  helloRevision,
}) => {
  const home = makeHome();
  const paths = hostPaths(home);
  const child = startHost(home, hostRange);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, clientRange);
  expect(connected.helloRevision).toBe(helloRevision);
  expect(connected.revision).toBe(revision);
  const response = await requestScreen(connected.client, revision, 88);
  expect(response.revision).toBe(revision);
  expect(response.correlation).toBe(88);
  expect(failure(response).code).toBe("protocol_incompatible");
  connected.client.close();
  expect(await waitForExit(child)).toBe(0);
  expect(await streamText(child.stderr)).toBe("");
});

test("incompatible live host is preserved and never replaced", async () => {
  const home = makeHome();
  const paths = hostPaths(home);
  const child = startHost(home, { minimum: 6, current: 6 }, 500);
  await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity));
  const identityBefore = readFileSync(paths.identity, "utf8");

  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  expect(first.revision).toBeUndefined();
  expect(first.helloRevision).toBe(5);
  expect(first.hostRange).toEqual({ minimum: 6, current: 6 });
  first.client.close();
  const second = await handshake(paths.socket, { minimum: 4, current: 5 });
  expect(second.revision).toBeUndefined();
  expect(second.helloRevision).toBe(5);
  second.client.close();

  expect(child.exitCode).toBeNull();
  expect(readFileSync(paths.identity, "utf8")).toBe(identityBefore);
  expect(existsSync(paths.socket)).toBe(true);
  expect(await waitForExit(child)).toBe(0);
  expect(await streamText(child.stderr)).toBe("");
});
