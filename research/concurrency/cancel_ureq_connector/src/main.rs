//! Can a custom ureq Connector stash a TcpStream so another thread can
//! shutdown() a body read that is blocked inside ureq?
//!
//! `TcpTransport` is `pub` inside ureq but not re-exported from
//! `ureq::unversioned::transport`, so this uses the public `Transport` trait
//! on a stream we own.
//!
//! The shutdown probe runs `CANCEL_ITERS` times (default 20) over plain HTTP
//! and over HTTPS, where rustls sits between ureq and the stashed socket.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use ureq::config::Config;
use ureq::tls::{Certificate, RootCerts, TlsConfig};
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, RustlsConnector, Transport,
};
use ureq::Agent;

fn main() {
    let iters = std::env::var("CANCEL_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20usize);
    let tls = TestCert::new();
    for (label, cert) in [("http", None), ("https", Some(&tls))] {
        let mut samples = Vec::new();
        for _ in 0..iters {
            if let Some(us) = probe_shutdown(label, cert) {
                samples.push(us);
            }
        }
        samples.sort_by(|a, b| a.total_cmp(b));
        if samples.is_empty() {
            println!("cancel-via-connector {label} summary n=0");
            continue;
        }
        println!(
            "cancel-via-connector {label} summary n={} median={:.1}us min={:.1}us max={:.1}us",
            samples.len(),
            samples[samples.len() / 2],
            samples[0],
            samples[samples.len() - 1]
        );
    }
    probe_chunked_decoded();
}

/// A self-signed certificate for 127.0.0.1, trusted by the probe's agent.
struct TestCert {
    der: &'static [u8],
    server: Arc<rustls::ServerConfig>,
}

impl TestCert {
    fn new() -> Self {
        let certified = rcgen::generate_simple_self_signed(["127.0.0.1".into()]).expect("rcgen");
        let der: &'static [u8] = Box::leak(certified.cert.der().to_vec().into_boxed_slice());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(certified.key_pair.serialize_der()));
        let server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("protocols")
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(der)], key)
        .expect("server config");
        TestCert {
            der,
            server: Arc::new(server),
        }
    }
}

/// Like `sse_server::spawn_hang`, over TLS: accept one connection, send
/// response headers, then hold the socket open until the sender is dropped.
fn spawn_tls_hang(config: Arc<rustls::ServerConfig>) -> (std::net::SocketAddr, mpsc::Sender<()>) {
    let listener = sse_server::bind_local();
    let addr = listener.local_addr().unwrap();
    let (keep, hold_rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        let (sock, _) = listener.accept().expect("accept tls hang");
        let _ = sock.set_nodelay(true);
        let conn = rustls::ServerConnection::new(config).expect("server conn");
        let mut tls = rustls::StreamOwned::new(conn, sock);
        let mut buf = [0u8; 4096];
        let _ = tls.read(&mut buf);
        let _ = tls.write_all(
            b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Transfer-Encoding: chunked\r\n\
Connection: keep-alive\r\n\
\r\n",
        );
        let _ = tls.flush();
        let _ = hold_rx.recv();
    });
    (addr, keep)
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

fn agent_with_slot(cert: Option<&TestCert>) -> (Agent, Slot) {
    let slot: Slot = Arc::new(Mutex::new(None));
    let connector = StashConnector {
        slot: Arc::clone(&slot),
    }
    .chain(RustlsConnector::default());
    let mut config = Config::builder();
    if let Some(cert) = cert {
        let roots = RootCerts::new_with_certs(&[Certificate::from_der(cert.der)]);
        config = config.tls_config(TlsConfig::builder().root_certs(roots).build());
    }
    let agent = Agent::with_parts(config.build(), connector, DefaultResolver::default());
    (agent, slot)
}

/// Returns the latency from `shutdown()` to the blocked read returning, in µs.
fn probe_shutdown(label: &str, cert: Option<&TestCert>) -> Option<f64> {
    let (url, _hold): (String, Box<dyn std::any::Any>) = match cert {
        None => {
            let (addr, hold) = sse_server::spawn_hang();
            (format!("http://{addr}/hang"), Box::new(hold))
        }
        Some(cert) => {
            let (addr, hold) = spawn_tls_hang(Arc::clone(&cert.server));
            (format!("https://{addr}/hang"), Box::new(hold))
        }
    };
    let (agent, slot) = agent_with_slot(cert);
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
        println!("cancel-via-connector {label} shutdown after 0us result=never-reached-body-read");
        std::mem::forget(handle);
        return None;
    }
    thread::sleep(Duration::from_millis(5));
    let t0 = Instant::now();
    match slot.lock().unwrap().take() {
        Some(stream) => {
            if let Err(e) = stream.shutdown(Shutdown::Both) {
                println!("cancel-via-connector {label} shutdown after 0us result=shutdown-err {e}");
                std::mem::forget(handle);
                return None;
            }
        }
        None => {
            println!("cancel-via-connector {label} shutdown after 0us result=no-stashed-TcpStream");
            std::mem::forget(handle);
            return None;
        }
    }
    let result = handle.join().unwrap();
    let us = t0.elapsed().as_secs_f64() * 1_000_000.0;
    println!("cancel-via-connector {label} shutdown after {us:.1}us result={result}");
    Some(us)
}

fn probe_chunked_decoded() {
    let events = 4usize;
    let (addr, server) = sse_server::spawn_chunked_sse(events, Duration::from_millis(50));
    let url = format!("http://{addr}/sse");
    let (agent, _slot) = agent_with_slot(None);
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
