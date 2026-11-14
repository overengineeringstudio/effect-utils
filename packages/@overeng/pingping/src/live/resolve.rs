//! Generation-isolated lookup batches with at most four active lookup threads.
use std::io::{self, Write};
use std::net::IpAddr;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};

use crate::probe::{self, Family};
use crate::target::TargetId;

pub(super) struct Resolution {
    pub generation: u64,
    pub edit: Option<TargetId>,
    pub result: Result<Vec<(String, IpAddr)>, String>,
}

const MAX_ACTIVE: usize = 4;

type Lookup = dyn Fn(&str) -> Result<IpAddr, String> + Send + Sync;

#[derive(Default)]
struct State {
    generation: u64,
    active: usize,
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    lookup: Box<Lookup>,
    sender: Sender<Resolution>,
    wake: UnixStream,
    #[cfg(test)]
    finished: std::sync::Condvar,
}

impl Shared {
    fn publish(&self, resolution: Resolution) {
        let state = self.state.lock().expect("resolver lock");
        if !state.closed && state.generation == resolution.generation {
            let _ = self.sender.send(resolution);
            let _ = (&self.wake).write_all(&[1]);
        }
    }
}

struct Active(Arc<Shared>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.state.lock().expect("resolver lock").active -= 1;
        #[cfg(test)]
        self.0.finished.notify_all();
    }
}

pub(super) struct Resolver {
    shared: Arc<Shared>,
    results: Receiver<Resolution>,
    pub notification: UnixStream,
}

impl Resolver {
    pub fn new(family: Family) -> io::Result<Self> {
        Self::spawn(move |host| probe::resolve(host, family))
    }

    fn spawn(
        lookup: impl Fn(&str) -> Result<IpAddr, String> + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let (sender, results) = mpsc::channel();
        let (notification, wake) = UnixStream::pair()?;
        notification.set_nonblocking(true)?;
        wake.set_nonblocking(true)?;
        Ok(Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                lookup: Box::new(lookup),
                sender,
                wake,
                #[cfg(test)]
                finished: std::sync::Condvar::new(),
            }),
            results,
            notification,
        })
    }

    pub fn submit(&self, edit: Option<TargetId>, hosts: Vec<String>) -> u64 {
        let mut state = self.shared.state.lock().expect("resolver lock");
        state.generation = state.generation.checked_add(1).expect("lookup generations exhausted");
        let generation = state.generation;
        if state.active == MAX_ACTIVE {
            drop(state);
            self.shared.publish(Resolution {
                generation,
                edit,
                result: Err("resolver busy".into()),
            });
            return generation;
        }
        state.active += 1;
        drop(state);
        let active = Active(Arc::clone(&self.shared));
        let thread = std::thread::Builder::new()
            .name("target-resolver".into())
            .spawn(move || {
                let active = active;
                let shared = &active.0;
                let mut resolved = Vec::with_capacity(hosts.len());
                let mut error = None;
                for name in hosts {
                    let state = shared.state.lock().expect("resolver lock");
                    if state.closed || state.generation != generation {
                        return;
                    }
                    drop(state);
                    match (shared.lookup)(&name) {
                        Ok(address) => resolved.push((name, address)),
                        Err(reason) => {
                            error = Some(format!("Cannot resolve {name}: {reason}"));
                            break;
                        }
                    }
                }
                shared.publish(Resolution {
                    generation,
                    edit,
                    result: error.map_or_else(|| Ok(resolved), Err),
                });
            });
        // A failed spawn drops its closure and active lease before returning.
        if let Err(error) = thread {
            self.shared.publish(Resolution {
                generation,
                edit,
                result: Err(format!("Cannot start target resolver: {error}")),
            });
        }
        generation
    }

    pub fn cancel(&self) {
        let mut state = self.shared.state.lock().expect("resolver lock");
        state.generation = state
            .generation
            .checked_add(1)
            .expect("lookup generations exhausted");
    }

    pub fn try_result(&self) -> io::Result<Option<Resolution>> {
        loop {
            match self.results.try_recv() {
                // Cancellation also invalidates results queued before it took the lock.
                Ok(result) => {
                    if result.generation == self.shared.state.lock().expect("resolver lock").generation {
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
        let mut state = self.shared.state.lock().expect("resolver lock");
        state.closed = true;
        state.generation = state.generation.checked_add(1).expect("lookup generations exhausted");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::poll::{poll, PollFd, PollFlags};
    use std::io::Read;
    use std::os::fd::AsFd;
    use std::time::Duration;

    fn wait_for_idle(shared: &Shared) {
        let state = shared.state.lock().unwrap();
        let (state, timeout) = shared.finished.wait_timeout_while(
            state,
            Duration::from_secs(2),
            |state| state.active != 0,
        ).unwrap();
        assert!(!timeout.timed_out());
        assert_eq!(state.active, 0);
    }

    #[test]
    fn canceled_hung_generation_does_not_block_a_new_batch() {
        let (started, reads) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let resolver = Resolver::spawn(move |host| {
            started.send(host.to_owned()).unwrap();
            if host == "old" {
                wait.lock().unwrap().recv().unwrap();
            }
            Ok("127.0.0.1".parse().unwrap())
        }).unwrap();
        resolver.submit(None, vec!["old".into(), "never".into()]);
        assert_eq!(reads.recv_timeout(Duration::from_secs(2)).unwrap(), "old");
        resolver.cancel();
        let generation = resolver.submit(Some(42), vec!["latest".into()]);
        assert_eq!(reads.recv_timeout(Duration::from_secs(2)).unwrap(), "latest");
        let result = resolver.results.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(result.generation, generation);
        assert_eq!(result.edit, Some(42));
        assert_eq!(result.result.unwrap()[0].0, "latest");
        release.send(()).unwrap();
        wait_for_idle(&resolver.shared);
        assert!(reads.try_recv().is_err());
        assert!(resolver.try_result().unwrap().is_none());
    }

    #[test]
    fn four_hung_lookups_bound_admission_and_capacity_recovers() {
        let (started, reads) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let resolver = Resolver::spawn(move |host| {
            started.send(()).unwrap();
            if host == "held" {
                wait.lock().unwrap().recv().unwrap();
            }
            Ok("127.0.0.1".parse().unwrap())
        }).unwrap();
        for _ in 0..MAX_ACTIVE {
            resolver.submit(None, vec!["held".into()]);
            reads.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        let generation = resolver.submit(None, vec!["busy".into()]);
        let result = resolver.try_result().unwrap().unwrap();
        assert_eq!(result.generation, generation);
        assert_eq!(result.result.unwrap_err(), "resolver busy");
        assert_eq!(resolver.shared.state.lock().unwrap().active, MAX_ACTIVE);
        assert!(reads.try_recv().is_err());
        for _ in 0..MAX_ACTIVE {
            release.send(()).unwrap();
        }
        wait_for_idle(&resolver.shared);
        let generation = resolver.submit(None, vec!["recovered".into()]);
        let result = resolver.results.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(result.generation, generation);
        assert!(result.result.is_ok());
    }

    #[test]
    fn dropping_during_a_lookup_aborts_the_remaining_hosts() {
        let (started, reads) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let resolver = Resolver::spawn(move |host| {
            started.send(host.to_owned()).unwrap();
            wait.lock().unwrap().recv().unwrap();
            Ok("127.0.0.1".parse().unwrap())
        }).unwrap();
        let shared = Arc::clone(&resolver.shared);
        resolver.submit(None, vec!["blocked".into(), "never".into()]);
        assert_eq!(reads.recv_timeout(Duration::from_secs(2)).unwrap(), "blocked");
        drop(resolver);
        release.send(()).unwrap();
        wait_for_idle(&shared);
        assert!(reads.try_recv().is_err());
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
