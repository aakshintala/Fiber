const std = @import("std");
const session = @import("session.zig");
const session_codec = @import("session_codec.zig");
const session_permission_state = @import("../permissions/session_permission_state.zig");
const session_usage = @import("session_usage.zig");
const types = @import("../shared/types.zig");
const model_provider = @import("../config/model_provider.zig");

const Allocator = std.mem.Allocator;
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const event_frame_max_bytes: usize = 8 * 1024 * 1024;
pub const raw_state_chunk_bytes: usize = 4 * 1024 * 1024;
pub const Identifier = [16]u8;
pub const Digest = [Sha256.digest_length]u8;

pub const Kind = enum {
    session_started,
    preferences_changed,
    permission_state_changed,
    workspace_rebound,
    run_started,
    run_completed,
    turn_started,
    turn_completed,
    assistant_message_started,
    assistant_message_completed,
    reasoning_started,
    reasoning_completed,
    usage_recorded,
    recovery_checkpoint_set,
    recovery_checkpoint_cleared,
    state_replacement_started,
    state_replacement_chunk,
    state_replacement_committed,
    /// Retired pre-inversion kinds. Decode-only: old logs project through
    /// them, but no writer emits them. They stay last so the durable prefix
    /// keeps its order.
    history_turn_committed,
    usage_checkpointed,
};

pub const ReplacementReason = enum {
    compaction,
    migration,
    recovery,
    log_compaction,
};

pub const SessionStarted = struct {
    id: []u8,
    created_at_ms: i64,
    origin_workspace_root: []u8,
    workspace_root: []u8,
    conversation_language: session.ConversationLanguage,
    preferences: session_codec.DurableSessionPreferences,
    usage: ?session_usage.Snapshot = null,
    subagent_child: bool = false,

    fn deinit(self: *SessionStarted, alloc: Allocator) void {
        alloc.free(self.id);
        alloc.free(self.origin_workspace_root);
        alloc.free(self.workspace_root);
        self.preferences.deinit(alloc);
        if (self.usage) |*usage| usage.deinit(alloc);
        self.* = undefined;
    }
};

pub const PreferencesChanged = struct {
    provider: ?model_provider.ProviderId = null,
    model: ?[]u8 = null,
    effort: ?types.ReasoningEffort = null,
    fast_mode: ?bool = null,

    fn deinit(self: *PreferencesChanged, alloc: Allocator) void {
        if (self.model) |model| alloc.free(model);
        self.* = undefined;
    }
};

pub const PermissionStateChanged = struct {
    permission_state: session_permission_state.State,

    fn deinit(self: *PermissionStateChanged, alloc: Allocator) void {
        self.permission_state.deinit(alloc);
        self.* = undefined;
    }
};

pub const WorkspaceRebound = struct {
    previous_workspace_root: []u8,
    workspace_root: []u8,

    fn deinit(self: *WorkspaceRebound, alloc: Allocator) void {
        alloc.free(self.previous_workspace_root);
        alloc.free(self.workspace_root);
        self.* = undefined;
    }
};

pub const RunMode = enum {
    new,
    resumed,
};

pub const RunStarted = struct {
    run_id: []u8,
    fiber_version: []u8,
    schema_version: u64 = 1,
    mode: RunMode,

    fn deinit(self: *RunStarted, alloc: Allocator) void {
        alloc.free(self.run_id);
        alloc.free(self.fiber_version);
        self.* = undefined;
    }
};

pub const EventError = struct {
    code: []u8,
    message: []u8,

    fn deinit(self: *EventError, alloc: Allocator) void {
        alloc.free(self.code);
        alloc.free(self.message);
        self.* = undefined;
    }
};

pub const RunCompleted = struct {
    run_id: []u8,
    exit_code: i64,
    final_text: ?[]u8 = null,
    model: ?[]u8 = null,
    @"error": ?EventError = null,

    fn deinit(self: *RunCompleted, alloc: Allocator) void {
        alloc.free(self.run_id);
        if (self.final_text) |text| alloc.free(text);
        if (self.model) |model| alloc.free(model);
        if (self.@"error") |*err| err.deinit(alloc);
        self.* = undefined;
    }
};

/// Single-variant today: every turn starts from user input. A wakeup shape
/// for job-driven turns arrives with the jobs work, not this slice.
pub const TurnInput = union(enum) {
    user: session.UserTurn,

    fn deinit(self: *TurnInput, alloc: Allocator) void {
        switch (self.*) {
            .user => |*user| session.freeUserTurn(alloc, user.*),
        }
        self.* = undefined;
    }
};

pub const TurnStarted = struct {
    input: TurnInput,
    /// Host's language snapshot after prompt admission. Additive and
    /// optional per the spec's versioning rules; the fold keeps prior
    /// state when absent.
    language: ?session.ConversationLanguage = null,

    fn deinit(self: *TurnStarted, alloc: Allocator) void {
        self.input.deinit(alloc);
        self.* = undefined;
    }
};

pub const TurnOutcome = enum {
    completed,
    interrupted,
    failed,
};

pub const TurnCompleted = struct {
    outcome: TurnOutcome,
    @"error": ?EventError = null,

    fn deinit(self: *TurnCompleted, alloc: Allocator) void {
        if (self.@"error") |*err| err.deinit(alloc);
        self.* = undefined;
    }
};

pub const AssistantMessageStarted = struct {};

pub const MessageOutcome = enum {
    completed,
    failed,
    interrupted,
};

pub const AssistantMessageCompleted = struct {
    text: []u8,
    outcome: MessageOutcome = .completed,
    cause: ?[]u8 = null,
    attempt: ?u64 = null,

    fn deinit(self: *AssistantMessageCompleted, alloc: Allocator) void {
        alloc.free(self.text);
        if (self.cause) |cause| alloc.free(cause);
        self.* = undefined;
    }
};

pub const ReasoningStarted = struct {};

pub const ReasoningCompleted = struct {
    text: []u8,

    fn deinit(self: *ReasoningCompleted, alloc: Allocator) void {
        alloc.free(self.text);
        self.* = undefined;
    }
};

pub const UsageRecorded = struct {
    generation_id: []u8,
    model: []u8,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64 = 0,
    cache_write_tokens: u64 = 0,
    reasoning_tokens: ?u64 = null,
    total_cost: ?f64 = null,
    billable_web_search_calls: u64 = 0,

    fn deinit(self: *UsageRecorded, alloc: Allocator) void {
        alloc.free(self.generation_id);
        alloc.free(self.model);
        self.* = undefined;
    }
};

/// Ephemeral per the spec: kept as taxonomy only, with no log sink until
/// the stdout stream that carries ephemeral lines lands with #195. It is
/// deliberately outside the durable Event union below, so no code path can
/// write or read one as a sequenced log line. A retry also writes its
/// failed message and its new item as durable assistant_message_* lines,
/// so no retry information is lost meanwhile.
pub const RetryScheduled = struct {
    cause: []u8,
    attempt: u64,
    delay_ms: u64,

    fn deinit(self: *RetryScheduled, alloc: Allocator) void {
        alloc.free(self.cause);
        self.* = undefined;
    }
};

/// Ephemeral per the spec: kept as taxonomy only, with no log sink until
/// #195, and deliberately outside the durable Event union for the same
/// reason. Failures outside any item keep reaching the UI directly.
pub const Notice = struct {
    code: []u8,
    message: []u8,

    fn deinit(self: *Notice, alloc: Allocator) void {
        alloc.free(self.code);
        alloc.free(self.message);
        self.* = undefined;
    }
};

/// Retired pre-inversion turn commit. Decode-only: old logs project their
/// turn through it; nothing writes it.
pub const HistoryTurnCommitted = struct {
    conversation_language: session.ConversationLanguage,
    last_input_tokens: ?u64 = null,
    last_output_tokens: ?u64 = null,
    work_id: ?[]u8 = null,
    turn: session.HistoryTurn,

    fn deinit(self: *HistoryTurnCommitted, alloc: Allocator) void {
        if (self.work_id) |id| alloc.free(id);
        session.freeHistoryTurn(alloc, self.turn);
        self.* = undefined;
    }
};

/// Retired whole-ledger usage snapshot. Decode-only: old logs restore
/// billing through it; per-call usage_recorded lines replaced it.
pub const UsageCheckpointed = struct {
    /// Full cumulative replacement; reducers must not add it to prior usage.
    usage: session_usage.Snapshot,

    fn deinit(self: *UsageCheckpointed, alloc: Allocator) void {
        self.usage.deinit(alloc);
        self.* = undefined;
    }
};

/// Borrowed runtime-to-host notes emitted as work happens. Hosts copy what
/// the log keeps via LoadedWritableSession.appendSessionNote.
pub const SessionNoteTurn = struct {
    turn_id: u64,
    prompt: []const u8,
    images: []const types.ImageAttachment = &.{},
    work_id: ?[]const u8 = null,
    /// Filled by the host from its language snapshot at admission.
    language: ?session.ConversationLanguage = null,
};

pub const SessionNoteItem = struct {
    turn_id: u64,
    item_id: []const u8,
};

pub const SessionNoteMessage = struct {
    turn_id: u64,
    item_id: []const u8,
    text: []const u8,
    outcome: MessageOutcome = .completed,
    cause: ?[]const u8 = null,
    attempt: ?u64 = null,
};

pub const SessionNoteReasoning = struct {
    turn_id: u64,
    item_id: []const u8,
    text: []const u8,
};

pub const SessionNote = union(enum) {
    turn_started: SessionNoteTurn,
    message_started: SessionNoteItem,
    message_completed: SessionNoteMessage,
    reasoning_started: SessionNoteItem,
    reasoning_completed: SessionNoteReasoning,
};

pub const RecoveryCheckpointSet = struct {
    checkpoint: session_codec.RecoveryCheckpoint,

    fn deinit(self: *RecoveryCheckpointSet, alloc: Allocator) void {
        self.checkpoint.deinit(alloc);
        self.* = undefined;
    }
};

pub const RecoveryCheckpointCleared = struct {};

pub const StateReplacementStarted = struct {
    replacement_id: Identifier,
    reason: ReplacementReason,
    encoded_bytes: u64,
    sha256: Digest,
    chunk_count: u64,
};

pub const StateReplacementChunk = struct {
    replacement_id: Identifier,
    chunk_index: u64,
    raw_bytes: u64,
    chunk_sha256: Digest,
    bytes: []u8,

    fn deinit(self: *StateReplacementChunk, alloc: Allocator) void {
        alloc.free(self.bytes);
        self.* = undefined;
    }
};

pub const StateReplacementCommitted = struct {
    replacement_id: Identifier,
    encoded_bytes: u64,
    sha256: Digest,
    chunk_count: u64,
};

pub const Event = union(Kind) {
    session_started: SessionStarted,
    preferences_changed: PreferencesChanged,
    permission_state_changed: PermissionStateChanged,
    workspace_rebound: WorkspaceRebound,
    run_started: RunStarted,
    run_completed: RunCompleted,
    turn_started: TurnStarted,
    turn_completed: TurnCompleted,
    assistant_message_started: AssistantMessageStarted,
    assistant_message_completed: AssistantMessageCompleted,
    reasoning_started: ReasoningStarted,
    reasoning_completed: ReasoningCompleted,
    usage_recorded: UsageRecorded,
    recovery_checkpoint_set: RecoveryCheckpointSet,
    recovery_checkpoint_cleared: RecoveryCheckpointCleared,
    state_replacement_started: StateReplacementStarted,
    state_replacement_chunk: StateReplacementChunk,
    state_replacement_committed: StateReplacementCommitted,
    history_turn_committed: HistoryTurnCommitted,
    usage_checkpointed: UsageCheckpointed,

    fn deinit(self: *Event, alloc: Allocator) void {
        switch (self.*) {
            .session_started => |*payload| payload.deinit(alloc),
            .preferences_changed => |*payload| payload.deinit(alloc),
            .permission_state_changed => |*payload| payload.deinit(alloc),
            .workspace_rebound => |*payload| payload.deinit(alloc),
            .run_started => |*payload| payload.deinit(alloc),
            .run_completed => |*payload| payload.deinit(alloc),
            .turn_started => |*payload| payload.deinit(alloc),
            .turn_completed => |*payload| payload.deinit(alloc),
            .assistant_message_started => {},
            .assistant_message_completed => |*payload| payload.deinit(alloc),
            .reasoning_started => {},
            .reasoning_completed => |*payload| payload.deinit(alloc),
            .usage_recorded => |*payload| payload.deinit(alloc),
            .history_turn_committed => |*payload| payload.deinit(alloc),
            .usage_checkpointed => |*payload| payload.deinit(alloc),
            .recovery_checkpoint_set => |*payload| payload.deinit(alloc),
            .recovery_checkpoint_cleared => {},
            .state_replacement_chunk => |*payload| payload.deinit(alloc),
            .state_replacement_started, .state_replacement_committed => {},
        }
        self.* = undefined;
    }
};

/// One session-log event with its v1 envelope.
///
/// Memory contract: an Envelope either borrows or owns its slices, never
/// both. Encode-side envelopes (built by callers, passed to `encodeFrame`,
/// `applyDelta`, or `validateEnvelope`) borrow: the caller keeps every
/// allocation and must never call `deinit`. Decode-side envelopes
/// (returned by `decodeFrame` or `readSessionStarted`) own: the caller
/// must call `deinit` exactly once. Moving an owned envelope out of a
/// guarded scope (e.g. `break :blk`) transfers ownership and disarms the
/// guard; holding two guards over one allocation double-frees.
pub const Envelope = struct {
    session_id: []u8,
    seq: u64,
    ts: i64,
    turn_id: ?[]u8 = null,
    item_id: ?[]u8 = null,
    event: Event,

    pub fn kind(self: Envelope) Kind {
        return std.meta.activeTag(self.event);
    }

    pub fn deinit(self: *Envelope, alloc: Allocator) void {
        alloc.free(self.session_id);
        if (self.turn_id) |turn| alloc.free(turn);
        if (self.item_id) |item| alloc.free(item);
        self.event.deinit(alloc);
        self.* = undefined;
    }
};

pub const SequenceValidator = struct {
    next_seq: u64 = 1,

    pub fn validate(self: *SequenceValidator, seq: u64) !void {
        if (seq != self.next_seq) return error.NonContiguousSequence;
        self.next_seq = std.math.add(u64, self.next_seq, 1) catch
            return error.NonContiguousSequence;
    }
};

/// Header of a well-formed v1 envelope whose kind this build does not
/// recognize. Reducers still validate its seq contiguity and session
/// binding, then skip its payload per spec section 9.
pub const UnknownHeader = struct {
    session_id: []u8,
    seq: u64,

    pub fn deinit(self: *UnknownHeader, alloc: Allocator) void {
        alloc.free(self.session_id);
        self.* = undefined;
    }
};

pub const Frame = union(enum) {
    known: Envelope,
    unknown: UnknownHeader,

    pub fn deinit(self: *Frame, alloc: Allocator) void {
        switch (self.*) {
            .known => |*envelope| envelope.deinit(alloc),
            .unknown => |*header| header.deinit(alloc),
        }
        self.* = undefined;
    }

    pub fn seq(self: Frame) u64 {
        return switch (self) {
            .known => |envelope| envelope.seq,
            .unknown => |header| header.seq,
        };
    }

    pub fn session_id(self: Frame) []const u8 {
        return switch (self) {
            .known => |envelope| envelope.session_id,
            .unknown => |header| header.session_id,
        };
    }
};

pub const ReplacementWriteOptions = struct {
    session_id: []const u8,
    first_seq: u64,
    replacement_id: Identifier,
    ts: i64,
    reason: ReplacementReason,
};

pub const ReplacementWriteSummary = struct {
    encoded_bytes: u64,
    sha256: Digest,
    chunk_count: u64,
    last_seq: u64,
};

pub const ReductionStart = struct {
    next_seq: u64 = 1,
};

pub const ReductionBoundary = struct {
    seq: u64,
    byte_offset: u64,
};

pub const Reduction = struct {
    state: session_codec.DurableSessionState,
    truncate_from: ?u64 = null,
    through: ?ReductionBoundary = null,
    bytes_consumed: u64 = 0,

    pub fn deinit(self: *Reduction, alloc: Allocator) void {
        self.state.deinit(alloc);
        self.* = undefined;
    }
};

/// Serializes a borrowed envelope; never takes ownership and never calls
/// `deinit`, so encode-side envelopes must not be deinitialized.
pub fn encodeFrame(alloc: Allocator, envelope: Envelope) ![]u8 {
    try validateEnvelope(envelope);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"schema_version\":1,\"kind\":");
    try writeJsonString(&out.writer, @tagName(envelope.kind()));
    try out.writer.writeAll(",\"session_id\":");
    try writeJsonString(&out.writer, envelope.session_id);
    try out.writer.print(",\"ts\":{d}", .{envelope.ts});
    if (envelope.turn_id) |turn_id| {
        try out.writer.writeAll(",\"turn_id\":");
        try writeJsonString(&out.writer, turn_id);
    }
    if (envelope.item_id) |item_id| {
        try out.writer.writeAll(",\"item_id\":");
        try writeJsonString(&out.writer, item_id);
    }
    try out.writer.print(",\"seq\":{d},\"payload\":", .{envelope.seq});
    try writePayload(&out.writer, envelope.event);
    try out.writer.writeAll("}\n");
    if (out.written().len > event_frame_max_bytes) return error.EventFrameTooLarge;
    return try out.toOwnedSlice();
}

inline fn failEnvelope(err: anytype) @TypeOf(err)!Envelope {
    return @errorCast(failEnvelopeDynamic(err));
}

noinline fn failEnvelopeDynamic(err: anyerror) anyerror!Envelope {
    return err;
}

test "session envelope failures preserve exact error types and identities" {
    const invalid = failEnvelope(error.InvalidEventFrame);
    try std.testing.expect(@TypeOf(invalid) == error{InvalidEventFrame}!Envelope);
    try std.testing.expectError(error.InvalidEventFrame, invalid);
    try std.testing.expectError(error.OutOfMemory, failEnvelope(error.OutOfMemory));
}

/// Decodes one v1 event line. Unknown envelope fields are ignored and an
/// unrecognized kind decodes to `.unknown` (reducers skip its payload but
/// still validate its seq and session); only malformed framing, missing
/// required keys, or a wrong schema_version fail.
pub fn decodeFrame(alloc: Allocator, line: []const u8) !Frame {
    if (line.len > event_frame_max_bytes) return error.EventFrameTooLarge;
    if (line.len == 0 or line[line.len - 1] != '\n') {
        return error.InvalidEventFrame;
    }
    if (std.mem.indexOfScalar(u8, line[0 .. line.len - 1], '\n') != null) {
        return error.InvalidEventFrame;
    }

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, line[0 .. line.len - 1], .{
        .parse_numbers = false,
    }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidEventFrame,
    };
    defer parsed.deinit();
    const root = try requireObject(parsed.value);
    for ([_][]const u8{
        "schema_version",
        "kind",
        "session_id",
        "ts",
        "seq",
        "payload",
    }) |key| {
        if (root.get(key) == null) {
            return error.InvalidEventFrame;
        }
    }
    if (try requireU64(root, "schema_version") != 1) return error.UnsupportedEventSchema;
    const kind_raw = try requireString(root, "kind");
    if (std.meta.stringToEnum(Kind, kind_raw)) |kind| {
        // Ownership of the duped id strings moves into the returned
        // envelope on success; the block-scoped errdefers below free them
        // only when a later step in this block fails, so a validation
        // failure cannot free them twice through both these guards and
        // the envelope deinit.
        var envelope = blk: {
            const session_id = try dupeString(alloc, root, "session_id");
            errdefer alloc.free(session_id);
            const turn_id = if (root.get("turn_id")) |_| try dupeString(alloc, root, "turn_id") else null;
            errdefer if (turn_id) |id| alloc.free(id);
            const item_id = if (root.get("item_id")) |_| try dupeString(alloc, root, "item_id") else null;
            errdefer if (item_id) |id| alloc.free(id);
            break :blk Envelope{
                .session_id = session_id,
                .seq = try requireU64(root, "seq"),
                .ts = try requireI64(root, "ts"),
                .turn_id = turn_id,
                .item_id = item_id,
                .event = try parsePayload(alloc, kind, root.get("payload") orelse return error.InvalidEventFrame),
            };
        };
        errdefer envelope.deinit(alloc);
        try validateEnvelope(envelope);
        return .{ .known = envelope };
    }
    var header = blk: {
        const session_id = try dupeString(alloc, root, "session_id");
        errdefer alloc.free(session_id);
        break :blk UnknownHeader{
            .session_id = session_id,
            .seq = try requireU64(root, "seq"),
        };
    };
    errdefer header.deinit(alloc);
    if (header.seq == 0 or header.session_id.len == 0) return error.InvalidEventFrame;
    return .{ .unknown = header };
}

pub fn writeStateReplacement(
    alloc: Allocator,
    writer: *std.Io.Writer,
    state: session_codec.DurableSessionState,
    options: ReplacementWriteOptions,
) !ReplacementWriteSummary {
    var discard_buffer: [4096]u8 = undefined;
    var discard = std.Io.Writer.Discarding.init(&discard_buffer);
    const state_summary = try session_codec.encodeState(state, &discard.writer);
    if (state_summary.encoded_bytes == 0) return error.InvalidReplacement;
    const chunk_count = std.math.divCeil(
        u64,
        state_summary.encoded_bytes,
        raw_state_chunk_bytes,
    ) catch return error.InvalidReplacement;

    const start = Envelope{
        .session_id = @constCast(options.session_id),
        .seq = options.first_seq,
        .ts = options.ts,
        .event = .{ .state_replacement_started = .{
            .replacement_id = options.replacement_id,
            .reason = options.reason,
            .encoded_bytes = state_summary.encoded_bytes,
            .sha256 = state_summary.sha256,
            .chunk_count = chunk_count,
        } },
    };
    const start_line = try encodeFrame(alloc, start);
    defer alloc.free(start_line);
    try writer.writeAll(start_line);

    var chunk_writer: ReplacementChunkWriter = undefined;
    try chunk_writer.init(alloc, writer, options, state_summary, chunk_count);
    defer chunk_writer.deinit();
    const second_summary = session_codec.encodeState(state, &chunk_writer.interface) catch |err| {
        return chunk_writer.failure orelse err;
    };
    chunk_writer.interface.flush() catch |err| return chunk_writer.failure orelse err;
    try chunk_writer.finish();
    if (second_summary.encoded_bytes != state_summary.encoded_bytes or
        !std.mem.eql(u8, &second_summary.sha256, &state_summary.sha256) or
        chunk_writer.chunk_index != chunk_count)
    {
        return error.InvalidReplacement;
    }

    const transaction_frame_count = std.math.add(u64, chunk_count, 1) catch
        return error.InvalidReplacement;
    const commit_seq = std.math.add(u64, options.first_seq, transaction_frame_count) catch
        return error.InvalidReplacement;
    const commit = Envelope{
        .session_id = @constCast(options.session_id),
        .seq = commit_seq,
        .ts = options.ts,
        .event = .{ .state_replacement_committed = .{
            .replacement_id = options.replacement_id,
            .encoded_bytes = state_summary.encoded_bytes,
            .sha256 = state_summary.sha256,
            .chunk_count = chunk_count,
        } },
    };
    const commit_line = try encodeFrame(alloc, commit);
    defer alloc.free(commit_line);
    try writer.writeAll(commit_line);

    return .{
        .encoded_bytes = state_summary.encoded_bytes,
        .sha256 = state_summary.sha256,
        .chunk_count = chunk_count,
        .last_seq = commit_seq,
    };
}

pub fn reduceJsonl(
    alloc: Allocator,
    source: *std.Io.Reader,
    initial: ?session_codec.DurableSessionState,
) !Reduction {
    return reduceJsonlFrom(alloc, source, initial, .{});
}

/// Applies one contiguous semantic event frame to caller-owned state.
/// On failure, `state` remains valid and unchanged.
pub fn applyEventFrame(
    alloc: Allocator,
    state: *session_codec.DurableSessionState,
    line: []const u8,
    start: ReductionStart,
    fold: *ItemFold,
) !ReductionBoundary {
    if (start.next_seq == 0) {
        return error.InvalidReductionStart;
    }
    const frame_bytes = std.math.cast(u64, line.len) orelse
        return error.InvalidEventFrame;
    var frame = try decodeFrame(alloc, line);
    defer frame.deinit(alloc);
    var validator = SequenceValidator{
        .next_seq = start.next_seq,
    };
    try validator.validate(frame.seq());
    if (!std.mem.eql(u8, frame.session_id(), state.id)) {
        return error.SessionMismatch;
    }
    switch (frame) {
        .known => |envelope| {
            if (envelope.kind() == .session_started or
                envelope.kind() == .state_replacement_started or
                envelope.kind() == .state_replacement_chunk or
                envelope.kind() == .state_replacement_committed)
            {
                return error.InvalidEventFrame;
            }
            var current: ?session_codec.DurableSessionState = state.*;
            try applyDelta(alloc, &current, envelope, fold);
            state.* = current.?;
        },
        .unknown => {},
    }
    return .{ .seq = frame.seq(), .byte_offset = frame_bytes };
}

inline fn failReduction(err: anytype) @TypeOf(err)!Reduction {
    return @errorCast(failReductionDynamic(err));
}

noinline fn failReductionDynamic(err: anyerror) anyerror!Reduction {
    return err;
}

test "session event reduction failures preserve exact error types and identities" {
    const invalid = failReduction(error.InvalidReductionStart);
    try std.testing.expect(
        @TypeOf(invalid) == error{InvalidReductionStart}!Reduction,
    );
    try std.testing.expectError(error.InvalidReductionStart, invalid);
    try std.testing.expectError(error.MissingSessionStarted, failReduction(error.MissingSessionStarted));
}

pub fn reduceJsonlFrom(
    alloc: Allocator,
    source: *std.Io.Reader,
    initial: ?session_codec.DurableSessionState,
    start: ReductionStart,
) !Reduction {
    var state = initial;
    errdefer if (state) |*owned| owned.deinit(alloc);
    if (start.next_seq == 0 or
        (state == null and start.next_seq != 1))
    {
        return failReduction(error.InvalidReductionStart);
    }
    // The session is established by the caller's state when resuming, or
    // by the first line when starting fresh. Every later line must name
    // it; a foreign-session line fails loudly instead of mutating state.
    var established: ?[]u8 = if (state) |*s| try alloc.dupe(u8, s.id) else null;
    defer if (established) |id| alloc.free(id);
    var validator = SequenceValidator{
        .next_seq = start.next_seq,
    };
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    // Resuming from owned state: its usage already contains every folded
    // generation, so tail usage_recorded lines add onto it.
    if (state) |*initial_state| {
        if (initial_state.usage) |snapshot| try fold.seedUsageBase(alloc, snapshot);
    }
    var byte_offset: u64 = 0;
    var through: ?ReductionBoundary = null;

    while (true) {
        const line = readFrameLine(alloc, source) catch |err| switch (err) {
            error.EndOfStream => break,
            else => return err,
        };
        defer alloc.free(line);
        const frame_start = byte_offset;
        byte_offset += line.len;

        var frame = try decodeFrame(alloc, line);
        defer frame.deinit(alloc);
        try validator.validate(frame.seq());
        if (established) |known| {
            if (!std.mem.eql(u8, frame.session_id(), known)) {
                return failReduction(error.SessionMismatch);
            }
        } else {
            established = try alloc.dupe(u8, frame.session_id());
        }
        const envelope = switch (frame) {
            .known => |known| known,
            .unknown => {
                through = .{ .seq = frame.seq(), .byte_offset = byte_offset };
                continue;
            },
        };

        if (envelope.kind() == .state_replacement_started) {
            if (state == null) return failReduction(error.InvalidReplacement);
            const replacement = try reduceReplacement(
                alloc,
                source,
                &validator,
                &byte_offset,
                envelope,
                state.?,
            );
            if (replacement.state) |next| {
                state.?.deinit(alloc);
                state = next;
                through = replacement.through;
            } else {
                return .{
                    .state = state.?,
                    .truncate_from = frame_start,
                    .through = through,
                    .bytes_consumed = byte_offset,
                };
            }
            continue;
        }
        if (envelope.kind() == .state_replacement_chunk or
            envelope.kind() == .state_replacement_committed)
        {
            return failReduction(error.InvalidReplacement);
        }
        try applyDelta(alloc, &state, envelope, &fold);
        through = reductionBoundary(envelope, byte_offset);
    }

    return .{
        .state = state orelse return failReduction(error.MissingSessionStarted),
        .through = through,
        .bytes_consumed = byte_offset,
    };
}

const ReplacementChunkWriter = struct {
    alloc: Allocator,
    destination: *std.Io.Writer,
    options: ReplacementWriteOptions,
    state_summary: session_codec.EncodeSummary,
    expected_chunk_count: u64,
    raw: []u8,
    raw_len: usize = 0,
    chunk_index: u64 = 0,
    interface_buffer: [4096]u8 = undefined,
    interface: std.Io.Writer = undefined,
    failure: ?anyerror = null,

    fn init(
        self: *ReplacementChunkWriter,
        alloc: Allocator,
        destination: *std.Io.Writer,
        options: ReplacementWriteOptions,
        state_summary: session_codec.EncodeSummary,
        expected_chunk_count: u64,
    ) !void {
        self.* = .{
            .alloc = alloc,
            .destination = destination,
            .options = options,
            .state_summary = state_summary,
            .expected_chunk_count = expected_chunk_count,
            .raw = try alloc.alloc(u8, raw_state_chunk_bytes),
        };
        self.interface = .{
            .vtable = &.{ .drain = drain },
            .buffer = &self.interface_buffer,
            .end = 0,
        };
    }

    fn deinit(self: *ReplacementChunkWriter) void {
        self.alloc.free(self.raw);
        self.* = undefined;
    }

    fn drain(
        writer: *std.Io.Writer,
        data: []const []const u8,
        splat: usize,
    ) std.Io.Writer.Error!usize {
        const self: *ReplacementChunkWriter = @alignCast(@fieldParentPtr("interface", writer));
        var consumed: usize = 0;
        if (writer.end > 0) {
            self.consume(writer.buffer[0..writer.end]) catch |err| {
                self.failure = err;
                return error.WriteFailed;
            };
            writer.end = 0;
        }
        for (data, 0..) |part, index| {
            const repeat = if (index == data.len - 1) splat else 1;
            for (0..repeat) |_| {
                self.consume(part) catch |err| {
                    self.failure = err;
                    return error.WriteFailed;
                };
                consumed += part.len;
            }
        }
        return consumed;
    }

    fn consume(self: *ReplacementChunkWriter, bytes: []const u8) !void {
        var remaining = bytes;
        while (remaining.len > 0) {
            const count = @min(remaining.len, self.raw.len - self.raw_len);
            @memcpy(self.raw[self.raw_len..][0..count], remaining[0..count]);
            self.raw_len += count;
            remaining = remaining[count..];
            if (self.raw_len == self.raw.len) try self.emitChunk();
        }
    }

    fn finish(self: *ReplacementChunkWriter) !void {
        if (self.raw_len > 0) try self.emitChunk();
    }

    fn emitChunk(self: *ReplacementChunkWriter) !void {
        if (self.chunk_index >= self.expected_chunk_count or self.raw_len == 0) {
            return error.InvalidReplacement;
        }
        const chunk = self.raw[0..self.raw_len];
        const envelope = Envelope{
            .session_id = @constCast(self.options.session_id),
            .seq = std.math.add(u64, self.options.first_seq, self.chunk_index + 1) catch
                return error.InvalidReplacement,
            .ts = self.options.ts,
            .event = .{ .state_replacement_chunk = .{
                .replacement_id = self.options.replacement_id,
                .chunk_index = self.chunk_index,
                .raw_bytes = chunk.len,
                .chunk_sha256 = sha256(chunk),
                .bytes = chunk,
            } },
        };
        const line = try encodeFrame(self.alloc, envelope);
        defer self.alloc.free(line);
        try self.destination.writeAll(line);
        self.chunk_index += 1;
        self.raw_len = 0;
    }
};

const ReplacementOutcome = struct {
    state: ?session_codec.DurableSessionState,
    through: ?ReductionBoundary = null,
};

fn reduceReplacement(
    alloc: Allocator,
    source: *std.Io.Reader,
    validator: *SequenceValidator,
    byte_offset: *u64,
    start_envelope: Envelope,
    prior: session_codec.DurableSessionState,
) !ReplacementOutcome {
    const start = start_envelope.event.state_replacement_started;
    var chunk_reader: ReplacementStateReader = undefined;
    try chunk_reader.init(
        alloc,
        source,
        validator,
        byte_offset,
        start,
    );
    defer chunk_reader.deinit();

    var decoded = session_codec.decodeState(alloc, &chunk_reader.interface, .{}) catch |err| {
        if (chunk_reader.truncated) return .{ .state = null };
        if (chunk_reader.failure) |failure| return failure;
        return err;
    };
    errdefer decoded.deinit(alloc);
    try chunk_reader.finish();

    const commit_line = readFrameLine(alloc, source) catch |err| switch (err) {
        error.EndOfStream, error.TruncatedEventFrame => {
            decoded.deinit(alloc);
            return .{ .state = null };
        },
        else => return err,
    };
    defer alloc.free(commit_line);
    byte_offset.* += commit_line.len;
    var commit_frame = try decodeFrame(alloc, commit_line);
    defer commit_frame.deinit(alloc);
    try validator.validate(commit_frame.seq());
    const commit_envelope = switch (commit_frame) {
        .known => |*envelope| envelope,
        // A foreign line inside a replacement transaction is corruption,
        // not a skippable additive kind: chunks and commit are bound to
        // the (session-checked) start line by replacement_id.
        .unknown => return error.InvalidReplacement,
    };
    if (commit_envelope.kind() != .state_replacement_committed) return error.InvalidReplacement;
    const commit = commit_envelope.event.state_replacement_committed;
    if (!std.mem.eql(u8, &commit.replacement_id, &start.replacement_id) or
        commit.encoded_bytes != start.encoded_bytes or
        commit.chunk_count != start.chunk_count or
        !std.mem.eql(u8, &commit.sha256, &start.sha256))
    {
        return error.InvalidReplacement;
    }

    if (!std.mem.eql(u8, decoded.id, prior.id) or
        decoded.created_at_ms != prior.created_at_ms or
        !std.mem.eql(u8, decoded.origin_workspace_root, prior.origin_workspace_root) or
        !std.mem.eql(u8, decoded.workspace_root, prior.workspace_root) or
        decoded.updated_at_ms != commit_envelope.ts)
    {
        return error.ImmutableSessionIdentity;
    }
    if (start.reason == .log_compaction and
        commit_envelope.ts != prior.updated_at_ms)
    {
        return error.InvalidReplacement;
    }
    return .{
        .state = decoded,
        .through = reductionBoundary(commit_envelope.*, byte_offset.*),
    };
}

fn reductionBoundary(envelope: Envelope, byte_offset: u64) ReductionBoundary {
    return .{
        .seq = envelope.seq,
        .byte_offset = byte_offset,
    };
}

const ReplacementStateReader = struct {
    alloc: Allocator,
    source: *std.Io.Reader,
    validator: *SequenceValidator,
    byte_offset: *u64,
    start: StateReplacementStarted,
    chunk_index: u64 = 0,
    raw_total: u64 = 0,
    overall_sha256: Sha256 = Sha256.init(.{}),
    current: ?Envelope = null,
    current_offset: usize = 0,
    truncated: bool = false,
    failure: ?anyerror = null,
    buffer: [4096]u8 = undefined,
    interface: std.Io.Reader = undefined,

    fn init(
        self: *ReplacementStateReader,
        alloc: Allocator,
        source: *std.Io.Reader,
        validator: *SequenceValidator,
        byte_offset: *u64,
        start: StateReplacementStarted,
    ) !void {
        if (start.encoded_bytes == 0 or start.chunk_count == 0 or
            start.chunk_count != std.math.divCeil(
                u64,
                start.encoded_bytes,
                raw_state_chunk_bytes,
            ) catch return error.InvalidReplacement)
        {
            return error.InvalidReplacement;
        }
        self.* = .{
            .alloc = alloc,
            .source = source,
            .validator = validator,
            .byte_offset = byte_offset,
            .start = start,
        };
        self.interface = .{
            .vtable = &.{
                .stream = stream,
                .readVec = readVec,
            },
            .buffer = &self.buffer,
            .seek = 0,
            .end = 0,
        };
    }

    fn deinit(self: *ReplacementStateReader) void {
        if (self.current) |*envelope| envelope.deinit(self.alloc);
        self.* = undefined;
    }

    fn finish(self: *ReplacementStateReader) !void {
        if (self.chunk_index != self.start.chunk_count or
            self.raw_total != self.start.encoded_bytes or
            !std.mem.eql(u8, &self.overall_sha256.finalResult(), &self.start.sha256))
        {
            return error.InvalidReplacement;
        }
    }

    fn readVec(reader: *std.Io.Reader, destinations: [][]u8) std.Io.Reader.Error!usize {
        const self: *ReplacementStateReader = @alignCast(@fieldParentPtr("interface", reader));
        for (destinations) |destination| {
            if (destination.len == 0) continue;
            return self.copyInto(destination) catch |err| {
                if (err == error.EndOfStream) return error.EndOfStream;
                self.failure = err;
                return error.ReadFailed;
            };
        }
        const destination = reader.buffer[reader.end..];
        if (destination.len == 0) return 0;
        const count = self.copyInto(destination) catch |err| {
            if (err == error.EndOfStream) return error.EndOfStream;
            self.failure = err;
            return error.ReadFailed;
        };
        reader.end += count;
        return 0;
    }

    fn copyInto(self: *ReplacementStateReader, destination: []u8) !usize {
        if (self.currentBytes().len == 0) try self.loadChunk();
        const available = self.currentBytes();
        const count = @min(destination.len, available.len);
        @memcpy(destination[0..count], available[0..count]);
        self.current_offset += count;
        return count;
    }

    fn stream(
        reader: *std.Io.Reader,
        writer: *std.Io.Writer,
        limit: std.Io.Limit,
    ) std.Io.Reader.StreamError!usize {
        const destination = limit.slice(try writer.writableSliceGreedy(1));
        var destinations = [1][]u8{destination};
        const count = readVec(reader, &destinations) catch |err| switch (err) {
            error.EndOfStream => return error.EndOfStream,
            error.ReadFailed => return error.ReadFailed,
        };
        writer.advance(count);
        return count;
    }

    fn currentBytes(self: *ReplacementStateReader) []const u8 {
        const envelope = self.current orelse return &.{};
        const bytes = envelope.event.state_replacement_chunk.bytes;
        return bytes[self.current_offset..];
    }

    fn loadChunk(self: *ReplacementStateReader) !void {
        if (self.current) |*envelope| {
            envelope.deinit(self.alloc);
            self.current = null;
        }
        self.current_offset = 0;
        if (self.chunk_index == self.start.chunk_count) return error.EndOfStream;

        const line = readFrameLine(self.alloc, self.source) catch |err| switch (err) {
            error.EndOfStream, error.TruncatedEventFrame => {
                self.truncated = true;
                return error.EndOfStream;
            },
            else => return err,
        };
        defer self.alloc.free(line);
        self.byte_offset.* += line.len;
        var frame = try decodeFrame(self.alloc, line);
        errdefer frame.deinit(self.alloc);
        try self.validator.validate(frame.seq());
        const envelope = switch (frame) {
            .known => |*known| known,
            .unknown => return error.InvalidReplacement,
        };
        if (envelope.kind() != .state_replacement_chunk) {
            return error.InvalidReplacement;
        }
        const chunk = envelope.event.state_replacement_chunk;
        const final = self.chunk_index + 1 == self.start.chunk_count;
        const expected_raw: u64 = if (final)
            self.start.encoded_bytes - self.raw_total
        else
            raw_state_chunk_bytes;
        if (!std.mem.eql(u8, &chunk.replacement_id, &self.start.replacement_id) or
            chunk.chunk_index != self.chunk_index or
            chunk.raw_bytes != expected_raw or
            chunk.bytes.len != expected_raw or
            (!final and chunk.raw_bytes != raw_state_chunk_bytes) or
            (final and (chunk.raw_bytes == 0 or chunk.raw_bytes > raw_state_chunk_bytes)) or
            !std.mem.eql(u8, &sha256(chunk.bytes), &chunk.chunk_sha256))
        {
            return error.InvalidReplacement;
        }
        self.overall_sha256.update(chunk.bytes);
        self.raw_total += chunk.raw_bytes;
        self.chunk_index += 1;
        self.current = envelope.*;
    }
};

/// Rebuilds the session usage from the fold through the single
/// session-usage-owned entry point, so the reducer never reaches into
/// ledger internals. Usage errors surface as invalid frames like before.
fn rebuildUsageSnapshot(
    alloc: Allocator,
    current: *session_codec.DurableSessionState,
    fold: *ItemFold,
) !void {
    var snapshot = session_usage.snapshotFromFold(
        alloc,
        fold.base_usage,
        fold.generations.items,
    ) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.UsageOverflow => return error.InvalidEventFrame,
    };
    errdefer snapshot.deinit(alloc);
    if (current.usage) |*old| old.deinit(alloc);
    current.usage = snapshot;
}

/// Fold-scoped accumulation for per-item lines, owned by the refold loop or
/// the live session and never snapshotted. The pending turn's history
/// skeleton is appended to state.history at turn_started, so a torn log
/// still folds to a well-formed trailing entry; this struct only tracks which
/// entry is open, the message started but not yet completed, the current
/// step's reasoning ids, per-turn token counters, the per-generation usage
/// map that lets a late-settled cost replace its first line, and the
/// resume-seeded usage base that earlier generations folded into.
pub const ItemFold = struct {
    pending_turn_id: ?[]u8 = null,
    pending_history_index: usize = 0,
    open_message_id: ?[]u8 = null,
    step_reasoning_ids: std.ArrayList([]u8) = .empty,
    last_message_outcome: ?MessageOutcome = null,
    generations: std.ArrayList(session_usage.FoldGeneration) = .empty,
    /// Billing already folded before this reduction (the resumed state's
    /// usage). New usage_recorded lines add on top instead of replacing it.
    base_usage: ?session_usage.Snapshot = null,

    pub fn deinit(self: *ItemFold, alloc: Allocator) void {
        self.closePending(alloc);
        for (self.generations.items) |*entry| entry.deinit(alloc);
        self.generations.deinit(alloc);
        if (self.base_usage) |*usage| usage.deinit(alloc);
        self.* = undefined;
    }

    /// Seeds the billing base from resumed state. Later usage_recorded
    /// lines rebuild onto it, so pre-resume generations survive.
    pub fn seedUsageBase(self: *ItemFold, alloc: Allocator, usage: session_usage.Snapshot) !void {
        if (self.base_usage) |*old| old.deinit(alloc);
        self.base_usage = try session_usage.dupeSnapshotOwned(alloc, usage);
    }

    /// Reseeds the fold after a state replacement: the new state's usage
    /// already contains every folded generation, so the map restarts.
    /// Atomic: a failed reseed keeps the previous fold untouched.
    pub fn reseedUsageBase(self: *ItemFold, alloc: Allocator, usage: ?session_usage.Snapshot) !void {
        const fresh: ?session_usage.Snapshot = if (usage) |snapshot|
            try session_usage.dupeSnapshotOwned(alloc, snapshot)
        else
            null;
        for (self.generations.items) |*entry| entry.deinit(alloc);
        self.generations.clearRetainingCapacity();
        if (self.base_usage) |*old| old.deinit(alloc);
        self.base_usage = fresh;
    }

    fn closePending(self: *ItemFold, alloc: Allocator) void {
        if (self.pending_turn_id) |id| alloc.free(id);
        self.pending_turn_id = null;
        if (self.open_message_id) |id| alloc.free(id);
        self.open_message_id = null;
        for (self.step_reasoning_ids.items) |id| alloc.free(id);
        self.step_reasoning_ids.clearRetainingCapacity();
        self.last_message_outcome = null;
    }

    fn requireOpenTurn(self: *const ItemFold, envelope: Envelope) !void {
        const turn_id = envelope.turn_id orelse return error.InvalidEventFrame;
        const pending = self.pending_turn_id orelse return error.InvalidEventFrame;
        if (!std.mem.eql(u8, pending, turn_id)) return error.InvalidEventFrame;
    }
};

fn applyDelta(
    alloc: Allocator,
    state: *?session_codec.DurableSessionState,
    envelope: Envelope,
    fold: *ItemFold,
) !void {
    switch (envelope.event) {
        .session_started => |payload| {
            if (state.* != null) {
                return error.ImmutableSessionIdentity;
            }
            var next = session_codec.DurableSessionState{
                .id = try alloc.dupe(u8, payload.id),
                .origin_workspace_root = undefined,
                .workspace_root = undefined,
                .created_at_ms = payload.created_at_ms,
                .updated_at_ms = envelope.ts,
                .conversation_language = payload.conversation_language,
                .preferences = undefined,
                .history = &.{},
                .subagent_child = payload.subagent_child,
            };
            errdefer alloc.free(next.id);
            next.origin_workspace_root = try alloc.dupe(u8, payload.origin_workspace_root);
            errdefer alloc.free(next.origin_workspace_root);
            next.workspace_root = try alloc.dupe(u8, payload.workspace_root);
            errdefer alloc.free(next.workspace_root);
            next.preferences = try payload.preferences.dupe(alloc);
            errdefer next.preferences.deinit(alloc);
            next.usage = if (payload.usage) |snapshot|
                try session_usage.dupeSnapshotOwned(alloc, snapshot)
            else
                null;
            errdefer if (next.usage) |*usage| usage.deinit(alloc);
            // A synthesized opening usage already contains every generation,
            // so the first usage_recorded line adds onto it instead of
            // replacing it.
            if (next.usage) |snapshot| try fold.seedUsageBase(alloc, snapshot);
            try session_codec.validateState(next);
            state.* = next;
        },
        .preferences_changed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            var proposed = current.*;
            if (payload.provider) |provider| proposed.preferences.provider = provider;
            if (payload.model) |model| proposed.preferences.model = model;
            if (payload.effort) |effort| proposed.preferences.effort = effort;
            if (payload.fast_mode) |fast_mode| proposed.preferences.fast_mode = fast_mode;
            proposed.updated_at_ms = envelope.ts;
            try session_codec.validateState(proposed);
            const model_copy = if (payload.model) |model|
                try alloc.dupe(u8, model)
            else
                null;
            if (model_copy) |copy| {
                alloc.free(current.preferences.model);
                current.preferences.model = copy;
            }
            if (payload.provider) |provider| current.preferences.provider = provider;
            if (payload.effort) |effort| current.preferences.effort = effort;
            if (payload.fast_mode) |fast_mode| current.preferences.fast_mode = fast_mode;
            current.updated_at_ms = envelope.ts;
        },
        .permission_state_changed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            var proposed = current.*;
            proposed.permission_state = payload.permission_state;
            proposed.updated_at_ms = envelope.ts;
            try session_codec.validateState(proposed);
            const next = try session_permission_state.dupe(alloc, payload.permission_state);
            current.permission_state.deinit(alloc);
            current.permission_state = next;
            current.updated_at_ms = envelope.ts;
        },
        .workspace_rebound => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            if (!std.mem.eql(u8, payload.previous_workspace_root, current.workspace_root) or
                std.mem.eql(u8, payload.workspace_root, current.workspace_root))
            {
                return error.ImmutableSessionIdentity;
            }
            var proposed = current.*;
            proposed.workspace_root = payload.workspace_root;
            proposed.updated_at_ms = envelope.ts;
            try session_codec.validateState(proposed);
            const copy = try alloc.dupe(u8, payload.workspace_root);
            alloc.free(current.workspace_root);
            current.workspace_root = copy;
            current.updated_at_ms = envelope.ts;
        },
        .run_started => {
            var current = &(state.* orelse return error.MissingSessionStarted);
            current.updated_at_ms = envelope.ts;
        },
        .run_completed => {
            var current = &(state.* orelse return error.MissingSessionStarted);
            current.updated_at_ms = envelope.ts;
        },
        .turn_started => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const turn_id = envelope.turn_id orelse return error.InvalidEventFrame;
            // A recovery re-note repeats the open turn's boundary: the log
            // already holds it, so the fold holds its skeleton instead of
            // appending a ghost. Started lines stay idempotent like the
            // message_started repeat below.
            if (fold.pending_turn_id) |pending| {
                if (std.mem.eql(u8, pending, turn_id)) {
                    current.updated_at_ms = envelope.ts;
                    return;
                }
            }
            // A new turn closes whatever was open: a torn log's unterminated
            // skeleton already sits in history as the crash left it.
            fold.closePending(alloc);
            const user_turn = switch (payload.input) {
                .user => |user| try session.dupeUserTurn(alloc, user),
            };
            errdefer session.freeUserTurn(alloc, user_turn);
            const assistant_text = try alloc.dupe(u8, "");
            errdefer alloc.free(assistant_text);
            const owned_turn_id = try alloc.dupe(u8, turn_id);
            errdefer alloc.free(owned_turn_id);
            const turn_work_id = switch (payload.input) {
                .user => |user| user.work_id,
            };
            const owned_work_id = if (turn_work_id) |id| try alloc.dupe(u8, id) else null;
            errdefer if (owned_work_id) |id| alloc.free(id);
            const skeleton: session.HistoryTurn = .{ .assistant = .{
                .user = user_turn,
                .assistant = assistant_text,
            } };
            if (current.history.len == 0) {
                current.history = try alloc.alloc(session.HistoryTurn, 1);
            } else {
                current.history = try alloc.realloc(current.history, current.history.len + 1);
            }
            current.history[current.history.len - 1] = skeleton;
            fold.pending_turn_id = owned_turn_id;
            fold.pending_history_index = current.history.len - 1;
            if (owned_work_id) |id| {
                if (current.last_subagent_work_id) |old| alloc.free(old);
                current.last_subagent_work_id = id;
            }
            if (payload.language) |language| current.conversation_language = language;
            current.updated_at_ms = envelope.ts;
        },
        .turn_completed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            try fold.requireOpenTurn(envelope);
            if (fold.open_message_id != null) return error.InvalidEventFrame;
            if (fold.pending_history_index >= current.history.len) return error.InvalidEventFrame;
            const skeleton = &current.history[fold.pending_history_index];
            const entry = switch (skeleton.*) {
                .assistant => |*assistant| assistant,
                else => return error.InvalidEventFrame,
            };
            // A failed turn keeps its assistant shape when its messages ran
            // clean (length limits, failure notices); only a failed or
            // interrupted message converts it, matching the old commit.
            // In-flight tool extras are #191's tool_call_* lines, so the
            // converted turn carries none: checkpoints keep them until then.
            const converts = payload.outcome == .interrupted or
                (payload.outcome == .failed and fold.last_message_outcome != null and
                    fold.last_message_outcome.? != .completed);
            if (converts) {
                // Ownership moves field by field into the new variant; no
                // fallible work remains, so no rollback is needed.
                const user = entry.user;
                const text = entry.assistant;
                const assistant_item_id = entry.assistant_item_id;
                const reasoning_item_ids = entry.reasoning_item_ids;
                const execution = entry.execution;
                entry.* = undefined;
                const partial: ?[]u8 = if (text.len == 0) blk: {
                    alloc.free(text);
                    break :blk null;
                } else text;
                skeleton.* = .{ .interrupted = .{
                    .user = user,
                    .assistant = partial,
                    .assistant_item_id = assistant_item_id,
                    .reasoning_item_ids = reasoning_item_ids,
                    .execution = execution,
                    .terminal_reason = if (payload.outcome == .failed) .failed else .cancelled,
                } };
            }
            // A session owns at most one active model turn. Clearing its
            // checkpoint in the same reduction as the turn completion closes
            // the crash window between durable completion and a later clear.
            if (current.recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
            current.recovery_checkpoint = null;
            fold.closePending(alloc);
            current.updated_at_ms = envelope.ts;
        },
        .assistant_message_started => {
            _ = &(state.* orelse return error.MissingSessionStarted);
            const item_id = envelope.item_id orelse return error.InvalidEventFrame;
            try fold.requireOpenTurn(envelope);
            // Started lines are idempotent: the stream emits one as work
            // happens and the terminal repeats it, so a repeat of the open
            // id is a no-op while a different id means overlap.
            if (fold.open_message_id) |open| {
                if (!std.mem.eql(u8, open, item_id)) return error.InvalidEventFrame;
            } else {
                fold.open_message_id = try alloc.dupe(u8, item_id);
            }
        },
        .assistant_message_completed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const item_id = envelope.item_id orelse return error.InvalidEventFrame;
            try fold.requireOpenTurn(envelope);
            const open = fold.open_message_id orelse return error.InvalidEventFrame;
            if (!std.mem.eql(u8, open, item_id)) return error.InvalidEventFrame;
            if (fold.pending_history_index >= current.history.len) return error.InvalidEventFrame;
            const skeleton = &current.history[fold.pending_history_index];
            const entry = switch (skeleton.*) {
                .assistant => |*assistant| assistant,
                else => return error.InvalidEventFrame,
            };
            // Last completed message wins, matching the old commit which
            // persisted only the turn's final text.
            const owned_text = try alloc.dupe(u8, payload.text);
            errdefer alloc.free(owned_text);
            const owned_item_id = try alloc.dupe(u8, item_id);
            errdefer alloc.free(owned_item_id);
            const owned_reasoning = try fold.step_reasoning_ids.toOwnedSlice(alloc);
            errdefer {
                for (owned_reasoning) |id| alloc.free(id);
                alloc.free(owned_reasoning);
            }
            alloc.free(entry.assistant);
            entry.assistant = owned_text;
            if (entry.assistant_item_id) |old| alloc.free(old);
            entry.assistant_item_id = owned_item_id;
            types.freeItemIdSlice(alloc, entry.reasoning_item_ids);
            entry.reasoning_item_ids = owned_reasoning;
            alloc.free(fold.open_message_id.?);
            fold.open_message_id = null;
            fold.last_message_outcome = payload.outcome;
            current.updated_at_ms = envelope.ts;
        },
        .reasoning_started => {
            _ = &(state.* orelse return error.MissingSessionStarted);
            _ = envelope.item_id orelse return error.InvalidEventFrame;
            try fold.requireOpenTurn(envelope);
        },
        .reasoning_completed => |payload| {
            _ = payload;
            var current = &(state.* orelse return error.MissingSessionStarted);
            const item_id = envelope.item_id orelse return error.InvalidEventFrame;
            try fold.requireOpenTurn(envelope);
            // Reasoning text is retained durably in the log for #298's
            // exact-match replay; the projected turn keeps only the block
            // ids, which land on the turn with its message. A retried block
            // resumes under its id, so dedupe repeats.
            const known = for (fold.step_reasoning_ids.items) |known| {
                if (std.mem.eql(u8, known, item_id)) break true;
            } else false;
            if (!known) {
                const owned = try alloc.dupe(u8, item_id);
                errdefer alloc.free(owned);
                try fold.step_reasoning_ids.append(alloc, owned);
            }
            current.updated_at_ms = envelope.ts;
        },
        .usage_recorded => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const existing = for (fold.generations.items) |*entry| {
                if (std.mem.eql(u8, entry.id, payload.generation_id)) break entry;
            } else null;
            if (existing) |entry| {
                // A late-settled cost replaces its first line.
                if (!std.mem.eql(u8, entry.model, payload.model)) {
                    const owned_model = try alloc.dupe(u8, payload.model);
                    errdefer alloc.free(owned_model);
                    alloc.free(entry.model);
                    entry.model = owned_model;
                }
                entry.input_tokens = payload.input_tokens;
                entry.output_tokens = payload.output_tokens;
                entry.cache_read_tokens = payload.cache_read_tokens;
                entry.cache_write_tokens = payload.cache_write_tokens;
                entry.reasoning_tokens = payload.reasoning_tokens;
                entry.total_cost = payload.total_cost;
                entry.billable_web_search_calls = payload.billable_web_search_calls;
            } else {
                const owned_id = try alloc.dupe(u8, payload.generation_id);
                errdefer alloc.free(owned_id);
                const owned_model = try alloc.dupe(u8, payload.model);
                errdefer alloc.free(owned_model);
                // Generation order, not log position: the ledger's own
                // counters sit outside the contract, so the fold numbers
                // generations in first-seen order like a fresh ledger.
                const generation_seq: u64 = @intCast(fold.generations.items.len + 1);
                try fold.generations.append(alloc, .{
                    .id = owned_id,
                    .model = owned_model,
                    .input_tokens = payload.input_tokens,
                    .output_tokens = payload.output_tokens,
                    .cache_read_tokens = payload.cache_read_tokens,
                    .cache_write_tokens = payload.cache_write_tokens,
                    .reasoning_tokens = payload.reasoning_tokens,
                    .total_cost = payload.total_cost,
                    .billable_web_search_calls = payload.billable_web_search_calls,
                    .first_seq = generation_seq,
                });
            }
            try rebuildUsageSnapshot(alloc, current, fold);
            // Last-response counters track the latest call in the open turn,
            // overwriting like the old per-completion report: gateway input
            // tokens bill full prompt occupancy, not a delta, so summing
            // would over-count. Usage outside a turn leaves them alone.
            if (fold.pending_turn_id != null) {
                current.last_input_tokens = payload.input_tokens;
                current.last_output_tokens = payload.output_tokens;
            }
            current.updated_at_ms = envelope.ts;
        },
        .history_turn_committed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const association = session.decideWorkIdAssociation(
                payload.turn,
                payload.work_id,
            ) catch return error.InvalidEventFrame;
            var turn = try session.dupeHistoryTurn(alloc, payload.turn);
            errdefer session.freeHistoryTurn(alloc, turn);
            if (association == .copy_event) {
                session.copyWorkIdToTurn(alloc, &turn, payload.work_id.?) catch |err| switch (err) {
                    error.OutOfMemory => return error.OutOfMemory,
                    error.InvalidWorkId, error.ConflictingWorkId => return error.InvalidEventFrame,
                };
            }
            const work_id = if (payload.work_id) |id| try alloc.dupe(u8, id) else null;
            errdefer if (work_id) |id| alloc.free(id);
            if (current.history.len == 0) {
                current.history = try alloc.alloc(session.HistoryTurn, 1);
            } else {
                current.history = try alloc.realloc(current.history, current.history.len + 1);
            }
            current.history[current.history.len - 1] = turn;
            current.conversation_language = payload.conversation_language;
            current.last_input_tokens = payload.last_input_tokens;
            current.last_output_tokens = payload.last_output_tokens;
            if (work_id) |id| {
                if (current.last_subagent_work_id) |old| alloc.free(old);
                current.last_subagent_work_id = id;
            }
            // A session owns at most one active model turn. Clearing its
            // checkpoint in the same reduction as the history commit closes
            // the crash window between durable completion and a later clear.
            if (current.recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
            current.recovery_checkpoint = null;
            current.updated_at_ms = envelope.ts;
        },
        .usage_checkpointed => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const usage = try session_usage.dupeSnapshotOwned(alloc, payload.usage);
            if (current.usage) |*old| old.deinit(alloc);
            current.usage = usage;
            // A restored whole-ledger snapshot already contains every
            // generation, so the per-item map restarts on top of it.
            try fold.reseedUsageBase(alloc, usage);
            current.updated_at_ms = envelope.ts;
        },
        .recovery_checkpoint_set => |payload| {
            var current = &(state.* orelse return error.MissingSessionStarted);
            const checkpoint = try payload.checkpoint.dupe(alloc);
            if (current.recovery_checkpoint) |*old| old.deinit(alloc);
            current.recovery_checkpoint = checkpoint;
            current.updated_at_ms = envelope.ts;
        },
        .recovery_checkpoint_cleared => {
            var current = &(state.* orelse return error.MissingSessionStarted);
            if (current.recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
            current.recovery_checkpoint = null;
            current.updated_at_ms = envelope.ts;
        },
        .state_replacement_started, .state_replacement_chunk, .state_replacement_committed => {
            return error.InvalidReplacement;
        },
    }
}

fn validateEnvelope(envelope: Envelope) !void {
    if (envelope.seq == 0 or envelope.ts < 0) return error.InvalidEventFrame;
    if (envelope.session_id.len == 0) return error.InvalidEventFrame;
    if (envelope.turn_id) |turn_id| {
        if (turn_id.len == 0) return error.InvalidEventFrame;
    }
    if (envelope.item_id) |item_id| {
        if (item_id.len == 0) return error.InvalidEventFrame;
    }
    switch (envelope.event) {
        .session_started => |payload| {
            if (!std.mem.eql(u8, envelope.session_id, payload.id)) {
                return error.InvalidEventFrame;
            }
            const state = session_codec.DurableSessionState{
                .id = payload.id,
                .origin_workspace_root = payload.origin_workspace_root,
                .workspace_root = payload.workspace_root,
                .created_at_ms = payload.created_at_ms,
                .updated_at_ms = envelope.ts,
                .conversation_language = payload.conversation_language,
                .preferences = payload.preferences,
                .history = &.{},
                .usage = payload.usage,
                .subagent_child = payload.subagent_child,
            };
            try session_codec.validateState(state);
        },
        .preferences_changed => |payload| {
            if (payload.provider == null and payload.model == null and payload.effort == null and payload.fast_mode == null) {
                return error.InvalidEventFrame;
            }
            if (payload.model) |model| {
                const state = session_codec.DurableSessionState{
                    .id = @constCast("validation"),
                    .origin_workspace_root = @constCast("/"),
                    .workspace_root = @constCast("/"),
                    .created_at_ms = 0,
                    .updated_at_ms = 0,
                    .conversation_language = session.ConversationLanguage.literal("en"),
                    .preferences = .{
                        .model = model,
                        .effort = .auto,
                        .fast_mode = false,
                    },
                    .history = &.{},
                };
                try session_codec.validateState(state);
            }
        },
        .workspace_rebound => |payload| {
            if (payload.previous_workspace_root.len == 0 or payload.workspace_root.len == 0) {
                return error.InvalidEventFrame;
            }
        },
        .permission_state_changed => |payload| {
            try session_permission_state.validate(payload.permission_state);
        },
        .run_started => {
            if (envelope.turn_id != null or envelope.item_id != null) {
                return error.InvalidEventFrame;
            }
        },
        .run_completed => {
            if (envelope.turn_id != null or envelope.item_id != null) {
                return error.InvalidEventFrame;
            }
        },
        .turn_started => |payload| {
            if (envelope.turn_id == null or envelope.item_id != null) {
                return error.InvalidEventFrame;
            }
            switch (payload.input) {
                .user => |user| if (user.work_id) |id| session.validateWorkId(id) catch
                    return error.InvalidEventFrame,
            }
        },
        .turn_completed => |payload| {
            if (envelope.turn_id == null or envelope.item_id != null) {
                return error.InvalidEventFrame;
            }
            if (payload.outcome == .completed and payload.@"error" != null) {
                return error.InvalidEventFrame;
            }
        },
        .assistant_message_started => {
            if (envelope.turn_id == null or envelope.item_id == null) {
                return error.InvalidEventFrame;
            }
        },
        .assistant_message_completed => |payload| {
            if (envelope.turn_id == null or envelope.item_id == null) {
                return error.InvalidEventFrame;
            }
            // A failed model call carries its cause and attempt number.
            if (payload.outcome == .failed and
                (payload.cause == null or payload.attempt == null))
            {
                return error.InvalidEventFrame;
            }
        },
        .reasoning_started => {
            if (envelope.turn_id == null or envelope.item_id == null) {
                return error.InvalidEventFrame;
            }
        },
        .reasoning_completed => {
            if (envelope.turn_id == null or envelope.item_id == null) {
                return error.InvalidEventFrame;
            }
        },
        .usage_recorded => {},
        .history_turn_committed => |payload| _ = session.decideWorkIdAssociation(
            payload.turn,
            payload.work_id,
        ) catch return error.InvalidEventFrame,
        .usage_checkpointed => |payload| try session_usage.validateSnapshot(payload.usage),
        .recovery_checkpoint_set => |payload| {
            const state = session_codec.DurableSessionState{
                .id = @constCast("validation"),
                .origin_workspace_root = @constCast("/"),
                .workspace_root = @constCast("/"),
                .created_at_ms = 0,
                .updated_at_ms = 0,
                .conversation_language = session.ConversationLanguage.literal("en"),
                .preferences = .{
                    .model = @constCast("test/model"),
                    .effort = .auto,
                    .fast_mode = false,
                },
                .history = &.{},
                .recovery_checkpoint = payload.checkpoint,
            };
            try session_codec.validateState(state);
        },
        .recovery_checkpoint_cleared => {},
        .state_replacement_started => |payload| {
            if (payload.encoded_bytes == 0 or payload.chunk_count == 0) {
                return error.InvalidReplacement;
            }
        },
        .state_replacement_chunk => |payload| {
            if (payload.raw_bytes == 0 or payload.raw_bytes > raw_state_chunk_bytes or
                payload.bytes.len != payload.raw_bytes or
                !std.mem.eql(u8, &sha256(payload.bytes), &payload.chunk_sha256))
            {
                return error.InvalidReplacement;
            }
        },
        .state_replacement_committed => |payload| {
            if (payload.encoded_bytes == 0 or payload.chunk_count == 0) {
                return error.InvalidReplacement;
            }
        },
    }
}

fn writePayload(writer: *std.Io.Writer, event: Event) !void {
    switch (event) {
        .session_started => |payload| {
            try writer.writeAll("{\"id\":");
            try writeJsonString(writer, payload.id);
            try writer.print(",\"created_at_ms\":{d},\"origin_workspace_root\":", .{payload.created_at_ms});
            try writeJsonString(writer, payload.origin_workspace_root);
            try writer.writeAll(",\"workspace_root\":");
            try writeJsonString(writer, payload.workspace_root);
            try writer.writeAll(",\"conversation_language\":");
            try writeJsonString(writer, payload.conversation_language.view());
            try writer.writeAll(",\"preferences\":");
            try writePreferences(writer, payload.preferences);
            if (payload.usage) |usage| {
                try writer.writeAll(",\"usage\":");
                try session_usage.writeSnapshot(writer, usage);
            }
            if (payload.subagent_child) {
                try writer.writeAll(",\"subagent_child\":true");
            }
            try writer.writeByte('}');
        },
        .preferences_changed => |payload| {
            try writer.writeByte('{');
            var wrote = false;
            if (payload.provider) |provider| {
                try writer.writeAll("\"provider\":");
                try writeJsonString(writer, @tagName(provider));
                wrote = true;
            }
            if (payload.model) |model| {
                if (wrote) try writer.writeByte(',');
                try writer.writeAll("\"model\":");
                try writeJsonString(writer, model);
                wrote = true;
            }
            if (payload.effort) |effort| {
                if (wrote) try writer.writeByte(',');
                try writer.writeAll("\"effort\":");
                try writeJsonString(writer, effort.label());
                wrote = true;
            }
            if (payload.fast_mode) |fast_mode| {
                if (wrote) try writer.writeByte(',');
                try writer.print("\"fast_mode\":{s}", .{if (fast_mode) "true" else "false"});
            }
            try writer.writeByte('}');
        },
        .workspace_rebound => |payload| {
            try writer.writeAll("{\"previous_workspace_root\":");
            try writeJsonString(writer, payload.previous_workspace_root);
            try writer.writeAll(",\"workspace_root\":");
            try writeJsonString(writer, payload.workspace_root);
            try writer.writeByte('}');
        },
        .permission_state_changed => |payload| {
            try writer.writeAll("{\"permission_state\":");
            try session_codec.writePermissionState(writer, payload.permission_state);
            try writer.writeByte('}');
        },
        .run_started => |payload| {
            try writer.writeAll("{\"run_id\":");
            try writeJsonString(writer, payload.run_id);
            try writer.writeAll(",\"fiber_version\":");
            try writeJsonString(writer, payload.fiber_version);
            try writer.print(",\"schema_version\":{d},\"mode\":\"", .{payload.schema_version});
            try writer.writeAll(@tagName(payload.mode));
            try writer.writeAll("\"}");
        },
        .run_completed => |payload| {
            try writer.writeAll("{\"run_id\":");
            try writeJsonString(writer, payload.run_id);
            try writer.print(",\"exit_code\":{d}", .{payload.exit_code});
            if (payload.final_text) |text| {
                try writer.writeAll(",\"final_text\":");
                try writeJsonString(writer, text);
            }
            if (payload.model) |model| {
                try writer.writeAll(",\"model\":");
                try writeJsonString(writer, model);
            }
            if (payload.@"error") |err| {
                try writer.writeAll(",\"error\":");
                try writeEventError(writer, err);
            }
            try writer.writeByte('}');
        },
        .turn_started => |payload| {
            try writer.writeAll("{\"input\":{\"user\":");
            switch (payload.input) {
                .user => |user| try session_codec.writeUserTurn(writer, user),
            }
            try writer.writeByte('}');
            if (payload.language) |language| {
                try writer.writeAll(",\"language\":");
                try writeJsonString(writer, language.view());
            }
            try writer.writeByte('}');
        },
        .turn_completed => |payload| {
            try writer.writeAll("{\"outcome\":\"");
            try writer.writeAll(@tagName(payload.outcome));
            try writer.writeByte('"');
            if (payload.@"error") |err| {
                try writer.writeAll(",\"error\":");
                try writeEventError(writer, err);
            }
            try writer.writeByte('}');
        },
        .assistant_message_started => {
            try writer.writeAll("{}");
        },
        .assistant_message_completed => |payload| {
            try writer.writeAll("{\"text\":");
            try writeJsonString(writer, payload.text);
            try writer.writeAll(",\"outcome\":\"");
            try writer.writeAll(@tagName(payload.outcome));
            try writer.writeByte('"');
            if (payload.cause) |cause| {
                try writer.writeAll(",\"cause\":");
                try writeJsonString(writer, cause);
            }
            if (payload.attempt) |attempt| {
                try writer.print(",\"attempt\":{d}", .{attempt});
            }
            try writer.writeByte('}');
        },
        .reasoning_started => {
            try writer.writeAll("{}");
        },
        .reasoning_completed => |payload| {
            try writer.writeAll("{\"text\":");
            try writeJsonString(writer, payload.text);
            try writer.writeByte('}');
        },
        .usage_recorded => |payload| {
            try writer.writeAll("{\"generation_id\":");
            try writeJsonString(writer, payload.generation_id);
            try writer.writeAll(",\"model\":");
            try writeJsonString(writer, payload.model);
            try writer.print(",\"input_tokens\":{d},\"output_tokens\":{d},\"cache_read_tokens\":{d},\"cache_write_tokens\":{d},\"reasoning_tokens\":", .{
                payload.input_tokens,
                payload.output_tokens,
                payload.cache_read_tokens,
                payload.cache_write_tokens,
            });
            if (payload.reasoning_tokens) |tokens| {
                try writer.print("{d}", .{tokens});
            } else {
                try writer.writeAll("null");
            }
            try writer.writeAll(",\"total_cost\":");
            if (payload.total_cost) |cost| {
                try writer.print("{d}", .{cost});
            } else {
                try writer.writeAll("null");
            }
            try writer.print(",\"billable_web_search_calls\":{d}}}", .{payload.billable_web_search_calls});
        },
        .history_turn_committed => |payload| {
            try writer.writeAll("{\"conversation_language\":");
            try writeJsonString(writer, payload.conversation_language.view());
            try writer.writeAll(",\"last_input_tokens\":");
            try session_codec.writeOptionalU64(writer, payload.last_input_tokens);
            try writer.writeAll(",\"last_output_tokens\":");
            try session_codec.writeOptionalU64(writer, payload.last_output_tokens);
            try writer.writeAll(",\"turn\":");
            try session_codec.writeHistoryTurn(writer, payload.turn);
            if (payload.work_id) |id| {
                try writer.writeAll(",\"work_id\":");
                try writeJsonString(writer, id);
            }
            try writer.writeByte('}');
        },
        .usage_checkpointed => |payload| {
            try writer.writeAll("{\"usage\":");
            try session_usage.writeSnapshot(writer, payload.usage);
            try writer.writeByte('}');
        },
        .recovery_checkpoint_set => |payload| {
            try writer.writeAll("{\"checkpoint\":");
            try session_codec.writeRecoveryCheckpoint(writer, payload.checkpoint);
            try writer.writeByte('}');
        },
        .recovery_checkpoint_cleared => try writer.writeAll("{}"),
        .state_replacement_started => |payload| {
            try writer.writeAll("{\"replacement_id\":");
            try writeHexString(writer, &payload.replacement_id);
            try writer.writeAll(",\"reason\":");
            try writeJsonString(writer, @tagName(payload.reason));
            try writer.print(",\"encoded_bytes\":{d},\"sha256\":", .{payload.encoded_bytes});
            try writeHexString(writer, &payload.sha256);
            try writer.print(",\"chunk_count\":{d}}}", .{payload.chunk_count});
        },
        .state_replacement_chunk => |payload| {
            try writer.writeAll("{\"replacement_id\":");
            try writeHexString(writer, &payload.replacement_id);
            try writer.print(",\"chunk_index\":{d},\"raw_bytes\":{d},\"chunk_sha256\":", .{
                payload.chunk_index,
                payload.raw_bytes,
            });
            try writeHexString(writer, &payload.chunk_sha256);
            try writer.writeAll(",\"base64\":\"");
            try std.base64.standard.Encoder.encodeWriter(writer, payload.bytes);
            try writer.writeAll("\"}");
        },
        .state_replacement_committed => |payload| {
            try writer.writeAll("{\"replacement_id\":");
            try writeHexString(writer, &payload.replacement_id);
            try writer.print(",\"encoded_bytes\":{d},\"sha256\":", .{payload.encoded_bytes});
            try writeHexString(writer, &payload.sha256);
            try writer.print(",\"chunk_count\":{d}}}", .{payload.chunk_count});
        },
    }
}

fn parsePayload(alloc: Allocator, kind: Kind, value: std.json.Value) !Event {
    return switch (kind) {
        .session_started => blk: {
            const source = try requireObject(value);
            if (source.count() < 6 or source.count() > 8) {
                return error.InvalidEventFrame;
            }
            try rejectUnknownKeys(source, &.{
                "id",
                "created_at_ms",
                "origin_workspace_root",
                "workspace_root",
                "conversation_language",
                "preferences",
                "usage",
                "subagent_child",
            });
            const object = source;
            const id = try dupeString(alloc, object, "id");
            errdefer alloc.free(id);
            const origin = try dupeString(alloc, object, "origin_workspace_root");
            errdefer alloc.free(origin);
            const current = try dupeString(alloc, object, "workspace_root");
            errdefer alloc.free(current);
            const preferences = try parsePreferences(
                alloc,
                object.get("preferences") orelse return error.InvalidEventFrame,
            );
            errdefer {
                var owned = preferences;
                owned.deinit(alloc);
            }
            var usage = if (object.get("usage")) |usage_value|
                session_usage.parseSnapshotValue(alloc, usage_value) catch |err| switch (err) {
                    error.OutOfMemory => return error.OutOfMemory,
                    else => return error.InvalidEventFrame,
                }
            else
                null;
            errdefer if (usage) |*snapshot| snapshot.deinit(alloc);
            const subagent_child = if (object.get("subagent_child")) |raw|
                if (raw == .bool and raw.bool)
                    true
                else
                    return error.InvalidEventFrame
            else
                false;
            break :blk .{ .session_started = .{
                .id = id,
                .created_at_ms = try requireI64(object, "created_at_ms"),
                .origin_workspace_root = origin,
                .workspace_root = current,
                .conversation_language = parseLanguage(
                    try requireString(object, "conversation_language"),
                ) catch return error.InvalidEventFrame,
                .preferences = preferences,
                .usage = usage,
                .subagent_child = subagent_child,
            } };
        },
        .preferences_changed => blk: {
            const object = try requireObject(value);
            if (object.count() == 0 or object.count() > 4) return error.InvalidEventFrame;
            try rejectUnknownKeys(object, &.{ "provider", "model", "effort", "fast_mode" });
            const provider = if (object.get("provider")) |provider_value| provider_blk: {
                if (provider_value != .string) return error.InvalidEventFrame;
                break :provider_blk model_provider.parse(provider_value.string) orelse return error.InvalidEventFrame;
            } else null;
            const model = if (object.get("model")) |_| try dupeString(alloc, object, "model") else null;
            errdefer if (model) |owned| alloc.free(owned);
            const effort = if (object.get("effort")) |_|
                types.ReasoningEffort.parse(try requireString(object, "effort")) orelse
                    return error.InvalidEventFrame
            else
                null;
            const fast_mode = if (object.get("fast_mode")) |_| try requireBool(object, "fast_mode") else null;
            break :blk .{ .preferences_changed = .{
                .provider = provider,
                .model = model,
                .effort = effort,
                .fast_mode = fast_mode,
            } };
        },
        .workspace_rebound => blk: {
            const object = try exactObject(value, &.{ "previous_workspace_root", "workspace_root" });
            const previous = try dupeString(alloc, object, "previous_workspace_root");
            errdefer alloc.free(previous);
            break :blk .{ .workspace_rebound = .{
                .previous_workspace_root = previous,
                .workspace_root = try dupeString(alloc, object, "workspace_root"),
            } };
        },
        .permission_state_changed => blk: {
            const object = try exactObject(value, &.{"permission_state"});
            var permission_state = session_codec.parsePermissionState(
                alloc,
                object.get("permission_state") orelse return error.InvalidEventFrame,
            ) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.InvalidEventFrame,
            };
            errdefer permission_state.deinit(alloc);
            session_permission_state.validate(permission_state) catch
                return error.InvalidEventFrame;
            break :blk .{ .permission_state_changed = .{
                .permission_state = permission_state,
            } };
        },
        .run_started => blk: {
            const object = try exactObject(value, &.{ "run_id", "fiber_version", "schema_version", "mode" });
            const run_id = try dupeString(alloc, object, "run_id");
            errdefer alloc.free(run_id);
            if (run_id.len == 0) return error.InvalidEventFrame;
            const fiber_version = try dupeString(alloc, object, "fiber_version");
            errdefer alloc.free(fiber_version);
            if (fiber_version.len == 0) return error.InvalidEventFrame;
            if (try requireU64(object, "schema_version") != 1) return error.InvalidEventFrame;
            const mode = std.meta.stringToEnum(RunMode, try requireString(object, "mode")) orelse
                return error.InvalidEventFrame;
            break :blk .{ .run_started = .{
                .run_id = run_id,
                .fiber_version = fiber_version,
                .mode = mode,
            } };
        },
        .run_completed => blk: {
            const object = try requireObject(value);
            if (object.count() < 2 or object.count() > 5) return error.InvalidEventFrame;
            try rejectUnknownKeys(object, &.{ "run_id", "exit_code", "final_text", "model", "error" });
            const run_id = try dupeString(alloc, object, "run_id");
            errdefer alloc.free(run_id);
            if (run_id.len == 0) return error.InvalidEventFrame;
            const exit_code = try requireI64(object, "exit_code");
            const final_text = if (object.get("final_text")) |_| try dupeString(alloc, object, "final_text") else null;
            errdefer if (final_text) |text| alloc.free(text);
            const model = if (object.get("model")) |_| try dupeString(alloc, object, "model") else null;
            errdefer if (model) |name| alloc.free(name);
            var run_error: ?EventError = if (object.get("error")) |raw|
                try parseEventError(alloc, raw)
            else
                null;
            errdefer if (run_error) |*err| err.deinit(alloc);
            break :blk .{ .run_completed = .{
                .run_id = run_id,
                .exit_code = exit_code,
                .final_text = final_text,
                .model = model,
                .@"error" = run_error,
            } };
        },
        .turn_started => blk: {
            const object = try requireObject(value);
            if (object.count() < 1 or object.count() > 2) return error.InvalidEventFrame;
            try rejectUnknownKeys(object, &.{ "input", "language" });
            var input = try parseTurnInput(
                alloc,
                object.get("input") orelse return error.InvalidEventFrame,
            );
            errdefer input.deinit(alloc);
            const language = if (object.get("language")) |_| language_blk: {
                break :language_blk parseLanguage(
                    try requireString(object, "language"),
                ) catch return error.InvalidEventFrame;
            } else null;
            break :blk .{ .turn_started = .{ .input = input, .language = language } };
        },
        .turn_completed => blk: {
            const object = try requireObject(value);
            if (object.count() < 1 or object.count() > 2) return error.InvalidEventFrame;
            try rejectUnknownKeys(object, &.{ "outcome", "error" });
            const outcome = std.meta.stringToEnum(
                TurnOutcome,
                try requireString(object, "outcome"),
            ) orelse return error.InvalidEventFrame;
            var turn_error: ?EventError = if (object.get("error")) |raw|
                try parseEventError(alloc, raw)
            else
                null;
            errdefer if (turn_error) |*err| err.deinit(alloc);
            break :blk .{ .turn_completed = .{
                .outcome = outcome,
                .@"error" = turn_error,
            } };
        },
        .assistant_message_started => blk: {
            _ = try exactObject(value, &.{});
            break :blk .{ .assistant_message_started = .{} };
        },
        .assistant_message_completed => blk: {
            const object = try requireObject(value);
            if (object.count() < 1 or object.count() > 4) return error.InvalidEventFrame;
            try rejectUnknownKeys(object, &.{ "text", "outcome", "cause", "attempt" });
            const text = try dupeString(alloc, object, "text");
            errdefer alloc.free(text);
            const outcome = if (object.get("outcome")) |_| outcome_blk: {
                break :outcome_blk std.meta.stringToEnum(
                    MessageOutcome,
                    try requireString(object, "outcome"),
                ) orelse return error.InvalidEventFrame;
            } else .completed;
            const cause = if (object.get("cause")) |_| try dupeString(alloc, object, "cause") else null;
            errdefer if (cause) |owned| alloc.free(owned);
            const attempt = if (object.get("attempt")) |_| try requireU64(object, "attempt") else null;
            if (outcome == .failed and (cause == null or attempt == null)) {
                return error.InvalidEventFrame;
            }
            break :blk .{ .assistant_message_completed = .{
                .text = text,
                .outcome = outcome,
                .cause = cause,
                .attempt = attempt,
            } };
        },
        .reasoning_started => blk: {
            _ = try exactObject(value, &.{});
            break :blk .{ .reasoning_started = .{} };
        },
        .reasoning_completed => blk: {
            const object = try exactObject(value, &.{"text"});
            break :blk .{ .reasoning_completed = .{
                .text = try dupeString(alloc, object, "text"),
            } };
        },
        .usage_recorded => blk: {
            const object = try exactObject(value, &.{
                "generation_id",
                "model",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "reasoning_tokens",
                "total_cost",
                "billable_web_search_calls",
            });
            const generation_id = try dupeString(alloc, object, "generation_id");
            errdefer alloc.free(generation_id);
            if (generation_id.len == 0) return error.InvalidEventFrame;
            const model = try dupeString(alloc, object, "model");
            errdefer alloc.free(model);
            if (model.len == 0) return error.InvalidEventFrame;
            const input_tokens = try requireU64(object, "input_tokens");
            const output_tokens = try requireU64(object, "output_tokens");
            const cache_read_tokens = try requireU64(object, "cache_read_tokens");
            const cache_write_tokens = try requireU64(object, "cache_write_tokens");
            // Mirror the snapshot rules so a folded ledger always validates.
            if (cache_read_tokens > input_tokens or cache_write_tokens > input_tokens) {
                return error.InvalidEventFrame;
            }
            const reasoning_tokens = try requireOptionalU64(object, "reasoning_tokens");
            if (reasoning_tokens) |tokens| {
                if (tokens > output_tokens) return error.InvalidEventFrame;
            }
            const total_cost = try requireOptionalCost(object, "total_cost");
            break :blk .{ .usage_recorded = .{
                .generation_id = generation_id,
                .model = model,
                .input_tokens = input_tokens,
                .output_tokens = output_tokens,
                .cache_read_tokens = cache_read_tokens,
                .cache_write_tokens = cache_write_tokens,
                .reasoning_tokens = reasoning_tokens,
                .total_cost = total_cost,
                .billable_web_search_calls = try requireU64(object, "billable_web_search_calls"),
            } };
        },
        .history_turn_committed => blk: {
            const source = try requireObject(value);
            // Tolerance reader: pre-rename schema-1 events named the
            // last-response counters total_*; map them onto last_*.
            const legacy = source.get("total_input_tokens") != null;
            const input_key: []const u8 = if (legacy) "total_input_tokens" else "last_input_tokens";
            const output_key: []const u8 = if (legacy) "total_output_tokens" else "last_output_tokens";
            const object = if (source.get("work_id") != null)
                try exactObject(value, &.{
                    "conversation_language",
                    input_key,
                    output_key,
                    "turn",
                    "work_id",
                })
            else
                try exactObject(value, &.{
                    "conversation_language",
                    input_key,
                    output_key,
                    "turn",
                });
            const turn = try session_codec.parseHistoryTurn(
                alloc,
                object.get("turn") orelse return error.InvalidEventFrame,
            );
            errdefer session.freeHistoryTurn(alloc, turn);
            const work_id = if (object.get("work_id")) |_| try dupeString(alloc, object, "work_id") else null;
            errdefer if (work_id) |id| alloc.free(id);
            break :blk .{ .history_turn_committed = .{
                .conversation_language = parseLanguage(
                    try requireString(object, "conversation_language"),
                ) catch return error.InvalidEventFrame,
                .last_input_tokens = try requireOptionalU64(object, input_key),
                .last_output_tokens = try requireOptionalU64(object, output_key),
                .work_id = work_id,
                .turn = turn,
            } };
        },
        .usage_checkpointed => blk: {
            const object = try exactObject(value, &.{"usage"});
            var usage = session_usage.parseSnapshotValue(
                alloc,
                object.get("usage") orelse return error.InvalidEventFrame,
            ) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.InvalidEventFrame,
            };
            errdefer usage.deinit(alloc);
            break :blk .{ .usage_checkpointed = .{ .usage = usage } };
        },
        .recovery_checkpoint_set => blk: {
            const object = try exactObject(value, &.{"checkpoint"});
            const checkpoint = session_codec.parseRecoveryCheckpoint(
                alloc,
                object.get("checkpoint") orelse return error.InvalidEventFrame,
            ) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.InvalidEventFrame,
            };
            break :blk .{ .recovery_checkpoint_set = .{ .checkpoint = checkpoint } };
        },
        .recovery_checkpoint_cleared => blk: {
            _ = try exactObject(value, &.{});
            break :blk .{ .recovery_checkpoint_cleared = .{} };
        },
        .state_replacement_started => blk: {
            const object = try exactObject(value, &.{
                "replacement_id",
                "reason",
                "encoded_bytes",
                "sha256",
                "chunk_count",
            });
            break :blk .{ .state_replacement_started = .{
                .replacement_id = try parseIdentifier(try requireString(object, "replacement_id")),
                .reason = std.meta.stringToEnum(
                    ReplacementReason,
                    try requireString(object, "reason"),
                ) orelse return error.InvalidEventFrame,
                .encoded_bytes = try requireU64(object, "encoded_bytes"),
                .sha256 = try parseDigest(try requireString(object, "sha256")),
                .chunk_count = try requireU64(object, "chunk_count"),
            } };
        },
        .state_replacement_chunk => blk: {
            const object = try exactObject(value, &.{
                "replacement_id",
                "chunk_index",
                "raw_bytes",
                "chunk_sha256",
                "base64",
            });
            const encoded = try requireString(object, "base64");
            const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch
                return error.InvalidEventFrame;
            const bytes = try alloc.alloc(u8, decoded_len);
            errdefer alloc.free(bytes);
            std.base64.standard.Decoder.decode(bytes, encoded) catch return error.InvalidEventFrame;
            const canonical = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
            defer alloc.free(canonical);
            const rendered = std.base64.standard.Encoder.encode(canonical, bytes);
            if (!std.mem.eql(u8, rendered, encoded)) return error.InvalidEventFrame;
            break :blk .{ .state_replacement_chunk = .{
                .replacement_id = try parseIdentifier(try requireString(object, "replacement_id")),
                .chunk_index = try requireU64(object, "chunk_index"),
                .raw_bytes = try requireU64(object, "raw_bytes"),
                .chunk_sha256 = try parseDigest(try requireString(object, "chunk_sha256")),
                .bytes = bytes,
            } };
        },
        .state_replacement_committed => blk: {
            const object = try exactObject(value, &.{
                "replacement_id",
                "encoded_bytes",
                "sha256",
                "chunk_count",
            });
            break :blk .{ .state_replacement_committed = .{
                .replacement_id = try parseIdentifier(try requireString(object, "replacement_id")),
                .encoded_bytes = try requireU64(object, "encoded_bytes"),
                .sha256 = try parseDigest(try requireString(object, "sha256")),
                .chunk_count = try requireU64(object, "chunk_count"),
            } };
        },
    };
}

fn readFrameLine(alloc: Allocator, source: *std.Io.Reader) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    _ = source.streamDelimiterLimit(
        &out.writer,
        '\n',
        .limited(event_frame_max_bytes),
    ) catch |err| switch (err) {
        error.StreamTooLong => return error.EventFrameTooLarge,
        error.ReadFailed => return error.ReadFailed,
        error.WriteFailed => return error.OutOfMemory,
    };
    const next = source.takeByte() catch |err| switch (err) {
        error.EndOfStream => {
            if (out.written().len == 0) return error.EndOfStream;
            return error.TruncatedEventFrame;
        },
        else => return err,
    };
    if (next != '\n') return error.InvalidEventFrame;
    try out.writer.writeByte('\n');
    return try out.toOwnedSlice();
}

fn parsePreferences(alloc: Allocator, value: std.json.Value) !session_codec.DurableSessionPreferences {
    const raw_object = try requireObject(value);
    const object = if (raw_object.get("provider") != null)
        try exactObject(value, &.{ "provider", "model", "effort", "fast_mode" })
    else
        try exactObject(value, &.{ "model", "effort", "fast_mode" });
    const model = try dupeString(alloc, object, "model");
    errdefer alloc.free(model);
    return .{
        .provider = if (object.get("provider")) |provider_value| blk: {
            if (provider_value != .string) return error.InvalidEventFrame;
            break :blk model_provider.parse(provider_value.string) orelse return error.InvalidEventFrame;
        } else .codex,
        .model = model,
        .effort = types.ReasoningEffort.parse(
            try requireString(object, "effort"),
        ) orelse return error.InvalidEventFrame,
        .fast_mode = try requireBool(object, "fast_mode"),
    };
}

fn writePreferences(
    writer: *std.Io.Writer,
    preferences: session_codec.DurableSessionPreferences,
) !void {
    try writer.writeAll("{\"model\":");
    try writeJsonString(writer, preferences.model);
    try writer.writeAll(",\"effort\":");
    try writeJsonString(writer, preferences.effort.label());
    try writer.print(",\"fast_mode\":{s},\"provider\":", .{
        if (preferences.fast_mode) "true" else "false",
    });
    try writeJsonString(writer, @tagName(preferences.provider));
    try writer.writeByte('}');
}

fn exactObject(value: std.json.Value, keys: []const []const u8) !std.json.ObjectMap {
    const object = try requireObject(value);
    if (object.count() != keys.len) return error.InvalidEventFrame;
    try rejectUnknownKeys(object, keys);
    return object;
}

fn rejectUnknownKeys(object: std.json.ObjectMap, keys: []const []const u8) !void {
    var iterator = object.iterator();
    while (iterator.next()) |entry| {
        var known = false;
        for (keys) |key| {
            if (std.mem.eql(u8, entry.key_ptr.*, key)) {
                known = true;
                break;
            }
        }
        if (!known) return error.InvalidEventFrame;
    }
}

fn requireObject(value: std.json.Value) !std.json.ObjectMap {
    if (value != .object) return error.InvalidEventFrame;
    return value.object;
}

fn requireString(object: std.json.ObjectMap, key: []const u8) ![]const u8 {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    if (value != .string) return error.InvalidEventFrame;
    return value.string;
}

fn dupeString(alloc: Allocator, object: std.json.ObjectMap, key: []const u8) ![]u8 {
    return try alloc.dupe(u8, try requireString(object, key));
}

fn requireBool(object: std.json.ObjectMap, key: []const u8) !bool {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    if (value != .bool) return error.InvalidEventFrame;
    return value.bool;
}

fn requireI64(object: std.json.ObjectMap, key: []const u8) !i64 {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    return switch (value) {
        .integer => |number| number,
        .number_string => |raw| std.fmt.parseInt(i64, raw, 10) catch
            error.InvalidEventFrame,
        else => error.InvalidEventFrame,
    };
}

fn requireOptionalU64(object: std.json.ObjectMap, key: []const u8) !?u64 {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    return switch (value) {
        .null => null,
        .integer => |number| if (number >= 0) @intCast(number) else error.InvalidEventFrame,
        .number_string => |raw| std.fmt.parseUnsigned(u64, raw, 10) catch
            error.InvalidEventFrame,
        else => error.InvalidEventFrame,
    };
}

fn requireU64(object: std.json.ObjectMap, key: []const u8) !u64 {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    return switch (value) {
        .integer => |number| if (number >= 0) @intCast(number) else error.InvalidEventFrame,
        .number_string => |raw| std.fmt.parseUnsigned(u64, raw, 10) catch
            error.InvalidEventFrame,
        else => error.InvalidEventFrame,
    };
}

fn requireOptionalCost(object: std.json.ObjectMap, key: []const u8) !?f64 {
    const value = object.get(key) orelse return error.InvalidEventFrame;
    return switch (value) {
        .null => null,
        .integer => |number| cost: {
            const cost: f64 = @floatFromInt(number);
            if (!std.math.isFinite(cost) or cost < 0) return error.InvalidEventFrame;
            break :cost cost;
        },
        .float => |number| if (std.math.isFinite(number) and number >= 0)
            number
        else
            error.InvalidEventFrame,
        .number_string => |raw| cost: {
            const cost = std.fmt.parseFloat(f64, raw) catch return error.InvalidEventFrame;
            if (!std.math.isFinite(cost) or cost < 0) return error.InvalidEventFrame;
            break :cost cost;
        },
        else => error.InvalidEventFrame,
    };
}

fn parseEventError(alloc: Allocator, value: std.json.Value) !EventError {
    const object = try exactObject(value, &.{ "code", "message" });
    const code = try dupeString(alloc, object, "code");
    errdefer alloc.free(code);
    if (code.len == 0) return error.InvalidEventFrame;
    const message = try dupeString(alloc, object, "message");
    errdefer alloc.free(message);
    return .{ .code = code, .message = message };
}

fn parseTurnInput(alloc: Allocator, value: std.json.Value) !TurnInput {
    const object = try exactObject(value, &.{"user"});
    const user = session_codec.parseUserTurn(
        alloc,
        object.get("user") orelse return error.InvalidEventFrame,
    ) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidEventFrame,
    };
    return .{ .user = user };
}

fn parseLanguage(raw: []const u8) !session.ConversationLanguage {
    return session_codec.parseConversationLanguage(raw);
}

fn parseIdentifier(hex: []const u8) !Identifier {
    return parseHex(Identifier, hex);
}

fn parseDigest(hex: []const u8) !Digest {
    return parseHex(Digest, hex);
}

fn parseHex(comptime T: type, hex: []const u8) !T {
    if (hex.len != @sizeOf(T) * 2) return error.InvalidEventFrame;
    var value: T = undefined;
    _ = std.fmt.hexToBytes(&value, hex) catch return error.InvalidEventFrame;
    const canonical = std.fmt.bytesToHex(value, .lower);
    if (!std.mem.eql(u8, &canonical, hex)) return error.InvalidEventFrame;
    return value;
}

fn writeHexString(writer: *std.Io.Writer, bytes: []const u8) !void {
    try writer.writeByte('"');
    const alphabet = "0123456789abcdef";
    for (bytes) |byte| {
        try writer.writeByte(alphabet[byte >> 4]);
        try writer.writeByte(alphabet[byte & 0x0f]);
    }
    try writer.writeByte('"');
}

fn writeJsonString(writer: *std.Io.Writer, bytes: []const u8) !void {
    try std.json.Stringify.value(bytes, .{}, writer);
}

fn writeEventError(writer: *std.Io.Writer, err: EventError) !void {
    try writer.writeAll("{\"code\":");
    try writeJsonString(writer, err.code);
    try writer.writeAll(",\"message\":");
    try writeJsonString(writer, err.message);
    try writer.writeByte('}');
}

fn sha256(bytes: []const u8) Digest {
    var hash: Digest = undefined;
    Sha256.hash(bytes, &hash, .{});
    return hash;
}

test "session event kind contract contains exactly twenty stable variants" {
    try std.testing.expectEqual(@as(usize, 20), @typeInfo(Kind).@"enum".fields.len);
    try std.testing.expectEqualStrings("session_started", @tagName(Kind.session_started));
    try std.testing.expectEqualStrings("preferences_changed", @tagName(Kind.preferences_changed));
    try std.testing.expectEqualStrings("permission_state_changed", @tagName(Kind.permission_state_changed));
    try std.testing.expectEqualStrings("workspace_rebound", @tagName(Kind.workspace_rebound));
    try std.testing.expectEqualStrings("run_started", @tagName(Kind.run_started));
    try std.testing.expectEqualStrings("run_completed", @tagName(Kind.run_completed));
    try std.testing.expectEqualStrings("turn_started", @tagName(Kind.turn_started));
    try std.testing.expectEqualStrings("turn_completed", @tagName(Kind.turn_completed));
    try std.testing.expectEqualStrings("assistant_message_started", @tagName(Kind.assistant_message_started));
    try std.testing.expectEqualStrings("assistant_message_completed", @tagName(Kind.assistant_message_completed));
    try std.testing.expectEqualStrings("reasoning_started", @tagName(Kind.reasoning_started));
    try std.testing.expectEqualStrings("reasoning_completed", @tagName(Kind.reasoning_completed));
    try std.testing.expectEqualStrings("usage_recorded", @tagName(Kind.usage_recorded));
    try std.testing.expectEqualStrings("recovery_checkpoint_set", @tagName(Kind.recovery_checkpoint_set));
    try std.testing.expectEqualStrings("recovery_checkpoint_cleared", @tagName(Kind.recovery_checkpoint_cleared));
    try std.testing.expectEqualStrings("state_replacement_started", @tagName(Kind.state_replacement_started));
    try std.testing.expectEqualStrings("state_replacement_chunk", @tagName(Kind.state_replacement_chunk));
    try std.testing.expectEqualStrings("state_replacement_committed", @tagName(Kind.state_replacement_committed));
    try std.testing.expectEqualStrings("history_turn_committed", @tagName(Kind.history_turn_committed));
    try std.testing.expectEqualStrings("usage_checkpointed", @tagName(Kind.usage_checkpointed));
}

test "event frame codec is deterministic and validates contiguous sequence" {
    const alloc = std.testing.allocator;
    const frame = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 50,
        .event = .{ .session_started = .{
            .id = @constCast("session-1"),
            .created_at_ms = 10,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("openai/gpt-test"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
            .subagent_child = true,
        } },
    };

    const first = try encodeFrame(alloc, frame);
    defer alloc.free(first);
    const second = try encodeFrame(alloc, frame);
    defer alloc.free(second);
    try std.testing.expectEqualStrings(first, second);
    try std.testing.expect(first[first.len - 1] == '\n');

    var decoded_frame_1 = try decodeFrame(alloc, first);
    defer decoded_frame_1.deinit(alloc);
    const decoded = &decoded_frame_1.known;
    try std.testing.expectEqual(Kind.session_started, decoded.kind());
    try std.testing.expect(decoded.event.session_started.subagent_child);
    try std.testing.expectEqualStrings("session-1", decoded.session_id);
    try std.testing.expectEqual(@as(u64, 1), decoded.seq);
    try std.testing.expectEqual(@as(i64, 50), decoded.ts);

    var validator: SequenceValidator = .{};
    try validator.validate(decoded.seq);

    var gap = decoded;
    gap.seq = 3;
    try std.testing.expectError(error.NonContiguousSequence, validator.validate(gap.seq));
}

test "history_turn_committed event decode repairs duplicate-key tool arguments" {
    const duplicate_arguments = "{\"depth\":1,\"depth\":2}";
    var calls = [_]session.ToolCall{.{
        .id = "call_bad",
        .name = "read_file",
        .arguments_json = duplicate_arguments,
    }};
    var results = [_]session.PersistedToolResult{.{
        .tool_call_id = @constCast("call_bad"),
        .tool_name = @constCast("read_file"),
        .status = .success,
        .output = @constCast("stale success"),
        .output_bytes = 13,
        .stored_output_bytes = 13,
        .truncated = false,
        .provider_native = false,
        .created_at_ms = 1,
    }};
    var steps = [_]session.ToolExecutionStep{.{
        .tool_calls = calls[0..],
        .tool_results = results[0..],
    }};
    const frame = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 50,
        .event = .{ .history_turn_committed = .{
            .conversation_language = session.ConversationLanguage.literal("en"),
            .last_input_tokens = 1,
            .last_output_tokens = 2,
            .turn = .{ .assistant = .{
                .user = .{ .text = @constCast("inspect") },
                .assistant = @constCast("failed"),
                .execution = .{ .tool_steps = steps[0..] },
            } },
        } },
    };

    const encoded = try encodeFrame(std.testing.allocator, frame);
    defer std.testing.allocator.free(encoded);
    var decoded_frame_6 = try decodeFrame(std.testing.allocator, encoded);
    defer decoded_frame_6.deinit(std.testing.allocator);
    const decoded = &decoded_frame_6.known;

    const step = decoded.event.history_turn_committed.turn.assistant.execution.tool_steps[0];
    try std.testing.expectEqualStrings("{}", step.tool_calls[0].arguments_json);
    try std.testing.expectEqual(types.ToolArgumentIntegrity.valid, step.tool_calls[0].argument_integrity);
    try std.testing.expectEqual(session.PersistedToolStatus.failure, step.tool_results[0].status);
    try std.testing.expect(std.mem.find(u8, step.tool_results[0].output, "tool_execution_failed") != null);
    try std.testing.expect(std.mem.find(u8, step.tool_results[0].output, duplicate_arguments) == null);
}

test "event frames carry message and reasoning item ids on the envelope" {
    const alloc = std.testing.allocator;
    const started = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 50,
        .turn_id = @constCast("7"),
        .item_id = @constCast("item_msg"),
        .event = .{ .assistant_message_started = .{} },
    };
    const started_line = try encodeFrame(alloc, started);
    defer alloc.free(started_line);
    var decoded_started = try decodeFrame(alloc, started_line);
    defer decoded_started.deinit(alloc);
    try std.testing.expectEqualStrings("item_msg", decoded_started.known.item_id.?);
    try std.testing.expectEqualStrings("7", decoded_started.known.turn_id.?);

    const completed = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 2,
        .ts = 51,
        .turn_id = @constCast("7"),
        .item_id = @constCast("reason_a"),
        .event = .{ .reasoning_completed = .{ .text = @constCast("because") } },
    };
    const completed_line = try encodeFrame(alloc, completed);
    defer alloc.free(completed_line);
    var decoded_completed = try decodeFrame(alloc, completed_line);
    defer decoded_completed.deinit(alloc);
    try std.testing.expectEqualStrings("reason_a", decoded_completed.known.item_id.?);
    try std.testing.expectEqualStrings("because", decoded_completed.known.event.reasoning_completed.text);
}

test "event frame cap is inclusive of the required newline" {
    const alloc = std.testing.allocator;
    const frame = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 1,
        .event = .{ .preferences_changed = .{ .fast_mode = true } },
    };
    const encoded = try encodeFrame(alloc, frame);
    defer alloc.free(encoded);

    const exact = try alloc.alloc(u8, event_frame_max_bytes);
    defer alloc.free(exact);
    @memcpy(exact[0 .. encoded.len - 1], encoded[0 .. encoded.len - 1]);
    @memset(exact[encoded.len - 1 .. exact.len - 1], ' ');
    exact[exact.len - 1] = '\n';
    var decoded_frame_2 = try decodeFrame(alloc, exact);
    defer decoded_frame_2.deinit(alloc);

    const oversized = try alloc.alloc(u8, event_frame_max_bytes + 1);
    defer alloc.free(oversized);
    @memcpy(oversized[0..exact.len], exact);
    oversized[oversized.len - 2] = ' ';
    oversized[oversized.len - 1] = '\n';
    try std.testing.expectError(error.EventFrameTooLarge, decodeFrame(alloc, oversized));
}

test "replacement writer uses four MiB chunks and reducer commits only complete replacement" {
    const alloc = std.testing.allocator;
    const large_text = try alloc.alloc(u8, raw_state_chunk_bytes + 1);
    defer alloc.free(large_text);
    @memset(large_text, 'x');

    const initial = session_codec.DurableSessionState{
        .id = @constCast("session-1"),
        .origin_workspace_root = @constCast("/tmp/origin"),
        .workspace_root = @constCast("/tmp/current"),
        .created_at_ms = 10,
        .updated_at_ms = 20,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = @constCast("model-a"),
            .effort = types.ReasoningEffort.literal("low"),
            .fast_mode = false,
        },
        .history = @constCast(&.{}),
        .last_input_tokens = 1,
        .last_output_tokens = 2,
    };
    var large_history = [_]session.HistoryTurn{.{ .assistant = .{
        .user = .{ .text = @constCast("large") },
        .assistant = large_text,
    } }};
    const replacement = session_codec.DurableSessionState{
        .id = initial.id,
        .origin_workspace_root = initial.origin_workspace_root,
        .workspace_root = initial.workspace_root,
        .created_at_ms = initial.created_at_ms,
        .updated_at_ms = 15,
        .conversation_language = session.ConversationLanguage.literal("fr"),
        .preferences = .{
            .model = @constCast("model-b"),
            .effort = types.ReasoningEffort.literal("high"),
            .fast_mode = true,
        },
        .history = large_history[0..],
        .last_input_tokens = 9,
        .last_output_tokens = 8,
    };

    var complete: std.Io.Writer.Allocating = .init(alloc);
    defer complete.deinit();
    const replacement_summary = try writeStateReplacement(alloc, &complete.writer, replacement, .{
        .session_id = "session-1",
        .first_seq = 5,
        .replacement_id = identifier(0x22),
        .ts = 15,
        .reason = .recovery,
    });
    try std.testing.expect(replacement_summary.chunk_count >= 2);
    try std.testing.expectEqual(
        5 + replacement_summary.chunk_count + 1,
        replacement_summary.last_seq,
    );

    var source = std.Io.Reader.fixed(complete.written());
    var reduced = try reduceJsonlFrom(
        alloc,
        &source,
        try initial.dupe(alloc),
        .{ .next_seq = 5 },
    );
    defer reduced.deinit(alloc);
    try std.testing.expect(reduced.truncate_from == null);
    try std.testing.expectEqualStrings("model-b", reduced.state.preferences.model);
    try std.testing.expectEqual(@as(i64, 15), reduced.state.updated_at_ms);
    try std.testing.expectEqual(@as(usize, 1), reduced.state.history.len);
    try std.testing.expectEqual(large_text.len, reduced.state.history[0].assistant.assistant.len);

    const commit_start = std.mem.lastIndexOf(u8, complete.written(), "{\"schema_version\":1") orelse return error.TestExpectedEqual;
    var incomplete_source = std.Io.Reader.fixed(complete.written()[0..commit_start]);
    var incomplete = try reduceJsonlFrom(
        alloc,
        &incomplete_source,
        try initial.dupe(alloc),
        .{ .next_seq = 5 },
    );
    defer incomplete.deinit(alloc);
    try std.testing.expectEqual(@as(?u64, 0), incomplete.truncate_from);
    try std.testing.expectEqualStrings("model-a", incomplete.state.preferences.model);
    try std.testing.expectEqual(@as(i64, 20), incomplete.state.updated_at_ms);

    const FailingAfterReader = struct {
        bytes: []const u8,
        fail_at: usize,
        offset: usize = 0,
        buffer: [1]u8 = undefined,
        interface: std.Io.Reader = undefined,

        fn init(self: *@This(), bytes: []const u8, fail_at: usize) void {
            self.* = .{ .bytes = bytes, .fail_at = fail_at };
            self.interface = .{
                .vtable = &.{
                    .stream = stream,
                    .readVec = readVec,
                },
                .buffer = &self.buffer,
                .seek = 0,
                .end = 0,
            };
        }

        fn readVec(reader: *std.Io.Reader, destinations: [][]u8) std.Io.Reader.Error!usize {
            const self: *@This() = @alignCast(@fieldParentPtr("interface", reader));
            if (self.offset >= self.fail_at) return error.ReadFailed;
            if (self.offset >= self.bytes.len) return error.EndOfStream;
            for (destinations) |destination| {
                if (destination.len == 0) continue;
                const count = @min(
                    destination.len,
                    @min(
                        self.fail_at - self.offset,
                        self.bytes.len - self.offset,
                    ),
                );
                if (count == 0) return error.ReadFailed;
                @memcpy(destination[0..count], self.bytes[self.offset..][0..count]);
                self.offset += count;
                return count;
            }
            const destination = reader.buffer[reader.end..];
            if (destination.len == 0) return 0;
            const count = @min(
                destination.len,
                @min(
                    self.fail_at - self.offset,
                    self.bytes.len - self.offset,
                ),
            );
            if (count == 0) return error.ReadFailed;
            @memcpy(destination[0..count], self.bytes[self.offset..][0..count]);
            self.offset += count;
            reader.end += count;
            return 0;
        }

        fn stream(
            reader: *std.Io.Reader,
            writer: *std.Io.Writer,
            limit: std.Io.Limit,
        ) std.Io.Reader.StreamError!usize {
            const destination = limit.slice(try writer.writableSliceGreedy(1));
            var destinations = [1][]u8{destination};
            const count = try readVec(reader, &destinations);
            writer.advance(count);
            return count;
        }
    };
    const first_frame_end =
        (std.mem.findScalar(u8, complete.written(), '\n') orelse
            return error.TestExpectedEqual) + 1;
    var failing_source: FailingAfterReader = undefined;
    failing_source.init(complete.written(), first_frame_end + 16);
    try std.testing.expectError(
        error.ReadFailed,
        reduceJsonlFrom(
            alloc,
            &failing_source.interface,
            try initial.dupe(alloc),
            .{ .next_seq = 5 },
        ),
    );
}

test "semantic reducer uses event timestamps and enforces immutable identity" {
    const alloc = std.testing.allocator;
    const frames = [_]Envelope{
        .{
            .session_id = @constCast("session-1"),
            .seq = 1,
            .ts = 100,
            .event = .{ .session_started = .{
                .id = @constCast("session-1"),
                .created_at_ms = 10,
                .origin_workspace_root = @constCast("/tmp/origin"),
                .workspace_root = @constCast("/tmp/a"),
                .conversation_language = session.ConversationLanguage.literal("en"),
                .preferences = .{
                    .model = @constCast("model-a"),
                    .effort = .auto,
                    .fast_mode = false,
                },
            } },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 2,
            .ts = 90,
            .event = .{ .preferences_changed = .{ .fast_mode = true } },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 3,
            .ts = 80,
            .event = .{ .workspace_rebound = .{
                .previous_workspace_root = @constCast("/tmp/a"),
                .workspace_root = @constCast("/tmp/b"),
            } },
        },
    };

    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    for (frames) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try jsonl.writer.writeAll(line);
    }

    var source = std.Io.Reader.fixed(jsonl.written());
    var reduced = try reduceJsonl(alloc, &source, null);
    defer reduced.deinit(alloc);
    try std.testing.expectEqual(@as(i64, 80), reduced.state.updated_at_ms);
    try std.testing.expectEqualStrings("/tmp/origin", reduced.state.origin_workspace_root);
    try std.testing.expectEqualStrings("/tmp/b", reduced.state.workspace_root);
    try std.testing.expect(reduced.state.preferences.fast_mode);

    var bad = frames[2];
    bad.event.workspace_rebound.previous_workspace_root = @constCast("/tmp/not-current");
    const bad_line = try encodeFrame(alloc, bad);
    defer alloc.free(bad_line);
    var bad_log: std.Io.Writer.Allocating = .init(alloc);
    defer bad_log.deinit();
    for (frames[0..2]) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try bad_log.writer.writeAll(line);
    }
    try bad_log.writer.writeAll(bad_line);
    var bad_source = std.Io.Reader.fixed(bad_log.written());
    try std.testing.expectError(error.ImmutableSessionIdentity, reduceJsonl(alloc, &bad_source, null));
}

test "semantic reducer resumes a contiguous suffix from owned state" {
    const alloc = std.testing.allocator;
    const initial = session_codec.DurableSessionState{
        .id = @constCast("session-tail"),
        .origin_workspace_root = @constCast("/tmp/origin"),
        .workspace_root = @constCast("/tmp/current"),
        .created_at_ms = 10,
        .updated_at_ms = 20,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = @constCast("model-a"),
            .effort = .auto,
            .fast_mode = false,
        },
        .history = @constCast(&.{}),
        .last_input_tokens = 1,
        .last_output_tokens = 2,
    };
    const envelope = Envelope{
        .session_id = @constCast("session-tail"),
        .seq = 5,
        .ts = 30,
        .event = .{ .preferences_changed = .{ .fast_mode = true } },
    };
    const line = try encodeFrame(alloc, envelope);
    defer alloc.free(line);

    var source = std.Io.Reader.fixed(line);
    var reduced = try reduceJsonlFrom(
        alloc,
        &source,
        try initial.dupe(alloc),
        .{ .next_seq = 5 },
    );
    defer reduced.deinit(alloc);
    try std.testing.expect(reduced.truncate_from == null);
    try std.testing.expect(reduced.state.preferences.fast_mode);
    try std.testing.expectEqual(@as(i64, 30), reduced.state.updated_at_ms);
    try std.testing.expectEqual(@as(u64, line.len), reduced.bytes_consumed);
    const through = reduced.through orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(@as(u64, 5), through.seq);
    try std.testing.expectEqual(@as(u64, line.len), through.byte_offset);

    var wrong_source = std.Io.Reader.fixed(line);
    try std.testing.expectError(
        error.NonContiguousSequence,
        reduceJsonlFrom(
            alloc,
            &wrong_source,
            try initial.dupe(alloc),
            .{ .next_seq = 4 },
        ),
    );
}

test "per-item lines rebuild one history turn without replaying its prefix" {
    const alloc = std.testing.allocator;
    const initial = singleEventTestState("session-single-event");
    var state = try initial.dupe(alloc);
    defer state.deinit(alloc);
    var fold = ItemFold{};
    defer fold.deinit(alloc);

    const lines = [_]Envelope{
        .{
            .session_id = @constCast("session-single-event"),
            .seq = 5,
            .ts = 25,
            .turn_id = @constCast("3"),
            .event = .{ .turn_started = .{
                .input = .{ .user = .{ .text = @constCast("inspect") } },
                .language = session.ConversationLanguage.literal("fr"),
            } },
        },
        .{
            .session_id = @constCast("session-single-event"),
            .seq = 6,
            .ts = 26,
            .turn_id = @constCast("3"),
            .item_id = @constCast("item-1"),
            .event = .{ .assistant_message_started = .{} },
        },
        .{
            .session_id = @constCast("session-single-event"),
            .seq = 7,
            .ts = 27,
            .turn_id = @constCast("3"),
            .item_id = @constCast("item-1"),
            .event = .{ .assistant_message_completed = .{ .text = @constCast("done") } },
        },
        .{
            .session_id = @constCast("session-single-event"),
            .seq = 8,
            .ts = 28,
            .turn_id = @constCast("3"),
            .item_id = @constCast("item-1"),
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-1"),
                .model = @constCast("test/model"),
                .input_tokens = 100,
                .output_tokens = 50,
            } },
        },
        .{
            .session_id = @constCast("session-single-event"),
            .seq = 9,
            .ts = 30,
            .turn_id = @constCast("3"),
            .event = .{ .turn_completed = .{ .outcome = .completed } },
        },
    };
    var boundary: ReductionBoundary = .{ .seq = 0, .byte_offset = 0 };
    for (lines) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        boundary = try applyEventFrame(
            alloc,
            &state,
            line,
            .{ .next_seq = frame.seq },
            &fold,
        );
    }

    try std.testing.expectEqual(@as(u64, 9), boundary.seq);
    try std.testing.expectEqual(@as(usize, 1), state.history.len);
    try std.testing.expectEqualStrings("done", state.history[0].assistant.assistant);
    try std.testing.expectEqualStrings("fr", state.conversation_language.view());
    try std.testing.expectEqual(@as(?u64, 100), state.last_input_tokens);
    try std.testing.expectEqual(@as(?u64, 50), state.last_output_tokens);
    try std.testing.expectEqual(@as(i64, 30), state.updated_at_ms);
}

test "single event application preserves caller-owned state on allocation failure" {
    const alloc = std.testing.allocator;
    const frames = [_]Envelope{
        .{
            .session_id = @constCast("session-single-event-oom"),
            .seq = 7,
            .ts = 30,
            .turn_id = @constCast("3"),
            .event = .{ .turn_started = .{
                .input = .{ .user = .{ .text = @constCast("new prompt") } },
                .language = session.ConversationLanguage.literal("fr"),
            } },
        },
        .{
            .session_id = @constCast("session-single-event-oom"),
            .seq = 8,
            .ts = 31,
            .turn_id = @constCast("3"),
            .item_id = @constCast("item-9"),
            .event = .{ .assistant_message_started = .{} },
        },
        .{
            .session_id = @constCast("session-single-event-oom"),
            .seq = 9,
            .ts = 32,
            .turn_id = @constCast("3"),
            .item_id = @constCast("item-9"),
            .event = .{ .assistant_message_completed = .{ .text = @constCast("new response") } },
        },
        .{
            .session_id = @constCast("session-single-event-oom"),
            .seq = 10,
            .ts = 33,
            .turn_id = @constCast("3"),
            .event = .{ .turn_completed = .{ .outcome = .completed } },
        },
    };
    var log: std.Io.Writer.Allocating = .init(alloc);
    defer log.deinit();
    for (frames) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try log.writer.writeAll(line);
    }
    const log_bytes = log.written();

    const AllocationCheck = struct {
        fn run(failing_alloc: Allocator, bytes: []const u8) !void {
            const initial = singleEventTestState("session-single-event-oom");
            var state = try initial.dupe(failing_alloc);
            defer state.deinit(failing_alloc);
            var fold = ItemFold{};
            defer fold.deinit(failing_alloc);
            var reader = std.Io.Reader.fixed(bytes);
            var seq: u64 = 7;
            while (true) {
                const line = readFrameLine(failing_alloc, &reader) catch |err| switch (err) {
                    error.EndOfStream => break,
                    else => return err,
                };
                defer failing_alloc.free(line);
                _ = applyEventFrame(
                    failing_alloc,
                    &state,
                    line,
                    .{ .next_seq = seq },
                    &fold,
                ) catch |err| {
                    // Earlier lines of the sequence may already have applied
                    // (per-item durability); only untouched fields are asserted.
                    try std.testing.expectEqualStrings("model-a", state.preferences.model);
                    try std.testing.expectEqualStrings("/tmp/current", state.workspace_root);
                    return err;
                };
                seq += 1;
            }
            try std.testing.expectEqual(@as(usize, 1), state.history.len);
            try std.testing.expectEqualStrings(
                "new response",
                state.history[0].assistant.assistant,
            );
            try std.testing.expectEqualStrings("fr", state.conversation_language.view());
        }
    };
    try std.testing.checkAllAllocationFailures(
        alloc,
        AllocationCheck.run,
        .{log_bytes},
    );
}

test "single event application validates boundaries for every semantic event kind" {
    const alloc = std.testing.allocator;
    const initial = singleEventTestState("session-single-event-kinds");
    var state = try initial.dupe(alloc);
    defer state.deinit(alloc);
    var fold = ItemFold{};
    defer fold.deinit(alloc);

    const events = [_]Envelope{
        .{
            .session_id = @constCast("session-single-event-kinds"),
            .seq = 5,
            .ts = 21,
            .event = .{ .preferences_changed = .{
                .model = @constCast("model-b"),
                .effort = types.ReasoningEffort.literal("high"),
                .fast_mode = true,
            } },
        },
        .{
            .session_id = @constCast("session-single-event-kinds"),
            .seq = 6,
            .ts = 22,
            .event = .{ .workspace_rebound = .{
                .previous_workspace_root = @constCast("/tmp/current"),
                .workspace_root = @constCast("/tmp/next"),
            } },
        },
        .{
            .session_id = @constCast("session-single-event-kinds"),
            .seq = 7,
            .ts = 23,
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-boundary"),
                .model = @constCast("model-b"),
                .input_tokens = 10,
                .output_tokens = 4,
            } },
        },
    };

    const started_line = try encodeFrame(alloc, .{
        .session_id = @constCast("session-single-event-kinds"),
        .seq = 5,
        .ts = 20,
        .event = .{ .session_started = .{
            .id = @constCast("session-single-event-kinds"),
            .created_at_ms = 10,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("model-a"),
                .effort = .auto,
                .fast_mode = false,
            },
        } },
    });
    defer alloc.free(started_line);
    try std.testing.expectError(
        error.InvalidEventFrame,
        applyEventFrame(
            alloc,
            &state,
            started_line,
            .{ .next_seq = 5 },
            &fold,
        ),
    );
    try std.testing.expectEqualStrings("model-a", state.preferences.model);

    for (events, 0..) |event, index| {
        const line = try encodeFrame(alloc, event);
        defer alloc.free(line);
        if (index == 1) {
            try std.testing.expectError(
                error.NonContiguousSequence,
                applyEventFrame(
                    alloc,
                    &state,
                    line,
                    .{ .next_seq = event.seq - 1 },
                    &fold,
                ),
            );
            try std.testing.expectEqualStrings("/tmp/current", state.workspace_root);
        }
        _ = try applyEventFrame(
            alloc,
            &state,
            line,
            .{ .next_seq = event.seq },
            &fold,
        );
    }

    try std.testing.expectEqualStrings("model-b", state.preferences.model);
    try std.testing.expectEqual(types.ReasoningEffort.literal("high"), state.preferences.effort);
    try std.testing.expect(state.preferences.fast_mode);
    try std.testing.expectEqualStrings("/tmp/next", state.workspace_root);
    try std.testing.expectEqual(@as(u64, 10), state.usage.?.input_tokens);
    try std.testing.expectEqual(@as(u64, 4), state.usage.?.output_tokens);
    try std.testing.expectEqual(@as(usize, 1), state.usage.?.models.len);
    try std.testing.expectEqualStrings("model-b", state.usage.?.models[0].model);
}

fn singleEventTestState(id: []const u8) session_codec.DurableSessionState {
    return .{
        .id = @constCast(id),
        .origin_workspace_root = @constCast("/tmp/origin"),
        .workspace_root = @constCast("/tmp/current"),
        .created_at_ms = 10,
        .updated_at_ms = 20,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = @constCast("model-a"),
            .effort = .auto,
            .fast_mode = false,
        },
        .history = @constCast(&.{}),
        .last_input_tokens = 1,
        .last_output_tokens = 2,
    };
}

test "semantic reducer releases owned state when the reduction start is invalid" {
    const alloc = std.testing.allocator;
    const initial = session_codec.DurableSessionState{
        .id = @constCast("session-invalid-start"),
        .origin_workspace_root = @constCast("/tmp/origin"),
        .workspace_root = @constCast("/tmp/current"),
        .created_at_ms = 10,
        .updated_at_ms = 20,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = @constCast("model-a"),
            .effort = types.ReasoningEffort.literal("low"),
            .fast_mode = false,
        },
        .history = @constCast(&.{}),
        .last_input_tokens = 1,
        .last_output_tokens = 2,
    };
    var source = std.Io.Reader.fixed("");
    try std.testing.expectError(
        error.InvalidReductionStart,
        reduceJsonlFrom(
            alloc,
            &source,
            try initial.dupe(alloc),
            .{ .next_seq = 0 },
        ),
    );
}

test "item lines leave absent session usage until the first usage_recorded" {
    const alloc = std.testing.allocator;

    const started = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-1"),
            .created_at_ms = 10,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("openai/gpt-test"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    };
    const turn_lines = [_]Envelope{
        .{
            .session_id = @constCast("session-1"),
            .seq = 2,
            .ts = 105,
            .turn_id = @constCast("1"),
            .event = .{ .turn_started = .{
                .input = .{ .user = .{
                    .text = @constCast("hello"),
                    .work_id = @constCast("work-17"),
                } },
                .language = session.ConversationLanguage.literal("fr"),
            } },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 3,
            .ts = 106,
            .turn_id = @constCast("1"),
            .item_id = @constCast("item-1"),
            .event = .{ .assistant_message_started = .{} },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 4,
            .ts = 107,
            .turn_id = @constCast("1"),
            .item_id = @constCast("item-1"),
            .event = .{ .assistant_message_completed = .{ .text = @constCast("world") } },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 5,
            .ts = 108,
            .turn_id = @constCast("1"),
            .item_id = @constCast("item-1"),
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-17"),
                .model = @constCast("openai/gpt-test"),
                .input_tokens = 128,
                .output_tokens = 64,
            } },
        },
        .{
            .session_id = @constCast("session-1"),
            .seq = 6,
            .ts = 110,
            .turn_id = @constCast("1"),
            .event = .{ .turn_completed = .{ .outcome = .completed } },
        },
    };

    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    const started_line = try encodeFrame(alloc, started);
    defer alloc.free(started_line);
    try jsonl.writer.writeAll(started_line);
    // Fold the turn without its usage line first: usage stays absent and
    // last-response counters stay unknown.
    for (turn_lines[0..3]) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try jsonl.writer.writeAll(line);
    }
    var partial_source = std.Io.Reader.fixed(jsonl.written());
    var partial = try reduceJsonl(alloc, &partial_source, null);
    defer partial.deinit(alloc);
    try std.testing.expect(partial.state.usage == null);
    try std.testing.expect(partial.state.last_input_tokens == null);
    try std.testing.expect(partial.state.last_output_tokens == null);
    try std.testing.expectEqualStrings("fr", partial.state.conversation_language.view());
    try std.testing.expectEqualStrings("work-17", partial.state.last_subagent_work_id.?);

    for (turn_lines[3..]) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try jsonl.writer.writeAll(line);
    }
    var source = std.Io.Reader.fixed(jsonl.written());
    var reduced = try reduceJsonl(alloc, &source, null);
    defer reduced.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 128), reduced.state.usage.?.input_tokens);
    try std.testing.expectEqual(@as(?u64, 128), reduced.state.last_input_tokens);
    try std.testing.expectEqual(@as(?u64, 64), reduced.state.last_output_tokens);
    try std.testing.expectEqual(@as(usize, 1), reduced.state.history.len);
    try std.testing.expectEqualStrings(
        "work-17",
        reduced.state.history[0].assistant.user.work_id.?,
    );
    try std.testing.expectEqualStrings(
        "world",
        reduced.state.history[0].assistant.assistant,
    );
}

test "retired history_turn_committed projects its turn and usage_checkpointed restores billing" {
    const alloc = std.testing.allocator;
    // Byte-faithful pre-inversion frame with the pre-rename total_* counter
    // keys. Old logs must project their turn, not drop it.
    const started_line =
        "{\"schema_version\":1,\"kind\":\"session_started\",\"session_id\":\"session-1\",\"ts\":100,\"seq\":1,\"payload\":{\"id\":\"session-1\",\"created_at_ms\":10,\"origin_workspace_root\":\"/tmp/origin\",\"workspace_root\":\"/tmp/current\",\"conversation_language\":\"en\",\"preferences\":{\"model\":\"test/model\",\"effort\":\"auto\",\"fast_mode\":false}}}\n";
    const committed_line =
        "{\"schema_version\":1,\"kind\":\"history_turn_committed\",\"session_id\":\"session-1\",\"ts\":110,\"seq\":2,\"payload\":{\"conversation_language\":\"en\",\"total_input_tokens\":128,\"total_output_tokens\":64,\"turn\":{\"kind\":\"assistant\",\"user\":{\"text\":\"hello\",\"images\":[]},\"assistant\":\"world\",\"execution\":{\"schema_version\":3,\"tool_steps\":[],\"files\":[]}}}}\n";

    var committed_frame = try decodeFrame(alloc, committed_line);
    defer committed_frame.deinit(alloc);
    try std.testing.expect(committed_frame == .known);
    try std.testing.expectEqual(Kind.history_turn_committed, committed_frame.known.kind());
    try std.testing.expectEqual(@as(u64, 2), committed_frame.seq());

    const checkpoint_model = session_usage.ModelAggregate{
        .model = @constCast("test/model"),
        .first_sequence = 1,
        .total_cost = 0.25,
        .input_tokens = 128,
        .output_tokens = 64,
        .request_count = 1,
    };
    var checkpoint_models = [_]session_usage.ModelAggregate{checkpoint_model};
    const checkpoint_usage = session_usage.Snapshot{
        .billing = .complete,
        .api_duration_complete = true,
        .wall_duration_complete = true,
        .code_complete = true,
        .next_sequence = 2,
        .settled_through_sequence = 1,
        .api_duration_ms = 0,
        .wall_duration_ms = 0,
        .total_cost = 0.25,
        .input_tokens = 128,
        .output_tokens = 64,
        .cache_read_tokens = 0,
        .cache_write_tokens = 0,
        .reasoning_tokens = null,
        .request_count = 1,
        .billable_web_search_calls = 0,
        .lines_added = 0,
        .lines_removed = 0,
        .models = &checkpoint_models,
        .pending = &.{},
        .publication_backlog = &.{},
        .incidents = &.{},
    };
    const checkpoint_line = try encodeFrame(alloc, .{
        .session_id = @constCast("session-1"),
        .seq = 3,
        .ts = 120,
        .event = .{ .usage_checkpointed = .{ .usage = checkpoint_usage } },
    });
    defer alloc.free(checkpoint_line);
    const associated_line = try encodeFrame(alloc, .{
        .session_id = @constCast("session-1"),
        .seq = 4,
        .ts = 130,
        .event = .{ .history_turn_committed = .{
            .conversation_language = session.ConversationLanguage.literal("en"),
            .last_input_tokens = 7,
            .last_output_tokens = 8,
            .work_id = @constCast("work-9"),
            .turn = .{ .assistant = .{
                .user = .{ .text = @constCast("second") },
                .assistant = @constCast("answer"),
            } },
        } },
    });
    defer alloc.free(associated_line);

    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    try jsonl.writer.writeAll(started_line);
    try jsonl.writer.writeAll(committed_line);
    try jsonl.writer.writeAll(checkpoint_line);
    try jsonl.writer.writeAll(associated_line);
    var source = std.Io.Reader.fixed(jsonl.written());
    var reduced = try reduceJsonl(alloc, &source, null);
    defer reduced.deinit(alloc);
    // The retired turn projects with its text and last-response counters.
    try std.testing.expectEqual(@as(usize, 2), reduced.state.history.len);
    try std.testing.expectEqualStrings("hello", reduced.state.history[0].assistant.user.text);
    try std.testing.expectEqualStrings("world", reduced.state.history[0].assistant.assistant);
    try std.testing.expectEqual(@as(?u64, 7), reduced.state.last_input_tokens);
    try std.testing.expectEqual(@as(?u64, 8), reduced.state.last_output_tokens);
    // The retired checkpoint restores billing instead of dropping it.
    try std.testing.expectEqual(@as(u64, 128), reduced.state.usage.?.input_tokens);
    try std.testing.expectEqual(@as(u64, 64), reduced.state.usage.?.output_tokens);
    try std.testing.expectEqual(@as(?f64, 0.25), reduced.state.usage.?.total_cost);
    // Event-side work ids still associate onto turns without one.
    try std.testing.expectEqualStrings("work-9", reduced.state.history[1].assistant.user.work_id.?);
    try std.testing.expectEqualStrings("work-9", reduced.state.last_subagent_work_id.?);
}

test "replay associates each turn_started work ID with its exact user turn" {
    const alloc = std.testing.allocator;
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    var state: ?session_codec.DurableSessionState = null;
    defer if (state) |*current| current.deinit(alloc);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("provenance-replay"),
        .seq = 1,
        .ts = 1,
        .event = .{ .session_started = .{
            .id = @constCast("provenance-replay"),
            .created_at_ms = 1,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = .auto,
                .fast_mode = false,
            },
        } },
    }, &fold);
    const prompts = [_]struct { text: []const u8, work_id: ?[]const u8 }{
        .{ .text = "first", .work_id = "work-first" },
        .{ .text = "second", .work_id = "work-second" },
        .{ .text = "ordinary", .work_id = null },
    };
    for (prompts, 0..) |prompt, index| {
        const seq: u64 = @intCast(2 + index * 2);
        var turn_id_buf: [8]u8 = undefined;
        const turn_id = try std.fmt.bufPrint(&turn_id_buf, "{d}", .{index + 1});
        try applyDelta(alloc, &state, .{
            .session_id = @constCast("provenance-replay"),
            .seq = seq,
            .ts = 2,
            .turn_id = @constCast(turn_id),
            .event = .{ .turn_started = .{
                .input = .{ .user = .{
                    .text = @constCast(prompt.text),
                    .work_id = if (prompt.work_id) |id| @constCast(id) else null,
                } },
            } },
        }, &fold);
        try applyDelta(alloc, &state, .{
            .session_id = @constCast("provenance-replay"),
            .seq = seq + 1,
            .ts = 3,
            .turn_id = @constCast(turn_id),
            .event = .{ .turn_completed = .{ .outcome = .completed } },
        }, &fold);
    }

    try std.testing.expectEqual(@as(usize, 3), state.?.history.len);
    try std.testing.expectEqualStrings(
        "work-first",
        state.?.history[0].assistant.user.work_id.?,
    );
    try std.testing.expectEqualStrings(
        "work-second",
        state.?.history[1].assistant.user.work_id.?,
    );
    try std.testing.expect(state.?.history[2].assistant.user.work_id == null);
    try std.testing.expectEqualStrings("work-second", state.?.last_subagent_work_id.?);
    try std.testing.expect(
        state.?.history[1].assistant.user.work_id.?.ptr !=
            state.?.last_subagent_work_id.?.ptr,
    );
}

test "per-item envelope rules reject missing ids and malformed work IDs" {
    const user = session.UserTurn{ .text = @constCast("prompt") };
    const base = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 1,
        .ts = 1,
        .turn_id = @constCast("4"),
        .event = .{ .turn_started = .{ .input = .{ .user = user } } },
    };
    try validateEnvelope(base);

    // Turn and item lines require their envelope correlation.
    var missing_turn = base;
    missing_turn.turn_id = null;
    try std.testing.expectError(error.InvalidEventFrame, validateEnvelope(missing_turn));

    var stray_item = base;
    stray_item.item_id = @constCast("item-1");
    try std.testing.expectError(error.InvalidEventFrame, validateEnvelope(stray_item));

    const message = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 2,
        .ts = 2,
        .turn_id = @constCast("4"),
        .event = .{ .assistant_message_started = .{} },
    };
    try std.testing.expectError(error.InvalidEventFrame, validateEnvelope(message));

    // A failed model call carries its cause and attempt number.
    const failed_bare = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 2,
        .ts = 2,
        .turn_id = @constCast("4"),
        .item_id = @constCast("item-1"),
        .event = .{ .assistant_message_completed = .{
            .text = @constCast("partial"),
            .outcome = .failed,
        } },
    };
    try std.testing.expectError(
        error.InvalidEventFrame,
        encodeFrame(std.testing.allocator, failed_bare),
    );
    const failed = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 2,
        .ts = 2,
        .turn_id = @constCast("4"),
        .item_id = @constCast("item-1"),
        .event = .{ .assistant_message_completed = .{
            .text = @constCast("partial"),
            .outcome = .failed,
            .cause = @constCast("transport_interrupted"),
            .attempt = 1,
        } },
    };
    try validateEnvelope(failed);

    // Malformed work IDs fail on the turn that carries them.
    var malformed = base;
    malformed.event.turn_started.input.user.work_id = @constCast("bad\x00id");
    try std.testing.expectError(error.InvalidEventFrame, validateEnvelope(malformed));

    // Run boundaries carry no turn or item correlation.
    const run = Envelope{
        .session_id = @constCast("session-1"),
        .seq = 3,
        .ts = 3,
        .turn_id = @constCast("4"),
        .event = .{ .run_started = .{
            .run_id = @constCast("run-1"),
            .fiber_version = @constCast("0.0.0"),
            .mode = .new,
        } },
    };
    try std.testing.expectError(error.InvalidEventFrame, validateEnvelope(run));
}

fn checkHistoryProvenanceReplayAllocationFailures(alloc: Allocator) !void {
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    var state: ?session_codec.DurableSessionState = null;
    defer if (state) |*current| current.deinit(alloc);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("allocation-provenance"),
        .seq = 1,
        .ts = 1,
        .event = .{ .session_started = .{
            .id = @constCast("allocation-provenance"),
            .created_at_ms = 1,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = .auto,
                .fast_mode = false,
            },
        } },
    }, &fold);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("allocation-provenance"),
        .seq = 2,
        .ts = 2,
        .turn_id = @constCast("1"),
        .event = .{ .turn_started = .{
            .input = .{ .user = .{
                .text = @constCast("prompt"),
                .work_id = @constCast("allocation-work"),
            } },
        } },
    }, &fold);
    try std.testing.expectEqualStrings(
        "allocation-work",
        state.?.history[0].assistant.user.work_id.?,
    );
}

test "history provenance replay frees every partial allocation" {
    try std.testing.checkAllAllocationFailures(
        std.testing.allocator,
        checkHistoryProvenanceReplayAllocationFailures,
        .{},
    );
}

test "usage_recorded event decodes one model call and folds its totals" {
    const alloc = std.testing.allocator;

    const line =
        "{\"schema_version\":1," ++
        "\"kind\":\"usage_recorded\"," ++
        "\"session_id\":\"session-checkpoint\"," ++
        "\"ts\":200," ++
        "\"turn_id\":\"2\"," ++
        "\"item_id\":\"item-7\"," ++
        "\"seq\":2," ++
        "\"payload\":{" ++
        "\"generation_id\":\"gen-7\"," ++
        "\"model\":\"test/model\"," ++
        "\"input_tokens\":10,\"output_tokens\":2," ++
        "\"cache_read_tokens\":1,\"cache_write_tokens\":0," ++
        "\"reasoning_tokens\":1,\"total_cost\":0.25," ++
        "\"billable_web_search_calls\":0}}\n";

    var decoded_frame_4 = try decodeFrame(alloc, line);
    defer decoded_frame_4.deinit(alloc);
    const decoded = &decoded_frame_4.known;
    try std.testing.expectEqualStrings("usage_recorded", @tagName(decoded.kind()));
    try std.testing.expectEqualStrings("gen-7", decoded.event.usage_recorded.generation_id);
    try std.testing.expectEqualStrings("item-7", decoded.item_id.?);
    try std.testing.expectEqual(@as(?f64, 0.25), decoded.event.usage_recorded.total_cost);

    const started = Envelope{
        .session_id = @constCast("session-checkpoint"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-checkpoint"),
            .created_at_ms = 100,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    };
    const started_line = try encodeFrame(alloc, started);
    defer alloc.free(started_line);
    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    try jsonl.writer.writeAll(started_line);
    try jsonl.writer.writeAll(line);
    var source = std.Io.Reader.fixed(jsonl.written());
    var reduced = try reduceJsonl(alloc, &source, null);
    defer reduced.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 10), reduced.state.usage.?.input_tokens);
    try std.testing.expectEqual(@as(u64, 2), reduced.state.usage.?.output_tokens);
    try std.testing.expectEqual(@as(?f64, 0.25), reduced.state.usage.?.total_cost);
    try std.testing.expectEqual(@as(?u64, 1), reduced.state.usage.?.request_count);
    try std.testing.expectEqual(@as(usize, 1), reduced.state.usage.?.models.len);
    try session_usage.validateSnapshot(reduced.state.usage.?);
    try std.testing.expectEqual(@as(i64, 200), reduced.state.updated_at_ms);
}

test "permission state change event round-trips without history" {
    const alloc = std.testing.allocator;
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    var state: ?session_codec.DurableSessionState = null;
    defer if (state) |*current| current.deinit(alloc);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-permission-event"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-permission-event"),
            .created_at_ms = 100,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    }, &fold);
    try std.testing.expectEqual(@as(u64, 1), state.?.permission_state.next_generation);

    var changed = session_permission_state.State{ .next_generation = 3 };
    defer changed.deinit(alloc);
    {
        // Scoped so the errdefers lapse once the rules own the copies.
        const canonical = try alloc.dupe(u8, "test-canonical");
        errdefer alloc.free(canonical);
        const display = try alloc.dupe(u8, "test-display");
        errdefer alloc.free(display);
        try changed.rules.append(alloc, .{
            .id = .{ .value = 1 },
            .key = try session_permission_state.RuleKey.init(.command, canonical),
            .display_identity = display,
            .decision = .allow,
            .generation = 2,
        });
    }
    const event = Envelope{
        .session_id = @constCast("session-permission-event"),
        .seq = 2,
        .ts = 150,
        .event = .{ .permission_state_changed = .{ .permission_state = changed } },
    };
    const line = try encodeFrame(alloc, event);
    defer alloc.free(line);
    var decoded_frame_5 = try decodeFrame(alloc, line);
    defer decoded_frame_5.deinit(alloc);
    const decoded = &decoded_frame_5.known;
    try std.testing.expectEqualStrings("permission_state_changed", @tagName(decoded.kind()));
    try std.testing.expectEqual(@as(u64, 3), decoded.event.permission_state_changed.permission_state.next_generation);

    const boundary = try applyEventFrame(
        alloc,
        &state.?,
        line,
        .{ .next_seq = 2 },
        &fold,
    );
    try std.testing.expectEqual(@as(u64, 2), boundary.seq);
    try std.testing.expectEqual(@as(u64, 3), state.?.permission_state.next_generation);
    try std.testing.expectEqual(@as(usize, 1), state.?.permission_state.rules.items.len);
    try std.testing.expectEqualStrings("test-display", state.?.permission_state.rules.items[0].display_identity);
    try std.testing.expectEqual(@as(usize, 0), state.?.history.len);
    try std.testing.expectEqual(@as(i64, 150), state.?.updated_at_ms);
}

test "later usage_recorded lines replace the same generation id" {
    const alloc = std.testing.allocator;
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    var state: ?session_codec.DurableSessionState = null;
    defer if (state) |*current| current.deinit(alloc);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-usage-order"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-usage-order"),
            .created_at_ms = 100,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    }, &fold);
    try std.testing.expect(state.?.usage == null);

    const records = [_]Envelope{
        .{
            .session_id = @constCast("session-usage-order"),
            .seq = 2,
            .ts = 110,
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-a"),
                .model = @constCast("test/model"),
                .input_tokens = 10,
                .output_tokens = 2,
                .total_cost = 0.25,
            } },
        },
        .{
            .session_id = @constCast("session-usage-order"),
            .seq = 3,
            .ts = 120,
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-b"),
                .model = @constCast("test/other"),
                .input_tokens = 4,
                .output_tokens = 1,
                .total_cost = 0.125,
            } },
        },
        // Late-settled cost for gen-a replaces its first line.
        .{
            .session_id = @constCast("session-usage-order"),
            .seq = 4,
            .ts = 130,
            .event = .{ .usage_recorded = .{
                .generation_id = @constCast("gen-a"),
                .model = @constCast("test/model"),
                .input_tokens = 10,
                .output_tokens = 2,
                .total_cost = 0.5,
            } },
        },
    };
    for (records) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        var decoded_frame = try decodeFrame(alloc, line);
        defer decoded_frame.deinit(alloc);
        try applyDelta(alloc, &state, decoded_frame.known, &fold);
    }
    try std.testing.expectEqual(@as(u64, 14), state.?.usage.?.input_tokens);
    try std.testing.expectEqual(@as(u64, 3), state.?.usage.?.output_tokens);
    try std.testing.expectEqual(@as(?f64, 0.625), state.?.usage.?.total_cost);
    try std.testing.expectEqual(@as(?u64, 2), state.?.usage.?.request_count);
    try std.testing.expectEqual(@as(usize, 2), state.?.usage.?.models.len);
    try std.testing.expectEqualStrings("test/model", state.?.usage.?.models[0].model);
    try std.testing.expectEqualStrings("test/other", state.?.usage.?.models[1].model);
    try session_usage.validateSnapshot(state.?.usage.?);
}

test "usage fold seeds from resumed state across checkpoint replay" {
    const alloc = std.testing.allocator;
    const started = Envelope{
        .session_id = @constCast("session-usage-seed"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-usage-seed"),
            .created_at_ms = 100,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    };
    const usage_a = Envelope{
        .session_id = @constCast("session-usage-seed"),
        .seq = 2,
        .ts = 110,
        .event = .{ .usage_recorded = .{
            .generation_id = @constCast("gen-a"),
            .model = @constCast("test/model"),
            .input_tokens = 10,
            .output_tokens = 2,
            .total_cost = 1.0,
        } },
    };
    var prefix: std.Io.Writer.Allocating = .init(alloc);
    defer prefix.deinit();
    for ([_]Envelope{ started, usage_a }) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try prefix.writer.writeAll(line);
    }
    var prefix_source = std.Io.Reader.fixed(prefix.written());
    var first = try reduceJsonl(alloc, &prefix_source, null);
    defer first.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 10), first.state.usage.?.input_tokens);

    // The suffix replays from that owned state like a checkpoint tail: its
    // generation adds onto the resumed totals instead of replacing them.
    const tail_line = try encodeFrame(alloc, .{
        .session_id = @constCast("session-usage-seed"),
        .seq = 3,
        .ts = 120,
        .event = .{ .usage_recorded = .{
            .generation_id = @constCast("gen-b"),
            .model = @constCast("test/model"),
            .input_tokens = 20,
            .output_tokens = 4,
            .total_cost = 2.0,
        } },
    });
    defer alloc.free(tail_line);
    var tail_source = std.Io.Reader.fixed(tail_line);
    var second = try reduceJsonlFrom(
        alloc,
        &tail_source,
        try first.state.dupe(alloc),
        .{ .next_seq = 3 },
    );
    defer second.deinit(alloc);
    try std.testing.expectEqual(@as(u64, 30), second.state.usage.?.input_tokens);
    try std.testing.expectEqual(@as(u64, 6), second.state.usage.?.output_tokens);
    try std.testing.expectEqual(@as(?f64, 3.0), second.state.usage.?.total_cost);
    try std.testing.expectEqual(@as(?u64, 2), second.state.usage.?.request_count);
    try std.testing.expectEqual(@as(u64, 3), second.state.usage.?.next_sequence);
    try session_usage.validateSnapshot(second.state.usage.?);
}

test "recovery checkpoint events replace and clear deterministically" {
    const alloc = std.testing.allocator;
    var fold = ItemFold{};
    defer fold.deinit(alloc);
    var state: ?session_codec.DurableSessionState = null;
    defer if (state) |*current| current.deinit(alloc);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-recovery-events"),
            .created_at_ms = 100,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("test/model"),
                .effort = types.ReasoningEffort.literal("medium"),
                .fast_mode = false,
            },
        } },
    }, &fold);

    const first = session_codec.RecoveryCheckpoint{
        .turn_id = 11,
        .user = .{ .text = @constCast("prompt") },
        .assistant_source = @constCast("partial"),
        .cause = .network_interrupted,
        .action = .continuing_response,
        .authority = .{ .provider = .codex, .model = @constCast("test/model") },
        .requested_fast_mode = false,
        .fast_mode = false,
        .max_provider_attempts = 10,
        .consumed_provider_attempts = 2,
    };
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 2,
        .ts = 110,
        .event = .{ .recovery_checkpoint_set = .{ .checkpoint = first } },
    }, &fold);
    try std.testing.expectEqualStrings("partial", state.?.recovery_checkpoint.?.assistant_source);

    var replacement = first;
    replacement.assistant_source = @constCast("partial plus more");
    replacement.consumed_provider_attempts = 3;
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 3,
        .ts = 120,
        .event = .{ .recovery_checkpoint_set = .{ .checkpoint = replacement } },
    }, &fold);
    try std.testing.expectEqualStrings(
        "partial plus more",
        state.?.recovery_checkpoint.?.assistant_source,
    );
    try std.testing.expectEqual(@as(usize, 3), state.?.recovery_checkpoint.?.consumed_provider_attempts);

    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 4,
        .ts = 130,
        .turn_id = @constCast("9"),
        .event = .{ .turn_started = .{
            .input = .{ .user = .{ .text = @constCast("prompt") } },
        } },
    }, &fold);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 5,
        .ts = 131,
        .turn_id = @constCast("9"),
        .event = .{ .turn_completed = .{ .outcome = .completed } },
    }, &fold);
    try std.testing.expect(state.?.recovery_checkpoint == null);

    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 6,
        .ts = 140,
        .event = .{ .recovery_checkpoint_set = .{ .checkpoint = replacement } },
    }, &fold);
    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 7,
        .ts = 150,
        .event = .{ .recovery_checkpoint_cleared = .{} },
    }, &fold);
    try std.testing.expect(state.?.recovery_checkpoint == null);

    try applyDelta(alloc, &state, .{
        .session_id = @constCast("session-recovery-events"),
        .seq = 8,
        .ts = 160,
        .event = .{ .recovery_checkpoint_cleared = .{} },
    }, &fold);
    try std.testing.expect(state.?.recovery_checkpoint == null);
}

fn identifier(seed: u8) Identifier {
    var value: Identifier = undefined;
    for (&value, 0..) |*byte, i| byte.* = seed +% @as(u8, @intCast(i));
    return value;
}

fn foreignSessionTestState() session_codec.DurableSessionState {
    return .{
        .id = @constCast("session-foreign-home"),
        .origin_workspace_root = @constCast("/tmp/origin"),
        .workspace_root = @constCast("/tmp/current"),
        .created_at_ms = 10,
        .updated_at_ms = 20,
        .conversation_language = session.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = @constCast("model-a"),
            .effort = .auto,
            .fast_mode = false,
        },
        .history = @constCast(&.{}),
        .last_input_tokens = 1,
        .last_output_tokens = 2,
    };
}

test "reducer rejects a foreign-session line without mutating state" {
    const alloc = std.testing.allocator;
    const frames = [_]Envelope{
        .{
            .session_id = @constCast("session-foreign-home"),
            .seq = 1,
            .ts = 100,
            .event = .{ .session_started = .{
                .id = @constCast("session-foreign-home"),
                .created_at_ms = 10,
                .origin_workspace_root = @constCast("/tmp/origin"),
                .workspace_root = @constCast("/tmp/current"),
                .conversation_language = session.ConversationLanguage.literal("en"),
                .preferences = .{
                    .model = @constCast("model-a"),
                    .effort = .auto,
                    .fast_mode = false,
                },
            } },
        },
        .{
            .session_id = @constCast("session-foreign-home"),
            .seq = 2,
            .ts = 110,
            .event = .{ .preferences_changed = .{ .fast_mode = true } },
        },
        .{
            .session_id = @constCast("session-foreign-away"),
            .seq = 3,
            .ts = 120,
            .event = .{ .preferences_changed = .{ .fast_mode = false } },
        },
    };

    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    for (frames) |frame| {
        const line = try encodeFrame(alloc, frame);
        defer alloc.free(line);
        try jsonl.writer.writeAll(line);
    }
    var source = std.Io.Reader.fixed(jsonl.written());
    try std.testing.expectError(error.SessionMismatch, reduceJsonl(alloc, &source, null));

    // A single foreign frame applied to owned state fails the same way
    // and leaves the caller's state untouched.
    const initial = foreignSessionTestState();
    var state = try initial.dupe(alloc);
    defer state.deinit(alloc);
    const foreign_line = try encodeFrame(alloc, frames[2]);
    defer alloc.free(foreign_line);
    var foreign_fold = ItemFold{};
    defer foreign_fold.deinit(alloc);
    try std.testing.expectError(
        error.SessionMismatch,
        applyEventFrame(alloc, &state, foreign_line, .{ .next_seq = 3 }, &foreign_fold),
    );
    try std.testing.expectEqualStrings("model-a", state.preferences.model);
    try std.testing.expect(!state.preferences.fast_mode);
    try std.testing.expectEqual(@as(i64, 20), state.updated_at_ms);
}

test "decoder ignores unknown envelope fields on known kinds" {
    const alloc = std.testing.allocator;
    const line =
        "{\"schema_version\":1," ++
        "\"kind\":\"preferences_changed\"," ++
        "\"session_id\":\"session-tolerant\"," ++
        "\"ts\":200," ++
        "\"future_field\":{\"nested\":[1,2]}," ++
        "\"seq\":2," ++
        "\"payload\":{\"fast_mode\":true}}\n";
    var frame = try decodeFrame(alloc, line);
    defer frame.deinit(alloc);
    const decoded = switch (frame) {
        .known => |*envelope| envelope,
        .unknown => return error.TestExpectedEqual,
    };
    try std.testing.expectEqual(Kind.preferences_changed, decoded.kind());
    try std.testing.expectEqualStrings("session-tolerant", decoded.session_id);
    try std.testing.expectEqual(@as(u64, 2), decoded.seq);
    try std.testing.expect(decoded.event.preferences_changed.fast_mode.?);
}

test "reducer skips unknown kinds while surrounding lines reduce" {
    const alloc = std.testing.allocator;
    const started = Envelope{
        .session_id = @constCast("session-skip"),
        .seq = 1,
        .ts = 100,
        .event = .{ .session_started = .{
            .id = @constCast("session-skip"),
            .created_at_ms = 10,
            .origin_workspace_root = @constCast("/tmp/origin"),
            .workspace_root = @constCast("/tmp/current"),
            .conversation_language = session.ConversationLanguage.literal("en"),
            .preferences = .{
                .model = @constCast("model-a"),
                .effort = .auto,
                .fast_mode = false,
            },
        } },
    };
    const finished = Envelope{
        .session_id = @constCast("session-skip"),
        .seq = 3,
        .ts = 120,
        .event = .{ .preferences_changed = .{ .fast_mode = true } },
    };
    const started_line = try encodeFrame(alloc, started);
    defer alloc.free(started_line);
    const finished_line = try encodeFrame(alloc, finished);
    defer alloc.free(finished_line);
    const future_line =
        "{\"schema_version\":1," ++
        "\"kind\":\"future_kind\"," ++
        "\"session_id\":\"session-skip\"," ++
        "\"ts\":110," ++
        "\"seq\":2," ++
        "\"payload\":{\"anything\":true}}\n";

    var jsonl: std.Io.Writer.Allocating = .init(alloc);
    defer jsonl.deinit();
    try jsonl.writer.writeAll(started_line);
    try jsonl.writer.writeAll(future_line);
    try jsonl.writer.writeAll(finished_line);
    var source = std.Io.Reader.fixed(jsonl.written());
    var reduced = try reduceJsonl(alloc, &source, null);
    defer reduced.deinit(alloc);
    try std.testing.expect(reduced.state.preferences.fast_mode);
    try std.testing.expectEqual(@as(i64, 120), reduced.state.updated_at_ms);
    const through = reduced.through orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(@as(u64, 3), through.seq);
    try std.testing.expectEqual(@as(u64, jsonl.written().len), reduced.bytes_consumed);
    try std.testing.expectEqual(@as(u64, jsonl.written().len), through.byte_offset);
}

test "emitted envelope carries exactly the v1 key set" {
    const alloc = std.testing.allocator;
    const bare = Envelope{
        .session_id = @constCast("session-keys"),
        .seq = 2,
        .ts = 200,
        .event = .{ .preferences_changed = .{ .fast_mode = true } },
    };
    const bare_line = try encodeFrame(alloc, bare);
    defer alloc.free(bare_line);
    try expectEnvelopeKeys(bare_line, &.{
        "schema_version", "kind", "session_id", "ts", "seq", "payload",
    });

    var correlated = bare;
    correlated.seq = 3;
    correlated.turn_id = @constCast("turn-1");
    correlated.item_id = @constCast("item-1");
    const correlated_line = try encodeFrame(alloc, correlated);
    defer alloc.free(correlated_line);
    try expectEnvelopeKeys(correlated_line, &.{
        "schema_version", "kind", "session_id", "ts", "turn_id", "item_id", "seq", "payload",
    });
    var frame = try decodeFrame(alloc, correlated_line);
    defer frame.deinit(alloc);
    const decoded = switch (frame) {
        .known => |*envelope| envelope,
        .unknown => return error.TestExpectedEqual,
    };
    try std.testing.expectEqualStrings("turn-1", decoded.turn_id.?);
    try std.testing.expectEqualStrings("item-1", decoded.item_id.?);
}

fn expectEnvelopeKeys(line: []const u8, expected: []const []const u8) !void {
    const alloc = std.testing.allocator;
    try std.testing.expect(line.len > 0 and line[line.len - 1] == '\n');
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, line[0 .. line.len - 1], .{});
    defer parsed.deinit();
    const root = try requireObject(parsed.value);
    try std.testing.expectEqual(expected.len, root.count());
    for (expected) |key| {
        try std.testing.expect(root.get(key) != null);
    }
    for ([_][]const u8{ "event_id", "log_generation", "timestamp_ms" }) |retired| {
        try std.testing.expect(std.mem.find(u8, line, retired) == null);
    }
}

test "decoder rejects the pre-v1 envelope and missing required keys" {
    const alloc = std.testing.allocator;
    const old_envelope =
        "{\"schema_version\":1," ++
        "\"log_generation\":\"000102030405060708090a0b0c0d0e0f\"," ++
        "\"seq\":2," ++
        "\"event_id\":\"101112131415161718191a1b1c1d1e1f\"," ++
        "\"timestamp_ms\":200," ++
        "\"kind\":\"preferences_changed\"," ++
        "\"payload\":{\"fast_mode\":true}}\n";
    try std.testing.expectError(error.InvalidEventFrame, decodeFrame(alloc, old_envelope));

    const bare = Envelope{
        .session_id = @constCast("session-keys"),
        .seq = 2,
        .ts = 200,
        .event = .{ .preferences_changed = .{ .fast_mode = true } },
    };
    const bare_line = try encodeFrame(alloc, bare);
    defer alloc.free(bare_line);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, bare_line[0 .. bare_line.len - 1], .{});
    defer parsed.deinit();
    for ([_][]const u8{ "seq", "payload", "session_id" }) |missing| {
        var robbed = try duplicateJsonObject(alloc, parsed.value.object);
        defer robbed.deinit();
        try std.testing.expect(robbed.value.object.orderedRemove(missing));
        const robbed_line = try stringifyJsonLine(alloc, robbed.value);
        defer alloc.free(robbed_line);
        try std.testing.expectError(error.InvalidEventFrame, decodeFrame(alloc, robbed_line));
    }
}

test "turn_completed rejects retired execution and interrupted carriers" {
    const alloc = std.testing.allocator;
    // #191 owns those fields: no tolerance reader for another slice's
    // carriers lives here, so inversion-era lines fail instead of
    // decoding and dropping them.
    const retired =
        "{\"schema_version\":1," ++
        "\"kind\":\"turn_completed\"," ++
        "\"session_id\":\"session-191\"," ++
        "\"ts\":100," ++
        "\"turn_id\":\"4\"," ++
        "\"seq\":2," ++
        "\"payload\":{\"outcome\":\"completed\",\"execution\":{},\"interrupted\":{}}}\n";
    try std.testing.expectError(error.InvalidEventFrame, decodeFrame(alloc, retired));
    const clean =
        "{\"schema_version\":1," ++
        "\"kind\":\"turn_completed\"," ++
        "\"session_id\":\"session-191\"," ++
        "\"ts\":100," ++
        "\"turn_id\":\"4\"," ++
        "\"seq\":2," ++
        "\"payload\":{\"outcome\":\"completed\"}}\n";
    var frame = try decodeFrame(alloc, clean);
    defer frame.deinit(alloc);
    const decoded = switch (frame) {
        .known => |*envelope| envelope,
        .unknown => return error.TestExpectedEqual,
    };
    try std.testing.expectEqual(Kind.turn_completed, decoded.kind());
    try std.testing.expectEqual(TurnOutcome.completed, decoded.event.turn_completed.outcome);
}

fn duplicateJsonObject(alloc: std.mem.Allocator, object: std.json.ObjectMap) !std.json.Parsed(std.json.Value) {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try std.json.Stringify.value(std.json.Value{ .object = object }, .{}, &out.writer);
    return try std.json.parseFromSlice(std.json.Value, alloc, out.written(), .{ .allocate = .alloc_always });
}

fn stringifyJsonLine(alloc: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try std.json.Stringify.value(value, .{}, &out.writer);
    try out.writer.writeByte('\n');
    return try out.toOwnedSlice();
}
