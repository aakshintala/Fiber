const std = @import("std");
const types = @import("../shared/types.zig");
const session = @import("session.zig");

const Allocator = std.mem.Allocator;

pub const SessionTokenUsage = struct {
    input: u64 = 0,
    output: u64 = 0,
    web_search_requests: u64 = 0,
};

pub noinline fn renderSessionJson(
    alloc: Allocator,
    active_id: []const u8,
    created_at_ms: i64,
    updated_at_ms: i64,
    language: session.ConversationLanguage,
    workspace_root: []const u8,
    history: []const session.HistoryTurn,
    token_usage: SessionTokenUsage,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try out.writer.writeAll("{\"schema_version\":1,\"id\":");
    try std.json.Stringify.value(active_id, .{}, &out.writer);
    try out.writer.print(",\"created_at_ms\":{d},\"updated_at_ms\":{d}", .{ created_at_ms, updated_at_ms });
    try out.writer.writeAll(",\"workspace_root\":");
    try std.json.Stringify.value(workspace_root, .{}, &out.writer);
    try out.writer.writeAll(",\"conversation_language\":");
    try std.json.Stringify.value(language.view(), .{}, &out.writer);
    if (token_usage.input > 0 or token_usage.output > 0) {
        try out.writer.print(",\"total_input_tokens\":{d},\"total_output_tokens\":{d}", .{ token_usage.input, token_usage.output });
    }
    if (token_usage.web_search_requests > 0) {
        try out.writer.print(",\"total_web_search_requests\":{d}", .{token_usage.web_search_requests});
    }
    try out.writer.print(",\"history_len\":{d},\"history\":[", .{history.len});

    for (history, 0..) |turn, i| {
        if (i > 0) try out.writer.writeByte(',');
        try writeHistoryTurnJson(&out.writer, turn);
    }

    try out.writer.writeAll("]}");
    return try out.toOwnedSlice();
}

fn writeHistoryTurnJson(writer: *std.Io.Writer, turn: session.HistoryTurn) !void {
    switch (turn) {
        .compacted_summary => |entry| {
            try writer.writeAll("{\"kind\":\"compacted_summary\",\"summary\":");
            try std.json.Stringify.value(entry.summary, .{}, writer);
            try writer.print(",\"removed_turn_count\":{d},\"compaction_count\":{d}", .{ entry.removed_turn_count, entry.compaction_count });
            try writer.writeByte('}');
        },
        .assistant => |entry| {
            try writer.writeAll("{\"kind\":\"assistant\",\"user\":");
            try writeUserTurnJson(writer, entry.user);
            try writer.writeAll(",\"assistant\":");
            try std.json.Stringify.value(entry.assistant, .{}, writer);
            if (!entry.execution.isEmpty()) {
                try writer.writeAll(",\"execution\":");
                try writeExecutionMemoryJson(writer, entry.execution);
            }
            try writer.writeByte('}');
        },
        .interrupted => |entry| {
            try writer.writeAll("{\"kind\":\"interrupted\",\"user\":");
            try writeUserTurnJson(writer, entry.user);
            try writer.writeAll(",\"assistant\":");
            if (entry.assistant) |assistant| {
                try std.json.Stringify.value(assistant, .{}, writer);
            } else {
                try writer.writeAll("null");
            }
            try writer.writeAll(",\"tool_call\":");
            if (entry.tool_call) |tool_call| {
                try writeToolCallJson(writer, tool_call);
            } else {
                try writer.writeAll("null");
            }
            try writer.writeAll(",\"completed_tool_names\":");
            try writeStringArrayJson(writer, entry.completed_tool_names);
            try writer.writeAll(",\"terminal_reason\":");
            try std.json.Stringify.value(@tagName(entry.terminal_reason), .{}, writer);
            if (!entry.execution.isEmpty()) {
                try writer.writeAll(",\"execution\":");
                try writeExecutionMemoryJson(writer, entry.execution);
            }
            try writer.writeByte('}');
        },
    }
}

fn writeToolCallJson(writer: *std.Io.Writer, tool_call: session.ToolCall) !void {
    try writer.writeAll("{\"id\":");
    try std.json.Stringify.value(tool_call.id, .{}, writer);
    try writer.writeAll(",\"name\":");
    try std.json.Stringify.value(tool_call.name, .{}, writer);
    try writer.writeAll(",\"arguments_json\":");
    try std.json.Stringify.value(tool_call.arguments_json, .{}, writer);
    try writer.writeAll(",\"provider_result\":");
    if (tool_call.provider_result) |provider_result| {
        try std.json.Stringify.value(provider_result, .{}, writer);
    } else {
        try writer.writeAll("null");
    }
    try writer.writeByte('}');
}

pub fn writeExecutionMemoryJson(writer: *std.Io.Writer, execution: session.ExecutionMemory) !void {
    try writer.writeAll("{\"schema_version\":2,\"tool_steps\":[");
    for (execution.tool_steps, 0..) |step, i| {
        if (i > 0) try writer.writeByte(',');
        try writer.writeAll("{\"assistant\":");
        if (step.assistant) |assistant| {
            try std.json.Stringify.value(assistant, .{}, writer);
        } else {
            try writer.writeAll("null");
        }
        try writer.writeAll(",\"tool_calls\":[");
        for (step.tool_calls, 0..) |tool_call, call_index| {
            if (call_index > 0) try writer.writeByte(',');
            try writeToolCallJson(writer, tool_call);
        }
        try writer.writeAll("],\"tool_results\":[");
        for (step.tool_results, 0..) |result, result_index| {
            if (result_index > 0) try writer.writeByte(',');
            try writePersistedToolResultJson(writer, result);
        }
        try writer.writeAll("]}");
    }
    try writer.writeAll("],\"files\":[");
    for (execution.files, 0..) |file, i| {
        if (i > 0) try writer.writeByte(',');
        try writeFileEvidenceJson(writer, file);
    }
    try writer.writeAll("],\"steering\":[");
    for (execution.steering, 0..) |text, i| {
        if (i > 0) try writer.writeByte(',');
        try std.json.Stringify.value(text, .{}, writer);
    }
    try writer.writeAll("]}");
}

fn writePersistedToolResultJson(writer: *std.Io.Writer, result: session.PersistedToolResult) !void {
    try writer.writeAll("{\"tool_call_id\":");
    try std.json.Stringify.value(result.tool_call_id, .{}, writer);
    try writer.writeAll(",\"tool_name\":");
    try std.json.Stringify.value(result.tool_name, .{}, writer);
    try writer.writeAll(",\"status\":");
    try std.json.Stringify.value(@tagName(result.status), .{}, writer);
    try writer.writeAll(",\"output\":");
    try std.json.Stringify.value(result.output, .{}, writer);
    if (result.output_handle) |handle| {
        try writer.writeAll(",\"output_handle\":");
        try std.json.Stringify.value(handle, .{}, writer);
    }
    if (result.preview) |preview| {
        try writer.writeAll(",\"preview\":");
        try std.json.Stringify.value(preview, .{}, writer);
    }
    try writer.print(",\"output_bytes\":{d},\"stored_output_bytes\":{d},\"truncated\":{s},\"provider_native\":{s},\"created_at_ms\":{d}", .{
        result.output_bytes,
        result.stored_output_bytes,
        if (result.truncated) "true" else "false",
        if (result.provider_native) "true" else "false",
        result.created_at_ms,
    });
    try writer.writeAll(",\"permission_feedback\":[");
    for (result.permission_feedback, 0..) |feedback, i| {
        if (i > 0) try writer.writeByte(',');
        try std.json.Stringify.value(feedback, .{}, writer);
    }
    try writer.writeByte(']');
    if (result.committed_file_presentation) |presentation| {
        try writer.writeAll(",\"committed_file_presentation\":");
        try writeCommittedFilePresentationJson(writer, presentation);
    }
    try writer.writeByte('}');
}

fn writeCommittedFilePresentationJson(
    writer: *std.Io.Writer,
    presentation: types.CommittedFilePresentation,
) !void {
    try writer.writeAll("{\"path\":");
    try std.json.Stringify.value(presentation.path, .{}, writer);
    try writer.writeAll(",\"kind\":");
    try std.json.Stringify.value(@tagName(presentation.kind), .{}, writer);
    try writer.writeAll(",\"lines\":[");
    for (presentation.lines, 0..) |line, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeAll("{\"kind\":");
        try std.json.Stringify.value(@tagName(line.kind), .{}, writer);
        try writer.writeAll(",\"old_line\":");
        try writeOptionalU32Json(writer, line.old_line);
        try writer.writeAll(",\"new_line\":");
        try writeOptionalU32Json(writer, line.new_line);
        try writer.writeAll(",\"text\":");
        try std.json.Stringify.value(line.text, .{}, writer);
        try writer.writeByte('}');
    }
    try writer.print("],\"additions\":{d},\"deletions\":{d},\"truncated\":{s},\"previous_content\":", .{
        presentation.additions,
        presentation.deletions,
        if (presentation.truncated) "true" else "false",
    });
    try writeOptionalStringJson(writer, presentation.previous_content);
    try writer.writeAll(",\"after_content\":");
    try writeOptionalStringJson(writer, presentation.after_content);
    try writer.writeAll(",\"lifecycle_id\":");
    if (presentation.lifecycle_id) |id| {
        try writer.print("{{\"turn_id\":{d},\"call_id\":", .{id.turn_id});
        try std.json.Stringify.value(id.call_id, .{}, writer);
        try writer.writeByte('}');
    } else {
        try writer.writeAll("null");
    }
    try writer.writeByte('}');
}

fn writeOptionalU32Json(writer: *std.Io.Writer, value: ?u32) !void {
    if (value) |number| {
        try writer.print("{d}", .{number});
    } else {
        try writer.writeAll("null");
    }
}

fn writeOptionalStringJson(writer: *std.Io.Writer, value: ?[]const u8) !void {
    if (value) |text| {
        try std.json.Stringify.value(text, .{}, writer);
    } else {
        try writer.writeAll("null");
    }
}

fn writeFileEvidenceJson(writer: *std.Io.Writer, file: session.FileEvidence) !void {
    try writer.writeAll("{\"path\":");
    try std.json.Stringify.value(file.path, .{}, writer);
    try writer.writeAll(",\"new_path\":");
    if (file.new_path) |new_path| {
        try std.json.Stringify.value(new_path, .{}, writer);
    } else {
        try writer.writeAll("null");
    }
    try writer.writeAll(",\"tool_call_id\":");
    try std.json.Stringify.value(file.tool_call_id, .{}, writer);
    try writer.writeAll(",\"tool_name\":");
    try std.json.Stringify.value(file.tool_name, .{}, writer);
    try writer.writeAll(",\"action\":");
    try std.json.Stringify.value(@tagName(file.action), .{}, writer);
    try writer.writeAll(",\"status\":");
    try std.json.Stringify.value(@tagName(file.status), .{}, writer);
    try writer.print(",\"model_view_covers_full_file\":{s},\"stale\":{s}", .{
        if (file.model_view_covers_full_file) "true" else "false",
        if (file.stale) "true" else "false",
    });
    try writer.writeByte('}');
}

fn writeUserTurnJson(writer: *std.Io.Writer, user: session.UserTurn) !void {
    try writer.writeAll("{\"text\":");
    try std.json.Stringify.value(user.text, .{}, writer);
    try writer.writeAll(",\"images\":[");
    for (user.images, 0..) |image, i| {
        if (i > 0) try writer.writeByte(',');
        try writer.writeAll("{\"path\":");
        try std.json.Stringify.value(image.path, .{}, writer);
        try writer.writeAll(",\"media_type\":");
        try std.json.Stringify.value(image.media_type, .{}, writer);
        try writer.writeAll(",\"snapshot_path\":");
        try writeImageSnapshotLocatorJson(writer, image.snapshot_path);
        try writer.writeAll(",\"snapshot_sha256\":");
        try std.json.Stringify.value(image.snapshot_sha256, .{}, writer);
        try writer.writeByte('}');
    }
    try writer.writeAll("]}");
}

fn writeImageSnapshotLocatorJson(writer: *std.Io.Writer, value: ?[]const u8) !void {
    const path = value orelse {
        try writer.writeAll("null");
        return;
    };
    var locator_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const locator = try session.projectSnapshotLocator(&locator_buffer, path);
    try std.json.Stringify.value(locator, .{}, writer);
}

test "ordinary session JSON presentation omits per-turn work provenance" {
    const alloc = std.testing.allocator;
    const history = [_]session.HistoryTurn{.{ .assistant = .{
        .user = .{
            .text = @constCast("canonical prompt"),
            .work_id = @constCast("work-private"),
        },
        .assistant = @constCast("canonical reply"),
    } }};
    const json = try renderSessionJson(
        alloc,
        "presentation",
        1,
        2,
        session.ConversationLanguage.literal("en"),
        "/tmp/workspace",
        &history,
        .{},
    );
    defer alloc.free(json);
    try std.testing.expect(std.mem.find(u8, json, "work-private") == null);
    try std.testing.expect(std.mem.find(u8, json, "work_id") == null);
    try std.testing.expect(std.mem.find(u8, json, "canonical prompt") != null);
}

fn writeStringArrayJson(writer: *std.Io.Writer, items: anytype) !void {
    try writer.writeByte('[');
    for (items, 0..) |item, i| {
        if (i > 0) try writer.writeByte(',');
        try std.json.Stringify.value(item, .{}, writer);
    }
    try writer.writeByte(']');
}

test {
    _ = @import("session_codec.zig");
    _ = @import("session_event.zig");
    _ = @import("session_projection.zig");
}
