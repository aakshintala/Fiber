const std = @import("std");
const command_admission = @import("../../permissions/command_admission.zig");
const types = @import("../../shared/types.zig");
const diff = @import("../../output/diff.zig");
const file_mutation = @import("../../tooling/file_mutation.zig");
const session_permission_state = @import("../../permissions/session_permission_state.zig");
const command_replay_store = @import("../../session/command_replay_store.zig");
const result_commit = @import("../../tooling/result_commit.zig");
const tool_dispatch = @import("../../tooling/tool_dispatch.zig");

pub const vision = @import("vision_contracts.zig");

test {
    _ = vision;
}

const Allocator = std.mem.Allocator;
const ChatMessage = types.ChatMessage;
const PermissionGrant = types.PermissionGrant;
const ToolCall = types.ToolCall;

/// Borrowed child-only authority refreshed immediately before one tool action.
/// Main-agent requests leave this null and retain their existing behavior.
pub const LiveToolAuthority = struct {
    generation: u64,
    root_id: []const u8,
    tools: []const []const u8,
    integrations: []const []const u8,
    rules: types.PermissionRuleSet,
    grants: []const PermissionGrant,
    permission_state: ?*const session_permission_state.State = null,
    permission_mode: types.PermissionMode = .yolo,
};

pub const ToolExecutionStatus = enum {
    success,
    failure,
};

/// Exact action identity and approval provenance retained while a child action
/// is revalidated against a newer live-authority generation.
pub const LivePermissionRevalidation = union(enum) {
    action: struct {
        authority: command_admission.ToolExecutionAuthority,
        human_approval: command_admission.HumanApprovalProvenance,
    },
};

pub const TransportPublicationOutcome = enum {
    published,
    failed,
};

pub const SecondarySinkOutcome = enum {
    skipped,
    published,
    failed,
};

pub const SecondaryPublicationReport = struct {
    diff: SecondarySinkOutcome,
    tracker: SecondarySinkOutcome,

    pub fn degraded(self: SecondaryPublicationReport) bool {
        return self.diff == .failed or self.tracker == .failed;
    }
};

pub const ToolExecutionResult = struct {
    model_output: []const u8,
    status: ToolExecutionStatus = .success,
    cancelled: bool = false,
    /// Typed outcome set by the code that knows what happened (ticket
    /// #178): admission stamps denials, and the orchestrator stamps
    /// reject and deferral outcomes. Command tools publish structured
    /// process facts instead, which the runtime boundary maps without
    /// reading text. A set outcome always wins over the derived one.
    outcome: ?types.ToolCallOutcome = null,
    status_detail: ?[]const u8 = null,
    diff_entry: ?DiffEntryPayload = null,
    finish_turn: bool = false,
    system_notice: ?[]const u8 = null,
    interactive_notice: ?types.SemanticNotice = null,
    context_notices: []const []const u8 = &.{},
    command_result_json: ?[]const u8 = null,
    web_search_completion: ?types.WebSearchCompletion = null,
    web_fetch_completion: ?types.WebFetchCompletion = null,
    inner_usage: ?types.ToolUsage = null,
    selected_dynamic_tool_name: ?[]const u8 = null,
    selected_dynamic_tool_schema_json: ?[]const u8 = null,
    tool_result_memory: ?types.ToolResultMemory = null,
    tool_result_memory_prepared: bool = false,
    committed_file_handoff: ?file_mutation.CommittedFileHandoff = null,
    command_replay_capture: ?*command_replay_store.Capture = null,
    result_commit: ?result_commit.Token = null,

    /// Centralized constructors (ticket #178): each stamps the typed
    /// outcome at construction through toolOutcomeForExecution, so tools
    /// carry their outcome from the source instead of leaving it for
    /// downstream derivation. No constructor changes model-visible text;
    /// only the outcome is added.
    pub fn completed(scratch: Allocator, model_output: []const u8) ToolExecutionResult {
        return stamped(scratch, .{ .model_output = model_output });
    }

    pub fn failed(scratch: Allocator, model_output: []const u8) ToolExecutionResult {
        return stamped(scratch, .{ .status = .failure, .model_output = model_output });
    }

    pub fn cancelledResult(scratch: Allocator, model_output: []const u8) ToolExecutionResult {
        return stamped(scratch, .{ .status = .failure, .cancelled = true, .model_output = model_output });
    }

    /// Stamps any literal without changing its fields or text: an
    /// explicitly set outcome is preserved, otherwise the choke-point
    /// derivation fills it in. Mechanical migrations wrap their existing
    /// literal with this.
    pub fn stamped(scratch: Allocator, base: ToolExecutionResult) ToolExecutionResult {
        var result = base;
        result.outcome = result.outcome orelse toolOutcomeForExecution(
            scratch,
            result.status,
            result.cancelled,
            result.command_result_json,
            result.status_detail,
        );
        return result;
    }
};

test "tool result retains one memory payload across preparation" {
    try std.testing.expect(@hasField(ToolExecutionResult, "tool_result_memory"));
    try std.testing.expect(@hasField(ToolExecutionResult, "tool_result_memory_prepared"));
    try std.testing.expect(!@hasField(ToolExecutionResult, "prepared_result_memory"));
}

/// Typed outcome for a locally executed tool call (ticket #178). A stop
/// by Fiber or the user is `cancelled`; `signal` covers only a kill from
/// outside Fiber. Process facts come from the structured command result,
/// never from output text. `scratch` is used only while parsing the
/// command result; the returned outcome borrows `command_result_json` and
/// `status_detail`, never the parse tree.
///
/// Single choke point: every ToolExecutionResult constructor below stamps
/// its outcome through this function, and execution_memory delegates to it.
/// Un-migrated literals keep the null-outcome fallback, which
/// toolOutcomeForResult derives the same way.
pub fn toolOutcomeForExecution(
    scratch: Allocator,
    status: ToolExecutionStatus,
    cancelled: bool,
    command_result_json: ?[]const u8,
    status_detail: ?[]const u8,
) types.ToolCallOutcome {
    if (cancelled) return .{ .status = .cancelled };
    const facts = commandFacts(scratch, command_result_json);
    const process: ?types.ToolProcessFacts = if (facts.present) .{
        .exit_code = facts.exit_code,
        .signal = facts.signal,
        .timed_out = facts.timed_out,
    } else null;
    // A successful tool result carrying a death signal is a stop by Fiber
    // or the user (the stop tool reports success once the target is
    // reaped), never an outside kill: outside kills surface as command
    // failures. Report it cancelled, not completed, so an interrupt is
    // never read as a clean run (spec issue #189 section 3, story 37).
    if (status == .success) {
        if (facts.signal != null) return .{ .status = .cancelled };
        return .{ .status = .completed, .process = process };
    }
    if (facts.timed_out) return .{
        .status = .failed,
        .error_code = .timeout,
        .error_message = status_detail orelse "Command timed out",
        .process = process,
    };
    if (facts.signal) |_| return .{
        .status = .failed,
        .error_code = .signal,
        .error_message = status_detail orelse "Command terminated by signal",
        .process = process,
    };
    if (facts.termination_indeterminate) return .{
        .status = .failed,
        .error_code = .indeterminate,
        .error_message = status_detail orelse "Command status could not be confirmed",
        .process = process,
    };
    if (facts.exit_code) |code| {
        if (code != 0) return .{
            .status = .failed,
            .error_code = .nonzero_exit,
            .error_message = status_detail orelse "Command exited with non-zero status",
            .process = process,
        };
        return .{ .status = .completed, .process = process };
    }
    return .{
        .status = .failed,
        .error_code = .tool_error,
        .error_message = status_detail orelse "Tool execution failed",
        .process = process,
    };
}

const CommandFacts = struct {
    present: bool = false,
    exit_code: ?i64 = null,
    signal: ?u32 = null,
    timed_out: bool = false,
    termination_indeterminate: bool = false,
};

fn commandFacts(scratch: Allocator, command_result_json: ?[]const u8) CommandFacts {
    const encoded = command_result_json orelse return .{};
    const Parsed = struct {
        exit_code: ?i64 = null,
        signal: ?u32 = null,
        timed_out: bool = false,
        termination_indeterminate: bool = false,
    };
    const parsed = std.json.parseFromSlice(
        Parsed,
        scratch,
        encoded,
        .{ .ignore_unknown_fields = true },
    ) catch return .{};
    defer parsed.deinit();
    return .{
        .present = true,
        .exit_code = parsed.value.exit_code,
        .signal = parsed.value.signal,
        .timed_out = parsed.value.timed_out,
        .termination_indeterminate = parsed.value.termination_indeterminate,
    };
}

test "tool constructors stamp the typed outcome at construction" {
    const scratch = std.testing.allocator;
    // Fail-before anchor: a plain literal leaves the outcome null at the
    // source; only the constructors (or the downstream fallback) set it.
    const raw: ToolExecutionResult = .{ .model_output = "done" };
    try std.testing.expect(raw.outcome == null);

    const ok = ToolExecutionResult.completed(scratch, "done");
    try std.testing.expect(ok.outcome != null);
    try std.testing.expectEqual(types.ToolCallStatus.completed, ok.outcome.?.status);

    const err = ToolExecutionResult.failed(scratch, "nope");
    try std.testing.expect(err.outcome != null);
    try std.testing.expectEqual(types.ToolCallStatus.failed, err.outcome.?.status);
    try std.testing.expectEqual(types.ToolErrorCode.tool_error, err.outcome.?.error_code.?);

    const stop = ToolExecutionResult.cancelledResult(scratch, "command cancelled\n");
    try std.testing.expect(stop.outcome != null);
    try std.testing.expectEqual(types.ToolCallStatus.cancelled, stop.outcome.?.status);

    // Structured command facts route through the same choke point.
    const timeout = ToolExecutionResult.stamped(scratch, .{
        .status = .failure,
        .model_output = "timeout\n",
        .command_result_json = "{\"timed_out\":true}",
    });
    try std.testing.expectEqual(types.ToolCallStatus.failed, timeout.outcome.?.status);
    try std.testing.expectEqual(types.ToolErrorCode.timeout, timeout.outcome.?.error_code.?);

    // An explicitly set outcome always wins over the derivation.
    const explicit = ToolExecutionResult.stamped(scratch, .{
        .status = .failure,
        .model_output = "denied",
        .outcome = .{ .status = .denied, .denial_reason = .policy_denied },
    });
    try std.testing.expectEqual(types.ToolCallStatus.denied, explicit.outcome.?.status);
}

pub inline fn failToolExecutionResult(err: anytype) @TypeOf(err)!ToolExecutionResult {
    return @errorCast(failToolExecutionResultDynamic(err));
}

noinline fn failToolExecutionResultDynamic(err: anyerror) anyerror!ToolExecutionResult {
    return err;
}

test "tool result failure writer preserves exact error type and identity" {
    const failure = failToolExecutionResult(error.LiveToolAuthorityUnavailable);
    try std.testing.expect(
        @TypeOf(failure) == error{LiveToolAuthorityUnavailable}!ToolExecutionResult,
    );
    try std.testing.expectError(error.LiveToolAuthorityUnavailable, failure);
}

pub const ToolExecutionRequest = struct {
    call_allocator: Allocator,
    result_allocator: Allocator,
    call: ToolCall,
    authority: command_admission.ToolExecutionAuthority,
    /// Action-scoped root mode sampled before permission admission. Direct
    /// callers without a sampled mode retain their execution context value.
    permission_mode: ?types.PermissionMode = null,
    /// Borrowed root-user evidence for subagent execution. This is never
    /// populated from an assistant-authored task prompt.
    root_user_intent_context: []const u8 = "",
    root_user_messages: []const []const u8 = &.{},
    root_user_evidence_complete: bool = false,
    /// Borrowed caller-owned catalog of images authorized for this call. The
    /// executor must not retain this slice or any attachment pointer.
    authorized_image_catalog: []const types.ImageAttachment = &.{},
    /// Borrowed execution evidence retained by the owning agent loop until
    /// the current turn is committed.
    current_turn_messages: []const ChatMessage = &.{},
    session_grants: []const PermissionGrant,
    live_authority: ?LiveToolAuthority = null,
    expected_mcp_runtime_generation: ?u64 = null,
    advertised_dynamic_tool_names: []const []const u8,
    max_tool_result_bytes: usize,
    /// The owning agent loop already ran its policy-neutral idempotency and
    /// availability classifiers for this exact effective call.
    classification_complete: bool = false,
    /// Timeout origin retained across preparation and execution.
    command_timeout_started_ms: ?i64 = null,
    /// Continues accepted-byte capture across the prepared execution.
    command_replay_capture: ?*command_replay_store.Capture = null,
    command_replay_unavailable: bool = false,
    /// Present for interactive tool calls so streamed command output can stay
    /// attached to the status row that owns this exact call.
    lifecycle_id: ?types.ToolLifecycleId = null,
};

pub const DiffEntryPayload = diff.DiffEntryPayload;

pub const ToolCallValidationWitness = struct {
    mcp_runtime_generation: ?u64 = null,
};

pub const ToolCallValidationResult = union(enum) {
    not_registered,
    valid: ToolCallValidationWitness,
    failure: []const u8,
};
