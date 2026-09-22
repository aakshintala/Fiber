// VM-granularity probe: N extensions as N separate Lua states vs one state with
// N per-extension _ENV tables. Also serves as the 5.4-vs-5.5 memory comparison
// (the iso55 crate is byte-identical; only the mlua lua feature differs).
use mlua::{Lua, LuaOptions, StdLib, Table, Value};

fn safe_libs() -> StdLib { StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE }

// A modest extension: a top-level global (tests collision) plus retained array
// data (exercises array allocation / the heap the GC manages).
const EXT: &str = r#"
marker = "loaded"
local data = {}
for i = 1, 1000 do data[i] = "entry number " .. i end
__retain = data
fiber.provider("acme", { chat = function(req) return #__retain end })
"#;

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps").args(["-o","rss=","-p",&std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn install_globals(lua: &Lua, t: &Table) {
    let fiber = lua.create_table().unwrap();
    fiber.set("provider", lua.create_function(|_, (_n, _s): (String, Table)| Ok(())).unwrap()).unwrap();
    fiber.set("tool", lua.create_function(|_, (_n, _s): (String, Table)| Ok(())).unwrap()).unwrap();
    t.set("fiber", fiber).unwrap();
    let host = lua.create_table().unwrap();
    host.set("emit", lua.create_function(|_, _s: String| Ok(())).unwrap()).unwrap();
    t.set("host", host).unwrap();
}

fn separate(n: usize) {
    let mut vms: Vec<Lua> = Vec::new();
    for _ in 0..n {
        let lua = Lua::new_with(safe_libs(), LuaOptions::default()).unwrap();
        let g = lua.globals();
        install_globals(&lua, &g);
        lua.load(EXT).exec().unwrap();
        vms.push(lua);
    }
    for lua in &vms { lua.gc_collect().ok(); }
    println!("RESULT separate n={n} rss_kib={}", rss_kib());
}

fn shared(n: usize) {
    let lua = Lua::new_with(safe_libs(), LuaOptions::default()).unwrap();
    let g = lua.globals();
    install_globals(&lua, &g); // fiber/host live in shared _G, read-through
    let mut envs: Vec<Table> = Vec::new();
    let mut collision = false;
    for i in 0..n {
        let env = lua.create_table().unwrap();
        let mt = lua.create_table().unwrap();
        mt.set("__index", g.clone()).unwrap();       // reads fall through to shared _G
        env.set_metatable(Some(mt)).unwrap();         // writes (no __newindex) rawset on env => private
        lua.load(EXT).set_environment(env.clone()).exec().unwrap();
        // isolation check: each env has its own marker/__retain; _G stays clean
        let m: Option<String> = env.get("marker").ok();
        if m.as_deref() != Some("loaded") { collision = true; }
        if i > 0 {
            // confirm this env's retain is distinct object from env[0]'s
            let r_here: Table = env.get("__retain").unwrap();
            let r_first: Table = envs[0].get("__retain").unwrap();
            if r_here == r_first { collision = true; }
        }
        envs.push(env);
    }
    let leaked: Value = g.get("marker").unwrap();     // must be nil: no write leaked to shared
    lua.gc_collect().ok();
    println!("RESULT shared n={n} rss_kib={} global_isolation={} shared_G_marker_leaked={}",
             rss_kib(), if collision {"BROKEN"} else {"ok"},
             !matches!(leaked, Value::Nil));
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let n: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    match mode.as_str() {
        "separate" => separate(n),
        "shared" => shared(n),
        _ => eprintln!("usage: separate|shared N"),
    }
}
