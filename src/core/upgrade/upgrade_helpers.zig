const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const update_target = @import("update_target.zig");

const Allocator = std.mem.Allocator;

const recv_timeout_sec: i64 = 30;
const latest_version_max_bytes: usize = 128;
const checksum_max_bytes: usize = 4096;
const latest_tag_max_bytes: usize = 128;

/// Download base for published releases. Asset URLs are
/// `{base}/{tag}/fiber-{platform}.tar.gz` plus the matching `.sha256`
/// sidecar, which is exactly the shape of
/// `https://github.com/aakshintala/Fiber/releases/download/<tag>/...`.
pub const github_download_base = "https://github.com/aakshintala/Fiber/releases/download";

/// Resolves to `.../releases/latest`, which redirects to the newest published
/// release (`.../releases/tag/<tag>`).
const github_latest_url = "https://github.com/aakshintala/Fiber/releases/latest";

const Target = update_target.Target;

fn setRecvTimeout(conn: *std.http.Client.Connection) void {
    const sock = conn.stream_writer.stream.socket.handle;
    const timeout = std.posix.timeval{ .sec = recv_timeout_sec, .usec = 0 };
    std.posix.setsockopt(sock, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout)) catch {};
}

/// Returns the base URL to fetch releases from, or null when this build has no
/// release source at all.
///
/// The loopback address the deterministic E2E tests serve wins when set;
/// otherwise upgrades resolve from GitHub Releases for aakshintala/Fiber.
pub fn resolveReleaseBase() ?[]const u8 {
    if (io_mod.getenv("FIBER_E2E_UPGRADE_BASE_URL")) |url| {
        if (isLoopbackE2eUpgradeBase(url)) return url;
    }
    return github_download_base;
}

fn isLoopbackE2eUpgradeBase(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "http") or
        uri.user != null or
        uri.password != null or
        uri.port == null or
        !uri.path.isEmpty() or
        uri.query != null or
        uri.fragment != null)
    {
        return false;
    }

    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.mem.eql(u8, host, "127.0.0.1");
}

pub const platform = platformFromTarget() orelse
    @compileError("unsupported platform for auto-upgrade (requires macOS or Linux, x86_64 or aarch64)");

fn platformFromTarget() ?[]const u8 {
    const os: ?[]const u8 = switch (builtin.os.tag) {
        .macos => "macos",
        .linux => "linux",
        else => null,
    };
    const arch: ?[]const u8 = switch (builtin.cpu.arch) {
        .x86_64 => "x86_64",
        .aarch64 => "aarch64",
        else => null,
    };
    if (os) |o| {
        if (arch) |a| {
            return o ++ "-" ++ a;
        }
    }
    return null;
}

pub fn fetchTarget(alloc: Allocator, base_url: []const u8) !?Target {
    if (isLoopbackE2eUpgradeBase(base_url)) {
        const latest = try fetchLatestVersion(alloc, base_url);
        defer alloc.free(latest);
        return Target.initStable(alloc, latest) catch return error.FetchFailed;
    }
    const tag = fetchGithubLatestTag(alloc) catch |err| switch (err) {
        error.NoRelease => return null,
        else => return err,
    };
    defer alloc.free(tag);
    // A tag that is not stable SemVer means no release, not a failure.
    return Target.initStable(alloc, tag) catch null;
}

fn fetchLatestVersion(alloc: Allocator, base_url: []const u8) ![]u8 {
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    const url = try std.fmt.allocPrint(alloc, "{s}/latest.txt", .{base_url});
    defer alloc.free(url);

    const raw = try fetchTextBounded(
        &client,
        alloc,
        url,
        latest_version_max_bytes,
    );
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == raw.len) return raw;

    const duped = try alloc.dupe(u8, trimmed);
    alloc.free(raw);
    return duped;
}

/// Resolves the newest published tag from `/releases/latest` via its redirect
/// target (`.../releases/tag/<tag>`). The redirect response itself is bounded
/// by the head buffer; only the tag segment is copied out.
/// Returns `error.NoRelease` when no release is published yet or the redirect
/// carries no usable tag; transport problems are `error.FetchFailed`.
fn fetchGithubLatestTag(alloc: Allocator) ![]u8 {
    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();

    const uri = std.Uri.parse(github_latest_url) catch return error.FetchFailed;
    var req = client.request(.GET, uri, .{ .redirect_behavior = .unhandled }) catch return error.FetchFailed;
    defer req.deinit();

    if (req.connection) |conn| setRecvTimeout(conn);
    req.sendBodiless() catch return error.FetchFailed;

    var redirect_buf: [8192]u8 = undefined;
    var response = req.receiveHead(&redirect_buf) catch return error.FetchFailed;

    if (response.head.status == .not_found) return error.NoRelease;
    if (response.head.status.class() != .redirect) return error.FetchFailed;

    const location = response.head.location orelse return error.NoRelease;
    const tag = lastPathSegment(location);
    if (tag.len == 0 or tag.len > latest_tag_max_bytes) return error.NoRelease;
    return alloc.dupe(u8, tag) catch return error.OutOfMemory;
}

fn lastPathSegment(location: []const u8) []const u8 {
    var target = location;
    if (std.mem.findScalar(u8, target, '?')) |idx| target = target[0..idx];
    if (std.mem.findScalar(u8, target, '#')) |idx| target = target[0..idx];
    if (std.mem.findScalarLast(u8, target, '/')) |idx| return target[idx + 1 ..];
    return target;
}

/// Creates a uniquely named staging directory beside the destination binary
/// and returns its owned path. Staging beside the destination keeps the final
/// replace a same-filesystem rename, and creating it up front fails fast when
/// the destination directory is not writable, before anything is downloaded.
/// The caller removes the directory when done.
pub fn createSiblingStagingDir(alloc: Allocator, dest_path: []const u8) ![]u8 {
    const parent = std.fs.path.dirname(dest_path) orelse ".";
    var rand_buf: [8]u8 = undefined;
    io_mod.getIo().random(&rand_buf);
    const rand_hex = std.fmt.bytesToHex(rand_buf, .lower);
    const staging = try std.fmt.allocPrint(alloc, "{s}/fiber-upgrade-{s}", .{ parent, rand_hex });
    errdefer alloc.free(staging);
    std.Io.Dir.createDirAbsolute(io_mod.getIo(), staging, .default_dir) catch return error.StagingFailed;
    return staging;
}

fn fetchTextBounded(
    client: *std.http.Client,
    alloc: Allocator,
    url: []const u8,
    max_bytes: usize,
) ![]u8 {
    const uri = std.Uri.parse(url) catch return error.FetchFailed;

    var req = client.request(.GET, uri, .{}) catch return error.FetchFailed;
    defer req.deinit();

    if (req.connection) |conn| setRecvTimeout(conn);
    req.sendBodiless() catch return error.FetchFailed;

    var redirect_buf: [8192]u8 = undefined;
    var response = req.receiveHead(&redirect_buf) catch return error.FetchFailed;
    if (response.head.status != .ok) return error.FetchFailed;
    if (response.head.content_length) |content_length| {
        if (content_length > max_bytes) return error.FetchFailed;
    }

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    var transfer_buf: [4096]u8 = undefined;
    const body_reader = response.reader(&transfer_buf);
    var chunk: [1024]u8 = undefined;
    while (true) {
        const n = body_reader.readSliceShort(&chunk) catch return error.FetchFailed;
        if (n == 0) break;
        if (n > max_bytes -| out.writer.buffered().len) return error.FetchFailed;
        out.writer.writeAll(chunk[0..n]) catch return error.FetchFailed;
    }
    return out.toOwnedSlice() catch return error.OutOfMemory;
}

pub const DownloadProgress = struct {
    ctx: *anyopaque,
    start: *const fn (*anyopaque, ?u64) void,
    update: *const fn (*anyopaque, u64, ?u64) void,
};

pub fn downloadFileStreamingWithProgress(client: *std.http.Client, url: []const u8, dest_path: []const u8, progress: ?DownloadProgress) !void {
    var file = std.Io.Dir.createFileAbsolute(io_mod.getIo(), dest_path, .{}) catch return error.DownloadFailed;
    defer file.close(io_mod.getIo());

    var write_buf: [64 * 1024]u8 = undefined;
    var file_writer: std.Io.File.Writer = .initStreaming(file, io_mod.getIo(), &write_buf);

    const uri = std.Uri.parse(url) catch return error.DownloadFailed;
    var req = client.request(.GET, uri, .{}) catch return error.DownloadFailed;
    defer req.deinit();

    if (req.connection) |conn| setRecvTimeout(conn);
    req.sendBodiless() catch return error.DownloadFailed;

    var redirect_buf: [8192]u8 = undefined;
    var response = req.receiveHead(&redirect_buf) catch return error.DownloadFailed;
    if (response.head.status != .ok) return error.DownloadFailed;

    const total = response.head.content_length;
    if (progress) |p| p.start(p.ctx, total);

    var transfer_buf: [4096]u8 = undefined;
    const body_reader = response.reader(&transfer_buf);
    var copy_buf: [64 * 1024]u8 = undefined;
    var downloaded: u64 = 0;
    while (true) {
        const n = body_reader.readSliceShort(&copy_buf) catch return error.DownloadFailed;
        if (n == 0) break;
        file_writer.interface.writeAll(copy_buf[0..n]) catch return error.DownloadFailed;
        downloaded += n;
        if (progress) |p| p.update(p.ctx, downloaded, total);
    }

    file_writer.interface.flush() catch return error.DownloadFailed;
}

pub fn verifyChecksum(client: *std.http.Client, file_path: []const u8, checksum_url: []const u8) !void {
    const raw = fetchTextBounded(
        client,
        client.allocator,
        checksum_url,
        checksum_max_bytes,
    ) catch return error.ChecksumFetchFailed;
    defer client.allocator.free(raw);

    const expected_hex = extractChecksumHex(raw) orelse return error.ChecksumMismatch;
    if (expected_hex.len != 64) return error.ChecksumMismatch;

    var file = std.Io.Dir.openFileAbsolute(io_mod.getIo(), file_path, .{}) catch return error.ChecksumMismatch;
    defer file.close(io_mod.getIo());

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var rbuf: [8192]u8 = undefined;
    var r = file.readerStreaming(io_mod.getIo(), &rbuf);
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const n = r.interface.readSliceShort(&buf) catch return error.ChecksumMismatch;
        if (n == 0) break;
        hasher.update(buf[0..n]);
    }
    const digest = hasher.finalResult();
    const actual_hex = bytesToHex(&digest);

    if (!std.mem.eql(u8, &actual_hex, expected_hex)) return error.ChecksumMismatch;
}

fn bytesToHex(bytes: *const [32]u8) [64]u8 {
    const charset = "0123456789abcdef";
    var out: [64]u8 = undefined;
    for (bytes, 0..) |b, i| {
        out[i * 2] = charset[b >> 4];
        out[i * 2 + 1] = charset[b & 0x0f];
    }
    return out;
}

fn extractChecksumHex(raw: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (std.mem.findScalar(u8, trimmed, ' ')) |space_idx| {
        return trimmed[0..space_idx];
    }
    return if (trimmed.len >= 64) trimmed[0..64] else null;
}

pub fn extractTarGz(alloc: Allocator, archive_path: []const u8, dest_dir: []const u8) !void {
    const result = std.process.run(alloc, io_mod.getIo(), .{
        .argv = &.{ "tar", "-xzf", archive_path, "-C", dest_dir },
    }) catch return error.ExtractionFailed;
    defer alloc.free(result.stdout);
    defer alloc.free(result.stderr);

    switch (result.term) {
        .exited => |code| if (code != 0) return error.ExtractionFailed,
        else => return error.ExtractionFailed,
    }
}

/// Atomically replaces the target with the staged binary via a
/// same-filesystem rename. The staging directory always sits beside the
/// target, so there is no cross-filesystem fallback and no half-replaced
/// binary: the rename either happens or it does not.
pub fn replaceBinary(new_path: []const u8, target_path: []const u8) !void {
    std.Io.Dir.renameAbsolute(new_path, target_path, io_mod.getIo()) catch return error.ReplaceFailed;
}

pub const ExecutablePathError = error{
    SelfExeNotFound,
    PathTooLong,
};

pub fn currentExecutablePath(out: []u8) ExecutablePathError![]const u8 {
    const n = std.process.executablePath(io_mod.getIo(), out) catch |err| switch (err) {
        error.NameTooLong => return error.PathTooLong,
        else => return error.SelfExeNotFound,
    };
    const path = out[0..n];
    const linux_deleted_suffix = " (deleted)";
    if (builtin.os.tag == .linux and std.mem.endsWith(u8, path, linux_deleted_suffix)) {
        return path[0 .. path.len - linux_deleted_suffix.len];
    }
    return path;
}

fn writeTempFile(dir: std.Io.Dir, name: []const u8, content: []const u8) !void {
    var file = try dir.createFile(io_mod.getIo(), name, .{ .truncate = true });
    defer file.close(io_mod.getIo());
    try file.writeStreamingAll(io_mod.getIo(), content);
}

fn readAbsoluteFile(alloc: Allocator, path: []const u8) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), path, .{});
    defer file.close(io_mod.getIo());
    return io_mod.readFileToEnd(alloc, &file, 1024 * 1024);
}

test "platform string is valid" {
    try std.testing.expect(platform.len > 0);
    try std.testing.expect(std.mem.find(u8, platform, "-") != null);
}

test "E2E upgrade base accepts only explicit IPv4 loopback origins" {
    try std.testing.expect(isLoopbackE2eUpgradeBase("http://127.0.0.1:1234"));
    try std.testing.expect(!isLoopbackE2eUpgradeBase("https://127.0.0.1:1234"));
    try std.testing.expect(!isLoopbackE2eUpgradeBase("http://127.0.0.1"));
    try std.testing.expect(!isLoopbackE2eUpgradeBase("http://127.0.0.1:80@example.com"));
    try std.testing.expect(!isLoopbackE2eUpgradeBase("http://localhost:1234"));
}

test "production upgrade base is GitHub Releases without E2E override" {
    try std.testing.expectEqualStrings(github_download_base, resolveReleaseBase().?);
}

test "lastPathSegment takes the tag from a release redirect target" {
    try std.testing.expectEqualStrings("v0.2.11", lastPathSegment("https://github.com/aakshintala/Fiber/releases/tag/v0.2.11"));
    try std.testing.expectEqualStrings("v0.2.11", lastPathSegment("/aakshintala/Fiber/releases/tag/v0.2.11"));
    try std.testing.expectEqualStrings("v0.2.11", lastPathSegment("https://github.com/aakshintala/Fiber/releases/tag/v0.2.11?foo=bar"));
    try std.testing.expectEqualStrings("", lastPathSegment("https://github.com/aakshintala/Fiber/releases/tag/"));
    try std.testing.expectEqualStrings("v0.2.11", lastPathSegment("v0.2.11"));
}

test "createSiblingStagingDir stages beside the destination" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const dest = try std.fs.path.join(alloc, &.{ root, "fiber" });
    defer alloc.free(dest);

    const staging = try createSiblingStagingDir(alloc, dest);
    defer alloc.free(staging);
    defer std.Io.Dir.cwd().deleteTree(io_mod.getIo(), staging) catch {};

    try std.testing.expectEqualStrings(root, std.fs.path.dirname(staging).?);
    // The directory exists: creating it again must fail.
    if (std.Io.Dir.createDirAbsolute(io_mod.getIo(), staging, .default_dir)) |_| {
        return error.TestExpectedDirExists;
    } else |_| {}
}

test "extractChecksumHex parses sha256sum format" {
    const with_filename = "abc123def456  fiber-macos-aarch64.tar.gz\n";
    const hex = extractChecksumHex(with_filename).?;
    try std.testing.expectEqualStrings("abc123def456", hex);
}

test "extractChecksumHex parses raw hex" {
    const raw = "a" ** 64 ++ "\n";
    const hex = extractChecksumHex(raw).?;
    try std.testing.expectEqual(@as(usize, 64), hex.len);
    try std.testing.expectEqualStrings("a" ** 64, hex);
}

test "extractChecksumHex rejects short raw checksum" {
    try std.testing.expect(extractChecksumHex("abcd\n") == null);
}

test "bytesToHex renders lowercase sha256 digest" {
    const bytes = [_]u8{0x0f} ** 32;
    const hex = bytesToHex(&bytes);
    try std.testing.expectEqualStrings("0f" ** 32, &hex);
}

test "replaceBinary moves replacement over target path" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    try writeTempFile(tmp.dir, "fiber-old", "old");
    try writeTempFile(tmp.dir, "fiber-new", "new");
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const new_path = try std.fs.path.join(alloc, &.{ root, "fiber-new" });
    defer alloc.free(new_path);
    const target_path = try std.fs.path.join(alloc, &.{ root, "fiber-old" });
    defer alloc.free(target_path);

    try replaceBinary(new_path, target_path);

    const replaced = try readAbsoluteFile(alloc, target_path);
    defer alloc.free(replaced);
    try std.testing.expectEqualStrings("new", replaced);
}
