//! Stream a chunked SSE-ish body with attohttpc (tls-rustls, no tokio in default path).

use std::time::Duration;

fn main() {
    let (addr, server) = sse_server::spawn_chunked_sse(8, Duration::from_millis(200));
    let url = format!("http://{addr}/sse");
    let response = attohttpc::get(&url).send().expect("attohttpc get");
    let (_status, _headers, mut reader) = response.split();
    sse_server::dump_arrivals("attohttpc", &mut reader);
    let _ = server.join();
}
