//! Current-thread tokio runtime parked on a channel / pending future.
//! The runtime is driven on a dedicated thread; main measures.

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio ct runtime");

    std::thread::Builder::new()
        .name("tokio-ct".into())
        .spawn(move || {
            rt.block_on(async {
                let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
                std::mem::forget(tx);
                tokio::spawn(async move {
                    let _ = rx.recv().await;
                });
                std::future::pending::<()>().await
            });
        })
        .unwrap();

    measure::measure_while_idle("idle_tokio_ct");
}
