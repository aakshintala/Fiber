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
const max_input_modalities: usize = 16;

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
    InsecureCredentialTransport,
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

/// Classifies the four credential kinds (decision 12; issue #45): only
/// `none` travels without a secret. `fiber auth login` reads this to
/// report keyless connections; the transport guard below exempts `none`
/// from the plain-HTTP refusal. Per-connection header selection lands
/// with routing (#289).
pub fn requiresCredential(kind: CredentialKind) bool {
    return kind != .none;
}

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
/// and compat; otherwise the connection defaults apply. The remaining fields
/// are models.dev metadata written by scripts/generate_models_dev.py (#304)
/// and read as plain data until the routing tickets consume them.
pub const ModelOverride = struct {
    protocol: ?Protocol = null,
    base_url: ?[]u8 = null,
    compat: Compat = .{},
    context_window: ?i64 = null,
    output_limit: ?i64 = null,
    input_modalities: ?[][]u8 = null,
    reasoning: ?bool = null,
    price_input: ?f64 = null,
    price_output: ?f64 = null,
    price_cache_read: ?f64 = null,
    price_cache_write: ?f64 = null,

    pub fn deinit(self: *ModelOverride, alloc: Allocator) void {
        if (self.base_url) |url| alloc.free(url);
        self.compat.deinit(alloc);
        self.freeModalities(alloc);
        self.* = .{};
    }

    fn freeModalities(self: *ModelOverride, alloc: Allocator) void {
        if (self.input_modalities) |modalities| {
            for (modalities) |entry| alloc.free(entry);
            alloc.free(modalities);
            self.input_modalities = null;
        }
    }

    fn setModalities(self: *ModelOverride, alloc: Allocator, modalities: []const []const u8) Error!void {
        var owned = try alloc.alloc([]u8, modalities.len);
        errdefer alloc.free(owned);
        var count: usize = 0;
        errdefer for (owned[0..count]) |entry| alloc.free(entry);
        for (modalities, 0..) |entry, index| {
            owned[index] = try alloc.dupe(u8, entry);
            count = index + 1;
        }
        self.freeModalities(alloc);
        self.input_modalities = owned;
    }

    fn mergeFrom(self: *ModelOverride, alloc: Allocator, incoming: *const ModelOverride) Error!void {
        if (incoming.protocol) |protocol| self.protocol = protocol;
        if (incoming.base_url) |url| {
            const owned = try alloc.dupe(u8, url);
            if (self.base_url) |current| alloc.free(current);
            self.base_url = owned;
        }
        try self.compat.mergeFrom(alloc, &incoming.compat);
        if (incoming.context_window) |limit| self.context_window = limit;
        if (incoming.output_limit) |limit| self.output_limit = limit;
        if (incoming.input_modalities) |modalities| try self.setModalities(alloc, modalities);
        if (incoming.reasoning) |reasoning| self.reasoning = reasoning;
        if (incoming.price_input) |price| self.price_input = price;
        if (incoming.price_output) |price| self.price_output = price;
        if (incoming.price_cache_read) |price| self.price_cache_read = price;
        if (incoming.price_cache_write) |price| self.price_cache_write = price;
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

/// Resolves the base URL one request uses (decision 6): a model entry
/// override wins, otherwise the connection default applies. The transport
/// guard runs on this resolved URL, so an override cannot bypass it.
/// Returns null when neither layer sets one. Borrowed; empty model names
/// only match an entry literally named empty, which the parser rejects.
fn resolveBaseUrl(connection: *const Connection, model_name: []const u8) ?[]const u8 {
    if (connection.models.getPtr(model_name)) |override| {
        if (override.base_url) |url| return url;
    }
    return connection.base_url;
}

/// Loopback for the transport guard (decision 12, amended on #303):
/// `localhost`, `127.0.0.0/8` and `::1`. Anything else, including an empty
/// or unparseable host, is not loopback: the guard fails closed.
fn isLoopbackHost(host: []const u8) bool {
    if (host.len == 0) return false;
    const bare = if (host.len >= 2 and host[0] == '[' and host[host.len - 1] == ']')
        host[1 .. host.len - 1]
    else
        host;
    if (bare.len == 0) return false;
    if (std.ascii.eqlIgnoreCase(bare, "localhost")) return true;
    if (std.mem.eql(u8, bare, "::1")) return true;
    return isLoopbackIpv4(bare);
}

fn isLoopbackIpv4(host: []const u8) bool {
    var parts: [4][]const u8 = undefined;
    var count: usize = 0;
    var iterator = std.mem.splitScalar(u8, host, '.');
    while (iterator.next()) |part| {
        if (count >= parts.len) return false;
        parts[count] = part;
        count += 1;
    }
    if (count != parts.len) return false;
    if (!std.mem.eql(u8, parts[0], "127")) return false;
    for (parts[1..]) |part| {
        if (part.len == 0 or part.len > 3) return false;
        var value: u16 = 0;
        for (part) |byte| {
            if (byte < '0' or byte > '9') return false;
            value = value * 10 + (byte - '0');
        }
        if (value > 255) return false;
    }
    return true;
}

/// Refuses, before any network I/O, to send a keyed credential over plain
/// HTTP to a host other than loopback (decision 12). Keyless (`none`)
/// connections may use `http://` anywhere, and `https://` is unaffected.
/// Callers report the failure naming the connection; the error itself
/// carries no strings. An unparsable URL or a missing host fails closed.
pub fn checkCredentialTransport(kind: CredentialKind, base_url: []const u8) !void {
    if (kind == .none) return;
    const uri = try std.Uri.parse(base_url);
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "http")) return;
    const host_component = uri.host orelse return error.InsecureCredentialTransport;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return error.InsecureCredentialTransport;
    if (isLoopbackHost(host)) return;
    return error.InsecureCredentialTransport;
}

/// Strict-standard Chat Completions compat for a connection that sets no
/// compat flags (decision 7): exactly what pi's `openai-completions.js`
/// `detectCompat` returns with no vendor matched (pi-ai 0.85.1), so Fiber
/// never sniffs the URL to guess quirks. Declared flags layer over these
/// in the adapter ticket (#295), which owns the flag vocabulary. pi's
/// vendor-routing objects (`openRouterRouting`, `vercelGatewayRouting`,
/// `chatTemplateKwargs`, `chatTemplateArgs`) are omitted here: Fiber's
/// generic escape hatch for those knobs is `extra_body` (decision data).
const StrictStandardCompat = struct {
    supports_store: bool = true,
    supports_developer_role: bool = true,
    supports_reasoning_effort: bool = true,
    supports_usage_in_streaming: bool = true,
    supports_finish_reason: bool = true,
    max_tokens_field: []const u8 = "max_completion_tokens",
    requires_tool_result_name: bool = false,
    requires_assistant_after_tool_result: bool = false,
    requires_thinking_as_text: bool = false,
    requires_reasoning_content_on_assistant_messages: bool = false,
    thinking_format: []const u8 = "openai",
    supports_strict_mode: bool = true,
    supports_openai_grammar_tools: bool = false,
    supports_thinking_token_budget: bool = false,
    thinking_token_budget_field: ?[]const u8 = null,
    cache_control_format: ?[]const u8 = null,
    send_session_affinity_headers: bool = false,
    deferred_tools_mode: ?[]const u8 = null,
    session_affinity_format: []const u8 = "openai",
    supports_long_cache_retention: bool = true,
    zai_tool_stream: bool = false,
};

const strict_standard_compat: StrictStandardCompat = .{};

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

const PriceSlot = enum { input, output, cache_read, cache_write };

fn parsePriceKey(key: []const u8) ?PriceSlot {
    if (std.mem.eql(u8, key, "price_input")) return .input;
    if (std.mem.eql(u8, key, "price_output")) return .output;
    if (std.mem.eql(u8, key, "price_cache_read")) return .cache_read;
    if (std.mem.eql(u8, key, "price_cache_write")) return .cache_write;
    return null;
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
        } else if (std.mem.eql(u8, key, "context_window") or std.mem.eql(u8, key, "output_limit")) {
            if (entry.value_ptr.* != .integer or entry.value_ptr.integer < 0) return error.InvalidConnectionType;
            if (std.mem.eql(u8, key, "context_window")) {
                target.context_window = entry.value_ptr.integer;
            } else {
                target.output_limit = entry.value_ptr.integer;
            }
        } else if (std.mem.eql(u8, key, "input_modalities")) {
            if (entry.value_ptr.* != .array) return error.InvalidConnectionType;
            const items = entry.value_ptr.array.items;
            if (items.len > max_input_modalities) return error.InvalidConnectionType;
            var staged = std.ArrayList([]const u8).empty;
            defer staged.deinit(alloc);
            for (items) |item| {
                if (item != .string or item.string.len == 0 or item.string.len > max_name_bytes) {
                    return error.InvalidConnectionType;
                }
                try staged.append(alloc, item.string);
            }
            try target.setModalities(alloc, staged.items);
        } else if (std.mem.eql(u8, key, "reasoning")) {
            if (entry.value_ptr.* != .bool) return error.InvalidConnectionType;
            target.reasoning = entry.value_ptr.bool;
        } else if (parsePriceKey(key)) |slot| {
            const price = switch (entry.value_ptr.*) {
                .float => entry.value_ptr.float,
                .integer => @as(f64, @floatFromInt(entry.value_ptr.integer)),
                else => return error.InvalidConnectionType,
            };
            if (!std.math.isFinite(price) or price < 0) return error.InvalidConnectionType;
            switch (slot) {
                .input => target.price_input = price,
                .output => target.price_output = price,
                .cache_read => target.price_cache_read = price,
                .cache_write => target.price_cache_write = price,
            }
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

test "model metadata parses every field and merges field by field" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc, "{\"acme\":{\"models\":{\"fast\":{\"protocol\":\"responses\",\"context_window\":1000000,\"output_limit\":131072,\"input_modalities\":[\"text\",\"image\"],\"reasoning\":true,\"price_input\":0.15,\"price_output\":0.5,\"price_cache_read\":0.03,\"price_cache_write\":1}}}}");
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try parseSetInto(alloc, parsed.value, &set, &detail);

    const fast = set.get("acme").?.models.get("fast").?;
    try std.testing.expectEqual(Protocol.responses, fast.protocol.?);
    try std.testing.expectEqual(@as(i64, 1_000_000), fast.context_window.?);
    try std.testing.expectEqual(@as(i64, 131_072), fast.output_limit.?);
    try std.testing.expectEqual(@as(usize, 2), fast.input_modalities.?.len);
    try std.testing.expectEqualStrings("image", fast.input_modalities.?[1]);
    try std.testing.expectEqual(true, fast.reasoning.?);
    try std.testing.expectEqual(@as(f64, 0.15), fast.price_input.?);
    try std.testing.expectEqual(@as(f64, 0.5), fast.price_output.?);
    try std.testing.expectEqual(@as(f64, 0.03), fast.price_cache_read.?);
    try std.testing.expectEqual(@as(f64, 1), fast.price_cache_write.?);

    var override_text = try parseTestValue(alloc, "{\"acme\":{\"models\":{\"fast\":{\"output_limit\":100,\"input_modalities\":[\"text\"]}}}}");
    defer override_text.deinit();
    try parseSetInto(alloc, override_text.value, &set, &detail);
    const merged = set.get("acme").?.models.get("fast").?;
    try std.testing.expectEqual(@as(i64, 100), merged.output_limit.?);
    try std.testing.expectEqual(@as(usize, 1), merged.input_modalities.?.len);
    try std.testing.expectEqual(@as(i64, 1_000_000), merged.context_window.?);
    try std.testing.expectEqual(true, merged.reasoning.?);
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
        "{\"codex\":{\"models\":{\"fast\":{\"context_window\":\"lots\"}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"output_limit\":-1}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"input_modalities\":\"text\"}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"input_modalities\":[7]}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"reasoning\":\"yes\"}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"price_input\":\"cheap\"}}}}",
        "{\"codex\":{\"models\":{\"fast\":{\"price_output\":-0.5}}}}",
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

test "none needs no credential while keyed kinds do" {
    try std.testing.expect(!requiresCredential(.none));
    try std.testing.expect(requiresCredential(.oauth));
    try std.testing.expect(requiresCredential(.api_key));
    try std.testing.expect(requiresCredential(.env));
}

test "resolved base URL prefers the model entry override" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc,
        \\{"local":{"credential":"none","base_url":"http://127.0.0.1:11434/v1","models":{"qwen":{"base_url":"http://192.0.2.1:11434/v1"},"llama":{}}}}
    );
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try parseSetInto(alloc, parsed.value, &set, &detail);

    const local = set.get("local") orelse return error.TestExpectedConnection;
    try std.testing.expectEqualStrings("http://192.0.2.1:11434/v1", resolveBaseUrl(local, "qwen").?);
    try std.testing.expectEqualStrings("http://127.0.0.1:11434/v1", resolveBaseUrl(local, "llama").?);
    try std.testing.expectEqualStrings("http://127.0.0.1:11434/v1", resolveBaseUrl(local, "undescribed").?);

    var bare = Connection{};
    try std.testing.expect(resolveBaseUrl(&bare, "qwen") == null);
}

test "transport guard lets keyless connections use plain HTTP anywhere" {
    try checkCredentialTransport(.none, "http://192.0.2.1:11434/v1");
    try checkCredentialTransport(.none, "http://example.com/v1");
    try checkCredentialTransport(.none, "https://example.com/v1");
}

test "transport guard refuses keyed credentials over plain HTTP off loopback" {
    const kinds = [_]CredentialKind{ .oauth, .api_key, .env };
    const urls = [_][]const u8{
        "http://192.0.2.1:11434/v1",
        "http://lan-box:11434/v1",
        "http://example.com/v1",
        "HTTP://192.0.2.1/v1",
    };
    for (kinds) |kind| {
        for (urls) |url| {
            try std.testing.expectError(
                error.InsecureCredentialTransport,
                checkCredentialTransport(kind, url),
            );
        }
    }
}

test "transport guard keeps https and loopback HTTP flowing with a key" {
    const urls = [_][]const u8{
        "https://192.0.2.1/v1",
        "https://example.com/v1",
        "http://localhost:11434/v1",
        "http://LOCALHOST:11434/v1",
        "http://127.0.0.1:11434/v1",
        "http://127.0.0.2:11434/v1",
        "http://127.1.2.3:11434/v1",
        "http://127.0.0.1/v1",
        "http://[::1]:11434/v1",
    };
    for (urls) |url| {
        try checkCredentialTransport(.api_key, url);
    }
}

test "transport guard fails closed on exotic hosts" {
    const urls = [_][]const u8{
        "http://0.0.0.0:11434/v1",
        "http://localhost.:11434/v1",
        "http://127.1:11434/v1",
        "http://[::2]:11434/v1",
        "http:///v1",
    };
    for (urls) |url| {
        try std.testing.expectError(
            error.InsecureCredentialTransport,
            checkCredentialTransport(.api_key, url),
        );
    }
    try std.testing.expect(isLoopbackHost("::1"));
    try std.testing.expect(isLoopbackHost("[::1]"));
    try std.testing.expect(!isLoopbackHost(""));
    try std.testing.expect(!isLoopbackHost("example.com"));
}

test "model entry override cannot bypass the transport guard" {
    const alloc = std.testing.allocator;
    var parsed = try parseTestValue(alloc,
        \\{"local":{"credential":"api_key","base_url":"http://127.0.0.1:11434/v1","models":{"qwen":{"base_url":"http://192.0.2.1:11434/v1"}}},"keyless":{"credential":"none","base_url":"http://192.0.2.1:11434/v1"}}
    );
    defer parsed.deinit();
    var set = ConnectionSet{};
    defer set.deinit(alloc);
    var detail = ParseDetail{};
    defer detail.deinit(alloc);
    try parseSetInto(alloc, parsed.value, &set, &detail);

    const local = set.get("local") orelse return error.TestExpectedConnection;
    try std.testing.expectError(
        error.InsecureCredentialTransport,
        checkCredentialTransport(local.credential.?, resolveBaseUrl(local, "qwen").?),
    );
    try checkCredentialTransport(local.credential.?, resolveBaseUrl(local, "undescribed").?);

    const keyless = set.get("keyless") orelse return error.TestExpectedConnection;
    try checkCredentialTransport(keyless.credential.?, resolveBaseUrl(keyless, "any").?);
}

test "strict standard compat matches pi with no vendor detected" {
    const compat = strict_standard_compat;
    try std.testing.expect(compat.supports_store);
    try std.testing.expect(compat.supports_developer_role);
    try std.testing.expect(compat.supports_reasoning_effort);
    try std.testing.expect(compat.supports_usage_in_streaming);
    try std.testing.expect(compat.supports_finish_reason);
    try std.testing.expectEqualStrings("max_completion_tokens", compat.max_tokens_field);
    try std.testing.expect(!compat.requires_tool_result_name);
    try std.testing.expect(!compat.requires_assistant_after_tool_result);
    try std.testing.expect(!compat.requires_thinking_as_text);
    try std.testing.expect(!compat.requires_reasoning_content_on_assistant_messages);
    try std.testing.expectEqualStrings("openai", compat.thinking_format);
    try std.testing.expect(compat.supports_strict_mode);
    try std.testing.expect(!compat.supports_openai_grammar_tools);
    try std.testing.expect(!compat.supports_thinking_token_budget);
    try std.testing.expect(compat.thinking_token_budget_field == null);
    try std.testing.expect(compat.cache_control_format == null);
    try std.testing.expect(!compat.send_session_affinity_headers);
    try std.testing.expect(compat.deferred_tools_mode == null);
    try std.testing.expectEqualStrings("openai", compat.session_affinity_format);
    try std.testing.expect(compat.supports_long_cache_retention);
    try std.testing.expect(!compat.zai_tool_stream);
}
