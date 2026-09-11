const std = @import("std");
const stream_provider = @import("../agent/stream_provider.zig");
const model_provider = @import("../config/model_provider.zig");
const model_capabilities = @import("../config/model_capabilities.zig");
const provider_catalog = @import("../auth/provider_catalog.zig");
const gateway_provider = @import("gateway_provider.zig");
const auto_classifier = @import("../permissions/auto_classifier.zig");
const model_catalog = @import("model_catalog.zig");

const Allocator = std.mem.Allocator;

pub const Bundle = struct {
    pub const AuthStrategy = enum {
        chatgpt,
    };
    pub const Capabilities = struct {
        vision_fallback: bool = false,
    };

    capabilities: Capabilities = .{},
    presentation: ?*const provider_catalog.Entry = null,
    auth_strategy: ?AuthStrategy = null,
    fallback_model_capabilities_fn: *const fn ([]const u8) model_capabilities.Capabilities = emptyModelCapabilities,
    agent_stream: ?stream_provider.Provider = null,
    cli_model_catalog: ?gateway_provider.CliModelCatalogProvider = null,
    model_catalog: ?model_catalog.Provider = null,
    permission_reviewer: ?auto_classifier.Provider = null,

    pub fn agent_stream_or_unavailable(self: Bundle) stream_provider.Provider {
        return self.agent_stream orelse stream_provider.unavailable_provider;
    }

    pub fn fallbackModelCapabilities(self: Bundle, model: []const u8) model_capabilities.Capabilities {
        return self.fallback_model_capabilities_fn(model);
    }
};

fn emptyModelCapabilities(_: []const u8) model_capabilities.Capabilities {
    return .{};
}

pub const Set = struct {
    codex: Bundle,

    pub fn select(self: Set, provider: model_provider.ProviderId) Bundle {
        switch (provider) {
            .codex => {},
        }
        return self.codex;
    }
};

test "provider set selects the codex route" {
    var codex_tag: u8 = 0;

    const Fake = struct {
        fn cli_catalog(
            _: ?*anyopaque,
            _: Allocator,
            _: gateway_provider.CliModelCatalogInput,
        ) gateway_provider.CliModelCatalogResult {
            return .{ .failure = .{
                .access = .init(.{ .public_only = .no_credential }),
                .anonymous_fallback_used = false,
                .failure = .{ .category = .runtime },
            } };
        }

        fn model_catalog_fetch(
            _: ?*anyopaque,
            _: Allocator,
            _: model_catalog.FetchInput,
        ) Allocator.Error!model_catalog.ProviderResult {
            return .{ .catalog = .empty };
        }

        fn review(
            _: ?*anyopaque,
            _: Allocator,
            _: auto_classifier.ProviderInput,
            _: auto_classifier.ReviewRequest,
        ) anyerror!auto_classifier.ParseOutcome {
            return .invalid;
        }
    };

    const codex = Bundle{
        .agent_stream = stream_provider.Provider{
            .context = &codex_tag,
            .stream_fn = stream_provider.unavailable_provider.stream_fn,
        },
        .cli_model_catalog = .{ .context = &codex_tag, .fetch_fn = Fake.cli_catalog },
        .model_catalog = .{ .context = &codex_tag, .fetch_fn = Fake.model_catalog_fetch },
        .permission_reviewer = .{ .context = &codex_tag, .review_fn = Fake.review },
    };
    var providers = Set{ .codex = codex };

    try std.testing.expect(providers.select(.codex).agent_stream.?.context.? == @as(*anyopaque, @ptrCast(&codex_tag)));
    try std.testing.expect(providers.select(.codex).model_catalog.?.context.? == @as(*anyopaque, @ptrCast(&codex_tag)));
    try std.testing.expect(providers.select(.codex).agent_stream_or_unavailable().context.? == @as(*anyopaque, @ptrCast(&codex_tag)));

    providers.codex.model_catalog = null;
    try std.testing.expect(providers.select(.codex).model_catalog == null);
}
