//! Native unwind boundaries. A panic is a defect; callers must retire any
//! affected adapter state rather than resume the panicking operation.
use std::any::Any;
use std::fmt;
use std::future::{poll_fn, Future};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::pin;
use std::task::Poll;

/// A caught Rust panic, carrying the export name and original payload text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PanicError {
    pub name: String,
    pub message: String,
}

impl PanicError {
    fn from_payload(name: &str, payload: Box<dyn Any + Send>) -> Self {
        let message = match payload.downcast::<String>() {
            Ok(message) => *message,
            Err(payload) => match payload.downcast::<&'static str>() {
                Ok(message) => (*message).to_owned(),
                Err(_) => "non-string panic payload".to_owned(),
            },
        };
        Self { name: name.to_owned(), message }
    }
}

impl fmt::Display for PanicError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "RUST_PANIC:{}: {}", self.name, self.message)
    }
}

impl std::error::Error for PanicError {}

/// Guards a synchronous native entrypoint, including callback construction.
/// # Errors
/// Converts an unwinding panic into `PanicError`. Aborting panics cannot be caught.
pub fn guard<T>(name: &str, operation: impl FnOnce() -> T) -> Result<T, PanicError> {
    catch_unwind(AssertUnwindSafe(operation)).map_err(|payload| PanicError::from_payload(name, payload))
}

/// Guards **every poll**, including polls after host awaits, and completion-time
/// destruction without boxing the future. Guard construction separately if it
/// can panic. To guard cancellation-time destruction, put the cancellation race
/// inside this boundary, not around it.
/// # Errors
/// Converts an unwinding panic from a poll or completed future's drop into `PanicError`.
pub async fn guard_future<F: Future>(name: &str, future: F) -> Result<F::Output, PanicError> {
    let mut future = pin!(Some(future));
    poll_fn(|context| {
        let result = match guard(name, || future.as_mut().as_pin_mut().expect("pending future").poll(context)) {
            Ok(Poll::Pending) => return Poll::Pending,
            Ok(Poll::Ready(output)) => Ok(output),
            Err(error) => Err(error),
        };
        // Pin::set drops in place and leaves None even if F::drop unwinds.
        // A poll panic remains the primary defect if cleanup also panics.
        let dropped = guard(name, || future.as_mut().set(None));
        Poll::Ready(result.and_then(|output| dropped.map(|()| output)))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Waker};

    #[test]
    fn synchronous_panics_preserve_payload_and_defect_prefix() {
        let error = guard("hash", || panic!("bad hash state")).unwrap_err();
        assert_eq!(error.name, "hash");
        assert_eq!(error.message, "bad hash state");
        assert!(error.to_string().starts_with("RUST_PANIC:"));
        let owned = guard("owned", || std::panic::panic_any(String::from("owned payload"))).unwrap_err();
        assert_eq!(owned.message, "owned payload");
        let opaque = guard("opaque", || std::panic::panic_any(17_u32)).unwrap_err();
        assert_eq!(opaque.message, "non-string panic payload");
    }

    #[test]
    fn panic_after_pending_poll_is_caught() {
        let mut polled = false;
        let future = poll_fn(|_| -> Poll<()> {
            if polled {
                panic!("panic after host await");
            }
            polled = true;
            Poll::Pending
        });
        let mut guarded = pin!(guard_future("host_work", future));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(guarded.as_mut().poll(&mut context), Poll::Pending);
        let Poll::Ready(Err(error)) = guarded.as_mut().poll(&mut context) else {
            panic!("poll panic was not converted to a defect");
        };
        assert_eq!(error.name, "host_work");
        assert_eq!(error.message, "panic after host await");
    }

    #[test]
    fn first_poll_panic_is_caught_and_domain_failure_is_not_a_panic() {
        let mut panicking = pin!(guard_future("first", async { panic!("first poll") }));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(panicking.as_mut().poll(&mut context), Poll::Ready(Err(_))));
        let mut domain_failure = pin!(guard_future("domain", async { Err::<(), _>("expected failure") }));
        assert_eq!(domain_failure.as_mut().poll(&mut context), Poll::Ready(Ok(Err("expected failure"))));
    }

    #[test]
    fn completed_future_drop_panic_is_caught() {
        struct DropPanic;
        impl Future for DropPanic {
            type Output = u32;
            fn poll(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<u32> {
                Poll::Ready(42)
            }
        }
        impl Drop for DropPanic {
            fn drop(&mut self) {
                panic!("completion cleanup");
            }
        }
        let mut guarded = pin!(guard_future("cleanup", DropPanic));
        let Poll::Ready(Err(error)) = guarded.as_mut().poll(&mut Context::from_waker(Waker::noop())) else {
            panic!("completion cleanup panic escaped its boundary");
        };
        assert_eq!(error.message, "completion cleanup");
    }

    #[test]
    fn cancellation_inside_guard_catches_pending_future_drop_panic() {
        struct DropPanic;
        impl Drop for DropPanic {
            fn drop(&mut self) {
                panic!("cancellation cleanup");
            }
        }
        let token = crate::CancellationToken::new();
        let future = async {
            let _guard = DropPanic;
            std::future::pending::<()>().await;
        };
        let mut guarded = pin!(guard_future("cancel", crate::host::cancel_future(&token, future)));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(guarded.as_mut().poll(&mut context), Poll::Pending);
        token.cancel();
        let Poll::Ready(Err(error)) = guarded.as_mut().poll(&mut context) else {
            panic!("cancellation cleanup panic escaped its boundary");
        };
        assert_eq!(error.message, "cancellation cleanup");
    }
}
