const std = @import("std");

const Allocator = std.mem.Allocator;

pub const max_version_bytes: usize = 32;

pub const Channel = enum {
    stable,

    pub fn parse(raw: []const u8) ?Channel {
        if (std.ascii.eqlIgnoreCase(raw, "stable")) return .stable;
        return null;
    }

    pub fn label(self: Channel) []const u8 {
        return @tagName(self);
    }
};

pub const CurrentBuild = struct {
    channel: Channel,
    version: []const u8,
    revision: []const u8,
};

pub const Target = union(Channel) {
    stable: Stable,

    pub const Stable = struct {
        version: []u8,
        artifact_ref: []u8,
    };

    pub fn initStable(alloc: Allocator, raw_version: []const u8) !Target {
        const trimmed = std.mem.trim(u8, raw_version, " \t\r\n");
        const normalized_version = normalizeVersion(trimmed);
        if (!validVersion(normalized_version)) return error.InvalidVersion;

        const owned_version = try alloc.dupe(u8, normalized_version);
        errdefer alloc.free(owned_version);
        const artifact_ref = try alloc.dupe(u8, trimmed);
        return .{ .stable = .{
            .version = owned_version,
            .artifact_ref = artifact_ref,
        } };
    }

    pub fn deinit(self: *Target, alloc: Allocator) void {
        switch (self.*) {
            .stable => |stable| {
                alloc.free(stable.version);
                alloc.free(stable.artifact_ref);
            },
        }
        self.* = undefined;
    }

    pub fn channel(self: Target) Channel {
        return std.meta.activeTag(self);
    }

    pub fn version(self: Target) []const u8 {
        return switch (self) {
            .stable => |stable| stable.version,
        };
    }

    pub fn revision(self: Target) ?[]const u8 {
        return switch (self) {
            .stable => null,
        };
    }

    pub fn artifactRef(self: Target) []const u8 {
        return switch (self) {
            .stable => |stable| stable.artifact_ref,
        };
    }

    pub fn shouldInstall(self: Target, current: CurrentBuild) bool {
        return switch (self) {
            .stable => |stable| compareVersions(stable.version, current.version) == .gt,
        };
    }

    pub fn writeDisplayLabel(self: Target, out: []u8) ![]const u8 {
        return switch (self) {
            .stable => |stable| std.fmt.bufPrint(out, "{s}", .{stable.version}),
        };
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

test "channel parsing accepts only stable" {
    try std.testing.expectEqual(Channel.stable, Channel.parse("stable").?);
    try std.testing.expect(Channel.parse("dev") == null);
    try std.testing.expect(Channel.parse("nightly") == null);
}

test "stable release ordering rejects older targets" {
    const alloc = std.testing.allocator;
    var older = try Target.initStable(alloc, "v0.0.1");
    defer older.deinit(alloc);
    const newer_current = CurrentBuild{
        .channel = .stable,
        .version = "0.0.2",
        .revision = "0123456789ab",
    };

    try std.testing.expect(!older.shouldInstall(newer_current));
    try std.testing.expect(!older.shouldInstall(.{
        .channel = .stable,
        .version = "0.4.5",
        .revision = "0123456789ab",
    }));
}
