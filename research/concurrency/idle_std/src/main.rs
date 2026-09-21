//! One OS thread blocked on `std::sync::mpsc::Receiver::recv`, no runtime.

fn main() {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::mem::forget(tx);
    std::thread::Builder::new()
        .name("std-recv".into())
        .spawn(move || {
            let _ = rx.recv();
        })
        .unwrap();

    measure::measure_while_idle("idle_std");
}
