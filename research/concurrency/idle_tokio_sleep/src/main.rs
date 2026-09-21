//! Multi-thread tokio with a 24-hour `sleep` registered on the time driver.

fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("tokio-worker")
        .build()
        .expect("runtime");

    rt.spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(86_400)).await;
    });

    measure::measure_while_idle("idle_tokio_sleep");
    drop(rt);
}
