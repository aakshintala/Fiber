// Cost of handing a value to a Lua hook and taking its answer back, for #48.
// Rust -> Lua table (mlua serde), a gsub redaction in Lua, Lua -> Rust.
use mlua::{Lua, LuaSerdeExt, StdLib, LuaOptions, Function, Value};
use serde_json::json;
use std::time::Instant;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(feature = "jemalloc")]
#[global_allocator]
static ALLOC: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const HOOK: &str = r#"
return function(v)
  if v.content then
    for _, part in ipairs(v.content) do
      if part.text then part.text = part.text:gsub("sk%-[%w]+", "[redacted]") end
    end
  elseif v.messages then
    v.system = v.system:gsub("sk%-[%w]+", "[redacted]")
    for _, m in ipairs(v.messages) do
      if type(m.content) == "string" then m.content = m.content:gsub("sk%-[%w]+", "[redacted]") end
    end
  end
  return v
end
"#;

fn text(bytes: usize) -> String {
    let line = "drwxr-xr-x  12 user staff   384 Sep 24 10:00 src/core/loop.rs token=sk-abc123DEF456\n";
    line.repeat(bytes / line.len() + 1)[..bytes].to_string()
}

fn tool_result(bytes: usize) -> serde_json::Value {
    json!({ "status": "completed", "content": [{ "type": "text", "text": text(bytes) }],
            "details": { "exit_code": 0 }, "process": { "exit_code": 0, "timed_out": false } })
}

fn request(messages: usize) -> serde_json::Value {
    let msgs: Vec<_> = (0..messages).map(|i| {
        if i % 2 == 0 { json!({ "role": "user", "content": text(200) }) }
        else { json!({ "role": "assistant", "content": text(300),
                       "tool_calls": [{ "id": format!("c{i}"), "name": "shell", "arguments": { "cmd": "ls -la" } }] }) }
    }).collect();
    json!({ "model": "anthropic/claude-opus-5-5", "system": text(4096), "messages": msgs })
}

fn median(mut v: Vec<f64>) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] }

fn bench(lua: &Lua, hook: &Function, label: &str, v: &serde_json::Value) {
    let size = serde_json::to_vec(v).unwrap().len();
    let mut to_lua = vec![]; let mut call = vec![]; let mut from_lua = vec![];
    for i in 0..220 {
        let t0 = Instant::now();
        let lv: Value = lua.to_value(v).unwrap();
        let t1 = Instant::now();
        let out: Value = hook.call(lv).unwrap();
        let t2 = Instant::now();
        let back: serde_json::Value = lua.from_value(out).unwrap();
        let t3 = Instant::now();
        assert!(!serde_json::to_string(&back).unwrap().contains("sk-abc"));
        if i >= 20 {
            to_lua.push((t1 - t0).as_secs_f64() * 1e6);
            call.push((t2 - t1).as_secs_f64() * 1e6);
            from_lua.push((t3 - t2).as_secs_f64() * 1e6);
        }
    }
    println!("| {label} | {} KiB | {:.0} µs | {:.0} µs | {:.0} µs | {:.0} µs |", size / 1024,
        median(to_lua.clone()), median(call.clone()), median(from_lua.clone()),
        median(to_lua.iter().zip(&call).zip(&from_lua).map(|((a, b), c)| a + b + c).collect()));
}

fn main() {
    let lua = Lua::new_with(StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE,
                            LuaOptions::default()).unwrap();
    let hook: Function = lua.load(HOOK).eval().unwrap();
    println!("| value | JSON size | to Lua | hook | to Rust | total (median of 200, after 20 warmup) |");
    println!("|---|---|---|---|---|---|");
    bench(&lua, &hook, "tool result, 16 KiB content (default cap)", &tool_result(16 * 1024));
    bench(&lua, &hook, "tool result, 1 MiB content (artifact-sized)", &tool_result(1024 * 1024));
    bench(&lua, &hook, "model request, 200 messages", &request(200));
    bench(&lua, &hook, "model request, 1000 messages", &request(1000));
}
