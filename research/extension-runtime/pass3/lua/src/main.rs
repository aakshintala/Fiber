// Pass-3 execution scorer, mlua backend (Lua 5.4 here; the luau crate differs
// only in the embedding). Loads a model-generated extension into the real
// interpreter with a stub host that replays the pass-2 SSE transcript through
// http_stream, invokes the registered `acme` provider, and checks the emitted
// text against expected.txt. The judge is this program, not a model.
use mlua::{Function, Lua, LuaOptions, LuaSerdeExt, StdLib, Table, Value};
use std::sync::{Arc, Mutex};

fn safe_libs() -> StdLib {
    StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE
}

// Glue installed before the extension loads: fiber.provider/tool capture into
// globals the scorer reads back. Matches the documented registration API.
const GLUE: &str = r#"
__providers = {}
__tools = {}
fiber = {
  provider = function(name, spec) __providers[name] = spec end,
  tool = function(name, spec) __tools[name] = spec end,
}
"#;

// Drives the registered provider exactly as the host would begin a turn.
const DRIVER: &str = r#"
__providers.acme.chat({
  model = "acme-large",
  max_tokens = 1024,
  messages = { { role = "user", content = "hello" } },
})
"#;

fn main() {
    let path = std::env::args().nth(1).expect("usage: score-lua <ext-file>");
    let src = std::fs::read_to_string(&path).expect("read ext");
    let sse = std::fs::read_to_string("../transcript.sse").expect("transcript.sse");
    let lines: Vec<String> = sse.lines().map(|s| s.to_string()).collect();
    let expected = std::fs::read_to_string("../expected.txt").expect("expected.txt");
    let name = std::path::Path::new(&path).file_name().unwrap().to_string_lossy();

    let lua = Lua::new_with(safe_libs(), LuaOptions::default()).expect("new_with");
    let emitted = Arc::new(Mutex::new(String::new()));

    install_host(&lua, emitted.clone(), lines);
    lua.load(GLUE).exec().expect("glue");

    let mut loaded = "yes";
    let mut ran = "no";
    let mut err = String::new();

    if let Err(e) = lua.load(&src).set_name(&*name).exec() {
        loaded = "no";
        err = first_line(&e.to_string());
    } else if let Err(e) = lua.load(DRIVER).exec() {
        err = first_line(&e.to_string());
    } else {
        ran = "yes";
    }

    let got = emitted.lock().unwrap().clone();
    let matched = if got.trim_end() == expected.trim_end() { "yes" } else { "no" };

    println!("RESULT score file={name} loaded={loaded} ran={ran} match={matched} \
              emit_len={} expected_len={} err={err}", got.len(), expected.trim_end().len());
}

fn install_host(lua: &Lua, emitted: Arc<Mutex<String>>, lines: Vec<String>) {
    let host = lua.create_table().unwrap();
    host.set("secret", lua.create_function(|_, _n: String| Ok("test-key".to_string())).unwrap()).unwrap();
    host.set("log", lua.create_function(|_, _m: Value| Ok(())).unwrap()).unwrap();
    // non-streaming http: stub 200 with empty JSON body (the reference tool path)
    host.set("http", lua.create_function(|lua, _opts: Table| {
        let t = lua.create_table()?;
        t.set("status", 200)?;
        t.set("body", "{}")?;
        Ok(t)
    }).unwrap()).unwrap();
    let em = emitted.clone();
    host.set("emit", lua.create_function(move |_, s: String| {
        em.lock().unwrap().push_str(&s);
        Ok(())
    }).unwrap()).unwrap();
    // streaming http: replay the transcript through the extension's callback
    host.set("http_stream", lua.create_function(move |_, (_opts, on_line): (Table, Function)| {
        for line in &lines {
            on_line.call::<()>(line.as_str())?;
        }
        Ok(())
    }).unwrap()).unwrap();
    lua.globals().set("host", host).unwrap();

    let json = lua.create_table().unwrap();
    json.set("decode", lua.create_function(|lua, s: String| {
        let v: serde_json::Value = serde_json::from_str(&s)
            .map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
        lua.to_value(&v)
    }).unwrap()).unwrap();
    json.set("encode", lua.create_function(|lua, v: Value| {
        let jv: serde_json::Value = lua.from_value(v)?;
        serde_json::to_string(&jv).map_err(|e| mlua::Error::RuntimeError(e.to_string()))
    }).unwrap()).unwrap();
    lua.globals().set("json", json).unwrap();
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(120).collect()
}
