//! Stream a chunked SSE-ish body with isahc (libcurl). Features chosen to avoid tokio.

use std::time::Duration;

fn main() {
    let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
    let url = format!("http://{addr}/sse");
    let mut response = isahc::get(&url).expect("isahc get");
    sse_server::dump_arrivals("isahc", response.body_mut());
    let _ = server.join();
}
