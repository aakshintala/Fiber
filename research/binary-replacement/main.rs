use std::{env, process::Command, thread, time::Duration, io::Write};
fn main() {
    let a: Vec<String> = env::args().collect();
    if a.get(1).map(|s| s.as_str()) == Some("child") { println!("child ok v{}", env!("V")); return; }
    let log = a[1].clone();
    for i in 0..40 {
        thread::sleep(Duration::from_millis(250));
        let exe = env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|e| format!("ERR {e}"));
        let spawn = Command::new(env::current_exe().unwrap()).arg("child").output()
            .map(|o| format!("status={} out={}", o.status, String::from_utf8_lossy(&o.stdout).trim()))
            .unwrap_or_else(|e| format!("spawn ERR {e}"));
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap();
        writeln!(f, "v{} tick {i} exe={exe} {spawn}", env!("V")).unwrap();
    }
}
