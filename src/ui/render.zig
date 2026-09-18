const std = @import("std");
const io_mod = @import("../core/shared/io.zig");
const host = @import("../core/hosts/host.zig");
const display_width = @import("../core/shared/display_width.zig");
const text_utils = @import("../core/shared/text_utils.zig");
const types = @import("../core/shared/types.zig");
const assistant_presentation = @import("../core/agent/assistant_presentation.zig");
const main = @import("../main.zig");
const theme_detection = @import("terminal/theme_detection.zig");
const theme_protocol = @import("terminal/theme_protocol.zig");
const visual_layout = @import("input/visual_layout.zig");

pub const TerminalRgb = user_message_card.Rgb;
pub const reset_style = "\x1b[0m";
pub const bold_style = "\x1b[1m";
pub const ask_activity_label = "⏺ Asking";

const user_message_card = @import("assistant/user_message_card.zig");
const record_tape = @import("../core/workspace/record_tape.zig");

pub const welcome_message_reserved_rows: u16 = 11;

pub var is_light: bool = false;
pub var divider_style: []const u8 = "\x1b[38;5;240m";
pub var hint_style: []const u8 = "\x1b[38;5;255m";
pub var statusline_style: []const u8 = "\x1b[38;5;245m";
pub var tag_style: []const u8 = "\x1b[1;38;5;255m";
pub var subtitle_style: []const u8 = "\x1b[1;38;5;255m";
pub var system_notice_label_style: []const u8 = "\x1b[1;38;5;252m";
pub var system_notice_text_style: []const u8 = "\x1b[38;5;250m";
pub var dim_style: []const u8 = "\x1b[38;5;245m";
// Semantic colour roles (issue #314). Every hue role carries a truecolor
// value and the nearest 256-colour index; initTheme picks by the existing
// truecolor detection. The rgb triple mirrors the truecolor value so unit
// tests can assert WCAG contrast without parsing SGR.
const ColorDef = struct {
    truecolor: []const u8,
    fallback_256: []const u8,
    r: u8,
    g: u8,
    b: u8,
};

fn pickShade(shade: ColorDef) []const u8 {
    return if (truecolor_enabled) shade.truecolor else shade.fallback_256;
}

// Status hues: error red, warning amber, success green. The light value is
// dark enough for a white terminal, the dark value light enough for #1c1c1c.
const error_light = ColorDef{ .truecolor = "\x1b[38;2;200;30;30m", .fallback_256 = "\x1b[38;5;160m", .r = 200, .g = 30, .b = 30 };
const error_dark = ColorDef{ .truecolor = "\x1b[38;2;242;85;90m", .fallback_256 = "\x1b[38;5;203m", .r = 242, .g = 85, .b = 90 };
const warning_light = ColorDef{ .truecolor = "\x1b[38;2;194;65;12m", .fallback_256 = "\x1b[38;5;130m", .r = 194, .g = 65, .b = 12 };
const warning_dark = ColorDef{ .truecolor = "\x1b[38;2;253;176;34m", .fallback_256 = "\x1b[38;5;214m", .r = 253, .g = 176, .b = 34 };
const success_light = ColorDef{ .truecolor = "\x1b[38;2;6;118;71m", .fallback_256 = "\x1b[38;5;29m", .r = 6, .g = 118, .b = 71 };
const success_dark = ColorDef{ .truecolor = "\x1b[38;2;48;164;108m", .fallback_256 = "\x1b[38;5;71m", .r = 48, .g = 164, .b = 108 };
// Permission hues: ask grey, auto amber, YOLO red.
const ask_light = ColorDef{ .truecolor = "\x1b[38;2;71;84;103m", .fallback_256 = "\x1b[38;5;240m", .r = 71, .g = 84, .b = 103 };
const ask_dark = ColorDef{ .truecolor = "\x1b[38;2;152;162;179m", .fallback_256 = "\x1b[38;5;248m", .r = 152, .g = 162, .b = 179 };
// The thinking-activity marker keeps the grey the permission auto style used
// to carry, so turning auto amber leaves the marker unchanged.
const thinking_light = ColorDef{ .truecolor = "\x1b[38;2;68;68;68m", .fallback_256 = "\x1b[38;5;238m", .r = 68, .g = 68, .b = 68 };
const thinking_dark = ColorDef{ .truecolor = "\x1b[38;2;208;208;208m", .fallback_256 = "\x1b[38;5;252m", .r = 208, .g = 208, .b = 208 };
// Categorical roles for the /context breakdown (#310): setup in cool shades,
// built-in and MCP tools in one indigo hue in two shades, conversation in
// olive earth shades (kept off the warning hue family), the compacted
// summary in magenta. Free space has no
// colour. Dark values are tints of the light hues, so each family reads as
// one family on both themes. None equals a status hue.
const ctx_system_prompt_light = ColorDef{ .truecolor = "\x1b[38;2;14;116;144m", .fallback_256 = "\x1b[38;5;30m", .r = 14, .g = 116, .b = 144 };
const ctx_system_prompt_dark = ColorDef{ .truecolor = "\x1b[38;2;146;192;205m", .fallback_256 = "\x1b[38;5;110m", .r = 146, .g = 192, .b = 205 };
const ctx_project_instructions_light = ColorDef{ .truecolor = "\x1b[38;2;124;58;237m", .fallback_256 = "\x1b[38;5;99m", .r = 124, .g = 58, .b = 237 };
const ctx_project_instructions_dark = ColorDef{ .truecolor = "\x1b[38;2;196;166;246m", .fallback_256 = "\x1b[38;5;183m", .r = 196, .g = 166, .b = 246 };
const ctx_skills_light = ColorDef{ .truecolor = "\x1b[38;2;29;78;216m", .fallback_256 = "\x1b[38;5;26m", .r = 29, .g = 78, .b = 216 };
const ctx_skills_dark = ColorDef{ .truecolor = "\x1b[38;2;153;175;237m", .fallback_256 = "\x1b[38;5;111m", .r = 153, .g = 175, .b = 237 };
const ctx_environment_light = ColorDef{ .truecolor = "\x1b[38;2;3;105;161m", .fallback_256 = "\x1b[38;5;25m", .r = 3, .g = 105, .b = 161 };
const ctx_environment_dark = ColorDef{ .truecolor = "\x1b[38;2;159;198;219m", .fallback_256 = "\x1b[38;5;152m", .r = 159, .g = 198, .b = 219 };
const ctx_builtin_tools_light = ColorDef{ .truecolor = "\x1b[38;2;67;56;202m", .fallback_256 = "\x1b[38;5;62m", .r = 67, .g = 56, .b = 202 };
const ctx_builtin_tools_dark = ColorDef{ .truecolor = "\x1b[38;2;170;165;231m", .fallback_256 = "\x1b[38;5;146m", .r = 170, .g = 165, .b = 231 };
const ctx_mcp_tools_light = ColorDef{ .truecolor = "\x1b[38;2;99;102;241m", .fallback_256 = "\x1b[38;5;63m", .r = 99, .g = 102, .b = 241 };
const ctx_mcp_tools_dark = ColorDef{ .truecolor = "\x1b[38;2;184;186;248m", .fallback_256 = "\x1b[38;5;147m", .r = 184, .g = 186, .b = 248 };
const ctx_user_messages_light = ColorDef{ .truecolor = "\x1b[38;2;96;102;24m", .fallback_256 = "\x1b[38;5;58m", .r = 96, .g = 102, .b = 24 };
const ctx_user_messages_dark = ColorDef{ .truecolor = "\x1b[38;2;182;190;130m", .fallback_256 = "\x1b[38;5;144m", .r = 182, .g = 190, .b = 130 };
const ctx_assistant_messages_light = ColorDef{ .truecolor = "\x1b[38;2;70;80;18m", .fallback_256 = "\x1b[38;5;58m", .r = 70, .g = 80, .b = 18 };
const ctx_assistant_messages_dark = ColorDef{ .truecolor = "\x1b[38;2;168;178;124m", .fallback_256 = "\x1b[38;5;144m", .r = 168, .g = 178, .b = 124 };
const ctx_reasoning_light = ColorDef{ .truecolor = "\x1b[38;2;120;113;108m", .fallback_256 = "\x1b[38;5;243m", .r = 120, .g = 113, .b = 108 };
const ctx_reasoning_dark = ColorDef{ .truecolor = "\x1b[38;2;194;191;188m", .fallback_256 = "\x1b[38;5;250m", .r = 194, .g = 191, .b = 188 };
const ctx_tool_calls_light = ColorDef{ .truecolor = "\x1b[38;2;84;92;20m", .fallback_256 = "\x1b[38;5;58m", .r = 84, .g = 92, .b = 20 };
const ctx_tool_calls_dark = ColorDef{ .truecolor = "\x1b[38;2;178;186;118m", .fallback_256 = "\x1b[38;5;144m", .r = 178, .g = 186, .b = 118 };
const ctx_tool_output_light = ColorDef{ .truecolor = "\x1b[38;2;68;76;36m", .fallback_256 = "\x1b[38;5;58m", .r = 68, .g = 76, .b = 36 };
const ctx_tool_output_dark = ColorDef{ .truecolor = "\x1b[38;2;170;178;138m", .fallback_256 = "\x1b[38;5;144m", .r = 170, .g = 178, .b = 138 };
const ctx_compacted_summary_light = ColorDef{ .truecolor = "\x1b[38;2;162;28;175m", .fallback_256 = "\x1b[38;5;127m", .r = 162, .g = 28, .b = 175 };
const ctx_compacted_summary_dark = ColorDef{ .truecolor = "\x1b[38;2;240;171;252m", .fallback_256 = "\x1b[38;5;219m", .r = 240, .g = 171, .b = 252 };
// The conversation roles share the coarse 256-cube olive; the truecolor
// values stay distinct.
// Status hues reach status notices only (#314). warning_style, green_style
// and red_style stay grey for every other use: tool states, MCP failures,
// input warnings, questions and resume menus.
pub var warning_style: []const u8 = "\x1b[38;5;252m";
pub var green_style: []const u8 = "\x1b[38;5;252m";
pub var red_style: []const u8 = "\x1b[38;5;252m";
pub var notice_warning_style: []const u8 = "\x1b[38;5;252m";
pub var notice_success_style: []const u8 = "\x1b[38;5;252m";
pub var notice_error_style: []const u8 = "\x1b[38;5;252m";
pub var permission_ask_style: []const u8 = "\x1b[38;5;245m";
// Statusbar permissions "auto": warning amber. The thinking-activity marker
// used to borrow this style; it now has thinking_marker_style below.
pub var permission_auto_style: []const u8 = "\x1b[38;5;252m";
pub var permission_yolo_style: []const u8 = "\x1b[38;5;252m";
pub var thinking_marker_style: []const u8 = "\x1b[38;5;252m";
// One role per /context category (#310 renders them; free space is unstyled).
// #310 reads them through contextCategoryStyle; nothing outside this file
// touches the vars directly.
var ctx_system_prompt_style: []const u8 = "";
var ctx_project_instructions_style: []const u8 = "";
var ctx_skills_style: []const u8 = "";
var ctx_builtin_tools_style: []const u8 = "";
var ctx_mcp_tools_style: []const u8 = "";
var ctx_environment_style: []const u8 = "";
var ctx_user_messages_style: []const u8 = "";
var ctx_assistant_messages_style: []const u8 = "";
var ctx_reasoning_style: []const u8 = "";
var ctx_tool_calls_style: []const u8 = "";
var ctx_tool_output_style: []const u8 = "";
var ctx_compacted_summary_style: []const u8 = "";
const ctx_free_space_style: []const u8 = "";
pub var diff_added_style: []const u8 = "\x1b[38;5;252m";
pub var diff_removed_style: []const u8 = "\x1b[38;5;252m";
// The line number and +/- sign carry the only color in an otherwise
// monochrome diff: green for additions (#30A46C), red for deletions
// (#E5484D). The line text stays neutral. Truecolor when the terminal
// supports it, 256-color fallback otherwise.
const diff_added_marker_truecolor = "\x1b[38;2;48;164;108m";
const diff_removed_marker_truecolor = "\x1b[38;2;229;72;77m";
const diff_added_marker_fallback = "\x1b[38;5;71m";
const diff_removed_marker_fallback = "\x1b[38;5;167m";
pub var diff_added_marker_style: []const u8 = diff_added_marker_fallback;
pub var diff_removed_marker_style: []const u8 = diff_removed_marker_fallback;
pub var approval_button_active_style: []const u8 = "\x1b[48;5;255m\x1b[38;5;235m\x1b[1m";
pub var approval_button_inactive_style: []const u8 = "\x1b[48;5;239m\x1b[38;5;255m";
pub var selected_completion_style: []const u8 = "\x1b[1;38;5;255m";
var active_terminal_background: ?TerminalRgb = null;

var truecolor_enabled: bool = true;

pub fn setTruecolorSupport(enabled: bool) void {
    truecolor_enabled = enabled;
}

pub fn initTheme(light: bool, terminal_bg: ?TerminalRgb) void {
    is_light = light;
    active_terminal_background = terminal_bg;
    assistant_presentation.setInlineCodeTheme(light);
    if (light) {
        divider_style = "\x1b[38;5;250m";
        hint_style = "\x1b[38;5;235m";
        statusline_style = "\x1b[38;5;241m";
        tag_style = "\x1b[1;38;5;235m";
        subtitle_style = "\x1b[1;38;5;235m";
        system_notice_label_style = "\x1b[1;38;5;238m";
        system_notice_text_style = "\x1b[38;5;241m";
        dim_style = "\x1b[38;5;247m";
        notice_warning_style = pickShade(warning_light);
        notice_success_style = pickShade(success_light);
        notice_error_style = pickShade(error_light);
        permission_ask_style = pickShade(ask_light);
        permission_auto_style = pickShade(warning_light);
        permission_yolo_style = pickShade(error_light);
        thinking_marker_style = pickShade(thinking_light);
        ctx_system_prompt_style = pickShade(ctx_system_prompt_light);
        ctx_project_instructions_style = pickShade(ctx_project_instructions_light);
        ctx_skills_style = pickShade(ctx_skills_light);
        ctx_builtin_tools_style = pickShade(ctx_builtin_tools_light);
        ctx_mcp_tools_style = pickShade(ctx_mcp_tools_light);
        ctx_environment_style = pickShade(ctx_environment_light);
        ctx_user_messages_style = pickShade(ctx_user_messages_light);
        ctx_assistant_messages_style = pickShade(ctx_assistant_messages_light);
        ctx_reasoning_style = pickShade(ctx_reasoning_light);
        ctx_tool_calls_style = pickShade(ctx_tool_calls_light);
        ctx_tool_output_style = pickShade(ctx_tool_output_light);
        ctx_compacted_summary_style = pickShade(ctx_compacted_summary_light);
        diff_added_style = "\x1b[38;5;238m";
        diff_removed_style = "\x1b[38;5;238m";
        approval_button_active_style = "\x1b[48;5;236m\x1b[38;5;255m\x1b[1m";
        approval_button_inactive_style = "\x1b[48;5;251m\x1b[38;5;237m";
        selected_completion_style = "\x1b[1;38;5;235m";
    } else {
        divider_style = "\x1b[38;5;240m";
        hint_style = "\x1b[38;5;255m";
        statusline_style = "\x1b[38;5;245m";
        tag_style = "\x1b[1;38;5;255m";
        subtitle_style = "\x1b[1;38;5;255m";
        system_notice_label_style = "\x1b[1;38;5;252m";
        system_notice_text_style = "\x1b[38;5;250m";
        dim_style = "\x1b[38;5;245m";
        notice_warning_style = pickShade(warning_dark);
        notice_success_style = pickShade(success_dark);
        notice_error_style = pickShade(error_dark);
        permission_ask_style = pickShade(ask_dark);
        permission_auto_style = pickShade(warning_dark);
        permission_yolo_style = pickShade(error_dark);
        thinking_marker_style = pickShade(thinking_dark);
        ctx_system_prompt_style = pickShade(ctx_system_prompt_dark);
        ctx_project_instructions_style = pickShade(ctx_project_instructions_dark);
        ctx_skills_style = pickShade(ctx_skills_dark);
        ctx_builtin_tools_style = pickShade(ctx_builtin_tools_dark);
        ctx_mcp_tools_style = pickShade(ctx_mcp_tools_dark);
        ctx_environment_style = pickShade(ctx_environment_dark);
        ctx_user_messages_style = pickShade(ctx_user_messages_dark);
        ctx_assistant_messages_style = pickShade(ctx_assistant_messages_dark);
        ctx_reasoning_style = pickShade(ctx_reasoning_dark);
        ctx_tool_calls_style = pickShade(ctx_tool_calls_dark);
        ctx_tool_output_style = pickShade(ctx_tool_output_dark);
        ctx_compacted_summary_style = pickShade(ctx_compacted_summary_dark);
        diff_added_style = "\x1b[38;5;252m";
        diff_removed_style = "\x1b[38;5;252m";
        approval_button_active_style = "\x1b[48;5;255m\x1b[38;5;235m\x1b[1m";
        approval_button_inactive_style = "\x1b[48;5;239m\x1b[38;5;255m";
        selected_completion_style = "\x1b[1;38;5;255m";
    }

    // The diff marker green/red reads the same on light and dark, so it is set
    // once here rather than per-theme.
    if (truecolor_enabled) {
        diff_added_marker_style = diff_added_marker_truecolor;
        diff_removed_marker_style = diff_removed_marker_truecolor;
    } else {
        diff_added_marker_style = diff_added_marker_fallback;
        diff_removed_marker_style = diff_removed_marker_fallback;
    }

    user_message_card.setStyle(light, terminal_bg);
}

pub fn themeNeedsUpdate(light: bool, terminal_bg: ?TerminalRgb) bool {
    if (light != is_light) return true;
    const background = terminal_bg orelse return false;
    const current = active_terminal_background orelse return true;
    return current.r != background.r or current.g != background.g or current.b != background.b;
}

// Explicit theme overrides skip OSC 11, leaving `rgb` null for fallback shading.
pub const TerminalBackground = theme_protocol.Background;
pub const explicitThemeOverride = theme_detection.explicitThemeOverride;
pub const detectTheme = theme_detection.detectTheme;
pub const parseOsc11Response = theme_protocol.parseOsc11Response;
pub const truecolorSupportedForValues = theme_protocol.truecolorSupportedForValues;

// NO_COLOR and TERM=dumb support. When colour is disabled the TUI emits no
// foreground or background colour, greys included; bold, dim, italic,
// underline and reverse pass through. Every painted byte bound for the
// terminal flows through writeWithoutColor, so hardcoded colour sequences
// spread across the UI need no per-site edits. External users go through
// colorEnabled/setColorEnabled; nothing touches the var directly.
var color_enabled: bool = true;

pub fn setColorEnabled(enabled: bool) void {
    color_enabled = enabled;
}

pub fn colorEnabled() bool {
    return color_enabled;
}

// NO_COLOR disables colour when present, whatever its value; TERM=dumb
// counts as NO_COLOR.
pub fn colorEnabledForEnv(no_color_present: bool, term: ?[]const u8) bool {
    if (no_color_present) return false;
    if (term) |value| if (std.mem.eql(u8, value, "dumb")) return false;
    return true;
}

pub fn colorEnabledFromEnv() bool {
    return colorEnabledForEnv(io_mod.getenv("NO_COLOR") != null, io_mod.getenv("TERM"));
}

// Stripping only drops colour runs, so a partial write carries the file
// streaming error plus NoProgress when zero bytes move.
pub const PlainWriteError = std.Io.File.Writer.Error || error{NoProgress};

pub const PlainWriteResult = union(enum) {
    complete: usize,
    partial: struct {
        source_accepted: usize,
        stripped_written: usize,
        err: PlainWriteError,
    },
};

fn writePiece(file: std.Io.File, piece: []const u8) !void {
    var done: usize = 0;
    while (done < piece.len) {
        const n = try file.writeStreaming(io_mod.getIo(), &.{}, &.{piece[done..]}, 1);
        if (n == 0) return error.NoProgress;
        done += n;
    }
}

fn recordStripped(metrics: *types.Metrics, piece: []const u8) void {
    record_tape.recordStdout(piece);
    metrics.ansi_bytes += piece.len;
}

// A single SGR parameter that sets a colour. 39/49 reset to the default
// colour, which under NO_COLOR is already in effect.
fn sgrParamIsColor(param: []const u8) bool {
    const value = std.fmt.parseUnsigned(u16, param, 10) catch return false;
    return (value >= 30 and value <= 37) or value == 39 or
        (value >= 40 and value <= 47) or value == 49 or
        (value >= 90 and value <= 97) or (value >= 100 and value <= 107);
}

// 38/48 open an extended colour run (38;5;N, 38;2;R;G;B, or the colon
// forms); 58 does the same for underline colour. 59 resets the underline
// colour and takes no parameter. The bare opener is dropped along with
// its arguments.
fn sgrParamIsExtendedOpen(param: []const u8) bool {
    return std.mem.eql(u8, param, "38") or std.mem.eql(u8, param, "48") or
        std.mem.eql(u8, param, "58") or std.mem.eql(u8, param, "59") or
        std.mem.startsWith(u8, param, "38:") or std.mem.startsWith(u8, param, "48:") or
        std.mem.startsWith(u8, param, "58:") or std.mem.startsWith(u8, param, "59:");
}

const SgrParamAction = union(enum) {
    keep,
    drop,
    drop_with_skip: usize,
};

fn classifySgrParam(param: []const u8, rest: *std.mem.SplitIterator(u8, .scalar)) SgrParamAction {
    if (sgrParamIsExtendedOpen(param)) {
        // 59 takes no parameter, so it must not consume the next one:
        // ESC[59;4m resets the underline colour and keeps underline.
        if (std.mem.eql(u8, param, "38") or std.mem.eql(u8, param, "48") or
            std.mem.eql(u8, param, "58"))
        {
            const mode = rest.next() orelse "";
            if (std.mem.eql(u8, mode, "5")) return .{ .drop_with_skip = 1 };
            // Truecolor mode 2 takes three params (R;G;B); skipping four
            // would eat the trailing style of a combined sequence.
            if (std.mem.eql(u8, mode, "2")) return .{ .drop_with_skip = 3 };
        }
        return .drop;
    }
    if (sgrParamIsColor(param)) return .drop;
    return .keep;
}

fn countKeptSgrParams(inner: []const u8) usize {
    var kept: usize = 0;
    var skip: usize = 0;
    var params = std.mem.splitScalar(u8, inner, ';');
    while (params.next()) |param| {
        if (skip > 0) {
            skip -= 1;
            continue;
        }
        switch (classifySgrParam(param, &params)) {
            .keep => kept += 1,
            .drop => {},
            .drop_with_skip => |n| skip = n,
        }
    }
    return kept;
}

fn writeFilteredSgr(file: std.Io.File, metrics: *types.Metrics, seq: []const u8) !usize {
    const inner = seq[2 .. seq.len - 1];
    // An all-colour sequence is dropped without emitting a bare escape.
    if (countKeptSgrParams(inner) == 0) return 0;
    var written: usize = 0;
    var skip: usize = 0;
    var first_kept = true;
    var params = std.mem.splitScalar(u8, inner, ';');
    try writePiece(file, "\x1b[");
    recordStripped(metrics, "\x1b[");
    written += 2;
    while (params.next()) |param| {
        if (skip > 0) {
            skip -= 1;
            continue;
        }
        switch (classifySgrParam(param, &params)) {
            .keep => {},
            .drop => continue,
            .drop_with_skip => |n| {
                skip = n;
                continue;
            },
        }
        if (!first_kept) {
            try writePiece(file, ";");
            recordStripped(metrics, ";");
            written += 1;
        }
        first_kept = false;
        try writePiece(file, param);
        recordStripped(metrics, param);
        written += param.len;
    }
    try writePiece(file, "m");
    recordStripped(metrics, "m");
    return written + 1;
}

fn csiSequenceEnd(bytes: []const u8, start: usize) ?usize {
    var i = start;
    while (i < bytes.len) : (i += 1) {
        if (bytes[i] >= 0x40 and bytes[i] <= 0x7e) return i;
    }
    return null;
}

fn writeRawPiece(file: std.Io.File, metrics: *types.Metrics, piece: []const u8, source_accepted: usize, stripped_written: usize) ?PlainWriteResult {
    writePiece(file, piece) catch |err| return .{ .partial = .{
        .source_accepted = source_accepted,
        .stripped_written = stripped_written,
        .err = err,
    } };
    recordStripped(metrics, piece);
    return null;
}

pub fn writeWithoutColor(file: std.Io.File, metrics: *types.Metrics, bytes: []const u8) PlainWriteResult {
    var i: usize = 0;
    var source_accepted: usize = 0;
    var stripped_written: usize = 0;
    while (i < bytes.len) {
        if (bytes[i] == 0x1b and i + 1 < bytes.len and bytes[i + 1] == '[') {
            const end = csiSequenceEnd(bytes, i + 2) orelse bytes.len;
            const seq = bytes[i..@min(end + 1, bytes.len)];
            if (end < bytes.len and bytes[end] == 'm') {
                const wrote = writeFilteredSgr(file, metrics, seq) catch |err| return .{ .partial = .{
                    .source_accepted = source_accepted,
                    .stripped_written = stripped_written,
                    .err = err,
                } };
                stripped_written += wrote;
            } else if (writeRawPiece(file, metrics, seq, source_accepted, stripped_written)) |failed| {
                return failed;
            } else {
                stripped_written += seq.len;
            }
            source_accepted = i + seq.len;
            i += seq.len;
        } else {
            var run_end = i + 1;
            while (run_end < bytes.len) {
                if (bytes[run_end] == 0x1b and run_end + 1 < bytes.len and bytes[run_end + 1] == '[') break;
                run_end += 1;
            }
            const run = bytes[i..run_end];
            if (writeRawPiece(file, metrics, run, source_accepted, stripped_written)) |failed| {
                return failed;
            }
            stripped_written += run.len;
            source_accepted = run_end;
            i = run_end;
        }
    }
    return .{ .complete = stripped_written };
}

pub const InputLineView = struct {
    line: []const u8,
    cursor_col: u16,
};

pub const MultilineInfo = struct {
    total_lines: u16,
    cursor_line: u16,
};

pub fn countMultilineInfo(input: []const u8, cursor: usize, width: u16) MultilineInfo {
    const summary = visual_layout.summarize(.{ .input = input, .cursor = cursor, .terminal_cols = width }, null);
    return .{
        .total_lines = @intCast(@min(summary.total_rows, std.math.maxInt(u16))),
        .cursor_line = @intCast(@min(summary.cursor.row_index, std.math.maxInt(u16))),
    };
}

pub fn buildInputLineForRow(input: []const u8, cursor: usize, line_index: usize, total_lines: usize, width: u16, out: []u8) InputLineView {
    if (width == 0 or out.len == 0) return .{ .line = "", .cursor_col = 1 };

    const source = visual_layout.Source{ .input = input, .cursor = cursor, .terminal_cols = width };
    const summary = visual_layout.summarize(source, null);
    const visible_rows = @max(total_lines, 1);
    const window = visual_layout.visibleWindow(summary.cursor.row_index, summary.total_rows, visible_rows);
    const actual_row = window.first_row + line_index;
    const line = copyVisualRowToBuffer(source, actual_row, out);
    return .{
        .line = line,
        .cursor_col = if (summary.cursor.row_index == actual_row) visual_layout.terminalColumn(summary.cursor, width) else 0,
    };
}

const welcome_build_label_bytes: usize = 96;
fn writeBuildLabel(
    out: []u8,
    version_text: []const u8,
) ![]const u8 {
    return std.fmt.bufPrint(out, "v{s}", .{version_text});
}

pub fn welcomeMessage(alloc: std.mem.Allocator) ![]u8 {
    var label_buf: [welcome_build_label_bytes]u8 = undefined;
    const build_label = try writeBuildLabel(
        &label_buf,
        main.version,
    );
    return std.fmt.allocPrint(
        alloc,
        "{s}fiber{s}{s} {s} · Run /help for commands" ++ reset_style ++ "\n\n",
        .{ subtitle_style, reset_style, dim_style, build_label },
    );
}

pub const StatuslineItems = struct {
    workspace_label: []const u8 = "",
    git_branch: ?[]const u8 = null,
    context_used: u64 = 0,
    context_total: ?u32 = null,
    session_title: ?[]const u8 = null,
};

/// Cell budget for the session title segment. The title is capped at 8 words
/// upstream, so this only bounds pathological single-word titles.
const max_session_title_cells: usize = 32;

fn compactModelLabel(model: []const u8, out: []u8) []const u8 {
    var start: usize = 0;
    for (model, 0..) |byte, i| {
        if (byte == '/') start = i + 1;
    }
    const bare = model[start..];

    const claude_prefix = "claude-";
    if (!std.mem.startsWith(u8, bare, claude_prefix)) return bare;
    const claude_name = bare[claude_prefix.len..];

    inline for (&.{
        .{ "opus-", "opus " },
        .{ "sonnet-", "sonnet " },
        .{ "haiku-", "haiku " },
    }) |mapping| {
        const prefix = mapping[0];
        const label = mapping[1];
        if (std.mem.startsWith(u8, claude_name, prefix)) {
            return std.fmt.bufPrint(out, "{s}{s}", .{ label, claude_name[prefix.len..] }) catch bare;
        }
    }

    return claude_name;
}

fn permissionModeStatusLabel(mode: types.PermissionMode, out: []u8) []const u8 {
    // ask renders in the hint row's statusline grey base, which carries the
    // permission_ask_style value, so it stays bare here.
    return switch (mode) {
        .ask => "ask",
        .auto => std.fmt.bufPrint(out, "{s}auto{s}", .{ permission_auto_style, statusline_style }) catch "auto",
        .yolo => std.fmt.bufPrint(out, "{s}YOLO{s}", .{ permission_yolo_style, statusline_style }) catch "YOLO",
    };
}

/// /context breakdown categories (#310). Every category except free space has
/// exactly one categorical role; contextCategoryStyle is the lookup #310
/// renders from.
pub const ContextCategory = enum {
    system_prompt,
    project_instructions,
    skills,
    builtin_tools,
    mcp_tools,
    environment,
    user_messages,
    assistant_messages,
    reasoning,
    tool_calls,
    tool_output,
    compacted_summary,
    free_space,
};

pub fn contextCategoryStyle(category: ContextCategory) []const u8 {
    return switch (category) {
        .system_prompt => ctx_system_prompt_style,
        .project_instructions => ctx_project_instructions_style,
        .skills => ctx_skills_style,
        .builtin_tools => ctx_builtin_tools_style,
        .mcp_tools => ctx_mcp_tools_style,
        .environment => ctx_environment_style,
        .user_messages => ctx_user_messages_style,
        .assistant_messages => ctx_assistant_messages_style,
        .reasoning => ctx_reasoning_style,
        .tool_calls => ctx_tool_calls_style,
        .tool_output => ctx_tool_output_style,
        .compacted_summary => ctx_compacted_summary_style,
        .free_space => ctx_free_space_style,
    };
}

fn appendStatusSegment(out: []u8, end: *usize, segment: []const u8) void {
    if (segment.len == 0) return;
    const sep = " · ";
    const sep_len = if (end.* > 0) sep.len else 0;
    if (end.* + sep_len + segment.len > out.len) return;

    if (sep_len > 0) {
        @memcpy(out[end.* .. end.* + sep.len], sep);
        end.* += sep.len;
    }
    @memcpy(out[end.* .. end.* + segment.len], segment);
    end.* += segment.len;
}

const statusline_separator = " · ";

fn leadingPermissionModeFits(
    limit: usize,
    permission_label: []const u8,
    model_label: []const u8,
) bool {
    if (limit == 0) return false;
    return display_width.visibleWidthIgnoringAnsi(permission_label) +
        display_width.visibleWidth(statusline_separator) +
        display_width.visibleWidth(model_label) <= limit;
}

const ClippedSegment = struct {
    bytes: []const u8,
    marker_before: bool = false,
    marker_after: bool = false,
};

fn clippedWorkspaceSuffix(encoded: []const u8, max_width: usize) ClippedSegment {
    if (display_width.visibleWidth(encoded) <= max_width) return .{ .bytes = encoded };
    if (max_width <= 1) return .{ .bytes = "", .marker_before = max_width == 1 };
    return .{
        .bytes = text_utils.suffixTerminalSafeByWidth(encoded, max_width - 1),
        .marker_before = true,
    };
}

fn clippedBranchPrefix(encoded: []const u8, max_width: usize) ClippedSegment {
    if (display_width.visibleWidth(encoded) <= max_width) return .{ .bytes = encoded };
    if (max_width <= 1) return .{ .bytes = "", .marker_after = max_width == 1 };
    return .{
        .bytes = text_utils.prefixTerminalSafeByWidth(encoded, max_width - 1),
        .marker_after = true,
    };
}

fn appendIdentityBytes(out: []u8, end: *usize, bytes: []const u8) bool {
    if (end.* + bytes.len > out.len) return false;
    @memcpy(out[end.* .. end.* + bytes.len], bytes);
    end.* += bytes.len;
    return true;
}

fn appendClippedIdentityPart(
    out: []u8,
    end: *usize,
    clipped: ClippedSegment,
) bool {
    if (clipped.marker_before and !appendIdentityBytes(out, end, "…")) return false;
    if (!appendIdentityBytes(out, end, clipped.bytes)) return false;
    if (clipped.marker_after and !appendIdentityBytes(out, end, "…")) return false;
    return true;
}

fn composeWorkspaceIdentity(
    statusline: StatuslineItems,
    max_width: usize,
    out: []u8,
) ?[]const u8 {
    if (statusline.workspace_label.len == 0 or max_width == 0) return null;

    var width_budget = @min(max_width, out.len);
    while (width_budget > 0) : (width_budget -= 1) {
        var end: usize = 0;
        if (statusline.git_branch) |branch| {
            if (branch.len > 0) {
                // Below seven cells, showing fragments of both values is less
                // useful than retaining the working-directory tail alone.
                if (width_budget >= 7) {
                    const branch_width = display_width.visibleWidth(branch);
                    const max_branch_width = width_budget - 4;
                    const branch_budget = @min(
                        branch_width,
                        @min(max_branch_width, @max(@as(usize, 4), width_budget / 2)),
                    );
                    const path_budget = width_budget - 3 - branch_budget;
                    const path = clippedWorkspaceSuffix(statusline.workspace_label, path_budget);
                    const branch_label = clippedBranchPrefix(branch, branch_budget);
                    if (appendClippedIdentityPart(out, &end, path) and
                        appendIdentityBytes(out, &end, " (") and
                        appendClippedIdentityPart(out, &end, branch_label) and
                        appendIdentityBytes(out, &end, ")"))
                    {
                        return out[0..end];
                    }
                    continue;
                }
            }
        }

        const path = clippedWorkspaceSuffix(statusline.workspace_label, width_budget);
        if (appendClippedIdentityPart(out, &end, path)) return out[0..end];
    }
    return null;
}

fn appendWorkspaceIdentity(
    out: []u8,
    end: *usize,
    status_limit: usize,
    statusline: StatuslineItems,
) void {
    if (statusline.workspace_label.len == 0) return;
    const used_width = display_width.visibleWidthIgnoringAnsi(out[0..end.*]);
    const separator_width = if (end.* > 0)
        display_width.visibleWidth(statusline_separator)
    else
        0;
    if (used_width + separator_width >= status_limit) return;

    const separator_bytes = if (end.* > 0) statusline_separator.len else 0;
    if (end.* + separator_bytes >= out.len) return;
    const available_width = status_limit - used_width - separator_width;
    const available_bytes = out.len - end.* - separator_bytes;
    var identity_buf: [512]u8 = undefined;
    const identity = composeWorkspaceIdentity(
        statusline,
        available_width,
        identity_buf[0..@min(identity_buf.len, available_bytes)],
    ) orelse return;
    appendStatusSegment(out, end, identity);
}

pub fn buildHintLine(
    stream_active: bool,
    awaiting_permission: bool,
    has_api_key: bool,
    model: []const u8,
    permission_mode: types.PermissionMode,
    queued_count: usize,
    active_label: ?[]const u8,
    fast_indicator_active: bool,
    effort: types.ReasoningEffort,
    model_supports_effort: bool,
    statusline: StatuslineItems,
    width: u16,
    out: []u8,
) []const u8 {
    _ = active_label;

    var model_buf: [96]u8 = undefined;
    const model_label = compactModelLabel(model, &model_buf);
    var permission_buf: [64]u8 = undefined;
    const permission_label = permissionModeStatusLabel(permission_mode, &permission_buf);

    var end: usize = 0;
    if (!awaiting_permission and !has_api_key) {
        appendStatusSegment(out, &end, "run /login");
    }
    if (!awaiting_permission and queued_count > 0) {
        var queued_buf: [32]u8 = undefined;
        appendStatusSegment(out, &end, std.fmt.bufPrint(&queued_buf, "queued {d}", .{queued_count}) catch "");
    }
    if (stream_active and !awaiting_permission) {
        appendStatusSegment(out, &end, "enter queue");
    }
    const status_limit = @min(@as(usize, width), out.len);
    const show_effort = model_supports_effort and !effort.isDefault();
    if (leadingPermissionModeFits(status_limit, permission_label, model_label)) {
        appendStatusSegment(out, &end, permission_label);
    }
    appendStatusSegment(out, &end, model_label);
    if (show_effort) {
        appendStatusSegment(out, &end, effort.displayLabel());
    }
    if (fast_indicator_active) {
        appendStatusSegment(out, &end, "⚡︎");
    }

    if (statusline.session_title) |title| {
        appendStatusSegment(out, &end, display_width.prefixByWidth(title, max_session_title_cells));
    }

    if (statusline.context_used > 0) {
        if (statusline.context_total) |total| {
            const used_k = statusline.context_used / 1000;
            const total_k: u64 = @as(u64, total) / 1000;
            const pct = if (total > 0) (statusline.context_used * 100) / @as(u64, total) else 0;
            var ctx_buf: [48]u8 = undefined;
            appendStatusSegment(out, &end, std.fmt.bufPrint(&ctx_buf, "Context: {d}k/{d}k {d}%", .{ used_k, total_k, pct }) catch "");
        } else {
            const used_k = statusline.context_used / 1000;
            var ctx_buf: [32]u8 = undefined;
            appendStatusSegment(out, &end, std.fmt.bufPrint(&ctx_buf, "Context: {d}k", .{used_k}) catch "");
        }
    }
    appendWorkspaceIdentity(out, &end, status_limit, statusline);

    const width_usize: usize = width;
    if (width_usize == 0) return "";
    return display_width.prefixByWidthIgnoringAnsi(out[0..end], width_usize);
}

pub fn buildInputLine(input: []const u8, cursor: usize, width: u16, out: []u8) InputLineView {
    const ml = countMultilineInfo(input, cursor, width);
    return buildInputLineForRow(input, cursor, ml.cursor_line, ml.total_lines, width, out);
}

pub fn inputColumnForIndex(input: []const u8, cursor: usize, target: usize, width: u16) u16 {
    const summary = visual_layout.summarize(.{ .input = input, .cursor = cursor, .terminal_cols = width }, target);
    return visual_layout.projectedAnchorColumn(summary, width);
}

fn copyVisualRowToBuffer(source: visual_layout.Source, target_row: usize, out: []u8) []const u8 {
    if (source.terminal_cols == 0 or out.len == 0) return "";

    var len: usize = 0;
    var row_started = false;
    var remaining_cells: usize = 0;
    var omitted_positive_unit = false;
    var it = visual_layout.iterator(source);
    while (it.next()) |event| switch (event) {
        .unit => |unit| {
            if (unit.row_index < target_row) continue;
            if (unit.row_index > target_row) break;
            startVisualRow(source.terminal_cols, target_row, out, &len, &row_started, &remaining_cells);
            if (remaining_cells == 0) continue;
            switch (unit.kind) {
                .text => {
                    if (unit.cell_width == 0) {
                        if (!omitted_positive_unit) appendBytesToBuffer(out, &len, source.input[unit.raw_start..unit.raw_end]);
                    } else if (unit.cell_width <= remaining_cells) {
                        appendBytesToBuffer(out, &len, source.input[unit.raw_start..unit.raw_end]);
                        remaining_cells -= unit.cell_width;
                        omitted_positive_unit = false;
                    } else {
                        omitted_positive_unit = true;
                    }
                },
                .paste_placeholder => {
                    const visible = display_width.prefixByWidth(
                        source.input[unit.raw_start..unit.raw_end],
                        remaining_cells,
                    );
                    appendBytesToBuffer(out, &len, visible);
                    const emitted_width = display_width.visibleWidth(visible);
                    remaining_cells -= emitted_width;
                    omitted_positive_unit = emitted_width < unit.cell_width;
                },
                .tab => {
                    if (unit.cell_width > 0 and unit.cell_width <= remaining_cells) {
                        appendSpacesToBuffer(out, &len, unit.cell_width);
                        remaining_cells -= unit.cell_width;
                        omitted_positive_unit = false;
                    } else if (unit.cell_width > 0) {
                        omitted_positive_unit = true;
                    }
                },
                .skill_token => |token_index| {
                    const token = source.skill_tokens[token_index];
                    if (unit.cell_width <= remaining_cells) {
                        appendBytesToBuffer(out, &len, token.name);
                        remaining_cells -= unit.cell_width;
                        omitted_positive_unit = false;
                    } else {
                        omitted_positive_unit = true;
                    }
                },
                .image_badge => {},
            }
        },
        .row_end => |row| {
            if (row.index < target_row) continue;
            if (row.index == target_row) startVisualRow(source.terminal_cols, target_row, out, &len, &row_started, &remaining_cells);
            break;
        },
    };
    return out[0..len];
}

fn startVisualRow(width: u16, row_index: usize, out: []u8, len: *usize, started: *bool, remaining_cells: *usize) void {
    if (started.*) return;
    started.* = true;
    const prefix = visual_layout.inputPrefix(row_index);
    const clipped = display_width.prefixByWidth(prefix.bytes, width);
    appendBytesToBuffer(out, len, clipped);
    const width_usize: usize = width;
    remaining_cells.* = if (width_usize > prefix.cell_width) width_usize - prefix.cell_width else 0;
}

fn appendBytesToBuffer(out: []u8, len: *usize, bytes: []const u8) void {
    if (bytes.len > out.len - len.*) return;
    @memcpy(out[len.* .. len.* + bytes.len], bytes);
    len.* += bytes.len;
}

fn appendSpacesToBuffer(out: []u8, len: *usize, count: usize) void {
    var i: usize = 0;
    while (i < count and len.* < out.len) : (i += 1) {
        out[len.*] = ' ';
        len.* += 1;
    }
}

test "input line wraps to the cursor row" {
    var buf: [64]u8 = undefined;
    const view = buildInputLine("abcdefghijklmnopqrstuvwxyz", 26, 16, &buf);
    try std.testing.expectEqualStrings("  opqrstuvwxyz", view.line);
    try std.testing.expectEqual(@as(u16, 15), view.cursor_col);
}

test "input line wraps without cutting emoji bytes" {
    var buf: [64]u8 = undefined;
    const view = buildInputLine("a😀b", "a😀b".len, 5, &buf);
    try std.testing.expectEqualStrings("  b", view.line);
    try std.testing.expectEqual(@as(u16, 4), view.cursor_col);
}

test "wrapped input row builder exposes all visual rows" {
    var buf: [64]u8 = undefined;
    const input = "abcdefgh";
    const ml = countMultilineInfo(input, input.len, 6);
    try std.testing.expectEqual(@as(u16, 2), ml.total_lines);
    try std.testing.expectEqual(@as(u16, 1), ml.cursor_line);

    const first = buildInputLineForRow(input, input.len, 0, ml.total_lines, 6, &buf);
    try std.testing.expectEqualStrings("❯ abcd", first.line);
    try std.testing.expectEqual(@as(u16, 0), first.cursor_col);

    const second = buildInputLineForRow(input, input.len, 1, ml.total_lines, 6, &buf);
    try std.testing.expectEqualStrings("  efgh", second.line);
    try std.testing.expectEqual(@as(u16, 6), second.cursor_col);
}

test "hard newline keeps cursor at end of previous row" {
    var buf: [64]u8 = undefined;
    const input = "abc\ndef";
    const view = buildInputLine(input, 3, 20, &buf);
    try std.testing.expectEqualStrings("❯ abc", view.line);
    try std.testing.expectEqual(@as(u16, 6), view.cursor_col);
}

test "inputColumnForIndex aligns active token under input" {
    const input = "/model openai/gpt-5 high";
    const col = inputColumnForIndex(input, input.len, "/model openai/gpt-5 ".len, 80);
    try std.testing.expectEqual(@as(u16, 23), col);
}

test "render geometry wrappers match visual layout projections" {
    const input = "abc\ndefgh";
    const source = visual_layout.Source{ .input = input, .cursor = input.len, .terminal_cols = 6 };
    const summary = visual_layout.summarize(source, "abc\n".len + 1);
    const ml = countMultilineInfo(input, input.len, 6);
    try std.testing.expectEqual(@as(u16, @intCast(summary.total_rows)), ml.total_lines);
    try std.testing.expectEqual(@as(u16, @intCast(summary.cursor.row_index)), ml.cursor_line);
    try std.testing.expectEqual(visual_layout.projectedAnchorColumn(summary, 6), inputColumnForIndex(input, input.len, "abc\n".len + 1, 6));

    try std.testing.expectEqual(@as(u16, 3), visual_layout.terminalColumn(.{ .raw_offset = 0, .row_index = 0, .content_column = 0 }, 80));
    try std.testing.expectEqual(@as(u16, 3), visual_layout.terminalColumn(.{ .raw_offset = 0, .row_index = 1, .content_column = 0 }, 80));
    try std.testing.expectEqual(@as(u16, 6), visual_layout.terminalColumn(.{ .raw_offset = 3, .row_index = 0, .content_column = 3 }, 80));
}

test "render row window stays cursor-containing for direct and restored input" {
    var buf: [128]u8 = undefined;
    inline for (.{ "x" ** 4096, "y" ** 5000 }) |input| {
        const summary = visual_layout.summarize(.{ .input = input, .cursor = input.len, .terminal_cols = 80 }, null);
        const window = visual_layout.visibleWindow(summary.cursor.row_index, summary.total_rows, 4);
        try std.testing.expect(window.first_row <= summary.cursor.row_index);
        try std.testing.expect(summary.cursor.row_index < window.first_row + window.row_count);

        const view = buildInputLineForRow(input, input.len, 3, 4, 80, &buf);
        try std.testing.expect(std.mem.startsWith(u8, view.line, "  "));
        try std.testing.expect(view.cursor_col > 0);
    }
}

test "render soft-wrap boundary and earlier anchors use cursor row columns" {
    var buf: [64]u8 = undefined;
    const input = "abcd";
    const view = buildInputLine(input, 3, 5, &buf);
    try std.testing.expectEqualStrings("  d", view.line);
    try std.testing.expectEqual(@as(u16, 3), view.cursor_col);

    const earlier_anchor_col = inputColumnForIndex("abcdef", 5, 1, 5);
    try std.testing.expectEqual(@as(u16, 3), earlier_anchor_col);
}

test "render tabs use visual layout absolute tab stops" {
    const input = "\tX";
    const summary = visual_layout.summarize(.{ .input = input, .cursor = 1, .terminal_cols = 10 }, 1);
    try std.testing.expectEqual(@as(u16, 9), visual_layout.projectedAnchorColumn(summary, 10));
    try std.testing.expectEqual(@as(u16, 9), inputColumnForIndex(input, 1, 1, 10));

    const wrapped = "aaaaaa\tXY";
    const wrapped_summary = visual_layout.summarize(.{ .input = wrapped, .cursor = wrapped.len, .terminal_cols = 10 }, wrapped.len - 1);
    try std.testing.expectEqual(visual_layout.projectedAnchorColumn(wrapped_summary, 10), inputColumnForIndex(wrapped, wrapped.len, wrapped.len - 1, 10));
}

test "render width zero emits no row bytes and first cursor column" {
    var buf: [8]u8 = undefined;
    const view = buildInputLine("abc", 3, 0, &buf);
    try std.testing.expectEqualStrings("", view.line);
    try std.testing.expectEqual(@as(u16, 1), view.cursor_col);
}

/// Writes the title to the same file the transcript renders to, so a host
/// that redirects its output keeps the escape sequence out of the real
/// stdout. `out` must outlive every call.
pub fn terminalTitleFor(out: *const std.Io.File) host.TerminalTitle {
    return .{
        .context = @constCast(out),
        .set_fn = setTerminalTitleLabel,
        .clear_fn = clearTerminalTitleProvider,
    };
}

fn titleOutput(raw: ?*anyopaque) std.Io.File {
    const out: *const std.Io.File = @ptrCast(@alignCast(raw.?));
    return out.*;
}

const terminal_title_osc_prefix = "\x1b]2;";
const terminal_title_display_prefix = "fiber · ";
const terminal_title_max_content_bytes: usize = 128;
const terminal_title_max_label_bytes = terminal_title_max_content_bytes - terminal_title_display_prefix.len;

fn sanitizedTerminalTitleLabel(raw: []const u8, buffer: *[terminal_title_max_label_bytes]u8) []const u8 {
    const marker = "...";
    var source_index: usize = 0;
    var written: usize = 0;
    while (source_index < raw.len) {
        const sequence_len: usize = std.unicode.utf8ByteSequenceLength(raw[source_index]) catch {
            source_index += 1;
            continue;
        };
        if (raw.len - source_index < sequence_len) break;
        const sequence = raw[source_index .. source_index + sequence_len];
        const codepoint = std.unicode.utf8Decode(sequence) catch {
            source_index += 1;
            continue;
        };
        source_index += sequence_len;
        if (codepoint < 0x20 or (codepoint >= 0x7f and codepoint <= 0x9f)) continue;
        if (written + sequence_len > buffer.len) {
            written = text_utils.utf8BackwardBoundary(buffer[0..written], buffer.len - marker.len);
            @memcpy(buffer[written .. written + marker.len], marker);
            written += marker.len;
            break;
        }
        @memcpy(buffer[written .. written + sequence_len], sequence);
        written += sequence_len;
    }
    return buffer[0..written];
}

fn setTerminalTitleLabel(raw: ?*anyopaque, label: []const u8) void {
    const out = titleOutput(raw);
    var label_buffer: [terminal_title_max_label_bytes]u8 = undefined;
    const sanitized = sanitizedTerminalTitleLabel(label, &label_buffer);
    var sequence_buffer: [terminal_title_osc_prefix.len + terminal_title_max_content_bytes + 1]u8 = undefined;
    var sequence: std.Io.Writer = .fixed(&sequence_buffer);
    sequence.writeAll(terminal_title_osc_prefix) catch return;
    sequence.writeAll(terminal_title_display_prefix) catch return;
    sequence.writeAll(sanitized) catch return;
    sequence.writeByte('\x07') catch return;
    out.writeStreamingAll(io_mod.getIo(), sequence.buffered()) catch return;
}

fn clearTerminalTitleProvider(raw: ?*anyopaque) void {
    const out = titleOutput(raw);
    out.writeStreamingAll(io_mod.getIo(), "\x1b]2;\x07") catch return;
}

test "terminal title writes the label to the caller's output file" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var sink = try tmp.dir.createFile(std.testing.io, "terminal-title.log", .{});
    defer sink.close(io_mod.getIo());

    // A host that redirects its output keeps the escape sequence off the
    // real stdout, which the Zig test runner owns as its protocol channel.
    terminalTitleFor(&sink).set("release notes");

    var written_file = try tmp.dir.openFile(io_mod.getIo(), "terminal-title.log", .{});
    defer written_file.close(io_mod.getIo());
    const written = try io_mod.readFileToEnd(alloc, &written_file, 128);
    defer alloc.free(written);
    try std.testing.expectEqualStrings("\x1b]2;fiber · release notes\x07", written);
}

test "terminal title sanitizes and bounds untrusted labels" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var sink = try tmp.dir.createFile(std.testing.io, "terminal-title-hostile.log", .{});
    defer sink.close(io_mod.getIo());

    terminalTitleFor(&sink).set("safe\x07\x1b]2;owned\xc2\x9b" ++ ("é" ** 80));

    var written_file = try tmp.dir.openFile(io_mod.getIo(), "terminal-title-hostile.log", .{});
    defer written_file.close(io_mod.getIo());
    const written = try io_mod.readFileToEnd(alloc, &written_file, 512);
    defer alloc.free(written);
    try std.testing.expect(written.len <= terminal_title_osc_prefix.len + terminal_title_max_content_bytes + 1);
    try std.testing.expect(std.mem.startsWith(u8, written, "\x1b]2;fiber · safe]2;owned"));
    try std.testing.expect(std.mem.endsWith(u8, written, "...\x07"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, written, "\x07"));
    try std.testing.expect(std.mem.find(u8, written[terminal_title_osc_prefix.len..], "\x1b") == null);
    try std.testing.expect(std.mem.find(u8, written, "\xc2\x9b") == null);
}

test "terminal title clear restores a predictable empty state" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var sink = try tmp.dir.createFile(std.testing.io, "terminal-title-clear.log", .{});
    defer sink.close(io_mod.getIo());

    terminalTitleFor(&sink).clear();

    var written_file = try tmp.dir.openFile(io_mod.getIo(), "terminal-title-clear.log", .{});
    defer written_file.close(io_mod.getIo());
    const written = try io_mod.readFileToEnd(alloc, &written_file, 32);
    defer alloc.free(written);
    try std.testing.expectEqualStrings("\x1b]2;\x07", written);
}

pub fn formatResumeHandoff(
    buffer: []u8,
    session_id: []const u8,
    terminal_cols: u16,
) ![]const u8 {
    const label = "Continue session with:";
    const command = "fiber resume ";
    const single_row_width = label.len + 1 + command.len + session_id.len;
    const separator = if (single_row_width <= terminal_cols) " " else "\n  ";
    return std.fmt.bufPrint(
        buffer,
        "{s}{s}{s}{s}{s}{s}\n",
        .{ dim_style, label, separator, command, session_id, reset_style },
    );
}

test "initTheme sets light mode styles" {
    initTheme(true, null);
    try std.testing.expect(is_light);
    try std.testing.expect(!std.mem.eql(u8, subtitle_style, "\x1b[1;38;5;255m"));

    initTheme(false, null);
    try std.testing.expect(!is_light);
    try std.testing.expectEqualStrings("\x1b[1;38;5;255m", subtitle_style);
}

test "resume handoff uses one row only when the full instruction fits" {
    initTheme(false, null);
    defer initTheme(false, null);

    const single_row = "Continue session with: fiber resume session-123";
    var exact_buffer: [128]u8 = undefined;
    const exact = try formatResumeHandoff(&exact_buffer, "session-123", single_row.len);
    try std.testing.expectEqualStrings(
        "\x1b[38;5;245mContinue session with: fiber resume session-123\x1b[0m\n",
        exact,
    );

    var narrow_buffer: [128]u8 = undefined;
    const narrow = try formatResumeHandoff(&narrow_buffer, "session-123", single_row.len - 1);
    try std.testing.expectEqualStrings(
        "\x1b[38;5;245mContinue session with:\n  fiber resume session-123\x1b[0m\n",
        narrow,
    );
}

test "resume handoff follows the active muted theme shade" {
    initTheme(true, null);
    defer initTheme(false, null);

    var buffer: [128]u8 = undefined;
    const message = try formatResumeHandoff(&buffer, "session-123", 80);
    try std.testing.expectEqualStrings(
        "\x1b[38;5;247mContinue session with: fiber resume session-123\x1b[0m\n",
        message,
    );
}

test "themeNeedsUpdate compares the active terminal background" {
    initTheme(false, .{ .r = 20, .g = 21, .b = 22 });
    defer initTheme(false, null);

    try std.testing.expect(!themeNeedsUpdate(false, null));
    try std.testing.expect(!themeNeedsUpdate(false, .{ .r = 20, .g = 21, .b = 22 }));
    try std.testing.expect(themeNeedsUpdate(false, .{ .r = 21, .g = 21, .b = 22 }));
    try std.testing.expect(themeNeedsUpdate(true, null));
}

test "initTheme selects the light inline code foreground" {
    const alloc = std.testing.allocator;
    assistant_presentation.setInlineCodeTheme(false);
    defer initTheme(false, null);

    initTheme(true, null);

    var processor = assistant_presentation.MarkdownProcessor{};
    defer processor.deinit(alloc);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);

    try processor.push(alloc, "run `zig build` now\n", &out);
    try std.testing.expectEqualStrings("run \x1b[38;5;247mzig build\x1b[39m now\n", out.items);
}

test "welcomeMessage shows version and help hint" {
    const message = try welcomeMessage(std.testing.allocator);
    defer std.testing.allocator.free(message);

    try std.testing.expect(std.mem.find(u8, message, "fiber") != null);
    try std.testing.expect(std.mem.find(u8, message, main.version) != null);
    try std.testing.expect(std.mem.find(u8, message, "/help") != null);
}

test "welcomeMessage keeps only the app name bright" {
    initTheme(false, null);
    const message = try welcomeMessage(std.testing.allocator);
    defer std.testing.allocator.free(message);

    var label_buf: [welcome_build_label_bytes]u8 = undefined;
    const build_label = try writeBuildLabel(
        &label_buf,
        main.version,
    );
    const expected = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}fiber{s}{s} {s} · Run /help for commands" ++ reset_style ++ "\n\n",
        .{ subtitle_style, reset_style, dim_style, build_label },
    );
    defer std.testing.allocator.free(expected);

    try std.testing.expectEqualStrings(expected, message);
}

test "build label stays bare on the stable channel" {
    var buf: [welcome_build_label_bytes]u8 = undefined;
    const label = try writeBuildLabel(&buf, "0.0.4");
    try std.testing.expectEqualStrings("v0.0.4", label);
}

test "buildHintLine advertises queue without persistent steering hint while streaming" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(true, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{}, 120, &buf);
    try std.testing.expect(std.mem.find(u8, line, "enter queue") != null);
    try std.testing.expect(std.mem.find(u8, line, "ctrl+enter steer") == null);
}

test "buildHintLine hides effort when it is auto" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "anthropic/claude-opus-4.7", .ask, 0, null, false, .auto, true, .{}, 80, &buf);
    try std.testing.expectEqualStrings("ask · opus 4.7", line);
}

test "buildHintLine hides effort for models without effort support" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-4o", .ask, 0, null, false, .auto, false, .{}, 80, &buf);
    try std.testing.expectEqualStrings("ask · gpt-4o", line);
}

test "buildHintLine uses a monochrome lightning marker for fast mode" {
    initTheme(false, null);
    defer initTheme(false, null);

    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "anthropic/claude-opus-4.8", .ask, 0, null, true, types.ReasoningEffort.literal("low"), true, .{}, 80, &buf);
    try std.testing.expectEqualStrings("ask · opus 4.8 · low · ⚡︎", line);
    try std.testing.expectEqual(@as(usize, 25), display_width.visibleWidthIgnoringAnsi(line));
}

test "buildHintLine shows effort when active" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, types.ReasoningEffort.literal("high"), true, .{}, 80, &buf);
    try std.testing.expectEqualStrings("ask · gpt-5 · high", line);
}

test "buildHintLine shows full context usage" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "anthropic/claude-opus-4.8", .ask, 0, null, false, .auto, true, .{
        .context_used = 43_000,
        .context_total = 1_000_000,
    }, 80, &buf);
    try std.testing.expectEqualStrings("ask · opus 4.8 · Context: 43k/1000k 4%", line);
}

test "buildHintLine shows the session title" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .session_title = "add a session name display",
    }, 200, &buf);
    try std.testing.expectEqualStrings(
        "ask · gpt-5 · add a session name display",
        line,
    );
}

test "buildHintLine clips an overlong session title on a character boundary" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .session_title = "ααααααααααααααααααααααααααααααααααααααααα",
    }, 200, &buf);
    try std.testing.expect(std.mem.startsWith(u8, line, "ask · gpt-5 · "));
    const title = line["ask · gpt-5 · ".len..];
    try std.testing.expect(std.unicode.utf8ValidateSlice(title));
    try std.testing.expectEqual(@as(usize, 32), display_width.visibleWidth(title));
}

test "buildHintLine omits the session segment when no title is cached" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .session_title = null,
    }, 80, &buf);
    try std.testing.expectEqualStrings("ask · gpt-5", line);
}

test "buildHintLine shows the workspace and Git branch" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .workspace_label = "/workspace/code/fiber",
        .git_branch = "feature/statusline",
    }, 100, &buf);
    try std.testing.expectEqualStrings(
        "ask · gpt-5 · /workspace/code/fiber (feature/statusline)",
        line,
    );
}

test "buildHintLine keeps workspace and branch readable at narrow widths" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .workspace_label = "/a/very/long/path/fiber-repo",
        .git_branch = "feat/statusline",
    }, 36, &buf);
    try std.testing.expectEqual(@as(usize, 36), display_width.visibleWidthIgnoringAnsi(line));
    try std.testing.expectEqualStrings("ask · gpt-5 · …er-repo (feat/statu…)", line);
}

test "buildHintLine workspace identity does not displace existing status segments" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, true, "anthropic/claude-opus-4.8", .auto, 0, null, true, types.ReasoningEffort.literal("xhigh"), true, .{
        .workspace_label = "/a/very/long/path/to/the/active/workspace",
        .git_branch = "feature/statusline",
        .context_used = 1_000,
        .context_total = 100_000,
    }, 60, &buf);
    try std.testing.expect(std.mem.find(u8, line, "xhigh") != null);
    try std.testing.expect(std.mem.find(u8, line, "⚡︎") != null);
    try std.testing.expect(std.mem.find(u8, line, "Context: 1k/100k 1%") != null);
}

test "buildHintLine shows a non-Git workspace without branch punctuation" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .workspace_label = "/tmp/plain-workspace",
    }, 80, &buf);
    try std.testing.expectEqualStrings(
        "ask · gpt-5 · /tmp/plain-workspace",
        line,
    );
}

test "buildHintLine labels detached HEAD" {
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-5", .ask, 0, null, false, .auto, false, .{
        .workspace_label = "/tmp/fiber",
        .git_branch = "detached:0123456789ab",
    }, 80, &buf);
    try std.testing.expectEqualStrings(
        "ask · gpt-5 · /tmp/fiber (detached:0123456789ab)",
        line,
    );
}

test "buildHintLine keeps system labels and dot separators" {
    var buf: [256]u8 = undefined;
    const line = buildHintLine(false, false, false, "anthropic/claude-opus-4.8", .auto, 2, null, true, types.ReasoningEffort.literal("low"), true, .{
        .context_used = 43_000,
        .context_total = 1_000_000,
    }, 256, &buf);
    const expected = try std.fmt.allocPrint(
        std.testing.allocator,
        "run /login · queued 2 · {s}auto{s} · opus 4.8 · low · ⚡︎ · Context: 43k/1000k 4%",
        .{ permission_auto_style, statusline_style },
    );
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(
        expected,
        line,
    );
}

test "buildHintLine skips an over-capacity segment without a dangling dot" {
    var buf: [16]u8 = undefined;
    const line = buildHintLine(false, false, true, "anthropic/claude-opus-4.7", .ask, 0, null, true, .auto, true, .{}, 80, &buf);
    try std.testing.expectEqualStrings("ask · opus 4.7", line);
}

test "buildHintLine colors auto mode with theme accent" {
    initTheme(false, null);
    const dark_accent = permission_auto_style;
    const dark_status = statusline_style;
    var dark_buf: [128]u8 = undefined;
    const dark_line = buildHintLine(false, false, true, "openai/gpt-4o", .auto, 0, null, false, .auto, false, .{}, 80, &dark_buf);
    const dark_expected = try std.fmt.allocPrint(std.testing.allocator, "{s}auto{s} · gpt-4o", .{ dark_accent, dark_status });
    defer std.testing.allocator.free(dark_expected);
    try std.testing.expectEqualStrings(dark_expected, dark_line);

    initTheme(true, null);
    defer initTheme(false, null);
    try std.testing.expect(!std.mem.eql(u8, permission_auto_style, dark_accent));
    var light_buf: [128]u8 = undefined;
    const light_line = buildHintLine(false, false, true, "openai/gpt-4o", .auto, 0, null, false, .auto, false, .{}, 80, &light_buf);
    const light_expected = try std.fmt.allocPrint(std.testing.allocator, "{s}auto{s} · gpt-4o", .{ permission_auto_style, statusline_style });
    defer std.testing.allocator.free(light_expected);
    try std.testing.expectEqualStrings(light_expected, light_line);
}

test "buildHintLine renders yolo uppercase with permission yolo styling" {
    initTheme(false, null);
    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-4o", .yolo, 0, null, false, .auto, false, .{}, 80, &buf);
    const expected = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}YOLO{s} · gpt-4o",
        .{ permission_yolo_style, statusline_style },
    );
    defer std.testing.allocator.free(expected);

    try std.testing.expectEqualStrings(expected, line);
}

test "buildHintLine clips styled auto mode by visible width" {
    initTheme(false, null);
    defer initTheme(false, null);

    var buf: [128]u8 = undefined;
    const line = buildHintLine(false, false, true, "openai/gpt-4o", .auto, 0, null, false, .auto, false, .{}, 13, &buf);
    const expected = try std.fmt.allocPrint(std.testing.allocator, "{s}auto{s} · gpt-4o", .{ permission_auto_style, statusline_style });
    defer std.testing.allocator.free(expected);

    try std.testing.expectEqualStrings(expected, line);
    try std.testing.expectEqual(@as(usize, 13), display_width.visibleWidthIgnoringAnsi(line));
    try std.testing.expect(std.mem.endsWith(u8, line, "gpt-4o"));
}

fn testLinearizeChannel(value: u8) f64 {
    const c: f64 = @as(f64, @floatFromInt(value)) / 255.0;
    if (c <= 0.03928) return c / 12.92;
    return std.math.pow(f64, (c + 0.055) / 1.055, 2.4);
}

fn testRelativeLuminance(r: u8, g: u8, b: u8) f64 {
    return 0.2126 * testLinearizeChannel(r) + 0.7152 * testLinearizeChannel(g) + 0.0722 * testLinearizeChannel(b);
}

fn testContrastRatio(a: ColorDef, r: u8, g: u8, b: u8) f64 {
    const first = testRelativeLuminance(a.r, a.g, a.b);
    const second = testRelativeLuminance(r, g, b);
    const high = @max(first, second);
    const low = @min(first, second);
    return (high + 0.05) / (low + 0.05);
}

// The light value of each text role is read on #ffffff, the dark value on
// #1c1c1c: one hue cannot reach 4.5:1 on both, which is why the roles carry
// per-theme values.
const status_role_shades = [_]struct { name: []const u8, light: ColorDef, dark: ColorDef }{
    .{ .name = "error", .light = error_light, .dark = error_dark },
    .{ .name = "warning", .light = warning_light, .dark = warning_dark },
    .{ .name = "success", .light = success_light, .dark = success_dark },
    .{ .name = "permission ask", .light = ask_light, .dark = ask_dark },
    .{ .name = "permission auto", .light = warning_light, .dark = warning_dark },
    .{ .name = "permission yolo", .light = error_light, .dark = error_dark },
    .{ .name = "thinking marker", .light = thinking_light, .dark = thinking_dark },
};

const categorical_role_shades = [_]struct { category: ContextCategory, light: ColorDef, dark: ColorDef }{
    .{ .category = .system_prompt, .light = ctx_system_prompt_light, .dark = ctx_system_prompt_dark },
    .{ .category = .project_instructions, .light = ctx_project_instructions_light, .dark = ctx_project_instructions_dark },
    .{ .category = .skills, .light = ctx_skills_light, .dark = ctx_skills_dark },
    .{ .category = .builtin_tools, .light = ctx_builtin_tools_light, .dark = ctx_builtin_tools_dark },
    .{ .category = .mcp_tools, .light = ctx_mcp_tools_light, .dark = ctx_mcp_tools_dark },
    .{ .category = .environment, .light = ctx_environment_light, .dark = ctx_environment_dark },
    .{ .category = .user_messages, .light = ctx_user_messages_light, .dark = ctx_user_messages_dark },
    .{ .category = .assistant_messages, .light = ctx_assistant_messages_light, .dark = ctx_assistant_messages_dark },
    .{ .category = .reasoning, .light = ctx_reasoning_light, .dark = ctx_reasoning_dark },
    .{ .category = .tool_calls, .light = ctx_tool_calls_light, .dark = ctx_tool_calls_dark },
    .{ .category = .tool_output, .light = ctx_tool_output_light, .dark = ctx_tool_output_dark },
    .{ .category = .compacted_summary, .light = ctx_compacted_summary_light, .dark = ctx_compacted_summary_dark },
};

test "semantic roles meet text contrast on their theme background" {
    for (status_role_shades) |role| {
        try std.testing.expect(testContrastRatio(role.light, 0xff, 0xff, 0xff) >= 4.5);
        try std.testing.expect(testContrastRatio(role.dark, 0x1c, 0x1c, 0x1c) >= 4.5);
    }
}

test "categorical roles meet non-text contrast on their theme background" {
    for (categorical_role_shades) |role| {
        try std.testing.expect(testContrastRatio(role.light, 0xff, 0xff, 0xff) >= 3.0);
        try std.testing.expect(testContrastRatio(role.dark, 0x1c, 0x1c, 0x1c) >= 3.0);
    }
}

// Hue families slice the colour wheel into twelve 30-degree buckets so the
// collision check compares families, not exact equality. Near-grey shades
// carry no hue claim and are skipped.
fn testHueFamily(r: u8, g: u8, b: u8) ?u4 {
    const max = @max(r, @max(g, b));
    const min = @min(r, @min(g, b));
    if (max == 0) return null;
    const saturation = @as(f64, @floatFromInt(max - min)) / @as(f64, @floatFromInt(max));
    if (saturation < 0.12) return null;
    const rf: f64 = @floatFromInt(r);
    const gf: f64 = @floatFromInt(g);
    const bf: f64 = @floatFromInt(b);
    const delta: f64 = @floatFromInt(max - min);
    var h: f64 = undefined;
    if (max == r) {
        h = @mod((gf - bf) / delta, 6.0);
    } else if (max == g) {
        h = (bf - rf) / delta + 2.0;
    } else {
        h = (rf - gf) / delta + 4.0;
    }
    return @intCast(@as(u64, @intFromFloat(@floor(h * 2.0))) % 12);
}

test "categorical roles cover every context category and avoid status hues" {
    const status_shades = [_]ColorDef{
        error_light, error_dark, warning_light, warning_dark, success_light, success_dark,
    };
    var status_families = [_]bool{false} ** 12;
    for (status_shades) |status| {
        if (testHueFamily(status.r, status.g, status.b)) |family| status_families[family] = true;
    }
    // Every category resolves to a role, and free space stays unstyled.
    for (categorical_role_shades) |role| {
        try std.testing.expect(contextCategoryStyle(role.category).len > 0);
    }
    try std.testing.expectEqualStrings("", contextCategoryStyle(.free_space));
    try std.testing.expectEqualStrings("", ctx_free_space_style);
    // No categorical value equals a status hue, in truecolor or 256-color,
    // and no saturated categorical value shares a status hue family.
    for (categorical_role_shades) |role| {
        for ([_]ColorDef{ role.light, role.dark }) |shade| {
            for (status_shades) |status| {
                try std.testing.expect(shade.r != status.r or shade.g != status.g or shade.b != status.b);
                try std.testing.expect(!std.mem.eql(u8, shade.truecolor, status.truecolor));
                try std.testing.expect(!std.mem.eql(u8, shade.fallback_256, status.fallback_256));
            }
            if (testHueFamily(shade.r, shade.g, shade.b)) |family| {
                try std.testing.expect(!status_families[family]);
            }
        }
    }
}

test "initTheme paints notice, status and permission hues on both themes" {
    setTruecolorSupport(true);
    initTheme(false, null);
    try std.testing.expectEqualStrings(error_dark.truecolor, notice_error_style);
    try std.testing.expectEqualStrings(warning_dark.truecolor, notice_warning_style);
    try std.testing.expectEqualStrings(success_dark.truecolor, notice_success_style);
    // The shared styles stay grey: tool states, MCP failures, input
    // warnings, questions and resume menus never take a status hue.
    try std.testing.expectEqualStrings("\x1b[38;5;252m", red_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", warning_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", green_style);
    try std.testing.expectEqualStrings(ask_dark.truecolor, permission_ask_style);
    try std.testing.expectEqualStrings(warning_dark.truecolor, permission_auto_style);
    try std.testing.expectEqualStrings(error_dark.truecolor, permission_yolo_style);
    try std.testing.expectEqualStrings(thinking_dark.truecolor, thinking_marker_style);
    try std.testing.expectEqualStrings(ctx_user_messages_dark.truecolor, contextCategoryStyle(.user_messages));

    initTheme(true, null);
    try std.testing.expectEqualStrings(error_light.truecolor, notice_error_style);
    try std.testing.expectEqualStrings(warning_light.truecolor, notice_warning_style);
    try std.testing.expectEqualStrings(success_light.truecolor, notice_success_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", red_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", warning_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", green_style);
    try std.testing.expectEqualStrings(warning_light.truecolor, permission_auto_style);
    try std.testing.expectEqualStrings(error_light.truecolor, permission_yolo_style);
    try std.testing.expectEqualStrings(thinking_light.truecolor, thinking_marker_style);

    setTruecolorSupport(false);
    initTheme(false, null);
    defer {
        setTruecolorSupport(true);
        initTheme(false, null);
    }
    try std.testing.expectEqualStrings(error_dark.fallback_256, notice_error_style);
    try std.testing.expectEqualStrings("\x1b[38;5;252m", red_style);
    try std.testing.expectEqualStrings(warning_dark.fallback_256, permission_auto_style);
    try std.testing.expectEqualStrings(error_dark.fallback_256, permission_yolo_style);
    try std.testing.expectEqualStrings(ctx_compacted_summary_dark.fallback_256, contextCategoryStyle(.compacted_summary));
}

test "colorEnabledForEnv honors NO_COLOR and TERM=dumb" {
    try std.testing.expect(colorEnabledForEnv(false, "xterm-256color"));
    try std.testing.expect(colorEnabledForEnv(false, null));
    try std.testing.expect(!colorEnabledForEnv(true, "xterm-256color"));
    try std.testing.expect(!colorEnabledForEnv(true, null));
    try std.testing.expect(!colorEnabledForEnv(false, "dumb"));
    try std.testing.expect(colorEnabledForEnv(false, "dumber"));
}

fn writeWithoutColorToTmp(input: []const u8) !struct { bytes: []u8, metrics: types.Metrics } {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile(std.testing.io, "stripped.log", .{ .read = true });
    defer file.close(io_mod.getIo());
    var metrics: types.Metrics = .{};
    const result = writeWithoutColor(file, &metrics, input);
    const written = switch (result) {
        .complete => |n| n,
        .partial => return error.TestUnexpectedResult,
    };
    const out = try std.testing.allocator.alloc(u8, written);
    errdefer std.testing.allocator.free(out);
    try std.testing.expectEqual(written, try file.readPositionalAll(io_mod.getIo(), out, 0));
    return .{ .bytes = out, .metrics = metrics };
}

test "writeWithoutColor drops color SGR and keeps styles" {
    const input = "\x1b[38;5;252mnotice\x1b[0m \x1b[1;38;5;255mbright\x1b[39m \x1b[31mred\x1b[7mok\x1b[27m \x1b[2mdim\x1b[22m \x1b[3mi\x1b[23m \x1b[4mu\x1b[24m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings(
        "notice\x1b[0m \x1b[1mbright red\x1b[7mok\x1b[27m \x1b[2mdim\x1b[22m \x1b[3mi\x1b[23m \x1b[4mu\x1b[24m",
        result.bytes,
    );
}

test "writeWithoutColor drops truecolor and background runs" {
    const input = "a\x1b[38;2;48;164;108m+\x1b[0m\x1b[48;5;255m\x1b[38;5;235m\x1b[1mbutton\x1b[0m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings("a+\x1b[0m\x1b[1mbutton\x1b[0m", result.bytes);
}

test "writeWithoutColor keeps trailing styles after a truecolor run" {
    const input = "\x1b[1;38;2;48;164;108;4mok\x1b[0m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings("\x1b[1;4mok\x1b[0m", result.bytes);
}

test "writeWithoutColor drops colon-form colours but keeps colon styles" {
    const input = "\x1b[38:5:203mcolon\x1b[0m \x1b[4:3mcurly\x1b[0m \x1b[58:2::200:30:30munder\x1b[59m \x1b[58;5;9msemi\x1b[0m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings("colon\x1b[0m \x1b[4:3mcurly\x1b[0m under semi\x1b[0m", result.bytes);
}

test "writeWithoutColor keeps styles after underline-default 59" {
    const input = "\x1b[59;4mok\x1b[0m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings("\x1b[4mok\x1b[0m", result.bytes);
}

test "writeWithoutColor leaves movement and erase sequences alone" {
    const input = "\x1b[?25l\x1b[10;1H\x1b[Ktext\x1b[2J\x1b[3J\x1b[H\x1b]2;fiber · hi\x07";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    try std.testing.expectEqualStrings(input, result.bytes);
}

test "writeWithoutColor emits no color SGR parameters" {
    const input = "\x1b[38;5;252merror\x1b[0m \x1b[1;33mwarn\x1b[0m \x1b[92mok\x1b[0m \x1b[48;2;1;2;3mbg\x1b[49m \x1b[38:5:203mcolon\x1b[0m";
    const result = try writeWithoutColorToTmp(input);
    defer std.testing.allocator.free(result.bytes);
    var i: usize = 0;
    while (i < result.bytes.len) {
        if (result.bytes[i] == 0x1b and i + 1 < result.bytes.len and result.bytes[i + 1] == '[') {
            var end = i + 2;
            while (end < result.bytes.len and (result.bytes[end] < 0x40 or result.bytes[end] > 0x7e)) : (end += 1) {}
            try std.testing.expect(end < result.bytes.len);
            if (result.bytes[end] == 'm') {
                var params = std.mem.splitScalar(u8, result.bytes[i + 2 .. end], ';');
                while (params.next()) |param| {
                    const value = std.fmt.parseUnsigned(u16, param, 10) catch continue;
                    try std.testing.expect(!((value >= 30 and value <= 37) or (value >= 40 and value <= 47) or
                        (value >= 90 and value <= 97) or (value >= 100 and value <= 107)));
                    try std.testing.expect(value != 38 and value != 48);
                }
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
    try std.testing.expect(std.mem.find(u8, result.bytes, "38;") == null);
    try std.testing.expect(std.mem.find(u8, result.bytes, "48;") == null);
}
