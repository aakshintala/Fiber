//! Mini harness: smol async runtime, same shape as `mini_blocking`.
//! Timings are per platform; label the host when quoting them.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use smol::io::AsyncReadExt;
use smol::prelude::*;

fn main() {
    smol::block_on(run());
}

async fn run() {
    let (addr, _server) =
        sse_server::spawn_chunked_sse(20, Duration::from_millis(50));

    let start = Instant::now();
    let sub_done = Arc::new(AtomicBool::new(false));
    let events = Arc::new(AtomicUsize::new(0));

    let sub_flag = Arc::clone(&sub_done);
    smol::spawn(async move {
        let out = smol::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 0.3; echo tool-done")
            .output()
            .await
            .expect("subprocess");
        let text = String::from_utf8_lossy(&out.stdout);
        let text = text.trim();
        println!(
            "subprocess {text} +{:.1}ms",
            start.elapsed().as_secs_f64() * 1000.0
        );
        let _ = io::stdout().flush();
        sub_flag.store(true, Ordering::SeqCst);
    })
    .detach();

    let path = std::env::temp_dir().join(format!("mini_smol-{}.log", std::process::id()));
    let (file_tx, file_rx) = smol::channel::unbounded::<String>();
    let file_task = smol::spawn(async move {
        let mut f = smol::fs::File::create(&path).await.expect("log file");
        while let Ok(line) = file_rx.recv().await {
            use smol::io::AsyncWriteExt;
            let _ = f.write_all(format!("{line}\n").as_bytes()).await;
            let _ = f.sync_all().await;
        }
    });

    let (cancel_tx, cancel_rx) = smol::channel::bounded::<Instant>(1);
    let mut stream = smol::net::TcpStream::connect(addr).await.expect("connect");
    stream.set_nodelay(true).ok();
    smol::spawn(async move {
        smol::Timer::after(Duration::from_millis(500)).await;
        let _ = cancel_tx.send(Instant::now()).await;
    })
    .detach();
    stream
        .write_all(b"GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .expect("write GET");

    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let mut headers_done = false;
    loop {
        enum Step {
            Data(usize),
            Cancel(Instant),
        }
        let step = async {
            Step::Data(stream.read(&mut tmp).await.unwrap_or(0))
        }
        .or(async { Step::Cancel(cancel_rx.recv().await.expect("cancel")) })
        .await;
        match step {
            Step::Cancel(t0) => {
                let observed = Instant::now();
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                let us = observed.duration_since(t0).as_secs_f64() * 1_000_000.0;
                println!("cancelled +{ms:.1}ms latency={us:.0}us");
                let _ = io::stdout().flush();
                break;
            }
            Step::Data(0) => break,
            Step::Data(n) => {
                buf.extend_from_slice(&tmp[..n]);
                for i in take_events(&mut buf, &mut headers_done) {
                    events.fetch_add(1, Ordering::SeqCst);
                    println!(
                        "event {i} +{:.1}ms",
                        start.elapsed().as_secs_f64() * 1000.0
                    );
                    let _ = io::stdout().flush();
                    let _ = file_tx.send(format!("event-{i}")).await;
                }
            }
        }
    }
    drop(file_tx);
    let _ = file_task.await;

    let n = events.load(Ordering::SeqCst);
    let sub = if sub_done.load(Ordering::SeqCst) {
        "done"
    } else {
        "pending"
    };
    println!(
        "total +{:.1}ms events={n} subprocess={sub}",
        start.elapsed().as_secs_f64() * 1000.0
    );
}

fn take_events(buf: &mut Vec<u8>, headers_done: &mut bool) -> Vec<usize> {
    if !*headers_done {
        match buf.windows(4).position(|w| w == b"\r\n\r\n") {
            Some(i) => {
                buf.drain(..i + 4);
                *headers_done = true;
            }
            None => return Vec::new(),
        }
    }
    let mut ids = Vec::new();
    const PREFIX: &[u8] = b"data: event-";
    loop {
        let start = match buf.windows(PREFIX.len()).position(|w| w == PREFIX) {
            Some(s) => s,
            None => break,
        };
        let num_at = start + PREFIX.len();
        let nl = match buf[num_at..].iter().position(|&b| b == b'\n') {
            Some(n) => n,
            None => break,
        };
        let num_str = std::str::from_utf8(&buf[num_at..num_at + nl])
            .unwrap_or("")
            .trim();
        if let Ok(id) = num_str.parse::<usize>() {
            ids.push(id);
        }
        buf.drain(..num_at + nl + 1);
    }
    ids
}
