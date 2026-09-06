const std = @import("std");

const oauth_transport = @import("../core/auth/oauth_transport.zig");
const secret = @import("../core/auth/secret.zig");
const gateway_client = @import("../gateway/client.zig");
const io_mod = @import("../core/shared/io.zig");

const Allocator = std.mem.Allocator;
const oauth_request_timeout_ms: i64 = 15_000;
const oauth_response_max_bytes: usize = 64 * 1024;

pub const oauth_transport_provider = oauth_transport.Provider{
    .execute_fn = executeOAuthRequest,
};

/// Codex-only provider bundle used by ACP/CLI test configurations.
pub const provider_bundle = @import("../core/gateway/provider_set.zig").Bundle{
    .presentation = @import("../core/auth/provider_catalog.zig").find(.codex),
    .auth_strategy = .chatgpt,
    .agent_stream = @import("../gateway/openai_codex.zig").agent_stream_provider,
    .cli_model_catalog = @import("../gateway/openai_codex_models.zig").cli_model_catalog_provider,
    .model_catalog = @import("../gateway/openai_codex_models.zig").model_catalog_provider,
    .permission_reviewer = @import("../gateway/openai_codex_permission_reviewer.zig").provider,
};

fn executeOAuthRequest(
    _: ?*anyopaque,
    alloc: Allocator,
    request: oauth_transport.Request,
) !oauth_transport.Response {
    var local_cancel = std.atomic.Value(bool).init(false);
    const cancel_flag = request.cancel_flag orelse &local_cancel;
    const deadline = request.deadline orelse std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(oauth_request_timeout_ms),
    });
    var operation = OAuthHttpOperation{
        .alloc = alloc,
        .request = request,
    };
    return gateway_client.runBoundedHttpOperation(
        oauth_transport.Response,
        alloc,
        cancel_flag,
        deadline,
        &operation,
    );
}

const OAuthHttpOperation = struct {
    alloc: Allocator,
    request: oauth_transport.Request,

    pub fn run(self: *@This()) !oauth_transport.Response {
        var client: std.http.Client = .{
            .allocator = self.alloc,
            .io = io_mod.getIo(),
        };
        defer client.deinit();

        const response_buffer = try self.alloc.alloc(u8, oauth_response_max_bytes + 1);
        defer secret.zeroAndFree(self.alloc, response_buffer);
        var response_writer = std.Io.Writer.fixed(response_buffer);

        const result = client.fetch(.{
            .location = .{ .url = self.request.url },
            .method = switch (self.request.method) {
                .get => .GET,
                .post_form, .post_json => .POST,
            },
            .payload = self.request.payload,
            .headers = .{
                .content_type = switch (self.request.method) {
                    .get => .default,
                    .post_form => .{ .override = "application/x-www-form-urlencoded" },
                    .post_json => .{ .override = "application/json" },
                },
                .user_agent = .{ .override = gateway_client.user_agent },
                .accept_encoding = .omit,
                .authorization = if (self.request.authorization) |value|
                    .{ .override = value }
                else
                    .default,
            },
            .redirect_behavior = .unhandled,
            .response_writer = &response_writer,
        }) catch |err| switch (err) {
            error.WriteFailed => return error.OAuthResponseTooLarge,
            else => return err,
        };
        const body = response_writer.buffered();
        if (body.len > oauth_response_max_bytes) return error.OAuthResponseTooLarge;

        return .{
            .disposition = if (result.status == .ok) .accepted else .rejected,
            .body = try self.alloc.dupe(u8, body),
        };
    }
};

pub const agent_stream_provider_contract = @import("../core/agent/stream_provider.zig");
const agent_request_body = @import("../gateway/agent_request_body.zig");
const model_tool_schema = @import("../core/tooling/model_tool_schema.zig");
const model_capabilities = @import("../core/config/model_capabilities.zig");

/// Shapes an agent request body for the fiber-internal transport fixtures.
pub fn buildAgentRequest(
    alloc: Allocator,
    request: agent_stream_provider_contract.RequestData,
) anyerror![]u8 {
    const budget: ?agent_request_body.BuildBudget = if (request.budget) |value|
        .{ .deadline = value.deadline, .cancel_flag = value.cancel_flag }
    else
        null;
    if (budget) |active| try active.check();

    const tools_json = try buildAgentToolsJson(alloc, request);
    defer alloc.free(tools_json);

    if (request.verified_images) |images| {
        const response_format = request.response_format orelse
            return error.MissingStructuredResponseFormat;
        const body = try agent_request_body.buildGatewayRequestBodyWithVerifiedImagesAndBudget(
            alloc,
            tools_json,
            request.messages,
            images,
            request.provider_options,
            request.tool_choice,
            .{
                .name = response_format.name,
                .description = response_format.description,
                .schema = response_format.schema,
            },
            budget orelse .{},
        );
        return body;
    }
    if (request.response_format != null) return error.StructuredResponseRequiresVerifiedImages;

    if (request.vision_mode != .required) {
        const body = if (budget) |active|
            agent_request_body.buildGatewayRequestBodyWithOptionsAndBudget(
                alloc,
                tools_json,
                request.messages,
                request.provider_options,
                request.tool_choice,
                request.max_output_tokens,
                active,
            )
        else
            agent_request_body.buildGatewayRequestBodyWithOptionsAndOutputLimit(
                alloc,
                tools_json,
                request.messages,
                request.provider_options,
                request.tool_choice,
                request.max_output_tokens,
            );
        return body;
    }

    if (budget) |active| {
        return agent_request_body.buildGatewayRequiredToolRequestBodyWithOptionsAndBudget(
            alloc,
            tools_json,
            request.messages,
            request.provider_options,
            request.max_output_tokens,
            active,
        );
    }
    return agent_request_body.buildGatewayRequiredToolRequestBodyWithOptionsAndOutputLimit(
        alloc,
        tools_json,
        request.messages,
        request.provider_options,
        request.max_output_tokens,
    );
}

fn buildAgentToolsJson(
    alloc: Allocator,
    request: agent_stream_provider_contract.RequestData,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeByte('[');
    var first = true;

    if (request.vision_mode == .required) {
        const vision = request.tools.registry.lookup("vision") orelse
            return error.VisionToolNotRegistered;
        try model_tool_schema.writeBuiltinFunctionSchema(alloc, &out.writer, vision.model_schema);
        try out.writer.writeByte(']');
        return out.toOwnedSlice();
    }

    for (request.tools.advertised_names) |name| {
        if (!first) try out.writer.writeByte(',');
        first = false;
        if (request.tools.advertisedFunction(name)) |function| {
            try model_tool_schema.writeBuiltinFunctionSchema(alloc, &out.writer, function);
        } else {
            const tool = request.tools.registry.lookup(name) orelse return error.AdvertisedToolNotRegistered;
            const write_advertisement = tool.write_provider_advertisement_fn orelse
                return error.AdvertisedToolSchemaMissing;
            try write_advertisement(alloc, &out.writer);
        }
    }
    for (request.tools.additional_functions) |tool| {
        if (toolNameSelected(request.tools.advertised_names, tool.name)) continue;
        if (!first) try out.writer.writeByte(',');
        first = false;
        try model_tool_schema.writeBuiltinFunctionSchema(alloc, &out.writer, tool);
    }
    for (request.tools.selected_dynamic) |tool| {
        if (toolNameSelected(request.tools.advertised_names, tool.name)) continue;
        if (!first) try out.writer.writeByte(',');
        first = false;
        try writeDynamicFunctionTool(&out.writer, tool);
    }
    if (request.vision_mode == .optional and
        !toolNameSelected(request.tools.advertised_names, "vision"))
    {
        const vision = request.tools.registry.lookup("vision") orelse
            return error.VisionToolNotRegistered;
        if (!first) try out.writer.writeByte(',');
        try model_tool_schema.writeBuiltinFunctionSchema(alloc, &out.writer, vision.model_schema);
    }
    try out.writer.writeByte(']');
    return out.toOwnedSlice();
}

fn writeDynamicFunctionTool(
    writer: *std.Io.Writer,
    tool: agent_stream_provider_contract.DynamicFunctionTool,
) !void {
    try writer.writeAll("{\"type\":\"function\",\"name\":");
    try std.json.Stringify.value(tool.name, .{}, writer);
    try writer.writeAll(",\"description\":");
    try std.json.Stringify.value(tool.description, .{}, writer);
    try writer.writeAll(",\"inputSchema\":");
    try std.json.Stringify.value(tool.input_schema, .{}, writer);
    try writer.writeByte('}');
}

fn toolNameSelected(names: []const []const u8, expected: []const u8) bool {
    for (names) |name| if (std.mem.eql(u8, name, expected)) return true;
    return false;
}
