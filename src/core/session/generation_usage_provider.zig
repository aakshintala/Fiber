pub const Record = struct {
    id: []const u8,
    created_at_ms: i64 = 0,
    model: []const u8,
    total_cost: f64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    reasoning_tokens: ?u64 = null,
    billable_web_search_calls: u64,
};
