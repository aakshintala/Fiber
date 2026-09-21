//! Tiny HTTP/1.1 server for streaming and hang tests. No TLS, no tokio.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Keeps a server-side `TcpStream` open until dropped.
pub struct Hold {
    _keep: mpsc::Sender<()>,
    _thread: Option<thread::JoinHandle<()>>,
}

pub fn dump_arrivals(label: &str, reader: &mut dyn Read) {
    let start = Instant::now();
    let mut buf = [0u8; 512];
    let mut n_reads = 0u32;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                n_reads += 1;
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                let text = String::from_utf8_lossy(&buf[..n]);
                print!(
                    "{label} read#{n_reads} +{ms:.1}ms bytes={n} {text:?}\n"
                );
            }
            Err(e) => {
                println!("{label} read-err {e}");
                break;
            }
        }
    }
    println!(
        "{label} done reads={n_reads} elapsed_ms={:.1}",
        start.elapsed().as_secs_f64() * 1000.0
    );
}

pub fn bind_local() -> TcpListener {
    TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0")
}

/// Serve one SSE-ish chunked body: `events` chunks, `interval` apart, then close.
pub fn spawn_chunked_sse(events: usize, interval: Duration) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = bind_local();
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        handle_chunked_sse(&mut stream, events, interval);
    });
    (addr, handle)
}

pub fn handle_chunked_sse(stream: &mut TcpStream, events: usize, interval: Duration) {
    let mut buf = [0u8; 4096];
    let _ = stream.read(&mut buf);
    let headers = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Transfer-Encoding: chunked\r\n\
Cache-Control: no-cache\r\n\
Connection: close\r\n\
\r\n";
    stream.write_all(headers.as_bytes()).expect("headers");
    stream.flush().ok();
    for i in 0..events {
        let body = format!("data: event-{i}\n\n");
        let chunk = format!("{:x}\r\n{}\r\n", body.len(), body);
        stream.write_all(chunk.as_bytes()).expect("chunk");
        stream.flush().ok();
        if i + 1 < events {
            thread::sleep(interval);
        }
    }
    stream.write_all(b"0\r\n\r\n").ok();
    stream.flush().ok();
}

/// Accept one connection, write response headers, then hold the socket open
/// without sending a body until the returned `Hold` is dropped.
pub fn spawn_hang() -> (SocketAddr, Hold) {
    let listener = bind_local();
    let addr = listener.local_addr().unwrap();
    let (keep, hold_rx) = mpsc::channel::<()>();
    let thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept hang");
        let _ = stream.set_nodelay(true);
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let headers = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Transfer-Encoding: chunked\r\n\
Cache-Control: no-cache\r\n\
Connection: keep-alive\r\n\
\r\n";
        stream.write_all(headers.as_bytes()).expect("hang headers");
        stream.flush().ok();
        let _ = hold_rx.recv();
        drop(stream);
    });
    (
        addr,
        Hold {
            _keep: keep,
            _thread: Some(thread),
        },
    )
}

/// Accept one raw TCP client and never write until the returned `Hold` is dropped.
pub fn spawn_silent_tcp() -> (SocketAddr, Hold) {
    let listener = bind_local();
    let addr = listener.local_addr().unwrap();
    let (keep, hold_rx) = mpsc::channel::<()>();
    let thread = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept silent");
        let _ = hold_rx.recv();
        drop(stream);
    });
    (
        addr,
        Hold {
            _keep: keep,
            _thread: Some(thread),
        },
    )
}
