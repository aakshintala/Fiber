//! Smol runtime parked on `pending()`. Reactor thread is created on first use.

fn main() {
    std::thread::Builder::new()
        .name("smol-block".into())
        .spawn(|| {
            smol::block_on(std::future::pending::<()>());
        })
        .unwrap();

    measure::measure_while_idle("idle_smol");
}
