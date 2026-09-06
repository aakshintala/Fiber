const std = @import("std");

const Allocator = std.mem.Allocator;

pub const max_version_bytes: usize = 32;

pub const CurrentBuild = struct {
    version: []const u8,
    revision: []const u8,
};

pub const Target = struct {
    version: []u8,
    artifact_ref: []u8,

    pub fn initStable(alloc: Allocator, raw_version: []const u8) !Target {
        const trimmed = std.mem.trim(u8, raw_version, " \t\r\n");
        const normalized_version = normalizeVersion(trimmed);
        if (!validVersion(normalized_version)) return error.InvalidVersion;

        const owned_version = try alloc.dupe(u8, normalized_version);
        errdefer alloc.free(owned_version);
        const artifact_ref = try alloc.dupe(u8, trimmed);
        return .{
            .version = owned_version,
            .artifact_ref = artifact_ref,
        };
    }

    pub fn deinit(self: *Target, alloc: Allocator) void {
        alloc.free(self.version);
        alloc.free(self.artifact_ref);
        self.* = undefined;
    }

    pub fn artifactRef(self: Target) []const u8 {
        return self.artifact_ref;
    }

    pub fn shouldInstall(self: Target, current: CurrentBuild) bool {
        return compareVersions(self.version, current.version) == .gt;
    }

    pub fn writeDisplayLabel(self: Target, out: []u8) ![]const u8 {
        return std.fmt.bufPrint(out, "{s}", .{self.version});
    }
};

pub fn normalizeVersion(raw: []const u8) []const u8 {
    if (raw.len > 0 and raw[0] == 'v') return raw[1..];
    return raw;
}

pub fn compareVersions(a: []const u8, b: []const u8) std.math.Order {
    const av = parseVersionParts(a);
    const bv = parseVersionParts(b);
    if (av[0] != bv[0]) return std.math.order(av[0], bv[0]);
    if (av[1] != bv[1]) return std.math.order(av[1], bv[1]);
    return std.math.order(av[2], bv[2]);
}

fn validVersion(raw: []const u8) bool {
    if (raw.len == 0 or raw.len > max_version_bytes) return false;
    var count: usize = 0;
    var parts = std.mem.splitScalar(u8, raw, '.');
    while (parts.next()) |part| {
        if (count == 3 or part.len == 0) return false;
        for (part) |byte| if (!std.ascii.isDigit(byte)) return false;
        _ = std.fmt.parseUnsigned(u32, part, 10) catch return false;
        count += 1;
    }
    return count == 3;
}

fn parseVersionParts(raw: []const u8) [3]u32 {
    var values = [_]u32{ 0, 0, 0 };
    var parts = std.mem.splitScalar(u8, normalizeVersion(raw), '.');
    for (&values) |*value| {
        const part = parts.next() orelse break;
        value.* = std.fmt.parseUnsigned(u32, part, 10) catch 0;
    }
    return values;
}

test "stable release ordering rejects older targets" {
    const alloc = std.testing.allocator;
    var older = try Target.initStable(alloc, "v0.0.1");
    defer older.deinit(alloc);
    const newer_current = CurrentBuild{
        .version = "0.0.2",
        .revision = "0123456789ab",
    };

    try std.testing.expect(!older.shouldInstall(newer_current));
    try std.testing.expect(!older.shouldInstall(.{
        .version = "0.4.5",
        .revision = "0123456789ab",
    }));
}
