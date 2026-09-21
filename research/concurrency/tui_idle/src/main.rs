//! Blocking TUI shape: crossterm event thread + hanging HTTP read thread +
//! render thread blocked on `std::sync::mpsc`. No poll timeout, no busy loop.
//!
//! If this process has no controlling tty, the event thread falls back to
//! blocking on an unused channel (same park as `event::read` waiting for a
//! key). The fallback is printed so the report can say which path ran.

use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

enum Msg {
    Input(String),
    Http(usize),
}

fn main() {
    let (addr, _hang) = sse_server::spawn_hang();
    let (tx, rx) = mpsc::channel::<Msg>();

    let tx_http = tx.clone();
    thread::Builder::new()
        .name("http-read".into())
        .spawn(move || {
            let mut stream = std::net::TcpStream::connect(addr).expect("connect hang");
            stream
                .write_all(b"GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .ok();
            let mut buf = [0u8; 1024];
            // First read consumes headers; the body then hangs.
            let _ = stream.read(&mut buf);
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx_http.send(Msg::Http(n)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .unwrap();

    let tx_ev = tx;
    let event_mode = thread::Builder::new()
        .name("tty-read".into())
        .spawn(move || event_thread(tx_ev))
        .unwrap();

    thread::Builder::new()
        .name("render".into())
        .spawn(move || {
            for msg in &rx {
                match msg {
                    Msg::Input(s) => eprintln!("tui_idle input {s}"),
                    Msg::Http(n) => eprintln!("tui_idle http {n}"),
                }
            }
        })
        .unwrap();

    // Give the hang server a moment to accept so the HTTP thread is in read().
    thread::sleep(Duration::from_millis(200));

    eprintln!(
        "tui_idle event_mode will be reported by the event thread on stderr at start"
    );
    measure::measure_while_idle("tui_idle");

    // Keep the event-thread handle so it is not joined (it is blocked).
    std::mem::forget(event_mode);
}

fn event_thread(tx: mpsc::Sender<Msg>) -> &'static str {
    match try_crossterm_read(&tx) {
        Ok(()) => "crossterm::event::read",
        Err(e) => {
            eprintln!("tui_idle crossterm read failed ({e}); falling back to mpsc recv");
            let (never_tx, never_rx) = mpsc::channel::<()>();
            std::mem::forget(never_tx);
            let _ = never_rx.recv();
            let _ = tx;
            "mpsc fallback"
        }
    }
}

fn try_crossterm_read(tx: &mpsc::Sender<Msg>) -> io::Result<()> {
    // Disable the internal event-poll timeout by blocking on read().
    loop {
        match crossterm::event::read()? {
            crossterm::event::Event::Key(k) => {
                let _ = tx.send(Msg::Input(format!("{k:?}")));
            }
            other => {
                let _ = tx.send(Msg::Input(format!("{other:?}")));
            }
        }
    }
}
