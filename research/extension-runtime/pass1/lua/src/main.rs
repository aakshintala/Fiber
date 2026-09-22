// Pass-1 disqualification probe, Lua 5.4 via mlua 0.12.
// Each subcommand prints one RESULT line: RESULT <probe> <verdict> <detail>
use std::ops::BitOr;
use mlua::{HookTriggers, Lua, StdLib, LuaOptions, VmState, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The stdlib set an extension actually gets: no io, no os, no package, no debug.
fn safe_libs() -> StdLib {
    StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8 | StdLib::COROUTINE
}

fn lua() -> Lua {
    Lua::new_with(safe_libs(), LuaOptions::default()).expect("new_with")
}

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

/// Can a wedged script be stopped from another thread, under a deadline?
/// Mitigation attempt: once the deadline passes the hook fires on EVERY
/// instruction and errors unconditionally, so a pcall that swallows one error
/// is handed another immediately and the script cannot make progress.
/// What does hook enforcement cost? Same busy loop under three hook settings.
fn probe_hook_cost() {
    const SRC: &str = "local s=0 for i=1,2000000 do s=s+i end return s";
    let mut out = vec![];
    for (label, n) in [("none", 0u32), ("n=1000", 1000), ("n=1", 1)] {
        let lua = lua();
        if n > 0 {
            let flag = Arc::new(AtomicBool::new(false));
            lua.set_hook(HookTriggers::default().every_nth_instruction(n), move |_, _| {
                if flag.load(Ordering::Relaxed) {
                    Err(mlua::Error::RuntimeError("deadline".into()))
                } else { Ok(VmState::Continue) }
            }).expect("set_hook");
        }
        let t0 = Instant::now();
        let _: i64 = lua.load(SRC).eval().expect("eval");
        out.push(format!("{label}={:?}", t0.elapsed()));
    }
    println!("RESULT hook_cost INFO {}", out.join(" "));
}

/// The design that would actually ship: cheap hook normally, escalate to
/// every-instruction from inside the hook once the deadline has passed.
fn probe_interrupt_escalate() {
    let lua = lua();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    lua.set_hook(HookTriggers::default().every_nth_instruction(1000), move |lua, _| {
        if flag.load(Ordering::Relaxed) {
            // Re-arm at every instruction so a pcall gets no room to recover.
            let f2 = flag.clone();
            let _ = lua.set_hook(HookTriggers::default().every_nth_instruction(1), move |_, _| {
                if f2.load(Ordering::Relaxed) {
                    Err(mlua::Error::RuntimeError("deadline exceeded".into()))
                } else { Ok(VmState::Continue) }
            });
            Err(mlua::Error::RuntimeError("deadline exceeded".into()))
        } else { Ok(VmState::Continue) }
    }).expect("set_hook");
    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let r = lua.load("while true do pcall(function() while true do end end) end").exec();
    let elapsed = t0.elapsed();
    match r {
        Err(e) => println!("RESULT interrupt_escalate PASS stopped_after={elapsed:?} err={}",
                           first_line(&e.to_string())),
        Ok(()) => println!("RESULT interrupt_escalate FAIL script_escaped_deadline after={elapsed:?}"),
    }
}

fn probe_interrupt_rearm() {
    let lua = lua();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    // every_nth_instruction(1) => fire constantly, so pcall gets no room to run.
    lua.set_hook(HookTriggers::default().every_nth_instruction(1), move |_, _| {
        if flag.load(Ordering::Relaxed) {
            Err(mlua::Error::RuntimeError("deadline exceeded".into()))
        } else {
            Ok(VmState::Continue)
        }
    })
    .expect("set_hook");
    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });
    let t0 = Instant::now();
    // Adversarial: retry the pcall forever, the idiomatic Lua way to be robust.
    let r = lua.load("while true do pcall(function() while true do end end) end").exec();
    let elapsed = t0.elapsed();
    match r {
        Err(e) => println!("RESULT interrupt_rearm PASS stopped_after={elapsed:?} err={}",
                           first_line(&e.to_string())),
        Ok(()) => println!("RESULT interrupt_rearm FAIL script_escaped_deadline after={elapsed:?}"),
    }
}

fn probe_interrupt(guarded: bool) {
    let lua = lua();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    lua.set_hook(HookTriggers::default().every_nth_instruction(1000), move |_, _| {
        if flag.load(Ordering::Relaxed) {
            Err(mlua::Error::RuntimeError("deadline exceeded".into()))
        } else {
            Ok(VmState::Continue)
        }
    })
    .expect("set_hook");

    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });

    let src = if guarded {
        "local ok, err = pcall(function() while true do end end) return 'swallowed:'..tostring(ok)"
    } else {
        "while true do end"
    };
    let name = if guarded { "interrupt_guarded" } else { "interrupt" };
    let t0 = Instant::now();
    let r = lua.load(src).exec();
    let elapsed = t0.elapsed();
    match r {
        Err(e) => {
            // Prove the interpreter is reusable after the interrupt.
            lua.remove_hook();
            let alive = lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false);
            println!("RESULT {name} PASS stopped_after={:?} reusable={} err={}",
                     elapsed, alive, first_line(&e.to_string()));
        }
        Ok(()) => println!("RESULT {name} FAIL script_escaped_deadline after={elapsed:?}"),
    }
}

/// Does the blocking-threads model fit: one interpreter per thread, moved across?
fn probe_threads() {
    let n = 4;
    let handles: Vec<_> = (0..n)
        .map(|i| {
            std::thread::spawn(move || {
                let lua = lua(); // constructed on the worker thread
                let v: i64 = lua.load("local s=0 for i=1,100000 do s=s+i end return s")
                    .eval().expect("eval");
                (i, v)
            })
        })
        .collect();
    let mut ok = true;
    for h in handles {
        let (_, v) = h.join().expect("join");
        if v != 5000050000 { ok = false; }
    }

    // Stronger claim: an interpreter built on one thread and *moved* to another.
    let moved = lua();
    let moved_ok = std::thread::spawn(move || {
        moved.load("return 7*6").eval::<i64>().unwrap_or(0) == 42
    }).join().unwrap_or(false);

    println!("RESULT threads {} per_thread_instances={} moved_across_threads={}",
             if ok && moved_ok { "PASS" } else { "FAIL" }, n, moved_ok);
}

/// Failure mode 1: the script raises an error.
fn probe_error() {
    let lua = lua();
    let r = lua.load(r#"error("boom")"#).exec();
    let alive = lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false);
    println!("RESULT error {} reusable={} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive,
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

/// Failure mode 2: unbounded recursion. Does the host segfault on a blown stack?
fn probe_recurse() {
    let lua = lua();
    let r = lua.load("local function f() return 1 + f() end return f()").eval::<Value>();
    let alive = lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false);
    println!("RESULT recurse {} reusable={} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive,
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

/// Failure mode 3: allocate without bound, against a host memory cap.
fn probe_oom() {
    let lua = lua();
    lua.set_memory_limit(8 * 1024 * 1024).expect("set_memory_limit");
    let before = rss_kib();
    let r = lua.load(r#"local t = {} while true do t[#t+1] = string.rep("x", 1024) end"#).exec();
    let peak = rss_kib();
    drop(r.as_ref().err());
    // Reclaim: drop the script's values and collect.
    let alive = lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false);
    lua.gc_collect().ok();
    lua.gc_collect().ok();
    let after = rss_kib();
    lua.set_memory_limit(0).ok(); // 0 = unlimited
    let alive_uncapped = lua.load("return 1+1").eval::<i64>().map(|v| v == 2).unwrap_or(false);
    println!("RESULT oom_recovery reusable_at_cap={alive} reusable_uncapped={alive_uncapped}");
    println!("RESULT oom {} reusable={} rss_before_kib={} rss_peak_kib={} rss_after_gc_kib={} err={}",
             if r.is_err() { "PASS" } else { "FAIL" }, alive, before, peak, after,
             first_line(&r.err().map(|e| e.to_string()).unwrap_or_default()));
}

/// #3 measured the DEFAULT embedding and found io/os reachable. This checks the
/// stripped embedding it recommended instead, which #3 never verified.
fn probe_sandbox() {
    let lua = lua();
    let probes = [
        ("io", "return io ~= nil"),
        ("os", "return os ~= nil"),
        ("package", "return package ~= nil"),
        ("debug", "return debug ~= nil"),
        ("loadstring_load", "return load ~= nil"),
    ];
    let mut present = vec![];
    for (name, src) in probes {
        if lua.load(src).eval::<bool>().unwrap_or(false) {
            present.push(name);
        }
    }
    println!("RESULT sandbox {} reachable_globals=[{}]",
             if present.iter().all(|p| *p == "loadstring_load") { "PASS" } else { "FAIL" },
             present.join(","));
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(90).collect()
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("interrupt") => probe_interrupt(false),
        Some("interrupt_guarded") => probe_interrupt(true),
        Some("interrupt_rearm") => probe_interrupt_rearm(),
        Some("interrupt_escalate") => probe_interrupt_escalate(),
        Some("hook_cost") => probe_hook_cost(),
        Some("threads") => probe_threads(),
        Some("error") => probe_error(),
        Some("recurse") => probe_recurse(),
        Some("oom") => probe_oom(),
        Some("sandbox") => probe_sandbox(),
        other => { eprintln!("unknown probe: {other:?}"); std::process::exit(2); }
    }
}
