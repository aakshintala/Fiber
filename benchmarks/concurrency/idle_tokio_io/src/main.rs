//! Multi-thread tokio with a real idle TCP read registered on the reactor.
//! Closer to Fiber than `pending()`: an open connection, no bytes arriving.

use tokio::io::AsyncReadExt;

fn main() {
    let (addr, _hold) = sse_server::spawn_silent_tcp();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("tokio-worker")
        .build()
        .expect("runtime");

    rt.spawn(async move {
        let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let mut buf = [0u8; 8];
        let _ = stream.read(&mut buf).await;
    });

    measure::measure_while_idle("idle_tokio_io");
    drop(rt);
}
