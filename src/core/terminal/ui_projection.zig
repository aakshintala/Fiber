const std = @import("std");
const contracts = @import("contracts.zig");

const Allocator = std.mem.Allocator;
// ponytail: keep the 64 newest uncatalogued command rows; LRU/age eviction if a long-lived process needs more captured history
const max_retained_uncatalogued_command_rows: usize = 64;

pub const Row = struct {
    session_id: []u8,
    label: []u8,
    lifecycle: contracts.Lifecycle,
    attention: contracts.AttentionState,
    backend: contracts.Backend,
    attachable: bool = true,

    fn deinit(self: *Row, alloc: Allocator) void {
        alloc.free(self.label);
        alloc.free(self.session_id);
        self.* = undefined;
    }
};

pub const Snapshot = struct {
    alloc: Allocator,
    rows: []Row,

    pub fn deinit(self: *Snapshot) void {
        for (self.rows) |*row| row.deinit(self.alloc);
        self.alloc.free(self.rows);
        self.* = undefined;
    }
};

pub const Store = struct {
    rows: std.ArrayList(Row) = .empty,

    pub fn deinit(self: *Store, alloc: Allocator) void {
        for (self.rows.items) |*row| row.deinit(alloc);
        self.rows.deinit(alloc);
        self.* = .{};
    }

    pub fn observe(
        self: *Store,
        alloc: Allocator,
        request: contracts.ActionRequest,
        result: contracts.Result,
    ) !void {
        const success = switch (result) {
            .success => |value| value,
            .failure => return,
        };
        switch (success) {
            .list => |value| switch (request) {
                .list => |filters| if (filters.task_id == null and
                    filters.workspace_root == null and filters.lifecycle == null and
                    filters.backend == null)
                {
                    try self.replaceAll(alloc, value.sessions);
                } else for (value.sessions) |facts| {
                    try self.upsert(alloc, facts, null);
                },
                else => unreachable,
            },
            .inspect => |value| try self.upsert(
                alloc,
                value.session,
                value.command orelse value.shell,
            ),
            .start => |value| try self.upsert(alloc, value.session, labelFromRequest(request)),
            .read => |value| try self.upsert(alloc, value.session, null),
            .screen => |value| try self.upsert(alloc, value.session, null),
            .write => |value| try self.upsert(alloc, value.session, null),
            .wait => |value| try self.upsert(alloc, value.session, null),
            .resize => |value| try self.upsert(alloc, value.session, null),
            .signal => |value| try self.upsert(alloc, value.session, null),
            .close => |value| try self.upsert(alloc, value.session, null),
        }
    }

    pub fn snapshot(self: *const Store, alloc: Allocator) !Snapshot {
        const rows = try alloc.alloc(Row, self.rows.items.len);
        var initialized: usize = 0;
        errdefer {
            for (rows[0..initialized]) |*row| row.deinit(alloc);
            alloc.free(rows);
        }
        for (self.rows.items, rows) |source, *target| {
            const session_id = try alloc.dupe(u8, source.session_id);
            errdefer alloc.free(session_id);
            target.* = .{
                .session_id = session_id,
                .label = try alloc.dupe(u8, source.label),
                .lifecycle = source.lifecycle,
                .attention = source.attention,
                .backend = source.backend,
            };
            initialized += 1;
        }
        return .{ .alloc = alloc, .rows = rows };
    }

    pub fn clear(self: *Store, alloc: Allocator) bool {
        if (self.rows.items.len == 0) return false;
        for (self.rows.items) |*row| row.deinit(alloc);
        self.rows.clearRetainingCapacity();
        return true;
    }

    /// Records the launch command for a session that never issued a terminal
    /// `.start` request, such as a captured shell execution. Existing rows keep
    /// their lifecycle facts; only the label is replaced.
    pub fn recordLabel(
        self: *Store,
        alloc: Allocator,
        session_id: []const u8,
        label: []const u8,
    ) !void {
        for (self.rows.items) |*row| {
            if (!std.mem.eql(u8, row.session_id, session_id)) continue;
            const replacement = try alloc.dupe(u8, label);
            alloc.free(row.label);
            row.label = replacement;
            return;
        }
        try self.upsert(alloc, unlabeledFacts(session_id), label);
    }

    fn replaceAll(
        self: *Store,
        alloc: Allocator,
        sessions: []const contracts.SessionFacts,
    ) !void {
        var replacement: Store = .{};
        errdefer replacement.deinit(alloc);
        for (sessions) |facts| {
            var label: ?[]const u8 = null;
            for (self.rows.items) |row| {
                if (std.mem.eql(u8, row.session_id, facts.session_id)) {
                    label = row.label;
                    break;
                }
            }
            try replacement.upsert(alloc, facts, label);
        }
        var retained_uncatalogued: usize = 0;
        for (self.rows.items) |row| {
            if (!shouldRetainUncataloguedCommand(row, sessions)) continue;
            retained_uncatalogued += 1;
        }
        const skip = retained_uncatalogued -| max_retained_uncatalogued_command_rows;
        var skipped: usize = 0;
        for (self.rows.items) |row| {
            if (!shouldRetainUncataloguedCommand(row, sessions)) continue;
            if (skipped < skip) {
                skipped += 1;
                continue;
            }
            try replacement.recordLabel(alloc, row.session_id, row.label);
        }
        var previous = self.*;
        self.* = replacement;
        previous.deinit(alloc);
    }

    fn unlabeledFacts(session_id: []const u8) contracts.SessionFacts {
        return .{
            .session_id = session_id,
            .lifecycle = .running,
            .attention = .{},
            .backend = .native,
            .output_cursor = .{ .segment = 1, .offset = 0 },
            .screen_recovery = .{ .unavailable = .missing },
        };
    }

    fn labelIsCommand(row: Row) bool {
        return row.label.len != 0 and !std.mem.eql(u8, row.label, row.session_id);
    }

    fn shouldRetainUncataloguedCommand(row: Row, sessions: []const contracts.SessionFacts) bool {
        return labelIsCommand(row) and !catalogContains(sessions, row.session_id);
    }

    fn catalogContains(sessions: []const contracts.SessionFacts, session_id: []const u8) bool {
        for (sessions) |facts| {
            if (std.mem.eql(u8, facts.session_id, session_id)) return true;
        }
        return false;
    }

    fn upsert(
        self: *Store,
        alloc: Allocator,
        facts: contracts.SessionFacts,
        label: ?[]const u8,
    ) !void {
        for (self.rows.items) |*row| {
            if (!std.mem.eql(u8, row.session_id, facts.session_id)) continue;
            if (label) |value| {
                const replacement = try alloc.dupe(u8, value);
                alloc.free(row.label);
                row.label = replacement;
            }
            row.lifecycle = facts.lifecycle;
            row.attention = facts.attention;
            row.backend = facts.backend;
            return;
        }
        const session_id = try alloc.dupe(u8, facts.session_id);
        errdefer alloc.free(session_id);
        const display = label orelse facts.session_id;
        const display_copy = try alloc.dupe(u8, display);
        errdefer alloc.free(display_copy);
        try self.rows.append(alloc, .{
            .session_id = session_id,
            .label = display_copy,
            .lifecycle = facts.lifecycle,
            .attention = facts.attention,
            .backend = facts.backend,
        });
    }
};

test "recordLabel stores a launch command for a session with no start request" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.recordLabel(alloc, "shell-captured", "printf CAPTURED_READY");
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 1), snapshot.rows.len);
    try std.testing.expectEqualStrings("shell-captured", snapshot.rows[0].session_id);
    try std.testing.expectEqualStrings("printf CAPTURED_READY", snapshot.rows[0].label);
}

test "catalog replaceAll keeps a captured launch command that is not in the catalog" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.recordLabel(alloc, "shell-captured", "printf CAPTURED_READY");
    const catalog = [_]contracts.SessionFacts{
        testFacts("terminal-a", .running),
    };
    try store.observe(
        alloc,
        .{ .list = .{} },
        .{ .success = .{ .list = .{ .sessions = &catalog } } },
    );
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 2), snapshot.rows.len);
    try std.testing.expectEqualStrings("terminal-a", snapshot.rows[0].session_id);
    try std.testing.expectEqualStrings("terminal-a", snapshot.rows[0].label);
    try std.testing.expectEqualStrings("shell-captured", snapshot.rows[1].session_id);
    try std.testing.expectEqualStrings("printf CAPTURED_READY", snapshot.rows[1].label);
}

test "catalog replaceAll preserves a recorded launch command across a matching refresh" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.recordLabel(alloc, "shell-resume", "printf TTY_RESUME_READY");
    const catalog = [_]contracts.SessionFacts{
        testFacts("shell-resume", .running),
    };
    try store.observe(
        alloc,
        .{ .list = .{} },
        .{ .success = .{ .list = .{ .sessions = &catalog } } },
    );
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 1), snapshot.rows.len);
    try std.testing.expectEqual(contracts.Lifecycle.running, snapshot.rows[0].lifecycle);
    try std.testing.expectEqualStrings("printf TTY_RESUME_READY", snapshot.rows[0].label);
}

test "owner-authority catalog list replaces the projection and keeps captured commands" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.recordLabel(alloc, "shell-captured", "printf CAPTURED_READY");
    const full = [_]contracts.SessionFacts{
        testFacts("terminal-a", .running),
        testFacts("terminal-b", .starting),
    };
    try store.observe(
        alloc,
        .{ .list = .{} },
        .{ .success = .{ .list = .{ .sessions = &full } } },
    );

    const owned = [_]contracts.SessionFacts{
        testFacts("terminal-a", .running),
    };
    try store.observe(
        alloc,
        .{ .list = .{ .owner_authority = testOwnerAuthority() } },
        .{ .success = .{ .list = .{ .sessions = &owned } } },
    );
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 2), snapshot.rows.len);
    try std.testing.expectEqualStrings("terminal-a", snapshot.rows[0].session_id);
    try std.testing.expectEqualStrings("shell-captured", snapshot.rows[1].session_id);
    try std.testing.expectEqualStrings("printf CAPTURED_READY", snapshot.rows[1].label);
}

test "catalog replaceAll caps retained uncatalogued command rows" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    var index: usize = 0;
    while (index < max_retained_uncatalogued_command_rows + 8) : (index += 1) {
        var id_buf: [32]u8 = undefined;
        const session_id = try std.fmt.bufPrint(&id_buf, "shell-{d}", .{index});
        var command_buf: [32]u8 = undefined;
        const command = try std.fmt.bufPrint(&command_buf, "printf {d}", .{index});
        try store.recordLabel(alloc, session_id, command);
    }
    const catalog = [_]contracts.SessionFacts{
        testFacts("terminal-a", .running),
    };
    try store.observe(
        alloc,
        .{ .list = .{} },
        .{ .success = .{ .list = .{ .sessions = &catalog } } },
    );
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 1 + max_retained_uncatalogued_command_rows), snapshot.rows.len);
    try std.testing.expectEqualStrings("terminal-a", snapshot.rows[0].session_id);
    try std.testing.expectEqualStrings("shell-8", snapshot.rows[1].session_id);
    try std.testing.expectEqualStrings(
        "shell-71",
        snapshot.rows[snapshot.rows.len - 1].session_id,
    );
}

fn checkRecordLabelAllocationFailures(alloc: Allocator) !void {
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.recordLabel(alloc, "shell-captured", "printf CAPTURED_READY");
}

test "recordLabel releases owned row fields on every allocation failure" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        checkRecordLabelAllocationFailures,
        .{},
    );
}

fn labelFromRequest(request: contracts.ActionRequest) ?[]const u8 {
    return switch (request) {
        .start => |value| value.command orelse switch (value.shell) {
            .user_login => "interactive shell",
            .executable => |shell| shell.path,
        },
        else => null,
    };
}

test "filtered catalog observations update rows without replacing the full projection" {
    const alloc = std.testing.allocator;
    var store: Store = .{};
    defer store.deinit(alloc);
    const full = [_]contracts.SessionFacts{
        testFacts("terminal-a", .running),
        testFacts("terminal-b", .starting),
    };
    try store.observe(
        alloc,
        .{ .list = .{} },
        .{ .success = .{ .list = .{ .sessions = &full } } },
    );

    const partial = [_]contracts.SessionFacts{
        testFacts("terminal-b", .running),
    };
    try store.observe(
        alloc,
        .{ .list = .{ .lifecycle = .running } },
        .{ .success = .{ .list = .{ .sessions = &partial } } },
    );
    var snapshot = try store.snapshot(alloc);
    defer snapshot.deinit();
    try std.testing.expectEqual(@as(usize, 2), snapshot.rows.len);
    try std.testing.expectEqual(contracts.Lifecycle.running, snapshot.rows[1].lifecycle);
}

fn checkUpsertAllocationFailures(alloc: Allocator) !void {
    var store: Store = .{};
    defer store.deinit(alloc);
    try store.upsert(
        alloc,
        testFacts("terminal-a", .running),
        "display label",
    );
}

test "upsert releases owned row fields on every allocation failure" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        checkUpsertAllocationFailures,
        .{},
    );
}

fn testFacts(
    session_id: []const u8,
    lifecycle: contracts.Lifecycle,
) contracts.SessionFacts {
    return .{
        .session_id = session_id,
        .lifecycle = lifecycle,
        .attention = .{},
        .backend = .native,
        .output_cursor = .{ .segment = 1, .offset = 0 },
        .screen_recovery = .{ .unavailable = .missing },
    };
}

fn testOwnerAuthority() contracts.OwnerCatalogAuthorityClaim {
    return .{
        .principal = .{
            .profile_user = "fiber",
            .durable_session_id = "test-session",
            .workspace_root = "/tmp/workspace",
            .transport_role = .interactive,
        },
        .actor = .agent,
        .proof = .{ .bytes = [_]u8{1} ** 32 },
    };
}
