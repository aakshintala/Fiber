//! Hand-rolled idle: one thread blocked in `polling::Poller::wait` with no timeout
//! on a pipe that never becomes readable.

use std::io::pipe;
use std::os::fd::AsRawFd;

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
        .name("poll-wait".into())
        .spawn(move || {
            let mut events = Events::new();
            let _ = poller.wait(&mut events, None);
        })
        .unwrap();

    measure::measure_while_idle("idle_polling");
    drop(writer);
}
