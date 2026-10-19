//! Wait only for endpoint publication; authentication remains the caller's responsibility.
use super::*;

impl Ctl {
    pub(super) fn connect_endpoint(&self, domain: &str, pid: u32) -> Result<UnixStream> {
        let socket = Path::new(self.arg("socket")?);
        connect(socket, Duration::from_secs(15), pid, || self.job(domain))
    }
}

fn connect(socket: &Path, timeout: Duration, pid: u32,
    job: impl FnMut() -> Result<(bool, Option<u32>)>) -> Result<UnixStream> {
    connect_observed(socket, timeout, pid, job, || {})
}

fn connect_observed(socket: &Path, timeout: Duration, pid: u32,
    mut job: impl FnMut() -> Result<(bool, Option<u32>)>,
    mut retry: impl FnMut()) -> Result<UnixStream> {
    let started = Instant::now();
    loop {
        let (loaded, current_pid) = job()?;
        if !loaded || current_pid != Some(pid) {
            return Err(fail(23, "job-not-running", format!(
                "Launchd job stopped or changed PID while waiting for {} (expected PID {pid}, loaded={loaded}, observed PID {current_pid:?})", socket.display())));
        }
        match UnixStream::connect(socket) {
            Ok(stream) => return Ok(stream),
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ECONNREFUSED)) => {},
            Err(error) => return Err(error.into()),
        }
        retry();
        let waited = started.elapsed();
        if waited >= timeout {
            return Err(fail(23, "endpoint-unready", format!(
                "Control socket {} was not ready after {waited:?} (deadline {timeout:?})", socket.display())));
        }
        std::thread::sleep(Duration::from_millis(50).min(timeout - waited));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::net::UnixListener, process::Child, sync::atomic::{AtomicU64, Ordering}};

    struct Fixture { directory: PathBuf, child: Child, checks: usize }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            // Relative paths keep the socket below SUN_LEN even in a long checkout path.
            fs::create_dir_all("tmp").unwrap();
            let directory = PathBuf::from("tmp").join(format!("ctl-ready-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&directory).unwrap();
            let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
            Self { directory, child, checks: 0 }
        }
        fn socket(&self) -> PathBuf { self.directory.join("control.sock") }
        // A real child is the local process-liveness substitute for launchd's job snapshot.
        fn job(&mut self) -> Result<(bool, Option<u32>)> {
            self.checks += 1;
            Ok((true, self.child.try_wait()?.is_none().then_some(self.child.id())))
        }
        fn connect(&mut self, path: &Path, timeout: Duration) -> Result<UnixStream> {
            connect(path, timeout, self.child.id(), || self.job())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    #[test]
    fn connects_when_listener_binds_after_delay() {
        let mut fixture = Fixture::new();
        let socket = fixture.socket();
        let binding = socket.clone();
        let (failed, attempt) = std::sync::mpsc::channel();
        let (bound, ready) = std::sync::mpsc::channel();
        let listener = std::thread::spawn(move || {
            attempt.recv().unwrap();
            let listener = UnixListener::bind(binding).unwrap();
            bound.send(()).unwrap();
            listener.accept().unwrap()
        });
        let mut failed = Some(failed);
        let stream = connect_observed(&socket, Duration::from_secs(2), fixture.child.id(), || fixture.job(), || {
            if let Some(failed) = failed.take() {
                failed.send(()).unwrap();
                ready.recv().unwrap();
            }
        }).unwrap();
        assert!(fixture.checks > 1);
        drop(stream);
        listener.join().unwrap();
    }

    #[test]
    fn missing_listener_returns_typed_timeout() {
        let mut fixture = Fixture::new();
        let socket = fixture.socket();
        let timeout = Duration::from_millis(120);
        let started = Instant::now();
        let error = fixture.connect(&socket, timeout).unwrap_err();
        assert_eq!(error.kind, "endpoint-unready");
        assert_eq!(error.code, 23);
        assert!(error.reason.contains(socket.to_str().unwrap()));
        assert!(error.reason.contains("120ms"));
        assert!(started.elapsed() >= timeout);
    }

    #[test]
    fn refused_listener_is_retried() {
        let mut fixture = Fixture::new();
        let socket = fixture.socket();
        // Bind without listening, so forked descriptors from concurrent process
        // tests cannot temporarily keep a closed listener accepting connections.
        // SAFETY: socket has no pointer arguments and returns a fresh descriptor.
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(fd >= 0);
        // SAFETY: the descriptor is fresh and is now owned exclusively by File.
        let bound = unsafe { File::from_raw_fd(fd) };
        // SAFETY: all-zero bytes are a valid initial sockaddr_un representation.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = socket.as_os_str().as_encoded_bytes();
        assert!(bytes.len() < address.sun_path.len());
        for (target, byte) in address.sun_path.iter_mut().zip(bytes) { *target = *byte as c_char; }
        let length = std::mem::size_of_val(&address) as libc::socklen_t;
        address.sun_len = length as u8;
        // SAFETY: address is initialized, NUL-terminated and live for the call.
        assert_eq!(unsafe { libc::bind(bound.as_raw_fd(), (&raw const address).cast(), length) }, 0);
        assert_eq!(UnixStream::connect(&socket).unwrap_err().raw_os_error(), Some(libc::ECONNREFUSED));
        let error = fixture.connect(&socket, Duration::from_millis(120)).unwrap_err();
        assert_eq!(error.kind, "endpoint-unready");
    }

    #[test]
    fn non_retryable_error_fails_on_first_attempt() {
        let mut fixture = Fixture::new();
        let parent = fixture.directory.join("file");
        fs::write(&parent, b"not a directory").unwrap();
        let socket = parent.join("control.sock");
        assert_eq!(UnixStream::connect(&socket).unwrap_err().raw_os_error(), Some(libc::ENOTDIR));
        let error = fixture.connect(&socket, Duration::from_secs(2)).unwrap_err();
        assert_eq!(error.kind, "operation-failed");
        assert_eq!(fixture.checks, 1);
    }

    #[test]
    fn exited_job_fails_before_deadline() {
        let mut fixture = Fixture::new();
        fixture.child.kill().unwrap();
        fixture.child.wait().unwrap();
        let error = fixture.connect(&fixture.socket(), Duration::from_secs(2)).unwrap_err();
        assert_eq!(error.kind, "job-not-running");
        assert_eq!(fixture.checks, 1);
    }

    #[test]
    fn job_exit_during_wait_fails_fast() {
        let mut fixture = Fixture::new();
        let pid = fixture.child.id();
        let (failed, attempt) = std::sync::mpsc::channel();
        let exiting = std::thread::spawn(move || {
            attempt.recv().unwrap();
            assert!(Command::new("/bin/kill").arg(pid.to_string()).status().unwrap().success());
        });
        let mut failed = Some(failed);
        let error = connect_observed(&fixture.socket(), Duration::from_secs(2), pid, || fixture.job(), || {
            if let Some(failed) = failed.take() { failed.send(()).unwrap(); }
        }).unwrap_err();
        exiting.join().unwrap();
        assert_eq!(error.kind, "job-not-running");
        assert!(fixture.checks > 1);
    }

    #[test]
    fn replaced_pid_fails_before_connecting() {
        let mut fixture = Fixture::new();
        let socket = fixture.socket();
        let _listener = UnixListener::bind(&socket).unwrap();
        let error = connect(&socket, Duration::from_secs(2), 0, || fixture.job()).unwrap_err();
        assert_eq!(error.kind, "job-not-running");
        assert_eq!(fixture.checks, 1);
    }
}
