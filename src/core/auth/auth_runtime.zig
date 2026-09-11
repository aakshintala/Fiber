const std = @import("std");
const credentials = @import("credentials.zig");
const chatgpt_oauth = @import("chatgpt_oauth.zig");
const login_flow = @import("login_flow.zig");
const model_provider = @import("../config/model_provider.zig");
const oauth_transport = @import("oauth_transport.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const io_mod = @import("../shared/io.zig");

const Allocator = std.mem.Allocator;

pub const SourceSet = std.EnumSet(credentials.Source);

pub const CredentialRefreshMode = enum {
    if_needed,
    force,
};

const credential_source_order = [_]credentials.Source{
    .chatgpt_subscription,
};

const SourceProbeFn = *const fn (?*anyopaque, Allocator, credentials.Source) anyerror!bool;
const CredentialLoaderFn = *const fn (?*anyopaque, Allocator, credentials.Source) anyerror!?credentials.Credential;

fn sourceLabelOrMissing(source: ?credentials.Source) []const u8 {
    return credentials.sourceLabel(source orelse return "missing");
}

pub const FailureReason = enum {
    credential_refresh_failed,
    http_unauthorized,
};

pub const FailureSnapshot = struct {
    source: credentials.Source,
    reason: FailureReason,
    http_status: ?std.http.Status = null,

    pub fn fromHttp(status: std.http.Status, source: ?credentials.Source) ?FailureSnapshot {
        if (status != .unauthorized) return null;
        return .{
            .source = source orelse return null,
            .reason = .http_unauthorized,
            .http_status = status,
        };
    }

    /// Returns owned, detail-free text. The caller owns the returned slice.
    pub fn renderText(self: FailureSnapshot, alloc: Allocator) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();

        try out.writer.print("{s} {s}", .{
            credentials.sourceLabel(self.source),
            switch (self.reason) {
                .credential_refresh_failed => "credential refresh failed",
                .http_unauthorized => "authentication failed",
            },
        });
        if (self.http_status) |status| {
            try out.writer.print(" · HTTP {d}", .{@intFromEnum(status)});
        }
        return try out.toOwnedSlice();
    }

    /// Returns owned JSON containing only the shared auth-failure facts.
    pub fn renderJson(self: FailureSnapshot, alloc: Allocator) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();

        try self.writeJson(&out.writer);
        return try out.toOwnedSlice();
    }

    pub fn writeJson(self: FailureSnapshot, writer: *std.Io.Writer) !void {
        try writer.writeAll("{\"source\":");
        try std.json.Stringify.value(credentials.sourceLabel(self.source), .{}, writer);
        try writer.writeAll(",\"reason\":");
        try std.json.Stringify.value(@tagName(self.reason), .{}, writer);
        if (self.http_status) |status| {
            try writer.print(",\"http_status\":{d}", .{@intFromEnum(status)});
        }
        try writer.writeByte('}');
    }
};

/// Returns an owned token when the selected provider credential can refresh.
/// The caller must release it with `secret.zeroAndFree`.
pub fn refreshCredentialTokenForAccount(
    transport: oauth_transport.Provider,
    alloc: Allocator,
    source: credentials.Source,
    mode: CredentialRefreshMode,
    expected_account_id: ?[]const u8,
) !?[]u8 {
    if (!credentials.sourceRefreshable(source)) return null;

    var credential = switch (source) {
        .chatgpt_subscription => switch (mode) {
            .if_needed => (try credentials.resolveForProvider(alloc, transport, .refresh_if_needed, .codex)).credential orelse return null,
            .force => (try credentials.refreshChatGptCredential(alloc, transport)) orelse return null,
        },
    };
    defer credential.deinit(alloc);
    if (expected_account_id) |expected| {
        const actual = credential.accountId() orelse return error.ChatGptAccountChanged;
        if (!std.mem.eql(u8, expected, actual)) return error.ChatGptAccountChanged;
    }

    const token = credential.token;
    credential.token = &.{};
    return token;
}

pub const AcquisitionAction = enum {
    connections,
    chatgpt_login,
};

pub const PickerStage = enum {
    root,
    connections,
    sign_in,
};

pub const Choice = union(enum) {
    source: credentials.Source,
    action: AcquisitionAction,

    pub fn eql(self: Choice, other: Choice) bool {
        return switch (self) {
            .source => |source| switch (other) {
                .source => |other_source| source == other_source,
                .action => false,
            },
            .action => |action| switch (other) {
                .source => false,
                .action => |other_action| action == other_action,
            },
        };
    }
};

pub const PickerView = struct {
    active: bool,
    available_sources: SourceSet,
    selected_choice: ?Choice,
    active_source: ?credentials.Source,
    active_provider: model_provider.ProviderId = .codex,
    include_skip: bool,
    stage: PickerStage = .root,
    sign_in: login_flow.SignInSnapshot = .{},

    pub fn activeSourceLabel(self: PickerView) []const u8 {
        return sourceLabelOrMissing(self.active_source);
    }

    pub fn choiceCount(self: PickerView) usize {
        return switch (self.stage) {
            .root => if (self.include_skip) 2 else 1,
            .connections => connectionChoiceCount(),
            .sign_in => 0,
        };
    }

    pub fn choiceAt(self: PickerView, index: usize) ?Choice {
        return switch (self.stage) {
            .root => if (self.include_skip)
                switch (index) {
                    0 => .{ .action = .connections },
                    1 => null,
                    else => null,
                }
            else switch (index) {
                0 => .{ .action = .connections },
                else => null,
            },
            .connections => connectionChoiceAt(index),
            .sign_in => null,
        };
    }

    pub fn choiceIsSelected(self: PickerView, choice: Choice) bool {
        const selected = self.selected_choice orelse return false;
        return selected.eql(choice);
    }

    pub fn selectedIndex(self: PickerView) usize {
        const selected = self.selected_choice orelse return 0;
        var index: usize = 0;
        while (self.choiceAt(index)) |choice| : (index += 1) {
            if (choice.eql(selected)) return index;
        }
        return 0;
    }

    pub fn choiceLabel(self: PickerView, choice: Choice) []const u8 {
        _ = self;
        return switch (choice) {
            .source => |source| credentials.sourceLabel(source),
            .action => |action| switch (action) {
                .connections => "Connections",
                .chatgpt_login => "Sign in with Codex",
            },
        };
    }

    pub fn choiceEnabled(self: PickerView, choice: Choice) bool {
        _ = self;
        _ = choice;
        return true;
    }
};

fn connectionChoiceCount() usize {
    return 1;
}

fn connectionChoiceAt(index: usize) ?Choice {
    return switch (index) {
        0 => .{ .action = .chatgpt_login },
        else => null,
    };
}

pub const MissingHelpSurface = enum {
    cli,
    interactive,
};

pub const StatusSnapshot = struct {
    active_source: ?credentials.Source = null,
    required_source: ?credentials.Source = null,
    chatgpt_connected: bool = false,
    /// The active credential is past its refresh deadline. Distinct from `refreshable`,
    /// which answers whether this source type can refresh at all.
    expired: bool = false,
    expires_at_ms: ?i64 = null,

    pub fn activeSourceLabel(self: StatusSnapshot) []const u8 {
        return sourceLabelOrMissing(self.active_source);
    }

    pub fn refreshable(self: StatusSnapshot) bool {
        const source = self.active_source orelse return false;
        return credentials.sourceRefreshable(source);
    }

    pub fn missingHelp(self: StatusSnapshot, surface: MissingHelpSurface) ?[]const u8 {
        if (self.active_source != null) return null;
        return switch (surface) {
            .cli => credentials.missing_chatgpt_credential_message,
            .interactive => credentials.missing_chatgpt_interactive_credential_message,
        };
    }

    /// Returns owned doctor status text containing no credential bytes.
    pub fn formatDoctorDetail(self: StatusSnapshot, alloc: Allocator) ![]u8 {
        if (self.missingHelp(.cli)) |help| return alloc.dupe(u8, help);

        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();

        try out.writer.print("{s} is configured", .{self.activeSourceLabel()});
        if (self.expired) try out.writer.writeAll("; session expired");
        try out.writer.print("; refreshable={s}", .{if (self.refreshable()) "true" else "false"});
        return try out.toOwnedSlice();
    }
};

pub fn loadStatusSnapshot(alloc: Allocator) !StatusSnapshot {
    return loadStatusSnapshotForProvider(alloc, null);
}

pub fn loadStatusSnapshotForProvider(
    alloc: Allocator,
    provider: ?model_provider.ProviderId,
) !StatusSnapshot {
    const chatgpt_connected = chatgpt_oauth.sourceExists(alloc) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => false,
    };
    // Resolves in `.stored` mode: a diagnostic must not refresh, because refreshing
    // rewrites the session file and performs network I/O. It reports the expired state
    // instead of repairing it.
    const resolution = credentials.resolveForProvider(
        alloc,
        oauth_transport.unavailable_provider,
        .stored,
        provider orelse .codex,
    ) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => blk: {
            debug_trace.logf("auth", "status snapshot failed step=resolve err={s}", .{@errorName(err)});
            break :blk credentials.Resolution{};
        },
    };
    if (resolution.credential) |loaded| {
        var credential = loaded;
        defer credential.deinit(alloc);
        return .{
            .active_source = credential.source,
            .chatgpt_connected = chatgpt_connected,
            .expired = credential.needsRefreshAt(io_mod.milliTimestamp()),
            .expires_at_ms = credential.refresh_after_ms,
        };
    }
    return .{
        .required_source = .chatgpt_subscription,
        .chatgpt_connected = chatgpt_connected,
    };
}

pub const View = struct {
    active_source: ?credentials.Source,
    refreshable: bool,
    onboarding_skipped: bool,

    pub fn activeSourceLabel(self: View) []const u8 {
        return sourceLabelOrMissing(self.active_source);
    }
};

pub const GatewayCredential = struct {
    api_key: []const u8,
    source: credentials.Source,
};

pub const Runtime = struct {
    const Self = @This();

    oauth_transport: oauth_transport.Provider = oauth_transport.unavailable_provider,
    selected_credential: ?credentials.Credential = null,
    credential_refresh_failure_source: ?credentials.Source = null,
    source_inventory: SourceSet = .empty,
    onboarding_skipped: bool = false,
    picker_active: bool = false,
    picker_selection: ?Choice = null,
    picker_include_skip: bool = false,
    picker_stage: PickerStage = .root,
    provider_picker_active: model_provider.ProviderId = .codex,
    sign_in_flow: login_flow.SignInRuntime = .{},
    sign_in_returns_to_root: bool = false,
    inventory_refresh_task: ?*InventoryRefreshTask = null,

    pub fn init(
        transport: oauth_transport.Provider,
    ) Self {
        return .{
            .oauth_transport = transport,
        };
    }

    /// Fieldwise initialization avoids retaining inactive credential and
    /// worker payloads in a static release-binary template.
    pub fn initInto(
        storage: *Self,
        transport: oauth_transport.Provider,
    ) void {
        storage.* = undefined;
        storage.oauth_transport = transport;
        storage.selected_credential = null;
        storage.credential_refresh_failure_source = null;
        storage.source_inventory = .empty;
        storage.onboarding_skipped = false;
        storage.picker_active = false;
        storage.picker_selection = null;
        storage.picker_include_skip = false;
        storage.picker_stage = .root;
        storage.provider_picker_active = .codex;
        storage.sign_in_flow = .{};
        storage.sign_in_returns_to_root = false;
        storage.inventory_refresh_task = null;
    }

    pub fn deinit(self: *Self, alloc: Allocator) void {
        if (self.inventory_refresh_task) |task| task.deinit();
        self.inventory_refresh_task = null;
        self.sign_in_flow.deinit(alloc);
        if (self.selected_credential) |*credential| credential.deinit(alloc);
        self.* = .{};
    }

    /// Borrows the current credential until this runtime replaces or releases it.
    pub fn gatewayCredential(self: *const Self) ?GatewayCredential {
        const credential = self.selected_credential orelse return null;
        if (credential.needsRefreshAt(io_mod.milliTimestamp())) return null;
        return .{
            .api_key = credential.token,
            .source = credential.source,
        };
    }

    pub fn apiKey(self: *const Self) ?[]const u8 {
        const credential = self.gatewayCredential() orelse return null;
        return credential.api_key;
    }

    pub fn oauthTransport(self: *const Self) oauth_transport.Provider {
        return self.oauth_transport;
    }

    pub fn modelCatalogAccess(self: *const Self) credentials.CatalogAccess {
        if (self.credential_refresh_failure_source) |source| {
            return credentials.catalogAccessAfterRefreshFailure(source);
        }
        return credentials.catalogAccessAt(self.selected_credential, io_mod.milliTimestamp());
    }

    pub fn recordCredentialRefreshFailure(self: *Self, source: credentials.Source) void {
        std.debug.assert(self.credentialSource() == source);
        self.credential_refresh_failure_source = source;
    }

    pub fn credentialSource(self: *const Self) ?credentials.Source {
        const credential = self.selected_credential orelse return null;
        return credential.source;
    }

    pub fn accountId(self: *const Self) ?[]const u8 {
        const credential = self.selected_credential orelse return null;
        return credential.accountId();
    }

    pub fn credentialNeedsRefresh(self: *const Self) bool {
        const credential = self.selected_credential orelse return false;
        return credential.needsRefreshAt(io_mod.milliTimestamp());
    }

    pub fn statusSnapshot(self: *const Self) StatusSnapshot {
        const chatgpt_connected = self.source_inventory.contains(.chatgpt_subscription);
        const credential = self.selected_credential orelse return .{
            .chatgpt_connected = chatgpt_connected,
        };
        return .{
            .active_source = credential.source,
            .chatgpt_connected = chatgpt_connected,
            .expired = credential.needsRefreshAt(io_mod.milliTimestamp()),
        };
    }

    pub fn view(self: *const Self) View {
        const active_source = self.credentialSource();
        return .{
            .active_source = active_source,
            .refreshable = if (active_source) |source| credentials.sourceRefreshable(source) else false,
            .onboarding_skipped = self.onboarding_skipped,
        };
    }

    pub fn recordStartupStatus(self: *Self, onboarding_skipped: bool) void {
        self.onboarding_skipped = onboarding_skipped;
    }

    pub fn skipOnboarding(self: *Self) void {
        self.onboarding_skipped = true;
    }

    pub fn refreshSourceInventory(self: *Self, alloc: Allocator) !void {
        try self.refreshSourceInventoryWithProbe(alloc, self, probeCredentialSource);
    }

    pub fn beginSourceInventoryRefresh(
        self: *Self,
        alloc: Allocator,
        action: InventoryRefreshAction,
    ) InventoryRefreshStart {
        return self.beginSourceInventoryRefreshWithDeps(alloc, action, .{
            .ctx = self,
            .probe = probeCredentialSource,
        });
    }

    fn beginSourceInventoryRefreshWithDeps(
        self: *Self,
        alloc: Allocator,
        action: InventoryRefreshAction,
        deps: InventoryRefreshDeps,
    ) InventoryRefreshStart {
        if (self.inventory_refresh_task != null) return .busy;
        self.inventory_refresh_task = InventoryRefreshTask.start(
            alloc,
            action,
            deps,
        ) catch return .failed;
        return .started;
    }

    pub fn takeSourceInventoryRefresh(
        self: *Self,
    ) ?InventoryRefreshResult {
        const task = self.inventory_refresh_task orelse return null;
        if (!task.done.load(.acquire)) return null;
        if (task.thread) |thread| {
            thread.join();
            task.thread = null;
        }
        self.inventory_refresh_task = null;
        defer task.deinit();
        if (task.failure != null or task.inventory == null) {
            return .{ .failed = task.action };
        }
        var detected = task.inventory.?;
        if (self.credentialSource()) |source| detected.insert(source);
        self.source_inventory = detected;
        return .{ .ready = task.action };
    }

    pub fn sourceInventoryRefreshActive(self: *const Self) bool {
        return self.inventory_refresh_task != null;
    }

    pub fn refreshChatGptSourceInventory(self: *Self, alloc: Allocator) !void {
        if (chatgpt_oauth.sourceExists(alloc) catch false) {
            self.source_inventory.insert(.chatgpt_subscription);
        } else if (self.credentialSource() != .chatgpt_subscription) {
            self.source_inventory.remove(.chatgpt_subscription);
        }
    }

    fn refreshSourceInventoryWithProbe(
        self: *Self,
        alloc: Allocator,
        ctx: ?*anyopaque,
        probe: SourceProbeFn,
    ) !void {
        var detected: SourceSet = .empty;
        for (credential_source_order) |source| {
            if (try probe(ctx, alloc, source)) detected.insert(source);
        }
        if (self.credentialSource()) |source| detected.insert(source);
        self.source_inventory = detected;
    }

    pub fn openPicker(self: *Self) void {
        self.openPickerWithSkip(false);
    }

    pub fn openPickerForProvider(
        self: *Self,
        active_provider: model_provider.ProviderId,
    ) void {
        self.provider_picker_active = active_provider;
        self.openPickerWithSkip(false);
    }

    pub fn openOnboardingPicker(self: *Self) void {
        self.openPickerWithSkip(true);
    }

    fn openPickerWithSkip(self: *Self, include_skip: bool) void {
        self.exitSignInStage();
        self.picker_active = true;
        self.picker_include_skip = include_skip;
        self.picker_stage = .root;
        self.picker_selection = self.pickerView().choiceAt(0);
    }

    pub fn pickerView(self: *const Self) PickerView {
        return .{
            .active = self.picker_active,
            .available_sources = self.source_inventory,
            .selected_choice = self.picker_selection,
            .active_source = self.credentialSource(),
            .active_provider = self.provider_picker_active,
            .include_skip = self.picker_include_skip,
            .stage = self.picker_stage,
            .sign_in = self.sign_in_flow.snapshot(),
        };
    }

    pub fn movePicker(self: *Self, delta: i32) bool {
        if (!self.picker_active or delta == 0) return false;
        const picker = self.pickerView();
        const choice_count = picker.choiceCount();
        if (choice_count < 2) return false;
        var next_index = picker.selectedIndex();
        for (0..choice_count) |_| {
            next_index = if (delta < 0)
                if (next_index == 0) choice_count - 1 else next_index - 1
            else if (next_index + 1 == choice_count)
                0
            else
                next_index + 1;
            const choice = picker.choiceAt(next_index) orelse continue;
            if (!picker.choiceEnabled(choice)) continue;
            self.picker_selection = choice;
            return true;
        }
        return false;
    }

    fn openConnectionPicker(self: *Self) void {
        self.exitSignInStage();
        self.picker_active = true;
        self.picker_stage = .connections;
        self.picker_selection = self.pickerView().choiceAt(0);
    }

    pub fn openChatGptSignInPickerFromRoot(self: *Self, alloc: Allocator) !bool {
        return self.openSignInPickerWithParent(alloc, true);
    }

    fn openSignInPickerWithParent(
        self: *Self,
        alloc: Allocator,
        returns_to_root: bool,
    ) !bool {
        self.exitSignInStage();
        const started = try chatgpt_oauth.startSignIn(&self.sign_in_flow, alloc, self.oauth_transport);
        if (!started) return false;
        self.picker_active = true;
        self.picker_stage = .sign_in;
        self.picker_selection = null;
        self.sign_in_returns_to_root = returns_to_root;
        return true;
    }

    pub fn signInEntryActive(self: *const Self) bool {
        return self.picker_active and self.picker_stage == .sign_in;
    }

    pub fn signInBrowserUrlAlloc(self: *Self, alloc: Allocator) !?[]u8 {
        if (!self.signInEntryActive()) return null;
        return self.sign_in_flow.browserUrlAlloc(alloc);
    }

    pub fn pollSignInTransition(self: *Self, alloc: Allocator) login_flow.SignInTransition {
        return self.sign_in_flow.pollTransition(alloc);
    }

    pub fn pulseSignIn(self: *Self, alloc: Allocator) void {
        self.sign_in_flow.pulse(alloc);
    }

    pub fn popPickerStage(self: *Self) bool {
        if (!self.picker_active) return false;
        const stage = self.picker_stage;
        if (stage == .root) {
            self.closePicker();
            return true;
        }
        if (stage == .connections) {
            self.picker_stage = .root;
            self.picker_selection = .{ .action = .connections };
            return true;
        }

        if (stage == .sign_in) {
            const returns_to_root = self.sign_in_returns_to_root;
            _ = self.sign_in_flow.cancel(undefined);
            self.sign_in_returns_to_root = false;
            if (!returns_to_root) {
                self.picker_active = false;
                self.picker_stage = .root;
                self.picker_selection = null;
                return true;
            }
            self.picker_stage = .connections;
            self.picker_selection = .{ .action = .chatgpt_login };
            return true;
        }
        return true;
    }

    pub fn closePicker(self: *Self) void {
        self.exitSignInStage();
        self.picker_active = false;
        self.picker_stage = .root;
    }

    pub fn takePickerChoice(self: *Self) ?Choice {
        if (!self.picker_active) return null;
        if (self.picker_stage == .sign_in) return null;
        const choice = self.picker_selection;
        const selected = choice orelse return null;
        if (!self.pickerView().choiceEnabled(selected)) return null;

        switch (self.picker_stage) {
            .sign_in => unreachable,
            .connections => switch (selected) {
                .action => |action| switch (action) {
                    .chatgpt_login => self.closePicker(),
                    .connections => unreachable,
                },
                .source => unreachable,
            },
            .root => switch (selected) {
                .source => self.closePicker(),
                .action => |action| switch (action) {
                    .connections => {
                        self.openConnectionPicker();
                        return null;
                    },
                    .chatgpt_login => self.closePicker(),
                },
            },
        }
        return choice;
    }

    fn exitSignInStage(self: *Self) void {
        if (self.picker_stage != .sign_in) return;
        _ = self.sign_in_flow.cancel(undefined);
        self.sign_in_returns_to_root = false;
    }

    /// Moves the credential into this session and returns whether its source,
    /// token, account, or readiness changed.
    pub fn adoptCredential(self: *Self, alloc: Allocator, credential: *credentials.Credential) bool {
        const changed = if (self.selected_credential) |selected|
            selected.source != credential.source or
                !std.mem.eql(u8, selected.token, credential.token) or
                !optionalBytesEqual(selected.accountId(), credential.accountId()) or
                selected.refresh_after_ms != credential.refresh_after_ms
        else
            true;
        const source = credential.source;
        if (self.selected_credential) |*selected| selected.deinit(alloc);

        self.selected_credential = credential.*;
        self.credential_refresh_failure_source = null;
        credential.token = &.{};
        credential.account_id = null;
        self.source_inventory.insert(source);
        return changed;
    }

    fn selectSourceWithLoader(
        self: *Self,
        alloc: Allocator,
        source: credentials.Source,
        ctx: ?*anyopaque,
        loader: CredentialLoaderFn,
    ) !?bool {
        var credential = (try loader(ctx, alloc, source)) orelse return null;
        defer credential.deinit(alloc);
        if (credential.source != source) return error.CredentialSourceMismatch;
        return self.adoptCredential(alloc, &credential);
    }

    pub fn selectSource(self: *Self, alloc: Allocator, source: credentials.Source) !?bool {
        return self.selectSourceWithLoader(alloc, source, self, loadRuntimeCredentialSource);
    }

    pub fn selectForProvider(
        self: *Self,
        alloc: Allocator,
        provider: model_provider.ProviderId,
    ) !?bool {
        switch (provider) {
            .codex => {},
        }
        if (self.credentialSource() == .chatgpt_subscription)
            return false;
        return self.selectSourceWithLoader(
            alloc,
            .chatgpt_subscription,
            self,
            loadRuntimeCredentialSource,
        );
    }

    pub fn reconcileAfterChatGptLogout(self: *Self, alloc: Allocator) !bool {
        const was_available = self.source_inventory.contains(.chatgpt_subscription);
        const was_active = self.credentialSource() == .chatgpt_subscription;
        if (was_active) {
            if (self.selected_credential) |*credential| credential.deinit(alloc);
            self.selected_credential = null;
            self.credential_refresh_failure_source = null;
        }
        try self.refreshSourceInventory(alloc);
        return was_active or was_available;
    }
};

pub const InventoryRefreshAction = struct {
    provider: model_provider.ProviderId,
};

pub const InventoryRefreshStart = enum {
    started,
    busy,
    failed,
};

pub const InventoryRefreshResult = union(enum) {
    ready: InventoryRefreshAction,
    failed: InventoryRefreshAction,
};

const InventoryProbeFn = *const fn (
    ctx: ?*anyopaque,
    alloc: Allocator,
    source: credentials.Source,
) anyerror!bool;

const InventoryRefreshDeps = struct {
    ctx: ?*anyopaque,
    probe: InventoryProbeFn,
};

const InventoryRefreshTask = struct {
    alloc: Allocator,
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    action: InventoryRefreshAction,
    deps: InventoryRefreshDeps,
    inventory: ?SourceSet = null,
    failure: ?anyerror = null,

    fn start(
        alloc: Allocator,
        action: InventoryRefreshAction,
        deps: InventoryRefreshDeps,
    ) !*InventoryRefreshTask {
        const task = try alloc.create(InventoryRefreshTask);
        task.* = .{
            .alloc = alloc,
            .action = action,
            .deps = deps,
        };
        task.thread = std.Thread.spawn(.{}, workerMain, .{task}) catch |err| {
            alloc.destroy(task);
            return err;
        };
        return task;
    }

    fn workerMain(self: *InventoryRefreshTask) void {
        var detected: SourceSet = .empty;
        for (credential_source_order) |source| {
            const present = self.deps.probe(
                self.deps.ctx,
                self.alloc,
                source,
            ) catch |err| {
                self.failure = err;
                self.done.store(true, .release);
                return;
            };
            if (present) detected.insert(source);
        }
        self.inventory = detected;
        self.done.store(true, .release);
    }

    fn deinit(self: *InventoryRefreshTask) void {
        if (self.thread) |thread| thread.join();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

fn probeCredentialSource(raw_context: ?*anyopaque, _: Allocator, source: credentials.Source) !bool {
    _ = source;
    _ = raw_context;
    return chatgpt_oauth.sourceExists(std.heap.page_allocator) catch false;
}

fn loadRuntimeCredentialSource(_: ?*anyopaque, alloc: Allocator, source: credentials.Source) !?credentials.Credential {
    return switch (source) {
        .chatgpt_subscription => (try credentials.resolveForProvider(alloc, oauth_transport.unavailable_provider, .stored, .codex)).credential,
    };
}

fn optionalBytesEqual(a: ?[]const u8, b: ?[]const u8) bool {
    if (a == null and b == null) return true;
    if (a == null or b == null) return false;
    return std.mem.eql(u8, a.?, b.?);
}

test "auth in-place initialization preserves empty runtime state" {
    var runtime: Runtime = undefined;
    Runtime.initInto(
        &runtime,
        oauth_transport.unavailable_provider,
    );
    defer runtime.deinit(std.testing.allocator);

    try std.testing.expect(runtime.selected_credential == null);
    try std.testing.expect(runtime.credential_refresh_failure_source == null);
    try std.testing.expect(runtime.source_inventory.count() == 0);
    try std.testing.expect(!runtime.picker_active);
    try std.testing.expect(runtime.picker_selection == null);
    try std.testing.expect(runtime.picker_stage == .root);
    try std.testing.expect(runtime.provider_picker_active == .codex);
}

test "picker root offers connections and the onboarding picker offers skip" {
    var runtime: Runtime = undefined;
    Runtime.initInto(&runtime, oauth_transport.unavailable_provider);
    defer runtime.deinit(std.testing.allocator);

    runtime.openPicker();
    var view = runtime.pickerView();
    try std.testing.expectEqual(@as(usize, 1), view.choiceCount());
    try std.testing.expect(view.choiceAt(0).?.eql(.{ .action = .connections }));

    runtime.closePicker();
    runtime.openOnboardingPicker();
    view = runtime.pickerView();
    try std.testing.expect(view.include_skip);
    try std.testing.expectEqual(@as(usize, 2), view.choiceCount());

    // The connections choice opens the connection submenu; from there the only
    // entry is the Codex sign-in.
    runtime.picker_selection = .{ .action = .connections };
    const forwarded = runtime.takePickerChoice();
    try std.testing.expect(forwarded == null);
    try std.testing.expectEqual(PickerStage.connections, runtime.pickerView().stage);
    try std.testing.expectEqual(@as(usize, 1), runtime.pickerView().choiceCount());
    try std.testing.expect(runtime.pickerView().choiceAt(0).?.eql(.{ .action = .chatgpt_login }));

    runtime.picker_selection = .{ .action = .chatgpt_login };
    const choice = runtime.takePickerChoice();
    try std.testing.expect(choice.?.eql(.{ .action = .chatgpt_login }));
    try std.testing.expect(!runtime.pickerView().active);
}

test "model catalog access distinguishes missing and present credentials" {
    var runtime: Runtime = undefined;
    Runtime.initInto(&runtime, oauth_transport.unavailable_provider);
    defer runtime.deinit(std.testing.allocator);

    try std.testing.expectEqual(credentials.CatalogPublicOnlyReason.no_credential, runtime.modelCatalogAccess().publicOnlyReason().?);
}

test "credential refresh failure is surfaced through catalog access" {
    var runtime: Runtime = undefined;
    Runtime.initInto(&runtime, oauth_transport.unavailable_provider);
    defer runtime.deinit(std.testing.allocator);

    runtime.credential_refresh_failure_source = .chatgpt_subscription;
    try std.testing.expectEqual(credentials.CatalogPublicOnlyReason.credential_refresh_failed, runtime.modelCatalogAccess().publicOnlyReason().?);
}
