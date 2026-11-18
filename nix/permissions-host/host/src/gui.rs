//! Main-thread GUI ownership and joined off-thread IPC. No module RPC surface.
use crate::HostError;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn permissions_host_gui_run_v1(
        should_stop: extern "C" fn(*mut std::ffi::c_void) -> bool,
        context: *mut std::ffi::c_void,
    ) -> i32;
}

pub(crate) fn serve(
    server: impl FnOnce() -> Result<(), HostError> + Send,
    stopping: &AtomicBool,
) -> Result<(), HostError> {
    run_joined(server, stopping, run_event_loop)
}

fn run_joined(
    server: impl FnOnce() -> Result<(), HostError> + Send,
    stopping: &AtomicBool,
    event_loop: impl FnOnce(&AtomicBool, &AtomicBool) -> Result<(), HostError>,
) -> Result<(), HostError> {
    let finished = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new().name("host-ipc".into()).spawn_scoped(scope, || {
            struct Finished<'a>(&'a AtomicBool);
            impl Drop for Finished<'_> {
                fn drop(&mut self) { self.0.store(true, Ordering::Release); }
            }
            let _finished = Finished(&finished);
            server()
        })?;
        let gui_result = event_loop(stopping, &finished);
        stopping.store(true, Ordering::Release);
        let server_result = worker.join().map_err(|_| HostError::new("operation-failed", "IPC server panicked"))?;
        gui_result.and(server_result)
    })
}

#[cfg(target_os = "macos")]
fn run_event_loop(stopping: &AtomicBool, finished: &AtomicBool) -> Result<(), HostError> {
    struct State<'a> { stopping: &'a AtomicBool, finished: &'a AtomicBool }
    extern "C" fn should_stop(context: *mut std::ffi::c_void) -> bool {
        // SAFETY: synchronous fixed ABI borrows State only until run returns.
        let state = unsafe { &*context.cast::<State<'_>>() };
        state.stopping.load(Ordering::Acquire) || state.finished.load(Ordering::Acquire)
    }
    let mut state = State { stopping, finished };
    // SAFETY: linked source-reviewed library, valid context, main-thread check in Swift.
    let result = unsafe { permissions_host_gui_run_v1(should_stop, (&mut state as *mut State<'_>).cast()) };
    if result == 0 { Ok(()) } else { Err(HostError::new("operation-failed", "GUI main-thread lifecycle failed")) }
}

#[cfg(not(target_os = "macos"))]
fn run_event_loop(_: &AtomicBool, _: &AtomicBool) -> Result<(), HostError> {
    Err(HostError::new("unsupported-platform", "GUI requires macOS"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gui_exit_cancels_and_joins_server_off_main_thread() {
        let main = std::thread::current().id();
        let stopping = AtomicBool::new(false);
        let joined = AtomicBool::new(false);
        run_joined(|| {
            assert_ne!(std::thread::current().id(), main);
            while !stopping.load(Ordering::Acquire) { std::thread::yield_now(); }
            joined.store(true, Ordering::Release);
            Ok(())
        }, &stopping, |_, _| { assert_eq!(std::thread::current().id(), main); Ok(()) }).unwrap();
        assert!(joined.load(Ordering::Acquire));
    }
    #[test]
    fn server_failure_wakes_gui_and_survives_join() {
        let stopping = AtomicBool::new(false);
        let error = run_joined(|| Err(HostError::new("test-failure", "server stopped")), &stopping, |_, finished| {
            while !finished.load(Ordering::Acquire) { std::thread::yield_now(); }
            Ok(())
        }).unwrap_err();
        assert_eq!(error.code, "test-failure");
    }
    #[test]
    fn gui_failure_still_joins_server() {
        let stopping = AtomicBool::new(false);
        let error = run_joined(|| {
            while !stopping.load(Ordering::Acquire) { std::thread::yield_now(); }
            Ok(())
        }, &stopping, |_, _| Err(HostError::new("gui-failure", "cannot initialize"))).unwrap_err();
        assert_eq!(error.code, "gui-failure");
    }
}
