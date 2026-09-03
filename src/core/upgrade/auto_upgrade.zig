const std = @import("std");
const io_mod = @import("../shared/io.zig");
const update_target = @import("update_target.zig");

pub const State = enum(u8) {
    idle = 0,
    checking = 1,
    waiting = 2,
    downloading = 3,
    ready = 4,
    failed = 5,
};

pub const RelaunchRequest = struct {
    executable_path_buf: [std.fs.max_path_bytes]u8 = undefined,
    executable_path_len: usize = 0,

    pub fn executablePath(self: *const RelaunchRequest) []const u8 {
        return self.executable_path_buf[0..self.executable_path_len];
    }
};

pub const AutoUpgrade = struct {
    state: std.atomic.Value(u8) = std.atomic.Value(u8).init(@intFromEnum(State.idle)),
    render_dirty: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    version_mutex: std.Io.Mutex = .init,
    latest_version_buf: [64]u8 = undefined,
    latest_version_len: u8 = 0,

    relaunch_request: ?RelaunchRequest = null,

    pub fn getState(self: *const AutoUpgrade) State {
        return @enumFromInt(self.state.load(.acquire));
    }

    pub fn requestRelaunch(self: *AutoUpgrade, executable_path: []const u8) !void {
        if (executable_path.len > std.fs.max_path_bytes) return error.NameTooLong;
        var request = RelaunchRequest{
            .executable_path_len = executable_path.len,
        };
        @memcpy(
            request.executable_path_buf[0..executable_path.len],
            executable_path,
        );
        self.relaunch_request = request;
    }

    pub fn takeRelaunchRequest(self: *AutoUpgrade) ?RelaunchRequest {
        const request = self.relaunch_request;
        self.relaunch_request = null;
        return request;
    }

    pub fn statusLabel(self: *AutoUpgrade, buf: []u8) []const u8 {
        const state = self.getState();
        switch (state) {
            .downloading => {
                var ver_buf: [32]u8 = undefined;
                const ver = self.getLatestVersion(&ver_buf);
                return std.fmt.bufPrint(buf, "upgrading to {s}...", .{ver}) catch "";
            },
            .ready => return "update ready: ctrl+g to reload",
            .failed => return "upgrade failed",
            else => return "",
        }
    }

    pub fn takeRenderDirty(self: *AutoUpgrade) bool {
        return self.render_dirty.swap(false, .acq_rel);
    }

    fn getLatestVersion(self: *AutoUpgrade, out: []u8) []const u8 {
        self.version_mutex.lockUncancelable(io_mod.getIo());
        defer self.version_mutex.unlock(io_mod.getIo());
        const len = self.latest_version_len;
        if (len == 0) return "";
        const n: usize = @min(len, out.len);
        @memcpy(out[0..n], self.latest_version_buf[0..n]);
        return out[0..n];
    }

    fn setState(self: *AutoUpgrade, state: State) void {
        const next = @intFromEnum(state);
        const previous = self.state.swap(next, .acq_rel);
        if (previous != next) self.markRenderDirty();
    }

    fn setLatestVersion(self: *AutoUpgrade, version: []const u8) void {
        const stripped = update_target.normalizeVersion(version);
        const len: u8 = @intCast(@min(stripped.len, 32));
        self.version_mutex.lockUncancelable(io_mod.getIo());
        defer self.version_mutex.unlock(io_mod.getIo());
        @memcpy(self.latest_version_buf[0..len], stripped[0..len]);
        self.latest_version_len = len;
        self.markRenderDirty();
    }

    fn markRenderDirty(self: *AutoUpgrade) void {
        self.render_dirty.store(true, .release);
    }
};

test "statusLabel idle returns empty" {
    var au = AutoUpgrade{};
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqual(@as(usize, 0), label.len);
}

test "statusLabel downloading shows ellipsis" {
    var au = AutoUpgrade{};
    au.setLatestVersion("v0.3.0");
    au.setState(.downloading);
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqualStrings("upgrading to 0.3.0...", label);
}

test "statusLabel ready explains ctrl+g reload" {
    var au = AutoUpgrade{};
    au.setState(.ready);
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqualStrings("update ready: ctrl+g to reload", label);
}

test "setLatestVersion stores normalized version" {
    var au = AutoUpgrade{};
    _ = au.takeRenderDirty();
    au.setLatestVersion("v1.2.3");
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("1.2.3", au.getLatestVersion(&buf));
    try std.testing.expect(au.takeRenderDirty());
}

test "relaunch request owns the executable path and is consumed once" {
    var au = AutoUpgrade{};
    var source = [_]u8{ '/', 't', 'm', 'p', '/', 'f', 'x' };
    try au.requestRelaunch(&source);
    source[1] = 'x';

    const request = au.takeRelaunchRequest() orelse
        return error.TestExpectedRelaunchRequest;
    try std.testing.expectEqualStrings("/tmp/fx", request.executablePath());
    try std.testing.expect(au.takeRelaunchRequest() == null);
}

test "statusLabel waiting returns empty" {
    var au = AutoUpgrade{};
    au.setState(.waiting);
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqual(@as(usize, 0), label.len);
}

test "statusLabel checking returns empty" {
    var au = AutoUpgrade{};
    au.setState(.checking);
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqual(@as(usize, 0), label.len);
}

test "statusLabel failed shows upgrade failed" {
    var au = AutoUpgrade{};
    au.setState(.failed);
    var buf: [64]u8 = undefined;
    const label = au.statusLabel(&buf);
    try std.testing.expectEqualStrings("upgrade failed", label);
}

test "getState returns the current atomic state" {
    var au = AutoUpgrade{};
    try std.testing.expectEqual(State.idle, au.getState());
    try std.testing.expect(!au.takeRenderDirty());
    au.setState(.checking);
    try std.testing.expectEqual(State.checking, au.getState());
    try std.testing.expect(au.takeRenderDirty());
    try std.testing.expect(!au.takeRenderDirty());
    au.setState(.checking);
    try std.testing.expect(!au.takeRenderDirty());
}

test "setLatestVersion truncates to stored capacity" {
    var au = AutoUpgrade{};
    au.setLatestVersion("v1234567890123456789012345678901234567890");

    var buf: [40]u8 = undefined;
    const latest = au.getLatestVersion(&buf);
    try std.testing.expectEqual(@as(usize, 32), latest.len);
    try std.testing.expectEqualStrings("12345678901234567890123456789012", latest);
}
