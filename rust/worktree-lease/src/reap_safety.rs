use crate::Identity;
use std::{fs, os::unix::fs::MetadataExt, path::Path};
pub(crate) fn pin(path: &Path) -> Result<(u64, u64), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "WorktreeChanged")?;
    if !metadata.is_dir() {
        return Err("NotManagedChild");
    }
    Ok((metadata.dev(), metadata.ino()))
}
pub(crate) fn handoff(identity: &Identity, expected: (u64, u64)) -> Result<(), &'static str> {
    if pin(&identity.worktree).ok() != Some(expected) {
        return Err("WorktreeChanged");
    }
    for root in [&identity.worktree, &identity.admin] {
        match fs::symlink_metadata(root.join("reclaim-keep")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err("Protected"),
        }
    }
    Ok(())
}
#[cfg(target_os = "linux")]
pub(crate) fn proc_visible(mountinfo: &str) -> bool {
    let mut found = false;
    for line in mountinfo.lines() {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            return false;
        };
        let mut fields = mount.split_whitespace();
        if fields.nth(4) != Some("/proc") {
            continue;
        }
        found = true;
        let mut fs = filesystem.split_whitespace();
        if fs.next() != Some("proc") {
            return false;
        }
        let (Some(options), Some(superoptions)) = (fields.next(), fs.nth(1)) else {
            return false;
        };
        if options
            .split(',')
            .chain(superoptions.split(','))
            .any(|option| {
                matches!(option, "invisible" | "noaccess" | "subset=pid")
                    || option
                        .strip_prefix("hidepid=")
                        .is_some_and(|value| value != "0")
            })
        {
            return false;
        }
    }
    found
}
#[cfg(all(test, target_os = "linux"))]
#[test]
fn hidden_processes_prevent_cwd_absence() {
    for option in [
        "hidepid=1",
        "hidepid=2",
        "hidepid=invisible",
        "hidepid=noaccess",
        "invisible",
        "noaccess",
        "subset=pid",
    ] {
        let info = format!("1 0 0:1 / /proc rw - proc proc rw,{option}\n");
        // No uid exception: even root can inherit hidden procfs in a user namespace.
        assert!(!proc_visible(&info));
        let info = format!("1 0 0:1 / /proc rw,{option} - proc proc rw\n");
        assert!(!proc_visible(&info));
    }
    assert!(proc_visible("1 0 0:1 / /proc rw - proc proc rw,hidepid=0\n"));
    assert!(!proc_visible("unreadable or malformed"));
}
