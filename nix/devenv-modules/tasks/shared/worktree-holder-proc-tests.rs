use super::{linux, objects, process, scopes};

#[test]
fn stat_parser_uses_last_parenthesis_and_actual_generation() {
    let mut fields = vec!["S", "7"];
    fields.extend(["0"; 17]);
    fields.push("123456");
    let stat = format!("42 (name with ) and spaces) {}", fields.join(" "));
    let parsed = process::parse_process(42, &stat).unwrap();
    assert_eq!(parsed.pid, 42);
    assert_eq!(parsed.parent, 7);
    assert_eq!(parsed.start, 123456);
    assert_eq!(parsed.state, b'S');
    assert!(process::parse_process(43, &stat).is_err());
    assert!(process::parse_process(42, "42 (short) S 7").is_err());
    assert!(process::parse_process(42, &stat.replace(") S ", ") SS ")).is_err());
}

#[test]
fn uid_parser_requires_exactly_one_complete_record() {
    assert_eq!(process::parse_uids("Name:\tx\nUid:\t1 2 3 4\n").unwrap(), [1, 2, 3, 4]);
    assert!(process::parse_uids("Uid: 1 2 3").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4 5").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4\nUid: 1 2 3 4").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 4294967296").is_err());
    assert!(process::parse_uids("Uid: 1 2 3 nope").is_err());
    assert!(process::parse_uids("Name: no-uids").is_err());
}

#[test]
fn actual_self_generation_and_read_only_pins() {
    let pid = std::process::id();
    let before = process::process(pid).unwrap();
    let pidfd = linux::pin_process(pid).unwrap();
    let scope = objects::pin_magic(format!("/proc/{pid}")).unwrap();
    let pinned = objects::bounded_text(format!("{}/stat", scopes::scope_path(&scope)), 65536).unwrap();
    assert!(process::parse_process(pid, &pinned).unwrap().same_identity(&before));
    assert_eq!(process::uids(pid).unwrap(), process::parse_uids(
        &objects::bounded_text(format!("{}/status", scopes::scope_path(&scope)), 65536).unwrap()
    ).unwrap());
    let root = objects::pin_magic(format!("/proc/{pid}/root")).unwrap();
    assert!(root.metadata().unwrap().is_dir());
    assert!(objects::mount_id(&root).unwrap() > 0);
    assert!(!linux::pidfd_terminated(&pidfd).unwrap());
    let clock = linux::boot_time_ns().unwrap();
    assert!(linux::boot_time_ns().unwrap() >= clock);
    assert!(process::process(pid).unwrap().same_identity(&before));
}
