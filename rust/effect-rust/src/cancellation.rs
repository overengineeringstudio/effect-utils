use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

/// Cooperative cancellation shared by clones. Cancellation is permanent and idempotent.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    state: Arc<State>,
}

#[derive(Debug, Default)]
struct State {
    cancelled: AtomicBool,
    waiters: Mutex<Vec<Option<Waker>>>,
}

impl State {
    fn waiters(&self) -> MutexGuard<'_, Vec<Option<Waker>>> {
        self.waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A cancelled operation, distinct from a host failure or a native panic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CancellationError;

impl fmt::Display for CancellationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("operation cancelled")
    }
}

impl std::error::Error for CancellationError {}

impl CancellationToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals every registered waiter. Calling this again has no effect.
    pub fn cancel(&self) {
        if !self.state.cancelled.swap(true, Ordering::AcqRel) {
            let waiters = std::mem::take(&mut *self.state.waiters());
            for waker in waiters.into_iter().flatten() {
                waker.wake();
            }
        }
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    /// # Errors
    /// Returns `CancellationError` once this token or any clone is cancelled.
    pub fn check(&self) -> Result<(), CancellationError> {
        if self.is_cancelled() {
            Err(CancellationError)
        } else {
            Ok(())
        }
    }

    /// Waits for cancellation without holding a lock across a poll or await.
    pub fn cancelled(&self) -> Cancelled<'_> {
        Cancelled {
            token: self,
            slot: None,
        }
    }
}

/// A cancellation waiter. Dropping a pending waiter unregisters its waker.
#[must_use = "futures do nothing unless polled"]
pub struct Cancelled<'a> {
    token: &'a CancellationToken,
    slot: Option<usize>,
}

impl Future for Cancelled<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let mut waiters = this.token.state.waiters();
        // Check under the registration lock: cancellation cannot miss a new waiter.
        if this.token.is_cancelled() {
            return Poll::Ready(());
        }
        if let Some(slot) = this.slot {
            let waker = &mut waiters[slot];
            if !waker
                .as_ref()
                .is_some_and(|waker| waker.will_wake(context.waker()))
            {
                *waker = Some(context.waker().clone());
            }
        } else {
            let waker = Some(context.waker().clone());
            let slot = if let Some(slot) = waiters.iter().position(Option::is_none) {
                waiters[slot] = waker;
                slot
            } else {
                waiters.push(waker);
                waiters.len() - 1
            };
            this.slot = Some(slot);
        }
        Poll::Pending
    }
}

impl Drop for Cancelled<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot {
            if let Some(waker) = self.token.state.waiters().get_mut(slot) {
                *waker = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::task::Wake;

    #[derive(Default)]
    struct Counter(AtomicUsize);

    impl Wake for Counter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn clones_cancel_all_waiters_only_once() {
        let token = CancellationToken::new();
        let clone = token.clone();
        let first_counter = Arc::new(Counter::default());
        let second_counter = Arc::new(Counter::default());
        let first_waker = Waker::from(first_counter.clone());
        let second_waker = Waker::from(second_counter.clone());
        let mut first = token.cancelled();
        let mut second = token.cancelled();
        assert_eq!(
            Pin::new(&mut first).poll(&mut Context::from_waker(&first_waker)),
            Poll::Pending
        );
        assert_eq!(
            Pin::new(&mut second).poll(&mut Context::from_waker(&second_waker)),
            Poll::Pending
        );
        clone.cancel();
        token.cancel();
        assert_eq!(token.check(), Err(CancellationError));
        assert_eq!(first_counter.0.load(Ordering::Relaxed), 1);
        assert_eq!(second_counter.0.load(Ordering::Relaxed), 1);
        assert_eq!(
            Pin::new(&mut first).poll(&mut Context::from_waker(&first_waker)),
            Poll::Ready(())
        );
        assert_eq!(
            Pin::new(&mut second).poll(&mut Context::from_waker(&second_waker)),
            Poll::Ready(())
        );
    }

    #[test]
    fn dropped_waiters_unregister_and_repoll_updates_waker() {
        let token = CancellationToken::new();
        let stale_counter = Arc::new(Counter::default());
        let live_counter = Arc::new(Counter::default());
        let stale_waker = Waker::from(stale_counter.clone());
        let live_waker = Waker::from(live_counter.clone());
        let mut dropped = token.cancelled();
        assert_eq!(
            Pin::new(&mut dropped).poll(&mut Context::from_waker(&stale_waker)),
            Poll::Pending
        );
        drop(dropped);
        let mut live = token.cancelled();
        assert_eq!(
            Pin::new(&mut live).poll(&mut Context::from_waker(&stale_waker)),
            Poll::Pending
        );
        assert_eq!(
            Pin::new(&mut live).poll(&mut Context::from_waker(&live_waker)),
            Poll::Pending
        );
        token.cancel();
        assert_eq!(stale_counter.0.load(Ordering::Relaxed), 0);
        assert_eq!(live_counter.0.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cancellation_before_registration_is_immediately_ready() {
        let token = CancellationToken::new();
        token.cancel();
        let mut waiter = token.cancelled();
        assert_eq!(
            Pin::new(&mut waiter).poll(&mut Context::from_waker(Waker::noop())),
            Poll::Ready(())
        );
    }
}
