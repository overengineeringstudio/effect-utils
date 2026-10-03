//! Host capabilities contain Rust callbacks, never backend JavaScript values.
use crate::{Bytes, CancellationError, CancellationToken};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::future::{poll_fn, Future};
use std::marker::PhantomData;
use std::pin::{pin, Pin};
use std::task::Poll;

#[cfg(target_arch = "wasm32")]
use std::rc::Rc as Shared;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc as Shared;

/// A callback failure or cancellation, not a panic/defect.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Error {
    Cancelled,
    Failed { message: String },
}

impl Error {
    #[must_use]
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed { message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => CancellationError.fmt(formatter),
            Self::Failed { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

impl From<CancellationError> for Error {
    fn from(_: CancellationError) -> Self {
        Self::Cancelled
    }
}

mod sealed {
    pub trait Sealed {}
}

/// Declares whether cancelling a host call may drop the pending operation.
pub trait Mode: sealed::Sealed {
    const ABORTABLE: bool;
}

/// The callback cooperates with its token; cancellation may drop its future.
#[derive(Clone, Copy, Debug, Default)]
pub struct Abortable;

/// The host operation must settle before cancellation releases its resources.
#[derive(Clone, Copy, Debug, Default)]
pub struct SettleOnly;

impl sealed::Sealed for Abortable {}
impl sealed::Sealed for SettleOnly {}
impl Mode for Abortable {
    const ABORTABLE: bool = true;
}
impl Mode for SettleOnly {
    const ABORTABLE: bool = false;
}

#[cfg(target_arch = "wasm32")]
pub type ReadFuture<'a> = Pin<Box<dyn Future<Output = Result<Bytes, Error>> + 'a>>;
#[cfg(not(target_arch = "wasm32"))]
pub type ReadFuture<'a> = Pin<Box<dyn Future<Output = Result<Bytes, Error>> + Send + 'a>>;

/// Operations dispatched through the same scope-owned host boundary.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request<'a> {
    Read { path: &'a str },
    ReadRange {
        path: &'a str,
        #[serde(serialize_with = "serialize_offset")]
        offset: u64,
        #[serde(rename = "maxBytes")]
        max_bytes: u32,
    },
    Yield,
}

fn serialize_offset<S: serde::Serializer>(offset: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(offset)
}

impl Request<'_> {
    /// Validates a response before backend adapters allocate or copy its bytes.
    /// # Errors
    /// Rejects oversized range responses and nonempty yield acknowledgements.
    pub fn check_response_len(self, length: usize) -> Result<(), Error> {
        match self {
            Self::ReadRange { max_bytes, .. } if length > max_bytes as usize =>
                Err(Error::failed("host readRange response exceeds maxBytes")),
            Self::Yield if length != 0 => Err(Error::failed("host yield must return an empty acknowledgement")),
            _ => Ok(()),
        }
    }
}

#[cfg(target_arch = "wasm32")]
type Call = dyn for<'a> Fn(Request<'a>, CancellationToken) -> ReadFuture<'a>;
#[cfg(not(target_arch = "wasm32"))]
type Call = dyn for<'a> Fn(Request<'a>, CancellationToken) -> ReadFuture<'a> + Send + Sync;

/// A clonable Rust capability. Clones share the host callback and cancellation.
///
/// For `SettleOnly`, callbacks must not drop the operation in response to their
/// token: host calls keep polling until settlement, then report cancellation.
pub struct Source<M: Mode = Abortable> {
    call: Shared<Call>,
    cancellation: CancellationToken,
    mode: PhantomData<M>,
}

impl<M: Mode> Clone for Source<M> {
    fn clone(&self) -> Self {
        Self { call: self.call.clone(), cancellation: self.cancellation.clone(), mode: PhantomData }
    }
}

impl<M: Mode> Source<M> {
    #[cfg(target_arch = "wasm32")]
    pub fn new(callback: impl for<'a> Fn(Request<'a>, CancellationToken) -> ReadFuture<'a> + 'static) -> Self {
        Self { call: Shared::new(callback), cancellation: CancellationToken::new(), mode: PhantomData }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(callback: impl for<'a> Fn(Request<'a>, CancellationToken) -> ReadFuture<'a> + Send + Sync + 'static) -> Self {
        Self { call: Shared::new(callback), cancellation: CancellationToken::new(), mode: PhantomData }
    }

    /// Binds this capability to a caller-owned cancellation scope.
    #[must_use]
    pub fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    /// Reads the whole file into an owned buffer. No size bound is implied.
    /// # Errors
    /// Preserves host failures and reports cancellation according to the mode.
    pub async fn read(&self, path: &str) -> Result<Bytes, Error> {
        self.call(Request::Read { path }).await
    }

    /// Reads at most `max_bytes` bytes starting at the absolute byte `offset`.
    ///
    /// `max_bytes` must be positive. A short read is permitted and is not proof
    /// of EOF; an empty result reports EOF at that offset. Calls do not share an
    /// implicit file handle or snapshot: hosts define consistency when files
    /// change between reads.
    /// # Errors
    /// Rejects zero bounds and oversized host responses, and preserves host
    /// failures/cancellation. Adapters validate the bound before copying bytes.
    pub async fn read_range(&self, path: &str, offset: u64, max_bytes: u32) -> Result<Bytes, Error> {
        if max_bytes == 0 { return Err(Error::failed("maxBytes must be positive")); }
        self.call(Request::ReadRange { path, offset, max_bytes }).await
    }

    /// Cooperatively returns control to the host event loop between CPU chunks.
    ///
    /// The host must schedule an event-loop task, not just a microtask or token
    /// check. This is not CPU preemption; callers choose their chunk boundaries.
    /// # Errors
    /// Preserves host failures and reports cancellation according to the mode.
    pub async fn yield_now(&self) -> Result<(), Error> {
        self.call(Request::Yield).await.map(|_| ())
    }

    async fn call(&self, request: Request<'_>) -> Result<Bytes, Error> {
        self.cancellation.check()?;
        let future = (self.call)(request, self.cancellation.clone());
        let bytes = if M::ABORTABLE {
            cancel_future(&self.cancellation, future).await??
        } else {
            let result = future.await;
            self.cancellation.check()?;
            result?
        };
        request.check_response_len(bytes.len())?;
        Ok(bytes)
    }
}

/// Races a cooperatively abortable future against cancellation.
///
/// The future is dropped before this helper completes. Cancellation takes
/// precedence when both cancellation and completion are observed in a poll.
/// # Errors
/// Returns `Error::Cancelled` if the token is cancelled before completion.
pub async fn cancel_future<F: Future>(token: &CancellationToken, future: F) -> Result<F::Output, Error> {
    let mut future = pin!(future);
    let mut cancelled = pin!(token.cancelled());
    poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() {
            return Poll::Ready(Err(Error::Cancelled));
        }
        match future.as_mut().poll(context) {
            Poll::Ready(result) => Poll::Ready(token.check().map(|()| result).map_err(Error::from)),
            Poll::Pending => Poll::Pending,
        }
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Waker};

    struct DropCount(Arc<AtomicUsize>);
    impl Drop for DropCount {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn abortable_read_drops_pending_operation_on_cancellation() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let source = Source::<Abortable>::new({
            let dropped = dropped.clone();
            move |_path, token| {
                let guard = DropCount(dropped.clone());
                Box::pin(async move {
                    let _guard = guard;
                    token.cancelled().await;
                    Ok(vec![1])
                })
            }
        });
        let clone = source.clone();
        let mut read = pin!(source.read("pending"));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(read.as_mut().poll(&mut context), Poll::Pending);
        clone.cancellation().cancel();
        assert_eq!(read.as_mut().poll(&mut context), Poll::Ready(Err(Error::Cancelled)));
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn settle_only_read_waits_for_settlement_before_reporting_cancelled() {
        let settled = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicUsize::new(0));
        let source = Source::<SettleOnly>::new({
            let settled = settled.clone();
            let dropped = dropped.clone();
            move |_path, _token| {
                let settled = settled.clone();
                let guard = DropCount(dropped.clone());
                Box::pin(async move {
                    let _guard = guard;
                    poll_fn(|_| {
                        if settled.load(Ordering::Acquire) { Poll::Ready(Ok(vec![2])) } else { Poll::Pending }
                    }).await
                })
            }
        });
        let mut read = pin!(source.read("pending"));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(read.as_mut().poll(&mut context), Poll::Pending);
        source.cancellation().cancel();
        assert_eq!(read.as_mut().poll(&mut context), Poll::Pending);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
        settled.store(true, Ordering::Release);
        assert_eq!(read.as_mut().poll(&mut context), Poll::Ready(Err(Error::Cancelled)));
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cancelled_scope_does_not_dispatch_new_reads() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = Source::<SettleOnly>::new({
            let calls = calls.clone();
            move |_path, _token| {
                calls.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(vec![3]) })
            }
        });
        source.cancellation().cancel();
        let mut read = pin!(source.read("not-started"));
        assert_eq!(read.as_mut().poll(&mut Context::from_waker(Waker::noop())), Poll::Ready(Err(Error::Cancelled)));
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn range_reads_preserve_exact_offsets_short_reads_and_eof() {
        let source = Source::<Abortable>::new(|request, _token| Box::pin(async move {
            match request {
                Request::ReadRange { path: "file", offset: 9_007_199_254_740_993, max_bytes: 4 } => Ok(vec![7, 8]),
                Request::ReadRange { path: "file", offset: u64::MAX, max_bytes: 4 } => Ok(vec![]),
                _ => panic!("unexpected host request"),
            }
        }));
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(pin!(source.read_range("file", 9_007_199_254_740_993, 4)).poll(&mut context), Poll::Ready(Ok(vec![7, 8])));
        assert_eq!(pin!(source.read_range("file", u64::MAX, 4)).poll(&mut context), Poll::Ready(Ok(vec![])));
    }

    #[test]
    fn invalid_bounds_do_not_dispatch_and_oversized_responses_fail() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = Source::<Abortable>::new({
            let calls = calls.clone();
            move |_request, _token| {
                calls.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(vec![1, 2]) })
            }
        });
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(pin!(source.read_range("file", 0, 0)).poll(&mut context), Poll::Ready(Err(Error::Failed { .. }))));
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        assert!(matches!(pin!(source.read_range("file", 0, 1)).poll(&mut context), Poll::Ready(Err(Error::Failed { .. }))));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cancellation_during_yield_prevents_the_next_chunk() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let source = Source::<Abortable>::new({
            let dropped = dropped.clone();
            move |request, token| {
                assert!(matches!(request, Request::Yield));
                let guard = DropCount(dropped.clone());
                Box::pin(async move {
                    let _guard = guard;
                    token.cancelled().await;
                    Ok(vec![])
                })
            }
        });
        let mut context = Context::from_waker(Waker::noop());
        let mut yielding = pin!(source.yield_now());
        assert_eq!(yielding.as_mut().poll(&mut context), Poll::Pending);
        source.cancellation().cancel();
        assert_eq!(yielding.as_mut().poll(&mut context), Poll::Ready(Err(Error::Cancelled)));
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert_eq!(pin!(source.read_range("must-not-read", 0, 1)).poll(&mut context), Poll::Ready(Err(Error::Cancelled)));
    }

    #[test]
    fn cancellation_during_completion_wins_over_result() {
        let token = CancellationToken::new();
        let mut operation = pin!(cancel_future(&token, async {
            token.cancel();
            7
        }));
        assert_eq!(operation.as_mut().poll(&mut Context::from_waker(Waker::noop())), Poll::Ready(Err(Error::Cancelled)));
    }
}
