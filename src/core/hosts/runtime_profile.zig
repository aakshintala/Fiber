const std = @import("std");

pub const Profile = struct {
    durable_sessions: bool,
    profile_usage: bool,
    native_auth: bool,
    file_index: bool,
    mcp: bool,
    subagents: bool,
    auto_upgrade: bool,
    skills: bool,
    clipboard: bool,
    url_opening: bool,
    web_search: bool,
    generation_usage: bool,
    tools: bool,
};

pub const Capability = std.meta.FieldEnum(Profile);

pub fn allows(comptime App: type, comptime capability: Capability) bool {
    if (!@hasDecl(App, "host_profile")) return @field(native, @tagName(capability));
    return @field(App.host_profile, @tagName(capability));
}

pub const native = Profile{
    .durable_sessions = true,
    .profile_usage = true,
    .native_auth = true,
    .file_index = true,
    .mcp = true,
    .subagents = true,
    .auto_upgrade = true,
    .skills = true,
    .clipboard = true,
    .url_opening = true,
    .web_search = true,
    .generation_usage = true,
    .tools = true,
};

test "apps without a host profile retain native capabilities" {
    const App = struct {};
    try std.testing.expect(allows(App, .durable_sessions));
    try std.testing.expect(allows(App, .tools));
}
