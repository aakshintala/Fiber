//! Stream a chunked SSE-ish body with ureq (rustls feature, no default features).

use std::time::Duration;

fn main() {
    let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
    let url = format!("http://{addr}/sse");
    let mut response = ureq::get(&url).call().expect("ureq get");
    let mut reader = response.body_mut().as_reader();
    sse_server::dump_arrivals("ureq", &mut reader);
    let _ = server.join();
}
