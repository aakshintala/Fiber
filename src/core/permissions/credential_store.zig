const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const profile_paths = @import("../shared/profile_paths.zig");

/// Built-in deny on tool reads of the credential store (issue #97).
///
/// Fiber loads OAuth tokens from `~/.fiber/chatgpt-auth.json` at runtime, and
/// has no OS sandbox, so without this deny an agent file read or shell
/// command could retrieve those secrets, gated only by user-configured
/// policy. This module is policy, not storage: it names the path and
/// canonicalizes tool targets before matching, and `permissions.zig`
/// consults it ahead of configured rules, so no configured or session grant
/// can allow these reads. Fiber's own credential loading
/// (`auth/chatgpt_session.zig`) is untouched; only tool targets are checked.
/// Yolo mode still bypasses permission policy, as documented for every rule.
///
/// Reads only: write/edit targets never reach this module, so a stray write
/// cannot be mistaken for credential exfiltration and vice versa. Only
/// `chatgpt-auth.json` and its parent directory are denied; sibling files
/// (`settings.json`, `credentials.json`, lock/backup files) stay allowed.
///
/// Fail-closed rules: a missing HOME, an unresolvable `$VAR`, or a failed
/// `realpath` never narrows a deny. Lexical identity may only widen one: a
/// target is denied when EITHER its lexical spelling OR its resolved
/// filesystem identity names the store. Ambiguous inputs (store-shaped but
/// not provably the store) hold for the owner instead of allowing.
///
/// TOCTOU residual: checks resolve at admission time, so a concurrent
/// swap of a path component between this check and the tool's open is not
/// covered. The parent-directory deny closes the non-concurrent variant (an
/// attacker cannot plant a sibling and read it back without naming the
/// denied parent), and a concurrent swap additionally needs a writer that
/// already bypasses this policy. Close the remainder with OS-level
/// sandboxing, not more string matching.
pub const Verdict = enum {
    allow,
    hold,
    deny,
};

const store_file_name = profile_paths.chatgpt_auth_file_name;

fn eql_ignore_case(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        if (std.ascii.toLower(x) != std.ascii.toLower(y)) return false;
    }
    return true;
}

fn contains_ignore_case(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (needle.len > haystack.len) return false;
    for (0..haystack.len - needle.len + 1) |start| {
        if (eql_ignore_case(haystack[start..][0..needle.len], needle)) return true;
    }
    return false;
}

fn strip_trailing_slashes(path: []const u8) []const u8 {
    var end = path.len;
    while (end > 1 and path[end - 1] == '/') end -= 1;
    return path[0..end];
}

/// Pure match of an already-absolute path against the store file and its
/// parent directory. Case-insensitive because the profile root typically
/// lives on a case-insensitive volume. No allocation, no I/O.
fn is_store_path(path: []const u8, home: []const u8) bool {
    const target = strip_trailing_slashes(path);
    const root = strip_trailing_slashes(home);
    if (root.len == 0 or target.len <= root.len) return false;
    if (!eql_ignore_case(target[0..root.len], root)) return false;
    const rest = target[root.len..];
    if (rest[0] != '/') return false;
    if (eql_ignore_case(rest, "/.fiber")) return true;
    if (rest.len != "/.fiber/".len + store_file_name.len) return false;
    if (!eql_ignore_case(rest[0.."/.fiber/".len], "/.fiber/")) return false;
    return eql_ignore_case(rest["/.fiber/".len..], store_file_name);
}

fn has_glob_meta(token: []const u8) bool {
    for (token) |byte| {
        if (byte == '*' or byte == '?' or byte == '[') return true;
    }
    return false;
}

fn glob_class_match(class: []const u8, byte: u8) bool {
    // class excludes the brackets; a leading ]/!/^ is literal/negation.
    var negated = false;
    var members = class;
    if (members.len > 0 and (members[0] == '!' or members[0] == '^')) {
        negated = true;
        members = members[1..];
    }
    var matched = false;
    var index: usize = 0;
    // A ] in first position is a literal, matching shell behavior.
    while (index < members.len) {
        if (index + 2 < members.len and members[index + 1] == '-' and members[index + 2] != ']') {
            const low = std.ascii.toLower(members[index]);
            const high = std.ascii.toLower(members[index + 2]);
            const want = std.ascii.toLower(byte);
            if (low <= want and want <= high) matched = true;
            index += 3;
        } else {
            if (std.ascii.toLower(members[index]) == std.ascii.toLower(byte)) matched = true;
            index += 1;
        }
    }
    return if (negated) !matched else matched;
}

/// Tiny case-insensitive glob matcher for `*`, `?`, and `[...]`.
/// `*` deliberately also crosses `/`: this widens denies (a pattern that can
/// textually reach the store is denied) and can never narrow one.
fn glob_match(pattern: []const u8, text: []const u8) bool {
    var px: usize = 0;
    var tx: usize = 0;
    var star: ?usize = null;
    var mark: usize = 0;
    while (tx < text.len) {
        if (px < pattern.len and pattern[px] == '[') {
            var end = px + 1;
            if (end < pattern.len and (pattern[end] == ']' or pattern[end] == '!' or pattern[end] == '^')) end += 1;
            while (end < pattern.len and pattern[end] != ']') : (end += 1) {}
            if (end >= pattern.len) {
                // Unterminated class: fall through to literal handling below.
            } else if (glob_class_match(pattern[px + 1 .. end], text[tx])) {
                px = end + 1;
                tx += 1;
                continue;
            } else if (star) |s| {
                px = s + 1;
                mark += 1;
                tx = mark;
                continue;
            } else return false;
        }
        if (px < pattern.len and (pattern[px] == '?' or std.ascii.toLower(pattern[px]) == std.ascii.toLower(text[tx]))) {
            px += 1;
            tx += 1;
        } else if (px < pattern.len and pattern[px] == '*') {
            star = px;
            px += 1;
            mark = tx;
        } else if (star) |s| {
            px = s + 1;
            mark += 1;
            tx = mark;
        } else return false;
    }
    while (px < pattern.len and pattern[px] == '*') : (px += 1) {}
    return px == pattern.len;
}

/// Strips shell quote/concat artifacts so `jso''n`, `"chatgpt-auth.json"`,
/// and escaped spellings match the same as their literal form.
fn strip_shell_noise(alloc: std.mem.Allocator, token: []const u8) ![]u8 {
    var out = try alloc.alloc(u8, token.len);
    var len: usize = 0;
    for (token) |byte| {
        if (byte == '\'' or byte == '"' or byte == '\\') continue;
        out[len] = byte;
        len += 1;
    }
    return alloc.realloc(out, len) catch out[0..len];
}

/// True when the token carries an environment reference this module cannot
/// resolve statically. `$HOME`/`${HOME}` followed by end-of-token or `/`
/// resolve via `expand_home_prefix`; every other `$` form holds when the
/// token is otherwise store-shaped.
fn has_unresolved_env(token: []const u8) bool {
    var index: usize = 0;
    while (index < token.len) {
        if (token[index] != '$') {
            index += 1;
            continue;
        }
        const rest = token[index..];
        if (std.mem.startsWith(u8, rest, "${HOME}")) {
            const tail = rest["${HOME}".len..];
            if (tail.len == 0 or tail[0] == '/') {
                index += "${HOME}".len;
                continue;
            }
            return true;
        }
        if (std.mem.startsWith(u8, rest, "$HOME")) {
            const tail = rest["$HOME".len..];
            if (tail.len == 0 or tail[0] == '/') {
                index += "$HOME".len;
                continue;
            }
            return true;
        }
        return true;
    }
    return false;
}

/// Cheap shape test for fail-closed paths: the token mentions the profile
/// directory or the credential filename fragments.
fn is_store_shaped(text: []const u8) bool {
    return contains_ignore_case(text, ".fiber") or contains_ignore_case(text, "chatgpt");
}

fn contains_store_file(text: []const u8) bool {
    return contains_ignore_case(text, store_file_name);
}

fn clean_home() ?[]const u8 {
    const home = io_mod.getenv("HOME") orelse return null;
    if (strip_trailing_slashes(home).len == 0) return null;
    return home;
}

fn expand_home_prefix(alloc: std.mem.Allocator, home: []const u8, token: []const u8) ![]u8 {
    if (std.mem.startsWith(u8, token, "${HOME}")) {
        return std.fs.path.join(alloc, &.{ strip_trailing_slashes(home), token["${HOME}".len..] });
    }
    if (std.mem.startsWith(u8, token, "$HOME")) {
        const rest = token["$HOME".len..];
        if (rest.len == 0 or rest[0] == '/') {
            return std.fs.path.join(alloc, &.{ strip_trailing_slashes(home), rest });
        }
        return alloc.dupe(u8, token);
    }
    if (std.mem.eql(u8, token, "~")) return alloc.dupe(u8, home);
    if (std.mem.startsWith(u8, token, "~/")) {
        return std.fs.path.join(alloc, &.{ strip_trailing_slashes(home), token[1..] });
    }
    if (token.len > 1 and token[0] == '~') {
        if (tilde_user_rest(token)) |parts| {
            if (parts.user.len > 0 and is_current_user(parts.user)) {
                return std.fs.path.join(alloc, &.{ strip_trailing_slashes(home), parts.rest });
            }
        }
    }
    return alloc.dupe(u8, token);
}

fn is_current_user(candidate: []const u8) bool {
    if (candidate.len == 0) return false;
    if (io_mod.getenv("USER")) |user| {
        if (std.mem.eql(u8, candidate, user)) return true;
    }
    if (io_mod.getenv("LOGNAME")) |name| {
        if (std.mem.eql(u8, candidate, name)) return true;
    }
    if (comptime builtin.link_libc) {
        var entry: std.c.passwd = undefined;
        var scratch: [4096]u8 = undefined;
        var found: ?*std.c.passwd = null;
        if (std.c.getpwuid_r(std.c.getuid(), &entry, &scratch, scratch.len, &found) == 0) {
            if (found) |record| {
                if (record.name) |ptr| {
                    if (std.mem.eql(u8, candidate, std.mem.span(ptr))) return true;
                }
            }
        }
    }
    return false;
}

/// Splits `~user/rest` into its username and `/rest` tail. Returns null for
/// `~`, `~/...`, and bare `~user` (no slash): bare names are not paths, so
/// they stay out of scope and keep their existing verdict.
fn tilde_user_rest(token: []const u8) ?struct { user: []const u8, rest: []const u8 } {
    if (token.len < 2 or token[0] != '~') return null;
    if (token[1] == '/') return null;
    const slash = std.mem.findScalar(u8, token, '/') orelse return null;
    return .{ .user = token[1..slash], .rest = token[slash..] };
}

/// True when a `~user/...` spelling names someone other than the current
/// user (unresolvable or mismatch) and the remainder is store-shaped. Such
/// inputs never expand, so they must hold instead of joining to the cwd.
fn is_foreign_tilde_store(token: []const u8) bool {
    const parts = tilde_user_rest(token) orelse return false;
    if (parts.user.len == 0) return false;
    if (is_current_user(parts.user)) return false;
    return is_store_shaped(parts.rest);
}

const StoreIdentities = struct {
    arena: std.heap.ArenaAllocator,
    home: []const u8,
    file_lex: []const u8,
    dir_lex: []const u8,
    file_real: ?[]const u8,
    dir_real: ?[]const u8,

    fn deinit(self: *StoreIdentities) void {
        self.arena.deinit();
    }

    fn matches_resolved(self: StoreIdentities, canonical: []const u8) bool {
        const target = strip_trailing_slashes(canonical);
        for ([2]?[]const u8{ self.file_real, self.dir_real }) |maybe_store| {
            const store = maybe_store orelse continue;
            if (eql_ignore_case(target, strip_trailing_slashes(store))) return true;
        }
        return false;
    }
};

/// Lexical store paths plus their `realpath` identities where they exist.
/// A missing identity is not an error: lexical matching still denies exact
/// spellings, and resolution matches widen the deny where available.
fn resolve_store_identities(alloc: std.mem.Allocator, home: []const u8) !StoreIdentities {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    errdefer arena_state.deinit();
    const scratch = arena_state.allocator();
    const trimmed = strip_trailing_slashes(home);
    const dir_lex = try std.fs.path.join(scratch, &.{ trimmed, profile_paths.root_dir_name });
    const file_lex = try std.fs.path.join(scratch, &.{ trimmed, profile_paths.root_dir_name, store_file_name });
    return .{
        .arena = arena_state,
        .home = home,
        .file_lex = file_lex,
        .dir_lex = dir_lex,
        .file_real = io_mod.realpathAlloc(scratch, file_lex) catch null,
        .dir_real = io_mod.realpathAlloc(scratch, dir_lex) catch null,
    };
}

fn realpath_opt(alloc: std.mem.Allocator, path: []const u8) ?[]u8 {
    return io_mod.realpathAlloc(alloc, path) catch null;
}

/// Glob branch shared by command tokens: a pattern that can textually reach
/// the store file or its directory denies, as does a literal parent that
/// resolves to the store directory (enumeration through a glob).
fn check_glob_pattern(alloc: std.mem.Allocator, stores: StoreIdentities, pattern: []const u8) Verdict {
    if (glob_match(pattern, stores.file_lex) or glob_match(pattern, stores.dir_lex)) return .deny;
    if (stores.file_real) |real| {
        if (glob_match(pattern, real)) return .deny;
    }
    if (stores.dir_real) |real| {
        if (glob_match(pattern, real)) return .deny;
    }
    var meta_at: usize = pattern.len;
    for (pattern, 0..) |byte, index| {
        if (byte == '*' or byte == '?' or byte == '[') {
            meta_at = index;
            break;
        }
    }
    const literal = pattern[0..meta_at];
    if (std.mem.lastIndexOfScalar(u8, literal, '/')) |slash| {
        const parent = strip_trailing_slashes(literal[0..slash]);
        if (parent.len > 0) {
            if (is_store_path(parent, stores.home)) return .deny;
            if (realpath_opt(alloc, parent)) |resolved| {
                defer alloc.free(resolved);
                if (is_store_path(resolved, stores.home) or stores.matches_resolved(resolved)) return .deny;
            }
        }
    }
    if (is_store_shaped(pattern) or has_unresolved_env(pattern)) return .hold;
    return .allow;
}

/// Shell brace groups (`{a,b}`, `{json}`, nested) are expansion metadata
/// like globs: the shell opens one path per expansion, so a token whose
/// expansion can name the store must not slip through as a literal.
fn has_brace_meta(token: []const u8) bool {
    const open = std.mem.findScalar(u8, token, '{') orelse return false;
    return std.mem.findScalar(u8, token[open..], '}') != null;
}

/// Locates the first balanced `{...}` group, respecting nesting.
/// Unbalanced input returns null and stays on the literal path.
fn find_brace_group(token: []const u8) ?struct { open: usize, close: usize } {
    const open = std.mem.findScalar(u8, token, '{') orelse return null;
    var depth: usize = 0;
    for (token[open..], 0..) |byte, offset| {
        if (byte == '{') {
            depth += 1;
        } else if (byte == '}') {
            depth -= 1;
            if (depth == 0) return .{ .open = open, .close = open + offset };
        }
    }
    return null;
}

const max_brace_expansions = 32;
const max_brace_depth = 8;

/// Shell-style brace expansion of one group: `a{b,c}d` yields `abd` and
/// `acd`; a group without a top-level comma yields its contents once, so a
/// single `{json}` still reaches `json` (fail-closed where bash would stay
/// literal). Nested groups expand recursively. Returns false over budget or
/// over depth so the caller can hold instead of guessing.
fn append_brace_expansions(alloc: std.mem.Allocator, pattern: []const u8, out: *std.ArrayList([]u8), depth: usize) !bool {
    if (depth > max_brace_depth) return false;
    const group = find_brace_group(pattern) orelse {
        try out.append(alloc, try alloc.dupe(u8, pattern));
        return out.items.len <= max_brace_expansions;
    };
    const prefix = pattern[0..group.open];
    const inner = pattern[group.open + 1 .. group.close];
    const suffix = pattern[group.close + 1 ..];
    var alts: std.ArrayList([]const u8) = .empty;
    defer alts.deinit(alloc);
    var level: usize = 0;
    var start: usize = 0;
    var has_comma = false;
    for (inner, 0..) |byte, index| {
        if (byte == '{') {
            level += 1;
        } else if (byte == '}') {
            if (level > 0) level -= 1;
        } else if (byte == ',' and level == 0) {
            has_comma = true;
            try alts.append(alloc, inner[start..index]);
            start = index + 1;
        }
    }
    if (has_comma) {
        try alts.append(alloc, inner[start..]);
    } else {
        try alts.append(alloc, inner);
    }
    for (alts.items) |alt| {
        const combined = try std.mem.concat(alloc, u8, &.{ prefix, alt, suffix });
        defer alloc.free(combined);
        if (!try append_brace_expansions(alloc, combined, out, depth + 1)) return false;
        if (out.items.len > max_brace_expansions) return false;
    }
    return true;
}

/// Brace-free tail of token checking shared by plain tokens and individual
/// brace expansions: glob match, lexical identity, then resolved identity.
fn check_expanded_token(alloc: std.mem.Allocator, stores: StoreIdentities, absolute: []const u8) !Verdict {
    if (has_glob_meta(absolute)) return check_glob_pattern(alloc, stores, absolute);
    const lexical = try std.fs.path.resolve(alloc, &.{absolute});
    defer alloc.free(lexical);
    if (is_store_path(lexical, stores.home)) return .deny;
    const resolved = realpath_opt(alloc, absolute) orelse return .allow;
    defer alloc.free(resolved);
    if (is_store_path(resolved, stores.home) or stores.matches_resolved(resolved)) return .deny;
    return .allow;
}

/// Brace branch: deny when any expansion can name the store, hold when the
/// braces defeat exact reasoning on a store-shaped token, allow otherwise.
fn check_brace_pattern(alloc: std.mem.Allocator, stores: StoreIdentities, pattern: []const u8) !Verdict {
    var expansions: std.ArrayList([]u8) = .empty;
    defer {
        for (expansions.items) |item| alloc.free(item);
        expansions.deinit(alloc);
    }
    if (try append_brace_expansions(alloc, pattern, &expansions, 0)) {
        var result: Verdict = .allow;
        for (expansions.items) |expanded| {
            if (contains_store_file(expanded)) return .deny;
            switch (try check_expanded_token(alloc, stores, expanded)) {
                .deny => return .deny,
                .hold => result = .hold,
                .allow => {},
            }
        }
        if (result == .hold) return .hold;
        if (is_store_shaped(pattern) or has_unresolved_env(pattern)) return .hold;
        return .allow;
    }
    if (is_store_shaped(pattern) or has_unresolved_env(pattern)) return .hold;
    return .allow;
}

fn join_cwd(alloc: std.mem.Allocator, cwd: []const u8, expanded: []const u8) !?[]u8 {
    if (std.fs.path.isAbsolute(expanded)) return try alloc.dupe(u8, expanded);
    if (cwd.len == 0) return null;
    return try std.fs.path.join(alloc, &.{ cwd, expanded });
}

/// Shared token verdict once HOME is known and the spelling is noise-free.
/// Denies when the lexical (dot-segment normalized), the resolved, or the
/// store identity names the store: lexical matching may only widen the
/// deny, never narrow it. Brace groups expand first (any expansion naming
/// the store denies); a failed `realpath` on a clean spelling allows
/// (the path cannot open), while shapes that defeat lexical reasoning hold.
fn check_clean_token(alloc: std.mem.Allocator, stores: StoreIdentities, absolute: []const u8) !Verdict {
    if (has_unresolved_env(absolute)) {
        if (is_store_shaped(absolute)) return .hold;
        return .allow;
    }
    if (has_brace_meta(absolute)) return check_brace_pattern(alloc, stores, absolute);
    return check_expanded_token(alloc, stores, absolute);
}

const token_separators = " \t\r\n;&|()<>`=";

/// Reports the verdict for one shell word against the command cwd.
/// The store basename is unique to the credential file, so naming it in any
/// spelling denies without needing HOME or a resolvable path.
fn check_command_token(alloc: std.mem.Allocator, home: ?[]const u8, stores: ?StoreIdentities, cwd: []const u8, token: []const u8) !Verdict {
    if (std.mem.findScalar(u8, token, 0) != null) return .deny;
    const stripped = try strip_shell_noise(alloc, token);
    defer alloc.free(stripped);
    const word = std.mem.trim(u8, stripped, " \t\r\n");
    if (word.len == 0) return .allow;
    if (contains_store_file(word)) return .deny;
    if (is_foreign_tilde_store(word)) return .hold;
    const known = home orelse {
        if (is_store_shaped(word) or has_unresolved_env(word)) return .hold;
        return .allow;
    };
    const expanded = try expand_home_prefix(alloc, known, word);
    defer alloc.free(expanded);
    const absolute = try join_cwd(alloc, cwd, expanded) orelse {
        if (is_store_shaped(expanded) or has_unresolved_env(expanded)) return .hold;
        return .allow;
    };
    defer alloc.free(absolute);
    return check_clean_token(alloc, stores.?, absolute);
}

/// Command verdict for `run_command` targets: deny wins, then hold, else
/// allow. Every token is checked, so smuggling the store into one argument
/// of a long command still denies.
pub fn check_command_target(alloc: std.mem.Allocator, target_path: []const u8) !Verdict {
    const home = clean_home();
    var stores: ?StoreIdentities = null;
    defer if (stores) |*owned| owned.deinit();
    if (home) |known| stores = try resolve_store_identities(alloc, known);
    const separator = std.mem.find(u8, target_path, "::");
    const cwd = if (separator) |index| target_path[0..index] else "";
    const command = if (separator) |index| target_path[index + 2 ..] else target_path;
    var result: Verdict = .allow;
    var words = std.mem.tokenizeAny(u8, command, token_separators);
    while (words.next()) |word| {
        switch (try check_command_token(alloc, home, stores, cwd, word)) {
            .deny => return .deny,
            .hold => result = .hold,
            .allow => {},
        }
    }
    return result;
}

/// File verdict for tool paths. Literal matching only: file tools take exact
/// paths, so a file merely shaped like a glob is a different file and
/// allowed. Relative inputs resolve against the workspace root.
pub fn check_file_target(alloc: std.mem.Allocator, workspace_root: []const u8, target_path: []const u8) !Verdict {
    if (std.mem.findScalar(u8, target_path, 0) != null) return .deny;
    const stripped = try strip_shell_noise(alloc, target_path);
    defer alloc.free(stripped);
    const word = std.mem.trim(u8, stripped, " \t\r\n");
    if (word.len == 0) return .allow;
    if (is_foreign_tilde_store(word)) return .hold;
    const home = clean_home() orelse {
        if (contains_store_file(word)) return .deny;
        if (is_store_shaped(word) or has_unresolved_env(word)) return .hold;
        return .allow;
    };
    var stores = try resolve_store_identities(alloc, home);
    defer stores.deinit();
    const expanded = try expand_home_prefix(alloc, home, word);
    defer alloc.free(expanded);
    const absolute = try join_cwd(alloc, workspace_root, expanded) orelse {
        // Unanchorable spelling with no workspace root: the exact filename
        // fails closed, anything store-shaped holds, the rest allows.
        if (contains_store_file(expanded)) return .deny;
        if (is_store_shaped(expanded) or has_unresolved_env(expanded)) return .hold;
        return .allow;
    };
    defer alloc.free(absolute);
    return check_clean_token(alloc, stores, absolute);
}

/// Test-only HOME swap shared by this file's and `permissions.zig`'s
/// credential tests. Keeps one static slot instead of a global allocator, so
/// sequential tests save and restore the outer environment exactly once.
pub const TestHome = struct {
    alloc: std.mem.Allocator,
    map: std.process.Environ.Map,

    pub fn install(alloc: std.mem.Allocator, home: []const u8) !*TestHome {
        const self = try install_inner(alloc);
        errdefer self.deinit();
        try self.map.put("HOME", home);
        return self;
    }

    pub fn install_without_home(alloc: std.mem.Allocator) !*TestHome {
        return install_inner(alloc);
    }

    fn install_inner(alloc: std.mem.Allocator) !*TestHome {
        if (test_home_depth == 0) {
            test_home_outer = io_mod.environMap();
            if (test_home_empty == null) {
                test_home_empty = std.process.Environ.Map.init(alloc);
            }
        }
        test_home_depth += 1;
        const self = try alloc.create(TestHome);
        errdefer alloc.destroy(self);
        self.* = .{
            .alloc = alloc,
            .map = std.process.Environ.Map.init(alloc),
        };
        io_mod.setEnvironMap(&self.map);
        return self;
    }

    pub fn deinit(self: *TestHome) void {
        test_home_depth -= 1;
        if (test_home_depth == 0) {
            if (test_home_outer) |outer| {
                io_mod.setEnvironMap(outer);
            } else {
                io_mod.setEnvironMap(&test_home_empty.?);
            }
        }
        self.map.deinit();
        const alloc = self.alloc;
        alloc.destroy(self);
    }
};

var test_home_outer: ?*const std.process.Environ.Map = null;
var test_home_depth: usize = 0;
var test_home_empty: ?std.process.Environ.Map = null;

test "store match covers the credential file and its parent directory" {
    const home = "/home/fiber";
    for ([_][]const u8{
        "/home/fiber/.fiber/chatgpt-auth.json",
        "/home/fiber/.fiber",
        "/home/fiber/.fiber/",
    }) |denied| {
        try std.testing.expect(is_store_path(denied, home));
    }
    for ([_][]const u8{
        "/home/fiber/.fiber/settings.json",
        "/home/fiber/.fiber/credentials.json",
        "/home/fiber/.fiber/mcp.json",
        "/home/fiber/.fiber/skills/agent/SKILL.md",
        "/home/fiber/.fiber/sessions/abc/session.json",
        "/home/fiber/.fiber/mcp-credentials/credentials.json",
        "/home/fiber/.fiber/chatgpt-auth.json.bak",
        "/home/fiber/.fiber/chatgpt-auth.lock",
        "/home/fiber",
        "/home/fiber/other",
        "/tmp/chatgpt-auth.json",
        "/home/fiber/.fiber2/chatgpt-auth.json",
    }) |allowed| {
        try std.testing.expect(!is_store_path(allowed, home));
    }
}

test "store match ignores case for case-insensitive profile volumes" {
    try std.testing.expect(is_store_path("/home/fiber/.FIBER/CHATGPT-AUTH.JSON", "/home/fiber"));
    try std.testing.expect(is_store_path("/home/fiber/.fiber/ChatGPT-Auth.Json", "/home/fiber"));
    try std.testing.expect(!is_store_path("/home/fiber/.fiber/settings.json", "/home/fiber"));
}

test "store match respects the home boundary" {
    try std.testing.expect(!is_store_path("/home/fiber2/.fiber/chatgpt-auth.json", "/home/fiber"));
    try std.testing.expect(!is_store_path("/home/fiber", "/home/fiber"));
    try std.testing.expect(!is_store_path("", "/home/fiber"));
    try std.testing.expect(is_store_path("/home/fiber/.fiber/chatgpt-auth.json", "/home/fiber/"));
}

test "policy denies the exact path the runtime loader reads" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    // Drift guard: the denied path is built from the same filename constant
    // the runtime loader opens, so renaming the store breaks this test.
    const loader_path = try profile_paths.chatgptAuthPath(alloc, home);
    defer alloc.free(loader_path);
    const expect_lexical = try std.fs.path.join(alloc, &.{ home, ".fiber", "chatgpt-auth.json" });
    defer alloc.free(expect_lexical);
    try std.testing.expectEqualStrings(expect_lexical, loader_path);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, loader_path));
}

test "file target denies every spelling and allows neighbors" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    const store = try std.fs.path.join(alloc, &.{ home, ".fiber", "chatgpt-auth.json" });
    defer alloc.free(store);
    var store_file = try tmp.dir.createFile(io_mod.getIo(), "home/.fiber/chatgpt-auth.json", .{ .truncate = true });
    store_file.close(io_mod.getIo());

    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, store));
    const tilde = try alloc.dupe(u8, "~/.fiber/chatgpt-auth.json");
    defer alloc.free(tilde);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, tilde));
    const dollar_home = try alloc.dupe(u8, "$HOME/.fiber/chatgpt-auth.json");
    defer alloc.free(dollar_home);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, dollar_home));
    const braced_home = try alloc.dupe(u8, "${HOME}/.fiber/chatgpt-auth.json");
    defer alloc.free(braced_home);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, braced_home));
    const dotdot = try std.fmt.allocPrint(alloc, "{s}/.fiber/sub/../chatgpt-auth.json", .{home});
    defer alloc.free(dotdot);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, dotdot));
    const parent = try std.fmt.allocPrint(alloc, "{s}/.fiber", .{home});
    defer alloc.free(parent);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, parent));
    const relative = try alloc.dupe(u8, ".fiber/chatgpt-auth.json");
    defer alloc.free(relative);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, home, relative));

    const neighbor = try std.fmt.allocPrint(alloc, "{s}/.fiber/settings.json", .{home});
    defer alloc.free(neighbor);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, neighbor));
    const sibling_store_name = try std.fmt.allocPrint(alloc, "{s}/.fiber/credentials.json", .{home});
    defer alloc.free(sibling_store_name);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, sibling_store_name));
    const same_name_elsewhere = try alloc.dupe(u8, "/tmp/chatgpt-auth.json");
    defer alloc.free(same_name_elsewhere);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, same_name_elsewhere));
    const unrelated = try std.fmt.allocPrint(alloc, "{s}/notes.txt", .{workspace});
    defer alloc.free(unrelated);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, unrelated));
}

test "file target denies reads through a symlinked path" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    var store_file = try tmp.dir.createFile(io_mod.getIo(), "home/.fiber/chatgpt-auth.json", .{ .truncate = true });
    store_file.close(io_mod.getIo());
    const store = try std.fs.path.join(alloc, &.{ home, ".fiber", "chatgpt-auth.json" });
    defer alloc.free(store);
    try tmp.dir.symLink(io_mod.getIo(), store, "home/alias.json", .{ .is_directory = false });
    const alias = try std.fs.path.join(alloc, &.{ home, "alias.json" });
    defer alloc.free(alias);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, home, alias));

    const fiber_dir = try std.fs.path.join(alloc, &.{ home, ".fiber" });
    defer alloc.free(fiber_dir);
    try tmp.dir.symLink(io_mod.getIo(), fiber_dir, "home/dirlink", .{ .is_directory = true });
    const dirlink = try std.fs.path.join(alloc, &.{ home, "dirlink" });
    defer alloc.free(dirlink);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, home, dirlink));
}

test "file target fails closed without a home" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install_without_home(alloc);
    defer test_home.deinit();

    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, "~/.fiber/chatgpt-auth.json"));
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, "/home/fiber/.fiber/chatgpt-auth.json"));
    try std.testing.expectEqual(Verdict.hold, try check_file_target(alloc, workspace, "~/.fiber"));
    try std.testing.expectEqual(Verdict.hold, try check_file_target(alloc, workspace, "$P/.fiber/settings.json"));
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, "notes.txt"));
}

test "command target denies shell spellings of the store" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    const home_prefix = try std.fmt.allocPrint(alloc, "{s}::", .{home});
    defer alloc.free(home_prefix);
    for ([_][]const u8{
        "cat ~/.fiber/chatgpt-auth.json",
        "cat $HOME/.fiber/chatgpt-auth.json",
        "cat ${HOME}/.fiber/chatgpt-auth.json",
        "cat ~/.fiber/../.fiber/chatgpt-auth.json",
        "ls ~/.fiber",
        "ls $HOME/.fiber/",
        "cat ~/.fiber/*",
        "grep -r token ~/.fiber",
        "cat chatgpt-auth.json",
        "cat ~/.fiber/chatgpt-auth.jso[n]",
        "cat ~/.fiber/chatgpt-auth.????-auth.json",
        "ls ~/.fi?er",
        "ls ~/.fiber/ch*",
        "cat \"~/.fiber/chatgpt-auth.json\"",
        "cat ~/.fiber/chatgpt-auth.jso''n",
        "cat ~/.fiber/chatgpt-auth.{json,bak}",
        "cat ~/.fiber/chatgpt-auth.{json}",
        "cat ~/.fiber/chatgpt-{auth,backup}.json",
        "cat ~/.fiber/{chatgpt-auth,other}.json",
        "cat ~/.fiber/chatgpt-auth.{jso{n,x},bak}",
        "cat $P/.fiber/chatgpt-auth.json",
    }) |denied_command| {
        const target = try std.mem.concat(alloc, u8, &.{ home_prefix, denied_command });
        defer alloc.free(target);
        try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, target));
    }

    const store_dir = try std.fs.path.join(alloc, &.{ home, ".fiber" });
    defer alloc.free(store_dir);
    const relative_prefix = try std.fmt.allocPrint(alloc, "{s}::", .{store_dir});
    defer alloc.free(relative_prefix);
    const relative_target = try std.mem.concat(alloc, u8, &.{ relative_prefix, "cat chatgpt-auth.json" });
    defer alloc.free(relative_target);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, relative_target));
    const relative_glob = try std.mem.concat(alloc, u8, &.{ relative_prefix, "cat chatgpt-auth.jso[n]" });
    defer alloc.free(relative_glob);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, relative_glob));

    const absolute = try std.fmt.allocPrint(alloc, "{s}::cat {s}/.fiber/chatgpt-auth.json", .{ home, home });
    defer alloc.free(absolute);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, absolute));
}

test "command target holds ambiguous spellings instead of allowing" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    const prefix = try std.fmt.allocPrint(alloc, "{s}::", .{workspace});
    defer alloc.free(prefix);
    for ([_][]const u8{
        "cat $P/.fiber/settings.json",
        "cat $P/chatgpt-backup",
        "ls $P/.fiber",
        "cat ~/.fiber/{settings,backup}.json",
    }) |held_command| {
        const target = try std.mem.concat(alloc, u8, &.{ prefix, held_command });
        defer alloc.free(target);
        try std.testing.expectEqual(Verdict.hold, try check_command_target(alloc, target));
    }
    // One ambiguous token holds the whole command even beside benign words.
    const mixed = try std.mem.concat(alloc, u8, &.{ prefix, "echo ok; cat $P/.fiber/settings.json" });
    defer alloc.free(mixed);
    try std.testing.expectEqual(Verdict.hold, try check_command_target(alloc, mixed));
}

test "command target fails closed without a home" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install_without_home(alloc);
    defer test_home.deinit();

    const prefix = try std.fmt.allocPrint(alloc, "{s}::", .{workspace});
    defer alloc.free(prefix);
    const denied = try std.mem.concat(alloc, u8, &.{ prefix, "cat ~/.fiber/chatgpt-auth.json" });
    defer alloc.free(denied);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, denied));
    const held = try std.mem.concat(alloc, u8, &.{ prefix, "ls ~/.fiber" });
    defer alloc.free(held);
    try std.testing.expectEqual(Verdict.hold, try check_command_target(alloc, held));
    const benign = try std.mem.concat(alloc, u8, &.{ prefix, "echo hello" });
    defer alloc.free(benign);
    try std.testing.expectEqual(Verdict.allow, try check_command_target(alloc, benign));
}

test "command target allows commands that do not touch the store" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    const prefix = try std.fmt.allocPrint(alloc, "{s}::", .{workspace});
    defer alloc.free(prefix);
    for ([_][]const u8{
        "echo hello",
        "git status",
        "cat notes.txt",
        "cat credentials.json",
        "ls ~/.fiber/skills",
        "echo $P",
        "cat ${CRED_DIR}/x",
    }) |allowed_command| {
        const target = try std.mem.concat(alloc, u8, &.{ prefix, allowed_command });
        defer alloc.free(target);
        try std.testing.expectEqual(Verdict.allow, try check_command_target(alloc, target));
    }
}

test "command target allows a workspace file that shares a generic store name" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    var local_file = try tmp.dir.createFile(io_mod.getIo(), "workspace/credentials.json", .{ .truncate = true });
    local_file.close(io_mod.getIo());
    const target = try std.fmt.allocPrint(alloc, "{s}::cat credentials.json", .{workspace});
    defer alloc.free(target);
    try std.testing.expectEqual(Verdict.allow, try check_command_target(alloc, target));
}

test "tilde user expansion denies current user and holds foreign store shapes" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.fiber");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    const test_home = try TestHome.install(alloc, home);
    defer test_home.deinit();

    var pw_scratch: [4096]u8 = undefined;
    var pw_entry: std.c.passwd = undefined;
    var pw_found: ?*std.c.passwd = null;
    var current: ?[]const u8 = io_mod.getenv("USER") orelse io_mod.getenv("LOGNAME");
    if (current == null and builtin.link_libc) {
        if (std.c.getpwuid_r(std.c.getuid(), &pw_entry, &pw_scratch, pw_scratch.len, &pw_found) == 0) {
            if (pw_found) |record| {
                if (record.name) |ptr| current = std.mem.span(ptr);
            }
        }
    }
    const me = current orelse return error.SkipZigTest;

    const foreign = "no_such_user_xyz123";
    try std.testing.expect(!is_current_user(foreign));

    const prefix = try std.fmt.allocPrint(alloc, "{s}::", .{workspace});
    defer alloc.free(prefix);

    const me_store = try std.fmt.allocPrint(alloc, "~{s}/.fiber/chatgpt-auth.json", .{me});
    defer alloc.free(me_store);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, me_store));
    const me_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "cat ", me_store });
    defer alloc.free(me_cmd);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, me_cmd));

    const me_parent = try std.fmt.allocPrint(alloc, "~{s}/.fiber", .{me});
    defer alloc.free(me_parent);
    try std.testing.expectEqual(Verdict.deny, try check_file_target(alloc, workspace, me_parent));
    const me_parent_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "ls ", me_parent });
    defer alloc.free(me_parent_cmd);
    try std.testing.expectEqual(Verdict.deny, try check_command_target(alloc, me_parent_cmd));

    const foreign_parent = try std.fmt.allocPrint(alloc, "~{s}/.fiber", .{foreign});
    defer alloc.free(foreign_parent);
    try std.testing.expectEqual(Verdict.hold, try check_file_target(alloc, workspace, foreign_parent));
    const foreign_parent_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "ls ", foreign_parent });
    defer alloc.free(foreign_parent_cmd);
    try std.testing.expectEqual(Verdict.hold, try check_command_target(alloc, foreign_parent_cmd));

    const foreign_settings = try std.fmt.allocPrint(alloc, "~{s}/.fiber/settings.json", .{foreign});
    defer alloc.free(foreign_settings);
    try std.testing.expectEqual(Verdict.hold, try check_file_target(alloc, workspace, foreign_settings));
    const foreign_settings_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "cat ", foreign_settings });
    defer alloc.free(foreign_settings_cmd);
    try std.testing.expectEqual(Verdict.hold, try check_command_target(alloc, foreign_settings_cmd));

    const foreign_other = try std.fmt.allocPrint(alloc, "~{s}/docs/notes.txt", .{foreign});
    defer alloc.free(foreign_other);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, foreign_other));
    const foreign_other_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "cat ", foreign_other });
    defer alloc.free(foreign_other_cmd);
    try std.testing.expectEqual(Verdict.allow, try check_command_target(alloc, foreign_other_cmd));

    const bare = try std.fmt.allocPrint(alloc, "~{s}", .{foreign});
    defer alloc.free(bare);
    try std.testing.expectEqual(Verdict.allow, try check_file_target(alloc, workspace, bare));
    const bare_cmd = try std.mem.concat(alloc, u8, &.{ prefix, "echo ", bare });
    defer alloc.free(bare_cmd);
    try std.testing.expectEqual(Verdict.allow, try check_command_target(alloc, bare_cmd));
}
