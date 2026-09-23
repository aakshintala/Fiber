// Throwaway RSS probe for aakshintala/fiber#76. Not Fiber code.
//
// rss-probe idle
// rss-probe run   N KB TLS COMPS   N sessions in this process (TLS = shared|per)
// rss-probe spawn N KB COMPS       N child processes, each `run 1 KB per COMPS`
// COMPS: comma list of lua,sql,tls,conv,thread (or "all")
// Prints "READY <pid> <pid>..." once every session is initialised, then idles.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};

struct Session {
    _lua: Option<mlua::Lua>,
    _db: Option<rusqlite::Connection>,
    _tls: Option<Arc<rustls::ClientConfig>>,
    _conv: Option<Vec<serde_json::Value>>,
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

// ~5 KB of Lua: a module of small functions, like one extension.
fn lua_script() -> String {
    let mut s = String::from("local M = {}\nlocal state = { calls = 0, names = {} }\n");
    for i in 0..40 {
        s += &format!(
            "function M.tool_{i}(args)\n  state.calls = state.calls + 1\n  local out = {{}}\n  for k, v in pairs(args or {{}}) do out[#out+1] = tostring(k) .. '=' .. tostring(v) end\n  return table.concat(out, ',') .. string.rep('x', {i})\nend\nstate.names[#state.names+1] = 'tool_{i}'\n"
        );
    }
    s += "M.state = state\nfor _, n in ipairs(state.names) do M[n]({a = 1, b = 'two'}) end\nreturn M\n";
    s
}

fn conversation(kb: usize, seed: usize) -> Vec<serde_json::Value> {
    let mut msgs = Vec::new();
    let mut bytes = 0;
    let mut x = seed as u64 * 2654435761 + 1;
    while bytes < kb * 1024 {
        let text: String = (0..2000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (b'a' + (x % 26) as u8) as char
            })
            .collect();
        let role = if msgs.len() % 2 == 0 { "user" } else { "assistant" };
        let m = serde_json::json!({"role": role, "content": [{"type": "text", "text": text}]});
        bytes += serde_json::to_string(&m).unwrap().len();
        msgs.push(m);
    }
    msgs
}

fn build(i: usize, kb: usize, comps: &str, shared: Option<Arc<rustls::ClientConfig>>) -> Session {
    let has = |c| comps == "all" || comps.split(',').any(|x| x == c);
    let lua = has("lua").then(|| {
        let lua = mlua::Lua::new();
        let m: mlua::Table = lua.load(lua_script()).eval().unwrap();
        lua.globals().set("ext", m).unwrap();
        lua
    });
    let db = has("sql").then(|| {
        let dir = std::env::temp_dir().join("rss-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}-{i}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE ev(id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        for n in 0..100 {
            c.execute("INSERT INTO ev(body) VALUES (?1)", [format!("event {n} {}", "y".repeat(200))]).unwrap();
        }
        let _: i64 = c.query_row("SELECT count(*) FROM ev", [], |r| r.get(0)).unwrap();
        c
    });
    let tls = has("tls").then(|| shared.unwrap_or_else(tls_config));
    let conv = has("conv").then(|| conversation(kb, i + 1));
    Session { _lua: lua, _db: db, _tls: tls, _conv: conv }
}

// Round 2: synthetic extension set sized from pi-rig (non-test TS LOC per extension, plus shared/).
const EXT_LOC: &[usize] = &[
    225, 10, 5583, 774, 330, 645, 261, 19, 335, 145, 309, 1245, 556, 1071, 59, 139, 277, 2452, // 18 extensions
    1475, // shared/ helpers, as one module
];

// One extension module of about `loc` lines: functions, config tables, string constants,
// and hook registrations, the way a pi extension registers tools and event handlers.
fn ext_source(e: usize, loc: usize) -> String {
    let mut s = format!("local M = {{ name = 'ext_{e}', S = {{}}, C = {{}} }}\nlocal state = {{ calls = 0 }}\n");
    let mut lines = 2;
    let mut i = 0;
    while lines < loc {
        s += &format!(
            "function M.f_{i}(ctx, args)\n  local out = {{}}\n  if args == nil then return nil end\n  for k, v in pairs(args) do\n    if type(v) == 'string' then out[#out + 1] = k .. '=' .. v\n    else out[#out + 1] = tostring(k) end\n  end\n  state.calls = state.calls + 1\n  return table.concat(out, M.S.sep_{i} or ',')\nend\n"
        );
        lines += 10;
        if i % 3 == 0 {
            s += &format!(
                "M.S.msg_{i} = 'ext {e} message {i}: the operation could not complete because the input was not valid'\nM.S.sep_{i} = ', '\n"
            );
            lines += 2;
        }
        if i % 5 == 0 {
            s += &format!(
                "M.C.tool_{i} = {{\n  name = 'ext_{e}_tool_{i}',\n  description = 'Runs step {i} of extension {e} and returns a short text summary of the result',\n  params = {{ path = 'string', limit = 'number', verbose = 'boolean' }},\n  limits = {{ 1, 2, 4, 8, 16 }},\n  handler = M.f_{i},\n}}\nfiber_register('ext_{e}', 'tool_{i}', M.C.tool_{i})\n"
            );
            lines += 9;
        }
        i += 1;
    }
    s += "for k, f in pairs(M) do if type(f) == 'function' then f({}, { a = 'x', b = 2 }) end end\nreturn M\n";
    s
}

fn ext_set() -> Vec<String> {
    EXT_LOC.iter().enumerate().map(|(e, &l)| ext_source(e, l)).collect()
}

// Load the whole extension set into a fresh state. `chunks` = precompiled bytecode, else source.
fn load_set(lua: &mlua::Lua, srcs: &[String], chunks: Option<&[Vec<u8>]>) {
    let reg = lua.create_table().unwrap();
    let r2 = reg.clone();
    lua.globals()
        .set(
            "fiber_register",
            lua.create_function(move |_, (e, n, t): (String, String, mlua::Table)| r2.set(format!("{e}.{n}"), t))
                .unwrap(),
        )
        .unwrap();
    lua.globals().set("fiber_registry", reg).unwrap();
    let exts = lua.create_table().unwrap();
    for (e, src) in srcs.iter().enumerate() {
        let chunk = match chunks {
            Some(c) => lua.load(&c[e][..]).set_mode(mlua::chunk::ChunkMode::Binary),
            None => lua.load(src.as_str()),
        };
        let m: mlua::Table = chunk.set_name(format!("ext_{e}")).eval().unwrap();
        exts.set(e + 1, m).unwrap();
    }
    lua.globals().set("exts", exts).unwrap();
    lua.gc_collect().unwrap();
    lua.gc_collect().unwrap();
}

fn park() -> ! {
    loop {
        std::thread::park();
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("idle") => {
            println!("READY {}", std::process::id());
            std::io::stdout().flush().unwrap();
            park()
        }
        Some("run") => {
            let n: usize = a[2].parse().unwrap();
            let kb: usize = a[3].parse().unwrap();
            let comps = a[5].clone();
            let shared = (a[4] == "shared").then(tls_config);
            let threaded = comps == "all" || comps.split(',').any(|x| x == "thread");
            let mut held = Vec::new();
            let (tx, rx) = mpsc::channel::<()>();
            let mut loops = Vec::new();
            for i in 0..n {
                if threaded {
                    // The session lives on its own loop thread, blocked on a channel (ADR 0004).
                    let (tx, comps, shared) = (tx.clone(), comps.clone(), shared.clone());
                    let (_ltx, lrx) = mpsc::channel::<()>();
                    loops.push(_ltx);
                    std::thread::spawn(move || {
                        let _s = build(i, kb, &comps, shared);
                        tx.send(()).unwrap();
                        let _ = lrx.recv();
                    });
                } else {
                    held.push(build(i, kb, &comps, shared.clone()));
                }
            }
            if threaded {
                for _ in 0..n {
                    rx.recv().unwrap();
                }
            }
            println!("READY {}", std::process::id());
            std::io::stdout().flush().unwrap();
            park()
        }
        // luaset N MODE: N Lua states in this process, each with the whole extension set.
        // MODE: src (compile source per state) | bin (shared bytecode, debug info kept)
        //       | strip (shared bytecode, debug info stripped) | stats (print sizes, exit)
        Some("luaset") => {
            let n: usize = a[2].parse().unwrap();
            let srcs = ext_set();
            let chunks: Option<Vec<Vec<u8>>> = (a[3] != "src").then(|| {
                let tmp = mlua::Lua::new();
                srcs.iter()
                    .map(|s| tmp.load(s.as_str()).into_function().unwrap().dump(a[3] == "strip"))
                    .collect()
            });
            if a[3] == "stats" {
                let lua = mlua::Lua::new();
                let before = lua.used_memory();
                load_set(&lua, &srcs, None);
                let dbg: usize = chunks.as_ref().unwrap().iter().map(Vec::len).sum();
                let tmp = mlua::Lua::new();
                let stripped: usize = srcs.iter().map(|s| tmp.load(s.as_str()).into_function().unwrap().dump(true).len()).sum();
                let loc: usize = srcs.iter().map(|s| s.lines().count()).sum();
                let bytes: usize = srcs.iter().map(String::len).sum();
                let fns = lua.load("local n=0 for _,m in ipairs(exts) do for _,f in pairs(m) do if type(f)=='function' then n=n+1 end end end return n").eval::<usize>().unwrap();
                println!("modules={} loc={loc} source_bytes={bytes} functions={fns} bytecode_bytes={dbg} stripped_bytecode_bytes={stripped} lua_used_memory_empty={before} lua_used_memory_loaded={}", srcs.len(), lua.used_memory());
                return;
            }
            let states: Vec<mlua::Lua> = (0..n)
                .map(|_| {
                    let lua = mlua::Lua::new();
                    load_set(&lua, &srcs, chunks.as_deref());
                    lua
                })
                .collect();
            if a.get(4).map(String::as_str) != Some("keepsrc") {
                drop(srcs);
            }
            let _keep = (states, chunks);
            println!("READY {}", std::process::id());
            std::io::stdout().flush().unwrap();
            park()
        }
        // json FILE: hold FILE parsed as serde_json::Value.
        Some("json") => {
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&a[2]).unwrap()).unwrap();
            let _keep = v;
            println!("READY {}", std::process::id());
            std::io::stdout().flush().unwrap();
            park()
        }
        Some("spawn") => {
            let exe = std::env::current_exe().unwrap();
            let mut pids = vec![std::process::id()];
            let mut kids = Vec::new();
            for _ in 0..a[2].parse::<usize>().unwrap() {
                let mut c = Command::new(&exe)
                    .args(["run", "1", &a[3], "per", &a[4]])
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut line = String::new();
                BufReader::new(c.stdout.take().unwrap()).read_line(&mut line).unwrap();
                pids.push(line.split_whitespace().nth(1).unwrap().parse().unwrap());
                kids.push(c);
            }
            println!("READY {}", pids.iter().map(u32::to_string).collect::<Vec<_>>().join(" "));
            std::io::stdout().flush().unwrap();
            park()
        }
        _ => eprintln!("usage: see top of main.rs"),
    }
}
