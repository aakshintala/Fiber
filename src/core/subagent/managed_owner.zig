const std = @import("std");
const approval_registry = @import("approval_registry.zig");
const authority = @import("authority.zig");
const child_state = @import("child_state.zig");
const execution = @import("execution.zig");
const io_mod = @import("../shared/io.zig");
const permission_request = @import("../permissions/permission_request.zig");
const session_store = @import("../session/session_store.zig");
const worker_runtime = @import("../agent/worker_runtime.zig");

const Allocator = std.mem.Allocator;

pub const StartResult = enum { started, already_running };
pub const StartError = error{ OutOfMemory, OwnerClosed, ChildUnavailable, ThreadSpawnFailed };
pub const WaitError = error{ OutOfMemory, ChildUnavailable, StateUnavailable };
pub const CancelError = error{ChildUnavailable};

pub const Observation = struct {
    phase: child_state.Phase,
    outcome: ?child_state.Outcome = null,
};

const Slot = struct {
    owner: *Owner,
    child_id: []u8,
    cancel: std.atomic.Value(bool) = .init(false),
    shutdown: std.atomic.Value(bool) = .init(false),
    worker: ?*worker_runtime.WorkerRuntime = null,
    route_refs: usize = 0,
    route_changed: std.Io.Condition = .init,
    thread: ?std.Thread = null,
    finished: bool = false,
    work_done: std.atomic.Value(bool) = .init(false),
    done: std.Io.Event = .unset,
};

pub const Owner = struct {
    alloc: Allocator,
    sessions: *session_store.Store,
    state_store: child_state.Store,
    services: execution.Services,
    authority_resolver: *authority.Resolver,
    approvals: *approval_registry.Registry,
    max_history_turns: usize = 8,
    mutex: std.Io.Mutex = .init,
    slots: std.ArrayList(*Slot) = .empty,
    closed: bool = false,

    pub fn start(self: *Owner, child_id: []const u8) StartError!StartResult {
        while (true) {
            const finished = blk: {
                self.mutex.lockUncancelable(io_mod.getIo());
                defer self.mutex.unlock(io_mod.getIo());
                if (self.closed) return error.OwnerClosed;
                for (self.slots.items, 0..) |slot, index| {
                    if (!std.mem.eql(u8, slot.child_id, child_id)) continue;
                    if (!slot.finished and !slot.work_done.load(.seq_cst))
                        return .already_running;
                    break :blk self.slots.swapRemove(index);
                }
                const slot = try self.alloc.create(Slot);
                errdefer self.alloc.destroy(slot);
                slot.* = .{
                    .owner = self,
                    .child_id = try self.alloc.dupe(u8, child_id),
                };
                errdefer self.alloc.free(slot.child_id);
                try self.slots.append(self.alloc, slot);
                errdefer _ = self.slots.pop();
                slot.thread = std.Thread.spawn(.{}, slotMain, .{slot}) catch
                    return error.ThreadSpawnFailed;
                return .started;
            };
            destroySlot(self, finished);
        }
    }

    pub fn wait(
        self: *Owner,
        child_id: []const u8,
        duration: std.Io.Clock.Duration,
    ) WaitError!Observation {
        const slot = self.findSlot(child_id);
        if (slot) |active| {
            active.done.waitTimeout(io_mod.getIo(), .{ .duration = duration }) catch |err| switch (err) {
                error.Timeout => return self.observe(child_id),
                error.Canceled => return self.observe(child_id),
            };
            self.reapSlot(active);
        }
        return self.observe(child_id);
    }

    pub fn cancel(self: *Owner, child_id: []const u8) CancelError!void {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        for (self.slots.items) |slot| {
            if (!std.mem.eql(u8, slot.child_id, child_id)) continue;
            if (slot.finished) return;
            slot.cancel.store(true, .seq_cst);
            if (slot.worker) |worker| worker.requestCancel();
            return;
        }
        return error.ChildUnavailable;
    }

    pub fn recoverInterrupted(self: *Owner) !void {
        var lock = try self.state_store.acquireLock(self.alloc);
        defer lock.release();
        var registry = try self.state_store.load(self.alloc);
        defer registry.deinit(self.alloc);
        const generation = registry.generation;
        registry.interruptActive(self.alloc);
        if (registry.generation != generation) try self.state_store.save(self.alloc, registry);
    }

    pub fn deinit(self: *Owner) void {
        self.mutex.lockUncancelable(io_mod.getIo());
        self.closed = true;
        for (self.slots.items) |slot| {
            slot.shutdown.store(true, .seq_cst);
            slot.cancel.store(true, .seq_cst);
            if (slot.worker) |worker| worker.requestShutdown();
        }
        self.mutex.unlock(io_mod.getIo());

        for (self.slots.items) |slot| {
            if (slot.thread) |thread| thread.join();
            self.alloc.free(slot.child_id);
            self.alloc.destroy(slot);
        }
        self.slots.deinit(self.alloc);
        self.* = undefined;
    }

    fn findSlot(self: *Owner, child_id: []const u8) ?*Slot {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        for (self.slots.items) |slot| {
            if (std.mem.eql(u8, slot.child_id, child_id)) return slot;
        }
        return null;
    }

    fn reapSlot(self: *Owner, slot: *Slot) void {
        self.mutex.lockUncancelable(io_mod.getIo());
        var index: ?usize = null;
        for (self.slots.items, 0..) |candidate, candidate_index| {
            if (candidate == slot and candidate.finished) {
                index = candidate_index;
                break;
            }
        }
        if (index == null) {
            self.mutex.unlock(io_mod.getIo());
            return;
        }
        _ = self.slots.swapRemove(index.?);
        self.mutex.unlock(io_mod.getIo());
        destroySlot(self, slot);
    }

    fn observe(self: *Owner, child_id: []const u8) WaitError!Observation {
        var lock = self.state_store.acquireLock(self.alloc) catch
            return error.StateUnavailable;
        defer lock.release();
        var registry = self.state_store.load(self.alloc) catch |err| return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => error.StateUnavailable,
        };
        defer registry.deinit(self.alloc);
        const child = registry.findById(child_id) orelse return error.ChildUnavailable;
        return .{ .phase = child.phase, .outcome = child.last_outcome };
    }

    fn phaseTransition(
        raw: *anyopaque,
        child_id: []const u8,
        work_id: []const u8,
        phase: child_state.Phase,
    ) !void {
        const self: *Owner = @ptrCast(@alignCast(raw));
        var lock = try self.state_store.acquireLock(self.alloc);
        defer lock.release();
        var registry = try self.state_store.load(self.alloc);
        defer registry.deinit(self.alloc);
        const child = registry.findById(child_id) orelse return error.ChildUnavailable;
        const active = child.active orelse return error.StaleWork;
        if (!std.mem.eql(u8, active.id, work_id)) return error.StaleWork;
        child.phase = phase;
        registry.generation +|= 1;
        try self.state_store.save(self.alloc, registry);
    }

    fn finish(
        self: *Owner,
        child_id: []const u8,
        work_id: []const u8,
        outcome: child_state.Outcome,
    ) void {
        var lock = self.state_store.acquireLock(self.alloc) catch |err| {
            debugFailure(child_id, "state_lock", err);
            return;
        };
        defer lock.release();
        var registry = self.state_store.load(self.alloc) catch |err| {
            debugFailure(child_id, "state_load", err);
            return;
        };
        defer registry.deinit(self.alloc);
        registry.finish(self.alloc, child_id, work_id, outcome) catch |err| {
            debugFailure(child_id, "state_finish", err);
            return;
        };
        self.state_store.save(self.alloc, registry) catch |err| {
            debugFailure(child_id, "state_save", err);
        };
    }
};

fn destroySlot(owner: *Owner, slot: *Slot) void {
    if (slot.thread) |thread| thread.join();
    std.debug.assert(slot.route_refs == 0);
    owner.alloc.free(slot.child_id);
    owner.alloc.destroy(slot);
}

fn slotMain(slot: *Slot) void {
    const owner = slot.owner;
    const outcome = runOne(slot);
    slot.work_done.store(true, .seq_cst);
    owner.finish(slot.child_id, outcome.work_id, outcome.outcome);
    owner.mutex.lockUncancelable(io_mod.getIo());
    slot.finished = true;
    slot.done.set(io_mod.getIo());
    owner.mutex.unlock(io_mod.getIo());
    outcome.deinit(owner.alloc);
}

const OneOutcome = struct {
    work_id: []u8,
    outcome: child_state.Outcome,

    fn deinit(self: OneOutcome, alloc: Allocator) void {
        alloc.free(self.work_id);
    }
};

fn runOne(slot: *Slot) OneOutcome {
    const owner = slot.owner;
    var snapshot = loadRunSnapshot(owner, slot.child_id) catch {
        return fallbackOutcome(owner.alloc, "unknown", .failed);
    };
    defer snapshot.deinit(owner.alloc);
    const work_id = owner.alloc.dupe(u8, snapshot.active.id) catch
        return fallbackOutcome(owner.alloc, "unknown", .failed);

    var loaded = owner.sessions.resumeTargetForWrite(
        owner.alloc,
        .{ .id = slot.child_id },
        owner.sessions.workspace_root,
        .{},
    ) catch return .{ .work_id = work_id, .outcome = .failed };
    defer {
        loaded.log.park();
        loaded.deinit(owner.alloc);
    }
    var turn = execution.TurnContext.init(
        owner.alloc,
        &loaded,
        owner.max_history_turns,
    ) catch return .{ .work_id = work_id, .outcome = .failed };
    defer turn.deinit();
    turn.live_authority = owner.authority_resolver;
    turn.approval_registry = owner.approvals;
    turn.child_id = slot.child_id;
    turn.active_work_id = snapshot.active.id;
    turn.phase_context = owner;
    turn.phase_fn = Owner.phaseTransition;
    owner.mutex.lockUncancelable(io_mod.getIo());
    slot.worker = turn.workerRuntime();
    owner.mutex.unlock(io_mod.getIo());
    turn.approval_worker_route = workerRoute(slot);
    defer detachWorker(slot);

    var message = snapshot.active.queuedMessage(
        owner.alloc,
        owner.state_store.parent_id,
        snapshot.instructions,
    ) catch
        return .{ .work_id = work_id, .outcome = .failed };
    defer message.deinit(owner.alloc);
    const admission = owner.services.capture(owner.alloc, .{
        .child_id = slot.child_id,
        .parent_id = owner.state_store.parent_id,
        .source_id = owner.state_store.parent_id,
        .preferences = .{
            .provider = loaded.state.preferences.provider,
            .model = loaded.state.preferences.model,
            .effort = loaded.state.preferences.effort,
        },
    }) catch |err| return .{
        .work_id = work_id,
        .outcome = if (err == error.Cancelled) .cancelled else .failed,
    };
    var owned_admission = admission;
    defer owned_admission.deinit(owner.alloc);
    const result = owner.services.run(
        &turn,
        message,
        admission,
        &slot.cancel,
    ) catch |err| return .{
        .work_id = work_id,
        .outcome = if (slot.shutdown.load(.seq_cst))
            .interrupted
        else if (slot.cancel.load(.seq_cst) or err == error.Cancelled)
            .cancelled
        else
            .failed,
    };
    if (slot.shutdown.load(.seq_cst)) return .{
        .work_id = work_id,
        .outcome = .interrupted,
    };
    if (slot.cancel.load(.seq_cst)) return .{
        .work_id = work_id,
        .outcome = .cancelled,
    };
    return .{
        .work_id = work_id,
        .outcome = switch (result) {
            .completed => .completed,
            .awaiting_approval, .paused => .interrupted,
        },
    };
}

fn workerRoute(slot: *Slot) approval_registry.WorkerRoute {
    return .{
        .context = slot,
        .submit_fn = submitWorkerApproval,
        .cancel_fn = cancelWorkerApproval,
        .pin_fn = pinWorkerRoute,
        .release_fn = releaseWorkerRoute,
    };
}

fn submitWorkerApproval(
    raw: *anyopaque,
    request_id: u64,
    response: permission_request.OwnedPermissionResponse,
    commit: ?worker_runtime.WorkerRuntime.PermissionCommit,
) worker_runtime.WorkerRuntime.PermissionCommitError!worker_runtime.PermissionSubmissionResult {
    const slot: *Slot = @ptrCast(@alignCast(raw));
    const owner = slot.owner;
    owner.mutex.lockUncancelable(io_mod.getIo());
    defer owner.mutex.unlock(io_mod.getIo());
    const worker = slot.worker orelse {
        var owned = response;
        owned.deinit();
        return .no_pending;
    };
    return worker.submitPermissionResponseAfterCommit(
        request_id,
        response,
        commit,
    );
}

fn cancelWorkerApproval(raw: *anyopaque) void {
    const slot: *Slot = @ptrCast(@alignCast(raw));
    const owner = slot.owner;
    owner.mutex.lockUncancelable(io_mod.getIo());
    defer owner.mutex.unlock(io_mod.getIo());
    if (slot.worker) |worker| worker.cancelApprovalTurn();
}

fn pinWorkerRoute(raw: *anyopaque) bool {
    const slot: *Slot = @ptrCast(@alignCast(raw));
    const owner = slot.owner;
    owner.mutex.lockUncancelable(io_mod.getIo());
    defer owner.mutex.unlock(io_mod.getIo());
    if (slot.worker == null) return false;
    slot.route_refs += 1;
    return true;
}

fn releaseWorkerRoute(raw: *anyopaque) void {
    const slot: *Slot = @ptrCast(@alignCast(raw));
    const owner = slot.owner;
    owner.mutex.lockUncancelable(io_mod.getIo());
    defer owner.mutex.unlock(io_mod.getIo());
    std.debug.assert(slot.route_refs > 0);
    slot.route_refs -= 1;
    if (slot.route_refs == 0) slot.route_changed.broadcast(io_mod.getIo());
}

fn detachWorker(slot: *Slot) void {
    const owner = slot.owner;
    _ = owner.approvals.invalidateChild(slot.child_id) catch |err|
        debugFailure(slot.child_id, "approval_invalidate", err);
    owner.mutex.lockUncancelable(io_mod.getIo());
    while (slot.route_refs > 0) {
        slot.route_changed.waitUncancelable(io_mod.getIo(), &owner.mutex);
    }
    slot.worker = null;
    owner.mutex.unlock(io_mod.getIo());
}

const RunSnapshot = struct {
    active: child_state.ActiveWork,
    instructions: []u8,

    fn deinit(self: *RunSnapshot, alloc: Allocator) void {
        self.active.deinit(alloc);
        if (self.instructions.len > 0) alloc.free(self.instructions);
        self.* = undefined;
    }
};

fn loadRunSnapshot(owner: *Owner, child_id: []const u8) !RunSnapshot {
    var lock = try owner.state_store.acquireLock(owner.alloc);
    defer lock.release();
    var registry = try owner.state_store.load(owner.alloc);
    defer registry.deinit(owner.alloc);
    const child = registry.findById(child_id) orelse return error.ChildUnavailable;
    const active = child.active orelse return error.ChildUnavailable;
    const owned_active = try active.clone(owner.alloc);
    errdefer {
        var value = owned_active;
        value.deinit(owner.alloc);
    }
    const instructions: []u8 = if (child.instructions().len == 0)
        &.{}
    else
        try owner.alloc.dupe(u8, child.instructions());
    return .{
        .active = owned_active,
        .instructions = instructions,
    };
}

fn fallbackOutcome(alloc: Allocator, work_id: []const u8, outcome: child_state.Outcome) OneOutcome {
    return .{
        .work_id = alloc.dupe(u8, work_id) catch &.{},
        .outcome = outcome,
    };
}

fn debugFailure(child_id: []const u8, stage: []const u8, err: anyerror) void {
    @import("../shared/debug_trace.zig").logf(
        "subagent",
        "managed child state update failed child_id={s} stage={s} err={s}",
        .{ child_id, stage, @errorName(err) },
    );
}

test "worker detach invalidates approval routes before worker deinit" {
    const alloc = std.testing.allocator;
    var approvals = approval_registry.Registry{ .alloc = alloc };
    defer approvals.deinit();
    var owner = Owner{
        .alloc = alloc,
        .sessions = undefined,
        .state_store = undefined,
        .services = undefined,
        .authority_resolver = undefined,
        .approvals = &approvals,
    };
    var worker = worker_runtime.WorkerRuntime{};
    defer worker.deinit(alloc);
    worker.worker_processing = true;
    worker.pending_permission_waiting = true;
    worker.pending_permission_request_shared =
        try permission_request.OwnedPermissionRequest.dupe(
            alloc,
            .{ .id = 9, .label = "review" },
        );
    var slot = Slot{
        .owner = &owner,
        .child_id = try alloc.dupe(u8, "child"),
        .worker = &worker,
    };
    defer alloc.free(slot.child_id);
    const route = workerRoute(&slot);
    try approvals.registerTool(
        "approval",
        "child",
        "root",
        "work",
        .{ .id = 9, .label = "review" },
        &.{},
        route,
        1,
    );

    detachWorker(&slot);
    try std.testing.expect(slot.worker == null);
    var pending = try approvals.firstPendingRequest(alloc, "root");
    defer if (pending) |*request| request.deinit(alloc);
    try std.testing.expect(pending == null);
    try std.testing.expectEqual(
        worker_runtime.PermissionSubmissionResult.no_pending,
        try route.submit_fn(
            route.context,
            9,
            permission_request.OwnedPermissionResponse.init(alloc, .deny, null),
            null,
        ),
    );
}

const LockGate = struct {
    allow: std.atomic.Value(bool) = .init(true),
    blocked: std.Io.Event = .unset,

    fn tryLock(raw: ?*anyopaque, file: std.Io.File) anyerror!bool {
        const self: *LockGate = @ptrCast(@alignCast(raw.?));
        if (!self.allow.load(.seq_cst)) {
            self.blocked.set(io_mod.getIo());
            return false;
        }
        return file.tryLock(io_mod.getIo(), .exclusive);
    }
};

const RunHarness = struct {
    entered: std.Io.Event = .unset,
    release_run: std.Io.Event = .unset,
    left: std.Io.Event = .unset,
};

const RaceEnv = struct {
    tmp: std.testing.TmpDir,
    home: []u8,
    workspace: []u8,
    sessions: session_store.Store,
    approvals: approval_registry.Registry,
    resolver: authority.Resolver,
    gate: LockGate,
    harness: RunHarness,
    owner: Owner,
    child_id: []const u8,

    fn init(self: *RaceEnv, alloc: Allocator) !void {
        const session = @import("../session/session.zig");
        const session_codec = @import("../session/session_codec.zig");
        const parent_id = "parent1";
        const child_id = "child1";

        self.tmp = std.testing.tmpDir(.{});
        errdefer self.tmp.cleanup();
        try self.tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
        try self.tmp.dir.createDirPath(io_mod.getIo(), "workspace");
        self.home = try io_mod.dirRealpathAlloc(alloc, self.tmp.dir, "home");
        errdefer alloc.free(self.home);
        self.workspace = try io_mod.dirRealpathAlloc(alloc, self.tmp.dir, "workspace");
        errdefer alloc.free(self.workspace);
        self.sessions = try session_store.Store.initFromHome(alloc, self.home, self.workspace);
        errdefer self.sessions.deinit(alloc);

        var parent_state = try raceDurable(alloc, session, session_codec, parent_id, self.workspace);
        defer parent_state.deinit(alloc);
        var parent = try self.sessions.startWritableSession(alloc, parent_state);
        parent.deinit(alloc);

        var child_durable = try raceDurable(alloc, session, session_codec, child_id, self.workspace);
        child_durable.subagent_child = true;
        defer child_durable.deinit(alloc);
        var child = try self.sessions.startWritableSession(alloc, child_durable);
        child.deinit(alloc);

        self.gate = .{};
        self.harness = .{};
        self.approvals = .{ .alloc = alloc };
        errdefer self.approvals.deinit();
        self.resolver = .{
            .sessions = &self.sessions,
            .root_id = parent_id,
            .host = .{ .resolve_fn = unusedHostResolve },
        };
        self.child_id = child_id;
        self.owner = .{
            .alloc = alloc,
            .sessions = &self.sessions,
            .state_store = .{
                .sessions = &self.sessions,
                .parent_id = parent_id,
                .options = .{
                    .lock_ops = .{
                        .ctx = &self.gate,
                        .try_lock = LockGate.tryLock,
                    },
                },
            },
            .services = .{
                .context = &self.harness,
                .capture_fn = captureStub,
                .run_fn = runStub,
            },
            .authority_resolver = &self.resolver,
            .approvals = &self.approvals,
        };
        errdefer self.owner.deinit();

        var registry = try child_state.Registry.init(alloc, parent_id);
        defer registry.deinit(alloc);
        var active = child_state.ActiveWork{
            .id = try alloc.dupe(u8, "work-1"),
            .message = try alloc.dupe(u8, "follow up"),
            .created_at_ms = 1,
        };
        defer active.deinit(alloc);
        try registry.appendPersistent(alloc, child_id, "reviewer", "Review carefully.", active);
        var lock = try self.owner.state_store.acquireLock(alloc);
        defer lock.release();
        try self.owner.state_store.save(alloc, registry);
    }

    fn deinit(self: *RaceEnv, alloc: Allocator) void {
        self.gate.allow.store(true, .seq_cst);
        self.harness.release_run.set(io_mod.getIo());
        self.owner.deinit();
        self.approvals.deinit();
        self.sessions.deinit(alloc);
        alloc.free(self.workspace);
        alloc.free(self.home);
        self.tmp.cleanup();
    }
};

fn raceDurable(
    alloc: Allocator,
    session: type,
    session_codec: type,
    id: []const u8,
    workspace_root: []const u8,
) !session_codec.DurableSessionState {
    return .{
        .id = try alloc.dupe(u8, id),
        .origin_workspace_root = try alloc.dupe(u8, workspace_root),
        .workspace_root = try alloc.dupe(u8, workspace_root),
        .created_at_ms = 1,
        .updated_at_ms = 1,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .history = &.{},
        .preferences = .{
            .model = try alloc.dupe(u8, "test"),
            .effort = .auto,
            .fast_mode = false,
        },
    };
}

fn unusedHostResolve(
    _: ?*anyopaque,
    _: Allocator,
    _: []const u8,
) authority.HostResolveError!authority.HostAuthority {
    return error.HostAuthorityUnavailable;
}

fn captureStub(
    _: ?*anyopaque,
    alloc: Allocator,
    request: execution.CaptureRequest,
) execution.ServiceError!@import("domain.zig").AdmissionSnapshot {
    const domain = @import("domain.zig");
    return domain.captureAdmission(alloc, .{
        .parent_id = request.parent_id,
        .source_id = request.source_id,
        .model = request.preferences.model,
        .provider = request.preferences.provider,
        .effort = request.preferences.effort,
    }) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.AdmissionFailed,
    };
}

fn runStub(
    raw: ?*anyopaque,
    _: *execution.TurnContext,
    _: @import("domain.zig").QueuedMessage,
    _: @import("domain.zig").AdmissionSnapshot,
    cancel: *std.atomic.Value(bool),
) execution.ServiceError!execution.RunOutcome {
    const harness: *RunHarness = @ptrCast(@alignCast(raw.?));
    const io = io_mod.getIo();
    harness.entered.set(io);
    const deadline = std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = .fromMilliseconds(5_000),
    });
    while (!harness.release_run.isSet() and !cancel.load(.seq_cst)) {
        const now = std.Io.Clock.Timestamp.now(io, .awake);
        if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline)) return error.Cancelled;
        harness.release_run.waitTimeout(io, .{
            .duration = .{
                .clock = .awake,
                .raw = .fromMilliseconds(10),
            },
        }) catch {};
    }
    harness.left.set(io);
    if (cancel.load(.seq_cst) and !harness.release_run.isSet()) return error.Cancelled;
    return .completed;
}

fn waitUntilSet(event: *std.Io.Event, timeout_ms: i64) error{SomethingNeverHappened}!void {
    const io = io_mod.getIo();
    const deadline = std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = .fromMilliseconds(timeout_ms),
    });
    while (!event.isSet()) {
        const now = std.Io.Clock.Timestamp.now(io, .awake);
        if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline))
            return error.SomethingNeverHappened;
        event.waitTimeout(io, .{ .deadline = deadline }) catch |err| switch (err) {
            error.Timeout => {},
            error.Canceled => return error.SomethingNeverHappened,
        };
    }
}

const FollowUp = struct {
    owner: *Owner,
    child_id: []const u8,
    result: ?StartError!StartResult = null,
    done: std.Io.Event = .unset,

    fn run(self: *FollowUp) void {
        self.result = self.owner.start(self.child_id);
        self.done.set(io_mod.getIo());
    }
};

fn expectFollowUpAdmitted(env: *RaceEnv) !void {
    var followup = FollowUp{
        .owner = &env.owner,
        .child_id = env.child_id,
    };
    const thread = try std.Thread.spawn(.{}, FollowUp.run, .{&followup});
    defer thread.join();
    defer env.gate.allow.store(true, .seq_cst);

    const io = io_mod.getIo();
    const deadline = std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = .fromMilliseconds(2_000),
    });
    var admitted = false;
    while (true) {
        if (followup.done.isSet()) break;
        if (env.owner.findSlot(env.child_id) == null) {
            admitted = true;
            break;
        }
        const now = std.Io.Clock.Timestamp.now(io, .awake);
        if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline))
            return error.SomethingNeverHappened;
        io_mod.sleep(5 * std.time.ns_per_ms);
    }
    if (admitted) {
        env.gate.allow.store(true, .seq_cst);
        try waitUntilSet(&followup.done, 2_000);
    }
    try std.testing.expectEqual(
        StartResult.started,
        try (followup.result orelse return error.SomethingNeverHappened),
    );
}

fn pinFinishWindow(env: *RaceEnv) !void {
    env.gate.allow.store(false, .seq_cst);
    try waitUntilSet(&env.harness.left, 2_000);
    try waitUntilSet(&env.gate.blocked, 2_000);
    const slot = env.owner.findSlot(env.child_id) orelse return error.SomethingNeverHappened;
    if (slot.finished) return error.FinishWindowClosed;
}

test "follow-up after finish is admitted while durable write is in flight" {
    const alloc = std.testing.allocator;
    var env: RaceEnv = undefined;
    try env.init(alloc);
    defer env.deinit(alloc);

    try std.testing.expectEqual(StartResult.started, try env.owner.start(env.child_id));
    try waitUntilSet(&env.harness.entered, 2_000);
    env.gate.allow.store(false, .seq_cst);
    env.harness.release_run.set(io_mod.getIo());
    try pinFinishWindow(&env);
    try expectFollowUpAdmitted(&env);
}

test "follow-up after cancel is admitted while durable write is in flight" {
    const alloc = std.testing.allocator;
    var env: RaceEnv = undefined;
    try env.init(alloc);
    defer env.deinit(alloc);

    try std.testing.expectEqual(StartResult.started, try env.owner.start(env.child_id));
    try waitUntilSet(&env.harness.entered, 2_000);
    env.gate.allow.store(false, .seq_cst);
    try env.owner.cancel(env.child_id);
    try pinFinishWindow(&env);
    try expectFollowUpAdmitted(&env);
}

test "follow-up while child is running stays already_running" {
    const alloc = std.testing.allocator;
    var env: RaceEnv = undefined;
    try env.init(alloc);
    defer env.deinit(alloc);

    try std.testing.expectEqual(StartResult.started, try env.owner.start(env.child_id));
    try waitUntilSet(&env.harness.entered, 2_000);
    try std.testing.expectEqual(StartResult.already_running, try env.owner.start(env.child_id));
    const slot = env.owner.findSlot(env.child_id) orelse return error.SomethingNeverHappened;
    try std.testing.expect(!slot.finished);
}
