const std = @import("std");
const builtin = @import("builtin");

comptime {
    if (!builtin.is_test) @compileError("gateway_fixture links transport fixtures; import it only from test builds");
}

const agent_request_body = @import("../gateway/agent_request_body.zig");
const agent_stream_provider_contract = @import("../core/agent/stream_provider.zig");
const model_tool_schema = @import("../core/tooling/model_tool_schema.zig");

const Allocator = std.mem.Allocator;

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
