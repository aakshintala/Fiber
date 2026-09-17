const std = @import("std");
const connection_mod = @import("connection.zig");

const Allocator = std.mem.Allocator;

/// Built-in connection presets, embedded in the binary. Each source is JSON
/// parsed by the same parser as user `connections`
/// (`connection_mod.parseSetInto`), so a preset typo fails the same way a
/// user typo does. Presets live outside `src/core/` because they carry vendor
/// constants; the core ships only the generic mechanism.
const codex_source: []const u8 = @embedFile("codex.json");

const embedded_sources: []const []const u8 = &.{codex_source};

/// Parses every embedded preset into the set. Called at startup before user
/// layers merge over it, so user `connections.<preset>` entries override
/// field by field.
pub fn loadInto(
    alloc: Allocator,
    set: *connection_mod.ConnectionSet,
    detail: ?*connection_mod.ParseDetail,
) connection_mod.Error!void {
    for (embedded_sources) |source| {
        try loadSourceInto(alloc, source, set, detail);
    }
}

pub fn loadSourceInto(
    alloc: Allocator,
    source: []const u8,
    set: *connection_mod.ConnectionSet,
    detail: ?*connection_mod.ParseDetail,
) connection_mod.Error!void {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, source, .{}) catch {
        return error.InvalidConnectionType;
    };
    defer parsed.deinit();
    try connection_mod.parseSetInto(alloc, parsed.value, set, detail);
}

test "embedded codex preset parses with the user-config parser" {
    const alloc = std.testing.allocator;
    var set = connection_mod.ConnectionSet{};
    defer set.deinit(alloc);
    var detail = connection_mod.ParseDetail{};
    defer detail.deinit(alloc);
    try loadInto(alloc, &set, &detail);

    const codex = set.get("codex") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.CredentialKind.oauth, codex.credential.?);
    try std.testing.expectEqual(connection_mod.Protocol.responses, codex.protocol.?);
    try std.testing.expectEqualStrings("https://chatgpt.com/backend-api/codex/responses", codex.base_url.?);
    try std.testing.expectEqual(connection_mod.BillingKind.subscription, codex.billing.?);
}

test "malformed preset source fails to load" {
    const alloc = std.testing.allocator;
    var detail = connection_mod.ParseDetail{};
    defer detail.deinit(alloc);
    const broken = [_][]const u8{
        "{not json",
        "[]",
        "{\"codex\":{\"base_url\":\"https://x.test\",\"bogus\":1}}",
    };
    for (broken) |source| {
        var set = connection_mod.ConnectionSet{};
        defer set.deinit(alloc);
        if (loadSourceInto(alloc, source, &set, &detail)) |_| {
            return error.TestExpectedPresetFailure;
        } else |_| {}
    }
    try std.testing.expectEqualStrings("codex", detail.connection.?);
    try std.testing.expectEqualStrings("bogus", detail.key.?);
}
