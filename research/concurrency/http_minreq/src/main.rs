//! Probe minreq streaming.
//!
//! `send()` buffers the whole body. `send_lazy()` implements `Read` and
//! yields bytes as they arrive. This program runs both against the same
//! chunked SSE-ish server shape.

use std::time::{Duration, Instant};

fn main() {
    {
        let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
        let url = format!("http://{addr}/sse");
        let start = Instant::now();
        let response = minreq::get(&url).send().expect("minreq send");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let body = response.as_str().unwrap_or("<non-utf8>");
        println!(
            "minreq send() assembled body after +{elapsed_ms:.1}ms bytes={}",
            body.len()
        );
        println!("minreq send() body={body:?}");
        let _ = server.join();
    }
    {
        let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
        let url = format!("http://{addr}/sse");
        let mut lazy = minreq::get(&url).send_lazy().expect("minreq send_lazy");
        sse_server::dump_arrivals("minreq send_lazy 512B buf", &mut lazy);
        let _ = server.join();
    }
    {
        let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
        let url = format!("http://{addr}/sse");
        let mut lazy = minreq::get(&url).send_lazy().expect("minreq send_lazy 1B");
        let start = Instant::now();
        let mut total = 0usize;
        let mut n_reads = 0u32;
        let mut one = [0u8; 1];
        loop {
            match std::io::Read::read(&mut lazy, &mut one) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    n_reads += 1;
                    if one[0] == b'\n' {
                        println!(
                            "minreq 1-byte-read newline +{:.1}ms total_bytes={total}",
                            start.elapsed().as_secs_f64() * 1000.0
                        );
                    }
                }
                Err(e) => {
                    println!("minreq 1-byte-read err {e}");
                    break;
                }
            }
        }
        println!("minreq 1-byte-read done reads={n_reads} bytes={total}");
        let _ = server.join();
    }
}
