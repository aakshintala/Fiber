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
    const a_stripped = stripBuildMetadata(normalizeVersion(a));
    const b_stripped = stripBuildMetadata(normalizeVersion(b));
    const av = parseVersionParts(a_stripped);
    const bv = parseVersionParts(b_stripped);
    if (av[0] != bv[0]) return std.math.order(av[0], bv[0]);
    if (av[1] != bv[1]) return std.math.order(av[1], bv[1]);
    if (av[2] != bv[2]) return std.math.order(av[2], bv[2]);
    return comparePrerelease(prereleasePart(a_stripped), prereleasePart(b_stripped));
}

fn stripBuildMetadata(version: []const u8) []const u8 {
    if (std.mem.findScalar(u8, version, '+')) |idx| return version[0..idx];
    return version;
}

fn corePart(version_no_build: []const u8) []const u8 {
    if (std.mem.findScalar(u8, version_no_build, '-')) |idx| return version_no_build[0..idx];
    return version_no_build;
}

fn prereleasePart(version_no_build: []const u8) ?[]const u8 {
    const idx = std.mem.findScalar(u8, version_no_build, '-') orelse return null;
    const pre = version_no_build[idx + 1 ..];
    if (pre.len == 0) return null;
    return pre;
}

fn comparePrerelease(a: ?[]const u8, b: ?[]const u8) std.math.Order {
    if (a == null and b == null) return .eq;
    if (a == null) return .gt;
    if (b == null) return .lt;
    var a_parts = std.mem.splitScalar(u8, a.?, '.');
    var b_parts = std.mem.splitScalar(u8, b.?, '.');
    while (true) {
        const a_next = a_parts.next();
        const b_next = b_parts.next();
        if (a_next == null and b_next == null) return .eq;
        if (a_next == null) return .lt;
        if (b_next == null) return .gt;
        switch (comparePrereleaseIdent(a_next.?, b_next.?)) {
            .eq => continue,
            else => |ord| return ord,
        }
    }
}

fn comparePrereleaseIdent(a: []const u8, b: []const u8) std.math.Order {
    const a_numeric = isNumericIdent(a);
    const b_numeric = isNumericIdent(b);
    if (a_numeric and b_numeric) return compareNumericIdent(a, b);
    if (a_numeric) return .lt;
    if (b_numeric) return .gt;
    return std.mem.order(u8, a, b);
}

fn isNumericIdent(ident: []const u8) bool {
    if (ident.len == 0) return false;
    for (ident) |byte| if (!std.ascii.isDigit(byte)) return false;
    return true;
}

fn compareNumericIdent(a: []const u8, b: []const u8) std.math.Order {
    const a_trimmed = std.mem.trimStart(u8, a, "0");
    const b_trimmed = std.mem.trimStart(u8, b, "0");
    if (a_trimmed.len != b_trimmed.len) return std.math.order(a_trimmed.len, b_trimmed.len);
    return std.mem.order(u8, a_trimmed, b_trimmed);
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

fn parseVersionParts(raw_no_build: []const u8) [3]u32 {
    var values = [_]u32{ 0, 0, 0 };
    var parts = std.mem.splitScalar(u8, corePart(raw_no_build), '.');
    for (&values) |*value| {
        const part = parts.next() orelse break;
        value.* = std.fmt.parseUnsigned(u32, part, 10) catch 0;
    }
    return values;
}

test "suffixed development build is not offered an older release" {
    const alloc = std.testing.allocator;
    var target = try Target.initStable(alloc, "v1.2.3");
    defer target.deinit(alloc);

    try std.testing.expect(!target.shouldInstall(.{
        .version = "1.2.4-dev.1",
        .revision = "0123456789ab",
    }));
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.2.3", "1.2.3-dev.1"));
    try std.testing.expect(target.shouldInstall(.{
        .version = "1.2.3-rc.1",
        .revision = "0123456789ab",
    }));
}

test "prerelease identifiers follow semver precedence" {
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-alpha", "1.0.0"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-1", "1.0.0-alpha"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-alpha", "1.0.0-alpha.1"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-2", "1.0.0-10"));
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("v1.2.3-rc.1", "1.2.3-rc.1"));
}

test "build metadata does not affect precedence" {
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("1.0.0+build.1", "1.0.0"));
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("1.0.0-alpha+build", "1.0.0-alpha"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-alpha+build", "1.0.0"));
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
