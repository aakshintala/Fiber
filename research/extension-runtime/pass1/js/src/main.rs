// Pass-1 disqualification probe, QuickJS via rquickjs 0.14.
// Each subcommand prints one RESULT line: RESULT <probe> <verdict> <detail>
use rquickjs::{Context, Runtime, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn rt_ctx() -> (Runtime, Context) {
    let rt = Runtime::new().expect("runtime");
    let ctx = Context::full(&rt).expect("context");
    (rt, ctx)
}

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn eval_ok(ctx: &Context, src: &str) -> bool {
    ctx.with(|c| c.eval::<i64, _>(src).map(|v| v == 2).unwrap_or(false))
}

/// rquickjs returns a placeholder Error; the real exception must be pulled off
/// the context with `catch()`. This is what a host would actually do.
fn err_of(ctx: &Context, src: &str) -> Option<String> {
    ctx.with(|c| match c.eval::<Value, _>(src) {
        Ok(_) => None,
        Err(rquickjs::Error::Exception) => {
            let v = c.catch();
            let msg = v.as_exception().map(|e| format!("{e}"))
                .or_else(|| v.as_string().and_then(|s| s.to_string().ok()))
                .unwrap_or_else(|| format!("{v:?}"));
            Some(first_line(&msg))
        }
        Err(e) => Some(first_line(&e.to_string())),
    })
}

/// Can a wedged script be stopped from another thread, under a deadline?
/// `guarded` wraps the loop in try/catch to see whether a script can swallow it.
fn probe_interrupt(guarded: bool) {
    let (rt, ctx) = rt_ctx();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    rt.set_interrupt_handler(Some(Box::new(move || flag.load(Ordering::Relaxed))));

    let watchdog = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        watchdog.store(true, Ordering::Relaxed);
    });

    let src = if guarded {
        "try { while(true){} } catch (e) { 'swallowed' }"
    } else {
        "while(true){}"
    };
    let t0 = Instant::now();
    let r = ctx.with(|c| c.eval::<Value, _>(src).map(|v| format!("{v:?}")));
    let elapsed = t0.elapsed();
    let name = if guarded { "interrupt_guarded" } else { "interrupt" };
    match r {
        Err(e) => {
            rt.set_interrupt_handler(None);
            println!("RESULT {name} PASS stopped_after={elapsed:?} reusable={} err={}",
                     eval_ok(&ctx, "1+1"), first_line(&e.to_string()));
        }
        Ok(v) => println!("RESULT {name} FAIL script_escaped_deadline after={elapsed:?} value={v}"),
    }
}

/// Does the blocking-threads model fit: one interpreter per thread, moved across?
/// Fair comparison against Lua's hook cost: same busy loop, with and without
/// the interrupt handler installed.
fn probe_hook_cost() {
    const SRC: &str = "let s=0; for(let i=1;i<=2000000;i++) s+=i; s";
    let mut out = vec![];
    for label in ["none", "interrupt"] {
        let (rt, ctx) = rt_ctx();
        if label == "interrupt" {
            let flag = Arc::new(AtomicBool::new(false));
            rt.set_interrupt_handler(Some(Box::new(move || flag.load(Ordering::Relaxed))));
        }
        let t0 = Instant::now();
        let _: i64 = ctx.with(|c| c.eval(SRC).expect("eval"));
        out.push(format!("{label}={:?}", t0.elapsed()));
    }
    println!("RESULT hook_cost INFO {}", out.join(" "));
}

fn probe_threads() {
    let n = 4;
    let handles: Vec<_> = (0..n)
        .map(|_| std::thread::spawn(|| {
            let (_rt, ctx) = rt_ctx(); // constructed on the worker thread
            ctx.with(|c| c.eval::<i64, _>("let s=0; for(let i=1;i<=100000;i++) s+=i; s").unwrap_or(0))
        }))
        .collect();
    let mut ok = true;
    for h in handles {
        if h.join().expect("join") != 5000050000i64 { ok = false; }
    }

    // Stronger claim: a runtime built on one thread and *moved* to another.
    let (rt, ctx) = rt_ctx();
    let moved_ok = std::thread::spawn(move || {
        let _keep = rt;
        ctx.with(|c| c.eval::<i64, _>("7*6").unwrap_or(0)) == 42
    }).join().unwrap_or(false);

    println!("RESULT threads {} per_thread_instances={} moved_across_threads={}",
             if ok && moved_ok { "PASS" } else { "FAIL" }, n, moved_ok);
}

/// Failure mode 1: the script throws.
fn probe_error() {
    let (_rt, ctx) = rt_ctx();
    let e = err_of(&ctx, r#"throw new Error("boom")"#);
    println!("RESULT error {} reusable={} err={}",
             if e.is_some() { "PASS" } else { "FAIL" }, eval_ok(&ctx, "1+1"),
             e.unwrap_or_default());
}

/// Failure mode 2: unbounded recursion. Does the host segfault on a blown stack?
fn probe_recurse() {
    let (_rt, ctx) = rt_ctx();
    let e = err_of(&ctx, "function f(){ return 1 + f() } f()");
    println!("RESULT recurse {} reusable={} err={}",
             if e.is_some() { "PASS" } else { "FAIL" }, eval_ok(&ctx, "1+1"),
             e.unwrap_or_default());
}

/// Failure mode 3: allocate without bound, against a host memory cap.
fn probe_oom() {
    let (rt, ctx) = rt_ctx();
    rt.set_memory_limit(8 * 1024 * 1024);
    let before = rss_kib();
    let e = err_of(&ctx, r#"let t=[]; while(true) t.push("x".repeat(1024));"#);
    let peak = rss_kib();
    let alive = eval_ok(&ctx, "1+1");
    rt.run_gc();
    rt.run_gc();
    let after = rss_kib();
    rt.set_memory_limit(usize::MAX);
    let alive_uncapped = eval_ok(&ctx, "1+1");
    println!("RESULT oom_recovery reusable_at_cap={alive} reusable_uncapped={alive_uncapped}");
    println!("RESULT oom {} reusable={} rss_before_kib={} rss_peak_kib={} rss_after_gc_kib={} err={}",
             if e.is_some() { "PASS" } else { "FAIL" }, alive, before, peak, after,
             e.unwrap_or_default());
}

/// #3 measured this on a default embedding; re-confirming here alongside Lua's
/// stripped set so the two are compared on the same footing.
fn probe_sandbox() {
    let (_rt, ctx) = rt_ctx();
    let names = ["os", "std", "process", "require", "fetch", "eval", "Function"];
    let present: Vec<_> = names.iter()
        .filter(|n| ctx.with(|c| c.eval::<bool, _>(format!("typeof {n} !== 'undefined'")).unwrap_or(false)))
        .copied().collect();
    let dangerous: Vec<_> = present.iter()
        .filter(|n| !matches!(**n, "eval" | "Function")).copied().collect();
    println!("RESULT sandbox {} reachable_globals=[{}]",
             if dangerous.is_empty() { "PASS" } else { "FAIL" }, present.join(","));
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(90).collect()
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("interrupt") => probe_interrupt(false),
        Some("interrupt_guarded") => probe_interrupt(true),
        Some("threads") => probe_threads(),
        Some("hook_cost") => probe_hook_cost(),
        Some("error") => probe_error(),
        Some("recurse") => probe_recurse(),
        Some("oom") => probe_oom(),
        Some("sandbox") => probe_sandbox(),
        other => { eprintln!("unknown probe: {other:?}"); std::process::exit(2); }
    }
}
