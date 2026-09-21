//! async-std parked on `pending()`, measured the same way as tokio/smol.

fn main() {
    std::thread::Builder::new()
        .name("async-std-block".into())
        .spawn(|| {
            async_std::task::block_on(std::future::pending::<()>());
        })
        .unwrap();

    measure::measure_while_idle("idle_async_std");
}
