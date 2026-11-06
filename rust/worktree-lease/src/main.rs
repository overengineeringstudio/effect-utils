use clap::{Parser, ValueEnum};
use std::{
    os::unix::process::CommandExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, AtomicI32, Ordering},
    time::{Duration, Instant},
};
use worktree_lease::{exit_code, Identity, Lease, Refusal, Result};

static SIGNAL: AtomicI32 = AtomicI32::new(0);
static CHILD: AtomicI32 = AtomicI32::new(0);
static WAITING: AtomicBool = AtomicBool::new(false);
unsafe extern "C" {
    fn setitimer(
        which: libc::c_int,
        new: *const libc::itimerval,
        old: *mut libc::itimerval,
    ) -> libc::c_int;
}
extern "C" fn signal(sig: i32) {
    if sig == libc::SIGALRM {
        let _ = SIGNAL.compare_exchange(0, sig, Ordering::SeqCst, Ordering::SeqCst);
    } else {
        SIGNAL.store(sig, Ordering::SeqCst);
    }
    forward(sig);
    if WAITING.load(Ordering::SeqCst) && sig != libc::SIGALRM {
        let _ = timer(0, true);
    }
}
fn forward(sig: i32) {
    let pid = CHILD.load(Ordering::SeqCst);
    // SAFETY: lock-free atomics and signal-safe kernel operations only.
    if pid > 0 && sig != libc::SIGALRM {
        unsafe {
            libc::kill(-pid, sig);
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
fn foreground(group: i32) -> Result<()> {
    // SAFETY: ignore SIGTTOU only while transferring the controlling terminal.
    unsafe {
        let previous = libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        let result = libc::tcsetpgrp(libc::STDIN_FILENO, group);
        libc::signal(libc::SIGTTOU, previous);
        if result != 0 {
            return Err(Refusal::UnsafeLock);
        }
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
    let mut blocked: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: defer forwarding until the child process group is published.
    unsafe {
        libc::sigemptyset(&mut blocked);
        libc::sigaddset(&mut blocked, libc::SIGINT);
        libc::sigaddset(&mut blocked, libc::SIGTERM);
        libc::sigprocmask(libc::SIG_BLOCK, &blocked, std::ptr::null_mut());
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
    let mut child = unsafe {
        Command::new(&args.command[0])
            .args(&args.command[1..])
            .process_group(0)
            // SAFETY: restore the inherited signal mask before executing the payload.
            .pre_exec(move || {
                libc::sigprocmask(libc::SIG_UNBLOCK, &blocked, std::ptr::null_mut());
                Ok(())
            })
            .spawn()
            .map_err(|_| Refusal::InvalidInput)?
    };
    CHILD.store(
        i32::try_from(child.id()).map_err(|_| Refusal::UnsafeLock)?,
        Ordering::SeqCst,
    );
    // SAFETY: terminal queries have no memory preconditions.
    let terminal = unsafe { libc::tcgetpgrp(0) == libc::getpgrp() };
    if terminal {
        if foreground(CHILD.load(Ordering::SeqCst)).is_err() {
            unsafe { libc::kill(-CHILD.load(Ordering::SeqCst), libc::SIGKILL) };
            let _ = child.wait();
            return Err(Refusal::UnsafeLock);
        }
        unsafe { libc::kill(-CHILD.load(Ordering::SeqCst), libc::SIGCONT) };
    }
    unsafe { libc::sigprocmask(libc::SIG_UNBLOCK, &blocked, std::ptr::null_mut()) };
    let status = child.wait().map_err(|_| Refusal::UnsafeLock);
    if terminal {
        foreground(unsafe { libc::getpgrp() })?;
    }
    CHILD.store(0, Ordering::SeqCst);
    drop(lease);
    Ok(exit_code(status?))
}
fn main() {
    let code = run(&Args::parse()).unwrap_or_else(|error| {
        eprintln!("worktree-lease: {error:?}");
        error.code()
    });
    std::process::exit(code);
}
