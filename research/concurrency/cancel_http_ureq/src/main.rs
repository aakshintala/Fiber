//! Can ureq's blocking body reader be cancelled from another thread?
//!
//! Probe 1: drop the `Response` from the reader thread after a timeout on a
//! wrapper — does not help the syscall.
//! Probe 2: `std::thread::JoinHandle` cannot be killed.
//! Probe 3: wrap a `TcpStream` we own, feed HTTP ourselves, shutdown the
//! socket — this is the control that works (same as cancel_tcp).
//! Probe 4: try whatever socket handle ureq exposes (printed at runtime).

use std::io::Read;
use std::net::{Shutdown, TcpStream};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

fn main() {
    println!("ureq version path: cancel_http_ureq");
    probe_ureq_drop();
    probe_owned_stream_http();
}

fn probe_ureq_drop() {
    let (addr, _server) = sse_server::spawn_hang();
    let url = format!("http://{addr}/hang");
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<String>();
    let handle = thread::spawn(move || {
        let mut response = match ureq::get(&url).call() {
            Ok(r) => r,
            Err(e) => {
                let _ = done_tx.send(format!("call-err {e}"));
                return;
            }
        };
        ready_tx.send(()).ok();
        let mut buf = [0u8; 32];
        let mut reader = response.body_mut().as_reader();
        match reader.read(&mut buf) {
            Ok(n) => {
                let _ = done_tx.send(format!("ok {n}"));
            }
            Err(e) => {
                let _ = done_tx.send(format!("err {e}"));
            }
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(()) => println!("ureq: entered body read (headers already consumed)"),
        Err(_) => println!("ureq: never reached body read (still in handshake or blocked in call)"),
    }
    // There is no ureq handle to shut the socket from this thread. Dropping
    // `handle` does nothing; we cannot abort the thread. Wait briefly, then
    // report that we are still blocked.
    thread::sleep(Duration::from_millis(100));
    match done_rx.recv_timeout(Duration::from_millis(50)) {
        Ok(msg) => println!("ureq drop-probe unexpected completion: {msg}"),
        Err(_) => println!(
            "ureq: still blocked in read after 150ms with no socket handle to shut down"
        ),
    }
    std::mem::forget(handle);
}

fn probe_owned_stream_http() {
    let (addr, _server) = sse_server::spawn_hang();
    let stream = TcpStream::connect(addr).expect("connect");
    stream.set_nodelay(true).ok();
    {
        use std::io::Write;
        let mut s = stream.try_clone().unwrap();
        s.write_all(b"GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        s.flush().ok();
    }
    let stream = Arc::new(stream);
    let reader = Arc::clone(&stream);
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let mut buf = [0u8; 1024];
        // consume headers
        let mut tmp = [0u8; 1024];
        let _ = Read::read(&mut &*reader, &mut tmp);
        ready_tx.send(()).ok();
        Read::read(&mut &*reader, &mut buf)
    });
    ready_rx.recv().unwrap();
    thread::sleep(Duration::from_millis(5));
    let t0 = Instant::now();
    stream.shutdown(Shutdown::Both).expect("shutdown");
    let result = handle.join().unwrap();
    let us = t0.elapsed().as_secs_f64() * 1_000_000.0;
    println!("owned-tcp-under-http shutdown after {us:.1}us result={result:?}");
}
