const std = @import("std");
const action_executor = @import("action_executor.zig");
const client = @import("client.zig");
const command_contract = @import("../execution/command_contract.zig");
const contracts = @import("contracts.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const identity = @import("identity.zig");
const managed_execution = @import("../execution/managed_execution.zig");
const managed_observer = @import("managed_observer.zig");
const operation = @import("operation.zig");
const session_child_store = @import("../session/session_child_store.zig");
const store = @import("store.zig");

const Allocator = std.mem.Allocator;

/// Ownership context for background session enumeration and stop. Mirrors the
/// fields the shell tool already carries; both the shell `list`/`stop`
/// actions and the human `/background` command build one.
pub const SessionContext = struct {
    alloc: Allocator,
    lifecycle_allocator: Allocator,
    terminal_client: ?*client.Runtime = null,
    owner: ?*session_child_store.SessionChildCapability = null,
    durable_session_id: ?[]const u8 = null,
    workspace_root: []const u8 = "",
    transport_role: contracts.TransportRole = .interactive,
    max_output_bytes: usize = 64 * 1024,
    cancel_flag: ?*std.atomic.Value(bool) = null,
};

pub const ParsedTerminalExecution = struct {
    result: contracts.OwnedResult,

    pub fn deinit(self: *ParsedTerminalExecution, alloc: Allocator) void {
        self.result.deinit(alloc);
        self.* = undefined;
    }
};

pub fn stateName(state: managed_execution.SnapshotState) []const u8 {
    return switch (state) {
        .running => "running",
        .completed => "completed",
        .stopped => "stopped",
        .lost => "lost",
    };
}

/// Shell tool failure body contract, shared so agent and human surfaces match.
pub fn failureBody(alloc: Allocator, err: anyerror) error{OutOfMemory}![]u8 {
    if (err == error.OutOfMemory) return error.OutOfMemory;
    return std.fmt.allocPrint(
        alloc,
        "{{\"error\":{{\"tool\":\"shell\",\"code\":\"{s}\",\"retryable\":false}}}}",
        .{@errorName(err)},
    );
}

/// Enumerate background sessions. Synchronizes owned TTY sessions (including
/// resumed ones absent from this process) through the native owner-catalog
/// list path before projecting the process-local registry.
pub fn listSessions(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
) error{OutOfMemory}![]managed_execution.ListItem {
    if (observerContext(ctx, runtime)) |observer| {
        managed_observer.syncOwned(observer) catch |err| {
            debug_trace.logf(
                "background",
                "owner catalog sync failed err={s}",
                .{@errorName(err)},
            );
        };
    }
    return runtime.list(ctx.alloc);
}

pub const StopOutcome = union(enum) {
    /// Unsettled snapshot; the caller formats it and commits or cancels the
    /// delivery reservation, then deinits it.
    prepared: managed_execution.PreparedSnapshot,
    /// Owned JSON failure body in the shell tool contract shape.
    failure: []u8,
};

/// Stop one background session for the given actor. Captured sessions stop
/// through the runtime; TTY sessions go through terminal signal and close
/// under a claim minted for that actor.
pub fn stopSession(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
    session_id: []const u8,
    force: bool,
    actor: contracts.ActorRole,
) error{OutOfMemory}!StopOutcome {
    ensureOwnedTtyIndexed(ctx, runtime, session_id) catch |err|
        return .{ .failure = try failureBody(ctx.alloc, err) };
    if (runtime.isTombstone(session_id)) {
        if (runtime.retainedTerminalSnapshot(ctx.alloc, session_id) catch |err|
            return .{ .failure = try failureBody(ctx.alloc, err) }) |retained|
        {
            return .{ .prepared = retained };
        }
    }
    if (runtime.backendFor(session_id) == .tty) {
        if (runtime.stateFor(session_id)) |state| {
            if (state != .running) {
                return finishTerminalTtyStop(ctx, runtime, session_id, state, actor);
            }
        }
        refreshTtyExecution(ctx, runtime, session_id, "") catch |err|
            return .{ .failure = try failureBody(ctx.alloc, err) };
        if (runtime.stateFor(session_id)) |state| {
            if (state != .running) {
                return finishTerminalTtyStop(ctx, runtime, session_id, state, actor);
            }
        }
        return callTtyStop(ctx, runtime, session_id, force, actor);
    }
    const prepared = runtime.stop(
        ctx.alloc,
        session_id,
        force,
    ) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    return .{ .prepared = prepared };
}

fn callTtyStop(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
    session_id: []const u8,
    force: bool,
    actor: contracts.ActorRole,
) error{OutOfMemory}!StopOutcome {
    runtime.preemptWait(session_id);
    var signaled = executeAuthorizedTerminalAs(ctx, session_id, .{ .signal = .{
        .session_id = session_id,
        .signal = if (force) .kill else .terminate,
        .authority = null,
    } }, actor) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    defer signaled.deinit(ctx.alloc);
    switch (signaled.result.view()) {
        .failure => return .{ .failure = try cloneTerminalFailureBody(ctx.alloc, signaled.result.view()) },
        .success => |success| switch (success) {
            .signal => {},
            else => return .{ .failure = try failureBody(ctx.alloc, error.InvalidTerminalResult) },
        },
    }

    var stopped_status: ?command_contract.CommandStatus = null;
    var waited = executeAuthorizedTerminalAs(ctx, session_id, .{ .wait = .{
        .session_id = session_id,
        .return_when = .exit,
        .safety_ceiling_ms = 2_000,
        .authority = null,
    } }, actor) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    defer waited.deinit(ctx.alloc);
    const wait_result = switch (waited.result.view()) {
        .failure => return .{ .failure = try cloneTerminalFailureBody(ctx.alloc, waited.result.view()) },
        .success => |success| switch (success) {
            .wait => |value| value,
            else => return .{ .failure = try failureBody(ctx.alloc, error.InvalidTerminalResult) },
        },
    };
    stopped_status = statusFromOutcome(wait_result.outcome);
    var observed = managed_observer.observe(
        observerContext(ctx, runtime) orelse
            return .{ .failure = try failureBody(ctx.alloc, error.TerminalUnavailable) },
        session_id,
        managed_observer.snapshotState(wait_result.session, wait_result.outcome),
        runtime.ttyCursorFor(session_id),
    ) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    defer observed.deinit(ctx.alloc);

    var closed = executeAuthorizedTerminalAs(ctx, session_id, .{ .close = .{
        .session_id = session_id,
        .policy = if (force) .force else .graceful,
        .authority = null,
    } }, actor) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    defer closed.deinit(ctx.alloc);
    switch (closed.result.view()) {
        .failure => return .{ .failure = try cloneTerminalFailureBody(ctx.alloc, closed.result.view()) },
        .success => |success| switch (success) {
            .close => {},
            else => return .{ .failure = try failureBody(ctx.alloc, error.InvalidTerminalResult) },
        },
    }
    const prepared = runtime.updateTty(ctx.alloc, .{
        .execution_id = session_id,
        .command = "",
        .state = .{ .stopped = stopped_status },
        .output = observed.output,
        .replay_output = observed.replay_output,
        .next_cursor = observed.next_cursor,
        .output_incomplete = observed.output_incomplete,
        .error_name = if (observed.timed_out) "TimeoutExpired" else null,
        .max_output_bytes = ctx.max_output_bytes,
        .published_running = true,
    }) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    return .{ .prepared = prepared };
}

fn executeTerminal(
    ctx: SessionContext,
    request: contracts.ActionRequest,
) !ParsedTerminalExecution {
    return .{ .result = try action_executor.execute(.{
        .alloc = ctx.alloc,
        .lifecycle_allocator = ctx.lifecycle_allocator,
        .runtime = ctx.terminal_client orelse return error.TerminalUnavailable,
        .cancel_flag = ctx.cancel_flag,
    }, request) };
}

pub fn executeAuthorizedTerminal(
    ctx: SessionContext,
    session_id: []const u8,
    request: contracts.ActionRequest,
) !ParsedTerminalExecution {
    return executeAuthorizedTerminalAs(ctx, session_id, request, .agent);
}

fn executeAuthorizedTerminalAs(
    ctx: SessionContext,
    session_id: []const u8,
    request: contracts.ActionRequest,
    actor: contracts.ActorRole,
) !ParsedTerminalExecution {
    var authority = try reloadTerminalAuthorityAs(ctx, session_id, actor);
    defer authority.deinit();
    const authorized: contracts.ActionRequest = switch (request) {
        .read => |value| .{ .read = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .write => |value| .{ .write = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .wait => |value| .{ .wait = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .signal => |value| .{ .signal = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .close => |value| .{ .close = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .screen => |value| .{ .screen = blk: {
            var owned = value;
            owned.authority = authority.view();
            break :blk owned;
        } },
        .start, .inspect, .list, .resize => return error.InvalidTerminalRequest,
    };
    return executeTerminal(ctx, authorized);
}

fn reloadTerminalAuthority(
    ctx: SessionContext,
    session_id: []const u8,
) !operation.OwnedAuthorityClaim {
    return reloadTerminalAuthorityAs(ctx, session_id, .agent);
}

fn reloadTerminalAuthorityAs(
    ctx: SessionContext,
    session_id: []const u8,
    actor: contracts.ActorRole,
) !operation.OwnedAuthorityClaim {
    const owner = ctx.owner orelse return error.TerminalAuthorityUnavailable;
    const durable_session_id = ctx.durable_session_id orelse
        return error.TerminalAuthorityUnavailable;
    var profile_user_buffer: [64]u8 = undefined;
    const profile_user = identity.profileUser(&profile_user_buffer) orelse
        return error.TerminalAuthorityUnavailable;
    return store.reloadOwnerAuthorityClaim(ctx.alloc, owner, .{
        .terminal_session_id = session_id,
        .profile_user = profile_user,
        .durable_session_id = durable_session_id,
        .workspace_root = ctx.workspace_root,
        .transport_role = ctx.transport_role,
        .actor = actor,
    });
}

pub fn cloneTerminalFailureBody(
    alloc: Allocator,
    result: contracts.Result,
) error{OutOfMemory}![]u8 {
    if (result == .success) return failureBody(alloc, error.InvalidTerminalResult);
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    std.json.Stringify.value(result, .{}, &out.writer) catch
        return error.OutOfMemory;
    return try out.toOwnedSlice();
}

fn statusFromOutcome(
    outcome: contracts.ReturnOutcome,
) ?command_contract.CommandStatus {
    return switch (outcome) {
        .exited => |code| .{ .exit_code = code },
        .signal => |signal| .{ .signal = signal },
        .started, .condition_met, .safety_ceiling, .cancelled => null,
    };
}

pub fn finalizeCompletedTty(
    ctx: SessionContext,
    session_id: []const u8,
    state: managed_execution.SnapshotState,
) !void {
    return finalizeCompletedTtyAs(ctx, session_id, state, .agent);
}

fn finalizeCompletedTtyAs(
    ctx: SessionContext,
    session_id: []const u8,
    state: managed_execution.SnapshotState,
    actor: contracts.ActorRole,
) !void {
    switch (state) {
        .completed => {},
        .running, .stopped, .lost => return,
    }
    var closed = try executeAuthorizedTerminalAs(ctx, session_id, .{ .close = .{
        .session_id = session_id,
        .policy = .graceful,
        .authority = null,
    } }, actor);
    defer closed.deinit(ctx.alloc);
    switch (closed.result.view()) {
        .failure => return error.TerminalCloseFailed,
        .success => |success| switch (success) {
            .close => {},
            else => return error.InvalidTerminalResult,
        },
    }
}

pub fn observerContext(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
) ?managed_observer.Context {
    return .{
        .alloc = ctx.alloc,
        .lifecycle_allocator = ctx.lifecycle_allocator,
        .terminal_client = ctx.terminal_client orelse return null,
        .managed_runtime = runtime,
        .owner = ctx.owner orelse return null,
        .durable_session_id = ctx.durable_session_id orelse return null,
        .workspace_root = ctx.workspace_root,
        .transport_role = ctx.transport_role,
        .max_output_bytes = ctx.max_output_bytes,
        .cancel_flag = ctx.cancel_flag,
    };
}

pub fn ensureOwnedTtyIndexed(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
    session_id: []const u8,
) !void {
    if (runtime.stateFor(session_id) != null) return;
    const observer = observerContext(ctx, runtime) orelse return;
    try managed_observer.syncOwned(observer);
}

fn refreshTtyExecution(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
    session_id: []const u8,
    command: []const u8,
) !void {
    return managed_observer.refresh(
        observerContext(ctx, runtime) orelse
            return error.TerminalAuthorityUnavailable,
        session_id,
        command,
    );
}

test "background list projects runtime entries without an owner catalog" {
    const alloc = std.testing.allocator;
    const command_admission = @import("../permissions/command_admission.zig");
    var runtime = managed_execution.Runtime.init(alloc);
    defer runtime.deinit();
    const command_ctx = command_admission.CommandContext{
        .command = "sleep 30",
        .resolved_cwd = "/tmp",
        .target_os = @import("builtin").os.tag,
        .environment = .legacy,
    };
    var prepared = try runtime.startCaptured(alloc, .{
        .execution_id = "background-helper-1",
        .command = command_ctx.command,
        .cwd = command_ctx.resolved_cwd,
        .environment = command_ctx.environment,
        .authority = .{ .shell_allowed = .{
            .fingerprint = .init(command_ctx),
            .source = .yolo,
        } },
        .max_output_bytes = 4096,
        .timeout_ms = 30_000,
        .command_artifact_dir = null,
        .yield_time_ms = 0,
    });
    defer prepared.deinit(alloc);
    try runtime.commitDelivery(prepared.snapshot.execution_id, prepared.reservation_id);

    const ctx = SessionContext{ .alloc = alloc, .lifecycle_allocator = alloc };
    const items = try listSessions(ctx, &runtime);
    defer {
        for (items) |*item| item.deinit(alloc);
        alloc.free(items);
    }
    try std.testing.expectEqual(@as(usize, 1), items.len);
    try std.testing.expectEqualStrings("background-helper-1", items[0].execution_id);
    try std.testing.expectEqualStrings("running", stateName(items[0].state));
}

test "background failure body keeps the shell tool contract" {
    const alloc = std.testing.allocator;
    const body = try failureBody(alloc, error.ExecutionNotFound);
    defer alloc.free(body);
    try std.testing.expectEqualStrings("{\"error\":{\"tool\":\"shell\",\"code\":\"ExecutionNotFound\",\"retryable\":false}}", body);
    try std.testing.expectError(error.OutOfMemory, failureBody(alloc, error.OutOfMemory));
}

fn finishTerminalTtyStop(
    ctx: SessionContext,
    runtime: *managed_execution.Runtime,
    session_id: []const u8,
    state: managed_execution.SnapshotState,
    actor: contracts.ActorRole,
) error{OutOfMemory}!StopOutcome {
    finalizeCompletedTtyAs(ctx, session_id, state, actor) catch |err|
        return .{ .failure = try failureBody(ctx.alloc, err) };
    const prepared = runtime.updateTty(ctx.alloc, .{
        .execution_id = session_id,
        .command = "",
        .state = state,
        .max_output_bytes = ctx.max_output_bytes,
        .published_running = true,
    }) catch |err| return .{ .failure = try failureBody(ctx.alloc, err) };
    return .{ .prepared = prepared };
}
