const std = @import("std");
const command_specs = @import("../core/slash_commands/command_specs.zig");

const Allocator = std.mem.Allocator;

pub const TopLevelKind = command_specs.TopLevelKind;
pub const TopLevelSpec = command_specs.TopLevelSpec;
pub const TopLevelHelpEntry = command_specs.TopLevelHelpEntry;
pub const TopLevelHelpGroup = command_specs.TopLevelHelpGroup;
pub const TopLevelFlag = command_specs.TopLevelFlag;
pub const TopLevelExample = command_specs.TopLevelExample;
pub const TopLevelRegistry = command_specs.TopLevelRegistry;
pub const HelpStyle = command_specs.HelpStyle;
pub const SlashKind = command_specs.SlashKind;
pub const SlashPresentationCategory = command_specs.SlashPresentationCategory;
pub const SlashSpec = command_specs.SlashSpec;
pub const SlashRegistry = command_specs.SlashRegistry;

const json_option = command_specs.OptionDoc{ .flag = "--json", .description = "Emit machine-readable JSON instead of text" };

pub const top_level_specs = [_]TopLevelSpec{
    .{
        .kind = .help,
        .token = "help",
        .aliases = &.{ "--help", "-h" },
        .usage = "help",
        .summary = "Show this help",
    },
    .{
        .kind = .ask,
        .token = "ask",
        .usage = "ask [--permission-mode <ask|auto|yolo>] [--model <model-id>] [--effort <level>] [--fast] [--image PATH] [--system TEXT] [--json] [--quiet] [--no-save] [--resume-id <id>] [--retry] [--timeout <seconds>] [--] <prompt>",
        .summary = "Run one noninteractive request",
        .options = &.{
            .{ .flag = "--permission-mode <ask|auto|yolo>", .description = "Set permission handling for this request: ask prompts on a TTY, auto reviews unresolved requests, yolo disables checks" },
            .{ .flag = "--model <model-id>", .description = "Use one model for this request" },
            .{ .flag = "--effort <level>", .description = "Use one reasoning effort for this request" },
            .{ .flag = "--fast", .description = "Use the fast tier for this request when the model supports it" },
            .{ .flag = "--image PATH", .description = "Attach an image file; repeat for multiple images" },
            .{ .flag = "--system TEXT", .description = "Replace the built-in system prompt for this request" },
            json_option,
            .{ .flag = "--quiet", .description = "Suppress assistant output" },
            .{ .flag = "--no-save", .description = "Do not save the session; incompatible with --resume-id" },
            .{ .flag = "--resume-id <id>", .description = "Continue a session by exact id" },
            .{ .flag = "--retry", .description = "Resume the paused model response in the selected session" },
            .{ .flag = "--timeout <seconds>", .description = "Set the maximum request duration in seconds" },
            .{ .flag = "--", .description = "Treat every following argument as prompt text" },
        },
        .details = &.{
            "The prompt may be passed as arguments or piped on stdin when no prompt args are given.",
            "TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.",
            "Operational progress and diagnostics are written to stderr. JSON `output` keeps accumulated assistant Markdown; `final_output` contains only the completed final response, or an empty string when absent.",
            "--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.",
            "With --permission-mode ask, JSON and quiet requests may prompt on stderr only when stdin is a TTY.",
        },
    },
    .{
        .kind = .auth,
        .token = "auth",
        .usage = "auth <command> ...",
        .summary = "Sign in, sign out, and inspect provider credentials",
        .details = &.{
            "Commands:",
            "  fiber auth list [--json]",
            "  fiber auth status [<provider>] [--json]",
            "  fiber auth login [<provider>]",
            "  fiber auth logout [<provider>] [--json]",
        },
    },
    .{
        .kind = .status,
        .token = "status",
        .usage = "status [--json]",
        .summary = "Show configuration and runtime information",
        .options = &.{json_option},
    },
    .{
        .kind = .permissions,
        .token = "permissions",
        .usage = "permissions [--json]",
        .summary = "Show the permission mode and rules",
        .options = &.{json_option},
        .details = &.{
            "Modes:",
            "  ask    Prompt before sensitive tool calls",
            "  auto   Apply rules, then review unresolved sensitive tool calls (default)",
            "  yolo   Disable fiber permission checks",
            "",
            "Change the mode from the interactive shell with `/permissions [ask|auto|yolo|reset]`.",
        },
    },
    .{
        .kind = .mcp,
        .token = "mcp",
        .usage = "mcp <command> ...",
        .summary = "Manage MCP servers without opening the interactive shell",
        .details = &.{
            "Commands:",
            "  fiber mcp add NAME COMMAND [ARGS...]",
            "  fiber mcp add --transport http NAME URL",
            "  fiber mcp auth NAME",
            "  fiber mcp list",
            "  fiber mcp logout NAME",
            "  fiber mcp path",
            "  fiber mcp remove NAME",
            "  fiber mcp trust approve|reject NAME",
            "  fiber mcp trust approve-all|reset",
            "",
            "By default, list reads configuration without opening MCP transports.",
        },
    },
    .{
        .kind = .models,
        .token = "models",
        .usage = "models [use <id>] [--json]",
        .summary = "List available models, or set the default",
        .options = &.{json_option},
        .details = &.{
            "Commands:",
            "  fiber models              List available models",
            "  fiber models use <id>     Set the profile default model",
            "",
            "`use` checks the id against the catalog when it can reach one, and",
            "warns instead of failing when it cannot.",
        },
    },
    .{
        .kind = .doctor,
        .token = "doctor",
        .usage = "doctor [--json]",
        .summary = "Run local health and preflight checks",
        .options = &.{json_option},
    },
    .{
        .kind = .session,
        .token = "session",
        .usage = "session show <last|id>|--id <id> [--json] | session list [--all] [--limit <1-100>] [--continuation <cursor>] [--json] | session rename <id> <title> [--json] | session remove <id>|--id <id> [--json] | session recover <id>|--id <id> [--json] | session resume [last|<id>] | session resume --id <id>",
        .summary = "Inspect, list, rename, remove, resume, or recover saved sessions",
        .options = &.{
            .{ .flag = "show <last|id>", .description = "Show the current workspace session or one saved session by id" },
            .{ .flag = "list", .description = "List saved sessions for the current workspace" },
            .{ .flag = "rename <id> <title>", .description = "Rename a saved session" },
            .{ .flag = "remove <id>", .description = "Delete a saved session" },
            .{ .flag = "recover <id>", .description = "Copy a recoverable corrupt session into a new session" },
            .{ .flag = "resume [last|<id>]", .description = "Resume the latest workspace session or a session by id" },
            .{ .flag = "--id <id>", .description = "Select a saved session by exact id" },
            json_option,
        },
    },
    .{
        .kind = .sessions,
        .token = "sessions",
        .usage = "sessions [--all] [--limit <1-100>] [--continuation <cursor>] [--json]",
        .summary = "List saved sessions for the current workspace",
        .options = &.{
            .{ .flag = "--all", .description = "List saved sessions across every workspace in this profile" },
            .{ .flag = "--limit <1-100>", .description = "Set the maximum sessions returned per page" },
            .{ .flag = "--continuation <cursor>", .description = "Continue from a prior sessions result" },
            json_option,
        },
    },
    .{
        .kind = .@"continue",
        .token = "continue",
        .usage = "continue",
        .summary = "Resume the most recent saved session",
    },
    .{
        .kind = .@"resume",
        .token = "resume",
        .hidden_from_top_level_help = true,
        .usage = "session resume [last|<id>] | session resume --id <id> | resume [last|<id>] | resume --id <id>",
        .summary = "Continue a saved interactive session",
        .options = &.{
            .{ .flag = "last", .description = "Resume the most recent session" },
            .{ .flag = "<id>", .description = "Resume a session by id" },
            .{ .flag = "--id <id>", .description = "Resume a session by exact id" },
        },
    },
    .{
        .kind = .usage,
        .token = "usage",
        .usage = "usage [--period <24h|7d|30d>] [--session <id>] [--json]",
        .summary = "Show local fiber token usage and spend",
        .options = &.{
            .{ .flag = "--period <24h|7d|30d>", .description = "Select a rolling window (default: 30d)" },
            .{ .flag = "--session <id>", .description = "Report lifetime totals for one saved session in this workspace" },
            json_option,
        },
        .details = &.{
            "Reports only usage recorded by fiber on this machine.",
            "This command reads local state and does not query account-wide Gateway reports.",
            "--session reports the session's last durable checkpoint; unknown spend shows as unknown, never $0.00. Sessions that predate durable usage accounting report as legacy with unknown totals.",
            "--session with --period reports the session only when it started inside the window; an older session needs a bare --session for lifetime totals.",
        },
    },
    .{
        .kind = .upgrade,
        .token = "upgrade",
        .usage = "upgrade [--json]",
        .summary = "Upgrade fiber to the latest release",
        .options = &.{
            json_option,
        },
    },
    .{
        .kind = .debug,
        .token = "debug",
        .usage = "debug <replay> ...",
        .summary = "Developer debugging utilities",
        .hidden_from_top_level_help = true,
        .details = &.{
            "Commands:",
            "  fiber debug replay <tape> [--frames] [--json] [--golden <path>] [--frames-dir <path>]",
            "",
            "Replay options:",
            "  --frames              Render each captured frame",
            "  --golden <path>       Write the final rendered grid to a file",
            "  --frames-dir <path>   Write rendered frames to a directory",
            "  --json                Emit structured output",
        },
    },
    .{
        .kind = .workspace,
        .token = "workspace",
        .usage = "workspace [list|add PATH|remove PATH|clear] [--json]",
        .summary = "Manage additional workspace directories",
        .options = &.{
            .{ .flag = "list", .description = "List the primary and additional directories (default)" },
            .{ .flag = "add PATH", .description = "Persist an existing additional directory" },
            .{ .flag = "remove PATH", .description = "Remove an additional directory" },
            .{ .flag = "clear", .description = "Remove all additional directories" },
            json_option,
        },
        .details = &.{
            "Additional directories are stored for the current primary workspace.",
        },
    },
};

pub const top_level_help_default_width = command_specs.top_level_help_default_width;
pub const top_level_help_fast_buffer_bytes: usize = 32 * 1024;

pub const top_level_help_groups = [_]TopLevelHelpGroup{
    .{ .entries = &.{
        .{ .kind = .ask, .usage = "ask <prompt>" },
    } },
    .{ .entries = &.{
        .{ .kind = .@"continue", .usage = "continue", .summary = "Resume the most recent saved session" },
        .{ .kind = .sessions, .usage = "sessions" },
        .{ .kind = .session, .usage = "session show <last|id>" },
        .{ .usage = "session list", .summary = "List saved sessions for the current workspace" },
        .{ .usage = "session rename <id> <title>", .summary = "Rename a saved session" },
        .{ .usage = "session remove <id>", .summary = "Delete a saved session" },
        .{ .usage = "session resume [last|id]", .summary = "Resume the latest workspace session or a session by id" },
        .{ .usage = "session recover <id>", .summary = "Copy a recoverable corrupt session" },
    } },
    .{ .entries = &.{
        .{ .kind = .auth, .usage = "auth <command> ...", .summary = "Sign in, sign out, and inspect provider credentials" },
        .{ .kind = .models, .usage = "models" },
    } },
    .{ .entries = &.{
        .{ .kind = .usage, .usage = "usage [--period <..>, --session <id>]", .summary = "Show locally recorded token usage and spend" },
    } },
    .{ .entries = &.{
        .{ .kind = .status, .usage = "status" },
        .{ .kind = .doctor, .usage = "doctor" },
        .{ .kind = .mcp, .usage = "mcp <command> ..." },
        .{ .kind = .permissions, .usage = "permissions" },
        .{ .kind = .workspace, .usage = "workspace" },
        .{ .kind = .upgrade, .usage = "upgrade", .summary = "Upgrade fiber to the latest release" },
        .{ .kind = .help, .usage = "help" },
    } },
};

pub const top_level_flags = [_]TopLevelFlag{
    .{
        .usage = "--context-limit <spec>",
        .description = "Set name=bytes|off; repeatable",
    },
    .{
        .usage = "--add-dir <path>",
        .description = "Add a workspace directory; repeatable",
    },
    .{
        .usage = "--no-additional-dirs",
        .description = "Ignore saved additional directories",
    },
    .{
        .usage = "-h, --help",
        .description = "Display this help and exit",
    },
    .{
        .usage = "-v, --version",
        .description = "Print the fiber version and exit",
    },
};

pub const top_level_examples = [_]TopLevelExample{
    .{ .command = "fiber", .description = "Start a fresh interactive session" },
    .{ .command = "fiber ask \"Explain the changes in this repository\"", .description = "Run one request and exit" },
    .{ .command = "fiber session resume last", .description = "Continue the latest session for this workspace" },
    .{ .command = "fiber status --json", .description = "Inspect the current configuration as JSON" },
};

pub const top_level_notes = [_][]const u8{
    "Run `fiber <command> --help` for command-specific usage and options.",
    "Run `/help` inside an interactive session for slash commands.",
};

pub const top_level_registry = TopLevelRegistry{
    .specs = top_level_specs[0..],
    .description = "Fast, native coding agent for the terminal.",
    .interactive_hint = "fiber starts an interactive session by default. Use `fiber ask` to run one noninteractive request.",
    .help_groups = top_level_help_groups[0..],
    .flags = top_level_flags[0..],
    .examples = top_level_examples[0..],
    .notes = top_level_notes[0..],
};

pub fn matchesTopLevel(token: []const u8, kind: TopLevelKind) bool {
    return command_specs.matchesTopLevel(top_level_registry, token, kind);
}

pub fn renderTopLevelHelp(alloc: Allocator, columns: usize, version: []const u8) ![]u8 {
    return command_specs.renderTopLevelHelp(alloc, top_level_registry, columns, version);
}

pub fn renderTopLevelHelpWithStyle(alloc: Allocator, columns: usize, version: []const u8, style: HelpStyle) ![]u8 {
    return command_specs.renderTopLevelHelpWithStyle(alloc, top_level_registry, columns, version, style);
}

pub fn renderTopLevelCommandHelp(alloc: Allocator, kind: TopLevelKind) ![]u8 {
    return command_specs.renderTopLevelCommandHelp(alloc, top_level_registry, kind);
}

pub fn topLevelKindFromToken(token: []const u8) ?TopLevelKind {
    return command_specs.topLevelKindFromToken(top_level_registry, token);
}

pub fn topLevelUsage(kind: TopLevelKind) []const u8 {
    return command_specs.topLevelUsage(top_level_registry, kind);
}

pub const slash_specs = [_]SlashSpec{
    .{ .kind = .help, .command = "/help", .help_entry = "/help", .completion_description = "show available slash commands", .presentation_category = .general, .show_in_welcome = true },
    .{ .kind = .new_session, .command = "/new", .aliases = &.{"/clear"}, .help_entry = "/new", .completion_description = "start a fresh session", .presentation_category = .session, .show_in_welcome = true },
    .{ .kind = .resume_session, .command = "/resume", .help_entry = "/resume", .completion_description = "resume a saved session", .presentation_category = .session },
    .{ .kind = .continue_recovery, .command = "/retry", .help_entry = "/retry", .completion_description = "retry an interrupted turn from its checkpoint", .presentation_category = .session, .requires_prompt_credential = true },
    .{ .kind = .rename_session, .command = "/rename", .help_entry = "/rename <title>", .completion_description = "rename the current session", .presentation_category = .session, .has_args = true, .accepts_payload = true },
    .{ .kind = .login, .command = "/login", .help_entry = "/login", .completion_description = "sign in to Codex", .presentation_category = .account },
    .{ .kind = .logout, .command = "/logout", .help_entry = "/logout [codex]", .completion_description = "sign out of the Codex session", .presentation_category = .account, .has_args = true, .accepts_payload = true },
    .{ .kind = .usage, .command = "/usage", .help_entry = "/usage", .completion_description = "show local fiber tokens, models, and spend", .presentation_category = .account },
    .{ .kind = .status, .command = "/status", .help_entry = "/status", .completion_description = "show runtime configuration", .presentation_category = .general, .show_in_welcome = true },
    .{ .kind = .model, .command = "/model", .help_entry = "/model <id-or-query>", .completion_description = "choose what model and reasoning effort to use", .presentation_category = .model, .has_args = true, .accepts_payload = true },
    .{ .kind = .permissions, .command = "/permissions", .help_entry = "/permissions [ask|auto|yolo|reset]", .completion_description = "choose what fiber is allowed to do", .presentation_category = .security, .show_in_welcome = true, .has_args = true, .accepts_payload = true },
    .{ .kind = .undo, .command = "/undo", .help_entry = "/undo", .completion_description = "undo the latest tracked file operation", .presentation_category = .session },
    .{ .kind = .mcp, .command = "/mcp", .help_entry = "/mcp [list|resource|prompt|add|remove|path|reload|login|logout|trust]", .completion_description = "manage local and remote MCP servers, resources, prompts, and project trust", .presentation_category = .extensions, .has_args = true, .accepts_payload = true },
    .{ .kind = .skills, .command = "/skills", .help_entry = "/skills [list|add|install|show|create|remove|path] [name|url|path] ($ opens skill search)", .completion_description = "browse and manage skills", .presentation_category = .extensions, .has_args = true, .accepts_payload = true },
    .{ .kind = .trace, .command = "/trace", .help_entry = "/trace", .completion_description = "copy a private diagnostic trace", .presentation_category = .product },
    .{ .kind = .context, .command = "/context", .help_entry = "/context", .completion_description = "show context window usage", .presentation_category = .general },
    .{ .kind = .compact, .command = "/compact", .help_entry = "/compact", .completion_description = "compact older conversation turns", .presentation_category = .session },
    .{ .kind = .settings, .command = "/settings", .help_entry = "/settings [startup-scrollback [on|off]]", .completion_description = "browse and update settings", .presentation_category = .appearance, .has_args = true, .accepts_payload = true },
    .{ .kind = .workspace, .command = "/workspace", .help_entry = "/workspace [list|add PATH|remove PATH|clear]", .completion_description = "manage additional workspace directories", .presentation_category = .workspace, .show_in_welcome = true, .has_args = true, .accepts_payload = true },
    .{ .kind = .quit, .command = "/quit", .aliases = &.{"/exit"}, .help_entry = "/quit", .completion_description = "exit the interactive shell", .presentation_category = .general, .show_in_welcome = true },
};

pub const slash_registry = SlashRegistry{ .commands = slash_specs[0..] };

pub fn matchesSlashExact(cmd: []const u8, kind: SlashKind) bool {
    return command_specs.matchesSlashExact(slash_registry, cmd, kind);
}

pub fn isExactSlashCommand(cmd: []const u8) bool {
    return slash_registry.matchExact(cmd) != null;
}

pub fn matchedSlashPrefix(cmd: []const u8, kind: SlashKind) ?[]const u8 {
    return command_specs.matchedSlashPrefix(slash_registry, cmd, kind);
}

pub fn renderSlashHelp(alloc: Allocator) ![]u8 {
    return command_specs.renderSlashHelp(alloc, slash_registry);
}

pub fn renderSlashWelcome(alloc: Allocator) ![]u8 {
    return command_specs.renderSlashWelcome(alloc, slash_registry);
}

pub fn firstSlashCompletion(prefix: []const u8) ?[]const u8 {
    return command_specs.firstSlashCompletion(slash_registry, prefix);
}

pub fn slashCompletionCount(prefix: []const u8) usize {
    return command_specs.slashCompletionCount(slash_registry, prefix);
}

pub fn nthSlashCompletion(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletion(slash_registry, prefix, n);
}

pub fn nthSlashCompletionLabel(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletionLabel(slash_registry, prefix, n);
}

pub fn nthSlashCompletionDescription(prefix: []const u8, n: usize) ?[]const u8 {
    return command_specs.nthSlashCompletionDescription(slash_registry, prefix, n);
}

pub fn nthSlashCompletionCategory(prefix: []const u8, n: usize) ?SlashPresentationCategory {
    return command_specs.nthSlashCompletionCategory(slash_registry, prefix, n);
}

pub fn slashCompletionHasArgs(command: []const u8) bool {
    return command_specs.slashCompletionHasArgs(slash_registry, command);
}

pub const argCompletionAnchor = command_specs.argCompletionAnchor;
pub const permissionsArgCompletionPrefix = command_specs.permissionsArgCompletionPrefix;

test "built-in slash commands register exact active order" {
    const expected_commands = [_][]const u8{
        "/help",
        "/new",
        "/resume",
        "/retry",
        "/rename",
        "/login",
        "/logout",
        "/usage",
        "/status",
        "/model",
        "/permissions",
        "/undo",
        "/mcp",
        "/skills",
        "/trace",
        "/context",
        "/compact",
        "/settings",
        "/workspace",
        "/quit",
    };

    try std.testing.expectEqual(expected_commands.len, slash_specs.len);
    for (expected_commands, slash_specs) |expected, spec| {
        try std.testing.expectEqualStrings(expected, spec.command);
    }
}

test "built-in slash registry resolves primary commands and aliases" {
    const quit = slash_registry.lookup("/exit") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.quit, quit.kind);

    const usage = slash_registry.lookup("/usage") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.usage, usage.kind);

    const quit_alias = slash_registry.matchExact("/exit\t") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.quit, quit_alias.command.kind);
    try std.testing.expectEqualStrings("/exit", quit_alias.token);

    const clear = slash_registry.lookup("/clear") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.new_session, clear.kind);

    const clear_alias = slash_registry.matchExact("/clear\t") orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(SlashKind.new_session, clear_alias.command.kind);
    try std.testing.expectEqualStrings("/clear", clear_alias.token);

    const model = command_specs.matchedSlashPrefix(slash_registry, "/model\tmodel-id", .model) orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("/model", model);

    try std.testing.expect(slash_registry.lookup("/credits") == null);
    try std.testing.expect(slash_registry.lookup("/balance") == null);

    const model_command = slash_registry.lookup("/model") orelse return error.TestExpectedEqual;
    try std.testing.expect(!model_command.requires_prompt_credential);
    try std.testing.expect(slash_registry.lookup("/models") == null);

    try std.testing.expect(command_specs.matchedSlashPrefix(slash_registry, "/model\nmodel-id", .model) == null);
}

test "retired appearance slash commands are not registered" {
    try std.testing.expect(!isExactSlashCommand("/appearance"));
    try std.testing.expect(!isExactSlashCommand("/input"));
    try std.testing.expect(!isExactSlashCommand("/maxxing\t"));
    try std.testing.expect(!isExactSlashCommand("/input lines"));
    try std.testing.expect(!isExactSlashCommand("/unknown"));
}
