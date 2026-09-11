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
    const a_stripped = strip_build_metadata(normalizeVersion(a));
    const b_stripped = strip_build_metadata(normalizeVersion(b));
    const a_parts = parse_version_parts(a_stripped);
    const b_parts = parse_version_parts(b_stripped);
    for (0..3) |i| {
        const ord = compare_core_part(a_parts[i], b_parts[i]);
        if (ord != .eq) return ord;
    }
    return compare_prerelease(prerelease_part(a_stripped), prerelease_part(b_stripped));
}

fn strip_build_metadata(version: []const u8) []const u8 {
    if (std.mem.findScalar(u8, version, '+')) |idx| return version[0..idx];
    return version;
}

fn core_part(version_no_build: []const u8) []const u8 {
    if (std.mem.findScalar(u8, version_no_build, '-')) |idx| return version_no_build[0..idx];
    return version_no_build;
}

fn prerelease_part(version_no_build: []const u8) ?[]const u8 {
    const idx = std.mem.findScalar(u8, version_no_build, '-') orelse return null;
    const pre = version_no_build[idx + 1 ..];
    if (pre.len == 0) return null;
    return pre;
}

fn compare_prerelease(a: ?[]const u8, b: ?[]const u8) std.math.Order {
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
        switch (compare_prerelease_ident(a_next.?, b_next.?)) {
            .eq => continue,
            else => |ord| return ord,
        }
    }
}

fn compare_prerelease_ident(a: []const u8, b: []const u8) std.math.Order {
    const a_numeric = is_numeric_ident(a);
    const b_numeric = is_numeric_ident(b);
    if (a_numeric and b_numeric) return compare_numeric_ident(a, b);
    if (a_numeric) return .lt;
    if (b_numeric) return .gt;
    return std.mem.order(u8, a, b);
}

fn is_numeric_ident(ident: []const u8) bool {
    if (ident.len == 0) return false;
    for (ident) |byte| if (!std.ascii.isDigit(byte)) return false;
    return true;
}

fn compare_numeric_ident(a: []const u8, b: []const u8) std.math.Order {
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

fn compare_core_part(a: []const u8, b: []const u8) std.math.Order {
    if (is_numeric_ident(a) and is_numeric_ident(b)) return compare_numeric_ident(a, b);
    const a_num = std.fmt.parseUnsigned(u32, a, 10) catch 0;
    const b_num = std.fmt.parseUnsigned(u32, b, 10) catch 0;
    return std.math.order(a_num, b_num);
}

fn parse_version_parts(raw_no_build: []const u8) [3][]const u8 {
    var values = [_][]const u8{ "", "", "" };
    var parts = std.mem.splitScalar(u8, core_part(raw_no_build), '.');
    for (&values) |*value| {
        value.* = parts.next() orelse break;
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
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.0.0-alpha", "1.0.0-beta"));
    try std.testing.expectEqual(std.math.Order.eq, compareVersions("v1.2.3-rc.1", "1.2.3-rc.1"));
}

test "large core numbers compare without overflow" {
    try std.testing.expectEqual(std.math.Order.gt, compareVersions("1.2.4294967296", "1.2.3"));
    try std.testing.expectEqual(std.math.Order.lt, compareVersions("1.2.3", "1.2.4294967296-dev.1"));
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
