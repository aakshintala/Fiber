const std = @import("std");
const chatgpt_oauth = @import("chatgpt_oauth.zig");
const model_provider = @import("../config/model_provider.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");
const types = @import("../shared/types.zig");

pub const Source = types.CredentialSource;

pub const CatalogPublicOnly = union(enum) {
    no_credential,
    credential_refresh_failed: Source,
    authenticated_credential_rejected: Source,
    chatgpt_subscription,

    fn credentialSource(self: CatalogPublicOnly) ?Source {
        return switch (self) {
            .no_credential => null,
            .credential_refresh_failed => |source| source,
            .authenticated_credential_rejected => |source| source,
            .chatgpt_subscription => .chatgpt_subscription,
        };
    }
};

pub const CatalogPublicOnlyReason = std.meta.Tag(CatalogPublicOnly);

pub const CatalogAuthenticatedSource = enum {
    chatgpt_subscription,

    fn credentialSource(self: CatalogAuthenticatedSource) Source {
        return switch (self) {
            .chatgpt_subscription => .chatgpt_subscription,
        };
    }
};

/// A borrowed authorization decision for one model-catalog request. Public-only
/// states cannot carry credential bytes; authenticated states carry the
/// only values the request is allowed to send.
pub const CatalogAccess = union(enum) {
    public_only: CatalogPublicOnly,
    authenticated: struct {
        source: CatalogAuthenticatedSource,
        credential: []const u8,
    },

    pub fn credentialSource(self: CatalogAccess) ?Source {
        return switch (self) {
            .public_only => |access| access.credentialSource(),
            .authenticated => |access| access.source.credentialSource(),
        };
    }

    pub fn publicOnlyReason(self: CatalogAccess) ?CatalogPublicOnlyReason {
        const access = self.publicOnly() orelse return null;
        return std.meta.activeTag(access);
    }

    pub fn publicOnly(self: CatalogAccess) ?CatalogPublicOnly {
        return switch (self) {
            .public_only => |access| access,
            .authenticated => null,
        };
    }

    pub fn publicFallbackAfterRejection(self: CatalogAccess) ?CatalogAccess {
        return switch (self) {
            .public_only => null,
            .authenticated => null,
        };
    }

    pub fn authorizationCredential(self: CatalogAccess) ?[]const u8 {
        return switch (self) {
            .public_only => null,
            .authenticated => |access| access.credential,
        };
    }
};

pub fn catalogAccessAt(credential: ?Credential, now_ms: i64) CatalogAccess {
    _ = now_ms;
    const selected = credential orelse return .{ .public_only = .no_credential };
    return catalogAccessForCredential(selected.source, selected.token);
}

pub fn catalogAccessAfterRefreshFailure(source: Source) CatalogAccess {
    return .{
        .public_only = .{
            .credential_refresh_failed = source,
        },
    };
}

pub fn catalogAccessForCredential(
    source: ?Source,
    credential: []const u8,
) CatalogAccess {
    const selected_source = source orelse return .{ .public_only = .no_credential };
    const authenticated_source: CatalogAuthenticatedSource = switch (selected_source) {
        .chatgpt_subscription => .chatgpt_subscription,
    };
    return .{
        .authenticated = .{
            .source = authenticated_source,
            .credential = credential,
        },
    };
}

pub const missing_credential_message = missing_chatgpt_credential_message;
pub const missing_interactive_credential_message = missing_chatgpt_interactive_credential_message;
pub const missing_chatgpt_credential_message = "fiber needs a Codex subscription login for this model. Run fiber auth login codex.";
pub const missing_chatgpt_interactive_credential_message = "Codex needs a subscription login. Run /login, open Connections, then choose Codex subscription.";

test "public credential guidance spells fiber lowercase" {
    try std.testing.expect(std.mem.startsWith(u8, missing_credential_message, "fiber needs"));
    try std.testing.expect(std.mem.startsWith(u8, missing_interactive_credential_message, "Codex needs"));
}

pub const Credential = struct {
    token: []u8,
    source: Source,
    account_id: ?[]u8 = null,
    refresh_after_ms: ?i64 = null,

    pub fn deinit(self: *Credential, alloc: std.mem.Allocator) void {
        secret.zeroAndFree(alloc, self.token);
        if (self.account_id) |account_id| alloc.free(account_id);
        self.* = undefined;
    }

    pub fn accountId(self: Credential) ?[]const u8 {
        return self.account_id;
    }

    pub fn needsRefreshAt(self: Credential, now_ms: i64) bool {
        const refresh_after_ms = self.refresh_after_ms orelse return false;
        return refresh_after_ms <= now_ms;
    }
};

/// Both modes resolve the same source set; the mode selects only whether an expired
/// subscription session is refreshed first.
pub const LoadMode = enum { stored, refresh_if_needed };

pub const Resolution = struct {
    credential: ?Credential = null,
};

/// The single credential resolution method. Loads the Codex subscription
/// credential, refreshing an expired session when the mode allows it.
pub fn resolve(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: LoadMode,
) !Resolution {
    return resolveForProvider(alloc, transport, mode, .codex);
}

pub fn resolveForProvider(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: LoadMode,
    provider: model_provider.ProviderId,
) !Resolution {
    switch (provider) {
        .codex => {
            const credential = switch (mode) {
                .stored => try loadStoredChatGptCredential(alloc),
                .refresh_if_needed => try loadChatGptCredential(alloc, transport, .if_needed),
            };
            return .{ .credential = credential };
        },
    }
}

pub fn refreshChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
) !?Credential {
    return loadChatGptCredential(alloc, transport, .force);
}

fn loadChatGptCredential(
    alloc: std.mem.Allocator,
    transport: oauth_transport.Provider,
    mode: chatgpt_oauth.RefreshMode,
) !?Credential {
    var access = (try chatgpt_oauth.loadAccess(alloc, transport, mode)) orelse return null;
    defer access.deinit(alloc);
    const token = access.access_token;
    access.access_token = &.{};
    const account_id = access.account_id;
    access.account_id = &.{};
    return .{
        .token = token,
        .source = .chatgpt_subscription,
        .account_id = account_id,
        .refresh_after_ms = access.refresh_after_ms,
    };
}

fn loadStoredChatGptCredential(alloc: std.mem.Allocator) !?Credential {
    return loadChatGptCredential(alloc, oauth_transport.unavailable_provider, .stored);
}

pub fn sourceLabel(source: Source) []const u8 {
    return switch (source) {
        .chatgpt_subscription => "Codex subscription",
    };
}

pub fn sourceRefreshable(source: Source) bool {
    return source == .chatgpt_subscription;
}

test "catalog access isolates public and authenticated provider credentials" {
    const missing = catalogAccessAt(null, 0);
    try std.testing.expectEqual(CatalogPublicOnlyReason.no_credential, missing.publicOnlyReason().?);
    try std.testing.expect(missing.credentialSource() == null);
    try std.testing.expect(missing.authorizationCredential() == null);

    const refresh_failed = catalogAccessAfterRefreshFailure(.chatgpt_subscription);
    try std.testing.expectEqual(CatalogPublicOnlyReason.credential_refresh_failed, refresh_failed.publicOnlyReason().?);
    try std.testing.expectEqual(Source.chatgpt_subscription, refresh_failed.credentialSource().?);

    const chatgpt = catalogAccessForCredential(
        .chatgpt_subscription,
        "chatgpt-secret",
    );
    try std.testing.expectEqual(Source.chatgpt_subscription, chatgpt.credentialSource().?);
    try std.testing.expectEqualStrings("chatgpt-secret", chatgpt.authorizationCredential().?);
    try std.testing.expect(chatgpt.publicFallbackAfterRejection() == null);

    const rejected: CatalogAccess = .{ .public_only = .{ .authenticated_credential_rejected = .chatgpt_subscription } };
    try std.testing.expectEqual(CatalogPublicOnlyReason.authenticated_credential_rejected, rejected.publicOnlyReason().?);
    try std.testing.expectEqual(Source.chatgpt_subscription, rejected.credentialSource().?);
    try std.testing.expect(rejected.authorizationCredential() == null);
}

test "fresh short-lived credential remains ready for its admitted action" {
    var credential = Credential{
        .token = try std.testing.allocator.dupe(u8, "token"),
        .source = .chatgpt_subscription,
        .refresh_after_ms = 10,
    };
    defer credential.deinit(std.testing.allocator);
    try std.testing.expect(credential.needsRefreshAt(10));
    try std.testing.expect(!credential.needsRefreshAt(9));
}
