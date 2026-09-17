import { expect, test } from "bun:test";
import {
  execFileSync,
} from "node:child_process";
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
  tmuxAvailable,
} from "./tmux-helpers";
import {
  CLEANUP_FINALIZATION_BUDGET_MS,
  NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
  PrivateTmuxResource,
  TERMINAL_FIXTURE_SHELL,
  TERMINAL_OPERATION_OBSERVATION_BUDGET_MS,
  TERMINAL_OWNER_SESSION,
  TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS,
  TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS,
  TMUX_DELAYED_PROFILE_TEST_TIMEOUT_MS,
  TMUX_EXPLICIT_BACKEND_TEST_TIMEOUT_MS,
  TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
  TMUX_MARKER_IO_DEADLINE_MS,
  children,
  cleanupOwnedTestResources,
  cleanupPrivateTmuxServer,
  directChildPids,
  durableTerminalRecord,
  durableTerminalRecordFor,
  failure,
  failureCode,
  finishStartupObservation,
  forceCloseTerminalFixture,
  handshake,
  homes,
  hostPaths,
  isolateZshStartupFixture,
  makeHome,
  privateTmuxProcessPids,
  privateTmuxServers,
  processExists,
  processFdCount,
  readSession,
  rememberPrivateTmuxIdentities,
  rememberPrivateTmuxServer,
  rememberRecoveredAuthority,
  requestAction,
  startCommand,
  startHost,
  startInteractiveTmuxFixture,
  startNativeCommandFixture,
  streamText,
  success,
  terminalTransportPaths,
  tmuxCaptureHelperPids,
  tmuxPeerArtifacts,
  transportRoots,
  waitFor,
  waitForExit,
  registerTerminalHostCleanupHooks,
} from "./terminal-host-helpers";

registerTerminalHostCleanupHooks();

test.skipIf(!tmuxAvailable())("explicit tmux backend is isolated and reports exact command exit", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  isolateZshStartupFixture(home);
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

  const tmuxResource = rememberPrivateTmuxServer(home);
  const started = await finishStartupObservation(
    connected.client,
    connected.revision!,
    111,
    success(
      await requestAction(connected.client, connected.revision!, 110, "start", {
        cwd: home,
        command: "pwd; printf '\\ntmux-ready\\n'; exit 23",
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        backend: "tmux",
        return_when: { exit: {} },
        wait_ceiling_ms: TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
        dimensions: { rows: 17, columns: 61 },
      }),
      "start",
    ),
    "tmux",
    { exit: {} },
    TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS,
  );
  rememberPrivateTmuxIdentities(tmuxResource);
  expect(started).toMatchObject({
    outcome: { exited: 23 },
    session: { lifecycle: "exited", backend: "tmux" },
  });
  const sessionId = (started.session as { session_id: string }).session_id;
  const read = await readSession(
    connected.client,
    connected.revision!,
    112,
    sessionId,
  );
  expect(read.output).toContain(`${home}\r\n`);
  expect(read.output).toContain("tmux-ready\r\n");
  await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

  writeFileSync(join(home, ".zshrc"), "");
  const normalProfile = await finishStartupObservation(
    connected.client,
    connected.revision!,
    114,
    await startCommand(connected.client, connected.revision!, 113, {
      cwd: home,
      command: "printf normal-profile-ready; exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: false } },
      backend: "tmux",
      returnWhen: { exit: {} },
      waitMs: TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
    }),
    "tmux",
    { exit: {} },
    TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS,
  );
  expect(normalProfile).toMatchObject({
    outcome: { exited: 0 },
    session: { lifecycle: "exited", backend: "tmux" },
  });
  await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

  const interactive = await finishStartupObservation(
    connected.client,
    connected.revision!,
    116,
    await startCommand(connected.client, connected.revision!, 115, {
      cwd: home,
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { started: {} },
      waitMs: TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
    }),
    "tmux",
    { started: {} },
    TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS,
  );
  const interactiveId = (interactive.session as { session_id: string }).session_id;
  success(
    await requestAction(connected.client, connected.revision!, 117, "write", {
      session_id: interactiveId,
      payload: { text: "printf commandless-ready; exit 0\n" },
    }),
    "write",
  );
  const interactiveExit = success(
    await requestAction(connected.client, connected.revision!, 118, "wait", {
      session_id: interactiveId,
      return_when: { exit: {} },
      safety_ceiling_ms: 5_000,
    }),
    "wait",
  );
  expect(interactiveExit.outcome).toEqual({ exited: 0 });
  expect((await readSession(
    connected.client,
    connected.revision!,
    119,
    interactiveId,
  )).output).toContain("commandless-ready");
  await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, TMUX_EXPLICIT_BACKEND_TEST_TIMEOUT_MS);

test.skipIf(!tmuxAvailable())(
  "tmux first shell marker can arrive after the acknowledgment-duration boundary",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    isolateZshStartupFixture(home);
    const paths = hostPaths(home);
    writeFileSync(
      join(home, ".zprofile"),
      "sleep 14.25\nprintf 'first-marker-profile-ready\\n'\n",
    );
    const host = startHost(home, undefined, 10_000);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

    const startedAt = Date.now();
    const initial = await startCommand(
      connected.client,
      connected.revision!,
      117,
      {
        cwd: home,
        command: "exit 19",
        shell: { executable: { path: "/bin/zsh", clean_start: false } },
        backend: "tmux",
        returnWhen: { exit: {} },
        waitMs: TMUX_INITIAL_STARTUP_OBSERVATION_BUDGET_MS,
      },
    );
    expect(initial).toMatchObject({
      outcome: { safety_ceiling: {} },
      session: { lifecycle: "starting", backend: "tmux" },
    });
    const sessionId = (initial.session as { session_id: string }).session_id;
    const result = success(
      await requestAction(connected.client, connected.revision!, 118, "wait", {
        session_id: sessionId,
        return_when: { exit: {} },
        safety_ceiling_ms: TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS,
      }),
      "wait",
    );
    expect(result).toMatchObject({
      outcome: { exited: 19 },
      session: { lifecycle: "exited", backend: "tmux" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      TMUX_MARKER_IO_DEADLINE_MS,
    );
    expect(
      (await readSession(
        connected.client,
        connected.revision!,
        119,
        sessionId,
      )).output,
    ).toContain("first-marker-profile-ready");
    await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  },
  TMUX_DELAYED_PROFILE_TEST_TIMEOUT_MS,
);

test.skipIf(!tmuxAvailable())(
  "tmux command release completes within the marker acknowledgment window",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const host = startHost(home, undefined, 10_000, {
      FIBER_TERMINAL_TEST_COMMAND_BOUNDARY_DELAY_MS: "5000",
    });
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

    const startedAt = Date.now();
    const result = await startCommand(
      connected.client,
      connected.revision!,
      117,
      {
        cwd: home,
        command: "exit 19",
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        backend: "tmux",
        returnWhen: { exit: {} },
        waitMs: 12_000,
      },
    );
    expect(result).toMatchObject({
      outcome: { exited: 19 },
      session: { lifecycle: "exited", backend: "tmux" },
    });
    // The injected command-boundary delay is 5000ms; assert a 4900ms floor
    // so timer granularity cannot flake a zero-margin comparison.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
    await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  },
  20_000,
);

const tmuxBoundedPeerFailures = [
  { owner: "marker", point: "no-peer" },
  { owner: "marker", point: "silent-peer" },
  { owner: "marker", point: "partial-marker" },
  { owner: "marker", point: "invalid-nonce" },
  { owner: "marker", point: "child-exit" },
  { owner: "capture", point: "no-peer" },
  { owner: "capture", point: "silent-peer" },
  { owner: "capture", point: "partial-identity" },
  { owner: "capture", point: "wrong-identity" },
  { owner: "capture", point: "child-exit" },
] as const;

test.skipIf(!tmuxAvailable())(
  "tmux marker and capture peers are deadline-bounded and clean every failed attempt twice",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    for (const fixture of tmuxBoundedPeerFailures) {
      for (let pass = 1; pass <= 2; pass++) {
        const home = makeHome();
        const paths = hostPaths(home);
        const transport = terminalTransportPaths(home);
        const trace = join(home, `${fixture.owner}-${fixture.point}-${pass}.log`);
        const host = startHost(home, undefined, 2_000, {
          FIBER_TRACE_LOG: trace,
          FIBER_TRACE_SCOPES: "terminal_host",
          FIBER_TERMINAL_TEST_TMUX_DEADLINE_MS: "150",
          ...(fixture.owner === "marker"
            ? { FIBER_TERMINAL_TEST_TMUX_MARKER_FAILURE: fixture.point }
            : { FIBER_TERMINAL_TEST_TMUX_CAPTURE_FAILURE: fixture.point }),
        });
        const stderr = streamText(host.stderr);
        await waitFor(() => existsSync(paths.socket));
        const connected = await handshake(paths.socket, {
          minimum: 4,
          current: 5,
        });
        const baselineFds = processFdCount(host.pid!);
        const baselinePeerArtifacts = tmuxPeerArtifacts();
        const baselineCaptureHelpers = tmuxCaptureHelperPids();
        const response = await requestAction(
          connected.client,
          connected.revision!,
          120,
          "start",
          {
            cwd: home,
            command: "sleep 30",
            shell: { executable: { path: "/bin/zsh", clean_start: true } },
            backend: "tmux",
            return_when: { started: {} },
            wait_ceiling_ms: 5_000,
            dimensions: { rows: 24, columns: 80 },
          },
        );
        expect(failure(response), `${fixture.owner}:${fixture.point}:${pass}`)
          .toMatchObject({ action: "start", code: "startup_failed" });
        const state = join(
          home,
          ".fiber",
          "sessions",
          TERMINAL_OWNER_SESSION,
          "terminal",
          "state",
        );
        const recordName = readdirSync(state).find((name) =>
          name.startsWith("record-") && name.endsWith(".json")
        );
        const identities = recordName
          ? [(JSON.parse(readFileSync(join(state, recordName), "utf8")) as {
            backend_identity: string;
          }).backend_identity]
          : [];
        await waitFor(() => !existsSync(transport.tmuxSocket), 5_000);
        await waitFor(() => directChildPids(host.pid!).length === 0, 5_000);
        await waitFor(
          () => JSON.stringify(tmuxCaptureHelperPids()) ===
            JSON.stringify(baselineCaptureHelpers),
          5_000,
        );
        expect(
          privateTmuxProcessPids(transport.tmuxSocket, identities),
          `${fixture.owner}:${fixture.point}:${pass}`,
        ).toEqual([]);
        expect(tmuxPeerArtifacts(), `${fixture.owner}:${fixture.point}:${pass}`)
          .toEqual(baselinePeerArtifacts);
        expect(
          readdirSync(paths.dir).filter((name) => name.startsWith("tmux-")),
          `${fixture.owner}:${fixture.point}:${pass}`,
        ).toEqual([]);
        expect(processFdCount(host.pid!)).toBeLessThanOrEqual(baselineFds + 2);
        connected.client.close();
        expect(await waitForExit(host)).toBe(0);
        expect(await stderr).toBe("");
      }
    }
  },
  180_000,
);

test.skipIf(!tmuxAvailable())(
  "tmux foreground handoff failure reaps group and direct-fallback attempts twice",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    for (const fixture of [
      { name: "group", injectGroupKillFailure: false },
      { name: "direct-fallback", injectGroupKillFailure: true },
    ]) {
      for (let pass = 1; pass <= 2; pass++) {
        const home = makeHome();
        const paths = hostPaths(home);
        const transport = terminalTransportPaths(home);
        const trace = join(home, `foreground-${fixture.name}-${pass}.log`);
        const host = startHost(home, undefined, 2_000, {
          FIBER_TRACE_LOG: trace,
          FIBER_TRACE_SCOPES: "terminal_host",
          FIBER_TERMINAL_TEST_TMUX_TCSETPGRP_FAILURE: "1",
          ...(fixture.injectGroupKillFailure
            ? { FIBER_TERMINAL_TEST_TMUX_GROUP_KILL_FAILURE: "1" }
            : {}),
        });
        const stderr = streamText(host.stderr);
        await waitFor(() => existsSync(paths.socket));
        const connected = await handshake(paths.socket, {
          minimum: 4,
          current: 5,
        });
        const baselineFds = processFdCount(host.pid!);
        const baselinePeerArtifacts = tmuxPeerArtifacts();
        const baselineCaptureHelpers = tmuxCaptureHelperPids();
        for (let attempt = 0; attempt < 2; attempt++) {
          const startedAt = Date.now();
          const response = await requestAction(
            connected.client,
            connected.revision!,
            121 + attempt * 10_000,
            "start",
            {
              cwd: home,
              command: "sleep 30",
              shell: { executable: { path: "/bin/zsh", clean_start: true } },
              backend: "tmux",
              return_when: { started: {} },
              wait_ceiling_ms: 5_000,
              dimensions: { rows: 24, columns: 80 },
            },
          );
          expect(Date.now() - startedAt, `${fixture.name}:${pass}`).toBeLessThan(
            5_000,
          );
          expect(failure(response), `${fixture.name}:${pass}`).toMatchObject({
            action: "start",
            code: "startup_failed",
          });
          try {
            await waitFor(
              () =>
                existsSync(trace) &&
                readFileSync(trace, "utf8").includes(
                  "tmux foreground handoff failed pid=",
                ),
              CLEANUP_FINALIZATION_BUDGET_MS * 2,
            );
            break;
          } catch (error) {
            if (attempt === 1) throw error;
            console.error(
              "Retrying tmux handoff failure fixture after unrelated startup failure",
            );
          }
        }
        const traceText = readFileSync(trace, "utf8");
        const childMatch = traceText.match(
          /tmux foreground handoff failed pid=(\d+)/,
        );
        expect(childMatch, `${fixture.name}:${pass}`).not.toBeNull();
        const childPid = Number(childMatch![1]);
        if (fixture.injectGroupKillFailure) {
          expect(traceText, `${fixture.name}:${pass}`).toContain(
            `tmux child group termination failed pid=${childPid} direct_kill_succeeded=true`,
          );
        } else {
          expect(traceText, `${fixture.name}:${pass}`).not.toContain(
            "tmux child group termination failed",
          );
        }
        const record = durableTerminalRecord(home).value as unknown as {
          backend_identity: string;
        };
        await waitFor(() => !existsSync(transport.tmuxSocket), 5_000);
        await waitFor(() => !processExists(childPid), 5_000);
        await waitFor(() => directChildPids(host.pid!).length === 0, 5_000);
        await waitFor(
          () => JSON.stringify(tmuxCaptureHelperPids()) ===
            JSON.stringify(baselineCaptureHelpers),
          5_000,
        );
        expect(processExists(childPid), `${fixture.name}:${pass}`).toBe(false);
        expect(privateTmuxProcessPids(
          transport.tmuxSocket,
          [record.backend_identity],
        )).toEqual([]);
        expect(tmuxPeerArtifacts(), `${fixture.name}:${pass}`).toEqual(
          baselinePeerArtifacts,
        );
        expect(
          readdirSync(paths.dir).filter((name) => name.startsWith("tmux-")),
          `${fixture.name}:${pass}`,
        ).toEqual([]);
        expect(existsSync(`/tmp/fiber-tmux-capture-${record.backend_identity}.sock`))
          .toBe(false);
        expect(existsSync(`/tmp/fiber-tmux-marker-${record.backend_identity}.sock`))
          .toBe(false);
        expect(processFdCount(host.pid!)).toBeLessThanOrEqual(baselineFds + 2);
        connected.client.close();
        expect(await waitForExit(host)).toBe(0);
        expect(await stderr).toBe("");
      }
    }
  },
  TERMINAL_OPERATION_OBSERVATION_BUDGET_MS * 4 +
    CLEANUP_FINALIZATION_BUDGET_MS * 4,
);

test.skipIf(!tmuxAvailable())(
  "tmux foreground race resumes the exact SIGTTIN group and reports command exit",
  async () => {
    const home = makeHome();
    const paths = hostPaths(home);
    const transport = terminalTransportPaths(home);
    const wrapper = join(
      home,
      TERMINAL_FIXTURE_SHELL.endsWith("/zsh") ? "zsh" : "bash",
    );
    const stoppedProof = join(home, "tmux-sigttin-stopped");
    const resumedProof = join(home, "tmux-sigttin-resumed");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ntrap - TTIN\nprintf '%s %s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" > ${JSON.stringify(stoppedProof)}\nkill -TTIN 0\n: > ${JSON.stringify(resumedProof)}\nexec ${JSON.stringify(TERMINAL_FIXTURE_SHELL)} "$@"\n`,
      { mode: 0o700 },
    );

    const tmuxResource = rememberPrivateTmuxServer(home);
    const baselinePeerArtifacts = tmuxPeerArtifacts();
    const baselineCaptureHelpers = tmuxCaptureHelperPids();
    const trace = join(home, "tmux-sigttin-trace.log");
    const host = startHost(home, undefined, 250, {
      FIBER_TRACE_LOG: trace,
      FIBER_TRACE_SCOPES: "terminal_host",
      FIBER_TERMINAL_TEST_TMUX_DEADLINE_MS: "2000",
    });
    const stderr = streamText(host.stderr);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
    const hostFds = processFdCount(host.pid!);

    const startedAt = Date.now();
    const response = await requestAction(
      connected.client,
      connected.revision!,
      122,
      "start",
      {
        cwd: home,
        command: "printf 'tmux-handoff-ready\\n'; exit 23",
        shell: { executable: { path: wrapper, clean_start: true } },
        backend: "tmux",
        return_when: { exit: {} },
        wait_ceiling_ms: 5_000,
        dimensions: { rows: 24, columns: 80 },
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const started = success(response, "start");
    expect(started).toMatchObject({
      outcome: { exited: 23 },
      session: { lifecycle: "exited", backend: "tmux" },
    });

    const [pidText, pgidText] = readFileSync(stoppedProof, "utf8")
      .trim()
      .split(/\s+/);
    const childPid = Number(pidText);
    const childPgid = Number(pgidText);
    expect(childPid).toBeGreaterThan(0);
    expect(childPid).toBe(childPgid);
    expect(existsSync(resumedProof)).toBe(true);
    await waitFor(() =>
      existsSync(trace) &&
      readFileSync(trace, "utf8").includes(
        `resumed terminal child after foreground race pid=${childPid}`,
      )
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    expect((await readSession(
      connected.client,
      connected.revision!,
      123,
      sessionId,
    )).output).toContain("tmux-handoff-ready");

    rememberPrivateTmuxIdentities(tmuxResource);
    const record = durableTerminalRecord(home).value as unknown as {
      backend_identity: string;
    };
    await waitFor(() => !existsSync(transport.tmuxSocket), 5_000);
    await waitFor(() => !processExists(childPid), 5_000);
    await waitFor(() => directChildPids(host.pid!).length === 0, 5_000);
    await waitFor(
      () => JSON.stringify(tmuxCaptureHelperPids()) ===
        JSON.stringify(baselineCaptureHelpers),
      5_000,
    );
    expect(privateTmuxProcessPids(
      transport.tmuxSocket,
      [record.backend_identity],
    )).toEqual([]);
    expect(tmuxPeerArtifacts()).toEqual(baselinePeerArtifacts);
    expect(
      readdirSync(paths.dir).filter((name) => name.startsWith("tmux-")),
    ).toEqual([]);
    expect(existsSync(`/tmp/fiber-tmux-capture-${record.backend_identity}.sock`))
      .toBe(false);
    expect(existsSync(`/tmp/fiber-tmux-marker-${record.backend_identity}.sock`))
      .toBe(false);
    expect(processFdCount(host.pid!)).toBeLessThanOrEqual(hostFds + 2);
    rmSync(stoppedProof, { force: true });
    rmSync(resumedProof, { force: true });
    rmSync(wrapper, { force: true });
    rmSync(trace, { force: true });
    expect(existsSync(stoppedProof)).toBe(false);
    expect(existsSync(resumedProof)).toBe(false);
    expect(existsSync(wrapper)).toBe(false);
    expect(existsSync(trace)).toBe(false);
    connected.client.close();
    expect(await waitForExit(host)).toBe(0);
    expect(await stderr).toBe("");
  },
  15_000,
);

test.skipIf(process.platform !== "linux" || !tmuxAvailable())(
  "tmux foreground handoff resumes a stopped same-group descendant",
  async () => {
    const home = makeHome();
    const paths = hostPaths(home);
    const transport = terminalTransportPaths(home);
    const wrapper = join(home, "bash");
    const interposerSource = join(home, "tcsetpgrp-gate.c");
    const interposer = join(home, "tcsetpgrp-gate.so");
    const descendantReady = join(home, "descendant-stopped");
    const handoffAssigned = join(home, "tcsetpgrp-assigned");
    const handoffRelease = join(home, "tcsetpgrp-release");
    const processProof = join(home, "process-proof");
    const resumedProof = join(home, "descendant-resumed");
    const laterStoppedPidProof = join(home, "later-stopped-pid");
    const laterResumedProof = join(home, "later-stop-resumed");

    writeFileSync(
      interposerSource,
      `#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int launcher_process(void) {
  char bytes[512];
  int fd = open("/proc/self/cmdline", O_RDONLY);
  if (fd < 0) return 0;
  ssize_t count = read(fd, bytes, sizeof(bytes));
  close(fd);
  const char needle[] = "--fiber-internal-terminal-tmux-launcher";
  if (count < (ssize_t)(sizeof(needle) - 1)) return 0;
  for (ssize_t i = 0; i <= count - (ssize_t)(sizeof(needle) - 1); i++) {
    if (memcmp(bytes + i, needle, sizeof(needle) - 1) == 0) return 1;
  }
  return 0;
}

static void touch_path(const char *path) {
  if (path == NULL) return;
  int fd = open(path, O_CREAT | O_WRONLY, 0600);
  if (fd >= 0) close(fd);
}

int tcsetpgrp(int fd, pid_t pgrp) {
  static int (*real_tcsetpgrp)(int, pid_t);
  if (real_tcsetpgrp == NULL) {
    *(void **)(&real_tcsetpgrp) = dlsym(RTLD_NEXT, "tcsetpgrp");
  }
  if (!launcher_process()) return real_tcsetpgrp(fd, pgrp);
  const char *ready = getenv("FIBER_E2E_TMUX_DESCENDANT_READY");
  for (int i = 0; ready != NULL && access(ready, F_OK) != 0 && i < 1000; i++) {
    usleep(5000);
  }
  int result = real_tcsetpgrp(fd, pgrp);
  touch_path(getenv("FIBER_E2E_TMUX_HANDOFF_ASSIGNED"));
  const char *release = getenv("FIBER_E2E_TMUX_HANDOFF_RELEASE");
  for (int i = 0; release != NULL && access(release, F_OK) != 0 && i < 1000; i++) {
    usleep(5000);
  }
  return result;
}
`,
    );
    execFileSync(
      "cc",
      [
        "-shared",
        "-fPIC",
        interposerSource,
        "-ldl",
        "-o",
        interposer,
      ],
      { stdio: "pipe", timeout: 10_000 },
    );
    writeFileSync(
      wrapper,
      `#!/bin/bash
set +m
(
  trap - TTIN
  printf '%s %s\n' "$BASHPID" "$(ps -o pgid= -p "$BASHPID" | tr -d ' ')" > ${JSON.stringify(processProof)}
  kill -TTIN "$BASHPID"
  : > ${JSON.stringify(resumedProof)}
) &
descendant=$!
while :; do
  state=$(ps -o stat= -p "$descendant" | tr -d ' ')
  case "$state" in
    T*) printf '%s %s\n' "$BASHPID" "$descendant" > ${JSON.stringify(descendantReady)}; break ;;
  esac
  sleep 0.005
done
wait "$descendant"
exec /bin/bash "$@"
`,
      { mode: 0o700 },
    );

    const tmuxResource = rememberPrivateTmuxServer(home);
    const baselinePeerArtifacts = tmuxPeerArtifacts();
    const baselineCaptureHelpers = tmuxCaptureHelperPids();
    const host = startHost(home, undefined, 250, {
      LD_PRELOAD: interposer,
      FIBER_E2E_TMUX_DESCENDANT_READY: descendantReady,
      FIBER_E2E_TMUX_HANDOFF_ASSIGNED: handoffAssigned,
      FIBER_E2E_TMUX_HANDOFF_RELEASE: handoffRelease,
      FIBER_TERMINAL_TEST_TMUX_DEADLINE_MS: "2000",
    });
    const stderr = streamText(host.stderr);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
    const hostFds = processFdCount(host.pid!);

    const startedAt = Date.now();
    const responsePromise = requestAction(
      connected.client,
      connected.revision!,
      124,
      "start",
      {
        cwd: home,
        command: "printf 'tmux-descendant-ready\\n'; exit 29",
        shell: { executable: { path: wrapper, clean_start: true } },
        backend: "tmux",
        return_when: { exit: {} },
        wait_ceiling_ms: 5_000,
        dimensions: { rows: 24, columns: 80 },
      },
    );
    await waitFor(
      () => existsSync(descendantReady) &&
        existsSync(handoffAssigned),
      5_000,
    );

    const [descendantPidText, processPgidText] = readFileSync(
      processProof,
      "utf8",
    ).trim().split(/\s+/);
    const [directPidText, observedDescendantText] = readFileSync(
      descendantReady,
      "utf8",
    ).trim().split(/\s+/);
    const descendantPid = Number(descendantPidText);
    const directPid = Number(directPidText);
    const processPgid = Number(processPgidText);
    expect(descendantPid).toBe(Number(observedDescendantText));
    expect(directPid).toBe(processPgid);

    const processLines = execFileSync(
      "ps",
      [
        "-eo",
        "pid=,ppid=,pgid=,sid=,tpgid=,stat=,wchan:32=,args=",
      ],
      { encoding: "utf8", stdio: "pipe" },
    ).split("\n");
    const processRow = (pid: number) => processLines
      .find((line) => Number(line.trim().split(/\s+/)[0]) === pid)!
      .trim()
      .split(/\s+/);
    const directRow = processRow(directPid);
    const descendantRow = processRow(descendantPid);
    const launcherPidText = directRow[1]!;
    expect(directRow.slice(0, 7)).toEqual([
      directPidText,
      launcherPidText,
      directPidText,
      launcherPidText,
      directPidText,
      expect.stringMatching(/^S/),
      "do_wait",
    ]);
    expect(descendantRow.slice(0, 7)).toEqual([
      descendantPidText,
      directPidText,
      directPidText,
      launcherPidText,
      directPidText,
      expect.stringMatching(/^T/),
      "do_signal_stop",
    ]);
    expect(processLines.some((line) =>
      line.includes("--fiber-internal-terminal-control")
    )).toBe(false);
    expect(existsSync(resumedProof)).toBe(false);
    const record = durableTerminalRecord(home).value as unknown as {
      backend_identity: string;
    };
    writeFileSync(handoffRelease, "", { mode: 0o600 });

    const response = await responsePromise;
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    const started = success(response, "start");
    expect(started).toMatchObject({
      outcome: { exited: 29 },
      session: { lifecycle: "exited", backend: "tmux" },
    });
    expect(existsSync(resumedProof)).toBe(true);
    const firstSessionId = (started.session as { session_id: string }).session_id;
    expect((await readSession(
      connected.client,
      connected.revision!,
      125,
      firstSessionId,
    )).output).toContain("tmux-descendant-ready");
    await waitFor(() => !existsSync(transport.tmuxSocket), 5_000);

    const later = await startCommand(
      connected.client,
      connected.revision!,
      126,
      {
        cwd: home,
        command:
          `set +m; /bin/bash -c 'trap - TSTP; printf "%s\\n" "$$" > ${JSON.stringify(laterStoppedPidProof)}; kill -TSTP "$$"; : > ${JSON.stringify(laterResumedProof)}' & wait`,
        shell: { executable: { path: "/bin/bash", clean_start: true } },
        backend: "tmux",
        returnWhen: { exit: {} },
        waitMs: 1_000,
      },
    );
    expect(later).toMatchObject({
      outcome: { safety_ceiling: {} },
      session: { lifecycle: "running", backend: "tmux" },
    });
    const laterSessionId = (later.session as { session_id: string }).session_id;
    const laterRecord = durableTerminalRecordFor(
      home,
      laterSessionId,
    ) as { backend_identity: string };
    const laterStoppedPid = Number(
      readFileSync(laterStoppedPidProof, "utf8").trim(),
    );
    expect(execFileSync(
      "ps",
      ["-o", "stat=", "-p", String(laterStoppedPid)],
      { encoding: "utf8", stdio: "pipe" },
    ).trim()).toStartWith("T");
    expect(existsSync(laterResumedProof)).toBe(false);
    rememberPrivateTmuxIdentities(tmuxResource);
    success(
      await requestAction(connected.client, connected.revision!, 127, "close", {
        session_id: laterSessionId,
        policy: "force",
      }),
      "close",
    );

    await waitFor(() => !existsSync(transport.tmuxSocket), 5_000);
    await waitFor(() => !processExists(directPid), 5_000);
    await waitFor(() => !processExists(descendantPid), 5_000);
    await waitFor(() => !processExists(laterStoppedPid), 5_000);
    await waitFor(() => directChildPids(host.pid!).length === 0, 5_000);
    await waitFor(
      () => JSON.stringify(tmuxCaptureHelperPids()) ===
        JSON.stringify(baselineCaptureHelpers),
      5_000,
    );
    expect(privateTmuxProcessPids(
      transport.tmuxSocket,
      [record.backend_identity, laterRecord.backend_identity],
    )).toEqual([]);
    expect(tmuxPeerArtifacts()).toEqual(baselinePeerArtifacts);
    expect(
      readdirSync(paths.dir).filter((name) => name.startsWith("tmux-")),
    ).toEqual([]);
    for (const identity of [record.backend_identity, laterRecord.backend_identity]) {
      expect(existsSync(`/tmp/fiber-tmux-capture-${identity}.sock`)).toBe(false);
      expect(existsSync(`/tmp/fiber-tmux-marker-${identity}.sock`)).toBe(false);
    }
    expect(processFdCount(host.pid!)).toBeLessThanOrEqual(hostFds + 2);
    for (const path of [
      wrapper,
      interposerSource,
      interposer,
      descendantReady,
      handoffAssigned,
      handoffRelease,
      processProof,
      resumedProof,
      laterStoppedPidProof,
      laterResumedProof,
    ]) {
      rmSync(path, { force: true });
      expect(existsSync(path)).toBe(false);
    }

    connected.client.close();
    expect(await waitForExit(host)).toBe(0);
    expect(await stderr).toBe("");
  },
  20_000,
);

test("missing tmux fails explicitly without changing native selection", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const emptyPath = join(home, "empty-path");
  mkdirSync(emptyPath);
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000, { PATH: emptyPath });
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const unavailable = await requestAction(
    connected.client,
    connected.revision!,
    130,
    "start",
    {
      cwd: home,
      command: "exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      return_when: { exit: {} },
      wait_ceiling_ms: 2_000,
      dimensions: { rows: 24, columns: 80 },
    },
  );
  expect(failure(unavailable)).toMatchObject({ action: "start", code: "pty_unavailable" });

  const native = await startNativeCommandFixture(connected.client, connected.revision!, 131_000, {
    cwd: home,
    command: "printf native-still-works; exit 0",
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    returnWhen: { exit: {} },
    waitMs: 5_000,
  });
  expect(native).toMatchObject({
    outcome: { exited: 0 },
    session: { backend: "native", lifecycle: "exited" },
  });

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, NATIVE_STARTUP_OBSERVATION_BUDGET_MS * 6 + 30_000);

test("incompatible tmux fails explicitly without native fallback", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const fakePath = join(home, "fake-path");
  mkdirSync(fakePath);
  const fakeTmux = join(fakePath, "tmux");
  writeFileSync(fakeTmux, "#!/bin/sh\nprintf 'tmux 3.1\\n'\n");
  chmodSync(fakeTmux, 0o700);
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000, { PATH: fakePath });
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  const incompatible = await requestAction(
    connected.client,
    connected.revision!,
    132,
    "start",
    {
      cwd: home,
      command: "exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      return_when: { exit: {} },
      wait_ceiling_ms: 2_000,
      dimensions: { rows: 24, columns: 80 },
    },
  );
  expect(failure(incompatible)).toMatchObject({
    action: "start",
    code: "protocol_incompatible",
  });
  expect(existsSync(join(paths.dir, "tmux.sock"))).toBe(false);

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, 15_000);

test.skipIf(!tmuxAvailable())("tmux resize checkpoint failures roll back without losing control", async () => {
  if (!existsSync("/bin/zsh")) return;
  for (const failurePoint of ["allocation", "storage", "checkpoint"]) {
    const home = makeHome();
    const releasePath = join(home, "resize-release");
    const paths = hostPaths(home);
    const host = startHost(home, undefined, 30_000, {
      FIBER_TERMINAL_TEST_TMUX_RESIZE_CHECKPOINT_FAILURE: failurePoint,
    });
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
    const started = await startCommand(connected.client, connected.revision!, 135, {
      cwd: home,
      command:
        "printf 'resize-ready\\n'; IFS= read -r input; printf 'resize-after:%s\\n' \"$input\"; " +
        `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done`,
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "resize-ready" },
      waitMs: 8_000,
      dimensions: { rows: 24, columns: 80 },
      startupAttempts: 2,
    });
    const sessionId = (started.session as { session_id: string }).session_id;
    const before = success(
      await requestAction(connected.client, connected.revision!, 136, "screen", {
        session_id: sessionId,
      }),
      "screen",
    ) as { snapshot: unknown };
    const recordBefore = durableTerminalRecord(home).value as unknown as {
      dimensions: { rows: number; columns: number };
    };

    const failed = await requestAction(
      connected.client,
      connected.revision!,
      137,
      "resize",
      { session_id: sessionId, dimensions: { rows: 30, columns: 90 } },
    );
    expect(failure(failed), failurePoint).toMatchObject({
      action: "resize",
      code: "invalid_request",
    });
    const after = success(
      await requestAction(connected.client, connected.revision!, 138, "screen", {
        session_id: sessionId,
      }),
      "screen",
    ) as { snapshot: unknown };
    expect(after.snapshot, failurePoint).toEqual(before.snapshot);
    const recordAfter = durableTerminalRecord(home).value as unknown as {
      dimensions: { rows: number; columns: number };
    };
    expect(recordAfter.dimensions, failurePoint).toEqual(recordBefore.dimensions);

    success(
      await requestAction(connected.client, connected.revision!, 139, "write", {
        session_id: sessionId,
        payload: { text: `${failurePoint}\n` },
      }),
      "write",
    );
    const continued = success(
      await requestAction(connected.client, connected.revision!, 140, "wait", {
        session_id: sessionId,
        return_when: { match: `resize-after:${failurePoint}` },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(continued.outcome, failurePoint).toEqual({ condition_met: {} });
    writeFileSync(releasePath, "release");
    const exited = success(
      await requestAction(connected.client, connected.revision!, 141, "wait", {
        session_id: sessionId,
        return_when: { exit: {} },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(exited.outcome, failurePoint).toEqual({ exited: 0 });
    success(
      await requestAction(connected.client, connected.revision!, 142, "close", {
        session_id: sessionId,
        policy: "graceful",
      }),
      "close",
    );
    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  }
}, 45_000);

test.skipIf(!tmuxAvailable())("revision four client cannot opt into Part 8 tmux recovery", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 10_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(
    paths.socket,
    { minimum: 4, current: 4 },
    3,
  );
  const response = await requestAction(
    connected.client,
    connected.revision!,
    133,
    "start",
    {
      cwd: home,
      command: "exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      return_when: { exit: {} },
      wait_ceiling_ms: 2_000,
      dimensions: { rows: 24, columns: 80 },
    },
  );
  expect(failure(response).code).toBe("protocol_incompatible");
  expect(existsSync(join(paths.dir, "tmux.sock"))).toBe(false);

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, 15_000);

test.skipIf(!tmuxAvailable() || process.platform !== "linux")(
  "terminal helpers keep running after the on-disk fx binary is replaced",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const home = makeHome();
    const paths = hostPaths(home);
    const liveBin = join(home, "fiber");
    copyFileSync(FIBER_BIN, liveBin);
    chmodSync(liveBin, 0o755);

    const host = startHost(home, undefined, 30_000, {}, liveBin);
    await waitFor(() => existsSync(paths.socket));
    const connected = await handshake(paths.socket, { minimum: 4, current: 5 });

    // Simulate `zig build` replacing the running binary.
    unlinkSync(liveBin);
    copyFileSync("/bin/sh", liveBin);
    chmodSync(liveBin, 0o755);

    const tmux = await startCommand(connected.client, connected.revision!, 510, {
      cwd: home,
      command: "printf 'rebuild-tmux-ok\\n'; exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { exit: {} },
      waitMs: 15_000,
    });
    expect(tmux.outcome, "tmux").toEqual({ exited: 0 });
    const tmuxId = (tmux.session as { session_id: string }).session_id;
    const tmuxOut = await readSession(
      connected.client,
      connected.revision!,
      512,
      tmuxId,
    );
    expect(tmuxOut.output, "tmux").toContain("rebuild-tmux-ok");

    const native = await startCommand(connected.client, connected.revision!, 511, {
      cwd: home,
      command: "printf 'rebuild-native-ok\\n'; exit 0",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "native",
      returnWhen: { exit: {} },
      waitMs: 15_000,
    });
    expect(native.outcome, "native").toEqual({ exited: 0 });
    const nativeId = (native.session as { session_id: string }).session_id;
    const nativeOut = await readSession(
      connected.client,
      connected.revision!,
      513,
      nativeId,
    );
    expect(nativeOut.output, "native").toContain("rebuild-native-ok");

    connected.client.close();
    host.kill("SIGKILL");
    await waitForExit(host);
  },
  TMUX_COMMAND_STARTUP_OBSERVATION_BUDGET_MS +
    NATIVE_STARTUP_OBSERVATION_BUDGET_MS,
);

test.skipIf(!tmuxAvailable())("tmux recovers every durable starting boundary", async () => {
  if (!existsSync("/bin/zsh")) return;
  const cases = [
    {
      name: "prepared",
      lifecycleKind: 1,
      commandless: false,
      env: { FIBER_TERMINAL_TEST_TMUX_PREPARED_RELEASE_DELAY_MS: "5000" },
    },
    {
      name: "shell-ready",
      lifecycleKind: 2,
      commandless: true,
      env: { FIBER_TERMINAL_TEST_TMUX_SHELL_READY_HOST_DELAY_MS: "5000" },
    },
    {
      name: "command-started",
      lifecycleKind: 3,
      commandless: false,
      env: { FIBER_TERMINAL_TEST_COMMAND_BOUNDARY_DELAY_MS: "5000" },
    },
  ];

  for (const fixture of cases) {
    const home = makeHome();
    const paths = hostPaths(home);
    const finish = join(home, `finish-${fixture.name}`);
    const firstHost = startHost(home, undefined, 30_000, fixture.env);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const pending = startCommand(first.client, first.revision!, 140, {
      cwd: home,
      command: fixture.commandless
        ? undefined
        : `printf 'recovered-${fixture.name}\\n'; while [[ ! -f ${JSON.stringify(finish)} ]]; do sleep 0.02; done; exit 0`,
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: fixture.commandless ? { started: {} } : { exit: {} },
      waitMs: 15_000,
    }).catch(() => null);
    await waitFor(() => {
      const lifecycleName = readdirSync(paths.dir).find((name) =>
        name.endsWith("-lifecycle.bin")
      );
      if (!lifecycleName) return false;
      const lifecycle = readFileSync(join(paths.dir, lifecycleName));
      return lifecycle.length >= fixture.lifecycleKind * 5 &&
        lifecycle[lifecycle.length - 5] === fixture.lifecycleKind;
    }, 8_000);
    const record = durableTerminalRecord(home);
    expect(record.value.lifecycle, fixture.name).toBe("starting");
    const hostArtifacts = readdirSync(paths.dir);
    if (!hostArtifacts.some((name) => name.endsWith("-manifest.json"))) {
      throw new Error(`${fixture.name}: ${JSON.stringify(hostArtifacts)}`);
    }
    const oldIdentity = readFileSync(paths.identity, "utf8");
    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);
    await pending;

    const recoveryTrace = join(home, `starting-${fixture.name}.log`);
    const replacement = startHost(home, undefined, 30_000, {
      FIBER_TRACE_LOG: recoveryTrace,
      FIBER_TRACE_SCOPES: "terminal_host",
    });
    await waitFor(
      () => existsSync(paths.socket) && existsSync(paths.identity) &&
        readFileSync(paths.identity, "utf8") !== oldIdentity,
      8_000,
    );
    rememberRecoveredAuthority(record.value.session_id, home, "tmux");
    const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
    if (fixture.commandless) {
      success(
        await requestAction(recovered.client, recovered.revision!, 144, "write", {
          session_id: record.value.session_id,
          payload: { text: `printf 'recovered-${fixture.name}\\n'; exit 0\n` },
        }),
        "write",
      );
    }
    const waitFrame = await requestAction(
      recovered.client,
      recovered.revision!,
      141,
      "wait",
      {
        session_id: record.value.session_id,
        return_when: { match: `recovered-${fixture.name}` },
        safety_ceiling_ms: 12_000,
      },
    );
    if (failureCode(waitFrame)) {
      throw new Error(
        `${fixture.name}: ${failureCode(waitFrame)}: ${readFileSync(recoveryTrace, "utf8")}`,
      );
    }
    const waited = success(waitFrame, "wait");
    if (fixture.commandless) {
      const outcome = waited.outcome as {
        condition_met?: Record<string, never>;
        exited?: number;
      };
      expect(outcome.condition_met !== undefined || outcome.exited === 0, fixture.name)
        .toBe(true);
    } else {
      expect(waited.outcome, fixture.name).toEqual({ condition_met: {} });
    }
    const inspected = success(
      await requestAction(recovered.client, recovered.revision!, 142, "inspect", {
        session_id: record.value.session_id,
      }),
      "inspect",
    ) as {
      session: { raw_gap?: { available_from: { segment: number; offset: number } } };
    };
    const outputFrame = await requestAction(
      recovered.client,
      recovered.revision!,
      145,
      "read",
      {
        session_id: record.value.session_id,
        cursor: inspected.session.raw_gap?.available_from ?? { segment: 1, offset: 0 },
      },
    );
    const output = success(outputFrame, "read") as { output: string };
    expect(output.output, fixture.name).toContain(`recovered-${fixture.name}`);
    if (!fixture.commandless) writeFileSync(finish, "go");
    const exited = success(
      await requestAction(recovered.client, recovered.revision!, 143, "wait", {
        session_id: record.value.session_id,
        return_when: { exit: {} },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(exited.outcome, fixture.name).toEqual({ exited: 0 });

    recovered.client.close();
    replacement.kill("SIGKILL");
    await waitForExit(replacement);
  }
}, 60_000);

test.skipIf(!tmuxAvailable())(
  "tmux recovery retains a prepared session when failure follows release",
  async () => {
    if (!existsSync("/bin/zsh")) return;
    const preparedReleaseDelayMs = 5_000;
    for (let pass = 1; pass <= 2; pass++) {
      const home = makeHome();
      const paths = hostPaths(home);
      const firstHost = startHost(home, undefined, 30_000, {
        FIBER_TERMINAL_TEST_TMUX_PREPARED_RELEASE_DELAY_MS:
          String(preparedReleaseDelayMs),
      });
      await waitFor(() => existsSync(paths.socket));
      const first = await handshake(paths.socket, { minimum: 4, current: 5 });
      const pending = startCommand(first.client, first.revision!, 144, {
        cwd: home,
        command: `printf 'release-recovered-${pass}\n'; sleep 30`,
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        backend: "tmux",
        returnWhen: { match: `release-recovered-${pass}` },
        waitMs: 15_000,
      }).catch(() => null);
      await waitFor(() => {
        const lifecycle = readdirSync(paths.dir).find((name) =>
          name.endsWith("-lifecycle.bin")
        );
        return lifecycle !== undefined &&
          readFileSync(join(paths.dir, lifecycle)).at(-5) === 1;
      }, preparedReleaseDelayMs + CLEANUP_FINALIZATION_BUDGET_MS);
      const record = durableTerminalRecord(home).value as unknown as {
        session_id: string;
        backend_identity: string;
      };
      const tmuxSocket = terminalTransportPaths(home).tmuxSocket;
      const sessionName = `fiber-${record.backend_identity}`;
      const panePid = Number(execFileSync(
        "tmux",
        ["-S", tmuxSocket, "display-message", "-p", "-t", sessionName, "#{pane_pid}"],
        { encoding: "utf8" },
      ).trim());
      first.client.close();
      firstHost.kill("SIGKILL");
      await waitForExit(firstHost);
      await pending;

      const failed = startHost(home, undefined, 30_000, {
        FIBER_TERMINAL_TEST_TMUX_RECOVERY_FAILURE: "release",
      });
      expect(await waitForExit(failed), `release:${pass}`).not.toBe(0);
      expect(processExists(panePid), `release:${pass}`).toBe(true);
      execFileSync("tmux", ["-S", tmuxSocket, "has-session", "-t", sessionName]);
      expect(existsSync(`/tmp/fiber-tmux-capture-${record.backend_identity}.sock`))
        .toBe(false);

      const replacement = startHost(home, undefined, 500);
      await waitFor(() => existsSync(paths.socket) && existsSync(paths.identity), 8_000);
      rememberRecoveredAuthority(record.session_id, home, "tmux");
      const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
      const waited = success(await requestAction(
        recovered.client,
        recovered.revision!,
        145,
        "wait",
        {
          session_id: record.session_id,
          return_when: { match: `release-recovered-${pass}` },
          safety_ceiling_ms: 8_000,
        },
      ), "wait");
      expect(waited.outcome, `release:${pass}`).toEqual({ condition_met: {} });
      success(await requestAction(
        recovered.client,
        recovered.revision!,
        146,
        "close",
        { session_id: record.session_id, policy: "force" },
      ), "close");
      await waitFor(() => !existsSync(tmuxSocket), 5_000);
      recovered.client.close();
      expect(await waitForExit(replacement)).toBe(0);
      expect(processExists(panePid), `release:${pass}`).toBe(false);
    }
  },
  45_000,
);

test.skipIf(!tmuxAvailable())("transient tmux recovery failures preserve the pane and retry state", async () => {
  if (!existsSync("/bin/zsh")) return;
  for (const failurePoint of [
    "after-backend",
    "lifecycle",
    "allocation",
    "storage",
    "identity",
    "capture",
    "screen-capture",
    "after-gap",
    "screen-reanchor",
    "begin-capture",
    "accept-capture",
    "output-thread",
    "control-thread",
  ]) {
    const home = makeHome();
    const paths = hostPaths(home);
    const firstHost = startHost(home, undefined, 30_000);
    await waitFor(() => existsSync(paths.socket));
    const first = await handshake(paths.socket, { minimum: 4, current: 5 });
    const started = await startCommand(first.client, first.revision!, 145, {
      cwd: home,
      command:
        "printf 'transient-ready\\n'; while ! IFS= read -r input; do :; done; " +
        "printf 'transient-after:%s\\n' \"$input\"; while ! IFS= read -r _; do :; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "transient-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const sessionId = (started.session as { session_id: string }).session_id;
    const sibling = await startCommand(first.client, first.revision!, 152, {
      cwd: home,
      command:
        "printf 'transient-sibling-ready\n'; while IFS= read -r input; do printf 'transient-sibling:%s\n' \"$input\"; done",
      shell: { executable: { path: "/bin/zsh", clean_start: true } },
      backend: "tmux",
      returnWhen: { match: "transient-sibling-ready" },
      waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
      startupAttempts: 2,
    });
    const siblingId = (sibling.session as { session_id: string }).session_id;
    const tmuxSocket = join(paths.dir, "tmux.sock");
    const backendIdentity = (durableTerminalRecordFor(home, sessionId) as {
      backend_identity: string;
    }).backend_identity;
    const siblingIdentity = (durableTerminalRecordFor(home, siblingId) as {
      backend_identity: string;
    }).backend_identity;
    const sessionName = `fiber-${backendIdentity}`;
    const siblingName = `fiber-${siblingIdentity}`;
    const panePid = Number(execFileSync(
      "tmux",
      ["-S", tmuxSocket, "display-message", "-p", "-t", sessionName, "#{pane_pid}"],
      { encoding: "utf8" },
    ).trim());
    const siblingPanePid = Number(execFileSync(
      "tmux",
      ["-S", tmuxSocket, "display-message", "-p", "-t", siblingName, "#{pane_pid}"],
      { encoding: "utf8" },
    ).trim());
    first.client.close();
    firstHost.kill("SIGKILL");
    await waitForExit(firstHost);

    const failedRecovery = startHost(home, undefined, 30_000, {
      FIBER_TERMINAL_TEST_TMUX_RECOVERY_FAILURE: failurePoint,
      FIBER_TERMINAL_TEST_TMUX_RECOVERY_SESSION_ID: sessionId,
    });
    expect(await waitForExit(failedRecovery), failurePoint).not.toBe(0);
    expect(() => process.kill(panePid, 0), failurePoint).not.toThrow();
    expect(() => process.kill(siblingPanePid, 0), failurePoint).not.toThrow();
    execFileSync("tmux", ["-S", tmuxSocket, "has-session", "-t", sessionName]);
    execFileSync("tmux", ["-S", tmuxSocket, "has-session", "-t", siblingName]);
    await waitFor(
      () => !existsSync(`/tmp/fiber-tmux-capture-${backendIdentity}.sock`),
      5_000,
    ).catch(() => {
      throw new Error(`${failurePoint}: target capture socket retained`);
    });
    expect(existsSync(`/tmp/fiber-tmux-capture-${backendIdentity}.sock`), failurePoint)
      .toBe(false);

    const failedIdentity = existsSync(paths.identity)
      ? readFileSync(paths.identity, "utf8")
      : null;
    const replacement = startHost(home, undefined, 500);
    await waitFor(
      () => (existsSync(paths.socket) && existsSync(paths.identity) &&
        (failedIdentity === null ||
          readFileSync(paths.identity, "utf8") !== failedIdentity)) ||
        replacement.exitCode !== null,
      8_000,
    );
    if (replacement.exitCode !== null) {
      throw new Error(
        `retry host exited at ${failurePoint}: ${await streamText(replacement.stderr)}`,
      );
    }
    const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
    const siblingInspect = success(
      await requestAction(recovered.client, recovered.revision!, 153, "inspect", {
        session_id: siblingId,
      }),
      "inspect",
    );
    expect(siblingInspect.session, failurePoint).toMatchObject({
      lifecycle: "running",
      backend: "tmux",
    });
    const inspect = success(
      await requestAction(recovered.client, recovered.revision!, 146, "inspect", {
        session_id: sessionId,
      }),
      "inspect",
    ) as {
      session: {
        lifecycle: string;
        raw_gap: { available_from: { segment: number; offset: number } };
      };
    };
    expect(inspect.session.lifecycle, failurePoint).toBe("running");
    expect(inspect.session.raw_gap.available_from.segment, failurePoint).toBe(2);
    success(
      await requestAction(recovered.client, recovered.revision!, 147, "write", {
        session_id: sessionId,
        payload: { text: `${failurePoint}\n` },
      }),
      "write",
    );
    const resumed = success(
      await requestAction(recovered.client, recovered.revision!, 148, "wait", {
        session_id: sessionId,
        return_when: { match: `transient-after:${failurePoint}` },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(resumed.outcome, failurePoint).toEqual({ condition_met: {} });
    const continued = success(
      await requestAction(recovered.client, recovered.revision!, 149, "inspect", {
        session_id: sessionId,
      }),
      "inspect",
    );
    expect(continued.session, failurePoint).toMatchObject({ lifecycle: "running" });
    const output = success(
      await requestAction(recovered.client, recovered.revision!, 150, "read", {
        session_id: sessionId,
        cursor: inspect.session.raw_gap.available_from,
      }),
      "read",
    ) as { output: string };
    expect(output.output, failurePoint).toContain(
      `transient-after:${failurePoint}`,
    );
    success(
      await requestAction(recovered.client, recovered.revision!, 154, "write", {
        session_id: siblingId,
        payload: { text: `${failurePoint}\n` },
      }),
      "write",
    );
    const siblingWait = success(
      await requestAction(recovered.client, recovered.revision!, 155, "wait", {
        session_id: siblingId,
        return_when: { match: `transient-sibling:${failurePoint}` },
        safety_ceiling_ms: 5_000,
      }),
      "wait",
    );
    expect(siblingWait.outcome, failurePoint).toEqual({ condition_met: {} });
    await forceCloseTerminalFixture(
      recovered.client,
      recovered.revision!,
      151,
      sessionId,
    );
    expect(existsSync(tmuxSocket), failurePoint).toBe(true);
    success(
      await requestAction(recovered.client, recovered.revision!, 156, "close", {
        session_id: siblingId,
        policy: "force",
      }),
      "close",
    );
    await waitFor(() => !existsSync(tmuxSocket), 5_000);
    recovered.client.close();
    expect(await waitForExit(replacement)).toBe(0);
    expect(processExists(panePid), failurePoint).toBe(false);
    expect(processExists(siblingPanePid), failurePoint).toBe(false);
    expect(existsSync(`/tmp/fiber-tmux-capture-${backendIdentity}.sock`), failurePoint)
      .toBe(false);
    expect(existsSync(`/tmp/fiber-tmux-capture-${siblingIdentity}.sock`), failurePoint)
      .toBe(false);
    expect(existsSync(`/tmp/fiber-tmux-marker-${backendIdentity}.sock`), failurePoint)
      .toBe(false);
    expect(existsSync(`/tmp/fiber-tmux-marker-${siblingIdentity}.sock`), failurePoint)
      .toBe(false);
  }
}, 180_000);

test.skipIf(!tmuxAvailable())("private tmux teardown owns partial recovery resources", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const tmuxSocket = join(paths.dir, "tmux.sock");
  const firstHost = startHost(home, undefined, 30_000);
  await waitFor(() => existsSync(paths.socket));
  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  await startCommand(first.client, first.revision!, 151, {
    cwd: home,
    command: "printf cleanup-ready; sleep 30",
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    backend: "tmux",
    returnWhen: { match: "cleanup-ready" },
    waitMs: TMUX_MARKER_IO_DEADLINE_MS + CLEANUP_FINALIZATION_BUDGET_MS,
    startupAttempts: 2,
  });
  const sessionName = execFileSync(
    "tmux",
    ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
    { encoding: "utf8" },
  ).trim();
  const backendIdentity = sessionName.slice("fiber-".length);
  const panePid = Number(execFileSync(
    "tmux",
    ["-S", tmuxSocket, "display-message", "-p", "-t", sessionName, "#{pane_pid}"],
    { encoding: "utf8" },
  ).trim());
  first.client.close();
  firstHost.kill("SIGKILL");
  await waitForExit(firstHost);

  const failedRecovery = startHost(home, undefined, 30_000, {
    FIBER_TERMINAL_TEST_TMUX_RECOVERY_FAILURE: "after-gap",
  });
  expect(await waitForExit(failedRecovery)).not.toBe(0);
  const proof = await cleanupPrivateTmuxServer(
    rememberPrivateTmuxServer(home),
  );

  expect(proof.identities).toContain(backendIdentity);
  expect(proof.panePids).toContain(panePid);
  expect(proof.panePids.every((pid) => !processExists(pid))).toBe(true);
  expect(proof.processPids.every((pid) => !processExists(pid))).toBe(true);
  expect(privateTmuxProcessPids(tmuxSocket, [backendIdentity])).toEqual([]);
  expect(existsSync(tmuxSocket)).toBe(false);
  expect(existsSync(`/tmp/fiber-tmux-capture-${backendIdentity}.sock`)).toBe(false);
  expect(existsSync(`/tmp/fiber-tmux-marker-${backendIdentity}.sock`)).toBe(false);
  expect(() =>
    execFileSync("tmux", ["-S", tmuxSocket, "has-session", "-t", sessionName], {
      stdio: "pipe",
    })
  ).toThrow();

  const retryProbe: PrivateTmuxResource = {
    socket: join(paths.dir, "cleanup-retry-probe.sock"),
    durableDir: paths.dir,
    identities: new Set(),
  };
  privateTmuxServers.set(retryProbe.socket, retryProbe);
  const transportRoot = mkdtempSync(join(tmpdir(), "fiber-terminal-cleanup-root-"));
  transportRoots.add(transportRoot);
  const attempts: string[] = [];
  const cleanupFailure = new Error("cleanup failure");
  const pendingChild = children[0]!;
  let releasePendingChild!: () => void;
  let childWaitStarted = false;
  let childWaitReleased = false;
  const pendingChildExit = new Promise<number>((resolve) => {
    releasePendingChild = () => {
      childWaitReleased = true;
      resolve(0);
    };
  });
  let observedFailure: unknown;
  const cleanup = cleanupOwnedTestResources(async (resource) => {
    attempts.push(resource.socket);
    if (resource.socket === tmuxSocket) throw cleanupFailure;
    return { identities: [], panePids: [], processPids: [] };
  }, async (child) => {
    if (child === pendingChild) {
      childWaitStarted = true;
      return await pendingChildExit;
    }
    return await waitForExit(child);
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(childWaitStarted).toBe(true);
    expect(childWaitReleased).toBe(false);
    expect(attempts).toEqual([tmuxSocket, retryProbe.socket]);
    expect(privateTmuxServers.size).toBe(0);
    expect(homes).toEqual([]);
    expect(transportRoots.size).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(transportRoot)).toBe(false);
  } finally {
    releasePendingChild();
    try {
      await cleanup;
    } catch (error) {
      observedFailure = error;
    }
  }
  expect(observedFailure).toBe(cleanupFailure);
  expect(attempts).toEqual([tmuxSocket, retryProbe.socket]);
  let childRetryCount = 0;
  await cleanupOwnedTestResources(async (resource) => {
    attempts.push(resource.socket);
    return { identities: [], panePids: [], processPids: [] };
  }, async (child) => {
    childRetryCount += 1;
    return await waitForExit(child);
  });
  expect(attempts).toEqual([tmuxSocket, retryProbe.socket]);
  expect(childRetryCount).toBe(0);
}, 25_000);

test.skipIf(!tmuxAvailable())("alternate-screen host loss keeps tmux facts but reports unprovable modes", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const firstHost = startHost(home, undefined, 30_000);
  await waitFor(() => existsSync(paths.socket));
  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  const command = [
    "printf '\\033[?1049h\\033[?25l\\033[4h\\033[?1h\\033=\\033[?6h\\033[?7l\\033[?1000h\\033[?2004h\\033[?1004h\\033[>1u'",
    "printf 'alt-mode-ready'",
    "IFS= read -r _",
  ].join("; ");
  const started = await startInteractiveTmuxFixture(
    first.client,
    first.revision!,
    150,
    {
      cwd: home,
      command,
      marker: "alt-mode-ready",
    },
  );
  const sessionId = (started.session as { session_id: string }).session_id;
  const tmuxSocket = join(paths.dir, "tmux.sock");
  const sessionName = execFileSync(
    "tmux",
    ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
    { encoding: "utf8" },
  ).trim();
  const captureTmuxFacts = () => ({
    cells: execFileSync(
      "tmux",
      ["-S", tmuxSocket, "capture-pane", "-p", "-e", "-t", sessionName],
      { encoding: "utf8" },
    ),
    cursorAndModes: execFileSync(
      "tmux",
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        sessionName,
        "#{cursor_y},#{cursor_x},#{cursor_flag},#{cursor_shape},#{alternate_on},#{origin_flag},#{wrap_flag},#{insert_flag},#{mouse_standard_flag},#{keypad_cursor_flag},#{keypad_flag}",
      ],
      { encoding: "utf8" },
    ).trim(),
  });
  const before = captureTmuxFacts();
  expect(before.cells).toContain("alt-mode-ready");
  expect(before.cursorAndModes.split(",")[4]).toBe("1");
  const oldIdentity = readFileSync(paths.identity, "utf8");
  first.client.close();
  firstHost.kill("SIGKILL");
  await waitForExit(firstHost);

  const replacement = startHost(home, undefined, 30_000);
  await waitFor(
    () => existsSync(paths.socket) && existsSync(paths.identity) &&
      readFileSync(paths.identity, "utf8") !== oldIdentity,
    8_000,
  );
  const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
  success(
    await requestAction(recovered.client, recovered.revision!, 151, "inspect", {
      session_id: sessionId,
    }),
    "inspect",
  );
  expect(captureTmuxFacts()).toEqual(before);
  const screen = await requestAction(
    recovered.client,
    recovered.revision!,
    152,
    "screen",
    { session_id: sessionId },
  );
  expect(failure(screen).code).toBe("screen_unavailable");

  success(
    await requestAction(recovered.client, recovered.revision!, 153, "close", {
      session_id: sessionId,
      policy: "force",
    }),
    "close",
  );
  recovered.client.close();
  replacement.kill("SIGKILL");
  await waitForExit(replacement);
}, TMUX_COMMANDLESS_STARTUP_OBSERVATION_BUDGET_MS +
  TERMINAL_OPERATION_OBSERVATION_BUDGET_MS + 30_000);

test.skipIf(!tmuxAvailable())("tmux recovery records one raw gap and refuses an unprovable screen", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const release = join(home, "release-command");
  const firstHost = startHost(home, undefined, 30_000);
  await waitFor(() => existsSync(paths.socket));
  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  const started = await startCommand(first.client, first.revision!, 112, {
    cwd: home,
    command: `printf 'before-loss\\n'; while [[ ! -f ${JSON.stringify(release)} ]]; do sleep 0.02; done; printf 'during-loss\\n'; exit 37`,
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    backend: "tmux",
    returnWhen: { match: "before-loss" },
    waitMs: 8_000,
    startupAttempts: 2,
  });
  const sessionId = (started.session as { session_id: string }).session_id;
  const before = await readSession(first.client, first.revision!, 113, sessionId);
  expect(before.output).toContain("before-loss");

  const oldIdentity = readFileSync(paths.identity, "utf8");
  first.client.close();
  firstHost.kill("SIGKILL");
  await waitForExit(firstHost);
  writeFileSync(release, "go");
  await waitFor(
    () => readdirSync(paths.dir).some((name) => {
      if (!name.endsWith("-lifecycle.bin")) return false;
      const bytes = readFileSync(join(paths.dir, name));
      return bytes.length >= 20 && bytes[bytes.length - 5] === 4;
    }),
    5_000,
  );

  const replacement = startHost(home, undefined, 30_000);
  await waitFor(
    () =>
      existsSync(paths.socket) &&
      existsSync(paths.identity) &&
      readFileSync(paths.identity, "utf8") !== oldIdentity,
    5_000,
  );
  const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
  const inspect = success(
    await requestAction(
      recovered.client,
      recovered.revision!,
      114,
      "inspect",
      { session_id: sessionId },
    ),
    "inspect",
  ) as { session: { lifecycle: string; raw_gap: unknown; output_cursor: { segment: number } } };
  expect(inspect.session.lifecycle).toBe("exited");
  expect(inspect.session.raw_gap).not.toBeNull();
  expect(inspect.session.output_cursor.segment).toBe(2);

  const retained = await readSession(
    recovered.client,
    recovered.revision!,
    115,
    sessionId,
  );
  expect(retained.output).toContain("before-loss");
  expect(retained.output).not.toContain("during-loss");
  const screen = await requestAction(
    recovered.client,
    recovered.revision!,
    116,
    "screen",
    { session_id: sessionId },
  );
  expect(failure(screen)).toMatchObject({
    action: "screen",
    code: "screen_unavailable",
  });
  await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));

  recovered.client.close();
  replacement.kill("SIGKILL");
  await waitForExit(replacement);
}, 25_000);

test.skipIf(!tmuxAvailable())("tmux recovery rejects a replaced pane without signaling it", async () => {
  if (!existsSync("/bin/zsh") || !existsSync("/bin/sleep")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const firstHost = startHost(home, undefined, 30_000);
  await waitFor(() => existsSync(paths.socket));
  const first = await handshake(paths.socket, { minimum: 4, current: 5 });
  const started = await startCommand(first.client, first.revision!, 133, {
    cwd: home,
    command: "printf identity-ready; sleep 30",
    shell: { executable: { path: "/bin/zsh", clean_start: true } },
    backend: "tmux",
    returnWhen: { match: "identity-ready" },
    waitMs: 8_000,
  });
  const sessionId = (started.session as { session_id: string }).session_id;
  const tmuxSocket = join(paths.dir, "tmux.sock");
  const sessionName = execFileSync(
    "tmux",
    ["-S", tmuxSocket, "list-sessions", "-F", "#{session_name}"],
    { encoding: "utf8" },
  ).trim();
  const backendIdentity = sessionName.slice("fiber-".length);
  const oldIdentity = readFileSync(paths.identity, "utf8");
  first.client.close();
  firstHost.kill("SIGKILL");
  await waitForExit(firstHost);

  execFileSync("tmux", ["-S", tmuxSocket, "kill-session", "-t", sessionName]);
  execFileSync(
    "tmux",
    [
      "-S",
      tmuxSocket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      "terminal",
      "/bin/sleep 30",
    ],
  );
  execFileSync("tmux", [
    "-S",
    tmuxSocket,
    "set-option",
    "-g",
    "@fiber_terminal_namespace",
    "1",
  ]);
  execFileSync("tmux", [
    "-S",
    tmuxSocket,
    "set-option",
    "-t",
    sessionName,
    "@fiber_terminal_namespace",
    backendIdentity,
  ]);

  const replacement = startHost(home, undefined, 30_000);
  await waitFor(
    () =>
      existsSync(paths.socket) &&
      existsSync(paths.identity) &&
      readFileSync(paths.identity, "utf8") !== oldIdentity,
    5_000,
  );
  const recovered = await handshake(paths.socket, { minimum: 4, current: 5 });
  const inspect = success(
    await requestAction(recovered.client, recovered.revision!, 134, "inspect", {
      session_id: sessionId,
    }),
    "inspect",
  );
  expect(inspect.session).toMatchObject({ lifecycle: "lost", backend: "tmux" });
  expect(
    execFileSync("tmux", ["-S", tmuxSocket, "has-session", "-t", sessionName]),
  ).toBeDefined();

  execFileSync("tmux", ["-S", tmuxSocket, "kill-server"]);

  recovered.client.close();
  replacement.kill("SIGKILL");
  await waitForExit(replacement);
}, 25_000);

test.skipIf(!tmuxAvailable())("tmux repeated force-close cycles leave no fx server", async () => {
  if (!existsSync("/bin/zsh")) return;
  const home = makeHome();
  const paths = hostPaths(home);
  const host = startHost(home, undefined, 30_000);
  await waitFor(() => existsSync(paths.socket));
  const connected = await handshake(paths.socket, { minimum: 4, current: 5 });
  for (let index = 0; index < 3; index++) {
    const started = await startCommand(
      connected.client,
      connected.revision!,
      140 + index * 2,
      {
        cwd: home,
        command: `printf cycle-${index}-ready; sleep 30`,
        shell: { executable: { path: "/bin/zsh", clean_start: true } },
        backend: "tmux",
        returnWhen: { match: `cycle-${index}-ready` },
        waitMs: 8_000,
        startupAttempts: 2,
      },
    );
    const sessionId = (started.session as { session_id: string }).session_id;
    const closed = success(
      await requestAction(
        connected.client,
        connected.revision!,
        141 + index * 2,
        "close",
        { session_id: sessionId, policy: "force" },
      ),
      "close",
    );
    expect(closed.session).toMatchObject({ lifecycle: "closed", backend: "tmux" });
    await waitFor(() => !existsSync(join(paths.dir, "tmux.sock")));
  }

  connected.client.close();
  host.kill("SIGKILL");
  await waitForExit(host);
}, 30_000);

