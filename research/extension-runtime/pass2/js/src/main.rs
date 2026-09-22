// Pass-2 streaming-provider shape, rquickjs backend. Same workload as the mlua
// crate; JavaScript parses JSON natively so there is no host decode callback.
use rquickjs::{Context, Function, Runtime};

const EXT: &str = r#"
globalThis.acc = [];
globalThis.reset = function() { globalThis.acc = []; };
globalThis.on_line = function(line) {
  if (!line.startsWith("data: ")) return;
  const payload = line.slice(6);
  if (payload === "[DONE]") return;
  const ev = JSON.parse(payload);
  const d = ev.delta;
  if (ev.type === "content_block_delta" && d && d.type === "text_delta") globalThis.acc.push(d.text);
};
globalThis.get_result = function() { return globalThis.acc.join(""); };
"#;

fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

fn make_instance() -> (Runtime, Context) {
    let rt = Runtime::new().expect("runtime");
    let ctx = Context::full(&rt).expect("context");
    ctx.with(|c| { c.eval::<(), _>(EXT).expect("load ext"); });
    (rt, ctx)
}

fn run_turn(ctx: &Context, lines: &[&str]) -> String {
    ctx.with(|c| {
        let g = c.globals();
        let reset: Function = g.get("reset").expect("reset");
        reset.call::<_, ()>(()).expect("reset call");
        let on_line: Function = g.get("on_line").expect("on_line");
        for line in lines {
            on_line.call::<_, ()>((line.to_string(),)).expect("on_line call");
        }
        let get: Function = g.get("get_result").expect("get_result");
        get.call::<_, String>(()).expect("get_result call")
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let strategy = args.get(1).map(|s| s.as_str()).unwrap_or("native");
    let turns: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(50);
    let instances: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);

    let sse = std::fs::read_to_string("../transcript.sse").expect("transcript.sse");
    let lines: Vec<&str> = sse.lines().collect();
    let expected = std::fs::read_to_string("../expected.txt").expect("expected.txt");

    let rss_start = rss_kib();
    let insts: Vec<(Runtime, Context)> = (0..instances).map(|_| make_instance()).collect();
    let rss_loaded = rss_kib();

    let mut rss_peak = rss_loaded;
    let mut verify = "ok";
    for t in 0..turns {
        for (_, ctx) in &insts {
            let got = run_turn(ctx, &lines);
            if t == 0 && got.trim_end() != expected.trim_end() { verify = "MISMATCH"; }
        }
        let r = rss_kib();
        if r > rss_peak { rss_peak = r; }
    }
    let rss_end = rss_kib();
    for (rt, _) in &insts { rt.run_gc(); rt.run_gc(); }
    std::thread::sleep(std::time::Duration::from_millis(200));
    let rss_idle = rss_kib();

    println!("RESULT stream strategy={strategy} instances={instances} turns={turns} \
              verify={verify} rss_start_kib={rss_start} rss_loaded_kib={rss_loaded} \
              rss_peak_kib={rss_peak} rss_end_kib={rss_end} rss_after_idle_gc_kib={rss_idle}");
}
