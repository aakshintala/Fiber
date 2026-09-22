// Pass-1 disqualification probe, Luau via mlua 0.12 (feature "luau").
// Mirrors probe-lua, but Luau replaces the debug hook with a purpose-built
// interrupt, and adds a first-class sandbox() the 5.4 backend does not have.
use mlua::{Lua, LuaOptions, StdLib, Value, VmState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn safe_libs() -> StdLib {
    StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE
}

/// `sandboxed` turns on Luau's own sandbox mode, which the 5.4 backend lacks.
fn lua(sandboxed: bool) -> Lua {
    let lua = Lua::new_with(safe_libs(), LuaOptions::default()).expect("new_with");
    if sandboxed {
        lua.sandbox(true).expect("sandbox");
    }
    lua
}

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(90).collect()
}

fn alive(lua: &Lua) -> bool {
    lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false)
}

/// The question Luau exists to answer here: does its interrupt survive pcall,
/// where Lua 5.4's debug hook did not?
fn probe_interrupt(guarded: bool) {
    let lua = lua(true);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    lua.set_interrupt(move |_| {
        if flag.load(Ordering::Relaxed) {
            Err(mlua::Error::RuntimeError("deadline exceeded".into()))
        } else {
            Ok(VmState::Continue)
        }
    });

    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });

    let src = if guarded {
        "local ok = pcall(function() while true do end end) return 'swallowed'"
    } else {
        "while true do end"
    };
    let name = if guarded { "interrupt_guarded" } else { "interrupt" };
    let t0 = Instant::now();
    let r = lua.load(src).exec();
    let elapsed = t0.elapsed();
    stop.store(false, Ordering::Relaxed); // clear the deadline, as a host would
    match r {
        Err(e) => println!("RESULT {name} PASS stopped_after={elapsed:?} reusable={} err={}",
                           alive(&lua), first_line(&e.to_string())),
        Ok(()) => println!("RESULT {name} FAIL script_escaped_deadline after={elapsed:?}"),
    }
}

/// Adversarial: retry the pcall forever.
fn probe_interrupt_adversarial() {
    let lua = lua(true);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    lua.set_interrupt(move |_| {
        if flag.load(Ordering::Relaxed) {
            Err(mlua::Error::RuntimeError("deadline exceeded".into()))
        } else { Ok(VmState::Continue) }
    });
    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let r = lua.load("while true do pcall(function() while true do end end) end").exec();
    let elapsed = t0.elapsed();
    match r {
        Err(e) => println!("RESULT interrupt_adversarial PASS stopped_after={elapsed:?} err={}",
                           first_line(&e.to_string())),
        Ok(()) => println!("RESULT interrupt_adversarial FAIL script_escaped_deadline after={elapsed:?}"),
    }
}

/// Cost of leaving the interrupt armed, comparable to probe-lua's hook_cost.
fn probe_hook_cost() {
    const SRC: &str = "local s=0 for i=1,2000000 do s=s+i end return s";
    let mut out = vec![];
    for label in ["none", "interrupt"] {
        let lua = lua(false);
        if label == "interrupt" {
            let flag = Arc::new(AtomicBool::new(false));
            lua.set_interrupt(move |_| {
                if flag.load(Ordering::Relaxed) {
                    Err(mlua::Error::RuntimeError("deadline".into()))
                } else { Ok(VmState::Continue) }
            });
        }
        let t0 = Instant::now();
        let _: i64 = lua.load(SRC).eval().expect("eval");
        out.push(format!("{label}={:?}", t0.elapsed()));
    }
    println!("RESULT hook_cost INFO {}", out.join(" "));
}

fn probe_threads() {
    let n = 4;
    let handles: Vec<_> = (0..n).map(|_| std::thread::spawn(|| {
        let lua = lua(true);
        lua.load("local s=0 for i=1,100000 do s=s+i end return s").eval::<i64>().unwrap_or(0)
    })).collect();
    let mut ok = true;
    for h in handles { if h.join().expect("join") != 5000050000 { ok = false; } }
    let moved = lua(true);
    let moved_ok = std::thread::spawn(move || {
        moved.load("return 7*6").eval::<i64>().unwrap_or(0) == 42
    }).join().unwrap_or(false);
    println!("RESULT threads {} per_thread_instances={n} moved_across_threads={moved_ok}",
             if ok && moved_ok { "PASS" } else { "FAIL" });
}

fn probe_error() {
    let lua = lua(true);
    let r = lua.load(r#"error("boom")"#).exec();
    println!("RESULT error {} reusable={} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive(&lua),
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

fn probe_recurse() {
    let lua = lua(true);
    let r = lua.load("local function f() return 1 + f() end return f()").eval::<Value>();
    println!("RESULT recurse {} reusable={} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive(&lua),
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

fn probe_oom() {
    let lua = lua(true);
    lua.set_memory_limit(8 * 1024 * 1024).expect("set_memory_limit");
    let before = rss_kib();
    let r = lua.load(r#"local t = {} while true do t[#t+1] = string.rep("x", 1024) end"#).exec();
    let peak = rss_kib();
    let at_cap = alive(&lua);
    lua.gc_collect().ok();
    lua.gc_collect().ok();
    let after = rss_kib();
    lua.set_memory_limit(0).ok();
    println!("RESULT oom {} reusable_at_cap={at_cap} reusable_uncapped={} rss_before_kib={before} rss_peak_kib={peak} rss_after_gc_kib={after} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive(&lua),
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

/// Same stripped set as the 5.4 probe, plus whatever Luau's sandbox() adds.
fn probe_sandbox() {
    let lua = lua(true);
    let names = ["io", "os", "package", "debug", "load", "loadstring", "require", "getfenv"];
    let present: Vec<_> = names.iter()
        .filter(|n| lua.load(format!("return {n} ~= nil")).eval::<bool>().unwrap_or(false))
        .copied().collect();
    // sandbox() makes globals read-only: confirm a script cannot patch a builtin.
    let patched = lua.load("string.rep = function() return 'pwned' end").exec().is_ok();
    // `require` being non-nil does not mean it can reach disk. Try it.
    // Self-contained: write a module into a fresh temp dir, chdir there, and
    // require it by relative path. Result must not depend on the caller's cwd.
    let dir = std::env::temp_dir().join(format!("luau_req_{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("luau_mod_test.luau"), "return { answer = 42 }\n").expect("write");
    let prev = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&dir).expect("chdir");
    let req = lua.load(r#"local ok, v = pcall(require, "./luau_mod_test") if not ok then return "blocked:"..tostring(v) end return "read_from_disk:"..tostring(v.answer)"#)
        .eval::<String>().unwrap_or_else(|e| format!("raised:{}", first_line(&e.to_string())));
    std::env::set_current_dir(prev).ok();
    std::fs::remove_dir_all(&dir).ok();
    // Same for loadstring: can it compile and run new code?
    let ls = lua.load(r#"local ok, f = pcall(loadstring, "return 7*6") if not ok then return "blocked" end if f == nil then return "nil" end return tostring(f())"#)
        .eval::<String>().unwrap_or_else(|e| format!("raised:{}", first_line(&e.to_string())));
    println!("RESULT sandbox_detail INFO require={req} loadstring={ls}");
    println!("RESULT sandbox {} reachable_globals=[{}] globals_writable={patched}",
             if present.is_empty() && !patched { "PASS" } else { "PARTIAL" },
             present.join(","));
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("interrupt") => probe_interrupt(false),
        Some("interrupt_guarded") => probe_interrupt(true),
        Some("interrupt_adversarial") => probe_interrupt_adversarial(),
        Some("hook_cost") => probe_hook_cost(),
        Some("threads") => probe_threads(),
        Some("error") => probe_error(),
        Some("recurse") => probe_recurse(),
        Some("oom") => probe_oom(),
        Some("sandbox") => probe_sandbox(),
        other => { eprintln!("unknown probe: {other:?}"); std::process::exit(2); }
    }
}
