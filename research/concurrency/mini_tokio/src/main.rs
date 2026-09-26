//! Mini harness: multi-thread tokio runtime, same shape as `mini_blocking`.
//! Timings are per platform; label the host when quoting them.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio mt runtime")
        .block_on(run());
}

async fn run() {
    let (addr, _server) =
        sse_server::spawn_chunked_sse(20, Duration::from_millis(50));

    let start = Instant::now();
    let sub_done = Arc::new(AtomicBool::new(false));
    let events = Arc::new(AtomicUsize::new(0));

    let sub_flag = Arc::clone(&sub_done);
    tokio::spawn(async move {
        let out = tokio::process::Command::new("/bin/sh")
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
    });

    let path = std::env::temp_dir().join(format!("mini_tokio-{}.log", std::process::id()));
    let (file_tx, mut file_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let file_task = tokio::spawn(async move {
        let mut f = tokio::fs::File::create(&path).await.expect("log file");
        while let Some(line) = file_rx.recv().await {
            let _ = f.write_all(format!("{line}\n").as_bytes()).await;
            let _ = f.sync_all().await;
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<Instant>();
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    stream.set_nodelay(true).ok();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = cancel_tx.send(Instant::now());
    });
    stream
        .write_all(b"GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .expect("write GET");

    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let mut headers_done = false;
    loop {
        tokio::select! {
            t0 = &mut cancel_rx => {
                let t0 = t0.expect("cancel");
                let observed = Instant::now();
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                let us = observed.duration_since(t0).as_secs_f64() * 1_000_000.0;
                println!("cancelled +{ms:.1}ms latency={us:.0}us");
                let _ = io::stdout().flush();
                break;
            }
            n = stream.read(&mut tmp) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        for i in take_events(&mut buf, &mut headers_done) {
                            events.fetch_add(1, Ordering::SeqCst);
                            println!(
                                "event {i} +{:.1}ms",
                                start.elapsed().as_secs_f64() * 1000.0
                            );
                            let _ = io::stdout().flush();
                            let _ = file_tx.send(format!("event-{i}"));
                        }
                    }
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
