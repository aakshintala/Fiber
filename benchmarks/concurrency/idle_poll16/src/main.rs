//! Frame-timer shape: `Poller::wait(Some(16ms))` on a pipe that never becomes
//! readable. This is the OS primitive behind crossterm `event::poll(16ms)`
//! without needing a tty.

use std::io::pipe;
use std::os::fd::AsRawFd;
use std::time::Duration;

use polling::{Event, Events, Poller};

fn main() {
    let (reader, writer) = pipe().expect("pipe");
    let poller = Poller::new().expect("poller");
    unsafe {
        poller
            .add(reader.as_raw_fd(), Event::readable(1))
            .expect("add");
    }

    std::thread::Builder::new()
        .name("poll-16ms".into())
        .spawn(move || {
            let mut events = Events::new();
            loop {
                events.clear();
                let _ = poller.wait(&mut events, Some(Duration::from_millis(16)));
            }
        })
        .unwrap();

    measure::measure_while_idle("idle_poll16");
    drop(writer);
}
