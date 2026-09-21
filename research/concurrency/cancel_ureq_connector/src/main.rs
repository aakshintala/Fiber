//! Can a custom ureq Connector stash a TcpStream so another thread can
//! shutdown() a body read that is blocked inside ureq?
//!
//! `TcpTransport` is `pub` inside ureq but not re-exported from
//! `ureq::unversioned::transport`, so this uses the public `Transport` trait
//! on a stream we own.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use ureq::config::Config;
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, RustlsConnector, Transport,
};
use ureq::Agent;

fn main() {
    probe_http_shutdown();
    probe_chunked_decoded();
}

type Slot = Arc<Mutex<Option<TcpStream>>>;

#[derive(Debug)]
struct StashConnector {
    slot: Slot,
}

struct StashTransport {
    stream: TcpStream,
    buffers: LazyBuffers,
}

impl Connector<()> for StashConnector {
    type Out = StashTransport;

    fn connect(
        &self,
        details: &ConnectionDetails,
        _chained: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let addr = details.addrs.iter().copied().next().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no resolved address")
        })?;
        let stream = TcpStream::connect(addr)?;
        if details.config.no_delay() {
            stream.set_nodelay(true)?;
        }
        *self.slot.lock().unwrap() = Some(stream.try_clone()?);
        let buffers = LazyBuffers::new(
            details.config.input_buffer_size(),
            details.config.output_buffer_size(),
        );
        Ok(Some(StashTransport { stream, buffers }))
    }
}

impl Transport for StashTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, _timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.write_all(&self.buffers.output()[..amount])?;
        Ok(())
    }

    fn await_input(&mut self, _timeout: NextTimeout) -> Result<bool, ureq::Error> {
        let buf = self.buffers.input_append_buf();
        let n = self.stream.read(buf)?;
        self.buffers.input_appended(n);
        Ok(n > 0)
    }

    fn is_open(&mut self) -> bool {
        true
    }
}

impl std::fmt::Debug for StashTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StashTransport")
            .field("addr", &self.stream.peer_addr().ok())
            .finish()
    }
}

fn agent_with_slot() -> (Agent, Slot) {
    let slot: Slot = Arc::new(Mutex::new(None));
    let connector = StashConnector {
        slot: Arc::clone(&slot),
    }
    .chain(RustlsConnector::default());
    let agent = Agent::with_parts(Config::default(), connector, DefaultResolver::default());
    (agent, slot)
}

fn probe_http_shutdown() {
    let (addr, _server) = sse_server::spawn_hang();
    let url = format!("http://{addr}/hang");
    let (agent, slot) = agent_with_slot();
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let mut response = match agent.get(&url).call() {
            Ok(r) => r,
            Err(e) => return format!("call-err {e}"),
        };
        ready_tx.send(()).ok();
        let mut buf = [0u8; 32];
        let mut reader = response.body_mut().as_reader();
        match reader.read(&mut buf) {
            Ok(n) => format!("Ok({n})"),
            Err(e) => format!("Err({e})"),
        }
    });
    if ready_rx.recv_timeout(Duration::from_secs(2)).is_err() {
        println!("cancel-via-connector http shutdown after 0us result=never-reached-body-read");
        std::mem::forget(handle);
        return;
    }
    thread::sleep(Duration::from_millis(5));
    let t0 = Instant::now();
    match slot.lock().unwrap().take() {
        Some(stream) => {
            if let Err(e) = stream.shutdown(Shutdown::Both) {
                println!("cancel-via-connector http shutdown after 0us result=shutdown-err {e}");
                std::mem::forget(handle);
                return;
            }
        }
        None => {
            println!("cancel-via-connector http shutdown after 0us result=no-stashed-TcpStream");
            std::mem::forget(handle);
            return;
        }
    }
    let result = handle.join().unwrap();
    let us = t0.elapsed().as_secs_f64() * 1_000_000.0;
    println!("cancel-via-connector http shutdown after {us:.1}us result={result}");
}

fn probe_chunked_decoded() {
    let events = 4usize;
    let (addr, server) = sse_server::spawn_chunked_sse(events, Duration::from_millis(50));
    let url = format!("http://{addr}/sse");
    let (agent, _slot) = agent_with_slot();
    let mut response = match agent.get(&url).call() {
        Ok(r) => r,
        Err(e) => {
            println!("cancel-via-connector chunked decoded=false chunks=0 call-err {e}");
            return;
        }
    };
    let mut reader = response.body_mut().as_reader();
    let start = Instant::now();
    let mut buf = [0u8; 512];
    let mut body = Vec::new();
    let mut n_reads = 0u32;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                n_reads += 1;
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                let text = String::from_utf8_lossy(&buf[..n]);
                println!("cancel-via-connector chunked +{ms:.1}ms bytes={n} {text:?}");
                body.extend_from_slice(&buf[..n]);
            }
            Err(e) => {
                println!("cancel-via-connector chunked read-err {e}");
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&body);
    let framing = text.contains("f\r\n") || text.contains("0\r\n\r\n");
    let payloads = (0..events)
        .filter(|i| text.contains(&format!("data: event-{i}")))
        .count();
    let decoded = !framing && payloads == events;
    println!("cancel-via-connector chunked decoded={decoded} chunks={n_reads}");
    let _ = server.join();
}
