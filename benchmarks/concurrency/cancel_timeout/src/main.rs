//! Interrupt a blocked read with `set_read_timeout` plus an atomic cancel flag.
//! Latency is bounded by the timeout, not by the kernel unblocking a wait.

use std::io::{self, Read};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn summarize(label: &str, mut samples_us: Vec<f64>) {
    samples_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = samples_us.len();
    let sum: f64 = samples_us.iter().sum();
    println!(
        "{label} n={n} min_us={:.1} p50_us={:.1} p95_us={:.1} max_us={:.1} mean_us={:.1}",
        samples_us.first().copied().unwrap_or(0.0),
        percentile(&samples_us, 50.0),
        percentile(&samples_us, 95.0),
        samples_us.last().copied().unwrap_or(0.0),
        if n == 0 { 0.0 } else { sum / n as f64 }
    );
}

fn one_timeout(timeout: Duration) -> f64 {
    let (addr, _server) = sse_server::spawn_silent_tcp();
    let mut stream = TcpStream::connect(addr).expect("connect");
    stream.set_read_timeout(Some(timeout)).expect("set timeout");
    let flag = Arc::new(AtomicBool::new(false));
    let flag_r = Arc::clone(&flag);
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let mut buf = [0u8; 8];
        ready_tx.send(()).ok();
        loop {
            match stream.read(&mut buf) {
                Ok(0) => return "eof",
                Ok(_) => return "data",
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.kind() == io::ErrorKind::TimedOut =>
                {
                    if flag_r.load(Ordering::SeqCst) {
                        return "flag";
                    }
                }
                Err(e) => {
                    eprintln!("unexpected {e}");
                    return "err";
                }
            }
        }
    });
    ready_rx.recv().unwrap();
    thread::sleep(Duration::from_millis(5));
    let t0 = Instant::now();
    flag.store(true, Ordering::SeqCst);
    let why = handle.join().expect("join");
    let us = t0.elapsed().as_secs_f64() * 1_000_000.0;
    eprintln!("timeout-read reason={why} after {us:.1}us (timeout={timeout:?})");
    us
}

fn main() {
    let n: usize = std::env::var("CANCEL_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    for timeout_ms in [10u64, 20, 50, 100] {
        let timeout = Duration::from_millis(timeout_ms);
        let mut samples = Vec::with_capacity(n);
        for _ in 0..n {
            samples.push(one_timeout(timeout));
        }
        summarize(&format!("cancel_timeout {timeout_ms}ms"), samples);
    }
}
