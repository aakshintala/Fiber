const std = @import("std");
const core_types = @import("../shared/types.zig");
const io_mod = @import("../shared/io.zig");
const output_contracts = @import("../output/output_contracts.zig");
const profile_usage_runtime = @import("../session/profile_usage_runtime.zig");
const session = @import("../session/session.zig");
const session_codec = @import("../session/session_codec.zig");
const session_store = @import("../session/session_store.zig");
const session_usage = @import("../session/session_usage.zig");
const resume_admission = @import("../subagent/resume_admission.zig");
const usage_recovery = @import("../session/usage_recovery.zig");
const usage_report = @import("../session/usage_report.zig");

const Allocator = std.mem.Allocator;

/// Reads one local profile snapshot. It never initializes credentials or
/// contacts the Gateway.
pub fn collect(
    alloc: Allocator,
    home_path: []const u8,
    scope: usage_report.Scope,
    snapshot_time_ms: i64,
) !usage_report.Snapshot {
    var runtime: profile_usage_runtime.Runtime = .{};
    defer runtime.deinit(alloc);
    const outcome = try runtime.initialize(alloc, home_path);
    if (outcome != .available) {
        return runtime.lastError() orelse error.ProfileUsageUnavailable;
    }

    var recovery = try usage_recovery.collectFromHomeConservative(
        alloc,
        home_path,
    );
    defer recovery.deinit(alloc);
    return runtime.snapshot(alloc, scope, snapshot_time_ms, .{
        .facts = recovery.facts,
        .incidents = recovery.incidents,
        .pending = recovery.pending,
        .unknown_pending = recovery.unknown_pending,
    });
}

/// Reads one saved session's durable usage checkpoint and projects it through
/// the same session snapshot contract the live session uses. It never
/// initializes credentials or contacts the Gateway.
///
/// A null `period` reports lifetime session totals. A non-null `period`
/// intersects the session lifetime with the rolling window: session ledgers
/// are cumulative and carry no per-generation timestamps, so exact
/// within-window totals exist only when the session started inside the
/// window. An older session returns `error.SessionPredatesUsageWindow`
/// instead of mislabeled totals. Unknown session ids surface the store's
/// `SessionNotFound`/`InvalidSessionId` errors unchanged.
pub fn collectSession(
    alloc: Allocator,
    home_path: []const u8,
    workspace_root: []const u8,
    session_id: []const u8,
    period: ?usage_report.Scope,
    snapshot_time_ms: i64,
) !usage_report.Snapshot {
    var store = try session_store.Store.initReadOnlyFromHome(
        alloc,
        home_path,
        workspace_root,
    );
    defer store.deinit(alloc);
    var detail = try resume_admission.loadVisibleReadOnlyDetail(
        store,
        alloc,
        session_id,
        .{},
    );
    defer detail.deinit(alloc);

    if (period) |scope| {
        const duration_ms = scope.durationMs() orelse return error.InvalidUsageScope;
        const window_start_ms = std.math.sub(
            i64,
            snapshot_time_ms,
            duration_ms,
        ) catch return error.InvalidSnapshotTime;
        if (detail.state.created_at_ms < window_start_ms) {
            return error.SessionPredatesUsageWindow;
        }
    }

    if (detail.state.usage) |usage| {
        return session_usage.Usage.reportSnapshotFromParts(
            alloc,
            usage,
            detail.state.created_at_ms,
            snapshot_time_ms,
        );
    }
    return usage_report.buildSessionSnapshot(alloc, .{
        .snapshot_time_ms = snapshot_time_ms,
        .session_started_at_ms = detail.state.created_at_ms,
        .completeness = .complete,
        .total_cost = 0,
        .input_tokens = 0,
        .output_tokens = 0,
        .cache_read_tokens = 0,
        .cache_write_tokens = 0,
        .reasoning_tokens = 0,
        .request_count = 0,
        .models = &.{},
        .activity = .{
            .api_duration_complete = true,
            .wall_duration_complete = true,
            .code_complete = true,
            .api_duration_ms = 0,
            .wall_duration_ms = 0,
            .lines_added = 0,
            .lines_removed = 0,
        },
    });
}

test "usage CLI collection does not create profile state for an empty home" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(home);

    var report = try collect(
        alloc,
        home,
        .days_30,
        std.time.ms_per_day * 40,
    );
    defer report.deinit(alloc);
    try std.testing.expectEqual(usage_report.Coverage.not_started, report.coverage);
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(io_mod.getIo(), ".fiber", .{}),
    );
}

const SessionProbe = struct {
    fn publish(_: *anyopaque, _: usage_report.ProfileEvent) !void {}
};

fn settleTestLedger(alloc: Allocator, total_cost: ?f64) !session_usage.Snapshot {
    var probe = SessionProbe{};
    var usage = session_usage.Usage.initFresh();
    defer usage.deinit(alloc);
    usage.configurePublicationSink(.{
        .context = &probe,
        .allocator = alloc,
        .publish = SessionProbe.publish,
    });
    const sequence = try usage.reserveInvocation();
    try usage.finishObservedInvocation(
        alloc,
        sequence,
        1,
        .observed_generation,
        "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "https://ai-gateway.vercel.sh",
        null,
    );
    try usage.applyGeneration(alloc, .{
        .id = "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        .created_at_ms = 1000,
        .model = "provider/model",
        .total_cost = total_cost,
        .input_tokens = 10,
        .output_tokens = 2,
        .cache_read_tokens = 1,
        .cache_write_tokens = 0,
        .reasoning_tokens = 1,
        .billable_web_search_calls = 0,
    });
    return usage.snapshot(alloc);
}

fn seedUsageSession(
    alloc: Allocator,
    store: session_store.Store,
    id: []const u8,
    created_at_ms: i64,
    ledger: session_usage.Snapshot,
) !void {
    var state: session_codec.DurableSessionState = .{
        .id = try alloc.dupe(u8, id),
        .origin_workspace_root = try alloc.dupe(u8, store.workspace_root),
        .workspace_root = try alloc.dupe(u8, store.workspace_root),
        .created_at_ms = created_at_ms,
        .updated_at_ms = created_at_ms,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = try alloc.dupe(u8, "test/model"),
            .effort = core_types.ReasoningEffort.literal("high"),
            .fast_mode = false,
        },
        .history = &.{},
        .total_input_tokens = 0,
        .total_output_tokens = 0,
    };
    defer state.deinit(alloc);
    var writable = try store.startWritableSession(alloc, state);
    defer writable.deinit(alloc);
    _ = try writable.appendEvent(
        alloc,
        .{ .usage_checkpointed = .{ .usage = ledger } },
        created_at_ms,
        .retry_expected_tail,
        .{},
    );
}

fn collectTestHome(alloc: Allocator, tmp: *std.testing.TmpDir) !struct {
    home: []u8,
    workspace: []u8,
} {
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    return .{
        .home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home"),
        .workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace"),
    };
}

test "usage session collection reports known spend from the durable checkpoint" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const paths = try collectTestHome(alloc, &tmp);
    defer alloc.free(paths.home);
    defer alloc.free(paths.workspace);

    var store = try session_store.Store.initFromHome(
        alloc,
        paths.home,
        paths.workspace,
    );
    defer store.deinit(alloc);
    var ledger = try settleTestLedger(alloc, 0.25);
    defer ledger.deinit(alloc);
    const now_ms = std.time.ms_per_day * 40;
    try seedUsageSession(alloc, store, "usage-known", now_ms - 1000, ledger);

    var report = try collectSession(
        alloc,
        paths.home,
        paths.workspace,
        "usage-known",
        null,
        now_ms,
    );
    defer report.deinit(alloc);
    try std.testing.expectEqual(usage_report.Scope.session, report.scope);
    try std.testing.expectEqual(@as(u64, 12), report.totals.?.total_tokens);
    try std.testing.expectEqual(@as(f64, 0.25), report.totals.?.total_cost.?);
    try std.testing.expectEqual(@as(usize, 1), report.models.len);

    const text = try (output_contracts.UsageSnapshot{ .report = &report }).render(
        alloc,
        .text,
    );
    defer alloc.free(text);
    try std.testing.expect(std.mem.find(u8, text, "Usage (Session)") != null);
    try std.testing.expect(std.mem.find(u8, text, "Spend         $0.2500") != null);
    const json = try (output_contracts.UsageSnapshot{ .report = &report }).render(
        alloc,
        .json,
    );
    defer alloc.free(json);
    try std.testing.expect(std.mem.find(u8, json, "\"period\":\"session\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"spend\":0.25") != null);
}

test "usage session collection keeps unknown spend honest in text and JSON" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const paths = try collectTestHome(alloc, &tmp);
    defer alloc.free(paths.home);
    defer alloc.free(paths.workspace);

    var store = try session_store.Store.initFromHome(
        alloc,
        paths.home,
        paths.workspace,
    );
    defer store.deinit(alloc);
    var ledger = try settleTestLedger(alloc, null);
    defer ledger.deinit(alloc);
    const now_ms = std.time.ms_per_day * 40;
    try seedUsageSession(alloc, store, "usage-unknown", now_ms - 1000, ledger);

    var report = try collectSession(
        alloc,
        paths.home,
        paths.workspace,
        "usage-unknown",
        null,
        now_ms,
    );
    defer report.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 12), report.totals.?.total_tokens);
    try std.testing.expect(report.totals.?.total_cost == null);

    const text = try (output_contracts.UsageSnapshot{ .report = &report }).render(
        alloc,
        .text,
    );
    defer alloc.free(text);
    try std.testing.expect(std.mem.find(u8, text, "Spend         unknown") != null);
    try std.testing.expect(std.mem.find(u8, text, "$0.00") == null);
    const json = try (output_contracts.UsageSnapshot{ .report = &report }).render(
        alloc,
        .json,
    );
    defer alloc.free(json);
    try std.testing.expect(std.mem.find(u8, json, "\"spend\":null") != null);
}

test "usage session collection rejects unknown session ids without crashing" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const paths = try collectTestHome(alloc, &tmp);
    defer alloc.free(paths.home);
    defer alloc.free(paths.workspace);

    const now_ms = std.time.ms_per_day * 40;
    try std.testing.expectError(
        error.SessionNotFound,
        collectSession(alloc, paths.home, paths.workspace, "usage-missing", null, now_ms),
    );
}

test "usage session collection composes with an explicit period window" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const paths = try collectTestHome(alloc, &tmp);
    defer alloc.free(paths.home);
    defer alloc.free(paths.workspace);

    var store = try session_store.Store.initFromHome(
        alloc,
        paths.home,
        paths.workspace,
    );
    defer store.deinit(alloc);
    var ledger = try settleTestLedger(alloc, 0.25);
    defer ledger.deinit(alloc);
    const now_ms = std.time.ms_per_day * 40;
    try seedUsageSession(alloc, store, "usage-recent", now_ms - std.time.ms_per_hour, ledger);
    try seedUsageSession(alloc, store, "usage-old", 10, ledger);

    var recent = try collectSession(
        alloc,
        paths.home,
        paths.workspace,
        "usage-recent",
        .hours_24,
        now_ms,
    );
    defer recent.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 12), recent.totals.?.total_tokens);
    try std.testing.expectEqual(@as(f64, 0.25), recent.totals.?.total_cost.?);

    try std.testing.expectError(
        error.SessionPredatesUsageWindow,
        collectSession(
            alloc,
            paths.home,
            paths.workspace,
            "usage-old",
            .hours_24,
            now_ms,
        ),
    );
}
