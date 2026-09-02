const std = @import("std");
const credentials = @import("credentials.zig");
const model_provider = @import("../config/model_provider.zig");

pub const ProviderSwitchDecision = enum {
    no_change,
    busy,
    prepare,
};

pub const ProviderSwitchIntent = enum {
    manual,
    post_oauth,
};

pub const ProviderSwitchFacts = struct {
    current: model_provider.ProviderId,
    target: model_provider.ProviderId,
    target_credential_ready: bool,
    intent: ProviderSwitchIntent,
    stream_active: bool,
    queued_prompts: usize,
};

pub fn decideProviderSwitch(facts: ProviderSwitchFacts) ProviderSwitchDecision {
    if (facts.intent == .manual and facts.current == facts.target and facts.target_credential_ready) {
        return .no_change;
    }
    if (facts.stream_active or facts.queued_prompts > 0) return .busy;
    return .prepare;
}

pub const LogoutFacts = struct {
    requested: ?model_provider.ProviderId,
    selected: model_provider.ProviderId,
    active_source: ?credentials.Source,
    available_sources: std.EnumSet(credentials.Source),
};

pub fn decideLogoutProvider(facts: LogoutFacts) model_provider.ProviderId {
    if (facts.requested) |provider| return provider;
    _ = facts.active_source;
    _ = facts.available_sources;
    return .codex;
}

pub const SignInCompletionAction = union(enum) {
    switch_provider: model_provider.ProviderId,
    activate_source: credentials.Source,
};

pub fn signInCompletion(
    provider: model_provider.ProviderId,
    provider_routing_supported: bool,
) SignInCompletionAction {
    _ = provider_routing_supported;
    return switch (provider) {
        .codex => .{ .activate_source = .chatgpt_subscription },
    };
}

test "provider switch and logout decisions are pure and provider keyed" {
    try std.testing.expectEqual(ProviderSwitchDecision.no_change, decideProviderSwitch(.{
        .current = .codex,
        .target = .codex,
        .target_credential_ready = true,
        .intent = .manual,
        .stream_active = false,
        .queued_prompts = 0,
    }));
    try std.testing.expectEqual(ProviderSwitchDecision.busy, decideProviderSwitch(.{
        .current = .codex,
        .target = .codex,
        .target_credential_ready = true,
        .intent = .manual,
        .stream_active = true,
        .queued_prompts = 0,
    }));

    var inventory: std.EnumSet(credentials.Source) = .empty;
    inventory.insert(.chatgpt_subscription);
    try std.testing.expectEqual(model_provider.ProviderId.codex, decideLogoutProvider(.{
        .requested = null,
        .selected = .codex,
        .active_source = null,
        .available_sources = inventory,
    }));
    try std.testing.expectEqual(model_provider.ProviderId.codex, decideLogoutProvider(.{
        .requested = .codex,
        .selected = .codex,
        .active_source = .chatgpt_subscription,
        .available_sources = inventory,
    }));
}

test "sign in completion selects routing or credential activation without effects" {
    try std.testing.expectEqual(
        SignInCompletionAction{ .activate_source = .chatgpt_subscription },
        signInCompletion(.codex, false),
    );
    try std.testing.expectEqual(
        SignInCompletionAction{ .activate_source = .chatgpt_subscription },
        signInCompletion(.codex, true),
    );
}
