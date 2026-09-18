const std = @import("std");

const Allocator = std.mem.Allocator;

/// A `Connection` is data: credential kind, default protocol, default base
/// URL, default compat flags, billing kind, and per-model overrides.
/// (#37 decisions 6, 7, 12, 25; issue #286.)
///
/// This module is generic: it never names a vendor. Built-in presets are JSON
/// files under this directory parsed by the same functions that parse user
/// `connections` in `~/.fiber/settings.json`.
const max_connections: usize = 32;
const max_models_per_connection: usize = 256;
const max_name_bytes: usize = 256;
const max_base_url_bytes: usize = 2048;
const max_compat_entries: usize = 64;

pub const Error = error{
    UnknownConnectionKey,
    InvalidConnectionType,
    UnknownCredentialKind,
    UnknownProtocol,
    UnknownBillingKind,
    InvalidBaseUrl,
    InvalidConnectionName,
    InvalidModelName,
    InvalidCompat,
    TooManyConnections,
    TooManyModels,
    TooManyCompatEntries,
    OutOfMemory,
};

/// Four credential kinds (decision 12). The store itself lands later; this
/// ticket only declares which kind a connection needs.
pub const CredentialKind = enum {
    oauth,
    api_key,
    env,
    none,

    pub fn parse(raw: []const u8) Error!CredentialKind {
        if (std.mem.eql(u8, raw, "oauth")) return .oauth;
        if (std.mem.eql(u8, raw, "api_key")) return .api_key;
        if (std.mem.eql(u8, raw, "env")) return .env;
        if (std.mem.eql(u8, raw, "none")) return .none;
        return error.UnknownCredentialKind;
    }
};

/// Wire format. Anthropic Messages and other adapters extend this enum in
/// their own tickets; unknown values fail here rather than at request time.
pub const Protocol = enum {
    responses,
    chat_completions,

    pub fn parse(raw: []const u8) Error!Protocol {
        if (std.mem.eql(u8, raw, "responses")) return .responses;
        if (std.mem.eql(u8, raw, "chat_completions")) return .chat_completions;
        return error.UnknownProtocol;
    }
};

/// Declared billing kind (decision 25), replacing inference from auth shape.
pub const BillingKind = enum {
    metered,
    subscription,

    pub fn parse(raw: []const u8) Error!BillingKind {
        if (std.mem.eql(u8, raw, "metered")) return .metered;
        if (std.mem.eql(u8, raw, "subscription")) return .subscription;
        return error.UnknownBillingKind;
    }
};

/// One compat flag value. Compat keys stay unvalidated here: the flag
/// vocabulary belongs to the adapter tickets, so this layer only checks the
/// shape (a flat object of scalars) and merges entries field by field.
pub const CompatValue = union(enum) {
    string: []u8,
    boolean: bool,
    integer: i64,

    fn clone(self: CompatValue, alloc: Allocator) Error!CompatValue {
        return switch (self) {
            .string => |text| .{ .string = try alloc.dupe(u8, text) },
            .boolean, .integer => self,
        };
    }

    fn deinit(self: *CompatValue, alloc: Allocator) void {
        if (self.* == .string) alloc.free(self.string);
        self.* = .{ .boolean = false };
    }
};

pub const Compat = struct {
    entries: std.StringHashMapUnmanaged(CompatValue) = .empty,

    pub fn deinit(self: *Compat, alloc: Allocator) void {
        var iterator = self.entries.iterator();
        while (iterator.next()) |entry| {
            alloc.free(entry.key_ptr.*);
            entry.value_ptr.deinit(alloc);
        }
        self.entries.deinit(alloc);
        self.* = .{};
    }

    fn count(self: *const Compat) usize {
        return self.entries.count();
    }

    fn mergeFrom(self: *Compat, alloc: Allocator, incoming: *const Compat) Error!void {
        var iterator = incoming.entries.iterator();
        while (iterator.next()) |entry| {
            if (self.entries.count() >= max_compat_entries and !self.entries.contains(entry.key_ptr.*)) {
                return error.TooManyCompatEntries;
            }
            const target = try self.entries.getOrPut(alloc, entry.key_ptr.*);
            if (!target.found_existing) {
                target.key_ptr.* = try alloc.dupe(u8, entry.key_ptr.*);
                target.value_ptr.* = try entry.value_ptr.clone(alloc);
            } else {
                target.value_ptr.deinit(alloc);
                target.value_ptr.* = try entry.value_ptr.clone(alloc);
            }
        }
    }
};

/// Per-model overrides inside a connection (decision 6): protocol, base URL
/// and compat; otherwise the connection defaults apply.
pub const ModelOverride = struct {
    protocol: ?Protocol = null,
    base_url: ?[]u8 = null,
    compat: Compat = .{},

    pub fn deinit(self: *ModelOverride, alloc: Allocator) void {
        if (self.base_url) |url| alloc.free(url);
        self.compat.deinit(alloc);
        self.* = .{};
    }

    fn mergeFrom(self: *ModelOverride, alloc: Allocator, incoming: *const ModelOverride) Error!void {
        if (incoming.protocol) |protocol| self.protocol = protocol;
        if (incoming.base_url) |url| {
            const owned = try alloc.dupe(u8, url);
            if (self.base_url) |current| alloc.free(current);
            self.base_url = owned;
        }
        try self.compat.mergeFrom(alloc, &incoming.compat);
    }
};

pub const Connection = struct {
    credential: ?CredentialKind = null,
    protocol: ?Protocol = null,
    base_url: ?[]u8 = null,
    billing: ?BillingKind = null,
    compat: Compat = .{},
    models: std.StringHashMapUnmanaged(ModelOverride) = .empty,

    pub fn deinit(self: *Connection, alloc: Allocator) void {
        if (self.base_url) |url| alloc.free(url);
        self.compat.deinit(alloc);
        var iterator = self.models.iterator();
        while (iterator.next()) |entry| {
            alloc.free(entry.key_ptr.*);
            entry.value_ptr.deinit(alloc);
        }
        self.models.deinit(alloc);
        self.* = .{};
    }

    /// Field-by-field merge: every set field on `incoming` wins, every unset
    /// field keeps the existing value. This is how a user
    /// `connections.<preset>` entry overrides a preset without restating it.
    fn mergeFrom(self: *Connection, alloc: Allocator, incoming: *const Connection) Error!void {
        if (incoming.credential) |credential| self.credential = credential;
        if (incoming.protocol) |protocol| self.protocol = protocol;
        if (incoming.base_url) |url| {
            const owned = try alloc.dupe(u8, url);
            if (self.base_url) |current| alloc.free(current);
            self.base_url = owned;
        }
        if (incoming.billing) |billing| self.billing = billing;
        try self.compat.mergeFrom(alloc, &incoming.compat);
        var iterator = incoming.models.iterator();
        while (iterator.next()) |entry| {
            if (self.models.count() >= max_models_per_connection and !self.models.contains(entry.key_ptr.*)) {
                return error.TooManyModels;
            }
            const target = try self.models.getOrPut(alloc, entry.key_ptr.*);
            if (!target.found_existing) {
                target.key_ptr.* = try alloc.dupe(u8, entry.key_ptr.*);
                target.value_ptr.* = .{};
            }
            try target.value_ptr.mergeFrom(alloc, entry.value_ptr);
        }
    }
};

pub const ConnectionSet = struct {
    connections: std.StringHashMapUnmanaged(Connection) = .empty,

    pub fn deinit(self: *ConnectionSet, alloc: Allocator) void {
        var iterator = self.connections.iterator();
        while (iterator.next()) |entry| {
            alloc.free(entry.key_ptr.*);
            entry.value_ptr.deinit(alloc);
        }
        self.connections.deinit(alloc);
        self.* = .{};
    }

    pub fn get(self: *const ConnectionSet, name: []const u8) ?*const Connection {
        return self.connections.getPtr(name);
    }

    fn count(self: *const ConnectionSet) usize {
        return self.connections.count();
    }

    pub fn mergeFrom(self: *ConnectionSet, alloc: Allocator, incoming: *const ConnectionSet) Error!void {
        var iterator = incoming.connections.iterator();
        while (iterator.next()) |entry| {
            try self.mergeConnection(alloc, entry.key_ptr.*, entry.value_ptr);
        }
    }

    fn mergeConnection(self: *ConnectionSet, alloc: Allocator, name: []const u8, incoming: *const Connection) Error!void {
        if (self.connections.count() >= max_connections and !self.connections.contains(name)) {
            return error.TooManyConnections;
        }
        const target = try self.connections.getOrPut(alloc, name);
        if (!target.found_existing) {
            target.key_ptr.* = try alloc.dupe(u8, name);
            target.value_ptr.* = .{};
        }
        try target.value_ptr.mergeFrom(alloc, incoming);
    }
};

/// Names the connection and key behind an `UnknownConnectionKey` failure, so
/// settings load can report both. Owned strings; empty unless set.
pub const ParseDetail = struct {
    connection: ?[]u8 = null,
    key: ?[]u8 = null,

    pub fn deinit(self: *ParseDetail, alloc: Allocator) void {
        if (self.connection) |name| alloc.free(name);
        if (self.key) |key| alloc.free(key);
        self.* = .{};
    }

    fn set(self: *ParseDetail, alloc: Allocator, connection: []const u8, key: []const u8) Error!void {
        const owned_connection = try alloc.dupe(u8, connection);
        errdefer alloc.free(owned_connection);
        const owned_key = try alloc.dupe(u8, key);
        errdefer alloc.free(owned_key);
        if (self.connection) |name| alloc.free(name);
        if (self.key) |current| alloc.free(current);
        self.connection = owned_connection;
        self.key = owned_key;
    }

    /// Caller owns the result: `connections.<connection>.<key>`.
    pub fn settingKey(self: *const ParseDetail, alloc: Allocator) Error![]u8 {
        return std.fmt.allocPrint(
            alloc,
            "connections.{s}.{s}",
            .{ self.connection orelse "?", self.key orelse "?" },
        );
    }
};

fn checkName(name: []const u8) Error!void {
    if (name.len == 0 or name.len > max_name_bytes) return error.InvalidConnectionName;
    if (!std.unicode.utf8ValidateSlice(name)) return error.InvalidConnectionName;
}

/// Parses the value of a top-level `connections` object: names to connection
/// objects. Merges each entry over any connection already in the set, so user
/// entries layer over presets. Unknown keys fail naming the connection.
pub fn parseSetInto(
    alloc: Allocator,
    value: std.json.Value,
    set: *ConnectionSet,
    detail: ?*ParseDetail,
) Error!void {
    if (value != .object) return error.InvalidConnectionType;
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        const name = entry.key_ptr.*;
        try checkName(name);
        if (entry.value_ptr.* != .object) return error.InvalidConnectionType;
        var staged = Connection{};
        defer staged.deinit(alloc);
        try parseInto(alloc, entry.value_ptr.*, name, &staged, detail);
        try set.mergeConnection(alloc, name, &staged);
    }
}

/// Parses one connection object with the same strict keys whether the JSON
/// came from an embedded preset or user settings. Merges the parsed fields
/// over `target`, so callers layer overrides by parsing into the preset.
fn parseInto(
    alloc: Allocator,
    value: std.json.Value,
    name: []const u8,
    target: *Connection,
    detail: ?*ParseDetail,
) Error!void {
    if (value != .object) return error.InvalidConnectionType;
    var staged = Connection{};
    defer staged.deinit(alloc);
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        const key = entry.key_ptr.*;
        if (std.mem.eql(u8, key, "credential")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            staged.credential = try CredentialKind.parse(entry.value_ptr.string);
        } else if (std.mem.eql(u8, key, "protocol")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            staged.protocol = try Protocol.parse(entry.value_ptr.string);
        } else if (std.mem.eql(u8, key, "base_url")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            const url = entry.value_ptr.string;
            if (url.len == 0 or url.len > max_base_url_bytes) return error.InvalidBaseUrl;
            staged.base_url = try alloc.dupe(u8, url);
        } else if (std.mem.eql(u8, key, "billing")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            staged.billing = try BillingKind.parse(entry.value_ptr.string);
        } else if (std.mem.eql(u8, key, "compat")) {
            try parseCompatInto(alloc, entry.value_ptr.*, name, null, &staged.compat, detail);
        } else if (std.mem.eql(u8, key, "models")) {
            try parseModelsInto(alloc, entry.value_ptr.*, name, &staged, detail);
        } else {
            if (detail) |errors| try errors.set(alloc, name, key);
            return error.UnknownConnectionKey;
        }
    }
    try target.mergeFrom(alloc, &staged);
}

fn parseModelsInto(
    alloc: Allocator,
    value: std.json.Value,
    connection_name: []const u8,
    target: *Connection,
    detail: ?*ParseDetail,
) Error!void {
    if (value != .object) return error.InvalidConnectionType;
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        const model_name = entry.key_ptr.*;
        if (model_name.len == 0 or model_name.len > max_name_bytes) return error.InvalidModelName;
        if (entry.value_ptr.* != .object) return error.InvalidConnectionType;
        if (target.models.count() >= max_models_per_connection and !target.models.contains(model_name)) {
            return error.TooManyModels;
        }
        const target_entry = try target.models.getOrPut(alloc, model_name);
        if (!target_entry.found_existing) {
            target_entry.key_ptr.* = try alloc.dupe(u8, model_name);
            target_entry.value_ptr.* = .{};
        }
        try parseModelOverrideInto(alloc, entry.value_ptr.*, connection_name, model_name, target_entry.value_ptr, detail);
    }
}

fn parseModelOverrideInto(
    alloc: Allocator,
    value: std.json.Value,
    connection_name: []const u8,
    model_name: []const u8,
    target: *ModelOverride,
    detail: ?*ParseDetail,
) Error!void {
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        const key = entry.key_ptr.*;
        if (std.mem.eql(u8, key, "protocol")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            target.protocol = try Protocol.parse(entry.value_ptr.string);
        } else if (std.mem.eql(u8, key, "base_url")) {
            if (entry.value_ptr.* != .string) return error.InvalidConnectionType;
            const url = entry.value_ptr.string;
            if (url.len == 0 or url.len > max_base_url_bytes) return error.InvalidBaseUrl;
            const owned = try alloc.dupe(u8, url);
            if (target.base_url) |current| alloc.free(current);
            target.base_url = owned;
        } else if (std.mem.eql(u8, key, "compat")) {
            try parseCompatInto(alloc, entry.value_ptr.*, connection_name, model_name, &target.compat, detail);
        } else {
            if (detail) |errors| {
                const scoped = try std.fmt.allocPrint(alloc, "models.{s}.{s}", .{ model_name, key });
                defer alloc.free(scoped);
                try errors.set(alloc, connection_name, scoped);
            }
            return error.UnknownConnectionKey;
        }
    }
}

fn parseCompatInto(
    alloc: Allocator,
    value: std.json.Value,
    connection_name: []const u8,
    model_name: ?[]const u8,
    target: *Compat,
    detail: ?*ParseDetail,
) Error!void {
    if (value != .object) return error.InvalidCompat;
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        const key = entry.key_ptr.*;
        if (key.len == 0 or key.len > max_name_bytes) return error.InvalidCompat;
        const parsed: CompatValue = switch (entry.value_ptr.*) {
            .string => |text| .{ .string = try alloc.dupe(u8, text) },
            .bool => |flag| .{ .boolean = flag },
            .integer => |number| .{ .integer = number },
            else => {
                if (detail) |errors| {
                    const scoped = if (model_name) |model|
                        try std.fmt.allocPrint(alloc, "models.{s}.compat.{s}", .{ model, key })
                    else
                        try std.fmt.allocPrint(alloc, "compat.{s}", .{key});
                    defer alloc.free(scoped);
                    try errors.set(alloc, connection_name, scoped);
                }
                return error.InvalidCompat;
            },
        };
        errdefer if (parsed == .string) alloc.free(parsed.string);
        if (target.entries.count() >= max_compat_entries and !target.entries.contains(key)) {
            if (parsed == .string) alloc.free(parsed.string);
            return error.TooManyCompatEntries;
        }
        const target_entry = try target.entries.getOrPut(alloc, key);
        if (!target_entry.found_existing) {
            target_entry.key_ptr.* = try alloc.dupe(u8, key);
            target_entry.value_ptr.* = parsed;
        } else {
            target_entry.value_ptr.deinit(alloc);
            target_entry.value_ptr.* = parsed;
        }
    }
}

fn parseTestValue(alloc: Allocator, text: []const u8) !std.json.Parsed(std.json.Value) {
    return std.json.parseFromSlice(std.json.Value, alloc, text, .{});
}

test "credential protocol and billing spellings parse" {
    try std.testing.expectEqual(CredentialKind.oauth, try CredentialKind.parse("oauth"));
    try std.testing.expectEqual(CredentialKind.api_key, try CredentialKind.parse("api_key"));
    try std.testing.expectEqual(CredentialKind.env, try CredentialKind.parse("env"));
    try std.testing.expectEqual(CredentialKind.none, try CredentialKind.parse("none"));
    try std.testing.expectError(error.UnknownCredentialKind, CredentialKind.parse("token"));
    try std.testing.expectEqual(Protocol.responses, try Protocol.parse("responses"));
    try std.testing.expectEqual(Protocol.chat_completions, try Protocol.parse("chat_completions"));
    try std.testing.expectError(error.UnknownProtocol, Protocol.parse("grpc"));
    try std.testing.expectEqual(BillingKind.subscription, try BillingKind.parse("subscription"));
    try std.testing.expectEqual(BillingKind.metered, try BillingKind.parse("metered"));
    try std.testing.expectError(error.UnknownBillingKind, BillingKind.parse("free"));
}

test "full connection parses every field" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc,
        \\{"acme":{"credential":"api_key","protocol":"chat_completions","base_url":"https://acme.test/v1","billing":"metered","compat":{"service_tier":"flex","count":3,"flag":true},"models":{"fast":{"protocol":"responses"}}}}
    );
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try parseSetInto(alloc, parsed.value, &set, &detail);

    const conn = set.get("acme") orelse return error.TestExpectedConnection;
    try std.testing.expectEqual(CredentialKind.api_key, conn.credential.?);
    try std.testing.expectEqual(Protocol.chat_completions, conn.protocol.?);
    try std.testing.expectEqualStrings("https://acme.test/v1", conn.base_url.?);
    try std.testing.expectEqual(BillingKind.metered, conn.billing.?);
    try std.testing.expectEqual(@as(usize, 3), conn.compat.count());
    try std.testing.expectEqual(Protocol.responses, conn.models.get("fast").?.protocol.?);
}

test "unknown connection key fails naming the connection and key" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc, "{\"codex\":{\"base_url\":\"https://x.test\",\"bogus\":1}}");
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try std.testing.expectError(error.UnknownConnectionKey, parseSetInto(alloc, parsed.value, &set, &detail));
    try std.testing.expectEqualStrings("codex", detail.connection.?);
    try std.testing.expectEqualStrings("bogus", detail.key.?);
    const dotted = try detail.settingKey(alloc);
    defer alloc.free(dotted);
    try std.testing.expectEqualStrings("connections.codex.bogus", dotted);
}

test "unknown model entry key fails naming the model" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc, "{\"codex\":{\"models\":{\"fast\":{\"bogus\":true}}}}");
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try std.testing.expectError(error.UnknownConnectionKey, parseSetInto(alloc, parsed.value, &set, &detail));
    try std.testing.expectEqualStrings("codex", detail.connection.?);
    try std.testing.expectEqualStrings("models.fast.bogus", detail.key.?);
}

test "override setting only base_url keeps every other preset field" {
    const alloc = std.testing.allocator;
    var preset_text = try parseTestValue(alloc,
        \\{"codex":{"credential":"oauth","protocol":"responses","base_url":"https://preset.test","billing":"subscription"}}
    );
    defer preset_text.deinit();
    var override_text = try parseTestValue(alloc,
        \\{"codex":{"base_url":"http://127.0.0.1:9"}}
    );
    defer override_text.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try parseSetInto(alloc, preset_text.value, &set, &detail);
    try parseSetInto(alloc, override_text.value, &set, &detail);

    const conn = set.get("codex") orelse return error.TestExpectedConnection;
    try std.testing.expectEqualStrings("http://127.0.0.1:9", conn.base_url.?);
    try std.testing.expectEqual(CredentialKind.oauth, conn.credential.?);
    try std.testing.expectEqual(Protocol.responses, conn.protocol.?);
    try std.testing.expectEqual(BillingKind.subscription, conn.billing.?);
}

test "malformed connection shapes fail" {
    const alloc = std.testing.allocator;
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    const cases = [_][]const u8{
        "[]",
        "{\"codex\":[]}",
        "{\"codex\":{\"credential\":7}}",
        "{\"codex\":{\"credential\":\"carrier-pigeon\"}}",
        "{\"codex\":{\"protocol\":\"grpc\"}}",
        "{\"codex\":{\"billing\":\"free\"}}",
        "{\"codex\":{\"base_url\":\"\"}}",
        "{\"codex\":{\"compat\":[]}}",
        "{\"codex\":{\"compat\":{\"tier\":[]}}}",
        "{\"codex\":{\"models\":[]}}",
        "{\"codex\":{\"models\":{\"\":{\"protocol\":\"responses\"}}}}",
    };
    for (cases) |case| {
        var parsed = try parseTestValue(alloc, case);
        defer parsed.deinit();
        var set = ConnectionSet{};
        defer set.deinit(alloc);
        if (parseSetInto(alloc, parsed.value, &set, &detail)) |_| {
            return error.TestExpectedParseFailure;
        } else |_| {}
    }
}
