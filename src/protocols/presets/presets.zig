const std = @import("std");
const connection_mod = @import("connection.zig");

const Allocator = std.mem.Allocator;

/// Built-in connection presets, embedded in the binary. Each source is JSON
/// parsed by the same parser as user `connections`
/// (`connection_mod.parseSetInto`), so a preset typo fails the same way a
/// user typo does. Presets live outside `src/core/` because they carry vendor
/// constants; the core ships only the generic mechanism.
const codex_source: []const u8 = @embedFile("codex.json");

const opencode_go_source: []const u8 = @embedFile("opencode-go.json");
const opencode_zen_source: []const u8 = @embedFile("opencode-zen.json");

const embedded_sources: []const []const u8 = &.{ codex_source, opencode_go_source, opencode_zen_source };

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

test "embedded opencode-go preset parses with the user-config parser" {
    const alloc = std.testing.allocator;
    var set = connection_mod.ConnectionSet{};
    defer set.deinit(alloc);
    var detail = connection_mod.ParseDetail{};
    defer detail.deinit(alloc);
    try loadInto(alloc, &set, &detail);

    const go = set.get("opencode-go") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.CredentialKind.api_key, go.credential.?);
    try std.testing.expectEqual(connection_mod.Protocol.chat_completions, go.protocol.?);
    try std.testing.expectEqualStrings("https://opencode.ai/zen/go/v1", go.base_url.?);
    try std.testing.expectEqual(connection_mod.BillingKind.subscription, go.billing.?);

    const glm = go.models.get("glm-5.3-flash") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.Protocol.chat_completions, glm.protocol.?);
    const deepseek = go.models.get("deepseek-v4.1-flash") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.Protocol.chat_completions, deepseek.protocol.?);
    const muse_spark = go.models.get("muse-spark-1.3-contributor") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.Protocol.responses, muse_spark.protocol.?);
    for ([_]connection_mod.ModelOverride{ glm, deepseek, muse_spark }) |model| {
        if (model.context_window orelse 0 <= 0) return error.TestExpectedPreset;
        if (model.output_limit orelse 0 <= 0) return error.TestExpectedPreset;
        if (model.price_input == null or model.price_output == null) return error.TestExpectedPreset;
    }
    const replay = deepseek.compat.entries.get("reasoning_replay") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(true, replay.boolean);
}

test "embedded opencode-zen preset parses with the user-config parser" {
    const alloc = std.testing.allocator;
    var set = connection_mod.ConnectionSet{};
    defer set.deinit(alloc);
    var detail = connection_mod.ParseDetail{};
    defer detail.deinit(alloc);
    try loadInto(alloc, &set, &detail);

    const zen = set.get("opencode-zen") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.CredentialKind.api_key, zen.credential.?);
    try std.testing.expectEqual(connection_mod.Protocol.chat_completions, zen.protocol.?);
    try std.testing.expectEqualStrings("https://opencode.ai/zen/v1", zen.base_url.?);
    try std.testing.expectEqual(connection_mod.BillingKind.metered, zen.billing.?);

    const chat = zen.models.get("deepseek-v4-flash") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.Protocol.chat_completions, chat.protocol.?);
    const responses = zen.models.get("gpt-5") orelse return error.TestExpectedPreset;
    try std.testing.expectEqual(connection_mod.Protocol.responses, responses.protocol.?);
    for ([_]connection_mod.ModelOverride{ chat, responses }) |model| {
        if (model.context_window orelse 0 <= 0) return error.TestExpectedPreset;
        if (model.output_limit orelse 0 <= 0) return error.TestExpectedPreset;
        if (model.price_input == null or model.price_output == null) return error.TestExpectedPreset;
    }
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
