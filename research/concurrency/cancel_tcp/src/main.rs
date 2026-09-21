//! Interrupt a thread blocked in `TcpStream::read` by shutting the socket down
//! from another thread (`shutdown` on a cloned stream / via `&self`).

use std::io::Read;
use std::net::{Shutdown, TcpStream};
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

fn one_shutdown() -> f64 {
    let (addr, _server) = sse_server::spawn_silent_tcp();
    let stream = TcpStream::connect(addr).expect("connect");
    stream.set_nodelay(true).ok();
    let stream = Arc::new(stream);
    let reader = Arc::clone(&stream);
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let mut buf = [0u8; 8];
        ready_tx.send(()).ok();
        Read::read(&mut &*reader, &mut buf)
    });
    ready_rx.recv().unwrap();
    // Give the reader time to enter the syscall. Measured empirically via a
    // short sleep; too short and we shut down before read() blocks.
    thread::sleep(Duration::from_millis(5));
    let t0 = Instant::now();
    stream.shutdown(Shutdown::Both).expect("shutdown");
    let result = handle.join().expect("join reader");
    let us = t0.elapsed().as_secs_f64() * 1_000_000.0;
    match result {
        Ok(n) => eprintln!("shutdown-read returned Ok({n}) after {us:.1}us"),
        Err(e) => eprintln!("shutdown-read returned Err({e}) after {us:.1}us"),
    }
    us
}

fn main() {
    let n: usize = std::env::var("CANCEL_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    let mut samples = Vec::with_capacity(n);
    for i in 0..n {
        let us = one_shutdown();
        samples.push(us);
        if i == 0 {
            // first result already printed
        }
    }
    summarize("cancel_tcp shutdown", samples);
}
