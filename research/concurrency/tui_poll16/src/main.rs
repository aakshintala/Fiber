//! Typical ratatui example loop: `event::poll(16ms)` then maybe `read`.
//! This is the "frame timer" shape, measured so it can be compared with tui_idle.

use std::time::Duration;

fn main() {
    std::thread::Builder::new()
        .name("poll16".into())
        .spawn(|| loop {
            match crossterm::event::poll(Duration::from_millis(16)) {
                Ok(true) => {
                    let _ = crossterm::event::read();
                }
                Ok(false) => {}
                Err(_) => {
                    // No tty: still sleep 16ms so the wakeup rate matches the example.
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
        })
        .unwrap();

    measure::measure_while_idle("tui_poll16");
}
