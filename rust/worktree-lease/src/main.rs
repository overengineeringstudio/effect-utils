use clap::{Parser, ValueEnum};
use std::{
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, AtomicI32, Ordering},
    time::{Duration, Instant},
};
use worktree_lease::{exit_code, Identity, Lease, Refusal, Result};

static SIGNAL: AtomicI32 = AtomicI32::new(0);
static CHILD: AtomicI32 = AtomicI32::new(0);
static WAITING: AtomicBool = AtomicBool::new(false);
static FORWARD: AtomicBool = AtomicBool::new(false);
unsafe extern "C" {
    fn setitimer(
        which: libc::c_int,
        new: *const libc::itimerval,
        old: *mut libc::itimerval,
    ) -> libc::c_int;
}
/// Same-group broadcasts are not relayed. An outside-group group kill remains
/// indistinguishable from a direct signal and can reach the child twice.
extern "C" fn signal(sig: i32, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
    if sig == libc::SIGALRM {
        let _ = SIGNAL.compare_exchange(0, sig, Ordering::SeqCst, Ordering::SeqCst);
    } else {
        SIGNAL.store(sig, Ordering::SeqCst);
        // SAFETY: SA_SIGINFO supplies initialized information for this handler.
        let sender = unsafe { (*info).si_pid() };
        FORWARD.store(
            sender > 0 && unsafe { libc::getpgid(sender) != libc::getpgrp() },
            Ordering::SeqCst,
        );
    }
    forward(sig);
    if WAITING.load(Ordering::SeqCst) && sig != libc::SIGALRM {
        let _ = timer(0, true);
    }
}
fn forward(sig: i32) {
    let pid = CHILD.load(Ordering::SeqCst);
    // SAFETY: lock-free atomics and signal-safe kernel operations only.
    if pid > 0 && sig != libc::SIGALRM && FORWARD.load(Ordering::SeqCst) {
        unsafe {
            libc::kill(pid, sig);
        }
    }
}
fn timer(seconds: u32, active: bool) -> Result<()> {
    let value = libc::itimerval {
        it_interval: libc::timeval {
            tv_sec: 0,
            tv_usec: if active { 1000 } else { 0 },
        },
        it_value: libc::timeval {
            tv_sec: seconds.into(),
            tv_usec: if active && seconds == 0 { 1 } else { 0 },
        },
    };
    // SAFETY: initialized stack storage; this supervisor exclusively owns ITIMER_REAL.
    // Repeated interrupts close the check-to-flock race without a polling acquisition loop.
    if unsafe { setitimer(libc::ITIMER_REAL, &value, std::ptr::null_mut()) } != 0 {
        return Err(Refusal::UnsafeLock);
    }
    Ok(())
}
#[derive(Clone, ValueEnum)]
enum Mode {
    Shared,
    Exclusive,
}
#[derive(Parser)]
struct Args {
    #[arg(value_parser = ["run"])]
    action: String,
    worktree: PathBuf,
    #[arg(long, value_enum)]
    mode: Mode,
    #[arg(long = "try", required_unless_present = "await_seconds")]
    attempt: bool,
    #[arg(long = "await", conflicts_with = "attempt", value_name = "SECONDS")]
    await_seconds: Option<u32>,
    #[arg(long, env = "WORKTREE_LEASE_AGENT")]
    agent: Option<String>,
    #[arg(long)]
    job: Option<String>,
    #[arg(last = true, required = true)]
    command: Vec<std::ffi::OsString>,
}
fn run(args: &Args) -> Result<i32> {
    let exclusive = matches!(args.mode, Mode::Exclusive);
    let attributed = args
        .agent
        .as_deref()
        .is_some_and(|a| a.starts_with("agent/") && a.len() > 6);
    if !attributed {
        if exclusive {
            return Err(Refusal::AttributionFailure);
        }
        eprintln!(
            "warning: missing or invalid agent attribution; continuing with shared protection"
        );
    }
    // SAFETY: single-threaded supervisor; sigaction is initialized and handlers do not restart flock.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = signal as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGALRM] {
            if libc::sigaction(sig, &action, std::ptr::null_mut()) != 0 {
                return Err(Refusal::UnsafeLock);
            }
        }
    }
    let lease = Lease::open(Identity::resolve(&args.worktree)?)?;
    let start = Instant::now();
    let mut acquired = lease.acquire(exclusive, false);
    if acquired == Err(Refusal::Busy) {
        if let Some(seconds) = args.await_seconds {
            WAITING.store(true, Ordering::SeqCst);
            timer(seconds, true)?;
            if SIGNAL.load(Ordering::SeqCst) == 0 {
                acquired = lease.acquire(exclusive, true);
            }
            WAITING.store(false, Ordering::SeqCst);
            timer(0, false)?;
            if SIGNAL.load(Ordering::SeqCst) == libc::SIGALRM
                || (SIGNAL.load(Ordering::SeqCst) == 0
                    && start.elapsed() >= Duration::from_secs(seconds.into()))
            {
                return Err(Refusal::Deadline);
            }
        }
    }
    let interrupted = SIGNAL.load(Ordering::SeqCst);
    if interrupted == libc::SIGALRM {
        return Err(Refusal::Deadline);
    }
    if interrupted != 0 {
        eprintln!("worktree-lease: acquisition cancelled");
        return Ok(128 + interrupted);
    }
    acquired?;
    lease.validate()?;
    let mut child = Command::new(&args.command[0])
        .args(&args.command[1..])
        .spawn()
        .map_err(|_| Refusal::InvalidInput)?;
    CHILD.store(
        i32::try_from(child.id()).map_err(|_| Refusal::UnsafeLock)?,
        Ordering::SeqCst,
    );
    let interrupted = SIGNAL.load(Ordering::SeqCst);
    if interrupted != 0 {
        forward(interrupted);
    }
    let status = child.wait().map_err(|_| Refusal::UnsafeLock)?;
    CHILD.store(0, Ordering::SeqCst);
    drop(lease);
    Ok(exit_code(status))
}
fn main() {
    let code = run(&Args::parse()).unwrap_or_else(|error| {
        eprintln!("worktree-lease: {error:?}");
        error.code()
    });
    std::process::exit(code);
}
