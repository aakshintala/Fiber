//! N parked OS threads, each blocked on its own `mpsc::Receiver::recv()`.
//!
//! Idle CPU, wakeups and RSS versus parked-thread count, and whether a
//! smaller thread stack changes RSS. Linux is unmeasured: every printed
//! number is macOS arm64 only.

use std::sync::mpsc;
use std::time::Duration;

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let n_threads = env_u64("N_THREADS", 32) as usize;
    let idle_secs = env_u64("IDLE_SECS", 10);
    let settle_secs = env_u64("SETTLE_SECS", 2);
    let stack_kib = env_u64("STACK_KIB", 0) as usize;

    let mut txs = Vec::with_capacity(n_threads);
    let mut joins = Vec::with_capacity(n_threads);
    for i in 0..n_threads {
        let (tx, rx) = mpsc::channel::<()>();
        let mut builder = std::thread::Builder::new().name(format!("parked-{i}"));
        if stack_kib != 0 {
            builder = builder.stack_size(stack_kib * 1024);
        }
        let handle = builder
            .spawn(move || {
                let _ = rx.recv();
            })
            .unwrap();
        txs.push(tx);
        joins.push(handle);
    }

    std::thread::sleep(Duration::from_secs(settle_secs));
    let start = measure::Snapshot::take();
    std::thread::sleep(Duration::from_secs(idle_secs));
    let end = measure::Snapshot::take();
    let label = format!("threads_scale N_THREADS={n_threads} STACK_KIB={stack_kib}");
    measure::Report::from_window(&label, start, end).print();

    drop(txs);
    for handle in joins {
        handle.join().unwrap();
    }
}
