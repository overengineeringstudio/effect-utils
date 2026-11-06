use clap::{Parser, ValueEnum};
use std::{
    io::Write,
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
    let pid = CHILD.load(Ordering::SeqCst);
    // SAFETY: the handler uses lock-free atomics and signal-safe kernel operations only.
    if pid > 0 && sig != libc::SIGALRM {
        unsafe {
            libc::kill(pid, sig);
        }
    }
    if WAITING.load(Ordering::SeqCst) && sig != libc::SIGALRM {
        let _ = timer(0, true);
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
fn emit(tag: &str, reason: &str, warning: Option<&str>, job: Option<&str>) {
    #[derive(serde::Serialize)]
    struct Record<'a> {
        _tag: &'a str,
        reason: &'a str,
        warning: Option<&'a str>,
        job: Option<&'a str>,
    }
    let mut stderr = std::io::stderr().lock();
    let _ = serde_json::to_writer(
        &mut stderr,
        &Record {
            _tag: tag,
            reason,
            warning,
            job,
        },
    );
    let _ = stderr.write_all(b"\n");
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
    #[arg(long)]
    json: bool,
    #[arg(last = true, required = true)]
    command: Vec<std::ffi::OsString>,
}
fn run(args: &Args) -> Result<i32> {
    let exclusive = matches!(args.mode, Mode::Exclusive);
    let attributed = args
        .agent
        .as_deref()
        .is_some_and(|a| a.starts_with("agent/") && a.len() > 6);
    let warning = (!attributed)
        .then_some("missing or invalid agent attribution; continuing with shared protection");
    if !attributed {
        if exclusive {
            return Err(Refusal::AttributionFailure);
        }
        if !args.json {
            eprintln!("warning: {}", warning.unwrap_or_default());
        }
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
    let interrupted = SIGNAL.load(Ordering::SeqCst);
    if interrupted == libc::SIGALRM {
        return Err(Refusal::Deadline);
    }
    if interrupted != 0 {
        if args.json {
            emit(
                "UnsafeLock",
                "acquisition cancelled",
                warning,
                args.job.as_deref(),
            );
        }
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
        signal(interrupted);
    }
    let status = child.wait().map_err(|_| Refusal::UnsafeLock)?;
    CHILD.store(0, Ordering::SeqCst);
    if args.json {
        emit(
            "Granted",
            "scoped lease completed",
            warning,
            args.job.as_deref(),
        );
    }
    drop(lease);
    Ok(exit_code(status))
}
fn main() {
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error) => {
            if std::env::args_os()
                .take_while(|a| a != "--")
                .any(|a| a == "--json")
            {
                emit("InvalidInput", "invalid command line", None, None);
                std::process::exit(2);
            }
            error.exit();
        }
    };
    let json = args.json;
    let code = run(&args).unwrap_or_else(|error| {
        if json {
            emit(error.tag(), error.tag(), None, args.job.as_deref());
        } else {
            eprintln!("worktree-lease: {error:?}");
        }
        error.code()
    });
    std::process::exit(code);
}
