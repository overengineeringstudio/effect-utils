use std::{fs, os::unix::fs::PermissionsExt, process::Command, sync::Barrier};
use worktree_lease::{
    record::{Holder, Record},
    Identity, Lease, Refusal,
};

fn holder() -> Holder {
    Holder {
        agent: "agent/test".into(),
        pid: 1,
        start_time: "123".into(),
        host: "test-host".into(),
    }
}
#[test]
fn publication_and_scoped_renewal() {
    let root = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(root.path())
        .status()
        .unwrap()
        .success());
    let identity = Identity::resolve(root.path()).unwrap();
    assert_eq!(Record::inspect(&identity).unwrap(), None);
    for (creator, purpose, ttl) in [
        ("invalid", "gate", 10),
        ("agent/test", "invalid", 10),
        ("agent/test", "gate", 0),
        ("agent/test", "gate", u64::MAX),
    ] {
        assert_eq!(
            Record::create(&identity, creator.into(), purpose.into(), holder(), ttl),
            Err(Refusal::InvalidInput)
        );
    }
    let barrier = Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let create = |creator: &str| {
            barrier.wait();
            Record::create(&identity, creator.into(), "gate".into(), holder(), 10)
        };
        let first = scope.spawn(move || create("agent/first"));
        let second = scope.spawn(move || create("agent/second"));
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let original = Record::inspect(&identity).unwrap().unwrap();
    assert!(results
        .iter()
        .any(|result| result.as_ref().ok() == Some(&original)));
    assert_eq!(
        fs::metadata(identity.admin.join("gate-lease.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let lease = Lease::open(identity).unwrap();
    assert_eq!(lease.renew(holder(), 20), Err(Refusal::UnsafeLock));
    lease.acquire(false, false).unwrap();
    let mut next_holder = holder();
    next_holder.agent = "agent/renewed".into();
    let renewed = lease.renew(next_holder.clone(), 20).unwrap();
    assert_eq!(
        (&renewed.creator_seat, &renewed.purpose, &renewed.created_at),
        (
            &original.creator_seat,
            &original.purpose,
            &original.created_at
        )
    );
    assert_eq!(renewed.holder, next_holder);
    assert!(renewed.expires_at > original.expires_at);
    assert_eq!(lease.renew(holder(), 0), Err(Refusal::InvalidInput));
    drop(lease);
    let identity = Identity::resolve(root.path()).unwrap();
    assert_eq!(Record::inspect(&identity).unwrap(), Some(renewed));
    let names: Vec<_> = fs::read_dir(&identity.admin)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(!names
        .iter()
        .any(|name| name.to_string_lossy().starts_with(".tmp")));
    fs::write(identity.admin.join("gate-lease.json"), b"{broken").unwrap();
    assert_eq!(Record::inspect(&identity), Err(Refusal::UnsafeLock));
}
