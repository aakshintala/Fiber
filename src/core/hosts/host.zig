const std = @import("std");
const builtin = @import("builtin");

pub const TerminalSupport = enum {
    unsupported,
    supported,

    pub fn isSupported(self: TerminalSupport) bool {
        return self == .supported;
    }
};

pub const Capabilities = struct {
    process_control: bool,
    url_open: bool,
    native_url_open: bool,
    terminal: TerminalSupport,
};

pub const UrlOpenError = std.mem.Allocator.Error;

pub const UrlOpener = struct {
    context: ?*anyopaque = null,
    open_fn: *const fn (
        ?*anyopaque,
        std.mem.Allocator,
        []const u8,
    ) UrlOpenError!bool,

    /// Borrows `url` for this call. The caller retains ownership. Returns
    /// `false` when the host cannot launch the URL so callers can keep a
    /// manual fallback available.
    pub fn open(
        self: UrlOpener,
        alloc: std.mem.Allocator,
        url: []const u8,
    ) UrlOpenError!bool {
        return self.open_fn(self.context, alloc, url);
    }
};

pub const unavailable_url_opener: UrlOpener = .{
    .open_fn = unavailableUrlOpen,
};

fn unavailableUrlOpen(
    _: ?*anyopaque,
    _: std.mem.Allocator,
    _: []const u8,
) UrlOpenError!bool {
    return false;
}

pub const TerminalTitle = struct {
    context: ?*anyopaque = null,
    set_fn: *const fn (?*anyopaque, []const u8) void,
    clear_fn: *const fn (?*anyopaque) void,

    /// Borrows `label` for this call. Callers resolve what the label says; the
    /// provider only renders it. Terminal write failures are intentionally
    /// non-fatal because the title is presentation metadata.
    pub fn set(self: TerminalTitle, label: []const u8) void {
        self.set_fn(self.context, label);
    }

    pub fn clear(self: TerminalTitle) void {
        self.clear_fn(self.context);
    }
};

pub const unavailable_terminal_title: TerminalTitle = .{
    .set_fn = ignoreTerminalTitleSet,
    .clear_fn = ignoreTerminalTitleClear,
};

fn ignoreTerminalTitleSet(_: ?*anyopaque, _: []const u8) void {}

fn ignoreTerminalTitleClear(_: ?*anyopaque) void {}

pub const SecretStorePresence = enum {
    present,
    missing,
    unavailable,
};

pub const ClipboardError = error{CopyFailed};

pub const unavailable_clipboard = Clipboard{
    .copy_fn = copyUnavailable,
};

fn copyUnavailable(_: ?*anyopaque, _: []const u8) ClipboardError!bool {
    return false;
}

fn copy_file_unavailable(_: ?*anyopaque, _: std.mem.Allocator, _: []const u8) ClipboardError!bool {
    return false;
}

pub const Clipboard = struct {
    context: ?*anyopaque = null,
    copy_fn: *const fn (
        ?*anyopaque,
        []const u8,
    ) ClipboardError!bool,
    copy_file_fn: *const fn (
        ?*anyopaque,
        std.mem.Allocator,
        []const u8,
    ) ClipboardError!bool = copy_file_unavailable,

    /// Borrows `text` for this call. The caller retains ownership. Returns
    /// `false` when the host has no clipboard implementation.
    pub fn copy(
        self: Clipboard,
        text: []const u8,
    ) ClipboardError!bool {
        return self.copy_fn(self.context, text);
    }

    /// Borrows `path` for this call. The caller retains ownership. Returns
    /// `false` when the host cannot publish file references to its clipboard.
    pub fn copy_file(
        self: Clipboard,
        alloc: std.mem.Allocator,
        path: []const u8,
    ) ClipboardError!bool {
        return self.copy_file_fn(self.context, alloc, path);
    }
};

pub fn current() Capabilities {
    return capabilitiesForTarget(builtin.os.tag);
}

fn capabilitiesForTarget(os_tag: std.Target.Os.Tag) Capabilities {
    return nativeForOs(os_tag);
}

pub fn terminalSupportForOs(os_tag: std.Target.Os.Tag) TerminalSupport {
    return if (os_tag == .macos or os_tag == .linux)
        .supported
    else
        .unsupported;
}

pub fn nativeForOs(os_tag: std.Target.Os.Tag) Capabilities {
    return .{
        .process_control = os_tag != .windows and os_tag != .wasi,
        .url_open = os_tag == .macos or os_tag == .linux,
        .native_url_open = os_tag == .macos,
        .terminal = terminalSupportForOs(os_tag),
    };
}

/// Returns an owned description of the current operating system. The caller
/// owns the returned slice and must free it with `alloc`.
pub fn operatingSystemText(alloc: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    const uts = std.posix.uname();
    const sysname = std.mem.sliceTo(&uts.sysname, 0);
    const release = std.mem.sliceTo(&uts.release, 0);
    if (release.len == 0) return alloc.dupe(u8, sysname);
    return std.fmt.allocPrint(alloc, "{s} {s}", .{ sysname, release });
}

test "terminal title forwards borrowed label bytes and clear" {
    const Capture = struct {
        label: [64]u8 = undefined,
        label_len: usize = 0,
        clear_count: usize = 0,

        fn set(raw: ?*anyopaque, label: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(raw.?));
            self.label_len = @min(label.len, self.label.len);
            @memcpy(self.label[0..self.label_len], label[0..self.label_len]);
        }

        fn clear(raw: ?*anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(raw.?));
            self.clear_count += 1;
        }

        fn label_text(self: *const @This()) []const u8 {
            return self.label[0..self.label_len];
        }
    };

    var capture = Capture{};
    const terminal_title = TerminalTitle{
        .context = &capture,
        .set_fn = Capture.set,
        .clear_fn = Capture.clear,
    };

    terminal_title.set("session name");
    terminal_title.clear();

    try std.testing.expectEqualStrings("session name", capture.label_text());
    try std.testing.expectEqual(@as(usize, 1), capture.clear_count);
}

test "unavailable terminal title accepts set and clear" {
    unavailable_terminal_title.set("provider/model");
    unavailable_terminal_title.clear();
}

test "native host capabilities expose process and URL support" {
    const macos = nativeForOs(.macos);
    try std.testing.expect(macos.process_control);
    try std.testing.expect(macos.url_open);
    try std.testing.expect(macos.native_url_open);
    try std.testing.expectEqual(TerminalSupport.supported, macos.terminal);

    const linux = nativeForOs(.linux);
    try std.testing.expect(linux.process_control);
    try std.testing.expect(linux.url_open);
    try std.testing.expect(!linux.native_url_open);
    try std.testing.expectEqual(TerminalSupport.supported, linux.terminal);

    const windows = nativeForOs(.windows);
    try std.testing.expect(!windows.process_control);
    try std.testing.expect(!windows.url_open);
    try std.testing.expect(!windows.native_url_open);
    try std.testing.expectEqual(TerminalSupport.unsupported, windows.terminal);

    try std.testing.expectEqual(
        TerminalSupport.unsupported,
        terminalSupportForOs(.freebsd),
    );
}

test "unavailable URL opener keeps the manual fallback available" {
    try std.testing.expect(!try unavailable_url_opener.open(
        std.testing.allocator,
        "https://example.test",
    ));
}

test "unavailable clipboard rejects text and file references" {
    try std.testing.expect(!try unavailable_clipboard.copy("text"));
    try std.testing.expect(!try unavailable_clipboard.copy_file(std.testing.allocator, "/tmp/report.md"));
}

test "current host describes its operating system" {
    const text = try operatingSystemText(std.testing.allocator);
    defer std.testing.allocator.free(text);

    try std.testing.expect(text.len > 0);
}
