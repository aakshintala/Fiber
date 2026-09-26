#![allow(deprecated)]
//!
//! CPU time comes from `getrusage` (microseconds) on both platforms.
//!
//! macOS: thread count and RSS come from `proc_pidinfo(PROC_PIDTASKINFO)`.
//! Interrupt and timer wakeups come from Mach `task_info(TASK_POWER_INFO)`.
//!
//! Linux: thread count and RSS come from `/proc/self/status`. Context
//! switches are voluntary plus involuntary, summed over `/proc/self/task/*/status`.
//! Linux has no per-process wakeup counter, so the wakeup fields stay 0 and
//! context switches are the idle signal.
//!
//! Every printed number is process-wide on the host that ran the binary.
//! Label the host when you quote them; timings do not carry across platforms.

use std::time::{Duration, Instant};

use libc::{getrusage, rusage, RUSAGE_SELF};
#[cfg(target_os = "macos")]
use libc::{getpid, mach_task_self, proc_pidinfo, proc_taskinfo, task_info, KERN_SUCCESS, PROC_PIDTASKINFO};

#[cfg(target_os = "macos")]
const TASK_POWER_INFO: u32 = 21;

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct TaskPowerInfo {
    total_user: u64,
    total_system: u64,
    task_interrupt_wakeups: u64,
    task_platform_idle_wakeups: u64,
    task_timer_wakeups_bin_1: u64,
    task_timer_wakeups_bin_2: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub wall: Instant,
    pub ru_utime_us: u64,
    pub ru_stime_us: u64,
    /// CPU when `take` finished; differs from `ru_*time_us` by the cost of taking the snapshot.
    pub ru_utime_after_us: u64,
    pub ru_stime_after_us: u64,
    pub ru_maxrss_bytes: u64,
    pub rss_bytes: u64,
    pub threads: i32,
    pub threads_running: i32,
    pub csw: i32,
    pub unix_syscalls: i32,
    pub interrupt_wakeups: u64,
    pub platform_idle_wakeups: u64,
    pub timer_wakeups_bin_1: u64,
    pub timer_wakeups_bin_2: u64,
    pub pti_user_ns: u64,
    pub pti_system_ns: u64,
}

fn rusage_self() -> rusage {
    let mut ru = unsafe { std::mem::zeroed::<rusage>() };
    unsafe {
        getrusage(RUSAGE_SELF, &mut ru);
    }
    ru
}

impl Snapshot {
    #[cfg(target_os = "linux")]
    pub fn take() -> Self {
        let wall = Instant::now();
        let ru = rusage_self();
        let ru_utime_us = timeval_us(ru.ru_utime);
        let ru_stime_us = timeval_us(ru.ru_stime);
        let status = std::fs::read_to_string("/proc/self/status").expect("/proc/self/status");
        let mut csw = 0i64;
        let mut threads_running = 0;
        for task in std::fs::read_dir("/proc/self/task").expect("/proc/self/task").flatten() {
            let Ok(t) = std::fs::read_to_string(task.path().join("status")) else {
                continue;
            };
            csw += status_field(&t, "voluntary_ctxt_switches:")
                + status_field(&t, "nonvoluntary_ctxt_switches:");
            if t.lines().any(|l| l.starts_with("State:\tR")) {
                threads_running += 1;
            }
        }
        let after = rusage_self();
        Snapshot {
            wall,
            ru_utime_us,
            ru_stime_us,
            ru_utime_after_us: timeval_us(after.ru_utime),
            ru_stime_after_us: timeval_us(after.ru_stime),
            // Linux documents ru_maxrss in KiB.
            ru_maxrss_bytes: ru.ru_maxrss as u64 * 1024,
            rss_bytes: status_field(&status, "VmRSS:") as u64 * 1024,
            threads: status_field(&status, "Threads:") as i32,
            threads_running,
            csw: csw as i32,
            unix_syscalls: 0,
            interrupt_wakeups: 0,
            platform_idle_wakeups: 0,
            timer_wakeups_bin_1: 0,
            timer_wakeups_bin_2: 0,
            pti_user_ns: ru_utime_us * 1000,
            pti_system_ns: ru_stime_us * 1000,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn take() -> Self {
        let wall = Instant::now();
        let ru = rusage_self();
        let ru_utime_us = timeval_us(ru.ru_utime);
        let ru_stime_us = timeval_us(ru.ru_stime);
        // Darwin documents ru_maxrss in bytes.
        let ru_maxrss_bytes = ru.ru_maxrss as u64;

        let mut pti = unsafe { std::mem::zeroed::<proc_taskinfo>() };
        let pti_got = unsafe {
            proc_pidinfo(
                getpid(),
                PROC_PIDTASKINFO,
                0,
                &mut pti as *mut _ as *mut libc::c_void,
                std::mem::size_of::<proc_taskinfo>() as libc::c_int,
            )
        };
        if pti_got <= 0 {
            panic!("proc_pidinfo(PROC_PIDTASKINFO) failed: {pti_got}");
        }

        let mut power = TaskPowerInfo::default();
        let mut count = (std::mem::size_of::<TaskPowerInfo>() / std::mem::size_of::<u32>()) as u32;
        let kr = unsafe {
            task_info(
                mach_task_self(),
                TASK_POWER_INFO,
                &mut power as *mut _ as libc::task_info_t,
                &mut count,
            )
        };
        if kr != KERN_SUCCESS {
            panic!("task_info(TASK_POWER_INFO) failed: {kr}");
        }

        Snapshot {
            wall,
            ru_utime_us,
            ru_stime_us,
            ru_utime_after_us: ru_utime_us,
            ru_stime_after_us: ru_stime_us,
            ru_maxrss_bytes,
            rss_bytes: pti.pti_resident_size,
            threads: pti.pti_threadnum,
            threads_running: pti.pti_numrunning,
            csw: pti.pti_csw,
            unix_syscalls: pti.pti_syscalls_unix,
            interrupt_wakeups: power.task_interrupt_wakeups,
            platform_idle_wakeups: power.task_platform_idle_wakeups,
            timer_wakeups_bin_1: power.task_timer_wakeups_bin_1,
            timer_wakeups_bin_2: power.task_timer_wakeups_bin_2,
            pti_user_ns: mach_ticks_to_ns(pti.pti_total_user),
            pti_system_ns: mach_ticks_to_ns(pti.pti_total_system),
        }
    }
}

#[cfg(target_os = "linux")]
fn status_field(status: &str, key: &str) -> i64 {
    status
        .lines()
        .find_map(|l| l.strip_prefix(key))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn timeval_us(tv: libc::timeval) -> u64 {
    (tv.tv_sec as u64)
        .saturating_mul(1_000_000)
        .saturating_add(tv.tv_usec as u64)
}

#[cfg(target_os = "macos")]
fn mach_ticks_to_ns(ticks: u64) -> u64 {
    let mut info = libc::mach_timebase_info_data_t { numer: 0, denom: 0 };
    unsafe {
        libc::mach_timebase_info(&mut info);
    }
    ticks.saturating_mul(info.numer as u64) / info.denom as u64
}

pub fn idle_window() -> Duration {
    Duration::from_secs(env_u64("IDLE_SECS", 60))
}

pub fn settle_window() -> Duration {
    Duration::from_secs(env_u64("SETTLE_SECS", 3))
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub fn platform_line() -> String {
    let mut uts = unsafe { std::mem::zeroed::<libc::utsname>() };
    unsafe {
        libc::uname(&mut uts);
    }
    let sys = cstr(&uts.sysname);
    let rel = cstr(&uts.release);
    let machine = cstr(&uts.machine);
    format!("{sys} {rel} {machine}")
}

fn cstr(buf: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = buf
        .iter()
        .map(|c| *c as u8)
        .take_while(|b| *b != 0)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Debug)]
pub struct Report {
    pub label: String,
    pub platform: String,
    pub window: Duration,
    pub cpu_user_us: u64,
    pub cpu_sys_us: u64,
    pub pti_user_ns: u64,
    pub pti_sys_ns: u64,
    pub threads_start: i32,
    pub threads_end: i32,
    pub threads_running_end: i32,
    pub rss_bytes_end: u64,
    pub maxrss_bytes: u64,
    pub interrupt_wakeups: u64,
    pub platform_idle_wakeups: u64,
    pub timer_wakeups_bin_1: u64,
    pub timer_wakeups_bin_2: u64,
    pub csw: i32,
    pub unix_syscalls: i32,
    pub snapshot_cpu_us: u64,
}

impl Report {
    pub fn from_window(label: &str, start: Snapshot, end: Snapshot) -> Self {
        Report {
            label: label.to_string(),
            platform: platform_line(),
            window: end.wall.saturating_duration_since(start.wall),
            cpu_user_us: end.ru_utime_us.saturating_sub(start.ru_utime_after_us),
            cpu_sys_us: end.ru_stime_us.saturating_sub(start.ru_stime_after_us),
            pti_user_ns: end.pti_user_ns.saturating_sub(start.pti_user_ns),
            pti_sys_ns: end.pti_system_ns.saturating_sub(start.pti_system_ns),
            threads_start: start.threads,
            threads_end: end.threads,
            threads_running_end: end.threads_running,
            rss_bytes_end: end.rss_bytes,
            maxrss_bytes: end.ru_maxrss_bytes,
            interrupt_wakeups: end
                .interrupt_wakeups
                .saturating_sub(start.interrupt_wakeups),
            platform_idle_wakeups: end
                .platform_idle_wakeups
                .saturating_sub(start.platform_idle_wakeups),
            timer_wakeups_bin_1: end
                .timer_wakeups_bin_1
                .saturating_sub(start.timer_wakeups_bin_1),
            timer_wakeups_bin_2: end
                .timer_wakeups_bin_2
                .saturating_sub(start.timer_wakeups_bin_2),
            csw: end.csw.saturating_sub(start.csw),
            unix_syscalls: end.unix_syscalls.saturating_sub(start.unix_syscalls),
            snapshot_cpu_us: (end.ru_utime_after_us + end.ru_stime_after_us)
                .saturating_sub(end.ru_utime_us + end.ru_stime_us),
        }
    }

    pub fn cpu_total_us(&self) -> u64 {
        self.cpu_user_us.saturating_add(self.cpu_sys_us)
    }

    pub fn wakeup_sum(&self) -> u64 {
        self.interrupt_wakeups
            .saturating_add(self.platform_idle_wakeups)
            .saturating_add(self.timer_wakeups_bin_1)
            .saturating_add(self.timer_wakeups_bin_2)
    }

    pub fn cpu_pct_of_one_core(&self) -> f64 {
        let window_us = self.window.as_secs_f64() * 1_000_000.0;
        if window_us <= 0.0 {
            return 0.0;
        }
        (self.cpu_total_us() as f64) / window_us * 100.0
    }

    pub fn wakeups_per_sec(&self) -> f64 {
        let s = self.window.as_secs_f64();
        if s <= 0.0 {
            return 0.0;
        }
        self.wakeup_sum() as f64 / s
    }

    pub fn csw_per_sec(&self) -> f64 {
        let s = self.window.as_secs_f64();
        if s <= 0.0 {
            return 0.0;
        }
        self.csw as f64 / s
    }

    pub fn print(&self) {
        println!("=== {} ===", self.label);
        println!("platform: {}", self.platform);
        println!("window_s: {:.3}", self.window.as_secs_f64());
        println!("cpu_user_us: {}", self.cpu_user_us);
        println!("cpu_sys_us: {}", self.cpu_sys_us);
        println!("cpu_total_us: {}", self.cpu_total_us());
        println!("cpu_total_ms: {:.3}", self.cpu_total_us() as f64 / 1000.0);
        println!("cpu_pct_of_one_core: {:.6}", self.cpu_pct_of_one_core());
        println!(
            "pti_cpu_ns: {} (user {}) (sys {})",
            self.pti_user_ns + self.pti_sys_ns,
            self.pti_user_ns,
            self.pti_sys_ns
        );
        println!("threads_start: {}", self.threads_start);
        println!("threads_end: {}", self.threads_end);
        println!("threads_running_end: {}", self.threads_running_end);
        println!("rss_bytes: {}", self.rss_bytes_end);
        println!("rss_kib: {:.1}", self.rss_bytes_end as f64 / 1024.0);
        println!("maxrss_bytes: {}", self.maxrss_bytes);
        if cfg!(target_os = "linux") {
            println!("wakeups: n/a on Linux (use csw)");
        }
        println!("interrupt_wakeups: {}", self.interrupt_wakeups);
        println!("platform_idle_wakeups: {}", self.platform_idle_wakeups);
        println!("timer_wakeups_bin_1: {}", self.timer_wakeups_bin_1);
        println!("timer_wakeups_bin_2: {}", self.timer_wakeups_bin_2);
        println!("wakeup_sum: {}", self.wakeup_sum());
        println!("wakeups_per_sec: {:.4}", self.wakeups_per_sec());
        println!("csw: {}", self.csw);
        println!("csw_per_sec: {:.4}", self.csw_per_sec());
        println!("unix_syscalls_delta: {}", self.unix_syscalls);
        println!("snapshot_cpu_us (excluded from the window): {}", self.snapshot_cpu_us);
    }
}

/// Settle, snapshot, park for the idle window, snapshot, print.
///
/// Call this after the program has already created whatever threads or
/// runtime it wants to keep parked. The calling thread sleeps; it must not
/// be the thread that drives a current-thread executor.
pub fn measure_while_idle(label: &str) -> Report {
    std::thread::sleep(settle_window());
    let start = Snapshot::take();
    std::thread::sleep(idle_window());
    let end = Snapshot::take();
    let report = Report::from_window(label, start, end);
    report.print();
    report
}
