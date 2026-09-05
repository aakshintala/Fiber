const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const app_lifecycle = @import("../app/app_lifecycle.zig");
const chatgpt_oauth = @import("../auth/chatgpt_oauth.zig");
const auth_runtime = @import("../auth/auth_runtime.zig");
const cli_ask = @import("cli_ask.zig");
const cli_replay = @import("cli_replay.zig");
const command_specs = @import("../slash_commands/command_specs.zig");
const collections = @import("../shared/collections.zig");
const config_runtime = @import("../config/config_runtime.zig");
const credentials = @import("../auth/credentials.zig");
const model_provider = @import("../config/model_provider.zig");
const debug_trace = @import("../shared/debug_trace.zig");
const doctor_runtime = @import("doctor_runtime.zig");
const gateway_provider = @import("../gateway/gateway_provider.zig");
const model_catalog = @import("../gateway/model_catalog.zig");
const provider_set = @import("../gateway/provider_set.zig");
const execution_process_provider = @import("../execution/process_provider.zig");
const host = @import("../hosts/host.zig");
const oauth_transport = @import("../auth/oauth_transport.zig");
const provider_catalog = @import("../auth/provider_catalog.zig");
const secret = @import("../auth/secret.zig");
const output_contracts = @import("../output/output_contracts.zig");
const permissions = @import("../permissions/permissions.zig");
const prompt_policy = @import("../config/prompt_policy.zig");
const session_store = @import("../session/session_store.zig");
const subagent_resume_admission = @import("../subagent/resume_admission.zig");
const app_session_runtime = @import("../app/app_session_runtime.zig");
const usage_report = @import("../session/usage_report.zig");
const skill_contract = @import("../skills/skill_contract.zig");
const types = @import("../shared/types.zig");
const update_target = @import("../upgrade/update_target.zig");
const test_builtin_gateway = if (builtin.is_test)
    @import("../../builtins/gateway.zig")
else
    struct {};
const context_contract = @import("../workspace/context_contract.zig");
const mode_registry = @import("../modes/mode_registry.zig");
const mcp_contract = @import("../mcp/mcp_contract.zig");
const mcp_command_provider = @import("../mcp/command_provider.zig");
const mcp_health = @import("../mcp/health.zig");
const project_config = @import("../mcp/project_config.zig");
const mcp_runtime = @import("../mcp/mcp_runtime.zig");
const text_utils = @import("../shared/text_utils.zig");
const profile_paths = @import("../shared/profile_paths.zig");
const tool_set_contract = @import("../tooling/tool_set.zig");
const workspace_access = @import("../workspace/workspace_access.zig");
const workspace_commands = @import("../workspace/workspace_commands.zig");
const usage_cli_runtime = @import("usage_cli_runtime.zig");

const Allocator = std.mem.Allocator;
const CommandCatalog = command_specs.TopLevelRegistry;
const TopLevelKind = command_specs.TopLevelKind;

pub const Command = union(enum) {
    interactive,
    help,
    ask: []const [:0]const u8,
    auth: []const [:0]const u8,
    status: []const [:0]const u8,
    permissions: []const [:0]const u8,
    mcp: []const [:0]const u8,
    models: []const [:0]const u8,
    doctor: []const [:0]const u8,
    session: []const [:0]const u8,
    sessions: []const [:0]const u8,
    resume_session: ResumeInvocation,
    usage: []const [:0]const u8,
    upgrade: []const [:0]const u8,
    debug: []const [:0]const u8,
    workspace: []const [:0]const u8,
    unknown: []const u8,
};

const ResumeInvocation = struct {
    args: []const [:0]const u8,
};

pub const upgrade_relaunch_arg = "--upgrade-relaunch";

pub const ResumeTarget = union(enum) {
    pick,
    last,
    id: []u8,

    pub fn deinit(self: *ResumeTarget, alloc: Allocator) void {
        switch (self.*) {
            .pick, .last => {},
            .id => |value| alloc.free(value),
        }
        self.* = undefined;
    }
};

pub const LaunchModifiers = struct {
    context_limit_overrides: []config_runtime.context_limits.Override = &.{},
    additional_directories: [][]u8 = &.{},
    saved_directories_suppressed: bool = false,

    pub fn deinit(self: *LaunchModifiers, alloc: Allocator) void {
        if (self.context_limit_overrides.len > 0) alloc.free(self.context_limit_overrides);
        for (self.additional_directories) |path| alloc.free(path);
        if (self.additional_directories.len > 0) alloc.free(self.additional_directories);
        self.* = .{};
    }

    pub fn hasWorkspaceModifiers(self: LaunchModifiers) bool {
        return self.additional_directories.len > 0 or self.saved_directories_suppressed;
    }
};

pub const InteractiveLaunch = struct {
    requested_resume: ?ResumeTarget = null,
    upgrade_relaunch: bool = false,
    modifiers: LaunchModifiers = .{},

    pub fn deinit(self: *InteractiveLaunch, alloc: Allocator) void {
        if (self.requested_resume) |*target| target.deinit(alloc);
        self.modifiers.deinit(alloc);
        self.* = undefined;
    }
};

pub const RunResult = union(enum) {
    interactive: InteractiveLaunch,
    handled_success,
    handled_failure,
    handled_usage_error,
    handled_exit: u8,
};

const version_usage = "usage: fiber --version\n";
const help_usage = "usage: fiber help\n";

pub const Config = struct {
    version: []const u8 = "",
    revision: []const u8 = "",
    build_channel: update_target.Channel = .stable,
    command_catalog: CommandCatalog,
    default_model: []const u8,
    default_agent_step_limit: usize,
    models_path: []const u8,
    gateway_retry_count: usize,
    gateway_provider: gateway_provider.Provider,
    provider_set: provider_set.Set,
    process_provider: execution_process_provider.Provider = execution_process_provider.unavailable_provider,
    url_opener: host.UrlOpener,
    prompt_policy: prompt_policy.Policy,
    skill_root_policy: skill_contract.RootPolicy,
    ignored_list_entries: []const []const u8,
    max_list_entries: usize,
    max_read_file_bytes: usize,
    max_read_file_lines: usize,
    max_read_file_line_len: usize,
    max_command_output_bytes: usize,
    max_tool_result_bytes: usize,
    max_history_turns: usize,
    context_registry: context_contract.Registry,
    mode_registry: mode_registry.Registry,
    tool_set: tool_set_contract.ToolSet,
    inspect_mcp_profile_config: mcp_contract.InspectProfileConfigFn,
    inspect_mcp_local_config: mcp_health.InspectLocalConfigFn =
        mcp_health.inspectLocalConfigUnavailable,
    load_mcp_runtime: mcp_runtime.LoadRuntimeFn,
    add_mcp_profile_server: mcp_command_provider.AddProfileServerFn =
        mcp_command_provider.addProfileServerUnavailable,
    remove_mcp_profile_server: mcp_command_provider.RemoveProfileServerFn =
        mcp_command_provider.removeProfileServerUnavailable,
};

const LocalSurfaceOptions = struct {
    format: output_contracts.OutputFormat = .text,
};

fn parseLoginProvider(rest: []const [:0]const u8) !?model_provider.ProviderId {
    if (rest.len == 0) return null;
    if (rest.len != 1) return error.InvalidLoginProviderArgs;
    return provider_catalog.parse(rest[0]) orelse error.InvalidLoginProviderArgs;
}

fn selectCatalogModel(
    entries: []const model_catalog.ModelCatalogEntry,
    saved: ?[]const u8,
) ?[]const u8 {
    if (saved) |candidate| {
        for (entries) |entry| {
            if (std.mem.eql(u8, entry.id, candidate)) return entry.id;
        }
    }
    return if (entries.len > 0) entries[0].id else null;
}

const UpgradeOptions = struct {
    format: output_contracts.OutputFormat = .text,
};

const SessionListOptions = struct {
    format: output_contracts.OutputFormat = .text,
    scope: session_store.SessionListScope = .current_workspace,
    limit: usize = session_store.session_list_default_limit,
    continuation: ?session_store.ResumableSessionContinuation = null,
};

const UsageOptions = struct {
    format: output_contracts.OutputFormat = .text,
    scope: usage_report.Scope = .days_30,
};

const WorkspaceOptions = struct {
    format: output_contracts.OutputFormat = .text,
    action: ?workspace_commands.Action = null,
};

const SessionDetailTarget = union(enum) {
    last,
    id: []u8,

    fn deinit(self: *SessionDetailTarget, alloc: Allocator) void {
        switch (self.*) {
            .last => {},
            .id => |value| alloc.free(value),
        }
        self.* = undefined;
    }
};

const SessionDetailOptions = struct {
    format: output_contracts.OutputFormat = .text,
    target: ?SessionDetailTarget = null,

    fn deinit(self: *SessionDetailOptions, alloc: Allocator) void {
        if (self.target) |*target| target.deinit(alloc);
        self.* = undefined;
    }
};

const SessionRecoveryOptions = struct {
    format: output_contracts.OutputFormat = .text,
    session_id: []u8,

    fn deinit(self: *SessionRecoveryOptions, alloc: Allocator) void {
        alloc.free(self.session_id);
        self.* = undefined;
    }
};

const SessionRenameOptions = struct {
    format: output_contracts.OutputFormat = .text,
    session_id: []u8,
    title: []u8,

    fn deinit(self: *SessionRenameOptions, alloc: Allocator) void {
        alloc.free(self.session_id);
        alloc.free(self.title);
        self.* = undefined;
    }
};

const SessionRemoveOptions = struct {
    format: output_contracts.OutputFormat = .text,
    session_id: []u8,

    fn deinit(self: *SessionRemoveOptions, alloc: Allocator) void {
        alloc.free(self.session_id);
        self.* = undefined;
    }
};

const SessionTitleValidator = app_session_runtime.Runtime(struct {});

fn validateSessionTitle(raw: []const u8) SessionTitleValidator.RenameError![]const u8 {
    return SessionTitleValidator.validateSessionTitle(raw);
}

const WriteFn = *const fn (?*anyopaque, []const u8) anyerror!void;
const LoadStartupStateFn = *const fn (Allocator, oauth_transport.Provider, []const u8, usize) anyerror!app_lifecycle.StartupState;
const LoadCatalogStartupStateFn = *const fn (Allocator, []const u8, usize) anyerror!app_lifecycle.StartupState;
const LoadStartupStateWithoutCredentialsFn = *const fn (Allocator, []const u8, usize) anyerror!app_lifecycle.StartupState;
const LoadStartupStatusFn = *const fn (Allocator, []const u8, usize) anyerror!app_lifecycle.StartupStatus;
const GetenvFn = *const fn (?*anyopaque, []const u8) ?[]const u8;
const EnvironMapFn = *const fn (?*anyopaque) ?*const std.process.Environ.Map;
const SelfExePathFn = *const fn (?*anyopaque, Allocator) anyerror![]u8;
const IsTtyFn = *const fn (?*anyopaque) bool;
const RunDeps = struct {
    stdout_ctx: ?*anyopaque = null,
    stderr_ctx: ?*anyopaque = null,
    stdin_ctx: ?*anyopaque = null,
    env_ctx: ?*anyopaque = null,
    self_exe_ctx: ?*anyopaque = null,
    write_stdout: WriteFn = writeRealStdout,
    write_stderr: WriteFn = writeRealStderr,
    stdin_is_tty: IsTtyFn = realStdinIsTty,
    load_startup_state: LoadStartupStateFn = app_lifecycle.loadStartupState,
    load_catalog_startup_state: LoadCatalogStartupStateFn = app_lifecycle.loadCatalogStartupState,
    load_startup_state_without_credentials: LoadStartupStateWithoutCredentialsFn = app_lifecycle.loadStartupStateWithoutCredentials,
    load_startup_status: LoadStartupStatusFn = app_lifecycle.loadStartupStatus,
    getenv: GetenvFn = getenvDefault,
    environ_map: EnvironMapFn = environMapDefault,
    self_exe_path: SelfExePathFn = selfExePathDefault,
};

const GlobalLaunchArgs = struct {
    remaining: []const [:0]const u8,
    modifiers: LaunchModifiers = .{},

    fn deinit(self: *GlobalLaunchArgs, alloc: Allocator) void {
        self.modifiers.deinit(alloc);
        self.* = undefined;
    }

    fn takeModifiers(self: *GlobalLaunchArgs) LaunchModifiers {
        const result = self.modifiers;
        self.modifiers = .{};
        return result;
    }
};

fn parseGlobalLaunchArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !GlobalLaunchArgs {
    var overrides: std.ArrayList(config_runtime.context_limits.Override) = .empty;
    errdefer overrides.deinit(alloc);
    var directories: std.ArrayList([]u8) = .empty;
    errdefer {
        for (directories.items) |path| alloc.free(path);
        directories.deinit(alloc);
    }
    var suppress_saved = false;

    var index: usize = 0;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--context-limit")) {
            index += 1;
            if (index >= args.len) return error.MissingContextLimitValue;
            try overrides.append(alloc, try config_runtime.context_limits.parseOverride(args[index]));
        } else if (std.mem.startsWith(u8, arg, "--context-limit=")) {
            try overrides.append(alloc, try config_runtime.context_limits.parseOverride(arg["--context-limit=".len..]));
        } else if (std.mem.eql(u8, arg, "--add-dir")) {
            index += 1;
            if (index >= args.len or args[index].len == 0) return error.MissingAddDirectoryValue;
            try directories.append(alloc, try alloc.dupe(u8, args[index]));
        } else if (std.mem.startsWith(u8, arg, "--add-dir=")) {
            const value = arg["--add-dir=".len..];
            if (value.len == 0) return error.MissingAddDirectoryValue;
            try directories.append(alloc, try alloc.dupe(u8, value));
        } else if (std.mem.eql(u8, arg, "--no-additional-dirs")) {
            if (suppress_saved) return error.DuplicateAdditionalDirectorySuppression;
            suppress_saved = true;
        } else {
            break;
        }
        index += 1;
    }

    const override_slice = try overrides.toOwnedSlice(alloc);
    errdefer if (override_slice.len > 0) alloc.free(override_slice);
    const directory_slice = try directories.toOwnedSlice(alloc);
    return .{
        .remaining = args[index..],
        .modifiers = .{
            .context_limit_overrides = override_slice,
            .additional_directories = directory_slice,
            .saved_directories_suppressed = suppress_saved,
        },
    };
}

/// Returns the command that follows the supported global launch modifiers.
/// Startup uses this same surface to select the full runtime configuration
/// before the allocating parser runs.
pub fn commandAfterGlobalLaunchArgs(args: []const [:0]const u8) ?[]const u8 {
    const remaining = argsAfterGlobalLaunchArgs(args);
    return if (remaining.len > 0) remaining[0] else null;
}

pub fn argsAfterGlobalLaunchArgs(args: []const [:0]const u8) []const [:0]const u8 {
    var index: usize = 0;
    while (index < args.len) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--context-limit") or std.mem.eql(u8, arg, "--add-dir")) {
            index += 1;
            if (index >= args.len) return &.{};
        } else if (!std.mem.startsWith(u8, arg, "--context-limit=") and
            !std.mem.startsWith(u8, arg, "--add-dir=") and
            !std.mem.eql(u8, arg, "--no-additional-dirs"))
        {
            return args[index..];
        }
        index += 1;
    }
    return &.{};
}

pub fn parse(command_catalog: CommandCatalog, args: []const [:0]const u8) Command {
    @setRuntimeSafety(false);
    if (args.len == 0) return .interactive;

    const command = args[0];
    if (command.len == 0) return .{ .unknown = command };
    switch (command[0]) {
        '-', 'h' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .help)) return .help;
        },
        'a' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .auth)) return .{ .auth = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .ask)) return .{ .ask = args[1..] };
        },
        'c' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .@"continue")) return .{ .resume_session = .{ .args = args[1..] } };
        },
        'd' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .debug)) return .{ .debug = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .doctor)) return .{ .doctor = args[1..] };
        },
        'l' => {},
        'm' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .mcp)) return .{ .mcp = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .models)) return .{ .models = args[1..] };
        },
        'p' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .permissions)) return .{ .permissions = args[1..] };
        },
        'r' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .@"resume")) return .{ .resume_session = .{ .args = args[1..] } };
        },
        's' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .status)) return .{ .status = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .sessions)) return .{ .sessions = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .session)) {
                if (args.len > 1 and std.mem.eql(u8, args[1], "resume")) {
                    return .{ .resume_session = .{ .args = args[2..] } };
                }
                return .{ .session = args[1..] };
            }
        },
        'u' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .usage)) return .{ .usage = args[1..] };
            if (command_specs.matchesTopLevel(command_catalog, command, .upgrade)) return .{ .upgrade = args[1..] };
        },
        'w' => {
            if (command_specs.matchesTopLevel(command_catalog, command, .workspace)) return .{ .workspace = args[1..] };
        },
        else => {},
    }
    return .{ .unknown = command };
}

pub const NonInteractiveLaunch = struct {
    global_args: GlobalLaunchArgs,
    effective_args: []const [:0]const u8,
    command: Command,

    pub fn deinit(self: *NonInteractiveLaunch, alloc: Allocator) void {
        self.global_args.deinit(alloc);
        self.* = undefined;
    }
};

pub const InteractiveLaunchParseResult = union(enum) {
    interactive: InteractiveLaunch,
    noninteractive: NonInteractiveLaunch,
};

/// Parses the shared interactive launch language without dispatching commands.
/// Returned launch values own their allocations and must be deinitialized.
pub fn parseInteractiveLaunch(
    alloc: Allocator,
    args: []const [:0]const u8,
    command_catalog: CommandCatalog,
) !InteractiveLaunchParseResult {
    var global_args = try parseGlobalLaunchArgs(alloc, args);
    errdefer global_args.deinit(alloc);
    const effective_args = global_args.remaining;

    if (effective_args.len == 0) {
        return .{ .interactive = .{ .modifiers = global_args.takeModifiers() } };
    }

    const command = parse(command_catalog, effective_args);
    if (topLevelHelpRequest(command_catalog, effective_args) != null) {
        return .{ .noninteractive = .{
            .global_args = global_args,
            .effective_args = effective_args,
            .command = command,
        } };
    }
    switch (command) {
        .interactive => return .{ .interactive = .{
            .modifiers = global_args.takeModifiers(),
        } },
        .resume_session => |invocation| {
            if (command_specs.matchesTopLevel(command_catalog, effective_args[0], .@"continue") and
                invocation.args.len > 0)
            {
                return error.InvalidContinueArgs;
            }
            const resume_args = invocation.args;
            const upgrade_relaunch = resume_args.len == 2 and
                std.mem.eql(u8, resume_args[1], upgrade_relaunch_arg);
            const target_args = if (upgrade_relaunch)
                resume_args[0..1]
            else
                resume_args;
            const target = try parseResumeArgs(alloc, target_args);
            return .{ .interactive = .{
                .requested_resume = target,
                .upgrade_relaunch = upgrade_relaunch,
                .modifiers = global_args.takeModifiers(),
            } };
        },
        else => return .{ .noninteractive = .{
            .global_args = global_args,
            .effective_args = effective_args,
            .command = command,
        } },
    }
}

/// Detects `fiber <subcommand> --help` / `-h` and returns the subcommand kind so the
/// caller can render command-specific help. Top-level `fiber --help`/`fiber help` are
/// handled separately and intentionally excluded here.
fn topLevelHelpRequest(command_catalog: CommandCatalog, args: []const [:0]const u8) ?TopLevelKind {
    if (args.len < 2) return null;
    const kind = command_specs.topLevelKindFromToken(command_catalog, args[0]) orelse return null;
    if (kind == .help) return null;
    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) return kind;
    }
    return null;
}

pub fn runIfRequested(alloc: Allocator, args: []const [:0]const u8, cfg: Config) !RunResult {
    return runIfRequestedWithDeps(alloc, args, cfg, .{});
}

pub fn runNoConfigIfRequested(alloc: Allocator, args: []const [:0]const u8, version: []const u8, command_catalog: CommandCatalog) !bool {
    return runNoConfigIfRequestedWithDeps(alloc, args, version, command_catalog, .{});
}

fn runNoConfigIfRequestedWithDeps(
    alloc: Allocator,
    args: []const [:0]const u8,
    version: []const u8,
    command_catalog: CommandCatalog,
    deps: RunDeps,
) !bool {
    if (args.len != 1 or !command_specs.matchesTopLevel(command_catalog, args[0], .help)) {
        return false;
    }
    try writeTopLevelHelp(alloc, command_catalog, deps, version, .stdout);
    return true;
}

const ProviderActivationCaller = enum {
    provider_command,
    provider_login,
};

fn writeProviderActivationError(
    alloc: Allocator,
    deps: RunDeps,
    caller: ProviderActivationCaller,
    detail: []const u8,
) !void {
    const message = try std.fmt.allocPrint(
        alloc,
        "{s}: {s}\n",
        .{ if (caller == .provider_login) "fiber auth login" else "fiber provider", detail },
    );
    defer alloc.free(message);
    try writeStderr(deps, message);
}

fn activateProviderSelection(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    target: model_provider.ProviderId,
    caller: ProviderActivationCaller,
) !bool {
    _ = caller;
    _ = target;
    var resolution = try credentials.resolveForProvider(
        alloc,
        cfg.gateway_provider.oauth_transport,
        .refresh_if_needed,
        .codex,
        null,
    );
    defer if (resolution.credential) |*credential| credential.deinit(alloc);

    const credential = if (resolution.credential) |*value| value else {
        try writeProviderActivationError(alloc, deps, .provider_login, "Codex credential is unavailable");
        return false;
    };
    const catalog_provider = cfg.provider_set.select(.codex).model_catalog orelse {
        try writeProviderActivationError(alloc, deps, .provider_login, "Codex model catalog is unavailable");
        return false;
    };
    const fetch_result = model_catalog.fetchWithPublicFallback(catalog_provider, alloc, .{
        .access = credentials.catalogAccessAt(credential.*, io_mod.milliTimestamp()),
        .endpoint = cfg.models_path,
        .view = .picker,
    });
    var loaded = switch (fetch_result) {
        .loaded => |loaded| loaded,
        .failed => |failure| {
            debug_trace.logf("catalog", "provider selection catalog failed provider=codex category={s}", .{@tagName(failure.failure.category)});
            const detail = try std.fmt.allocPrint(
                alloc,
                "could not load the target model catalog ({s})",
                .{@tagName(failure.failure.category)},
            );
            defer alloc.free(detail);
            try writeProviderActivationError(alloc, deps, .provider_login, detail);
            return false;
        },
    };
    defer model_catalog.freeModelCatalog(alloc, &loaded.catalog);
    const saved_model: ?[]const u8 = null;
    const selected_model = selectCatalogModel(loaded.catalog.items, saved_model) orelse {
        try writeProviderActivationError(alloc, deps, .provider_login, "target model catalog is empty");
        return false;
    };
    var attempt = config_runtime.attemptUserPreferences(alloc, .{
        .model_preference = .{ .provider = .codex, .model = selected_model },
    });
    defer attempt.deinit(alloc);
    switch (attempt) {
        .failure => |failure| {
            debug_trace.logf("config", "provider selection persistence failed err={s}", .{@errorName(failure.err)});
            try writeProviderActivationError(alloc, deps, .provider_login, "failed to save the Codex model selection");
            return false;
        },
        .outcome => {},
    }
    return true;
}

fn runIfRequestedWithDeps(alloc: Allocator, args: []const [:0]const u8, cfg: Config, deps: RunDeps) !RunResult {
    const parsed_launch = parseInteractiveLaunch(alloc, args, cfg.command_catalog) catch |err| {
        if (err == error.InvalidResumeArgs) {
            try writeTopLevelUsage(cfg.command_catalog, deps, .@"resume");
            return .handled_usage_error;
        }
        if (err == error.InvalidContinueArgs) {
            try writeTopLevelUsage(cfg.command_catalog, deps, .@"continue");
            return .handled_usage_error;
        }
        var writer: std.Io.Writer.Allocating = .init(alloc);
        defer writer.deinit();
        if (globalLaunchErrorMessage(err)) |message| {
            try writer.writer.print("fiber: {s}\n", .{message});
        } else {
            try writer.writer.print("fiber: invalid global launch option: {s}\n", .{@errorName(err)});
        }
        try writer.writer.writeAll("usage: fiber [--context-limit NAME=BYTES|off] [--add-dir PATH]... [--no-additional-dirs] <command>\n");
        try writeStderr(deps, writer.written());
        return .handled_usage_error;
    };
    switch (parsed_launch) {
        .interactive => |launch| {
            try writeMcpProfileWarningIfPresent(alloc, cfg, deps);
            return .{ .interactive = launch };
        },
        .noninteractive => |value| {
            var noninteractive = value;
            defer noninteractive.deinit(alloc);
            return runNonInteractiveWithDeps(alloc, &noninteractive, cfg, deps);
        },
    }
}

fn runNonInteractiveWithDeps(
    alloc: Allocator,
    parsed_launch: *NonInteractiveLaunch,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    const global_args = &parsed_launch.global_args;
    const effective_args = parsed_launch.effective_args;
    const parsed_command = parsed_launch.command;

    if (global_args.modifiers.hasWorkspaceModifiers() and
        !commandSupportsWorkspaceModifiers(parsed_command))
    {
        try writeWorkspaceModifierUsage(deps);
        return .handled_usage_error;
    }

    if (isVersionFlag(effective_args[0])) {
        if (effective_args.len != 1) {
            try writeStderr(deps, version_usage);
            return .handled_usage_error;
        }
        try writeStdout(deps, cfg.version);
        try writeStdout(deps, "\n");
        return .handled_success;
    }

    if (topLevelHelpRequest(cfg.command_catalog, effective_args)) |kind| {
        const text = try command_specs.renderTopLevelCommandHelp(alloc, cfg.command_catalog, kind);
        defer alloc.free(text);
        try writeStdout(deps, text);
        return .handled_success;
    }

    switch (parsed_command) {
        .interactive, .resume_session => unreachable,
        .help => {
            if (effective_args.len != 1) {
                try writeStderr(deps, help_usage);
                return .handled_usage_error;
            }
            try writeTopLevelHelp(alloc, cfg.command_catalog, deps, cfg.version, .stdout);
            return .handled_success;
        },
        .ask => |rest| {
            try writeMcpProfileWarningIfPresent(alloc, cfg, deps);
            const exit_code = try cli_ask.run(alloc, rest, workflowConfigWithLaunchModifiers(cfg, global_args.modifiers), cfg.context_registry, cfg.tool_set);
            return .{ .handled_exit = exit_code };
        },
        .auth => |rest| {
            return runTopLevelAuth(alloc, rest, cfg, deps);
        },

        .status => |rest| {
            const opts = parseLocalSurfaceArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .status, output_contracts.Kind.status.jsonName(), err, rest);
                return .handled_usage_error;
            };
            var startup = try deps.load_startup_status(
                alloc,
                cfg.default_model,
                cfg.default_agent_step_limit,
            );
            defer startup.deinit(alloc);
            try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);
            var mcp_inspection = try cfg.inspect_mcp_local_config(
                alloc,
                startup.workspace_root,
            );
            defer mcp_inspection.deinit(alloc);

            var snapshot = statusSnapshotFromStartupWithBuild(startup, .{
                .channel = cfg.build_channel,
                .version = cfg.version,
                .revision = cfg.revision,
            }, mcp_inspection.profile_diagnostic);
            snapshot.mcp = localMcpView(&mcp_inspection);
            if (opts.format == .json) {
                try writeStatusJsonLine(alloc, deps, snapshot);
                return .handled_success;
            }

            const text = try snapshot.render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .permissions => |rest| {
            if (rest.len > 0 and (std.mem.eql(u8, rest[0], "mode") or std.mem.eql(u8, rest[0], "rule"))) {
                return runTopLevelPermissions(alloc, rest, cfg, deps);
            }
            const opts = parseLocalSurfaceArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .permissions, output_contracts.Kind.permissions.jsonName(), err, rest);
                return .handled_usage_error;
            };
            var startup = try deps.load_startup_state_without_credentials(alloc, cfg.default_model, cfg.default_agent_step_limit);
            defer startup.deinit(alloc);
            try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);
            const rules = try permissionRulesForSnapshot(alloc, startup.permission_rules);
            defer if (rules.rules.len > 0) alloc.free(rules.rules);

            const text = try (output_contracts.PermissionsSnapshot{
                .workspace_root = startup.workspace_root,
                .mode = permissionModeForSnapshot(startup.permission_mode),
                .grants = &.{},
                .rules = rules,
                .runtime_grants_available = false,
            }).render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .mcp => |rest| {
            return runTopLevelMcp(alloc, rest, cfg, deps);
        },
        .models => |rest| {
            const opts = parseLocalSurfaceArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .models, output_contracts.Kind.models.jsonName(), err, rest);
                return .handled_usage_error;
            };

            var startup = try deps.load_catalog_startup_state(
                alloc,
                cfg.default_model,
                cfg.default_agent_step_limit,
            );
            defer startup.deinit(alloc);
            try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

            const catalog_access = startup.modelCatalogAccess();
            const catalog_provider = cfg.provider_set.select(startup.provider).cli_model_catalog orelse {
                try writeStderr(deps, "fiber models: Codex model catalog is unavailable\n");
                return .handled_failure;
            };
            const loaded = switch (catalog_provider.fetch(alloc, .{
                .access = catalog_access,
                .endpoint = cfg.models_path,
            })) {
                .loaded => |loaded| loaded,
                .failure => |failure| {
                    const error_name = @errorName(failure.failure.asError());
                    const message = try std.fmt.allocPrint(
                        alloc,
                        "could not list models: {s}",
                        .{catalogFailureDetail(failure.failure)},
                    );
                    defer alloc.free(message);
                    if (opts.format == .json) {
                        try writeJsonCommandFailureCode(
                            alloc,
                            deps,
                            output_contracts.Kind.models.jsonName(),
                            error_name,
                            message,
                        );
                    } else {
                        try writeStderr(deps, "fiber models: ");
                        try writeStderr(deps, message);
                        try writeStderr(deps, "\n");
                    }
                    return .handled_failure;
                },
            };
            var ids = loaded.ids;
            defer collections.freeStringList(alloc, &ids);

            const text = try (output_contracts.ModelListSnapshot{
                .ids = ids.items,
                .provider = startup.provider,
                .private_models_hidden = loaded.provenance.access.private_models_may_be_hidden,
                .public_only_reason = loaded.provenance.access.public_only_reason,
            }).render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .doctor => |rest| {
            const opts = parseLocalSurfaceArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .doctor, output_contracts.Kind.doctor.jsonName(), err, rest);
                return .handled_usage_error;
            };

            const workspace_root = try io_mod.realpathAlloc(alloc, ".");
            defer alloc.free(workspace_root);
            var mcp_inspection = try cfg.inspect_mcp_local_config(
                alloc,
                workspace_root,
            );
            defer mcp_inspection.deinit(alloc);
            var snapshot = try doctor_runtime.collect(
                alloc,
                cfg.default_model,
                cfg.default_agent_step_limit,
                mcp_inspection.profile_diagnostic,
            );
            defer snapshot.deinit(alloc);

            var output_snapshot = doctorSnapshotFromRuntime(snapshot);
            output_snapshot.mcp = localMcpView(&mcp_inspection);
            if (opts.format == .json) {
                try writeDoctorJsonLine(alloc, deps, output_snapshot);
                return .handled_success;
            }

            const text = try output_snapshot.render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .session => |rest| {
            if (rest.len == 0 or
                (!std.mem.eql(u8, rest[0], "show") and
                    !std.mem.eql(u8, rest[0], "list") and
                    !std.mem.eql(u8, rest[0], "rename") and
                    !std.mem.eql(u8, rest[0], "remove") and
                    !std.mem.eql(u8, rest[0], "recover")))
            {
                try writeUsageOrJsonError(
                    alloc,
                    cfg.command_catalog,
                    deps,
                    .session,
                    output_contracts.Kind.session_show.jsonName(),
                    error.InvalidSessionDetailArgs,
                    rest,
                );
                return .handled_usage_error;
            }
            if (std.mem.eql(u8, rest[0], "recover")) {
                var recovery = parseSessionRecoveryArgs(
                    alloc,
                    rest[1..],
                ) catch |err| {
                    try writeUsageOrJsonError(
                        alloc,
                        cfg.command_catalog,
                        deps,
                        .session,
                        output_contracts.Kind.session_recover.jsonName(),
                        err,
                        rest[1..],
                    );
                    return .handled_usage_error;
                };
                defer recovery.deinit(alloc);

                const workspace_root = try io_mod.realpathAlloc(alloc, ".");
                defer alloc.free(workspace_root);
                var store = session_store.Store.init(
                    alloc,
                    workspace_root,
                ) catch |err| {
                    try writeLookupFailure(
                        alloc,
                        deps,
                        output_contracts.Kind.session_recover.jsonName(),
                        err,
                        recovery.format,
                    );
                    return .handled_failure;
                };
                defer store.deinit(alloc);
                var result = store.recoverSessionCopy(
                    alloc,
                    recovery.session_id,
                    .{},
                ) catch |err| {
                    try writeLookupFailure(
                        alloc,
                        deps,
                        output_contracts.Kind.session_recover.jsonName(),
                        err,
                        recovery.format,
                    );
                    return .handled_failure;
                };
                defer result.deinit(alloc);

                const text = try (output_contracts.SessionRecoverySnapshot{
                    .result = result,
                }).render(alloc, recovery.format);
                defer alloc.free(text);
                try writeFormattedOutput(deps, text, recovery.format);
                return if (result.status == .recovered)
                    .handled_success
                else
                    .handled_failure;
            }
            if (std.mem.eql(u8, rest[0], "show")) {
                return try executeSessionShow(alloc, cfg, deps, rest[1..]);
            }
            if (std.mem.eql(u8, rest[0], "list")) {
                return try executeSessionList(alloc, cfg, deps, rest[1..]);
            }
            if (std.mem.eql(u8, rest[0], "rename")) {
                return try executeSessionRename(alloc, cfg, deps, rest[1..]);
            }
            return try executeSessionRemove(alloc, cfg, deps, rest[1..]);
        },
        .sessions => |rest| {
            return try executeSessionList(alloc, cfg, deps, rest);
        },
        .workspace => |rest| {
            const opts = parseWorkspaceArgs(rest) catch |err| {
                try writeWorkspaceCommandError(alloc, cfg.command_catalog, deps, rest, err);
                return .handled_usage_error;
            };
            var startup = deps.load_startup_state_without_credentials(
                alloc,
                cfg.default_model,
                cfg.default_agent_step_limit,
            ) catch |err| {
                try writeWorkspaceCommandError(alloc, cfg.command_catalog, deps, rest, err);
                return .handled_failure;
            };
            defer startup.deinit(alloc);
            try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

            if (opts.action == null) {
                const snapshot = output_contracts.WorkspaceSnapshot.fromAccess(
                    startup.workspace_root,
                    &startup.workspace_access,
                );
                const text = try snapshot.render(alloc, opts.format);
                defer alloc.free(text);
                try writeFormattedOutput(deps, text, opts.format);
                return .handled_success;
            }

            var failure_phase: workspace_commands.FailurePhase = .stage;
            var result = workspace_commands.execute(
                alloc,
                startup.workspace_root,
                &startup.workspace_access,
                opts.action.?,
                &failure_phase,
            ) catch |err| {
                try writeWorkspaceCommandError(alloc, cfg.command_catalog, deps, rest, err);
                return .handled_failure;
            };
            defer result.deinit(alloc);

            switch (result) {
                .updated => |updated| {
                    var snapshot = output_contracts.WorkspaceSnapshot.fromAccess(startup.workspace_root, &updated.access);
                    snapshot.mutation = updated.mutation;
                    const text = try snapshot.render(alloc, opts.format);
                    defer alloc.free(text);
                    try writeFormattedOutput(deps, text, opts.format);
                    return .handled_success;
                },
                .indeterminate => |reconciliation| {
                    try writeWorkspaceIndeterminateError(alloc, deps, rest, reconciliation);
                    return .handled_failure;
                },
            }
        },
        .usage => |rest| {
            const opts = parseUsageArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .usage, output_contracts.Kind.usage.jsonName(), err, rest);
                return .handled_usage_error;
            };
            const home = deps.getenv(deps.env_ctx, "HOME") orelse {
                try writeUsageCommandFailure(
                    alloc,
                    deps,
                    error.HomeNotSet,
                    opts.format,
                );
                return .handled_failure;
            };
            var report = usage_cli_runtime.collect(
                alloc,
                home,
                opts.scope,
                @max(io_mod.milliTimestamp(), 0),
            ) catch |err| {
                try writeUsageCommandFailure(alloc, deps, err, opts.format);
                return .handled_failure;
            };
            defer report.deinit(alloc);
            const text = try (output_contracts.UsageSnapshot{
                .report = &report,
            }).render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .upgrade => |rest| {
            const upgrade_runtime = @import("../upgrade/upgrade_runtime.zig");
            const opts = parseUpgradeArgs(rest) catch |err| {
                try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .upgrade, output_contracts.Kind.upgrade.jsonName(), err, rest);
                return .handled_usage_error;
            };

            var startup = deps.load_startup_state_without_credentials(
                alloc,
                cfg.default_model,
                cfg.default_agent_step_limit,
            ) catch |err| {
                if (opts.format == .json) {
                    try writeJsonCommandFailure(alloc, deps, output_contracts.Kind.upgrade.jsonName(), err, "failed to load update settings");
                } else {
                    try writeStderr(deps, "fiber upgrade: failed to load update settings\n");
                }
                return .handled_failure;
            };
            defer startup.deinit(alloc);
            try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

            var result = upgrade_runtime.run(alloc, .{
                .channel = cfg.build_channel,
                .version = cfg.version,
                .revision = cfg.revision,
            }, .stable, switch (opts.format) {
                .text => .text,
                .json => .json,
            });
            defer result.deinit(alloc);
            const text = result.snapshot.render(alloc, switch (opts.format) {
                .text => .text,
                .json => .json,
            }) catch {
                try writeStderr(deps, "fiber upgrade: render failed\n");
                return .handled_failure;
            };
            defer alloc.free(text);
            try writeStdout(deps, text);
            if (opts.format == .json) try writeStdout(deps, "\n");
            return if (result.snapshot.status == .failed) .handled_failure else .handled_success;
        },
        .debug => |rest| {
            return runTopLevelDebug(alloc, rest, cfg, deps);
        },
        .unknown => |command| {
            try writeStderr(deps, "fiber: unknown subcommand: ");
            try writeStderr(deps, command);
            try writeStderr(deps, "\n\n");
            try writeTopLevelHelp(alloc, cfg.command_catalog, deps, cfg.version, .stderr);
            return error.UnknownCliCommand;
        },
    }
}

const TopLevelHelpDestination = enum { stdout, stderr };

fn writeTopLevelHelp(
    alloc: Allocator,
    command_catalog: CommandCatalog,
    deps: RunDeps,
    version: []const u8,
    destination: TopLevelHelpDestination,
) !void {
    const text = try command_specs.renderTopLevelHelp(
        alloc,
        command_catalog,
        command_specs.top_level_help_default_width,
        version,
    );
    defer alloc.free(text);
    switch (destination) {
        .stdout => try writeStdout(deps, text),
        .stderr => try writeStderr(deps, text),
    }
}

/// Routes `fiber debug replay` output through the caller's injected sinks so
/// tests capture it instead of writing to the real process streams.
const ReplayOutput = struct {
    deps: RunDeps,

    pub fn writeStdout(self: *@This(), text: []const u8) !void {
        try self.deps.write_stdout(self.deps.stdout_ctx, text);
    }

    pub fn writeStderr(self: *@This(), text: []const u8) !void {
        try self.deps.write_stderr(self.deps.stderr_ctx, text);
    }
};

fn writeStdout(deps: RunDeps, text: []const u8) !void {
    try deps.write_stdout(deps.stdout_ctx, text);
}

fn writeStderr(deps: RunDeps, text: []const u8) !void {
    try deps.write_stderr(deps.stderr_ctx, text);
}

fn writeConfigDiagnostics(
    alloc: Allocator,
    deps: RunDeps,
    diagnostics: []const config_runtime.ConfigDiagnostic,
) !void {
    for (diagnostics) |diagnostic| {
        if (!diagnostic.reportAtStartup()) continue;
        var notice_writer: std.Io.Writer.Allocating = .init(alloc);
        defer notice_writer.deinit();
        try notice_writer.writer.print(
            "fiber: config {s}: {s}",
            .{ @tagName(diagnostic.layer), @tagName(diagnostic.cause) },
        );
        try config_runtime.writeDiagnosticMetadata(&notice_writer.writer, diagnostic);
        try notice_writer.writer.writeByte('\n');
        const notice = try notice_writer.toOwnedSlice();
        defer alloc.free(notice);
        try writeStderr(deps, notice);
    }
}

fn writeFormattedOutput(deps: RunDeps, text: []const u8, format: output_contracts.OutputFormat) !void {
    switch (format) {
        .text => try writeStdout(deps, text),
        .json => try writeJsonLine(deps, text),
    }
}

fn writeJsonLine(deps: RunDeps, text: []const u8) !void {
    @setRuntimeSafety(false);
    var buf: [4096]u8 = undefined;
    if (text.len < buf.len) {
        @memcpy(buf[0..text.len], text);
        buf[text.len] = '\n';
        return writeStdout(deps, buf[0 .. text.len + 1]);
    }

    try writeStdout(deps, text);
    try writeStdout(deps, "\n");
}

const JsonLinePayload = union(enum) {
    status: output_contracts.StatusSnapshot,
    doctor: output_contracts.DoctorSnapshot,
};

fn writeRenderedJsonLine(alloc: Allocator, deps: RunDeps, fixed_buffer: []u8, payload: JsonLinePayload) !void {
    var writer: std.Io.Writer = .fixed(fixed_buffer);
    renderJsonLinePayload(&writer, payload) catch |err| switch (err) {
        error.WriteFailed => {
            var out: std.Io.Writer.Allocating = .init(alloc);
            defer out.deinit();
            try renderJsonLinePayload(&out.writer, payload);
            return writeJsonLine(deps, out.writer.buffered());
        },
    };
    try writeJsonLine(deps, writer.buffered());
}

fn renderJsonLinePayload(writer: *std.Io.Writer, payload: JsonLinePayload) std.Io.Writer.Error!void {
    switch (payload) {
        .status => |snapshot| try snapshot.writeJson(writer),
        .doctor => |snapshot| try snapshot.writeJson(writer),
    }
}

fn writeStatusJsonLine(alloc: Allocator, deps: RunDeps, snapshot: output_contracts.StatusSnapshot) !void {
    var buf: [1024]u8 = undefined;
    try writeRenderedJsonLine(alloc, deps, buf[0..], .{ .status = snapshot });
}

fn statusSnapshotFromStartup(startup: app_lifecycle.StartupStatus) output_contracts.StatusSnapshot {
    return statusSnapshotFromStartupWithBuild(startup, .{
        .channel = .stable,
        .version = "",
        .revision = "",
    }, .clear);
}

fn statusSnapshotFromStartupWithBuild(
    startup: app_lifecycle.StartupStatus,
    build: update_target.CurrentBuild,
    mcp_config_diagnostic: mcp_contract.ProfileConfigDiagnostic,
) output_contracts.StatusSnapshot {
    return .{
        .model = startup.selected_model,
        .provider = startup.provider,
        .auth = startup.auth,
        .auth_help = startup.auth.missingHelp(.cli),
        .permission_mode = permissionModeForSnapshot(startup.permission_mode),
        .workspace_root = startup.workspace_root,
        .history_turns = 0,
        .session_permission_grants = 0,
        .agent_step_limit = startup.agent_step_limit,
        .update_channel = update_target.Channel.stable.label(),
        .build_channel = build.channel.label(),
        .build_revision = build.revision,
        .mcp_config_error = switch (mcp_config_diagnostic) {
            .clear, .warning => null,
            .failed => |err| @errorName(err),
        },
        .mcp_config_warning = switch (mcp_config_diagnostic) {
            .warning => |warning| warning,
            .clear, .failed => null,
        },
    };
}

fn writeDoctorJsonLine(alloc: Allocator, deps: RunDeps, snapshot: output_contracts.DoctorSnapshot) !void {
    var buf: [4096]u8 = undefined;
    try writeRenderedJsonLine(alloc, deps, buf[0..], .{ .doctor = snapshot });
}

fn doctorSnapshotFromRuntime(snapshot: doctor_runtime.Snapshot) output_contracts.DoctorSnapshot {
    return .{
        .workspace_root = snapshot.workspace_root,
        .model = snapshot.model,
        .provider = snapshot.provider,
        .auth = snapshot.auth,
        .permission_mode = permissionModeForSnapshot(snapshot.permission_mode),
        .agent_step_limit = snapshot.agent_step_limit,
        .checks = snapshot.checks,
    };
}

fn writeRealStdout(_: ?*anyopaque, text: []const u8) !void {
    if (comptime builtin.os.tag != .windows) {
        return writeFdAll(std.posix.STDOUT_FILENO, text);
    }
    try std.Io.File.stdout().writeStreamingAll(io_mod.getIo(), text);
}

fn writeRealStderr(_: ?*anyopaque, text: []const u8) !void {
    if (comptime builtin.os.tag != .windows) {
        return writeFdAll(std.posix.STDERR_FILENO, text);
    }
    try std.Io.File.stderr().writeStreamingAll(io_mod.getIo(), text);
}

fn realStdinIsTty(_: ?*anyopaque) bool {
    return std.Io.File.stdin().isTty(io_mod.getIo()) catch false;
}

fn writeFdAll(fd: std.posix.fd_t, text: []const u8) !void {
    @setRuntimeSafety(false);
    var remaining = text;
    while (remaining.len > 0) {
        const written = std.c.write(fd, remaining.ptr, remaining.len);
        if (written <= 0) return error.WriteFailed;
        remaining = remaining[@intCast(written)..];
    }
}

fn getenvDefault(_: ?*anyopaque, key: []const u8) ?[]const u8 {
    return io_mod.getenv(key);
}

fn environMapDefault(_: ?*anyopaque) ?*const std.process.Environ.Map {
    return io_mod.environMap();
}

fn selfExePathDefault(_: ?*anyopaque, alloc: Allocator) ![]u8 {
    const path_z = try std.process.executablePathAlloc(io_mod.getIo(), alloc);
    defer alloc.free(path_z);
    return alloc.dupe(u8, path_z);
}

fn writeTopLevelUsage(command_catalog: CommandCatalog, deps: RunDeps, kind: TopLevelKind) !void {
    try writeStderr(deps, "usage: fiber ");
    try writeStderr(deps, command_specs.topLevelUsage(command_catalog, kind));
    try writeStderr(deps, "\n");
}

const McpCommandRuntime = struct {
    startup: app_lifecycle.StartupState,
    runtime: ?*mcp_runtime.McpRuntime,

    fn deinit(self: *McpCommandRuntime, alloc: Allocator) void {
        if (self.runtime) |runtime| {
            runtime.deinit();
            alloc.destroy(runtime);
        }
        self.startup.deinit(alloc);
        self.* = undefined;
    }
};

fn localMcpView(
    inspection: *const mcp_health.LocalConfigInspection,
) output_contracts.McpLocalSnapshot {
    return .{
        .servers = inspection.snapshot.servers,
        .configuration_issues = inspection.snapshot.configuration_issues,
        .inspection_error = inspection.inspection_error,
    };
}

fn loadMcpCommandRuntime(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
) !McpCommandRuntime {
    var startup = try deps.load_startup_state_without_credentials(
        alloc,
        cfg.default_model,
        cfg.default_agent_step_limit,
    );
    errdefer startup.deinit(alloc);
    const runtime = try cfg.load_mcp_runtime(
        alloc,
        startup.workspace_root,
        .{ .form = true, .url = true },
    );
    return .{ .startup = startup, .runtime = runtime };
}

const AuthSurfaceOptions = struct {
    format: output_contracts.OutputFormat = .text,
    provider: ?model_provider.ProviderId = null,
};

fn parseAuthSurfaceArgs(args: []const [:0]const u8) !AuthSurfaceOptions {
    var options: AuthSurfaceOptions = .{};
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (options.provider != null) return error.InvalidAuthArgs;
        options.provider = provider_catalog.parse(arg) orelse return error.InvalidAuthArgs;
    }
    return options;
}

fn parseAuthListArgs(args: []const [:0]const u8) !output_contracts.OutputFormat {
    if (args.len == 0) return .text;
    if (args.len == 1 and std.mem.eql(u8, args[0], "--json")) return .json;
    return error.InvalidAuthArgs;
}

fn providerConnected(alloc: Allocator, provider: model_provider.ProviderId) !bool {
    return switch (provider) {
        .codex => chatgpt_oauth.sourceExists(alloc) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => false,
        },
    };
}

fn loadConfiguredAuthProvider(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
) !model_provider.ProviderId {
    var startup = try deps.load_startup_state_without_credentials(
        alloc,
        cfg.default_model,
        cfg.default_agent_step_limit,
    );
    defer startup.deinit(alloc);
    return startup.provider;
}

fn defaultAuthProvider(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
) !model_provider.ProviderId {
    if (provider_catalog.entries.len == 1) return provider_catalog.entries[0].id;
    return loadConfiguredAuthProvider(alloc, cfg, deps);
}

fn resolveAuthProvider(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    maybe_provider: ?model_provider.ProviderId,
) !model_provider.ProviderId {
    if (maybe_provider) |provider| return provider;
    return defaultAuthProvider(alloc, cfg, deps);
}

fn writeSupportedAuthProviders(deps: RunDeps) !void {
    try writeStderr(deps, "Supported providers:\n");
    for (&provider_catalog.entries) |*entry| {
        try writeStderr(deps, "  ");
        try writeStderr(deps, entry.slug);
        try writeStderr(deps, " — ");
        try writeStderr(deps, entry.name);
        try writeStderr(deps, "\n");
    }
}

fn writeAuthLoginNonInteractiveError(deps: RunDeps) !void {
    try writeStderr(deps, "fiber auth login: no provider and stdin is not a tty\n");
    try writeSupportedAuthProviders(deps);
}

fn pickAuthProviderInteractive(deps: RunDeps) !model_provider.ProviderId {
    try writeStderr(deps, "Select a provider:\n");
    for (&provider_catalog.entries, 0..) |*entry, index| {
        var line_buf: [128]u8 = undefined;
        const line = try std.fmt.bufPrint(
            &line_buf,
            "  {d}. {s} ({s})\n",
            .{ index + 1, entry.name, entry.slug },
        );
        try writeStderr(deps, line);
    }
    try writeStderr(deps, "Enter number: ");

    var read_buffer: [256]u8 = undefined;
    var reader = std.Io.File.stdin().reader(io_mod.getIo(), &read_buffer);
    const line = reader.takeDelimiter('\n') catch |err| switch (err) {
        error.StreamTooLong, error.EndOfStream => return error.InvalidAuthProviderSelection,
    };
    const trimmed = std.mem.trim(u8, line, " \t\r\n");
    const selected = std.fmt.parseInt(usize, trimmed, 10) catch return error.InvalidAuthProviderSelection;
    if (selected == 0 or selected > provider_catalog.entries.len) return error.InvalidAuthProviderSelection;
    return provider_catalog.entries[selected - 1].id;
}

fn resolveAuthLoginProvider(
    deps: RunDeps,
    maybe_provider: ?model_provider.ProviderId,
) !model_provider.ProviderId {
    if (maybe_provider) |provider| return provider;
    // Only ambiguous when >1 provider exists: a single provider proceeds
    // unconditionally, tty or not, matching today's `fiber login` behavior
    // (no tty check at all) for the one case that's actually reachable.
    if (provider_catalog.entries.len == 1) return provider_catalog.entries[0].id;
    if (!deps.stdin_is_tty(deps.stdin_ctx)) return error.ProviderRequiredNonInteractive;
    return pickAuthProviderInteractive(deps);
}

fn runProviderLogin(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    provider: model_provider.ProviderId,
) !RunResult {
    const provider_name = provider_catalog.find(provider).name;
    switch (provider) {
        .codex => {
            chatgpt_oauth.runLogin(
                alloc,
                cfg.gateway_provider.oauth_transport,
                cfg.url_opener,
            ) catch |err| {
                const message = switch (err) {
                    error.ChatGptLoginTimedOut => "fiber auth login: Codex authorization expired; run fiber auth login codex again\n",
                    error.ChatGptAuthorizationFailed => "fiber auth login: Codex authorization denied\n",
                    else => "fiber auth login: failed to sign in with Codex\n",
                };
                try writeStderr(deps, message);
                return .handled_failure;
            };
        },
    }
    if (!try activateProviderSelection(alloc, cfg, deps, provider, .provider_login)) {
        return .handled_failure;
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print("Signed in with {s}.\n", .{provider_name});
    try writeStdout(deps, out.written());
    return .handled_success;
}

fn runProviderLogout(
    alloc: Allocator,
    deps: RunDeps,
    provider: model_provider.ProviderId,
    format: output_contracts.OutputFormat,
) !RunResult {
    const provider_name = provider_catalog.find(provider).name;
    const outcome = switch (provider) {
        .codex => chatgpt_oauth.logout() catch {
            var message: std.Io.Writer.Allocating = .init(alloc);
            defer message.deinit();
            try message.writer.print(
                "fiber auth logout: failed to durably remove saved {s} login\n",
                .{provider_name},
            );
            try writeStderr(deps, message.written());
            return .handled_failure;
        },
    };
    return switch (outcome) {
        .deleted, .missing => result: {
            const snapshot = output_contracts.AuthLogoutSnapshot{
                .provider = provider,
                .result = switch (outcome) {
                    .deleted => .deleted,
                    .missing => .missing,
                    .deleted_not_durable => unreachable,
                },
            };
            const text = try snapshot.render(alloc, format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, format);
            break :result .handled_success;
        },
        .deleted_not_durable => result: {
            var message: std.Io.Writer.Allocating = .init(alloc);
            defer message.deinit();
            try message.writer.print(
                "fiber auth logout: failed to durably remove saved {s} login\n",
                .{provider_name},
            );
            try writeStderr(deps, message.written());
            break :result .handled_failure;
        },
    };
}

fn runTopLevelAuth(
    alloc: Allocator,
    rest: []const [:0]const u8,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    if (rest.len == 0) {
        try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
        return .handled_usage_error;
    }
    const operation = rest[0];
    if (std.mem.eql(u8, operation, "list")) {
        const format = parseAuthListArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .auth, output_contracts.Kind.auth_list.jsonName(), err, rest[1..]);
            return .handled_usage_error;
        };
        var entries: [provider_catalog.entries.len]output_contracts.AuthListEntry = undefined;
        var count: usize = 0;
        for (&provider_catalog.entries) |*entry| {
            entries[count] = .{
                .id = entry.slug,
                .name = entry.name,
                .connected = try providerConnected(alloc, entry.id),
            };
            count += 1;
        }
        const text = try (output_contracts.AuthListSnapshot{
            .providers = entries[0..count],
        }).render(alloc, format);
        defer alloc.free(text);
        try writeFormattedOutput(deps, text, format);
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "status")) {
        const opts = parseAuthSurfaceArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .auth, output_contracts.Kind.auth_status.jsonName(), err, rest[1..]);
            return .handled_usage_error;
        };
        const provider = resolveAuthProvider(alloc, cfg, deps, opts.provider) catch {
            try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
            return .handled_usage_error;
        };
        const status = try auth_runtime.loadStatusSnapshotForProvider(alloc, provider, null);
        const text = try (output_contracts.AuthStatusSnapshot{
            .provider = provider,
            .status = status,
        }).render(alloc, opts.format);
        defer alloc.free(text);
        try writeFormattedOutput(deps, text, opts.format);
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "login")) {
        if (argsContainJson(rest[1..])) {
            try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
            return .handled_usage_error;
        }
        const maybe_provider = parseLoginProvider(rest[1..]) catch {
            try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
            return .handled_usage_error;
        };
        const provider = resolveAuthLoginProvider(deps, maybe_provider) catch |err| {
            if (err == error.ProviderRequiredNonInteractive) {
                try writeAuthLoginNonInteractiveError(deps);
            } else {
                try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
            }
            return .handled_usage_error;
        };
        return runProviderLogin(alloc, cfg, deps, provider);
    }
    if (std.mem.eql(u8, operation, "logout")) {
        const opts = parseAuthSurfaceArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(alloc, cfg.command_catalog, deps, .auth, output_contracts.Kind.auth_logout.jsonName(), err, rest[1..]);
            return .handled_usage_error;
        };
        const provider = resolveAuthProvider(alloc, cfg, deps, opts.provider) catch {
            try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
            return .handled_usage_error;
        };
        return runProviderLogout(alloc, deps, provider, opts.format);
    }

    try writeTopLevelUsage(cfg.command_catalog, deps, .auth);
    return .handled_usage_error;
}

fn runTopLevelDebug(
    alloc: Allocator,
    rest: []const [:0]const u8,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    if (rest.len == 0) {
        try writeTopLevelUsage(cfg.command_catalog, deps, .debug);
        return .handled_usage_error;
    }
    const operation = rest[0];
    if (std.mem.eql(u8, operation, "replay")) {
        var output: ReplayOutput = .{ .deps = deps };
        const exit_code = try cli_replay.runWithOutput(alloc, rest[1..], &output);
        return .{ .handled_exit = exit_code };
    }

    try writeTopLevelUsage(cfg.command_catalog, deps, .debug);
    return .handled_usage_error;
}

fn runTopLevelPermissions(
    alloc: Allocator,
    rest: []const [:0]const u8,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    if (rest.len == 0) {
        try writeTopLevelUsage(cfg.command_catalog, deps, .permissions);
        return .handled_usage_error;
    }
    const operation = rest[0];
    if (std.mem.eql(u8, operation, "mode")) {
        const parsed = parsePermissionsModeArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(
                alloc,
                cfg.command_catalog,
                deps,
                .permissions,
                output_contracts.Kind.permissions_mode.jsonName(),
                err,
                rest[1..],
            );
            return .handled_usage_error;
        };
        var outcome = config_runtime.setUserPreferences(alloc, .{ .permission_mode = parsed.mode }) catch |err| {
            try writePermissionsModeFailure(alloc, deps, parsed.format, err);
            return .handled_failure;
        };
        defer outcome.deinit(alloc);
        const text = try (output_contracts.PermissionsModeSnapshot{
            .mode = parsed.mode,
        }).render(alloc, parsed.format);
        defer alloc.free(text);
        try writeFormattedOutput(deps, text, parsed.format);
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "rule")) {
        return runPermissionsRule(alloc, rest[1..], cfg, deps);
    }

    try writeTopLevelUsage(cfg.command_catalog, deps, .permissions);
    return .handled_usage_error;
}

fn runPermissionsRule(
    alloc: Allocator,
    rest: []const [:0]const u8,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    if (rest.len == 0) {
        try writeTopLevelUsage(cfg.command_catalog, deps, .permissions);
        return .handled_usage_error;
    }
    const operation = rest[0];
    if (std.mem.eql(u8, operation, "list")) {
        const format = parsePermissionsRuleListArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(
                alloc,
                cfg.command_catalog,
                deps,
                .permissions,
                output_contracts.Kind.permissions_rule_list.jsonName(),
                err,
                rest[1..],
            );
            return .handled_usage_error;
        };
        var startup = try deps.load_startup_state_without_credentials(alloc, cfg.default_model, cfg.default_agent_step_limit);
        defer startup.deinit(alloc);
        try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

        var detailed = try config_runtime.loadMergedSettingsDetailed(alloc, startup.workspace_root);
        defer detailed.deinit(alloc);
        const entries = try permissionRuleListEntriesFromSources(alloc, detailed.permission_sources);
        defer if (entries.len > 0) alloc.free(entries);

        const text = try (output_contracts.PermissionsRuleListSnapshot{
            .rules = entries,
            .user_shadowed_by_local = detailed.permission_sources.user_shadowed_by_local,
        }).render(alloc, format);
        defer alloc.free(text);
        try writeFormattedOutput(deps, text, format);
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "add")) {
        const args = parsePermissionsRuleAddArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(
                alloc,
                cfg.command_catalog,
                deps,
                .permissions,
                output_contracts.Kind.permissions_rule_add.jsonName(),
                err,
                rest[1..],
            );
            return .handled_usage_error;
        };
        return runPermissionsRuleAdd(alloc, cfg, deps, args, rest[1..]);
    }
    if (std.mem.eql(u8, operation, "remove")) {
        const args = parsePermissionsRuleRemoveArgs(rest[1..]) catch |err| {
            try writeUsageOrJsonError(
                alloc,
                cfg.command_catalog,
                deps,
                .permissions,
                output_contracts.Kind.permissions_rule_remove.jsonName(),
                err,
                rest[1..],
            );
            return .handled_usage_error;
        };
        return runPermissionsRuleRemove(alloc, cfg, deps, args, rest[1..]);
    }

    try writeTopLevelUsage(cfg.command_catalog, deps, .permissions);
    return .handled_usage_error;
}

fn runPermissionsRuleAdd(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    args: PermissionsRuleAddArgs,
    raw_args: []const [:0]const u8,
) !RunResult {
    var canonical_pattern: ?[]u8 = null;
    defer if (canonical_pattern) |pattern| alloc.free(pattern);

    const pattern = if (std.mem.eql(u8, args.permission, "web_fetch")) blk: {
        canonical_pattern = permissions.canonicalWebFetchDomainPattern(alloc, args.pattern) catch |err| {
            if (err == error.InvalidToolArguments) {
                try writeUsageOrJsonError(
                    alloc,
                    cfg.command_catalog,
                    deps,
                    .permissions,
                    output_contracts.Kind.permissions_rule_add.jsonName(),
                    error.InvalidPermissionArgs,
                    raw_args,
                );
                return .handled_usage_error;
            }
            return err;
        };
        break :blk canonical_pattern.?;
    } else args.pattern;

    var startup = try deps.load_startup_state_without_credentials(alloc, cfg.default_model, cfg.default_agent_step_limit);
    defer startup.deinit(alloc);
    try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

    const workspace_root: ?[]const u8 = if (args.scope == .local) startup.workspace_root else null;
    var outcome = config_runtime.addPermissionRule(
        alloc,
        args.scope,
        workspace_root,
        args.permission,
        pattern,
        args.action,
    ) catch |err| {
        try writePermissionsRuleMutationFailure(alloc, deps, "add", args.format, err);
        return .handled_failure;
    };
    defer outcome.deinit(alloc);

    const text = try (output_contracts.PermissionsRuleAddSnapshot{
        .scope = permissionScopeLabel(args.scope),
        .permission = args.permission,
        .pattern = pattern,
        .action = args.action,
        .changed = outcome == .committed,
    }).render(alloc, args.format);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, args.format);
    return .handled_success;
}

fn runPermissionsRuleRemove(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    args: PermissionsRuleRemoveArgs,
    raw_args: []const [:0]const u8,
) !RunResult {
    _ = raw_args;
    var startup = try deps.load_startup_state_without_credentials(alloc, cfg.default_model, cfg.default_agent_step_limit);
    defer startup.deinit(alloc);
    try writeConfigDiagnostics(alloc, deps, startup.config_diagnostics);

    const workspace_root: ?[]const u8 = if (args.scope == .local) startup.workspace_root else null;
    var outcome = config_runtime.removePermissionRule(
        alloc,
        args.scope,
        workspace_root,
        args.permission,
        args.pattern,
    ) catch |err| {
        try writePermissionsRuleMutationFailure(alloc, deps, "remove", args.format, err);
        return .handled_failure;
    };
    defer outcome.deinit(alloc);

    const text = try (output_contracts.PermissionsRuleRemoveSnapshot{
        .scope = permissionScopeLabel(args.scope),
        .permission = args.permission,
        .pattern = args.pattern,
        .removed = outcome == .committed,
    }).render(alloc, args.format);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, args.format);
    return .handled_success;
}

const PermissionsModeArgs = struct {
    mode: types.PermissionMode,
    format: output_contracts.OutputFormat = .text,
};

const PermissionsRuleAddArgs = struct {
    format: output_contracts.OutputFormat = .text,
    scope: config_runtime.PermissionScope = .local,
    permission: []const u8,
    pattern: []const u8,
    action: types.PermissionAction,
};

const PermissionsRuleRemoveArgs = struct {
    format: output_contracts.OutputFormat = .text,
    scope: config_runtime.PermissionScope = .local,
    permission: []const u8,
    pattern: []const u8,
};

fn parsePermissionsModeArgs(args: []const [:0]const u8) !PermissionsModeArgs {
    var options: PermissionsModeArgs = .{ .mode = undefined };
    var mode_seen = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (mode_seen) return error.InvalidPermissionArgs;
        mode_seen = true;
        options.mode = config_runtime.parsePermissionMode(arg) orelse return error.InvalidPermissionArgs;
    }
    if (!mode_seen) return error.InvalidPermissionArgs;
    return options;
}

fn parsePermissionsRuleListArgs(args: []const [:0]const u8) !output_contracts.OutputFormat {
    if (args.len == 0) return .text;
    if (args.len == 1 and std.mem.eql(u8, args[0], "--json")) return .json;
    return error.InvalidPermissionArgs;
}

fn parsePermissionsRuleAddArgs(args: []const [:0]const u8) !PermissionsRuleAddArgs {
    var options: PermissionsRuleAddArgs = .{
        .permission = undefined,
        .pattern = undefined,
        .action = undefined,
    };
    var permission_seen = false;
    var pattern_seen = false;
    var action_seen = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (std.mem.eql(u8, arg, "--user")) {
            options.scope = .user;
            continue;
        }
        if (!permission_seen) {
            permission_seen = true;
            options.permission = arg;
            continue;
        }
        if (!pattern_seen) {
            pattern_seen = true;
            options.pattern = arg;
            continue;
        }
        if (!action_seen) {
            action_seen = true;
            options.action = config_runtime.parsePermissionAction(arg) orelse return error.InvalidPermissionArgs;
            continue;
        }
        return error.InvalidPermissionArgs;
    }
    if (!permission_seen or !pattern_seen or !action_seen) return error.InvalidPermissionArgs;
    return options;
}

fn parsePermissionsRuleRemoveArgs(args: []const [:0]const u8) !PermissionsRuleRemoveArgs {
    var options: PermissionsRuleRemoveArgs = .{
        .permission = undefined,
        .pattern = undefined,
    };
    var permission_seen = false;
    var pattern_seen = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (std.mem.eql(u8, arg, "--user")) {
            options.scope = .user;
            continue;
        }
        if (!permission_seen) {
            permission_seen = true;
            options.permission = arg;
            continue;
        }
        if (!pattern_seen) {
            pattern_seen = true;
            options.pattern = arg;
            continue;
        }
        return error.InvalidPermissionArgs;
    }
    if (!permission_seen or !pattern_seen) return error.InvalidPermissionArgs;
    return options;
}

fn permissionScopeLabel(scope: config_runtime.PermissionScope) []const u8 {
    return switch (scope) {
        .user => "user",
        .local => "local",
    };
}

fn permissionRuleListEntriesFromSources(
    alloc: Allocator,
    sources: config_runtime.PermissionSourceViews,
) ![]output_contracts.PermissionsRuleListEntry {
    const total = sources.user.rules.len + sources.local.rules.len;
    if (total == 0) return &.{};
    const entries = try alloc.alloc(output_contracts.PermissionsRuleListEntry, total);
    var index: usize = 0;
    for (sources.user.rules) |rule| {
        entries[index] = .{
            .scope = "user",
            .permission = rule.permission,
            .pattern = rule.pattern,
            .action = rule.action,
        };
        index += 1;
    }
    for (sources.local.rules) |rule| {
        entries[index] = .{
            .scope = "local",
            .permission = rule.permission,
            .pattern = rule.pattern,
            .action = rule.action,
        };
        index += 1;
    }
    return entries;
}

fn writePermissionsModeFailure(
    alloc: Allocator,
    deps: RunDeps,
    format: output_contracts.OutputFormat,
    err: anyerror,
) !void {
    const message = "fiber permissions mode failed";
    if (format == .json) {
        try writeJsonCommandFailure(
            alloc,
            deps,
            output_contracts.Kind.permissions_mode.jsonName(),
            err,
            message,
        );
        return;
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print("{s}: {s}.\n", .{ message, @errorName(err) });
    try writeStderr(deps, out.written());
}

fn writePermissionsRuleMutationFailure(
    alloc: Allocator,
    deps: RunDeps,
    operation: []const u8,
    format: output_contracts.OutputFormat,
    err: anyerror,
) !void {
    const kind = if (std.mem.eql(u8, operation, "add"))
        output_contracts.Kind.permissions_rule_add.jsonName()
    else
        output_contracts.Kind.permissions_rule_remove.jsonName();
    const message = try std.fmt.allocPrint(alloc, "fiber permissions rule {s} failed", .{operation});
    defer alloc.free(message);
    if (format == .json) {
        try writeJsonCommandFailure(alloc, deps, kind, err, message);
        return;
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print("{s}: {s}.\n", .{ message, @errorName(err) });
    try writeStderr(deps, out.written());
}

fn runTopLevelMcp(
    alloc: Allocator,
    rest: []const [:0]const u8,
    cfg: Config,
    deps: RunDeps,
) !RunResult {
    if (rest.len == 0) {
        try writeTopLevelUsage(cfg.command_catalog, deps, .mcp);
        return .handled_usage_error;
    }
    const operation = rest[0];
    if (std.mem.eql(u8, operation, "add")) {
        var format: output_contracts.OutputFormat = .text;
        var tokens: std.ArrayList([]const u8) = .empty;
        defer tokens.deinit(alloc);
        for (rest[1..]) |token| {
            if (std.mem.eql(u8, token, "--json")) {
                format = .json;
                continue;
            }
            try tokens.append(alloc, token);
        }
        const intent = mcp_command_provider.parseAddIntent(tokens.items) catch |err| {
            if (err == error.McpAddUsage) {
                if (format == .json) {
                    try writeJsonCommandFailure(
                        alloc,
                        deps,
                        output_contracts.Kind.mcp_add.jsonName(),
                        err,
                        "fiber mcp add: invalid arguments",
                    );
                } else {
                    try writeMcpAddUsage(deps);
                }
                return .handled_usage_error;
            }
            try writeMcpOperationFailure(alloc, deps, "add", format, err);
            return .handled_failure;
        };
        var result = cfg.add_mcp_profile_server(alloc, intent) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "add", format, err);
            return .handled_failure;
        };
        defer result.deinit(alloc);
        if (result.warning) |warning| try writeMcpProfileWarning(alloc, deps, warning);
        const name = switch (intent) {
            .local => |local| local.name,
            .http => |http| http.name,
        };
        if (format == .json) {
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpAddSnapshot{
                .server = name,
                .profile_path = result.profile_path,
            });
        } else {
            try writeMcpProfileMutationSuccess(
                alloc,
                deps,
                "Saved",
                "to",
                name,
                result.profile_path,
            );
        }
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "trust")) {
        var format: output_contracts.OutputFormat = .text;
        var trust_args: std.ArrayList([:0]const u8) = .empty;
        defer trust_args.deinit(alloc);
        for (rest[1..]) |token| {
            if (std.mem.eql(u8, token, "--json")) {
                format = .json;
                continue;
            }
            try trust_args.append(alloc, token);
        }
        const action = parseTopLevelProjectMcpAction(trust_args.items) catch {
            try writeMcpUsageOrJsonError(alloc, cfg.command_catalog, deps, "trust", rest[1..]);
            return .handled_usage_error;
        };
        const workspace_root = io_mod.realpathAlloc(alloc, ".") catch |err| {
            try writeMcpOperationFailure(alloc, deps, "trust", format, err);
            return .handled_failure;
        };
        defer alloc.free(workspace_root);
        var attempt = config_runtime.attemptProjectMcpMutation(
            alloc,
            workspace_root,
            action,
        );
        defer attempt.deinit(alloc);
        switch (attempt) {
            .failure => |failure| {
                try writeMcpOperationFailure(alloc, deps, "trust", format, failure.err);
                return .handled_failure;
            },
            .outcome => {},
        }
        if (format == .json) {
            const fields = mcpTrustSnapshotFields(action);
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpTrustSnapshot{
                .workspace_root = workspace_root,
                .action = fields.action,
                .server = fields.server,
            });
        } else {
            try writeMcpTrustSuccess(alloc, deps, workspace_root, action);
        }
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "path")) {
        const format = parseMcpOptionalJsonArgs(rest[1..]) catch {
            try writeMcpUsageOrJsonError(alloc, cfg.command_catalog, deps, "path", rest[1..]);
            return .handled_usage_error;
        };
        const home = deps.getenv(deps.env_ctx, "HOME") orelse {
            try writeMcpOperationFailure(alloc, deps, "path", format, error.HomeNotSet);
            return .handled_failure;
        };
        const path = try profile_paths.mcpConfigPath(alloc, home);
        defer alloc.free(path);
        if (format == .json) {
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpPathSnapshot{ .path = path });
        } else {
            var encoded_path = try text_utils.encodeTerminalSafe(alloc, path, 512);
            defer encoded_path.deinit(alloc);
            try writeStdout(deps, encoded_path.bytes);
            try writeStdout(deps, "\n");
        }
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "remove")) {
        const parsed = parseMcpServerArgs(rest[1..]) catch {
            try writeMcpUsageOrJsonError(alloc, cfg.command_catalog, deps, "remove", rest[1..]);
            return .handled_usage_error;
        };
        var result = cfg.remove_mcp_profile_server(alloc, parsed.server) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "remove", parsed.format, err);
            return .handled_failure;
        };
        defer result.deinit(alloc);
        if (result.warning) |warning| try writeMcpProfileWarning(alloc, deps, warning);
        if (!result.removed) {
            if (parsed.format == .json) {
                const message = try std.fmt.allocPrint(
                    alloc,
                    "MCP server '{s}' was not found in the profile",
                    .{parsed.server},
                );
                defer alloc.free(message);
                try writeJsonCommandFailure(
                    alloc,
                    deps,
                    output_contracts.Kind.mcp_remove.jsonName(),
                    error.McpServerNotFound,
                    message,
                );
            } else {
                var encoded_name = try text_utils.encodeTerminalSafe(alloc, parsed.server, 160);
                defer encoded_name.deinit(alloc);
                var out: std.Io.Writer.Allocating = .init(alloc);
                defer out.deinit();
                try out.writer.print(
                    "MCP server '{s}' was not found in the profile.\n",
                    .{encoded_name.bytes},
                );
                try writeStderr(deps, out.written());
            }
            return .handled_failure;
        }
        if (parsed.format == .json) {
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpRemoveSnapshot{
                .server = parsed.server,
                .profile_path = result.profile_path,
            });
        } else {
            try writeMcpProfileMutationSuccess(
                alloc,
                deps,
                "Removed",
                "from",
                parsed.server,
                result.profile_path,
            );
        }
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "list")) {
        const format = parseMcpOptionalJsonArgs(rest[1..]) catch {
            try writeMcpUsageOrJsonError(alloc, cfg.command_catalog, deps, "list", rest[1..]);
            return .handled_usage_error;
        };
        var loaded = loadMcpCommandRuntime(alloc, cfg, deps) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "list", format, err);
            return .handled_failure;
        };
        defer loaded.deinit(alloc);
        try writeConfigDiagnostics(alloc, deps, loaded.startup.config_diagnostics);
        const listing = if (loaded.runtime) |runtime| listing: {
            try runtime.loadStoredCredentialsForHealthSnapshot();
            break :listing try runtime.listServersAndTools(alloc);
        } else try alloc.dupe(u8, "No MCP servers configured.\n");
        defer alloc.free(listing);
        if (format == .json) {
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpListSnapshot{ .listing = listing });
        } else {
            try writeStdout(deps, listing);
        }
        return .handled_success;
    }
    if (std.mem.eql(u8, operation, "login")) {
        if (argsContainJson(rest[1..])) {
            try writeTopLevelUsage(cfg.command_catalog, deps, .mcp);
            return .handled_usage_error;
        }
        if (rest.len != 2 or rest[1].len == 0) {
            try writeTopLevelUsage(cfg.command_catalog, deps, .mcp);
            return .handled_usage_error;
        }
        var loaded = loadMcpCommandRuntime(alloc, cfg, deps) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "login", .text, err);
            return .handled_failure;
        };
        defer loaded.deinit(alloc);
        try writeConfigDiagnostics(alloc, deps, loaded.startup.config_diagnostics);
        const runtime = loaded.runtime orelse {
            try writeMcpOperationFailure(alloc, deps, "login", .text, error.McpServerNotFound);
            return .handled_failure;
        };
        var opener = cfg.url_opener;
        var result = runtime.authenticateServer(
            rest[1],
            &opener,
            openTopLevelMcpUrl,
        ) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "login", .text, err);
            return .handled_failure;
        };
        defer result.deinit();
        switch (result) {
            .authenticated => |authenticated| {
                var encoded_name = try text_utils.encodeTerminalSafe(alloc, rest[1], 160);
                defer encoded_name.deinit(alloc);
                var out: std.Io.Writer.Allocating = .init(alloc);
                defer out.deinit();
                try out.writer.print("Authenticated MCP server '{s}'.", .{encoded_name.bytes});
                if (authenticated.repaired_entries > 0) {
                    try out.writer.print(
                        " Removed {d} unreadable MCP credential {s}.",
                        .{
                            authenticated.repaired_entries,
                            if (authenticated.repaired_entries == 1) "entry" else "entries",
                        },
                    );
                }
                try out.writer.writeByte('\n');
                try writeStdout(deps, out.written());
                return .handled_success;
            },
            .issuer_mismatch => {
                try writeMcpOperationFailure(
                    alloc,
                    deps,
                    "login",
                    .text,
                    error.McpAuthorizationIssuerMismatch,
                );
                return .handled_failure;
            },
        }
    }
    if (std.mem.eql(u8, operation, "logout")) {
        const parsed = parseMcpServerArgs(rest[1..]) catch {
            try writeMcpUsageOrJsonError(alloc, cfg.command_catalog, deps, "logout", rest[1..]);
            return .handled_usage_error;
        };
        var loaded = loadMcpCommandRuntime(alloc, cfg, deps) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "logout", parsed.format, err);
            return .handled_failure;
        };
        defer loaded.deinit(alloc);
        try writeConfigDiagnostics(alloc, deps, loaded.startup.config_diagnostics);
        const runtime = loaded.runtime orelse {
            try writeMcpOperationFailure(alloc, deps, "logout", parsed.format, error.McpServerNotFound);
            return .handled_failure;
        };
        const result = runtime.logoutServer(parsed.server) catch |err| {
            try writeMcpOperationFailure(alloc, deps, "logout", parsed.format, err);
            return .handled_failure;
        };
        if (parsed.format == .json) {
            try writeMcpJsonOutput(alloc, deps, output_contracts.McpLogoutSnapshot{
                .server = parsed.server,
                .result = mcpLogoutSnapshotResult(result),
            });
        } else {
            var encoded_name = try text_utils.encodeTerminalSafe(alloc, parsed.server, 160);
            defer encoded_name.deinit(alloc);
            var out: std.Io.Writer.Allocating = .init(alloc);
            defer out.deinit();
            if (!result.removed) {
                try out.writer.print(
                    "No stored MCP credentials found for '{s}'.\n",
                    .{encoded_name.bytes},
                );
            } else if (result.local_only) {
                try out.writer.print(
                    "Logged out of MCP server '{s}' locally.\n",
                    .{encoded_name.bytes},
                );
            } else if (result.revocation_failed) {
                try out.writer.print(
                    "Logged out of MCP server '{s}' locally; remote revocation failed.\n",
                    .{encoded_name.bytes},
                );
            } else {
                try out.writer.print(
                    "Logged out of MCP server '{s}'.\n",
                    .{encoded_name.bytes},
                );
            }
            try writeStdout(deps, out.written());
        }
        return .handled_success;
    }

    try writeTopLevelUsage(cfg.command_catalog, deps, .mcp);
    return .handled_usage_error;
}

fn parseTopLevelProjectMcpAction(
    args: []const [:0]const u8,
) error{InvalidProjectMcpTrustArgs}!project_config.ProjectMcpAction {
    if (args.len == 1 and std.mem.eql(u8, args[0], "approve-all")) return .approve_all;
    if (args.len == 1 and std.mem.eql(u8, args[0], "reset")) return .reset;
    if (args.len != 2 or args[1].len == 0) return error.InvalidProjectMcpTrustArgs;
    if (std.mem.eql(u8, args[0], "approve")) return .{ .approve = args[1] };
    if (std.mem.eql(u8, args[0], "reject")) return .{ .reject = args[1] };
    return error.InvalidProjectMcpTrustArgs;
}

fn writeMcpTrustSuccess(
    alloc: Allocator,
    deps: RunDeps,
    workspace_root: []const u8,
    action: project_config.ProjectMcpAction,
) !void {
    var encoded_root = try text_utils.encodeTerminalSafe(alloc, workspace_root, 512);
    defer encoded_root.deinit(alloc);
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    switch (action) {
        .approve => |name| {
            var encoded_name = try text_utils.encodeTerminalSafe(alloc, name, 160);
            defer encoded_name.deinit(alloc);
            try out.writer.print(
                "Approved project MCP server '{s}' for {s}.\n",
                .{ encoded_name.bytes, encoded_root.bytes },
            );
        },
        .reject => |name| {
            var encoded_name = try text_utils.encodeTerminalSafe(alloc, name, 160);
            defer encoded_name.deinit(alloc);
            try out.writer.print(
                "Rejected project MCP server '{s}' for {s}.\n",
                .{ encoded_name.bytes, encoded_root.bytes },
            );
        },
        .approve_all => try out.writer.print(
            "Approved all project MCP servers for {s}.\n",
            .{encoded_root.bytes},
        ),
        .reset => try out.writer.print(
            "Reset project MCP trust for {s}.\n",
            .{encoded_root.bytes},
        ),
    }
    try writeStdout(deps, out.written());
}

fn openTopLevelMcpUrl(
    raw: ?*anyopaque,
    alloc: Allocator,
    url: []const u8,
) anyerror!bool {
    const opener: *const host.UrlOpener = @ptrCast(@alignCast(raw.?));
    return opener.open(alloc, url);
}

fn writeMcpProfileMutationSuccess(
    alloc: Allocator,
    deps: RunDeps,
    action: []const u8,
    preposition: []const u8,
    name: []const u8,
    path: []const u8,
) !void {
    var encoded_name = try text_utils.encodeTerminalSafe(alloc, name, 160);
    defer encoded_name.deinit(alloc);
    var encoded_path = try text_utils.encodeTerminalSafe(alloc, path, 512);
    defer encoded_path.deinit(alloc);
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print(
        "{s} MCP server '{s}' {s} {s}.\n",
        .{ action, encoded_name.bytes, preposition, encoded_path.bytes },
    );
    try writeStdout(deps, out.written());
}

fn writeMcpAddUsage(deps: RunDeps) !void {
    return writeStderr(
        deps,
        "usage: fiber mcp add NAME COMMAND [ARGS...] | fiber mcp add --transport http NAME URL\n",
    );
}

fn writeMcpOperationFailure(
    alloc: Allocator,
    deps: RunDeps,
    operation: []const u8,
    format: output_contracts.OutputFormat,
    err: anyerror,
) !void {
    const message = try std.fmt.allocPrint(alloc, "fiber mcp {s} failed", .{operation});
    defer alloc.free(message);
    if (format == .json) {
        try writeJsonCommandFailure(alloc, deps, mcpOutputKind(operation), err, message);
        return;
    }
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print(
        "fiber mcp {s} failed: {s}.\n",
        .{ operation, @errorName(err) },
    );
    try writeStderr(deps, out.written());
}

fn mcpOutputKind(operation: []const u8) []const u8 {
    if (std.mem.eql(u8, operation, "list")) return output_contracts.Kind.mcp_list.jsonName();
    if (std.mem.eql(u8, operation, "add")) return output_contracts.Kind.mcp_add.jsonName();
    if (std.mem.eql(u8, operation, "remove")) return output_contracts.Kind.mcp_remove.jsonName();
    if (std.mem.eql(u8, operation, "path")) return output_contracts.Kind.mcp_path.jsonName();
    if (std.mem.eql(u8, operation, "logout")) return output_contracts.Kind.mcp_logout.jsonName();
    if (std.mem.eql(u8, operation, "trust")) return output_contracts.Kind.mcp_trust.jsonName();
    return "mcp";
}

fn writeMcpUsageOrJsonError(
    alloc: Allocator,
    command_catalog: CommandCatalog,
    deps: RunDeps,
    operation: []const u8,
    args: []const [:0]const u8,
) !void {
    if (argsContainJson(args)) {
        try writeJsonCommandFailure(
            alloc,
            deps,
            mcpOutputKind(operation),
            error.InvalidMcpArgs,
            "fiber mcp: invalid arguments",
        );
    } else {
        try writeTopLevelUsage(command_catalog, deps, .mcp);
    }
}

fn parseMcpOptionalJsonArgs(args: []const [:0]const u8) error{InvalidMcpArgs}!output_contracts.OutputFormat {
    if (args.len == 0) return .text;
    if (args.len == 1 and std.mem.eql(u8, args[0], "--json")) return .json;
    return error.InvalidMcpArgs;
}

const McpServerArgs = struct {
    server: []const u8,
    format: output_contracts.OutputFormat = .text,
};

fn parseMcpServerArgs(args: []const [:0]const u8) error{InvalidMcpArgs}!McpServerArgs {
    var options: McpServerArgs = .{ .server = undefined };
    var server_seen = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (server_seen) return error.InvalidMcpArgs;
        server_seen = true;
        if (arg.len == 0) return error.InvalidMcpArgs;
        options.server = arg;
    }
    if (!server_seen) return error.InvalidMcpArgs;
    return options;
}

fn mcpLogoutSnapshotResult(result: mcp_runtime.McpRuntime.LogoutResult) output_contracts.McpLogoutSnapshot.Result {
    if (!result.removed) return .missing;
    if (result.local_only) return .local_only;
    if (result.revocation_failed) return .revocation_failed;
    return .removed;
}

fn mcpTrustSnapshotFields(action: project_config.ProjectMcpAction) struct {
    action: []const u8,
    server: ?[]const u8,
} {
    return switch (action) {
        .approve => |name| .{ .action = "approve", .server = name },
        .reject => |name| .{ .action = "reject", .server = name },
        .approve_all => .{ .action = "approve_all", .server = null },
        .reset => .{ .action = "reset", .server = null },
    };
}

fn writeMcpJsonOutput(
    alloc: Allocator,
    deps: RunDeps,
    snapshot: anytype,
) !void {
    const text = try snapshot.render(alloc, .json);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, .json);
}

fn writeMcpProfileWarningIfPresent(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
) !void {
    const diagnostic = try cfg.inspect_mcp_profile_config(alloc);
    const warning = switch (diagnostic) {
        .warning => |value| value,
        .clear, .failed => return,
    };
    try writeMcpProfileWarning(alloc, deps, warning);
}

fn writeMcpProfileWarning(
    alloc: Allocator,
    deps: RunDeps,
    warning: mcp_contract.ProfileConfigWarning,
) !void {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print(
        "fiber: ~/.fiber/mcp.json warning: {s}",
        .{@tagName(warning.cause)},
    );
    if (warning.key()) |key| {
        var encoded = try text_utils.encodeTerminalSafe(alloc, key, 128);
        defer encoded.deinit(alloc);
        try out.writer.print(" key={s}", .{encoded.bytes});
    }
    try out.writer.print(
        " additional_matches={d}\n",
        .{warning.additional_matches},
    );
    try writeStderr(deps, out.written());
}

fn writeUsageOrJsonError(
    alloc: Allocator,
    command_catalog: CommandCatalog,
    deps: RunDeps,
    usage_kind: TopLevelKind,
    output_kind: []const u8,
    err: anyerror,
    args: anytype,
) !void {
    if (argsContainJson(args)) {
        try writeCommandFailure(alloc, deps, output_kind, err, .json);
    } else {
        try writeTopLevelUsage(command_catalog, deps, usage_kind);
    }
}

fn writeUsageCommandFailure(
    alloc: Allocator,
    deps: RunDeps,
    err: anyerror,
    format: output_contracts.OutputFormat,
) !void {
    const message = usageFailureMessage(err);
    if (format == .json) {
        return writeJsonCommandFailure(
            alloc,
            deps,
            output_contracts.Kind.usage.jsonName(),
            err,
            message,
        );
    }
    try writeStderr(deps, "fiber usage: ");
    try writeStderr(deps, message);
    try writeStderr(deps, "\n");
}

fn usageFailureMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.HomeNotSet => "HOME is not set",
        error.DurablePathUnsafe,
        error.PrivateStatePermissionsUnsupported,
        => "local usage storage is unsafe",
        else => "local usage data is unavailable",
    };
}

fn writeWorkspaceCommandError(
    alloc: Allocator,
    command_catalog: CommandCatalog,
    deps: RunDeps,
    args: []const [:0]const u8,
    err: anyerror,
) !void {
    if (!argsContainJson(args)) {
        if (output_contracts.workspaceErrorMessage(err)) |message| {
            try writeStderr(deps, "fiber workspace: ");
            try writeStderr(deps, message);
            try writeStderr(deps, "\n");
            return;
        }
        try writeTopLevelUsage(command_catalog, deps, .workspace);
        return;
    }

    const message = output_contracts.workspaceErrorMessage(err) orelse "invalid arguments";
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"kind\":\"workspace\",\"error\":");
    try std.json.Stringify.value(message, .{}, &out.writer);
    try out.writer.writeAll(",\"code\":");
    try std.json.Stringify.value(@errorName(err), .{}, &out.writer);
    try out.writer.writeByte('}');
    try writeJsonLine(deps, out.writer.buffered());
}

fn writeWorkspaceIndeterminateError(
    alloc: Allocator,
    deps: RunDeps,
    args: []const [:0]const u8,
    reconciliation: workspace_commands.Reconciliation,
) !void {
    const message = switch (reconciliation) {
        .intended => "settings durability is uncertain; reloaded settings match the requested update",
        .previous => "settings durability is uncertain; reloaded settings match the previous state, so the update was not applied",
        .unconfirmed => "settings durability is uncertain; reloaded settings match neither the requested nor previous state",
    };
    if (!argsContainJson(args)) {
        try writeStderr(deps, "fiber workspace: ");
        try writeStderr(deps, message);
        try writeStderr(deps, "\n");
        return;
    }

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"kind\":\"workspace\",\"error\":");
    try std.json.Stringify.value(message, .{}, &out.writer);
    try out.writer.writeAll(",\"code\":\"SettingsCommitIndeterminate\"}");
    try writeJsonLine(deps, out.writer.buffered());
}

fn argsContainJson(args: anytype) bool {
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) return true;
    }
    return false;
}

fn permissionModeForSnapshot(mode: anytype) types.PermissionMode {
    return switch (mode) {
        .ask => .ask,
        .auto => .auto,
        .yolo => .yolo,
    };
}

fn permissionModeLabel(mode: anytype) []const u8 {
    return switch (mode) {
        .ask => "ask",
        .auto => "auto",
        .yolo => "yolo",
    };
}

fn permissionRulesForSnapshot(alloc: Allocator, active_rules: anytype) !types.PermissionRuleSet {
    if (active_rules.rules.len == 0) return .{};
    const rules = try alloc.alloc(types.PermissionRule, active_rules.rules.len);
    for (active_rules.rules, 0..) |rule, i| {
        rules[i] = .{
            .permission = rule.permission,
            .pattern = rule.pattern,
            .action = switch (rule.action) {
                .allow => .allow,
                .ask => .ask,
                .deny => .deny,
            },
        };
    }
    return .{ .rules = rules };
}

fn loadLatestWorkspaceSessionDetail(
    alloc: Allocator,
    store: session_store.Store,
) !session_store.ReadOnlyDetail {
    var summary = try store.latestReadOnlyWorkspaceSummary(alloc);
    defer summary.deinit(alloc);
    return store.loadReadOnlyDetail(alloc, summary.id, .{});
}

fn loadLatestWorkspaceSessionSummary(
    alloc: Allocator,
    store: session_store.Store,
) !session_store.SessionSummary {
    return store.latestReadOnlyWorkspaceSummary(alloc);
}

fn catalogFailureDetail(failure: model_catalog.Failure) []const u8 {
    return switch (failure.category) {
        .authentication => "AuthenticationRejected",
        .cancellation => "the request was cancelled",
        .malformed_response => "MalformedResponse",
        .resource_exhausted => "OutOfMemory",
        .rate_limited, .gateway_unavailable, .transport, .http_status, .runtime => "Unavailable",
    };
}

fn writeCommandFailure(
    alloc: Allocator,
    deps: RunDeps,
    kind: []const u8,
    err: anyerror,
    format: output_contracts.OutputFormat,
) !void {
    if (format != .json) return err;
    const message = commandFailureMessage(err) orelse return err;
    return writeJsonCommandFailure(alloc, deps, kind, err, message);
}

fn writeJsonCommandFailure(
    alloc: Allocator,
    deps: RunDeps,
    kind: []const u8,
    err: anyerror,
    message: []const u8,
) !void {
    return writeJsonCommandFailureCode(
        alloc,
        deps,
        kind,
        @errorName(err),
        message,
    );
}

fn writeJsonCommandFailureCode(
    alloc: Allocator,
    deps: RunDeps,
    kind: []const u8,
    code: []const u8,
    message: []const u8,
) !void {
    const json = try (output_contracts.CommandFailureSnapshot{
        .kind = kind,
        .message = message,
        .code = code,
    }).renderJson(alloc);
    defer alloc.free(json);
    try writeJsonLine(deps, json);
}

fn writeLookupFailure(
    alloc: Allocator,
    deps: RunDeps,
    kind: []const u8,
    err: anyerror,
    format: output_contracts.OutputFormat,
) !void {
    if (format == .json) {
        return writeCommandFailure(alloc, deps, kind, err, format);
    }

    switch (err) {
        error.NoSavedSessions => {
            try writeStderr(deps, "fiber session: no saved sessions for this workspace\n");
        },
        error.NoReadableSessions => {
            try writeStderr(deps, "fiber session: saved sessions are unreadable; run `fiber doctor` for recovery guidance\n");
        },
        error.SessionNotFound => {
            try writeStderr(deps, "fiber session: record not found\n");
        },
        error.InvalidSessionFormat => {
            try writeStderr(
                deps,
                "fiber session: record is corrupt; run `fiber doctor` for recovery guidance\n",
            );
        },
        error.UnsupportedSessionSchema => {
            try writeStderr(
                deps,
                "fiber session: record uses an unsupported session version\n",
            );
        },
        error.InvalidSessionId => {
            try writeStderr(deps, "fiber session: invalid session id\n");
        },
        error.SessionRecoveryNotNeeded => {
            try writeStderr(
                deps,
                "fiber session: recovery was refused because the session has a valid commit boundary; resume it normally\n",
            );
        },
        error.SessionRecoveryRequiresCurrentSchema => {
            try writeStderr(
                deps,
                "fiber session: recovery only applies to current schema-v3 sessions\n",
            );
        },
        error.SessionRecoveryUnsupportedSchema => {
            try writeStderr(
                deps,
                "fiber session: recovery is unavailable for this unsupported session version\n",
            );
        },
        error.SessionRecoveryBoundaryInvalid => {
            try writeStderr(
                deps,
                "fiber session: no exact trustworthy recovery boundary was found; the source was left unchanged\n",
            );
        },
        error.SessionRecoveryIndeterminate => {
            try writeStderr(
                deps,
                "fiber session: the recovery copy could not be confirmed; the source was left unchanged\n",
            );
        },
        error.SessionAuthorityBoundaryUnavailable,
        error.SessionCommitBoundaryUnavailable,
        => {
            try writeStderr(
                deps,
                "fiber session: session authority is temporarily unavailable while an incomplete commit is resolved\n",
            );
        },
        error.SessionAuthorityIntentCleanupPending => {
            try writeStderr(
                deps,
                "fiber session: session authority is confirmed but transition cleanup is still pending\n",
            );
        },
        error.SessionBusy, error.SessionLockUnsupported => {
            try writeStderr(
                deps,
                "fiber session: session is busy or the filesystem cannot provide the required lock\n",
            );
        },
        error.SessionPathUnsafe,
        error.DurablePathUnsafe,
        error.PrivateStatePermissionsUnsupported,
        => {
            try writeStderr(
                deps,
                "fiber session: durable session storage is unsafe or does not support required private permissions\n",
            );
        },
        error.DurableLayoutFailed, error.SessionStoreUnavailable => {
            try writeStderr(deps, "fiber session: durable session store is unavailable\n");
        },
        error.HomeNotSet => {
            try writeStderr(deps, "fiber ");
            try writeStderr(deps, kind);
            try writeStderr(deps, ": HOME is not set\n");
        },
        else => return err,
    }
}

fn writeSessionCommandFailure(
    alloc: Allocator,
    deps: RunDeps,
    kind: []const u8,
    session_id: []const u8,
    err: anyerror,
    format: output_contracts.OutputFormat,
) !void {
    const message = switch (err) {
        error.InvalidSessionFormat => try std.fmt.allocPrint(
            alloc,
            "session {s} is corrupt; run `fiber session recover {s}`",
            .{ session_id, session_id },
        ),
        error.UnsupportedSessionSchema => try std.fmt.allocPrint(
            alloc,
            "session {s} uses an unsupported session version",
            .{session_id},
        ),
        else => return writeLookupFailure(
            alloc,
            deps,
            kind,
            err,
            format,
        ),
    };
    defer alloc.free(message);
    if (format == .json) {
        return writeJsonCommandFailure(
            alloc,
            deps,
            kind,
            err,
            message,
        );
    }
    try writeStderr(deps, "fiber session: ");
    try writeStderr(deps, message);
    try writeStderr(deps, "\n");
}

fn writeSessionDetailFailure(
    alloc: Allocator,
    deps: RunDeps,
    session_id: []const u8,
    err: anyerror,
    format: output_contracts.OutputFormat,
) !void {
    return writeSessionCommandFailure(
        alloc,
        deps,
        output_contracts.Kind.session_show.jsonName(),
        session_id,
        err,
        format,
    );
}

fn commandFailureMessage(err: anyerror) ?[]const u8 {
    if (lookupFailureMessage(err)) |message| return message;
    return switch (err) {
        error.InvalidLocalSurfaceArgs,
        error.InvalidUsageArgs,
        error.InvalidSessionDetailArgs,
        error.InvalidSessionRecoveryArgs,
        error.InvalidSessionRenameArgs,
        error.InvalidSessionRemoveArgs,
        error.InvalidResumeArgs,
        error.InvalidPermissionArgs,
        => "invalid arguments",
        else => null,
    };
}

fn lookupFailureMessage(err: anyerror) ?[]const u8 {
    return switch (err) {
        error.NoSavedSessions => "no saved sessions for this workspace",
        error.NoReadableSessions => "saved sessions are unreadable; run `fiber doctor` for recovery guidance",
        error.SessionNotFound => "record not found",
        error.InvalidSessionFormat => "record is corrupt; run `fiber doctor` for recovery guidance",
        error.UnsupportedSessionSchema => "record uses an unsupported session version",
        error.InvalidSessionId => "invalid session id",
        error.SessionRecoveryNotNeeded => "recovery was refused because the session has a valid commit boundary; resume it normally",
        error.SessionRecoveryRequiresCurrentSchema => "recovery only applies to current schema-v3 sessions",
        error.SessionRecoveryUnsupportedSchema => "recovery is unavailable for this unsupported session version",
        error.SessionRecoveryBoundaryInvalid => "no exact trustworthy recovery boundary was found; the source was left unchanged",
        error.SessionRecoveryIndeterminate => "the recovery copy could not be confirmed; the source was left unchanged",
        error.SessionAuthorityBoundaryUnavailable,
        error.SessionCommitBoundaryUnavailable,
        => "session authority is temporarily unavailable while an incomplete commit is resolved",
        error.SessionAuthorityIntentCleanupPending => "session authority is confirmed but transition cleanup is still pending",
        error.SessionBusy, error.SessionLockUnsupported => "session is busy or the filesystem cannot provide the required lock",
        error.SessionPathUnsafe,
        error.DurablePathUnsafe,
        error.PrivateStatePermissionsUnsupported,
        => "durable session storage is unsafe or does not support required private permissions",
        error.DurableLayoutFailed, error.SessionStoreUnavailable => "durable session store is unavailable",
        error.HomeNotSet => "HOME is not set",
        else => null,
    };
}

test "session detail failures separate corruption from unsupported schema" {
    var corrupt_text = CaptureOutput.init(std.testing.allocator);
    defer corrupt_text.deinit();
    try writeSessionDetailFailure(
        std.testing.allocator,
        corrupt_text.deps(),
        "broken-session",
        error.InvalidSessionFormat,
        .text,
    );
    try std.testing.expectEqualStrings("", corrupt_text.stdout.written());
    try std.testing.expectEqualStrings(
        "fiber session: session broken-session is corrupt; run `fiber session recover broken-session`\n",
        corrupt_text.stderr.written(),
    );

    var corrupt_json = CaptureOutput.init(std.testing.allocator);
    defer corrupt_json.deinit();
    try writeSessionDetailFailure(
        std.testing.allocator,
        corrupt_json.deps(),
        "broken-session",
        error.InvalidSessionFormat,
        .json,
    );
    try std.testing.expectEqualStrings("", corrupt_json.stderr.written());
    try std.testing.expect(
        std.mem.find(
            u8,
            corrupt_json.stdout.written(),
            "\"error\":\"session broken-session is corrupt; run `fiber session recover broken-session`\"",
        ) != null,
    );
    try std.testing.expect(
        std.mem.find(
            u8,
            corrupt_json.stdout.written(),
            "\"code\":\"InvalidSessionFormat\"",
        ) != null,
    );

    var unsupported_text = CaptureOutput.init(std.testing.allocator);
    defer unsupported_text.deinit();
    try writeSessionDetailFailure(
        std.testing.allocator,
        unsupported_text.deps(),
        "future-session",
        error.UnsupportedSessionSchema,
        .text,
    );
    try std.testing.expectEqualStrings("", unsupported_text.stdout.written());
    try std.testing.expectEqualStrings(
        "fiber session: session future-session uses an unsupported session version\n",
        unsupported_text.stderr.written(),
    );
}

test "session recovery boundary failures keep stable text and json guidance" {
    var text_output = CaptureOutput.init(std.testing.allocator);
    defer text_output.deinit();
    try writeLookupFailure(
        std.testing.allocator,
        text_output.deps(),
        output_contracts.Kind.session_recover.jsonName(),
        error.SessionRecoveryBoundaryInvalid,
        .text,
    );
    try std.testing.expectEqualStrings("", text_output.stdout.written());
    try std.testing.expectEqualStrings(
        "fiber session: no exact trustworthy recovery boundary was found; the source was left unchanged\n",
        text_output.stderr.written(),
    );

    var json_output = CaptureOutput.init(std.testing.allocator);
    defer json_output.deinit();
    try writeLookupFailure(
        std.testing.allocator,
        json_output.deps(),
        output_contracts.Kind.session_recover.jsonName(),
        error.SessionRecoveryBoundaryInvalid,
        .json,
    );
    try std.testing.expectEqualStrings("", json_output.stderr.written());
    try std.testing.expect(
        std.mem.find(
            u8,
            json_output.stdout.written(),
            "\"code\":\"SessionRecoveryBoundaryInvalid\"",
        ) != null,
    );
    try std.testing.expect(
        std.mem.find(
            u8,
            json_output.stdout.written(),
            "\"error\":\"no exact trustworthy recovery boundary was found; the source was left unchanged\"",
        ) != null,
    );
}

fn workflowConfig(cfg: Config) @import("cli_ask.zig").Config {
    return .{
        .command_usage = command_specs.topLevelUsage(cfg.command_catalog, .ask),
        .default_model = cfg.default_model,
        .default_agent_step_limit = cfg.default_agent_step_limit,
        .gateway_retry_count = cfg.gateway_retry_count,
        .gateway_models_path = cfg.models_path,
        .gateway_provider = cfg.gateway_provider,
        .provider_set = cfg.provider_set,
        .process_provider = cfg.process_provider,
        .prompt_policy = cfg.prompt_policy,
        .skill_root_policy = cfg.skill_root_policy,
        .ignored_list_entries = cfg.ignored_list_entries,
        .max_list_entries = cfg.max_list_entries,
        .max_read_file_bytes = cfg.max_read_file_bytes,
        .max_read_file_lines = cfg.max_read_file_lines,
        .max_read_file_line_len = cfg.max_read_file_line_len,
        .max_command_output_bytes = cfg.max_command_output_bytes,
        .max_tool_result_bytes = cfg.max_tool_result_bytes,
        .max_history_turns = cfg.max_history_turns,
        .mode_registry = cfg.mode_registry,
        .load_mcp_runtime = cfg.load_mcp_runtime,
    };
}

fn workflowConfigWithLaunchModifiers(
    cfg: Config,
    modifiers: LaunchModifiers,
) @import("cli_ask.zig").Config {
    var result = workflowConfig(cfg);
    result.context_limit_overrides = modifiers.context_limit_overrides;
    result.additional_directories = modifiers.additional_directories;
    result.saved_directories_suppressed = modifiers.saved_directories_suppressed;
    return result;
}

fn commandSupportsWorkspaceModifiers(command: Command) bool {
    return switch (command) {
        .interactive, .ask, .resume_session => true,
        else => false,
    };
}

fn writeWorkspaceModifierUsage(deps: RunDeps) !void {
    try writeStderr(
        deps,
        "fiber: --add-dir and --no-additional-dirs are only supported for interactive, resume, and ask launches\n",
    );
}

fn globalLaunchErrorMessage(err: anyerror) ?[]const u8 {
    return switch (err) {
        error.MissingAddDirectoryValue => "--add-dir requires a directory path",
        error.DuplicateAdditionalDirectorySuppression => "--no-additional-dirs may only be specified once",
        else => null,
    };
}

fn parseLocalSurfaceArgs(args: []const [:0]const u8) !LocalSurfaceOptions {
    var options = LocalSurfaceOptions{};
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        return error.InvalidLocalSurfaceArgs;
    }
    return options;
}

fn parseUpgradeArgs(args: []const [:0]const u8) !UpgradeOptions {
    var options = UpgradeOptions{};
    var format_seen = false;
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            if (format_seen) return error.InvalidUpgradeArgs;
            format_seen = true;
            options.format = .json;
            continue;
        }
        return error.InvalidUpgradeArgs;
    }
    return options;
}

fn executeSessionList(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    rest: []const [:0]const u8,
) !RunResult {
    const opts = parseSessionListArgs(rest) catch |err| {
        try writeUsageOrJsonError(
            alloc,
            cfg.command_catalog,
            deps,
            .sessions,
            output_contracts.Kind.session_list.jsonName(),
            err,
            rest,
        );
        return .handled_usage_error;
    };

    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    defer alloc.free(workspace_root);

    var store = session_store.Store.initReadOnly(alloc, workspace_root) catch |err| {
        try writeLookupFailure(alloc, deps, output_contracts.Kind.session_list.jsonName(), err, opts.format);
        return .handled_failure;
    };
    defer store.deinit(alloc);

    var page = subagent_resume_admission.listVisiblePage(
        store,
        alloc,
        opts.scope,
        opts.continuation,
        opts.limit,
    ) catch |err| return err;
    defer page.deinit(alloc);
    const next_cursor = if (page.has_more and page.summaries.items.len > 0)
        try formatSessionListCursor(
            alloc,
            page.summaries.items[page.summaries.items.len - 1],
        )
    else
        null;
    defer if (next_cursor) |cursor| alloc.free(cursor);

    const text = try (output_contracts.SessionListSnapshot{
        .sessions = page.summaries.items,
        .has_more = page.has_more,
        .next_cursor = next_cursor,
        .skipped_invalid = page.skipped_invalid,
        .all_workspaces = opts.scope == .all_workspaces,
    }).render(alloc, opts.format);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, opts.format);
    return .handled_success;
}

fn executeSessionShow(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    rest: []const [:0]const u8,
) !RunResult {
    var opts = parseSessionDetailArgs(alloc, rest) catch |err| {
        try writeUsageOrJsonError(
            alloc,
            cfg.command_catalog,
            deps,
            .session,
            output_contracts.Kind.session_show.jsonName(),
            err,
            rest,
        );
        return .handled_usage_error;
    };
    defer opts.deinit(alloc);

    const target = opts.target orelse {
        try writeUsageOrJsonError(
            alloc,
            cfg.command_catalog,
            deps,
            .session,
            output_contracts.Kind.session_show.jsonName(),
            error.InvalidSessionDetailArgs,
            rest,
        );
        return .handled_usage_error;
    };

    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    defer alloc.free(workspace_root);

    var store = session_store.Store.initReadOnly(alloc, workspace_root) catch |err| {
        try writeLookupFailure(alloc, deps, output_contracts.Kind.session_show.jsonName(), err, opts.format);
        return .handled_failure;
    };
    defer store.deinit(alloc);

    switch (target) {
        .last => {
            var summary = subagent_resume_admission.latestVisibleWorkspaceSummary(
                store,
                alloc,
            ) catch |err| {
                try writeLookupFailure(alloc, deps, output_contracts.Kind.session_show.jsonName(), err, opts.format);
                return .handled_failure;
            };
            defer summary.deinit(alloc);

            const text = try (output_contracts.SessionSummarySnapshot{
                .summary = summary,
            }).render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
        .id => |id| {
            var detail = subagent_resume_admission.loadVisibleReadOnlyDetail(
                store,
                alloc,
                id,
                .{},
            ) catch |err| {
                try writeSessionCommandFailure(
                    alloc,
                    deps,
                    output_contracts.Kind.session_show.jsonName(),
                    id,
                    err,
                    opts.format,
                );
                return .handled_failure;
            };
            defer detail.deinit(alloc);

            const text = try (output_contracts.SessionDetailSnapshot{
                .detail = detail,
            }).render(alloc, opts.format);
            defer alloc.free(text);
            try writeFormattedOutput(deps, text, opts.format);
            return .handled_success;
        },
    }
}

fn executeSessionRename(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    rest: []const [:0]const u8,
) !RunResult {
    var opts = parseSessionRenameArgs(alloc, rest) catch |err| {
        try writeUsageOrJsonError(
            alloc,
            cfg.command_catalog,
            deps,
            .session,
            output_contracts.Kind.session_rename.jsonName(),
            err,
            rest,
        );
        return .handled_usage_error;
    };
    defer opts.deinit(alloc);

    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    defer alloc.free(workspace_root);

    var store = session_store.Store.init(alloc, workspace_root) catch |err| {
        try writeLookupFailure(alloc, deps, output_contracts.Kind.session_rename.jsonName(), err, opts.format);
        return .handled_failure;
    };
    defer store.deinit(alloc);

    store.renameSessionDisplayTitle(alloc, opts.session_id, opts.title) catch |err| {
        try writeSessionCommandFailure(
            alloc,
            deps,
            output_contracts.Kind.session_rename.jsonName(),
            opts.session_id,
            err,
            opts.format,
        );
        return .handled_failure;
    };

    const text = try (output_contracts.SessionRenameSnapshot{
        .id = opts.session_id,
        .title = opts.title,
    }).render(alloc, opts.format);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, opts.format);
    return .handled_success;
}

fn executeSessionRemove(
    alloc: Allocator,
    cfg: Config,
    deps: RunDeps,
    rest: []const [:0]const u8,
) !RunResult {
    var opts = parseSessionRemoveArgs(alloc, rest) catch |err| {
        try writeUsageOrJsonError(
            alloc,
            cfg.command_catalog,
            deps,
            .session,
            output_contracts.Kind.session_remove.jsonName(),
            err,
            rest,
        );
        return .handled_usage_error;
    };
    defer opts.deinit(alloc);

    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    defer alloc.free(workspace_root);

    var store = session_store.Store.init(alloc, workspace_root) catch |err| {
        try writeLookupFailure(alloc, deps, output_contracts.Kind.session_remove.jsonName(), err, opts.format);
        return .handled_failure;
    };
    defer store.deinit(alloc);

    var loaded = store.resumeTargetForWrite(
        alloc,
        .{ .id = opts.session_id },
        workspace_root,
        .{},
    ) catch |err| {
        try writeSessionCommandFailure(
            alloc,
            deps,
            output_contracts.Kind.session_remove.jsonName(),
            opts.session_id,
            err,
            opts.format,
        );
        return .handled_failure;
    };

    const disposition = store.deleteCommittedSession(alloc, &loaded);
    switch (disposition) {
        .discarded => {},
        .retained, .indeterminate => {
            try writeSessionCommandFailure(
                alloc,
                deps,
                output_contracts.Kind.session_remove.jsonName(),
                opts.session_id,
                error.SessionStoreUnavailable,
                opts.format,
            );
            return .handled_failure;
        },
    }

    const text = try (output_contracts.SessionRemoveSnapshot{
        .id = opts.session_id,
        .removed = true,
    }).render(alloc, opts.format);
    defer alloc.free(text);
    try writeFormattedOutput(deps, text, opts.format);
    return .handled_success;
}

fn parseSessionListArgs(args: []const [:0]const u8) !SessionListOptions {
    var options = SessionListOptions{};
    var format_seen = false;
    var limit_seen = false;
    var cursor_seen = false;
    var scope_seen = false;
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            if (format_seen) return error.InvalidLocalSurfaceArgs;
            format_seen = true;
            options.format = .json;
            continue;
        }
        if (std.mem.eql(u8, arg, "--all")) {
            if (scope_seen) return error.InvalidLocalSurfaceArgs;
            scope_seen = true;
            options.scope = .all_workspaces;
            continue;
        }
        if (std.mem.eql(u8, arg, "--limit")) {
            if (limit_seen or index + 1 >= args.len) return error.InvalidLocalSurfaceArgs;
            limit_seen = true;
            index += 1;
            options.limit = std.fmt.parseUnsigned(usize, args[index], 10) catch
                return error.InvalidLocalSurfaceArgs;
            if (options.limit == 0 or
                options.limit > session_store.session_list_max_limit)
            {
                return error.InvalidLocalSurfaceArgs;
            }
            continue;
        }
        if (std.mem.eql(u8, arg, "--continuation")) {
            if (cursor_seen or index + 1 >= args.len) return error.InvalidLocalSurfaceArgs;
            cursor_seen = true;
            index += 1;
            options.continuation = try parseSessionListCursor(args[index]);
            continue;
        }
        return error.InvalidLocalSurfaceArgs;
    }
    return options;
}

fn parseUsageArgs(args: []const [:0]const u8) !UsageOptions {
    var options = UsageOptions{};
    var period_seen = false;
    var json_seen = false;
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            if (json_seen) return error.InvalidUsageArgs;
            json_seen = true;
            options.format = .json;
            continue;
        }
        if (std.mem.eql(u8, arg, "--period")) {
            if (period_seen or index + 1 >= args.len) return error.InvalidUsageArgs;
            period_seen = true;
            index += 1;
            options.scope = if (std.mem.eql(u8, args[index], "24h"))
                .hours_24
            else if (std.mem.eql(u8, args[index], "7d"))
                .days_7
            else if (std.mem.eql(u8, args[index], "30d"))
                .days_30
            else
                return error.InvalidUsageArgs;
            continue;
        }
        return error.InvalidUsageArgs;
    }
    return options;
}

fn parseSessionListCursor(raw: []const u8) !session_store.ResumableSessionContinuation {
    if (raw.len == 0 or raw.len > 320) return error.InvalidLocalSurfaceArgs;
    var fields = std.mem.splitScalar(u8, raw, ':');
    if (!std.mem.eql(u8, fields.next() orelse return error.InvalidLocalSurfaceArgs, "v1")) {
        return error.InvalidLocalSurfaceArgs;
    }
    const updated_text = fields.next() orelse return error.InvalidLocalSurfaceArgs;
    const id = fields.next() orelse return error.InvalidLocalSurfaceArgs;
    if (fields.next() != null) return error.InvalidLocalSurfaceArgs;
    session_store.validateSessionId(id) catch return error.InvalidLocalSurfaceArgs;
    const updated_at_ms = std.fmt.parseInt(i64, updated_text, 10) catch
        return error.InvalidLocalSurfaceArgs;
    var canonical: [320]u8 = undefined;
    const encoded = std.fmt.bufPrint(
        &canonical,
        "v1:{d}:{s}",
        .{ updated_at_ms, id },
    ) catch return error.InvalidLocalSurfaceArgs;
    if (!std.mem.eql(u8, encoded, raw)) return error.InvalidLocalSurfaceArgs;
    return .{ .updated_at_ms = updated_at_ms, .id = id };
}

fn formatSessionListCursor(
    alloc: Allocator,
    summary: session_store.SessionSummary,
) ![]u8 {
    return std.fmt.allocPrint(
        alloc,
        "v1:{d}:{s}",
        .{ summary.updated_at_ms, summary.id },
    );
}

fn parseWorkspaceArgs(args: []const [:0]const u8) !WorkspaceOptions {
    var positional: [2][]const u8 = undefined;
    var positional_len: usize = 0;
    var options = WorkspaceOptions{};
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--json")) {
            if (options.format == .json) return error.InvalidWorkspaceArgs;
            options.format = .json;
            continue;
        }
        if (positional_len >= positional.len) return error.InvalidWorkspaceArgs;
        positional[positional_len] = arg;
        positional_len += 1;
    }

    if (positional_len == 0) return options;
    if (std.mem.eql(u8, positional[0], "list")) {
        if (positional_len != 1) return error.InvalidWorkspaceArgs;
        return options;
    }
    if (std.mem.eql(u8, positional[0], "clear")) {
        if (positional_len != 1) return error.InvalidWorkspaceArgs;
        options.action = .clear;
        return options;
    }
    if (std.mem.eql(u8, positional[0], "add")) {
        if (positional_len != 2 or positional[1].len == 0) return error.InvalidWorkspaceArgs;
        options.action = .{ .add = positional[1] };
        return options;
    }
    if (std.mem.eql(u8, positional[0], "remove")) {
        if (positional_len != 2 or positional[1].len == 0) return error.InvalidWorkspaceArgs;
        options.action = .{ .remove = positional[1] };
        return options;
    }
    return error.InvalidWorkspaceArgs;
}

fn parseSessionDetailArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !SessionDetailOptions {
    var options = SessionDetailOptions{};
    errdefer options.deinit(alloc);
    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--json")) {
            options.format = .json;
            continue;
        }
        if (options.target != null) return error.InvalidSessionDetailArgs;
        const exact_id = std.mem.eql(u8, arg, "--id");
        if (exact_id) {
            i += 1;
            if (i >= args.len) return error.InvalidSessionDetailArgs;
        }
        const trimmed = std.mem.trim(u8, args[i], " \t\r\n");
        if (trimmed.len == 0) return error.InvalidSessionDetailArgs;
        if (!exact_id and std.mem.eql(u8, trimmed, "last")) {
            options.target = .last;
            continue;
        }
        options.target = .{ .id = try alloc.dupe(u8, trimmed) };
    }
    return options;
}

fn parseSessionRecoveryArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !SessionRecoveryOptions {
    var format: output_contracts.OutputFormat = .text;
    var session_id: ?[]u8 = null;
    errdefer if (session_id) |id| alloc.free(id);

    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--json")) {
            format = .json;
            continue;
        }
        if (session_id != null) return error.InvalidSessionRecoveryArgs;
        const exact_id = std.mem.eql(u8, arg, "--id");
        if (exact_id) {
            i += 1;
            if (i >= args.len) return error.InvalidSessionRecoveryArgs;
        }
        const trimmed = std.mem.trim(u8, args[i], " \t\r\n");
        if (trimmed.len == 0) return error.InvalidSessionRecoveryArgs;
        session_id = try alloc.dupe(u8, trimmed);
    }
    return .{
        .format = format,
        .session_id = session_id orelse return error.InvalidSessionRecoveryArgs,
    };
}

fn parseSessionRenameArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !SessionRenameOptions {
    var format: output_contracts.OutputFormat = .text;
    var format_seen = false;
    var owned_id: ?[]u8 = null;
    var owned_title: ?[]u8 = null;
    var title_start: ?usize = null;
    errdefer {
        if (owned_id) |value| alloc.free(value);
        if (owned_title) |value| alloc.free(value);
    }

    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--json")) {
            if (format_seen) return error.InvalidSessionRenameArgs;
            format_seen = true;
            format = .json;
            continue;
        }
        if (owned_id != null) return error.InvalidSessionRenameArgs;
        const exact_id = std.mem.eql(u8, arg, "--id");
        if (exact_id) {
            i += 1;
            if (i >= args.len) return error.InvalidSessionRenameArgs;
        }
        const trimmed = std.mem.trim(u8, args[i], " \t\r\n");
        if (trimmed.len == 0) return error.InvalidSessionRenameArgs;
        owned_id = try alloc.dupe(u8, trimmed);
        title_start = i + 1;
        break;
    }
    if (owned_id == null or title_start == null or title_start.? >= args.len) {
        return error.InvalidSessionRenameArgs;
    }
    owned_title = try joinValidatedSessionTitle(alloc, args[title_start.?..]);
    return .{
        .format = format,
        .session_id = owned_id.?,
        .title = owned_title.?,
    };
}

fn parseSessionRemoveArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !SessionRemoveOptions {
    var format: output_contracts.OutputFormat = .text;
    var format_seen = false;
    var owned_id: ?[]u8 = null;
    errdefer if (owned_id) |value| alloc.free(value);

    var i: usize = 0;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--json")) {
            if (format_seen) return error.InvalidSessionRemoveArgs;
            format_seen = true;
            format = .json;
            continue;
        }
        if (owned_id != null) return error.InvalidSessionRemoveArgs;
        const exact_id = std.mem.eql(u8, arg, "--id");
        if (exact_id) {
            i += 1;
            if (i >= args.len) return error.InvalidSessionRemoveArgs;
        }
        const trimmed = std.mem.trim(u8, args[i], " \t\r\n");
        if (trimmed.len == 0) return error.InvalidSessionRemoveArgs;
        owned_id = try alloc.dupe(u8, trimmed);
    }
    return .{
        .format = format,
        .session_id = owned_id orelse return error.InvalidSessionRemoveArgs,
    };
}

fn joinValidatedSessionTitle(
    alloc: Allocator,
    parts: []const [:0]const u8,
) ![]u8 {
    if (parts.len == 0) return error.InvalidSessionRenameArgs;
    for (parts) |part| {
        if (part.len > 0 and part[0] == '-') return error.InvalidSessionRenameArgs;
    }
    if (parts.len == 1) {
        const validated = validateSessionTitle(parts[0]) catch return error.InvalidSessionRenameArgs;
        return try alloc.dupe(u8, validated);
    }

    var total: usize = 0;
    for (parts, 0..) |part, index| {
        total += part.len;
        if (index + 1 < parts.len) total += 1;
    }
    var combined = try alloc.alloc(u8, total);
    errdefer alloc.free(combined);
    var offset: usize = 0;
    for (parts, 0..) |part, index| {
        @memcpy(combined[offset..][0..part.len], part);
        offset += part.len;
        if (index + 1 < parts.len) {
            combined[offset] = ' ';
            offset += 1;
        }
    }
    const validated = validateSessionTitle(combined) catch {
        alloc.free(combined);
        return error.InvalidSessionRenameArgs;
    };
    const owned = try alloc.dupe(u8, validated);
    alloc.free(combined);
    return owned;
}

fn parseResumeArgs(
    alloc: Allocator,
    args: []const [:0]const u8,
) !ResumeTarget {
    if (args.len == 0) return .last;

    const exact_id = std.mem.eql(u8, args[0], "--id");
    if (!exact_id and args[0].len > 0 and args[0][0] == '-') return error.InvalidResumeArgs;
    const operand_index: usize = if (exact_id) 1 else 0;
    if (args.len != operand_index + 1) return error.InvalidResumeArgs;

    const trimmed = std.mem.trim(u8, args[operand_index], " \t\r\n");
    if (trimmed.len == 0) return error.InvalidResumeArgs;
    if (!exact_id and std.mem.eql(u8, trimmed, "last")) return .last;
    return .{ .id = try alloc.dupe(u8, trimmed) };
}

fn isVersionFlag(arg: []const u8) bool {
    return std.mem.eql(u8, arg, "--version") or std.mem.eql(u8, arg, "-v");
}

fn testCommandCatalog() CommandCatalog {
    const builtin_commands = @import("../../builtins/commands.zig");
    return builtin_commands.top_level_registry;
}

test "parse recognizes every top-level command and preserves unknown commands" {
    const command_catalog = testCommandCatalog();
    try std.testing.expectEqual(Command.interactive, parse(command_catalog, &.{}));
    try std.testing.expectEqual(Command.help, parse(command_catalog, &.{@constCast("help")}));

    switch (parse(command_catalog, &.{ @constCast("ask"), @constCast("hello") })) {
        .ask => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("status"), @constCast("--json") })) {
        .status => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("permissions")})) {
        .permissions => |rest| try std.testing.expectEqual(@as(usize, 0), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("models"), @constCast("--json") })) {
        .models => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("mcp"), @constCast("add"), @constCast("fixture"), @constCast("node") })) {
        .mcp => |rest| try std.testing.expectEqual(@as(usize, 3), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("auth"), @constCast("list") })) {
        .auth => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("doctor")})) {
        .doctor => |rest| try std.testing.expectEqual(@as(usize, 0), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("background")})) {
        .unknown => |command| try std.testing.expectEqualStrings("background", command),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("session"), @constCast("last") })) {
        .session => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("session"), @constCast("resume"), @constCast("last") })) {
        .resume_session => |invocation| try std.testing.expectEqual(@as(usize, 1), invocation.args.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("sessions"), @constCast("--json") })) {
        .sessions => |rest| try std.testing.expectEqual(@as(usize, 1), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("resume"), @constCast("last") })) {
        .resume_session => |invocation| try std.testing.expectEqual(@as(usize, 1), invocation.args.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("continue")})) {
        .resume_session => |invocation| try std.testing.expectEqual(@as(usize, 0), invocation.args.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("usage"), @constCast("--period"), @constCast("24h") })) {
        .usage => |rest| try std.testing.expectEqual(@as(usize, 2), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("upgrade")})) {
        .upgrade => |rest| try std.testing.expectEqual(@as(usize, 0), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("debug"), @constCast("replay"), @constCast("tape") })) {
        .debug => |rest| {
            try std.testing.expectEqual(@as(usize, 2), rest.len);
            try std.testing.expectEqualStrings("replay", rest[0]);
            try std.testing.expectEqualStrings("tape", rest[1]);
        },
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("replay"), @constCast("tape") })) {
        .unknown => |value| try std.testing.expectEqualStrings("replay", value),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("wat")})) {
        .unknown => |value| try std.testing.expectEqualStrings("wat", value),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("task")})) {
        .unknown => |value| try std.testing.expectEqualStrings("task", value),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{@constCast("tasks")})) {
        .unknown => |value| try std.testing.expectEqualStrings("tasks", value),
        else => return error.TestExpectedEqual,
    }
}

test "help aliases route to help" {
    const command_catalog = testCommandCatalog();
    try std.testing.expectEqual(Command.help, parse(command_catalog, &.{@constCast("--help")}));
    try std.testing.expectEqual(Command.help, parse(command_catalog, &.{@constCast("-h")}));
}

test "usage arguments accept only rolling periods and one JSON flag" {
    const defaults = try parseUsageArgs(&.{});
    try std.testing.expectEqual(usage_report.Scope.days_30, defaults.scope);
    try std.testing.expectEqual(output_contracts.OutputFormat.text, defaults.format);

    const selected = try parseUsageArgs(&.{
        @constCast("--json"),
        @constCast("--period"),
        @constCast("7d"),
    });
    try std.testing.expectEqual(usage_report.Scope.days_7, selected.scope);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, selected.format);

    for ([_][]const [:0]const u8{
        &.{@constCast("--period")},
        &.{ @constCast("--period"), @constCast("session") },
        &.{ @constCast("--period"), @constCast("24h"), @constCast("--period"), @constCast("7d") },
        &.{ @constCast("--json"), @constCast("--json") },
        &.{@constCast("30d")},
    }) |invalid| {
        try std.testing.expectError(error.InvalidUsageArgs, parseUsageArgs(invalid));
    }
}

test "global launch modifiers preserve repeatable context limits before the command" {
    var parsed = try parseGlobalLaunchArgs(std.testing.allocator, &.{
        @constCast("--context-limit"),
        @constCast("skill_chunk_bytes=4096"),
        @constCast("--context-limit=mcp_description_bytes=off"),
        @constCast("ask"),
        @constCast("hello"),
    });
    defer parsed.deinit(std.testing.allocator);

    try std.testing.expectEqual(@as(usize, 2), parsed.modifiers.context_limit_overrides.len);
    try std.testing.expectEqual(config_runtime.context_limits.Name.skill_chunk_bytes, parsed.modifiers.context_limit_overrides[0].name);
    try std.testing.expectEqual(@as(usize, 4096), parsed.modifiers.context_limit_overrides[0].value.bytes);
    try std.testing.expectEqual(config_runtime.context_limits.Name.mcp_description_bytes, parsed.modifiers.context_limit_overrides[1].name);
    try std.testing.expect(parsed.modifiers.context_limit_overrides[1].value == .off);
    try std.testing.expectEqualStrings("ask", parsed.remaining[0]);
    try std.testing.expectEqualStrings("hello", parsed.remaining[1]);
}

test "global context limits reject missing values and stop at the command" {
    try std.testing.expectError(
        error.MissingContextLimitValue,
        parseGlobalLaunchArgs(std.testing.allocator, &.{@constCast("--context-limit")}),
    );
    var parsed = try parseGlobalLaunchArgs(std.testing.allocator, &.{
        @constCast("ask"),
        @constCast("--context-limit"),
        @constCast("skill_chunk_bytes=1"),
    });
    defer parsed.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), parsed.modifiers.context_limit_overrides.len);
    try std.testing.expectEqual(@as(usize, 3), parsed.remaining.len);
}

test "global launch modifiers own repeatable additional directories and suppression" {
    var parsed = try parseGlobalLaunchArgs(std.testing.allocator, &.{
        @constCast("--add-dir"),
        @constCast("/tmp/shared one"),
        @constCast("--context-limit=skill_chunk_bytes=2048"),
        @constCast("--add-dir=/tmp/shared-two"),
        @constCast("--no-additional-dirs"),
        @constCast("ask"),
        @constCast("inspect"),
    });
    defer parsed.deinit(std.testing.allocator);

    try std.testing.expectEqual(@as(usize, 2), parsed.modifiers.additional_directories.len);
    try std.testing.expectEqualStrings("/tmp/shared one", parsed.modifiers.additional_directories[0]);
    try std.testing.expectEqualStrings("/tmp/shared-two", parsed.modifiers.additional_directories[1]);
    try std.testing.expect(parsed.modifiers.saved_directories_suppressed);
    try std.testing.expectEqualStrings("ask", parsed.remaining[0]);
}

test "additional directory flags fail closed when malformed" {
    try std.testing.expectError(
        error.MissingAddDirectoryValue,
        parseGlobalLaunchArgs(std.testing.allocator, &.{@constCast("--add-dir")}),
    );
    try std.testing.expectError(
        error.MissingAddDirectoryValue,
        parseGlobalLaunchArgs(std.testing.allocator, &.{@constCast("--add-dir=")}),
    );
    try std.testing.expectError(
        error.DuplicateAdditionalDirectorySuppression,
        parseGlobalLaunchArgs(std.testing.allocator, &.{ @constCast("--no-additional-dirs"), @constCast("--no-additional-dirs") }),
    );
}

test "parse local surface args accepts only json" {
    const empty = try parseLocalSurfaceArgs(&.{});
    try std.testing.expectEqual(output_contracts.OutputFormat.text, empty.format);

    const opts = try parseLocalSurfaceArgs(&.{@constCast("--json")});
    try std.testing.expectEqual(output_contracts.OutputFormat.json, opts.format);

    try std.testing.expectError(error.InvalidLocalSurfaceArgs, parseLocalSurfaceArgs(&.{@constCast("--wat")}));
}

test "parse session list args supports bounded canonical pagination" {
    const empty = try parseSessionListArgs(&.{});
    try std.testing.expectEqual(output_contracts.OutputFormat.text, empty.format);
    try std.testing.expectEqual(session_store.session_list_default_limit, empty.limit);
    try std.testing.expect(empty.continuation == null);

    const paged = try parseSessionListArgs(&.{
        @constCast("--json"),
        @constCast("--all"),
        @constCast("--limit"),
        @constCast("2"),
        @constCast("--continuation"),
        @constCast("v1:20:session-a"),
    });
    try std.testing.expectEqual(output_contracts.OutputFormat.json, paged.format);
    try std.testing.expectEqual(session_store.SessionListScope.all_workspaces, paged.scope);
    try std.testing.expectEqual(@as(usize, 2), paged.limit);
    try std.testing.expectEqual(@as(i64, 20), paged.continuation.?.updated_at_ms);
    try std.testing.expectEqualStrings("session-a", paged.continuation.?.id);

    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--all"), @constCast("--all") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--limit"), @constCast("0") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--limit"), @constCast("101") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--limit"), @constCast("2"), @constCast("--limit"), @constCast("3") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{@constCast("--continuation")}),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--continuation"), @constCast("v1:020:session-a") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--continuation"), @constCast("v2:20:session-a") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--continuation"), @constCast("v1:20:../unsafe") }),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{@constCast("--cursor")}),
    );
    try std.testing.expectError(
        error.InvalidLocalSurfaceArgs,
        parseSessionListArgs(&.{ @constCast("--cursor"), @constCast("v1:20:session-a") }),
    );
}

test "parse session detail args owns string ids and frees through deinit" {
    var latest = try parseSessionDetailArgs(std.testing.allocator, &.{ @constCast("last"), @constCast("--json") });
    defer latest.deinit(std.testing.allocator);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, latest.format);
    try std.testing.expectEqual(SessionDetailTarget.last, latest.target.?);

    var specific = try parseSessionDetailArgs(std.testing.allocator, &.{@constCast(" sess-1 ")});
    defer specific.deinit(std.testing.allocator);
    switch (specific.target.?) {
        .id => |value| try std.testing.expectEqualStrings("sess-1", value),
        else => return error.TestExpectedEqual,
    }

    try std.testing.expectError(error.InvalidSessionDetailArgs, parseSessionDetailArgs(std.testing.allocator, &.{ @constCast("a"), @constCast("b") }));
    try std.testing.expectError(error.InvalidSessionDetailArgs, parseSessionDetailArgs(std.testing.allocator, &.{@constCast("")}));
}

test "parse session detail args accepts explicit id flag" {
    var specific = try parseSessionDetailArgs(std.testing.allocator, &.{
        @constCast("--id"),
        @constCast("release.2026.06"),
        @constCast("--json"),
    });
    defer specific.deinit(std.testing.allocator);

    try std.testing.expectEqual(output_contracts.OutputFormat.json, specific.format);
    switch (specific.target.?) {
        .last => return error.TestExpectedExactResumeId,
        .id => |id| try std.testing.expectEqualStrings("release.2026.06", id),
    }
}

test "parse session detail args treats last after id flag as exact id" {
    var specific = try parseSessionDetailArgs(std.testing.allocator, &.{
        @constCast("--id"),
        @constCast("last"),
    });
    defer specific.deinit(std.testing.allocator);

    switch (specific.target.?) {
        .last => return error.TestExpectedExactResumeId,
        .id => |id| try std.testing.expectEqualStrings("last", id),
    }
}

test "parse session recovery args accepts exact ids and rejects ambiguity" {
    var positional = try parseSessionRecoveryArgs(
        std.testing.allocator,
        &.{
            @constCast("session.v3"),
            @constCast("--json"),
        },
    );
    defer positional.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("session.v3", positional.session_id);
    try std.testing.expectEqual(
        output_contracts.OutputFormat.json,
        positional.format,
    );

    var exact = try parseSessionRecoveryArgs(
        std.testing.allocator,
        &.{
            @constCast("--id"),
            @constCast("last"),
        },
    );
    defer exact.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("last", exact.session_id);

    try std.testing.expectError(
        error.InvalidSessionRecoveryArgs,
        parseSessionRecoveryArgs(
            std.testing.allocator,
            &.{@constCast("--id")},
        ),
    );
    try std.testing.expectError(
        error.InvalidSessionRecoveryArgs,
        parseSessionRecoveryArgs(
            std.testing.allocator,
            &.{
                @constCast("first"),
                @constCast("second"),
            },
        ),
    );
}

test "parse resume args defaults to last owns ids and rejects invalid input" {
    const implicit = try parseResumeArgs(std.testing.allocator, &.{});
    try std.testing.expectEqual(ResumeTarget.last, implicit);

    const explicit = try parseResumeArgs(std.testing.allocator, &.{@constCast("last")});
    try std.testing.expectEqual(ResumeTarget.last, explicit);

    var target = try parseResumeArgs(std.testing.allocator, &.{@constCast(" session-123 ")});
    defer target.deinit(std.testing.allocator);
    switch (target) {
        .id => |value| try std.testing.expectEqualStrings("session-123", value),
        else => return error.TestExpectedEqual,
    }

    try std.testing.expectError(error.InvalidResumeArgs, parseResumeArgs(std.testing.allocator, &.{ @constCast("a"), @constCast("b") }));
    try std.testing.expectError(error.InvalidResumeArgs, parseResumeArgs(std.testing.allocator, &.{@constCast("   ")}));
    try std.testing.expectError(error.InvalidResumeArgs, parseResumeArgs(std.testing.allocator, &.{@constCast("--wat")}));
    try std.testing.expectError(error.InvalidResumeArgs, parseResumeArgs(std.testing.allocator, &.{@constCast("--bogus")}));
    try std.testing.expectError(error.InvalidResumeArgs, parseResumeArgs(std.testing.allocator, &.{@constCast("--json")}));
}

test "parse session subcommands require explicit show rename and remove forms" {
    const alloc = std.testing.allocator;

    var show = try parseSessionDetailArgs(alloc, &.{ @constCast("last"), @constCast("--json") });
    defer show.deinit(alloc);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, show.format);
    try std.testing.expectEqual(SessionDetailTarget.last, show.target.?);

    var rename = try parseSessionRenameArgs(alloc, &.{
        @constCast("session-a"),
        @constCast("deploy"),
        @constCast("pipeline"),
    });
    defer rename.deinit(alloc);
    try std.testing.expectEqualStrings("session-a", rename.session_id);
    try std.testing.expectEqualStrings("deploy pipeline", rename.title);

    var remove = try parseSessionRemoveArgs(alloc, &.{ @constCast("--id"), @constCast("session-b") });
    defer remove.deinit(alloc);
    try std.testing.expectEqualStrings("session-b", remove.session_id);

    try std.testing.expectError(
        error.InvalidSessionRenameArgs,
        parseSessionRenameArgs(alloc, &.{@constCast("session-a")}),
    );
    try std.testing.expectError(
        error.InvalidSessionRemoveArgs,
        parseSessionRemoveArgs(alloc, &.{}),
    );
}

test "runIfRequested bare session target is a usage error" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("session"), @constCast("session-a") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
}

test "runIfRequested resume rejects json flags" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("resume"), @constCast("--json") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings(
        "usage: fiber session resume [last|<id>] | session resume --id <id> | resume [last|<id>] | resume --id <id>\n",
        capture.stderr.written(),
    );
}

test "parse resume args accepts explicit id flag" {
    var target = try parseResumeArgs(std.testing.allocator, &.{
        @constCast("--id"),
        @constCast("release.2026.06"),
    });
    defer target.deinit(std.testing.allocator);

    switch (target) {
        .pick, .last => return error.TestExpectedExactResumeId,
        .id => |id| try std.testing.expectEqualStrings("release.2026.06", id),
    }
}

test "parse resume args treats last after id flag as exact id" {
    var target = try parseResumeArgs(std.testing.allocator, &.{
        @constCast("--id"),
        @constCast("last"),
    });
    defer target.deinit(std.testing.allocator);

    switch (target) {
        .pick, .last => return error.TestExpectedExactResumeId,
        .id => |id| try std.testing.expectEqualStrings("last", id),
    }
}

test "parseInteractiveLaunch shares native resume grammar" {
    const alloc = std.testing.allocator;
    const command_catalog = testCommandCatalog();
    const cases = [_]struct {
        args: []const [:0]const u8,
        expected_id: ?[]const u8,
    }{
        .{ .args = &.{ @constCast("session"), @constCast("resume"), @constCast("last") }, .expected_id = null },
        .{ .args = &.{ @constCast("session"), @constCast("resume"), @constCast("--id"), @constCast("session.v3") }, .expected_id = "session.v3" },
    };
    for (cases) |case| {
        const parsed = try parseInteractiveLaunch(alloc, case.args, command_catalog);
        switch (parsed) {
            .interactive => |value| {
                var launch = value;
                defer launch.deinit(alloc);
                const target = launch.requested_resume orelse return error.TestExpectedResumeTarget;
                if (case.expected_id) |expected_id| switch (target) {
                    .id => |id| try std.testing.expectEqualStrings(expected_id, id),
                    .pick, .last => return error.TestExpectedExactResumeId,
                } else try std.testing.expectEqual(ResumeTarget.last, target);
            },
            .noninteractive => |value| {
                var noninteractive = value;
                defer noninteractive.deinit(alloc);
                return error.TestExpectedInteractiveLaunch;
            },
        }
    }

    try std.testing.expectError(
        error.MissingAddDirectoryValue,
        parseInteractiveLaunch(alloc, &.{@constCast("--add-dir")}, command_catalog),
    );
}

test "runIfRequested help writes top-level help" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("help")}, testConfig(), capture.deps());
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expect(std.mem.startsWith(u8, capture.stdout.written(), "fiber v0.0.0\nFast, native coding agent for the terminal."));
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), testConfig().version) != null);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "top-level MCP add mutates through the focused provider without startup" {
    const alloc = std.testing.allocator;
    var capture = CaptureOutput.init(alloc);
    defer capture.deinit();
    var cfg = testConfig();
    cfg.add_mcp_profile_server = captureMcpProfileAddForTest;
    mcp_profile_add_calls_for_test = 0;
    var deps = capture.deps();
    deps.load_startup_state = failingStartupState;

    const result = try runIfRequestedWithDeps(
        alloc,
        &.{
            @constCast("mcp"),
            @constCast("add"),
            @constCast("fixture"),
            @constCast("node"),
            @constCast("server.js"),
        },
        cfg,
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expectEqual(@as(usize, 1), mcp_profile_add_calls_for_test);
    try std.testing.expectEqualStrings(
        "Saved MCP server 'fixture' to /tmp/test-home/.fiber/mcp.json.\n",
        capture.stdout.written(),
    );
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "top-level MCP list loads configuration without discovery and remove uses its provider" {
    const alloc = std.testing.allocator;
    {
        var capture = CaptureOutput.init(alloc);
        defer capture.deinit();
        var cfg = testConfig();
        cfg.load_mcp_runtime = configuredMcpRuntimeForTest;
        var deps = capture.deps();
        deps.load_startup_state_without_credentials = stubLoadStartupStateWithoutCredentials;

        const result = try runIfRequestedWithDeps(
            alloc,
            &.{ @constCast("mcp"), @constCast("list") },
            cfg,
            deps,
        );
        try std.testing.expectEqual(RunResult.handled_success, result);
        try std.testing.expect(std.mem.find(
            u8,
            capture.stdout.written(),
            "fixture source=profile scope=profile",
        ) != null);
        try std.testing.expect(std.mem.find(
            u8,
            capture.stdout.written(),
            "state=disconnected",
        ) != null);
        try std.testing.expectEqualStrings("", capture.stderr.written());
    }

    {
        var capture = CaptureOutput.init(alloc);
        defer capture.deinit();
        var cfg = testConfig();
        cfg.remove_mcp_profile_server = captureMcpProfileRemoveForTest;
        mcp_profile_remove_calls_for_test = 0;

        const result = try runIfRequestedWithDeps(
            alloc,
            &.{ @constCast("mcp"), @constCast("remove"), @constCast("fixture") },
            cfg,
            capture.deps(),
        );
        try std.testing.expectEqual(RunResult.handled_success, result);
        try std.testing.expectEqual(@as(usize, 1), mcp_profile_remove_calls_for_test);
        try std.testing.expectEqualStrings(
            "Removed MCP server 'fixture' from /tmp/test-home/.fiber/mcp.json.\n",
            capture.stdout.written(),
        );
        try std.testing.expectEqualStrings("", capture.stderr.written());
    }
}

test "top-level MCP trust persists project approval without interactive startup" {
    const alloc = std.testing.allocator;
    const workspace_root = try io_mod.realpathAlloc(alloc, ".");
    defer alloc.free(workspace_root);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(home);
    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    try environ.put("PATH", "");
    const stable_environ = try stableCliTestEnviron();
    io_mod.setEnvironMap(&environ);
    defer io_mod.setEnvironMap(stable_environ);

    var capture = CaptureOutput.init(alloc);
    defer capture.deinit();
    var deps = capture.deps();
    deps.load_startup_state_without_credentials = failingStartupStateWithoutCredentials;

    const result = try runIfRequestedWithDeps(
        alloc,
        &.{ @constCast("mcp"), @constCast("trust"), @constCast("approve"), @constCast("fixture") },
        testConfig(),
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_success, result);
    const expected = try std.fmt.allocPrint(
        alloc,
        "Approved project MCP server 'fixture' for {s}.\n",
        .{workspace_root},
    );
    defer alloc.free(expected);
    try std.testing.expectEqualStrings(expected, capture.stdout.written());
    try std.testing.expectEqualStrings("", capture.stderr.written());

    var choices = try config_runtime.loadProjectMcpChoices(alloc, workspace_root);
    defer choices.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 1), choices.choices.approved.len);
    try std.testing.expectEqualStrings("fixture", choices.choices.approved[0]);
}

test "workspace launch modifiers preserve supported command help" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    const deps = capture.deps();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("--add-dir"), @constCast("/tmp/shared"), @constCast("ask"), @constCast("--help") },
        testConfig(),
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expect(std.mem.startsWith(u8, capture.stdout.written(), "fiber ask\n\n"));
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "workspace launch modifiers still reject unsupported local command help" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    const deps = capture.deps();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("--add-dir"), @constCast("/tmp/shared"), @constCast("status"), @constCast("--help") },
        testConfig(),
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings("", capture.stdout.written());
    try std.testing.expect(std.mem.find(u8, capture.stderr.written(), "only supported for interactive, resume, and ask launches") != null);
}

test "global workspace launch option errors use user-facing copy" {
    const cases = [_]struct {
        args: []const [:0]const u8,
        expected: []const u8,
    }{
        .{
            .args = &.{@constCast("--add-dir")},
            .expected = "fiber: --add-dir requires a directory path\n",
        },
        .{
            .args = &.{ @constCast("--no-additional-dirs"), @constCast("--no-additional-dirs") },
            .expected = "fiber: --no-additional-dirs may only be specified once\n",
        },
    };

    for (cases) |case| {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();
        const deps = capture.deps();

        const result = try runIfRequestedWithDeps(std.testing.allocator, case.args, testConfig(), deps);
        try std.testing.expectEqual(RunResult.handled_usage_error, result);
        try std.testing.expectEqualStrings("", capture.stdout.written());
        try std.testing.expect(std.mem.startsWith(u8, capture.stderr.written(), case.expected));
        try std.testing.expect(std.mem.endsWith(u8, capture.stderr.written(), "<command>\n"));
    }
}

test "runIfRequested version flags write configured version" {
    const cases = [_][]const [:0]const u8{
        &.{@constCast("--version")},
        &.{@constCast("-v")},
    };

    for (cases) |args| {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();

        const result = try runIfRequestedWithDeps(std.testing.allocator, args, testConfig(), capture.deps());
        try std.testing.expectEqual(RunResult.handled_success, result);
        try std.testing.expectEqualStrings("0.0.0\n", capture.stdout.written());
        try std.testing.expectEqualStrings("", capture.stderr.written());
    }
}

test "runIfRequested version flags reject extra args" {
    const cases = [_][]const [:0]const u8{
        &.{ @constCast("--version"), @constCast("extra") },
        &.{ @constCast("-v"), @constCast("extra") },
    };

    for (cases) |args| {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();

        const result = try runIfRequestedWithDeps(std.testing.allocator, args, testConfig(), capture.deps());
        try std.testing.expectEqual(RunResult.handled_usage_error, result);
        try std.testing.expectEqualStrings("", capture.stdout.written());
        try std.testing.expectEqualStrings("usage: fiber --version\n", capture.stderr.written());
    }
}

test "workspace indeterminate errors report the reconciled durable state" {
    const cases = [_]struct {
        reconciliation: workspace_commands.Reconciliation,
        expected: []const u8,
    }{
        .{
            .reconciliation = .{ .intended = .{} },
            .expected = "reloaded settings match the requested update",
        },
        .{
            .reconciliation = .{ .previous = .{} },
            .expected = "reloaded settings match the previous state",
        },
        .{
            .reconciliation = .unconfirmed,
            .expected = "reloaded settings match neither the requested nor previous state",
        },
    };

    for (cases) |case| {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();
        try writeWorkspaceIndeterminateError(
            std.testing.allocator,
            capture.deps(),
            &.{@constCast("--json")},
            case.reconciliation,
        );
        try std.testing.expect(std.mem.find(u8, capture.stdout.written(), case.expected) != null);
        try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"code\":\"SettingsCommitIndeterminate\"") != null);
        try std.testing.expectEqualStrings("", capture.stderr.written());
    }
}

test "workspace json errors keep stable codes with shared user-facing copy" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try writeWorkspaceCommandError(
        std.testing.allocator,
        testCommandCatalog(),
        capture.deps(),
        &.{@constCast("--json")},
        error.PrimaryDirectory,
    );
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"error\":\"the primary workspace cannot be added or removed\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"code\":\"PrimaryDirectory\"") != null);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "workspace unknown directory errors keep stable json codes" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try writeWorkspaceCommandError(
        std.testing.allocator,
        testCommandCatalog(),
        capture.deps(),
        &.{@constCast("--json")},
        error.UnknownAdditionalDirectory,
    );
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"error\":\"directory is not configured as an additional workspace\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"code\":\"UnknownAdditionalDirectory\"") != null);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "runIfRequested rejects removed record flag as unknown input" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try std.testing.expectError(
        error.UnknownCliCommand,
        runIfRequestedWithDeps(
            std.testing.allocator,
            &.{@constCast("--record")},
            testConfig(),
            capture.deps(),
        ),
    );

    try std.testing.expect(std.mem.find(u8, capture.stderr.written(), "fiber: unknown subcommand: --record") != null);
}

test "runNoConfigIfRequested handles help without config" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try std.testing.expect(try runNoConfigIfRequestedWithDeps(
        std.testing.allocator,
        &.{@constCast("help")},
        "0.0.0",
        testCommandCatalog(),
        capture.deps(),
    ));
    try std.testing.expect(std.mem.startsWith(u8, capture.stdout.written(), "fiber v0.0.0\nFast, native coding agent for the terminal."));
    try std.testing.expectEqualStrings("", capture.stderr.written());

    try std.testing.expect(!try runNoConfigIfRequestedWithDeps(
        std.testing.allocator,
        &.{@constCast("status")},
        "0.0.0",
        testCommandCatalog(),
        capture.deps(),
    ));
}

test "CLI surface uses the supplied command catalog for parsing usage and help" {
    const specs = [_]command_specs.TopLevelSpec{
        .{
            .kind = .help,
            .token = "guide",
            .aliases = &.{"-?"},
            .usage = "guide",
            .summary = "Show injected help",
        },
    };
    const help_groups = [_]command_specs.TopLevelHelpGroup{
        .{ .entries = &.{
            .{ .kind = .help, .usage = "guide" },
        } },
    };
    const command_catalog = CommandCatalog{
        .specs = &specs,
        .description = "Injected command catalog.",
        .interactive_hint = "Injected interactive hint.",
        .help_groups = &help_groups,
    };

    try std.testing.expectEqual(Command.help, parse(command_catalog, &.{@constCast("-?")}));
    switch (parse(command_catalog, &.{@constCast("bogus")})) {
        .unknown => {},
        else => return error.TestExpectedEqual,
    }

    var help_capture = CaptureOutput.init(std.testing.allocator);
    defer help_capture.deinit();
    try std.testing.expect(try runNoConfigIfRequestedWithDeps(
        std.testing.allocator,
        &.{@constCast("guide")},
        "1.2.3",
        command_catalog,
        help_capture.deps(),
    ));
    try std.testing.expect(std.mem.find(u8, help_capture.stdout.written(), "Injected command catalog.") != null);

    var usage_capture = CaptureOutput.init(std.testing.allocator);
    defer usage_capture.deinit();
    var cfg = testConfig();
    cfg.command_catalog = command_catalog;
    try std.testing.expectError(error.UnknownCliCommand, runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("bogus"), @constCast("unexpected") },
        cfg,
        usage_capture.deps(),
    ));
    try std.testing.expect(std.mem.find(u8, usage_capture.stderr.written(), "fiber: unknown subcommand: bogus") != null);
    try std.testing.expect(std.mem.find(u8, usage_capture.stderr.written(), "Injected command catalog.") != null);
}

test "workflow config does not carry placeholder gateway tools" {
    const skill_roots = [_]skill_contract.RootSpec{
        .{ .source = .workspace_shared, .path = "skills" },
    };
    var surface_cfg = testConfig();
    surface_cfg.skill_root_policy.workspace_roots = &skill_roots;
    const cfg = workflowConfig(surface_cfg);
    try std.testing.expect(!@hasField(@TypeOf(cfg), "gateway_tools_json"));
    try std.testing.expect(!@hasField(@TypeOf(cfg), "context_registry"));
    try std.testing.expectEqualStrings("test-model", cfg.default_model);
    try std.testing.expectEqualStrings("surface", cfg.mode_registry.default_mode_id);
    try std.testing.expectEqualStrings("skills", cfg.skill_root_policy.workspace_roots[0].path);
    try std.testing.expect(cfg.load_mcp_runtime == noMcpRuntimeForTest);
}
test "runIfRequested invalid local flags write usage" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("status"), @constCast("--wat") }, testConfig(), capture.deps());
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings("", capture.stdout.written());
    try std.testing.expectEqualStrings("usage: fiber status [--json]\n", capture.stderr.written());
}

test "runIfRequested invalid json local flags write json error" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("status"), @constCast("--json"), @constCast("--wat") }, testConfig(), capture.deps());
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings("", capture.stderr.written());
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"kind\":\"status\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"code\":\"InvalidLocalSurfaceArgs\"") != null);
}

test "runIfRequested resume no args returns last target" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("resume")}, testConfig(), capture.deps());
    switch (result) {
        .interactive => |launch| try std.testing.expectEqual(ResumeTarget.last, launch.requested_resume.?),
        else => return error.TestExpectedEqual,
    }
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "runIfRequested continue returns last target like bare resume" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("continue")}, testConfig(), capture.deps());
    switch (result) {
        .interactive => |launch| try std.testing.expectEqual(ResumeTarget.last, launch.requested_resume.?),
        else => return error.TestExpectedEqual,
    }
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "runIfRequested continue rejects extra arguments" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("continue"), @constCast("session.v3") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings("usage: fiber continue\n", capture.stderr.written());
}

test "runIfRequested continue rejects json flags" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("continue"), @constCast("--json") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings("usage: fiber continue\n", capture.stderr.written());
}

test "runIfRequested resume id returns owned id" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("resume"), @constCast("abc123") }, testConfig(), capture.deps());
    switch (result) {
        .interactive => |launch_value| {
            var launch = launch_value;
            defer launch.deinit(std.testing.allocator);
            switch (launch.requested_resume.?) {
                .id => |value| try std.testing.expectEqualStrings("abc123", value),
                else => return error.TestExpectedEqual,
            }
        },
        else => return error.TestExpectedEqual,
    }
}

test "runIfRequested invalid resume writes usage" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("resume"), @constCast("a"), @constCast("b") }, testConfig(), capture.deps());
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expectEqualStrings(
        "usage: fiber session resume [last|<id>] | session resume --id <id> | resume [last|<id>] | resume --id <id>\n",
        capture.stderr.written(),
    );
}

test "runIfRequested unknown command writes header and help" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try std.testing.expectError(
        error.UnknownCliCommand,
        runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("wat")}, testConfig(), capture.deps()),
    );
    try std.testing.expect(std.mem.startsWith(u8, capture.stderr.written(), "fiber: unknown subcommand: wat\n\nfiber v0.0.0\nFast, native coding agent for the terminal.\n"));
}

test "runIfRequested bare version subcommand remains unknown" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try std.testing.expectError(
        error.UnknownCliCommand,
        runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("version")}, testConfig(), capture.deps()),
    );
    try std.testing.expect(std.mem.startsWith(u8, capture.stderr.written(), "fiber: unknown subcommand: version\n\nfiber v0.0.0\nFast, native coding agent for the terminal.\n"));
}

test "runIfRequested model fetch failure is handled" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    var probe = ModelFetchProbe{ .outcome = .failure };
    var cfg = testConfig();
    cfg.provider_set.codex.cli_model_catalog = probe.provider();

    var deps = capture.deps();
    deps.load_startup_state = failingStartupState;
    deps.load_catalog_startup_state = stubLoadCatalogStartupState;

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("models")}, cfg, deps);
    try std.testing.expectEqual(RunResult.handled_failure, result);
    try std.testing.expectEqualStrings(
        "fiber models: could not list models: Unavailable\n",
        capture.stderr.written(),
    );
}

test "runIfRequested model fetch failure preserves json output" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    var probe = ModelFetchProbe{ .outcome = .failure };
    var cfg = testConfig();
    cfg.provider_set.codex.cli_model_catalog = probe.provider();

    var deps = capture.deps();
    deps.load_catalog_startup_state = stubLoadCatalogStartupState;

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("models"), @constCast("--json") },
        cfg,
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_failure, result);
    try std.testing.expectEqualStrings(
        "{\"ok\":false,\"kind\":\"models\",\"error\":\"could not list models: Unavailable\",\"code\":\"Unavailable\"}\n",
        capture.stdout.written(),
    );
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "runIfRequested model provider cancellation is handled" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    var probe = ModelFetchProbe{ .outcome = .cancelled };
    var cfg = testConfig();
    cfg.provider_set.codex.cli_model_catalog = probe.provider();

    var deps = capture.deps();
    deps.load_catalog_startup_state = stubLoadCatalogStartupState;

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{@constCast("models")}, cfg, deps);
    try std.testing.expectEqual(RunResult.handled_failure, result);
    try std.testing.expectEqualStrings(
        "fiber models: could not list models: the request was cancelled\n",
        capture.stderr.written(),
    );
}

test "runIfRequested models passes startup team to fetch seam" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    var probe = ModelFetchProbe{};
    var cfg = testConfig();
    cfg.provider_set.codex.cli_model_catalog = probe.provider();

    var deps = capture.deps();
    deps.load_catalog_startup_state = stubLoadCatalogStartupState;

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("models"), @constCast("--json") }, cfg, deps);
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expect(probe.called);
    try std.testing.expectEqualStrings(
        "{\"ok\":true,\"kind\":\"models\",\"data\":{\"count\":1,\"shown_count\":1,\"more_count\":0,\"private_models_hidden\":false,\"ids\":[\"private/blue-hornbill\"]}}\n",
        capture.stdout.written(),
    );
}

test "runIfRequested local json success appends exactly one newline" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    var deps = capture.deps();
    deps.load_startup_status = stubLoadStartupStatus;

    const result = try runIfRequestedWithDeps(std.testing.allocator, &.{ @constCast("status"), @constCast("--json") }, testConfig(), deps);
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expectEqualStrings(
        "{\"ok\":true,\"kind\":\"status\",\"data\":{\"model\":\"test-model\",\"update_channel\":\"stable\",\"build_channel\":\"stable\",\"build_revision\":\"\",\"auth\":\"missing\",\"connected_providers\":[],\"auth_refreshable\":false,\"auth_help\":\"fiber needs a Codex subscription login for this model. Run fiber login codex.\",\"permission_mode\":\"auto\",\"workspace\":\"/tmp/fiber\",\"history_turns\":0,\"session_permission_grants\":0,\"agent_step_limit\":42,\"mcp\":{\"connection_check\":\"not_checked\",\"servers\":[],\"configuration_issues\":[],\"inspection_error\":null}}}\n",
        capture.stdout.written(),
    );
    try std.testing.expect(!std.mem.endsWith(u8, capture.stdout.written(), "\n\n"));
}

test "status and doctor inspect MCP configuration once per command" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    try environ.put("PATH", "");
    const stable_environ = try stableCliTestEnviron();
    io_mod.setEnvironMap(&environ);
    defer io_mod.setEnvironMap(stable_environ);

    mcp_local_inspection_calls_for_test = 0;
    var cfg = testConfig();
    cfg.inspect_mcp_local_config = failingMcpLocalInspectionForTest;

    var status_capture = CaptureOutput.init(alloc);
    defer status_capture.deinit();
    var status_deps = status_capture.deps();
    status_deps.load_startup_status = stubLoadStartupStatus;
    const status_result = try runIfRequestedWithDeps(
        alloc,
        &.{ @constCast("status"), @constCast("--json") },
        cfg,
        status_deps,
    );
    try std.testing.expectEqual(RunResult.handled_success, status_result);
    try std.testing.expectEqual(@as(usize, 1), mcp_local_inspection_calls_for_test);
    try std.testing.expect(std.mem.find(
        u8,
        status_capture.stdout.written(),
        "\"mcp_config_error\":\"McpConfigInvalidJson\"",
    ) != null);

    mcp_local_inspection_calls_for_test = 0;
    var doctor_capture = CaptureOutput.init(alloc);
    defer doctor_capture.deinit();
    const doctor_result = try runIfRequestedWithDeps(
        alloc,
        &.{ @constCast("doctor"), @constCast("--json") },
        cfg,
        doctor_capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_success, doctor_result);
    try std.testing.expectEqual(@as(usize, 1), mcp_local_inspection_calls_for_test);
    try std.testing.expectEqual(
        @as(usize, 1),
        std.mem.count(
            u8,
            doctor_capture.stdout.written(),
            "\"name\":\"mcp_config\"",
        ),
    );
    try std.testing.expect(std.mem.find(
        u8,
        doctor_capture.stdout.written(),
        "\"detail\":\"failed to load ~/.fiber/mcp.json: McpConfigInvalidJson\"",
    ) != null);
}

test "writeRenderedJsonLine falls back to heap and appends exactly one newline" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    var tiny_buf: [8]u8 = undefined;
    const startup = app_lifecycle.StartupStatus{
        .workspace_root = @constCast("/tmp/fiber"),
        .selected_model = "test-model",
        .permission_mode = .ask,
        .agent_step_limit = 42,
    };

    try writeRenderedJsonLine(
        std.testing.allocator,
        capture.deps(),
        tiny_buf[0..],
        .{ .status = statusSnapshotFromStartup(startup) },
    );

    try std.testing.expectEqualStrings(
        "{\"ok\":true,\"kind\":\"status\",\"data\":{\"model\":\"test-model\",\"update_channel\":\"stable\",\"build_channel\":\"stable\",\"build_revision\":\"\",\"auth\":\"missing\",\"connected_providers\":[],\"auth_refreshable\":false,\"auth_help\":\"fiber needs a Codex subscription login for this model. Run fiber login codex.\",\"permission_mode\":\"ask\",\"workspace\":\"/tmp/fiber\",\"history_turns\":0,\"session_permission_grants\":0,\"agent_step_limit\":42}}\n",
        capture.stdout.written(),
    );
}

test "writeRenderedJsonLine renders doctor json through output contract" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    var checks = [_]doctor_runtime.Check{
        .{ .name = "auth", .status = .ok, .detail = "AI_GATEWAY_API_KEY is configured" },
        .{ .name = "gh", .status = .warn, .detail = "GitHub CLI not found in PATH" },
    };
    const snapshot = doctor_runtime.Snapshot{
        .workspace_root = @constCast("/tmp/fiber"),
        .model = "test-model",
        .auth = .{ .active_source = .chatgpt_subscription },
        .permission_mode = .auto,
        .agent_step_limit = 42,
        .checks = checks[0..],
    };

    var tiny_buf: [8]u8 = undefined;
    try writeRenderedJsonLine(
        std.testing.allocator,
        capture.deps(),
        tiny_buf[0..],
        .{ .doctor = doctorSnapshotFromRuntime(snapshot) },
    );

    try std.testing.expectEqualStrings(
        "{\"ok\":true,\"kind\":\"doctor\",\"data\":{\"ok_count\":1,\"warn_count\":1,\"fail_count\":0,\"workspace\":\"/tmp/fiber\",\"model\":\"test-model\",\"auth\":\"Codex subscription\",\"auth_refreshable\":true,\"permission_mode\":\"auto\",\"agent_step_limit\":42,\"checks\":[{\"name\":\"auth\",\"status\":\"ok\",\"detail\":\"AI_GATEWAY_API_KEY is configured\"},{\"name\":\"gh\",\"status\":\"warn\",\"detail\":\"GitHub CLI not found in PATH\"}]}}\n",
        capture.stdout.written(),
    );
}

const CaptureOutput = struct {
    stdout: std.Io.Writer.Allocating,
    stderr: std.Io.Writer.Allocating,

    fn init(alloc: Allocator) CaptureOutput {
        return .{
            .stdout = .init(alloc),
            .stderr = .init(alloc),
        };
    }

    fn deinit(self: *@This()) void {
        self.stdout.deinit();
        self.stderr.deinit();
    }

    fn deps(self: *@This()) RunDeps {
        return .{
            .stdout_ctx = self,
            .stderr_ctx = self,
            .write_stdout = captureStdout,
            .write_stderr = captureStderr,
        };
    }
};

fn captureStdout(ctx: ?*anyopaque, text: []const u8) !void {
    const capture: *CaptureOutput = @ptrCast(@alignCast(ctx.?));
    try capture.stdout.writer.writeAll(text);
}

fn captureStderr(ctx: ?*anyopaque, text: []const u8) !void {
    const capture: *CaptureOutput = @ptrCast(@alignCast(ctx.?));
    try capture.stderr.writer.writeAll(text);
}

fn gatherNoopContextForTest(_: Allocator, _: context_contract.InitialContextInput) context_contract.ProviderError!context_contract.ProviderContext {
    return .{};
}

fn appendNoopStaticContextForTest(_: context_contract.StaticContextInput, _: Allocator, _: *std.ArrayList(types.ChatMessage)) context_contract.ProviderError!void {}

fn appendNoopTransientContextForTest(_: context_contract.TransientContextInput, _: Allocator, _: *std.ArrayList(types.ChatMessage)) context_contract.ProviderError!void {}

const test_surface_context_registry = context_contract.Registry{ .default_provider = .{
    .id = "test.surface_context",
    .gather_project_context_fn = gatherNoopContextForTest,
    .select_applicable_project_context_fn = context_contract.selectNoApplicableProjectContext,
    .append_static_fn = appendNoopStaticContextForTest,
    .append_transient_fn = appendNoopTransientContextForTest,
} };

fn noMcpRuntimeForTest(_: Allocator, _: []const u8, _: @import("../mcp/elicitation.zig").Capabilities) !?*mcp_runtime.McpRuntime {
    return null;
}

fn clearMcpConfigInspectionForTest(
    _: Allocator,
) error{OutOfMemory}!mcp_contract.ProfileConfigDiagnostic {
    return .clear;
}

var mcp_local_inspection_calls_for_test: usize = 0;
var mcp_profile_add_calls_for_test: usize = 0;
var mcp_profile_remove_calls_for_test: usize = 0;

fn captureMcpProfileAddForTest(
    alloc: Allocator,
    intent: mcp_command_provider.AddIntent,
) anyerror!mcp_command_provider.ProfileAddResult {
    mcp_profile_add_calls_for_test += 1;
    switch (intent) {
        .local => |local| {
            try std.testing.expectEqualStrings("fixture", local.name);
            try std.testing.expectEqualStrings("node", local.command);
            try std.testing.expectEqualSlices([]const u8, &.{"server.js"}, local.args);
        },
        .http => return error.TestUnexpectedResult,
    }
    return .{
        .profile_path = try alloc.dupe(u8, "/tmp/test-home/.fiber/mcp.json"),
    };
}

fn captureMcpProfileRemoveForTest(
    alloc: Allocator,
    name: []const u8,
) anyerror!mcp_command_provider.ProfileRemoveResult {
    mcp_profile_remove_calls_for_test += 1;
    try std.testing.expectEqualStrings("fixture", name);
    return .{
        .profile_path = try alloc.dupe(u8, "/tmp/test-home/.fiber/mcp.json"),
        .removed = true,
    };
}

fn configuredMcpRuntimeForTest(
    alloc: Allocator,
    workspace_root: []const u8,
    _: @import("../mcp/elicitation.zig").Capabilities,
) !?*mcp_runtime.McpRuntime {
    try std.testing.expectEqualStrings("/tmp/fiber", workspace_root);
    const runtime = try alloc.create(mcp_runtime.McpRuntime);
    errdefer alloc.destroy(runtime);
    runtime.* = mcp_runtime.McpRuntime.init(alloc);
    errdefer runtime.deinit();
    try runtime.addServer(.{
        .name = try alloc.dupe(u8, "fixture"),
        .command = try alloc.dupe(u8, "node"),
    });
    return runtime;
}

fn failingMcpLocalInspectionForTest(
    alloc: Allocator,
    workspace_root: []const u8,
) error{OutOfMemory}!mcp_health.LocalConfigInspection {
    mcp_local_inspection_calls_for_test += 1;
    var result = try mcp_health.inspectLocalConfigUnavailable(
        alloc,
        workspace_root,
    );
    result.profile_diagnostic = .{ .failed = error.McpConfigInvalidJson };
    result.inspection_error = "McpConfigInvalidJson";
    return result;
}

var stable_cli_test_environ: ?*std.process.Environ.Map = null;

fn stableCliTestEnviron() !*const std.process.Environ.Map {
    if (stable_cli_test_environ) |map| return map;

    const alloc = std.heap.page_allocator;
    const map = try alloc.create(std.process.Environ.Map);
    map.* = std.process.Environ.Map.init(alloc);
    stable_cli_test_environ = map;
    return map;
}

fn testConfig() Config {
    return .{
        .version = "0.0.0",
        .command_catalog = testCommandCatalog(),
        .default_model = "test-model",
        .default_agent_step_limit = 42,
        .models_path = "/v1/models",
        .gateway_retry_count = 1,
        .gateway_provider = test_builtin_gateway.provider,
        .provider_set = provider_set.Set{ .codex = test_builtin_gateway.provider_bundle },
        .url_opener = host.unavailable_url_opener,
        .prompt_policy = .{ .system_prompt = "system" },
        .skill_root_policy = .{ .managed_root_source = .global_fiber },
        .ignored_list_entries = &.{},
        .max_list_entries = 10,
        .max_read_file_bytes = 1024,
        .max_read_file_lines = 100,
        .max_read_file_line_len = 200,
        .max_command_output_bytes = 4096,
        .max_tool_result_bytes = 4096,
        .max_history_turns = 8,
        .context_registry = test_surface_context_registry,
        .mode_registry = .{ .default_mode_id = "surface" },
        .inspect_mcp_profile_config = clearMcpConfigInspectionForTest,
        .load_mcp_runtime = noMcpRuntimeForTest,
        .tool_set = .{
            .registry = .{ .tools = &.{} },
            .order = &.{},
            .read_only_tool_names = &.{},
        },
    };
}

fn stubLoadStartupState(
    alloc: Allocator,
    _: oauth_transport.Provider,
    default_model: []const u8,
    default_agent_step_limit: usize,
) !app_lifecycle.StartupState {
    var state = app_lifecycle.StartupState{ .agent_step_limit = default_agent_step_limit };
    errdefer state.deinit(alloc);
    state.workspace_root = try alloc.dupe(u8, "/tmp/fiber");
    state.selected_model = try alloc.dupe(u8, default_model);
    state.credential = .{
        .token = try alloc.dupe(u8, "test-key"),
        .source = .chatgpt_subscription,
    };
    return state;
}

fn stubLoadStartupStateWithoutCredentials(
    alloc: Allocator,
    _: []const u8,
    default_agent_step_limit: usize,
) !app_lifecycle.StartupState {
    var state = app_lifecycle.StartupState{
        .agent_step_limit = default_agent_step_limit,
    };
    errdefer state.deinit(alloc);
    state.workspace_root = try alloc.dupe(u8, "/tmp/fiber");
    return state;
}

fn failingStartupStateWithoutCredentials(
    _: Allocator,
    _: []const u8,
    _: usize,
) !app_lifecycle.StartupState {
    return error.StartupShouldNotRun;
}

fn stubLoadCatalogStartupState(
    alloc: Allocator,
    default_model: []const u8,
    default_agent_step_limit: usize,
) !app_lifecycle.StartupState {
    return stubLoadStartupState(alloc, oauth_transport.unavailable_provider, default_model, default_agent_step_limit);
}

fn stubLoadStartupStatus(
    alloc: Allocator,
    default_model: []const u8,
    default_agent_step_limit: usize,
) !app_lifecycle.StartupStatus {
    const workspace_root = try alloc.dupe(u8, "/tmp/fiber");
    errdefer alloc.free(workspace_root);
    const selected_model = try alloc.dupe(u8, default_model);
    errdefer alloc.free(selected_model);
    return .{
        .workspace_root = workspace_root,
        .selected_model = selected_model,
        .owned_selected_model = selected_model,
        .permission_mode = config_runtime.default_permission_mode,
        .agent_step_limit = default_agent_step_limit,
    };
}

fn failingStartupState(
    _: Allocator,
    _: oauth_transport.Provider,
    _: []const u8,
    _: usize,
) !app_lifecycle.StartupState {
    return error.StartupShouldNotRun;
}

const ModelFetchProbe = struct {
    const Outcome = enum {
        success,
        failure,
        cancelled,
    };

    called: bool = false,
    outcome: Outcome = .success,

    fn provider(self: *ModelFetchProbe) gateway_provider.CliModelCatalogProvider {
        return .{
            .context = self,
            .fetch_fn = fetch,
        };
    }

    fn failure(
        input: gateway_provider.CliModelCatalogInput,
        category: model_catalog.FailureCategory,
    ) gateway_provider.CliModelCatalogResult {
        return .{ .failure = .{
            .access = .init(input.access),
            .anonymous_fallback_used = false,
            .failure = .{ .category = category },
        } };
    }

    fn fetch(
        raw: ?*anyopaque,
        alloc: Allocator,
        input: gateway_provider.CliModelCatalogInput,
    ) gateway_provider.CliModelCatalogResult {
        const self: *ModelFetchProbe = @ptrCast(@alignCast(raw.?));
        self.called = true;
        if (!std.mem.eql(u8, input.access.authorizationCredential() orelse "", "test-key") or
            input.access.credentialSource() != .chatgpt_subscription or
            !std.mem.eql(u8, input.endpoint, "/v1/models") or
            input.cancel_flag != null)
        {
            return failure(input, .runtime);
        }

        switch (self.outcome) {
            .failure => return failure(input, .runtime),
            .cancelled => return failure(input, .cancellation),
            .success => {},
        }

        var ids: std.ArrayList([]u8) = .empty;
        const id = alloc.dupe(u8, "private/blue-hornbill") catch {
            return failure(input, .resource_exhausted);
        };
        ids.append(alloc, id) catch {
            alloc.free(id);
            return failure(input, .resource_exhausted);
        };
        return .{ .loaded = .{
            .ids = ids,
            .provenance = .{ .access = .init(input.access) },
        } };
    }
};

const TestTty = struct {
    fn yes(_: ?*anyopaque) bool {
        return true;
    }

    fn no(_: ?*anyopaque) bool {
        return false;
    }
};

test "resolveAuthLoginProvider proceeds without a tty when only one provider exists" {
    // A single provider is unambiguous: `fiber auth login` must proceed without
    // a tty, matching today's `fiber login` (no tty check at all). The tty gate
    // (writeAuthLoginNonInteractiveError) only guards the >1-provider case,
    // which is unreachable while provider_catalog.entries has one entry.
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();
    var deps = capture.deps();
    deps.stdin_is_tty = TestTty.no;

    const provider = try resolveAuthLoginProvider(deps, null);
    try std.testing.expectEqual(model_provider.ProviderId.codex, provider);
    try std.testing.expectEqualStrings("", capture.stderr.written());
}

test "parse routes bare permissions and subcommands separately" {
    const command_catalog = testCommandCatalog();
    switch (parse(command_catalog, &.{@constCast("permissions")})) {
        .permissions => |rest| try std.testing.expectEqual(@as(usize, 0), rest.len),
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("permissions"), @constCast("mode"), @constCast("auto") })) {
        .permissions => |rest| {
            try std.testing.expectEqual(@as(usize, 2), rest.len);
            try std.testing.expectEqualStrings("mode", rest[0]);
            try std.testing.expectEqualStrings("auto", rest[1]);
        },
        else => return error.TestExpectedEqual,
    }
    switch (parse(command_catalog, &.{ @constCast("permissions"), @constCast("rule"), @constCast("list") })) {
        .permissions => |rest| {
            try std.testing.expectEqual(@as(usize, 2), rest.len);
            try std.testing.expectEqualStrings("rule", rest[0]);
            try std.testing.expectEqualStrings("list", rest[1]);
        },
        else => return error.TestExpectedEqual,
    }
}

test "permissions mode argument parsing accepts mode and json" {
    const parsed = try parsePermissionsModeArgs(&.{ @constCast("yolo"), @constCast("--json") });
    try std.testing.expectEqual(types.PermissionMode.yolo, parsed.mode);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, parsed.format);
    try std.testing.expectError(error.InvalidPermissionArgs, parsePermissionsModeArgs(&.{@constCast("wat")}));
}

test "permissions rule add argument parsing accepts scope flags and action" {
    const parsed = try parsePermissionsRuleAddArgs(&.{
        @constCast("--user"),
        @constCast("bash"),
        @constCast("git *"),
        @constCast("allow"),
    });
    try std.testing.expectEqual(config_runtime.PermissionScope.user, parsed.scope);
    try std.testing.expectEqualStrings("bash", parsed.permission);
    try std.testing.expectEqualStrings("git *", parsed.pattern);
    try std.testing.expectEqual(types.PermissionAction.allow, parsed.action);
    try std.testing.expectError(error.InvalidPermissionArgs, parsePermissionsRuleAddArgs(&.{
        @constCast("bash"),
        @constCast("git *"),
        @constCast("wat"),
    }));
}

test "permissions rule add rejects invalid web_fetch pattern" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("permissions"), @constCast("rule"), @constCast("add"), @constCast("web_fetch"), @constCast("example.*"), @constCast("allow"), @constCast("--json") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"code\":\"InvalidPermissionArgs\"") != null);
}

test "auth login rejects --json" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("auth"), @constCast("login"), @constCast("--json") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
}

test "auth list renders provider catalog json" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("auth"), @constCast("list"), @constCast("--json") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"kind\":\"auth.list\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"id\":\"codex\"") != null);
}

test "auth logout argument parsing accepts provider and json" {
    const opts = try parseAuthSurfaceArgs(&.{ @constCast("codex"), @constCast("--json") });
    try std.testing.expectEqual(model_provider.ProviderId.codex, opts.provider.?);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, opts.format);
}

test "parseLoginProvider accepts a single provider token" {
    try std.testing.expectEqual(model_provider.ProviderId.codex, (try parseLoginProvider(&.{@constCast("codex")})).?);
    try std.testing.expect((try parseLoginProvider(&.{})) == null);
    try std.testing.expectError(error.InvalidLoginProviderArgs, parseLoginProvider(&.{ @constCast("codex"), @constCast("extra") }));
}

test "debug replay dispatches through cli replay with exit passthrough" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("debug"), @constCast("replay") },
        testConfig(),
        capture.deps(),
    );
    switch (result) {
        .handled_exit => |code| try std.testing.expectEqual(@as(u8, 2), code),
        else => return error.TestExpectedEqual,
    }
    try std.testing.expect(std.mem.startsWith(
        u8,
        capture.stderr.written(),
        "fiber replay: missing tape path\n",
    ));
}

test "bare replay is no longer a top-level command" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    try std.testing.expectError(error.UnknownCliCommand, runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("replay"), @constCast("tape") },
        testConfig(),
        capture.deps(),
    ));
    try std.testing.expect(std.mem.find(u8, capture.stderr.written(), "fiber: unknown subcommand: replay") != null);
}

test "top-level MCP auth subcommand is no longer recognized" {
    var capture = CaptureOutput.init(std.testing.allocator);
    defer capture.deinit();

    const result = try runIfRequestedWithDeps(
        std.testing.allocator,
        &.{ @constCast("mcp"), @constCast("auth"), @constCast("fixture") },
        testConfig(),
        capture.deps(),
    );
    try std.testing.expectEqual(RunResult.handled_usage_error, result);
}

test "top-level MCP login rejects --json and requires a server name" {
    {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();

        const result = try runIfRequestedWithDeps(
            std.testing.allocator,
            &.{ @constCast("mcp"), @constCast("login"), @constCast("--json") },
            testConfig(),
            capture.deps(),
        );
        try std.testing.expectEqual(RunResult.handled_usage_error, result);
    }
    {
        var capture = CaptureOutput.init(std.testing.allocator);
        defer capture.deinit();

        const result = try runIfRequestedWithDeps(
            std.testing.allocator,
            &.{ @constCast("mcp"), @constCast("login") },
            testConfig(),
            capture.deps(),
        );
        try std.testing.expectEqual(RunResult.handled_usage_error, result);
    }
}

test "parseMcpServerArgs accepts server name and json flag" {
    const parsed = try parseMcpServerArgs(&.{ @constCast("fixture"), @constCast("--json") });
    try std.testing.expectEqualStrings("fixture", parsed.server);
    try std.testing.expectEqual(output_contracts.OutputFormat.json, parsed.format);
    try std.testing.expectError(error.InvalidMcpArgs, parseMcpServerArgs(&.{}));
}

test "top-level MCP add renders json envelope" {
    const alloc = std.testing.allocator;
    var capture = CaptureOutput.init(alloc);
    defer capture.deinit();
    var cfg = testConfig();
    cfg.add_mcp_profile_server = captureMcpProfileAddForTest;
    mcp_profile_add_calls_for_test = 0;
    var deps = capture.deps();
    deps.load_startup_state = failingStartupState;

    const result = try runIfRequestedWithDeps(
        alloc,
        &.{
            @constCast("mcp"),
            @constCast("add"),
            @constCast("fixture"),
            @constCast("node"),
            @constCast("server.js"),
            @constCast("--json"),
        },
        cfg,
        deps,
    );
    try std.testing.expectEqual(RunResult.handled_success, result);
    try std.testing.expectEqual(@as(usize, 1), mcp_profile_add_calls_for_test);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"kind\":\"mcp.add\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"server\":\"fixture\"") != null);
    try std.testing.expect(std.mem.find(u8, capture.stdout.written(), "\"profile_path\":\"/tmp/test-home/.fiber/mcp.json\"") != null);
}
