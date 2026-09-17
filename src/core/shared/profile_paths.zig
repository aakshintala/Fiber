const std = @import("std");
const io_mod = @import("io.zig");

const Allocator = std.mem.Allocator;

/// Environment override for the entire profile root (issue #132). When set,
/// every helper below resolves under this absolute path instead of
/// `$HOME/.fiber`, so two processes given different roots share nothing.
/// Sharing is expressed by pointing processes at the same path.
pub const state_dir_env_name = "FIBER_STATE_DIR";

pub const root_dir_name = ".fiber";
pub const chatgpt_auth_file_name = "chatgpt-auth.json";
pub const sessions_dir_name = "sessions";
pub const prompt_history_file_name = "history.jsonl";
pub const usage_file_name = "usage.jsonl";
pub const usage_recovery_dir_name = "usage-recovery";
pub const backups_dir_name = "backups";
pub const mcp_credentials_dir_name = "mcp-credentials";
pub const mcp_credentials_file_name = "credentials.json";

const settings_file_name = "settings.json";
const mcp_config_file_name = "mcp.json";
const managed_skills_dir_name = "skills";
const logs_dir_name = "logs";
const trace_log_file_name = "trace.log";
const recordings_dir_name = "recordings";

/// Borrowed, validated override root, or null when the variable is unset.
/// A set-but-empty or set-but-relative value is an error, never a silent
/// fallback: falling back would write state where the caller did not
/// expect it. The returned slice strips trailing slashes (except a lone
/// root) and borrows from the process environment; do not free it.
/// True for values resolveStateRoot accepts: non-empty and absolute.
/// Shared with the startup gate in config_runtime.zig so the check and the
/// resolver cannot drift apart.
pub fn stateDirValid(raw: []const u8) bool {
    var value = raw;
    while (value.len > 1 and value[value.len - 1] == '/') value = value[0 .. value.len - 1];
    return value.len > 0 and std.fs.path.isAbsolute(value);
}

pub fn validatedOverride() !?[]const u8 {
    const raw = io_mod.getenv(state_dir_env_name) orelse return null;
    var value = raw;
    while (value.len > 1 and value[value.len - 1] == '/') value = value[0 .. value.len - 1];
    if (!stateDirValid(raw)) return error.InvalidFiberStateDir;
    return value;
}

/// Caller-owned state root: the override when set, else `$HOME/.fiber`.
/// Takes an optional home so an overridden process does not need HOME at
/// call sites that already tolerate a missing one.
pub fn resolveStateRoot(alloc: Allocator, home: ?[]const u8) ![]u8 {
    if (try validatedOverride()) |root| return alloc.dupe(u8, root);
    const base = home orelse return error.HomeNotSet;
    return std.fs.path.join(alloc, &.{ base, root_dir_name });
}

pub fn rootDir(alloc: Allocator, home: []const u8) ![]u8 {
    return resolveStateRoot(alloc, home);
}

pub fn settingsPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, settings_file_name });
}

pub fn mcpConfigPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, mcp_config_file_name });
}

pub fn mcpCredentialsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, mcp_credentials_dir_name });
}

pub fn mcpCredentialsPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{
        root,
        mcp_credentials_dir_name,
        mcp_credentials_file_name,
    });
}

pub fn managedSkillsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, managed_skills_dir_name });
}

pub fn chatgptAuthPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, chatgpt_auth_file_name });
}

pub fn sessionsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, sessions_dir_name });
}

pub fn promptHistoryPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, prompt_history_file_name });
}

pub fn backupsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, backups_dir_name });
}

pub fn logsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, logs_dir_name });
}

pub fn traceLogPath(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, logs_dir_name, trace_log_file_name });
}

pub fn recordingsDir(alloc: Allocator, home: []const u8) ![]u8 {
    const root = try resolveStateRoot(alloc, home);
    defer alloc.free(root);
    return std.fs.path.join(alloc, &.{ root, recordings_dir_name });
}

test "profile path helpers preserve current default locations" {
    const alloc = std.testing.allocator;

    const root = try rootDir(alloc, "/tmp/fake-home");
    defer alloc.free(root);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber", root);

    const settings = try settingsPath(alloc, "/tmp/fake-home");
    defer alloc.free(settings);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/settings.json", settings);

    const mcp = try mcpConfigPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/mcp.json", mcp);

    const mcp_credentials_dir = try mcpCredentialsDir(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials_dir);
    try std.testing.expectEqualStrings(
        "/tmp/fake-home/.fiber/mcp-credentials",
        mcp_credentials_dir,
    );

    const mcp_credentials = try mcpCredentialsPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials);
    try std.testing.expectEqualStrings(
        "/tmp/fake-home/.fiber/mcp-credentials/credentials.json",
        mcp_credentials,
    );

    const skills = try managedSkillsDir(alloc, "/tmp/fake-home");
    defer alloc.free(skills);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/skills", skills);

    const chatgpt_auth = try chatgptAuthPath(alloc, "/tmp/fake-home");
    defer alloc.free(chatgpt_auth);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/chatgpt-auth.json", chatgpt_auth);

    const sessions = try sessionsDir(alloc, "/tmp/fake-home");
    defer alloc.free(sessions);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/sessions", sessions);

    const history = try promptHistoryPath(alloc, "/tmp/fake-home");
    defer alloc.free(history);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/history.jsonl", history);

    const backups = try backupsDir(alloc, "/tmp/fake-home");
    defer alloc.free(backups);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/backups", backups);

    const logs = try logsDir(alloc, "/tmp/fake-home");
    defer alloc.free(logs);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/logs", logs);

    const trace = try traceLogPath(alloc, "/tmp/fake-home");
    defer alloc.free(trace);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/logs/trace.log", trace);

    const recordings = try recordingsDir(alloc, "/tmp/fake-home");
    defer alloc.free(recordings);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber/recordings", recordings);
}

/// Minimal environment swap for override tests, shared with other files'
/// state-dir tests. Saves and restores the outer environment exactly once
/// across nesting, mirroring the credential_store TestHome pattern.
pub const TestEnv = struct {
    alloc: Allocator,
    map: std.process.Environ.Map,

    pub fn install(alloc: Allocator, entries: []const struct { key: []const u8, value: []const u8 }) !*TestEnv {
        if (test_env_depth == 0) {
            test_env_outer = io_mod.environMap();
            if (test_env_empty == null) {
                test_env_empty = std.process.Environ.Map.init(alloc);
            }
        }
        test_env_depth += 1;
        const self = try alloc.create(TestEnv);
        errdefer alloc.destroy(self);
        self.* = .{
            .alloc = alloc,
            .map = std.process.Environ.Map.init(alloc),
        };
        errdefer self.map.deinit();
        for (entries) |entry| try self.map.put(entry.key, entry.value);
        io_mod.setEnvironMap(&self.map);
        return self;
    }

    pub fn put(self: *TestEnv, key: []const u8, value: []const u8) !void {
        try self.map.put(key, value);
    }

    pub fn deinit(self: *TestEnv) void {
        test_env_depth -= 1;
        if (test_env_depth == 0) {
            if (test_env_outer) |outer| {
                io_mod.setEnvironMap(outer);
            } else {
                io_mod.setEnvironMap(&test_env_empty.?);
            }
        }
        self.map.deinit();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

var test_env_outer: ?*const std.process.Environ.Map = null;
var test_env_depth: usize = 0;
var test_env_empty: ?std.process.Environ.Map = null;

test "state root override redirects every helper under the override" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = "/tmp/fake-home" },
        .{ .key = state_dir_env_name, .value = "/tmp/state" },
    });
    defer env.deinit();

    const cases = [_]struct { actual: []u8, expected: []const u8 }{
        .{ .actual = try rootDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state" },
        .{ .actual = try settingsPath(alloc, "/tmp/fake-home"), .expected = "/tmp/state/settings.json" },
        .{ .actual = try mcpConfigPath(alloc, "/tmp/fake-home"), .expected = "/tmp/state/mcp.json" },
        .{ .actual = try mcpCredentialsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/mcp-credentials" },
        .{
            .actual = try mcpCredentialsPath(alloc, "/tmp/fake-home"),
            .expected = "/tmp/state/mcp-credentials/credentials.json",
        },
        .{ .actual = try managedSkillsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/skills" },
        .{ .actual = try chatgptAuthPath(alloc, "/tmp/fake-home"), .expected = "/tmp/state/chatgpt-auth.json" },
        .{ .actual = try sessionsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/sessions" },
        .{ .actual = try promptHistoryPath(alloc, "/tmp/fake-home"), .expected = "/tmp/state/history.jsonl" },
        .{ .actual = try backupsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/backups" },
        .{ .actual = try logsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/logs" },
        .{ .actual = try traceLogPath(alloc, "/tmp/fake-home"), .expected = "/tmp/state/logs/trace.log" },
        .{ .actual = try recordingsDir(alloc, "/tmp/fake-home"), .expected = "/tmp/state/recordings" },
    };
    for (cases) |case| {
        defer alloc.free(case.actual);
        try std.testing.expectEqualStrings(case.expected, case.actual);
    }
    // The passed home is ignored while the override is set.
    const elsewhere = try settingsPath(alloc, "/somewhere/else");
    defer alloc.free(elsewhere);
    try std.testing.expectEqualStrings("/tmp/state/settings.json", elsewhere);
}

test "state root override tolerates a trailing slash" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = "/tmp/fake-home" },
        .{ .key = state_dir_env_name, .value = "/tmp/state/" },
    });
    defer env.deinit();

    const root = try rootDir(alloc, "/tmp/fake-home");
    defer alloc.free(root);
    try std.testing.expectEqualStrings("/tmp/state", root);
}

test "state dir validation rejects empty and relative values" {
    try std.testing.expect(!stateDirValid(""));
    try std.testing.expect(!stateDirValid("relative/path"));
    try std.testing.expect(stateDirValid("/abs/path"));
    try std.testing.expect(stateDirValid("/abs/path/"));
}

test "relative state dir is a startup error" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = "/tmp/fake-home" },
        .{ .key = state_dir_env_name, .value = "relative/path" },
    });
    defer env.deinit();

    try std.testing.expectError(error.InvalidFiberStateDir, validatedOverride());
    try std.testing.expectError(error.InvalidFiberStateDir, rootDir(alloc, "/tmp/fake-home"));
    try std.testing.expectError(error.InvalidFiberStateDir, settingsPath(alloc, "/tmp/fake-home"));
}

test "empty state dir is a startup error" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{
        .{ .key = "HOME", .value = "/tmp/fake-home" },
        .{ .key = state_dir_env_name, .value = "" },
    });
    defer env.deinit();

    try std.testing.expectError(error.InvalidFiberStateDir, validatedOverride());
    try std.testing.expectError(error.InvalidFiberStateDir, rootDir(alloc, "/tmp/fake-home"));
}

test "state root without an override still needs a home" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{});
    defer env.deinit();

    try std.testing.expectError(error.HomeNotSet, resolveStateRoot(alloc, null));
    const root = try resolveStateRoot(alloc, "/tmp/fake-home");
    defer alloc.free(root);
    try std.testing.expectEqualStrings("/tmp/fake-home/.fiber", root);
}

test "state root override does not need a home" {
    const alloc = std.testing.allocator;
    const env = try TestEnv.install(alloc, &.{
        .{ .key = state_dir_env_name, .value = "/tmp/state" },
    });
    defer env.deinit();

    const root = try resolveStateRoot(alloc, null);
    defer alloc.free(root);
    try std.testing.expectEqualStrings("/tmp/state", root);
}
