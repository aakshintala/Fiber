//! Multi-thread tokio runtime, no work: a spawned `pending()` task plus an
//! unused mpsc receiver. Main thread sleeps through the measurement window.

fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("tokio-worker")
        .build()
        .expect("tokio mt runtime");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
    std::mem::forget(tx);
    rt.spawn(async move {
        let _ = rx.recv().await;
    });
    rt.spawn(std::future::pending::<()>());

    if std::env::var("IDLE_MODE").ok().as_deref() == Some("sleep") {
        rt.spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(86_400)).await;
        });
    }

    measure::measure_while_idle("idle_tokio_mt");
    drop(rt);
}
