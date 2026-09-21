//! Blocking rustls client/server with no tokio.
//! Serves a chunked SSE-ish body over TLS; the client prints arrival times.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore, ServerConfig};

fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("ring provider");

    let certified = rcgen::generate_simple_self_signed(["localhost".into()]).expect("rcgen");
    let cert_der = CertificateDer::from(certified.cert.der().to_vec());
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        certified.key_pair.serialize_der(),
    ));

    let server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der.clone()], key_der)
        .expect("server config");
    let server_config = Arc::new(server_config);

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().unwrap();

    let server = thread::spawn(move || {
        let (sock, _) = listener.accept().expect("accept");
        let conn = rustls::ServerConnection::new(server_config).expect("server conn");
        let mut tls = rustls::StreamOwned::new(conn, sock);
        let mut req = [0u8; 1024];
        let _ = tls.read(&mut req);
        tls.write_all(
            b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Transfer-Encoding: chunked\r\n\
Connection: close\r\n\
\r\n",
        )
        .unwrap();
        tls.flush().ok();
        for i in 0..8 {
            let body = format!("data: event-{i}\n\n");
            let chunk = format!("{:x}\r\n{}\r\n", body.len(), body);
            tls.write_all(chunk.as_bytes()).unwrap();
            tls.flush().ok();
            if i + 7 < 15 && i < 7 {
                thread::sleep(Duration::from_millis(200));
            }
        }
        tls.write_all(b"0\r\n\r\n").ok();
        tls.flush().ok();
    });

    let mut roots = RootCertStore::empty();
    roots.add(cert_der).expect("add root");
    let client_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let client_config = Arc::new(client_config);

    let sock = std::net::TcpStream::connect(addr).expect("connect");
    let server_name = ServerName::try_from("localhost").unwrap();
    let conn = rustls::ClientConnection::new(client_config, server_name).expect("client conn");
    let mut tls = rustls::StreamOwned::new(conn, sock);
    tls.write_all(b"GET /sse HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    tls.flush().ok();

    // Skip HTTP headers, then dump body arrivals.
    let mut reader = BufReader::new(tls);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        headers.push_str(&line);
    }
    let _ = headers;
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
                println!("rustls read#{n_reads} +{ms:.1}ms bytes={n} {text:?}");
            }
            Err(e) => {
                println!("rustls read-err {e}");
                break;
            }
        }
    }
    println!(
        "rustls done reads={n_reads} elapsed_ms={:.1}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let _ = server.join();
}
