// Pass-2 streaming-provider shape, mlua backend (Luau here; the lua54 crate
// is byte-identical but for the embedding). Measures RSS across a realistic
// provider workload: N interpreters each holding a "provider" extension that
// JSON-decodes every SSE event, filters text deltas, and accumulates the
// assistant message across a full turn, over many turns, then goes idle.
//
// JSON strategy (arg 1):
//   serde    - host decodes with serde_json and hands the script a Lua table
//              via mlua's LuaSerdeExt (the idiomatic, zero-extra-code path).
//   ondemand - host parses nothing eagerly; script pulls only the fields it
//              needs through host callbacks. (added in a later iteration)
use mlua::{Lua, LuaOptions, LuaSerdeExt, StdLib, Value};

fn safe_libs() -> StdLib {
    StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE
}

// The standin extension, in the target language. Host owns SSE framing; the
// script sees one line at a time and owns parse + filter + accumulate.
const EXT_SERDE: &str = r#"
local acc = {}
function reset() acc = {} end
function on_line(line)
  if string.sub(line, 1, 6) ~= "data: " then return end
  local payload = string.sub(line, 7)
  if payload == "[DONE]" then return end
  local ev = json_decode(payload)
  local d = ev.delta
  if ev.type == "content_block_delta" and d and d.type == "text_delta" then
    acc[#acc + 1] = d.text
  end
end
function get_result() return table.concat(acc) end
"#;

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn make_instance(strategy: &str) -> Lua {
    let lua = Lua::new_with(safe_libs(), LuaOptions::default()).expect("new_with");
    lua.sandbox(true).expect("sandbox");
    match strategy {
        "serde" => {
            let decode = lua.create_function(|lua, s: String| {
                let v: serde_json::Value = serde_json::from_str(&s)
                    .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
                lua.to_value(&v)
            }).expect("create_function");
            lua.globals().set("json_decode", decode).expect("set");
            lua.load(EXT_SERDE).exec().expect("load ext");
        }
        other => panic!("strategy not yet implemented: {other}"),
    }
    lua
}

fn run_turn(lua: &Lua, lines: &[&str]) -> String {
    let reset: mlua::Function = lua.globals().get("reset").expect("reset");
    reset.call::<()>(()).expect("reset call");
    let on_line: mlua::Function = lua.globals().get("on_line").expect("on_line");
    for line in lines {
        on_line.call::<()>(*line).expect("on_line call");
    }
    let get: mlua::Function = lua.globals().get("get_result").expect("get_result");
    get.call::<String>(()).expect("get_result call")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let strategy = args.get(1).map(|s| s.as_str()).unwrap_or("serde");
    let turns: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(50);
    let instances: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);

    let sse = std::fs::read_to_string("../transcript.sse").expect("transcript.sse");
    let lines: Vec<&str> = sse.lines().collect();
    let expected = std::fs::read_to_string("../expected.txt").expect("expected.txt");

    let rss_start = rss_kib();
    let mut insts: Vec<Lua> = (0..instances).map(|_| make_instance(strategy)).collect();
    let rss_loaded = rss_kib();

    let mut rss_peak = rss_loaded;
    let mut verify = "ok";
    for t in 0..turns {
        for lua in &mut insts {
            let got = run_turn(lua, &lines);
            if t == 0 && got.trim_end() != expected.trim_end() {
                verify = "MISMATCH";
            }
        }
        let r = rss_kib();
        if r > rss_peak { rss_peak = r; }
    }
    let rss_end = rss_kib();
    for lua in &insts { lua.gc_collect().ok(); lua.gc_collect().ok(); }
    // idle: hold instances, let allocator settle
    std::thread::sleep(std::time::Duration::from_millis(200));
    let rss_idle = rss_kib();

    println!("RESULT stream strategy={strategy} instances={instances} turns={turns} \
              verify={verify} rss_start_kib={rss_start} rss_loaded_kib={rss_loaded} \
              rss_peak_kib={rss_peak} rss_end_kib={rss_end} rss_after_idle_gc_kib={rss_idle}");
    let _ = Value::Nil; // keep import if strategies trimmed
}
