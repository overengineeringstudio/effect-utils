//! One lookup worker and one replaceable pending batch, independent of UI focus.
use std::io::{self, Write};
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};

use crate::probe::{self, Family};
use crate::target::TargetId;

pub(super) struct Resolution {
    pub generation: u64,
    pub edit: Option<TargetId>,
    pub result: Result<Vec<(String, IpAddr)>, String>,
}

struct Request {
    generation: u64,
    edit: Option<TargetId>,
    hosts: Vec<String>,
}

#[derive(Default)]
struct State {
    generation: u64,
    pending: Option<Request>,
    closed: bool,
}

pub(super) struct Resolver {
    state: Arc<(Mutex<State>, Condvar)>,
    results: Receiver<Resolution>,
    pub notification: UnixStream,
}

impl Resolver {
    pub fn new(family: Family) -> io::Result<Self> {
        Self::spawn(move |host| probe::resolve(host, family))
    }

    fn spawn(lookup: impl Fn(&str) -> Result<IpAddr, String> + Send + 'static) -> io::Result<Self> {
        let state = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let (sender, results) = mpsc::channel();
        let (notification, mut wake) = UnixStream::pair()?;
        notification.set_nonblocking(true)?;
        wake.set_nonblocking(true)?;
        let worker_state = Arc::clone(&state);
        let thread = std::thread::Builder::new()
            .name("target-resolver".into())
            .spawn(move || loop {
                let (state, changed) = &*worker_state;
                let guard = changed
                    .wait_while(state.lock().expect("resolver lock"), |state| {
                        !state.closed && state.pending.is_none()
                    })
                    .expect("resolver wait");
                if guard.closed {
                    return;
                }
                let mut guard = guard;
                let request = guard.pending.take().expect("queued lookup");
                drop(guard);
                let mut resolved = Vec::with_capacity(request.hosts.len());
                let mut error = None;
                for name in request.hosts {
                    if state.lock().expect("resolver lock").generation != request.generation {
                        break;
                    }
                    match lookup(&name) {
                        Ok(address) => resolved.push((name, address)),
                        Err(reason) => {
                            error = Some(format!("Cannot resolve {name}: {reason}"));
                            break;
                        }
                    }
                }
                let guard = state.lock().expect("resolver lock");
                if guard.closed || guard.generation != request.generation {
                    continue;
                }
                let result = error.map_or_else(|| Ok(resolved), Err);
                if sender
                    .send(Resolution {
                        generation: request.generation,
                        edit: request.edit,
                        result,
                    })
                    .is_err()
                {
                    return;
                }
                let _ = wake.write_all(&[1]);
                drop(guard);
            })?;
        drop(thread); // Drop signals the shared state; a blocked libc lookup need not join.
        Ok(Self {
            state,
            results,
            notification,
        })
    }

    pub fn submit(&self, edit: Option<TargetId>, hosts: Vec<String>) -> u64 {
        let (state, changed) = &*self.state;
        let mut state = state.lock().expect("resolver lock");
        state.generation = state
            .generation
            .checked_add(1)
            .expect("lookup generations exhausted");
        let generation = state.generation;
        state.pending = Some(Request {
            generation,
            edit,
            hosts,
        });
        changed.notify_one();
        generation
    }

    pub fn cancel(&self) {
        let (state, _) = &*self.state;
        let mut state = state.lock().expect("resolver lock");
        state.generation = state
            .generation
            .checked_add(1)
            .expect("lookup generations exhausted");
        state.pending = None;
    }

    pub fn try_result(&self) -> io::Result<Option<Resolution>> {
        loop {
            match self.results.try_recv() {
                // Cancellation also invalidates results queued before it took the lock.
                Ok(result) => {
                    let (state, _) = &*self.state;
                    if result.generation == state.lock().expect("resolver lock").generation {
                        return Ok(Some(result));
                    }
                }
                Err(TryRecvError::Empty) => return Ok(None),
                Err(TryRecvError::Disconnected) => {
                    return Err(io::Error::other("target resolver disconnected"));
                }
            }
        }
    }
}

impl Drop for Resolver {
    fn drop(&mut self) {
        let (state, changed) = &*self.state;
        let mut state = state.lock().expect("resolver lock");
        state.closed = true;
        state.pending = None;
        changed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::poll::{poll, PollFd, PollFlags};
    use std::io::Read;
    use std::os::fd::AsFd;
    use std::time::Duration;

    #[test]
    fn canceled_batches_cannot_publish_and_only_latest_queued_batch_runs() {
        let (started, reads) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let resolver = Resolver::spawn(move |host| {
            started.send(host.to_owned()).unwrap();
            if host == "old" {
                wait.recv().unwrap();
            }
            Ok("127.0.0.1".parse().unwrap())
        })
        .unwrap();
        resolver.submit(None, vec!["old".into(), "never".into()]);
        assert_eq!(reads.recv_timeout(Duration::from_secs(2)).unwrap(), "old");
        resolver.cancel();
        resolver.submit(None, vec!["superseded".into()]);
        let generation = resolver.submit(Some(42), vec!["latest".into()]);
        release.send(()).unwrap();
        assert_eq!(
            reads.recv_timeout(Duration::from_secs(2)).unwrap(),
            "latest"
        );
        let result = resolver
            .results
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert_eq!(result.generation, generation);
        assert_eq!(result.edit, Some(42));
        assert_eq!(result.result.unwrap()[0].0, "latest");
        assert!(resolver.try_result().unwrap().is_none());
    }

    #[test]
    fn failed_batch_does_not_publish_partial_success() {
        let resolver = Resolver::spawn(|host| {
            if host == "bad" {
                Err("not found".into())
            } else {
                Ok("127.0.0.1".parse().unwrap())
            }
        })
        .unwrap();
        resolver.submit(None, vec!["good".into(), "bad".into()]);
        let result = resolver
            .results
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(result.result.unwrap_err().contains("Cannot resolve bad"));
    }

    #[test]
    fn cancel_discards_an_already_completed_generation() {
        let resolver = Resolver::spawn(|_| Ok("127.0.0.1".parse().unwrap())).unwrap();
        resolver.submit(None, vec!["completed".into()]);
        let mut descriptors = [PollFd::new(
            resolver.notification.as_fd(),
            PollFlags::POLLIN,
        )];
        assert_eq!(poll(&mut descriptors, 2000u16).unwrap(), 1);
        resolver.cancel();
        assert!(resolver.try_result().unwrap().is_none());
    }

    #[test]
    fn family_rule_uses_the_same_literal_resolver() {
        let resolver = Resolver::new(Family::V4).unwrap();
        resolver.submit(None, vec!["::1".into()]);
        let result = resolver
            .results
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(result.result.unwrap_err().contains("requested family"));
        let generation = resolver.submit(None, vec!["127.0.0.1".into()]);
        let result = resolver
            .results
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert_eq!(result.generation, generation);
        assert_eq!(
            result.result.unwrap(),
            vec![("127.0.0.1".into(), "127.0.0.1".parse::<IpAddr>().unwrap())]
        );
        let mut descriptors = [PollFd::new(
            resolver.notification.as_fd(),
            PollFlags::POLLIN,
        )];
        assert_eq!(poll(&mut descriptors, 2000u16).unwrap(), 1);
        resolver.notification.set_nonblocking(false).unwrap();
        resolver
            .notification
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut wake = [0];
        (&resolver.notification).read_exact(&mut wake).unwrap();
        assert_eq!(wake, [1]);
    }
}
