//! Mini harness: blocking `std::thread` + `std::net::TcpStream`, no runtime.
//! Timings are per platform; label the host when quoting them.

use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn main() {
    let (addr, _server) =
        sse_server::spawn_chunked_sse(20, Duration::from_millis(50));

    let start = Instant::now();
    let sub_done = Arc::new(AtomicBool::new(false));
    let events = Arc::new(AtomicUsize::new(0));
    let cancel_at = Arc::new(Mutex::new(None::<Instant>));

    let sub_flag = Arc::clone(&sub_done);
    thread::spawn(move || {
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 0.3; echo tool-done")
            .output()
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

    let path = std::env::temp_dir().join(format!("mini_blocking-{}.log", std::process::id()));
    let (file_tx, file_rx) = mpsc::channel::<String>();
    let file_thread = thread::spawn(move || {
        let mut f = File::create(&path).expect("log file");
        for line in file_rx {
            let _ = writeln!(f, "{line}");
            let _ = f.sync_all();
        }
    });

    let (sock_tx, sock_rx) = mpsc::channel::<TcpStream>();
    let cancel_at_w = Arc::clone(&cancel_at);
    thread::spawn(move || {
        let sock = sock_rx.recv().expect("stream socket");
        thread::sleep(Duration::from_millis(500));
        *cancel_at_w.lock().unwrap() = Some(Instant::now());
        let _ = sock.shutdown(Shutdown::Both);
    });

    let events_w = Arc::clone(&events);
    let stream_thread = thread::spawn(move || {
        let mut stream = TcpStream::connect(addr).expect("connect");
        stream.set_nodelay(true).ok();
        sock_tx.send(stream.try_clone().expect("clone")).expect("send clone");
        stream
            .write_all(b"GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .expect("write GET");
        let _ = stream.flush();

        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        let mut headers_done = false;
        loop {
            match stream.read(&mut tmp) {
                Ok(0) | Err(_) => {
                    let observed = Instant::now();
                    if let Some(t0) = *cancel_at.lock().unwrap() {
                        let ms = start.elapsed().as_secs_f64() * 1000.0;
                        let us = observed.duration_since(t0).as_secs_f64() * 1_000_000.0;
                        println!("cancelled +{ms:.1}ms latency={us:.0}us");
                        let _ = io::stdout().flush();
                    }
                    break;
                }
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    for i in take_events(&mut buf, &mut headers_done) {
                        events_w.fetch_add(1, Ordering::SeqCst);
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
    });

    stream_thread.join().expect("join stream");
    let _ = file_thread.join();
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
