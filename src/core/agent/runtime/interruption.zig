const std = @import("std");
const lifecycle_hooks = @import("../../hooks/hooks.zig");
const types = @import("../../shared/types.zig");
const debug_trace = @import("../../shared/debug_trace.zig");
const execution_memory_helpers = @import("../execution_memory.zig");

const runtime_execution_memory = @import("execution_memory.zig");
const runtime_finalization = @import("finalization.zig");
const runtime_deps = @import("deps.zig");
const session_event = @import("../../session/session_event.zig");
const model_response_recovery = @import("model_response_recovery.zig");
const runtime_telemetry = @import("telemetry.zig");
const worker_runtime = @import("../worker_runtime.zig");

const Allocator = std.mem.Allocator;
const HistoryTurn = types.HistoryTurn;
const ToolCall = types.ToolCall;
const TraceContext = debug_trace.TraceContext;
const AgentRuntimeDeps = runtime_deps.AgentRuntimeDeps;
const TurnFinalizationGuard = runtime_finalization.TurnFinalizationGuard;
const QueuedPrompt = worker_runtime.QueuedPrompt;

pub fn persistInterruptedTurnOnce(
    hooks: *const AgentRuntimeDeps,
    finalization: *TurnFinalizationGuard,
    job: QueuedPrompt,
    partial_assistant: ?[]const u8,
    active_tool_call: ?ToolCall,
    completed_tool_names: [][]u8,
    persisted: *bool,
    trace_ctx: TraceContext,
    current_turn_messages: []const types.ChatMessage,
    retained_candidate: ?[]const u8,
    terminal_materializing: *bool,
    item_ids: types.InterruptedItemIds,
    reasoning_texts: []const std.ArrayList(u8),
    turn_message_slot: ?*?[]u8,
) !void {
    return persistInterruptedTurnWithPresentation(
        hooks,
        finalization,
        job,
        partial_assistant,
        active_tool_call,
        completed_tool_names,
        persisted,
        trace_ctx,
        current_turn_messages,
        retained_candidate,
        terminal_materializing,
        null,
        item_ids,
        reasoning_texts,
        turn_message_slot,
    );
}

pub fn persistInterruptedCommandTurnOnce(
    hooks: *const AgentRuntimeDeps,
    finalization: *TurnFinalizationGuard,
    job: QueuedPrompt,
    partial_assistant: ?[]const u8,
    active_tool_call: ToolCall,
    completed_tool_names: [][]u8,
    persisted: *bool,
    trace_ctx: TraceContext,
    current_turn_messages: []const types.ChatMessage,
    retained_candidate: ?[]const u8,
    terminal_materializing: *bool,
    cancelled_command: ?types.CancelledCommandPresentation,
    item_ids: types.InterruptedItemIds,
    reasoning_texts: []const std.ArrayList(u8),
    turn_message_slot: ?*?[]u8,
) !void {
    return persistInterruptedTurnWithPresentation(
        hooks,
        finalization,
        job,
        partial_assistant,
        active_tool_call,
        completed_tool_names,
        persisted,
        trace_ctx,
        current_turn_messages,
        retained_candidate,
        terminal_materializing,
        cancelled_command,
        item_ids,
        reasoning_texts,
        turn_message_slot,
    );
}

/// Emits closing item lines for an interrupted or failed stream: its
/// reasoning blocks then its message. The stream owns every started
/// boundary, so the terminal closes them only; a caller-minted message id
/// arrives with its started line already noted by its minter. Closing the
/// message clears the turn slot when it names the slot's id, so later steps
/// mint anew instead of reusing (and re-closing) it.
fn noteInterruptedItems(
    hooks: *const AgentRuntimeDeps,
    turn_id: u64,
    item_ids: types.InterruptedItemIds,
    reasoning_texts: []const std.ArrayList(u8),
    partial_assistant: ?[]const u8,
    outcome: session_event.MessageOutcome,
    cause: ?[]const u8,
    attempt: ?u64,
    turn_message_slot: ?*?[]u8,
) !void {
    const note_fn = hooks.note_session_event orelse return;
    for (item_ids.reasoning, 0..) |item_id, index| {
        const text = if (index < reasoning_texts.len) reasoning_texts[index].items else "";
        try note_fn(hooks.ctx, .{ .reasoning_completed = .{
            .turn_id = turn_id,
            .item_id = item_id,
            .text = text,
        } });
    }
    if (item_ids.message) |item_id| {
        try note_fn(hooks.ctx, .{ .message_completed = .{
            .turn_id = turn_id,
            .item_id = item_id,
            .text = partial_assistant orelse "",
            .outcome = outcome,
            .cause = cause,
            .attempt = attempt,
        } });
        if (turn_message_slot) |slot| {
            if (slot.*) |open_id| {
                if (std.mem.eql(u8, open_id, item_id)) {
                    std.heap.c_allocator.free(open_id);
                    slot.* = null;
                }
            }
        }
    }
}

fn persistInterruptedTurnWithPresentation(
    hooks: *const AgentRuntimeDeps,
    finalization: *TurnFinalizationGuard,
    job: QueuedPrompt,
    partial_assistant: ?[]const u8,
    active_tool_call: ?ToolCall,
    completed_tool_names: [][]u8,
    persisted: *bool,
    trace_ctx: TraceContext,
    current_turn_messages: []const types.ChatMessage,
    retained_candidate: ?[]const u8,
    terminal_materializing: *bool,
    cancelled_command: ?types.CancelledCommandPresentation,
    item_ids: types.InterruptedItemIds,
    reasoning_texts: []const std.ArrayList(u8),
    turn_message_slot: ?*?[]u8,
) !void {
    if (persisted.*) return;

    try noteInterruptedItems(
        hooks,
        job.turn_id,
        item_ids,
        reasoning_texts,
        partial_assistant,
        .interrupted,
        null,
        null,
        turn_message_slot,
    );

    const durable_active_tool_call = if (active_tool_call) |call|
        try execution_memory_helpers.dupeRedactedToolCall(
            std.heap.c_allocator,
            call,
        )
    else
        null;
    defer if (durable_active_tool_call) |call| {
        types.freeToolCall(std.heap.c_allocator, call);
    };
    const execution = try runtime_execution_memory.buildInterruptedExecutionMemory(
        std.heap.c_allocator,
        current_turn_messages,
        active_tool_call,
    );
    defer types.freeExecutionMemory(std.heap.c_allocator, execution);
    terminal_materializing.* = true;

    // The interrupted stream's identities persist with the turn, so resume
    // reuses them instead of minting new ones. Borrowed below, freed here.
    const assistant_item_id = if (item_ids.message) |id| try std.heap.c_allocator.dupe(u8, id) else null;
    defer if (assistant_item_id) |id| std.heap.c_allocator.free(id);
    const reasoning_item_ids = try types.dupeItemIdSlice(std.heap.c_allocator, item_ids.reasoning);
    defer types.freeItemIdSlice(std.heap.c_allocator, reasoning_item_ids);

    if (retained_candidate) |candidate| {
        const assistant = try lifecycle_hooks.prompt.joinVisibleSegments(
            std.heap.c_allocator,
            candidate,
            partial_assistant,
        );
        defer std.heap.c_allocator.free(@constCast(assistant));
        const turn: HistoryTurn = .{ .interrupted = .{
            .user = .{ .text = job.prompt, .images = job.images },
            .assistant = @constCast(assistant),
            .assistant_item_id = assistant_item_id,
            .reasoning_item_ids = reasoning_item_ids,
            .tool_call = durable_active_tool_call,
            .completed_tool_names = completed_tool_names,
            .execution = execution,
            .cancelled_command = cancelled_command,
        } };
        const finished = try types.dupeFinishedPrompt(
            std.heap.c_allocator,
            .{
                .turn = turn,
                .terminal_projection = .assistant_text,
            },
        );

        persisted.* = true;
        var propagation_error: ?anyerror = null;
        hooks.propagate_history_turn(hooks.ctx, turn, .interrupted) catch |err| {
            propagation_error = err;
        };
        try traceInterruptedPersistence(
            job,
            assistant,
            active_tool_call,
            completed_tool_names,
            trace_ctx,
        );
        try finalization.finish(.interrupted, null, finished);
        debug_trace.eventf(
            "interrupt",
            "finish_event_emitted",
            trace_ctx,
            "outcome_kind=interrupted",
            .{},
        );
        if (propagation_error) |err| return err;
        return;
    }

    persisted.* = true;
    const turn: HistoryTurn = .{ .interrupted = .{
        .user = .{ .text = job.prompt, .images = job.images },
        .assistant = if (partial_assistant) |text| if (text.len > 0) @constCast(text) else null else null,
        .assistant_item_id = assistant_item_id,
        .reasoning_item_ids = reasoning_item_ids,
        .tool_call = durable_active_tool_call,
        .completed_tool_names = completed_tool_names,
        .execution = execution,
        .cancelled_command = cancelled_command,
    } };

    var propagation_error: ?anyerror = null;
    hooks.propagate_history_turn(hooks.ctx, turn, .interrupted) catch |err| {
        propagation_error = err;
    };
    try traceInterruptedPersistence(
        job,
        partial_assistant,
        active_tool_call,
        completed_tool_names,
        trace_ctx,
    );
    try finalization.finish(.interrupted, null, .{
        .turn = try types.dupeHistoryTurn(std.heap.c_allocator, turn),
    });
    debug_trace.eventf("interrupt", "finish_event_emitted", trace_ctx, "outcome_kind=interrupted", .{});
    if (propagation_error) |err| return err;
}

pub fn persistFailedPartialTurnOnce(
    hooks: *const AgentRuntimeDeps,
    finalization: *TurnFinalizationGuard,
    job: QueuedPrompt,
    partial_assistant: []const u8,
    persisted: *bool,
    trace_ctx: TraceContext,
    current_turn_messages: []const types.ChatMessage,
    terminal_materializing: *bool,
    item_ids: types.InterruptedItemIds,
    reasoning_texts: []const std.ArrayList(u8),
    cause: model_response_recovery.FailureCause,
    attempt: usize,
    turn_message_slot: ?*?[]u8,
) !void {
    if (persisted.*) return;
    // An earlier step's message may still be open when this step never
    // streamed: that step finished, so it closes clean before this
    // failure mints its own item below.
    if (item_ids.message == null) {
        if (turn_message_slot) |slot| {
            if (slot.*) |open_id| {
                if (hooks.note_session_event) |note_fn| {
                    try note_fn(hooks.ctx, .{ .message_completed = .{
                        .turn_id = job.turn_id,
                        .item_id = open_id,
                        .text = "",
                        .outcome = .completed,
                    } });
                }
                std.heap.c_allocator.free(open_id);
                slot.* = null;
            }
        }
    }
    // Every failed call is a distinct item, content or not: a failure
    // before the first chunk minted no message id, so mint one here and
    // persist the empty text under it.
    var owned_minted: ?[]u8 = null;
    defer if (owned_minted) |id| std.heap.c_allocator.free(id);
    var effective_ids = item_ids;
    if (item_ids.message == null) {
        owned_minted = try types.generate_item_id(std.heap.c_allocator);
        effective_ids.message = owned_minted;
    }
    // The mint is this item's single writer: its started line has never
    // reached the log, so note it before the closer below.
    if (owned_minted) |minted| {
        if (hooks.note_session_event) |note_fn| {
            try note_fn(hooks.ctx, .{ .message_started = .{
                .turn_id = job.turn_id,
                .item_id = minted,
            } });
        }
    }

    try noteInterruptedItems(
        hooks,
        job.turn_id,
        effective_ids,
        reasoning_texts,
        partial_assistant,
        .failed,
        @tagName(cause),
        @intCast(attempt),
        turn_message_slot,
    );

    // The failed item is logged above, content or not. An empty failure
    // keeps its historical turn shape: only a partial persists here.
    if (partial_assistant.len == 0) return;

    const execution = try runtime_execution_memory.buildInterruptedExecutionMemory(
        std.heap.c_allocator,
        current_turn_messages,
        null,
    );
    defer types.freeExecutionMemory(std.heap.c_allocator, execution);
    terminal_materializing.* = true;

    const assistant_item_id = if (effective_ids.message) |id| try std.heap.c_allocator.dupe(u8, id) else null;
    defer if (assistant_item_id) |id| std.heap.c_allocator.free(id);
    const reasoning_item_ids = try types.dupeItemIdSlice(std.heap.c_allocator, item_ids.reasoning);
    defer types.freeItemIdSlice(std.heap.c_allocator, reasoning_item_ids);

    const turn: HistoryTurn = .{ .interrupted = .{
        .user = .{ .text = job.prompt, .images = job.images },
        .assistant = @constCast(partial_assistant),
        .assistant_item_id = assistant_item_id,
        .reasoning_item_ids = reasoning_item_ids,
        .execution = execution,
        .terminal_reason = .failed,
    } };
    const finished = try types.dupeFinishedPrompt(
        std.heap.c_allocator,
        .{
            .turn = turn,
            .terminal_projection = .assistant_text,
        },
    );

    persisted.* = true;
    var propagation_error: ?anyerror = null;
    hooks.propagate_history_turn(hooks.ctx, turn, .failed) catch |err| {
        propagation_error = err;
    };
    debug_trace.eventf(
        "gateway",
        "stream_failure_history_persisted",
        trace_ctx,
        "prompt_bytes={d} partial_assistant_bytes={d}",
        .{ job.prompt.len, partial_assistant.len },
    );
    try finalization.finish(.failed, null, finished);
    debug_trace.eventf(
        "gateway",
        "stream_failure_finish_event_emitted",
        trace_ctx,
        "outcome_kind=failed",
        .{},
    );
    if (propagation_error) |err| return err;
}

fn traceInterruptedPersistence(
    job: QueuedPrompt,
    partial_assistant: ?[]const u8,
    active_tool_call: ?ToolCall,
    completed_tool_names: [][]u8,
    trace_ctx: TraceContext,
) !void {
    const completed_tool_names_text = try runtime_telemetry.formatCompletedToolNamesCompact(std.heap.c_allocator, completed_tool_names);
    defer std.heap.c_allocator.free(completed_tool_names_text);
    debug_trace.logf("agent", "interrupted marker persisted prompt_bytes={d} partial_assistant_bytes={d} active_tool={s} completed_tool_count={d} completed_tool_names={s}", .{
        job.prompt.len,
        if (partial_assistant) |text| text.len else 0,
        if (active_tool_call != null) "true" else "false",
        completed_tool_names.len,
        completed_tool_names_text,
    });
    debug_trace.eventf("interrupt", "interrupted_history_persisted", trace_ctx, "prompt_bytes={d} partial_assistant_bytes={d} active_tool_known={s} completed_tool_count={d} completed_tool_names={s}", .{
        job.prompt.len,
        if (partial_assistant) |text| text.len else 0,
        if (active_tool_call != null) "true" else "false",
        completed_tool_names.len,
        completed_tool_names_text,
    });
    debug_trace.eventf("interrupt", "interrupt_persisted", trace_ctx, "prompt_bytes={d} partial_assistant_bytes={d} active_tool={s} completed_tool_count={d} completed_tool_names={s} active_tool_reason={s}", .{
        job.prompt.len,
        if (partial_assistant) |text| text.len else 0,
        if (active_tool_call != null) "true" else "false",
        completed_tool_names.len,
        completed_tool_names_text,
        interruptPersistenceReason(partial_assistant, active_tool_call, completed_tool_names),
    });
    if (active_tool_call) |tool_call| {
        debug_trace.logf("agent", "aborted tool output persisted call_id={s} name={s}", .{ tool_call.id, tool_call.name });
        debug_trace.eventf("interrupt", "aborted_tool_persisted", trace_ctx, "call_id={s} name={s}", .{ tool_call.id, tool_call.name });
    }
}

pub fn recordCompletedToolName(arena: Allocator, completed_tool_names: *std.ArrayList([]u8), name: []const u8) !void {
    try completed_tool_names.append(arena, try arena.dupe(u8, name));
}

pub fn countInterruptedHistory(history: []const HistoryTurn) usize {
    var count: usize = 0;
    for (history) |turn| {
        if (turn == .interrupted) count += 1;
    }
    return count;
}

pub fn countPartialTextInterruptedClosures(history: []const HistoryTurn) usize {
    var count: usize = 0;
    for (history) |turn| {
        const entry = switch (turn) {
            .interrupted => |value| value,
            else => continue,
        };
        if (entry.tool_call != null) continue;
        if (entry.completed_tool_names.len > 0) continue;
        if (entry.assistant) |assistant| {
            if (assistant.len > 0) count += 1;
        }
    }
    return count;
}

fn interruptPersistenceReason(partial_assistant: ?[]const u8, active_tool_call: ?ToolCall, completed_tool_names: []const []u8) []const u8 {
    if (active_tool_call != null) return "active_tool_call_present";
    if (completed_tool_names.len > 0) return "completed_tools_present";
    if (partial_assistant) |text| {
        if (text.len > 0) return "partial_assistant_only";
    }
    return "no_assistant_output";
}
